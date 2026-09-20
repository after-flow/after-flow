import { createMiddleware } from 'hono/factory'
import { createApp } from '../../../src/app.js'
import { AccessService } from '../../../src/application/authorization/case-access.js'
import type { TenantMember } from '../../../src/application/authorization/case-access.js'
import { CaseService } from '../../../src/application/case/case-service.js'
import { ConsentService } from '../../../src/application/consent/consent-service.js'
import { PLACEHOLDER_CATALOG } from '../../../src/domain/consent/catalog.js'
import type { ConsentCatalog } from '../../../src/domain/consent/consent.js'
import { collections } from '../../../src/domain/shared/collections.js'
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
}

export function buildApp(tenantId: string, userId: string, options: TestAppOptions = {}) {
  const access = new AccessService(readRepository())
  const consentService = new ConsentService(
    options.catalog ?? PLACEHOLDER_CATALOG,
    access,
    readRepository(),
    unitOfWork(),
  )
  const routes = createPublicV1Routes({
    caseService: new CaseService(access, readRepository(), unitOfWork()),
    consentService,
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
