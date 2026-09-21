import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMiddleware } from 'hono/factory'
import { createBusinessServices } from '../../../src/infrastructure/firestore/business-services.js'
import { createApp } from '../../../src/app.js'
import { AccessService } from '../../../src/application/authorization/case-access.js'
import type { TenantMember } from '../../../src/application/authorization/case-access.js'
import { CaseService } from '../../../src/application/case/case-service.js'
import { ConsentService } from '../../../src/application/consent/consent-service.js'
import { DocumentService } from '../../../src/application/document/document-service.js'
import { RegistrationService } from '../../../src/application/identity/registration-service.js'
import type { InheritanceDecisionReader } from '../../../src/application/task/task-service.js'
import { AgentRunService } from '../../../src/application/agent/agent-run-service.js'
import type { AgentOperation } from '../../../src/domain/agent/agent-run.js'
import type { Clock } from '../../../src/application/ports.js'
import {
  InheritanceDecisionService,
  StoredInheritanceDecisionReader,
} from '../../../src/application/decision/decision-service.js'
import { MessageService } from '../../../src/application/chat/message-service.js'
import { CaseOverviewService } from '../../../src/application/overview/overview-service.js'
import { AgentResultIntake } from '../../../src/application/chat/result-intake.js'
import { ProposalService } from '../../../src/application/proposal/proposal-service.js'
import { taskProposalApplier } from '../../../src/application/proposal/task-applier.js'
import { entityProposalAppliers } from '../../../src/application/proposal/entity-appliers.js'
import { taskActionProposalAppliers } from '../../../src/application/proposal/task-action-appliers.js'
import type { ProposalApplier } from '../../../src/application/proposal/proposal-service.js'
import { TaskService } from '../../../src/application/task/task-service.js'
import { PLACEHOLDER_RULE_CATALOG } from '../../../src/domain/task/rule-catalog.js'
import type { RuleCatalog } from '../../../src/domain/task/rule-engine.js'
import { PLACEHOLDER_CATALOG } from '../../../src/domain/consent/catalog.js'
import type { ConsentCatalog } from '../../../src/domain/consent/consent.js'
import { collections } from '../../../src/domain/shared/collections.js'
import type { DocumentInspector } from '../../../src/application/ports/inspection.js'
import { LocalObjectStorage } from '../../../src/infrastructure/storage/local-object-storage.js'
import type { AppEnv } from '../../../src/presentation/http/context.js'
import { createInternalApp } from '../../../src/presentation/routes/internal/v1/results.js'
import { createPublicV1Routes } from '../../../src/presentation/routes/public/v1/index.js'
import { readRepository, unitOfWork as storageUnitOfWork, workContext } from './emulator.js'
import { ContextVersionUnitOfWork } from '../../../src/application/case/context-version-unit-of-work.js'

const unitOfWork = () => new ContextVersionUnitOfWork(storageUnitOfWork())

/**
 * 統合テスト用のアプリ。
 *
 * トークン検証そのものは authentication.test.ts が実 Adapter で行う。
 * ここでは認証より後ろ、認可・同意・業務処理の経路を見る。
 */
export interface TestAppOptions {
  proposalAppliers?: ProposalApplier[]
  catalog?: ConsentCatalog
  /** false にすると必須同意の検査を外す。既定は本番と同じく有効。 */
  enforceConsent?: boolean
  /** 検査実装。未指定なら検査は行われず、状態は PENDING のままになる。 */
  inspector?: DocumentInspector
  /** AI が接続されている前提にするか。既定は未接続。 */
  aiConnected?: boolean
  /** 原本の保存先。未指定ならテストごとに一時ディレクトリーを作る。 */
  storageRoot?: string
  /** 期限ルールと初期手続きの定義。未指定なら業務レビュー未了の仮定義。 */
  ruleCatalog?: RuleCatalog
  /** 相続方法の確定状況。未指定なら未確定として扱う。 */
  decisions?: InheritanceDecisionReader
  /** 接続済みの業務操作。未指定ならどれも未接続。 */
  connectedOperations?: AgentOperation[]
  /** 内部APIのサービストークン。未指定なら内部APIを公開しない。 */
  serviceToken?: string
  /** CaseService の時計。未指定なら実時刻。日付境界のテストで固定時刻を注入する。 */
  clock?: Clock
}

export function buildApp(tenantId: string, userId: string, options: TestAppOptions = {}) {
  const access = new AccessService(readRepository())
  const consentService = new ConsentService(
    options.catalog ?? PLACEHOLDER_CATALOG,
    access,
    readRepository(),
    unitOfWork(),
  )
  const storage = new LocalObjectStorage(
    options.storageRoot ?? mkdtempSync(path.join(tmpdir(), 'after-flow-docs-')),
  )
  const agentRunService = new AgentRunService(
    access,
    readRepository(),
    unitOfWork(),
    consentService,
    new Set(options.connectedOperations ?? []),
  )

  const routes = createPublicV1Routes({
    registrationService: new RegistrationService(tenantId, readRepository(), unitOfWork()),
    ...createBusinessServices(access, readRepository(), unitOfWork()),
    caseService: new CaseService(access, readRepository(), unitOfWork(), options.clock),
    consentService,
    documentService: new DocumentService(
      access,
      readRepository(),
      unitOfWork(),
      storage,
      consentService,
      options.inspector ?? null,
      options.aiConnected ?? false,
    ),
    taskService: new TaskService(
      options.ruleCatalog ?? PLACEHOLDER_RULE_CATALOG,
      access,
      readRepository(),
      unitOfWork(),
      options.decisions ?? new StoredInheritanceDecisionReader(readRepository()),
    ),
    agentRunService,
    proposalService: new ProposalService(access, readRepository(), unitOfWork(), options.proposalAppliers ?? [taskProposalApplier, ...entityProposalAppliers, ...taskActionProposalAppliers]),
    decisionService: new InheritanceDecisionService(access, readRepository(), unitOfWork()),
    messageService: new MessageService(access, readRepository(), unitOfWork(), agentRunService, consentService),
    overviewService: new CaseOverviewService(
      access,
      readRepository(),
      (options.connectedOperations ?? []).length > 0,
    ),
  })

  const stubAuthentication = createMiddleware<AppEnv>(async (c, next) => {
    c.set('user', { userId, tenantId })
    await next()
  })

  const internalApp = options.serviceToken
    ? createInternalApp({
        intake: new AgentResultIntake(readRepository(), unitOfWork()),
        serviceToken: options.serviceToken,
        audience: 'backend-server',
      })
    : undefined

  return createApp({
    routes,
    authentication: stubAuthentication,
    ...(internalApp ? { internalApp } : {}),
    ...(options.enforceConsent === false
      ? {}
      : {
          consentGate: async (c) => {
            const user = c.get('user')
            if (user) await consentService.assertBasicConsent(user)
          },
        }),
  })
}

export async function seedTenantMember(tenantId: string, userId: string): Promise<void> {
  await unitOfWork().run(workContext(tenantId), async (tx) => {
    tx.create<TenantMember>(
      { collection: collections.members, caseId: null, id: userId },
      { id: userId, userId, active: true },
    )
  })
}

export type Json = Record<string, any>

export async function call(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Json }> {
  const response = await app.request(`http://localhost/api/v1${path}`, init)
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as Json) : {} }
}

export function jsonRequest(method: string, body: unknown, idempotencyKey: string | null = randomUUID()): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  }
}

/** 必須同意を済ませた状態にする。業務 API の試験の前提。 */
export async function agreeRequiredConsents(
  app: ReturnType<typeof createApp>,
  catalog: ConsentCatalog = PLACEHOLDER_CATALOG,
  idempotencyKey = `idem-consent-${Math.random().toString(36).slice(2, 12)}`,
): Promise<void> {
  const agreements = catalog.documents
    .filter((document) => document.required)
    .map((document) => ({ kind: document.kind, version: document.version }))
  const response = await call(app, '/consents', jsonRequest('POST', { agreements }, idempotencyKey))
  if (response.status !== 200) {
    throw new Error(`必須同意の記録に失敗した: ${JSON.stringify(response.body)}`)
  }
}

/** 外部AI（CROSS_BORDER_AI）への提供同意を済ませた状態にする。 */
export async function agreeExternalAiConsent(
  app: ReturnType<typeof createApp>,
  catalog: ConsentCatalog = PLACEHOLDER_CATALOG,
  idempotencyKey = `idem-consent-ai-${Math.random().toString(36).slice(2, 12)}`,
): Promise<void> {
  const definition = catalog.documents.find((document) => document.kind === 'CROSS_BORDER_AI')
  if (!definition) {
    throw new Error('カタログに CROSS_BORDER_AI の定義が無い')
  }
  const response = await call(
    app,
    '/consents',
    jsonRequest('POST', { agreements: [{ kind: definition.kind, version: definition.version }] }, idempotencyKey),
  )
  if (response.status !== 200) {
    throw new Error(`外部AI同意の記録に失敗した: ${JSON.stringify(response.body)}`)
  }
}

/** 関連する API の試験用に、既存 ID の有効な相続人候補を保存する。 */
export async function seedHeir(tenantId: string, caseId: string, id: string) {
  await unitOfWork().run(workContext(tenantId), async tx => {
    tx.create<import('../../../src/domain/person/person.js').Person & import('../../../src/domain/shared/entity.js').EntityBase>(
      { collection: collections.persons, caseId, id },
      { id, name: id, nameKana: null, relationshipLabel: '家族', role: 'HEIR_CANDIDATE', isHeir: true,
        dateOfBirth: null, specialCircumstance: null, contact: null, note: null,
        excludedAt: null, excludedBy: null, exclusionReason: null,
        createdBy: { kind: 'USER', id: 'user-owner' }, updatedBy: { kind: 'USER', id: 'user-owner' } },
    )
  })
}
