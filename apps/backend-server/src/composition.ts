import type { Hono } from 'hono'
import { createBusinessServices } from './infrastructure/firestore/business-services.js'
import { createApp } from './app.js'
import { AccessService } from './application/authorization/case-access.js'
import { CaseService } from './application/case/case-service.js'
import { ConsentService } from './application/consent/consent-service.js'
import { DocumentService } from './application/document/document-service.js'
import { AgentRunService } from './application/agent/agent-run-service.js'
import { InternalExecutionService } from './application/agent/internal-execution-service.js'
import { OutboxDispatcher } from './application/agent/outbox-dispatcher.js'
import type { AgentOperation } from './domain/agent/agent-run.js'
import {
  InheritanceDecisionService,
  StoredInheritanceDecisionReader,
} from './application/decision/decision-service.js'
import { MessageService } from './application/chat/message-service.js'
import { CaseOverviewService } from './application/overview/overview-service.js'
import { AgentResultIntake } from './application/chat/result-intake.js'
import { ProposalService } from './application/proposal/proposal-service.js'
import { taskProposalApplier } from './application/proposal/task-applier.js'
import { entityProposalAppliers } from './application/proposal/entity-appliers.js'
import { taskActionProposalAppliers } from './application/proposal/task-action-appliers.js'
import { TaskService } from './application/task/task-service.js'
import {
  notConfiguredCheck,
  objectStorageReadinessCheck,
  ReadinessService,
  syncCheck,
} from './application/operations/readiness-service.js'
import type { ReadinessCheck } from './application/operations/readiness-service.js'
import { readConsentCatalog } from './infrastructure/consent/catalog-config.js'
import { readAgentClientConfig } from './infrastructure/agent/http-agent-client.js'
import { ScopedHttpAgentJobClient } from './infrastructure/agent/scoped-http-agent-client.js'
import { createAiConnectivityReadinessCheck } from './infrastructure/agent/readiness-check.js'
import { matchesServiceCredential, readExecutionAuthorization } from './infrastructure/identity/execution-authorization.js'
import { readRuleCatalog } from './infrastructure/rules/rule-config.js'
import { createDocumentStorage } from './infrastructure/storage/cloud-object-storage.js'
import { createFirestore, readFirestoreConfig } from './infrastructure/firestore/client.js'
import { createFirestoreReadinessCheck } from './infrastructure/firestore/readiness-check.js'
import { FirestoreReadRepository } from './infrastructure/firestore/read-repository.js'
import { FirestoreUnitOfWork } from './infrastructure/firestore/unit-of-work.js'
import { ContextVersionUnitOfWork } from './application/case/context-version-unit-of-work.js'
import { createTokenVerifier, readAuthConfig } from './infrastructure/identity/config.js'
import { authentication } from './presentation/http/authentication.js'
import type { AppEnv } from './presentation/http/context.js'
import { logger } from './presentation/http/logger.js'
import { createExecutionApp } from './presentation/routes/internal/v1/execution.js'
import { createReadinessApp } from './presentation/routes/internal/v1/readiness.js'
import { createPublicV1Routes } from './presentation/routes/public/v1/index.js'

/**
 * 実行時の組み立て。
 *
 * 認証 Provider は未決定（仕様書 19 章）で、Firestore の接続先も
 * 開発環境では未設定のことがある。設定が無い場合は、その機能を
 * 「接続されていない」として明示的に拒否する。検証を省略して通す
 * 既定値や、空配列を返して成功に見せる実装にはしない。
 */
export function createServer(env: NodeJS.ProcessEnv = process.env): Hono<AppEnv> {
  const database = createDatabase(env)
  const apiDocs = apiDocsEnabled(env)
  // readinessはFirestore/認証などの接続状況に関わらず必ず組み立てる。
  // 「未接続」を readiness 未搭載ではなく readiness 失敗として報告するため。
  const readinessApp = createReadinessAppFor(env, database)

  if (!database) {
    logger.warn('business database is not configured', {
      effect: 'business APIs reject every request with FEATURE_NOT_CONNECTED',
      required: ['FIRESTORE_PROJECT_ID'],
    })
    return createApp({ routes: createPublicV1Routes(null), apiDocs, ...(readinessApp ? { readinessApp } : {}) })
  }

  const access = new AccessService(database.read)
  const consentCatalog = readConsentCatalog(env)
  const consentService = new ConsentService(
    consentCatalog,
    access,
    database.read,
    database.uow,
  )
  const documentStorage = createDocumentStorage(env)
  if (!documentStorage) {
    // 原本の保存先が無い状態で登録を受け付けると、成功に見えて原本が残らない。
    logger.warn('document storage is not configured', {
      effect: 'document APIs reject every request with FEATURE_NOT_CONNECTED',
      required: ['DOCUMENT_STORAGE_ROOT or DOCUMENT_STORAGE_BUCKET'],
    })
  }

  const enabledOperations = connectedOperations(env)
  if (enabledOperations.size > 0 && !consentCatalog.documents.some((document) => document.kind === 'CROSS_BORDER_AI')) {
    // 接続済みのふりをしない、と対にする検査。AI へ渡す操作を接続していながら
    // カタログに CROSS_BORDER_AI が無い設定は、外国にある第三者への提供を
    // 同意なしで許してしまう fail-open になりうる（個人情報保護法28条）。
    // カタログ定義そのものは変えず、設定ミスを起動時に見えるようにする。
    logger.warn('consent catalog has no CROSS_BORDER_AI while AI operations are connected', {
      effect: 'external AI operations proceed without cross-border transfer consent enforcement',
      connectedOperations: [...enabledOperations],
    })
  }

  const agentRunService = new AgentRunService(
    access,
    database.read,
    database.uow,
    consentService,
    enabledOperations,
  )

  const proposalService = new ProposalService(access, database.read, database.uow, [taskProposalApplier, ...entityProposalAppliers, ...taskActionProposalAppliers])
  const routes = createPublicV1Routes({
    ...createBusinessServices(access, database.read, database.uow),
    caseService: new CaseService(access, database.read, database.uow),
    consentService,
    documentService: documentStorage ? new DocumentService(
      access,
      database.read,
      database.uow,
      documentStorage,
      consentService,
      // 検査実装は方式決定後（#26）。未接続なので検査状態は PENDING のまま。
      null,
      // AI は未接続。解析は受け付けない。
      false,
    ) : null,
    // 放棄前ロックは保存済みの確定状況で判定する。未記録は未確定のまま。
    taskService: new TaskService(
      readRuleCatalog(env),
      access,
      database.read,
      database.uow,
      new StoredInheritanceDecisionReader(database.read),
    ),
    // 接続済みの業務操作は設定で管理する。AI Server が未設定なら空集合で、
    // どの操作も FEATURE_NOT_CONNECTED になる。UI にボタンがあるだけで
    // すべての操作を有効にしない。
    agentRunService,
    // 種類ごとの反映は担当 Issue が登録する。未登録の種類は反映できない。
    proposalService,
    decisionService: new InheritanceDecisionService(access, database.read, database.uow),
    messageService: new MessageService(access, database.read, database.uow, agentRunService, consentService),
    overviewService: new CaseOverviewService(
      access,
      database.read,
      enabledOperations.size > 0,
    ),
  })

  // 認証済み利用者にだけ同意を要求する。未認証は先に 401 で止まる。
  const consentGate = async (c: import('./presentation/http/context.js').AppContext) => {
    const user = c.get('user')
    if (user) await consentService.assertBasicConsent(user)
  }

  const executionAuthorization = readExecutionAuthorization(env)
  if (env.BACKEND_INTERNAL_SERVICE_TOKEN && env.BACKEND_INTERNAL_SERVICE_TOKEN === env.AI_SERVICE_TOKEN) {
    throw new Error('Inbound and outbound service credentials must differ')
  }
  // 共有サービス資格情報だけの旧results endpointは本番にmountしない。
  const internalApp = executionAuthorization && env.BACKEND_INTERNAL_SERVICE_TOKEN
    ? createExecutionApp({
        service: new InternalExecutionService(database.read, database.uow, consentService, new AgentResultIntake(database.read, database.uow), proposalService),
        authorization: executionAuthorization,
        serviceCredential: env.BACKEND_INTERNAL_SERVICE_TOKEN,
      })
    : undefined

  if (!env.AUTH_ISSUER) {
    // 設定が無いこと自体をはっきり残す。無効のまま本番へ出さないため。
    logger.warn('authentication is not configured', {
      effect: 'routes that require a user reject every request with 401',
      required: ['AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URI'],
    })
    return createApp({
      routes,
      consentGate,
      apiDocs,
      ...(internalApp ? { internalApp } : {}),
      ...(readinessApp ? { readinessApp } : {}),
    })
  }

  return createApp({
    routes,
    consentGate,
    apiDocs,
    ...(internalApp ? { internalApp } : {}),
    ...(readinessApp ? { readinessApp } : {}),
    authentication: authentication(createTokenVerifier(readAuthConfig(env)), access),
  })
}

/** 本番では明示指定が無い限りAPIテスト画面を公開しない。 */
export function apiDocsEnabled(env: NodeJS.ProcessEnv): boolean {
  const configured = env.API_DOCS_ENABLED?.trim().toLowerCase()
  if (!configured) return env.NODE_ENV !== 'production'
  if (configured === 'true') return true
  if (configured === 'false') return false
  throw new Error('API_DOCS_ENABLED must be true or false')
}

/**
 * Outbox の配送を組み立てる。
 *
 * AI Server の設定が無ければ配送しない。イベントは PENDING のまま残り、
 * 接続後に配送される。接続済みのふりをしない。
 */
export function createOutboxDispatcher(
  env: NodeJS.ProcessEnv,
  dependencies: { firestore: import('@google-cloud/firestore').Firestore; consent: ConsentService },
): OutboxDispatcher | null {
  const config = readAgentClientConfig(env)
  const authorization = readExecutionAuthorization(env)
  if (!config || !authorization) return null
  const read = new FirestoreReadRepository(dependencies.firestore)
  const uow = new ContextVersionUnitOfWork(new FirestoreUnitOfWork(dependencies.firestore))
  const execution = new InternalExecutionService(read, uow, dependencies.consent, new AgentResultIntake(read, uow))
  return new OutboxDispatcher(dependencies.firestore, new ScopedHttpAgentJobClient(config, execution, authorization), dependencies.consent)
}

/** 設定で有効にした業務操作だけを受け付ける。 */
function connectedOperations(env: NodeJS.ProcessEnv): ReadonlySet<AgentOperation> {
  if (!env.BACKEND_EXECUTION_SIGNING_KEY || !env.BACKEND_INTERNAL_SERVICE_TOKEN || !readAgentClientConfig(env)) return new Set()
  const configured = (env.AI_CONNECTED_OPERATIONS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const supported: AgentOperation[] = ['case_planning', 'task_guidance', 'chat_reply']
  return new Set(supported.filter((operation) => configured.includes(operation)))
}

function createDatabase(env: NodeJS.ProcessEnv) {
  if (!env.FIRESTORE_PROJECT_ID && !env.GOOGLE_CLOUD_PROJECT) return null
  const firestore = createFirestore(readFirestoreConfig(env))
  return {
    firestore,
    read: new FirestoreReadRepository(firestore),
    uow: new ContextVersionUnitOfWork(new FirestoreUnitOfWork(firestore)),
  }
}

/**
 * readiness の検査一覧を組み立てる。
 *
 * `database` が無い（Firestore未設定）場合も、readiness自体は必ず組み立てる。
 * 設定不足を「readiness未接続」ではなく「readiness失敗」として報告するため。
 * 詳細は `docs/runbooks/readiness.md`。
 */
function readinessChecks(
  env: NodeJS.ProcessEnv,
  database: ReturnType<typeof createDatabase>,
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [
    database ? createFirestoreReadinessCheck(database.firestore) : notConfiguredCheck('firestore'),
  ]

  // storageも他の検査と同じく遅延評価にする。設定を都度読むことで、
  // readinessの組み立て自体（起動時）が設定不備で丸ごと落ちないようにする。
  // 実際の疎通確認（`exists`）は readinessService.evaluate() 呼び出し時だけ行う。
  checks.push({
    name: 'storage',
    async run() {
      const storage = createDocumentStorage(env)
      if (!storage) return { ok: false, reason: 'NOT_CONFIGURED' }
      return objectStorageReadinessCheck('storage', storage).run()
    },
  })

  checks.push(
    syncCheck('auth', () => {
      let config
      try {
        config = readAuthConfig(env)
      } catch {
        return { ok: false, reason: 'NOT_CONFIGURED' }
      }
      // static-jwksは試験・ローカル専用（readAuthConfigもNODE_ENV=productionでは拒否する）。
      // readinessはNODE_ENVに関係なく、本番相当の設定でなければ ready を返さない。
      if (config.mode === 'static-jwks') return { ok: false, reason: 'STATIC_JWKS_NOT_PRODUCTION_GRADE' }
      return { ok: true }
    }),
  )

  checks.push(
    syncCheck('consent_catalog', () => {
      let catalog
      try {
        catalog = readConsentCatalog(env)
      } catch {
        return { ok: false, reason: 'NOT_CONFIGURED' }
      }
      // #128で正式カタログが確定するまで、placeholder:trueは仮文面のまま。
      return catalog.placeholder ? { ok: false, reason: 'PLACEHOLDER_CATALOG' } : { ok: true }
    }),
  )

  checks.push(
    syncCheck('deadline_rules', () => {
      let catalog
      try {
        catalog = readRuleCatalog(env)
      } catch {
        // consent_catalog と同じ扱い。DEADLINE_RULES_PATH が壊れたJSON/矛盾した
        // ルールを指していても、汎用の CHECK_FAILED ではなく設定不備として報告する。
        return { ok: false, reason: 'NOT_CONFIGURED' }
      }
      // #129で正式ルールが確定するまで、placeholder:trueは業務レビュー未了のまま。
      return catalog.placeholder ? { ok: false, reason: 'PLACEHOLDER_CATALOG' } : { ok: true }
    }),
  )

  // AI操作が有効化されている場合だけ、AI関連の検査を追加する（#123実装範囲）。
  if (connectedOperations(env).size > 0) {
    checks.push(
      // 呼び出し時点では connectedOperations(env).size > 0 が
      // BACKEND_EXECUTION_SIGNING_KEY / BACKEND_INTERNAL_SERVICE_TOKEN / readAgentClientConfig(env)
      // をすでに要求しているため、NOT_CONFIGURED分岐は現状到達しない。また
      // Firestoreが設定されている経路ではcreateServerが不正な署名鍵を起動時に
      // 例外で落とすため、INVALID_SIGNING_KEY分岐も現状到達しない。それでも
      // readinessが「checkの入力を毎回自分で検証する」という前提を保つため、
      // connectedOperations の内部実装に依存せず残してある（防御的）。
      syncCheck('ai_internal_auth', () => {
        if (!env.BACKEND_INTERNAL_SERVICE_TOKEN) return { ok: false, reason: 'NOT_CONFIGURED' }
        try {
          if (!readExecutionAuthorization(env)) return { ok: false, reason: 'NOT_CONFIGURED' }
        } catch {
          return { ok: false, reason: 'INVALID_SIGNING_KEY' }
        }
        return { ok: true }
      }),
    )
    const agentConfig = readAgentClientConfig(env)
    checks.push(
      agentConfig ? createAiConnectivityReadinessCheck(agentConfig) : notConfiguredCheck('ai_connectivity'),
    )
  }

  return checks
}

/**
 * 内部readiness endpointを組み立てる。
 *
 * `READINESS_ACCESS_TOKEN` が無ければ mount しない（他の任意機能と同じ方針）。
 * AI向け資格情報（`AI_SERVICE_TOKEN` / `BACKEND_INTERNAL_SERVICE_TOKEN`）とは
 * 必ず別の値にする。AIにreadinessへのアクセスを渡さないため。
 */
function createReadinessAppFor(env: NodeJS.ProcessEnv, database: ReturnType<typeof createDatabase>) {
  const accessToken = env.READINESS_ACCESS_TOKEN
  if (!accessToken) {
    logger.warn('readiness endpoint is not configured', {
      effect: 'GET /internal/v1/health/ready is not mounted',
      required: ['READINESS_ACCESS_TOKEN'],
    })
    return undefined
  }
  for (const other of [env.AI_SERVICE_TOKEN, env.BACKEND_INTERNAL_SERVICE_TOKEN]) {
    if (other && matchesServiceCredential(`Bearer ${accessToken}`, `Bearer ${other}`)) {
      throw new Error('READINESS_ACCESS_TOKEN must differ from the AI-facing service credentials')
    }
  }
  return createReadinessApp({
    service: new ReadinessService(readinessChecks(env, database)),
    accessToken,
  })
}
