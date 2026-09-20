import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMiddleware } from 'hono/factory'
import { createApp } from '../../../src/app.js'
import { AccessService } from '../../../src/application/authorization/case-access.js'
import type { TenantMember } from '../../../src/application/authorization/case-access.js'
import { CaseService } from '../../../src/application/case/case-service.js'
import { ConsentService } from '../../../src/application/consent/consent-service.js'
import { DocumentService } from '../../../src/application/document/document-service.js'
import type { InheritanceDecisionReader } from '../../../src/application/task/task-service.js'
import { AgentRunService } from '../../../src/application/agent/agent-run-service.js'
import type { AgentOperation } from '../../../src/domain/agent/agent-run.js'
import { TaskService } from '../../../src/application/task/task-service.js'
import { PLACEHOLDER_RULE_CATALOG } from '../../../src/domain/task/rule-catalog.js'
import type { RuleCatalog } from '../../../src/domain/task/rule-engine.js'
import { PLACEHOLDER_CATALOG } from '../../../src/domain/consent/catalog.js'
import type { ConsentCatalog } from '../../../src/domain/consent/consent.js'
import { collections } from '../../../src/domain/shared/collections.js'
import type { DocumentInspector } from '../../../src/application/ports/inspection.js'
import { LocalObjectStorage } from '../../../src/infrastructure/storage/local-object-storage.js'
import type { AppEnv } from '../../../src/presentation/http/context.js'
import { createPublicV1Routes } from '../../../src/presentation/routes/public/v1/index.js'
import { readRepository, unitOfWork, workContext } from './emulator.js'

/**
 * 統合テスト用のアプリ。
 *
 * トークン検証そのものは authentication.test.ts が実 Adapter で行う。
 * ここでは認証より後ろ、認可・同意・業務処理の経路を見る。
 */
export interface TestAppOptions {
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
  const routes = createPublicV1Routes({
    caseService: new CaseService(access, readRepository(), unitOfWork()),
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
      ...(options.decisions ? [options.decisions] : []),
    ),
    agentRunService: new AgentRunService(
      access,
      readRepository(),
      unitOfWork(),
      consentService,
      new Set(options.connectedOperations ?? []),
    ),
  })

  const stubAuthentication = createMiddleware<AppEnv>(async (c, next) => {
    c.set('user', { userId, tenantId })
    await next()
  })

  return createApp({
    routes,
    authentication: stubAuthentication,
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

export function jsonRequest(method: string, body: unknown, idempotencyKey?: string): RequestInit {
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
