import { randomUUID } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import { createApp } from '../../../src/app.js'
import { AccessService } from '../../../src/application/authorization/case-access.js'
import { createBusinessServices } from '../../../src/infrastructure/firestore/business-services.js'
import { createPersonRoutes } from '../../../src/presentation/routes/public/v1/persons.js'
import { createEstateRoutes } from '../../../src/presentation/routes/public/v1/estate.js'
import { createContractRoutes } from '../../../src/presentation/routes/public/v1/contracts.js'
import { createInsightRoutes } from '../../../src/presentation/routes/public/v1/insights.js'
import type { AppEnv } from '../../../src/presentation/http/context.js'
import { newTenantId, firestore, readRepository, unitOfWork } from './emulator.js'

export const CASE_A = 'case_a'
export const CASE_B = 'case_b'
export const OWNER = 'user_owner'
export const MEMBER = 'user_member'
export const VIEWER = 'user_viewer'
export const OUTSIDER = 'user_outsider'

/** 認証済み主体だけを stub にし、認可・業務保存・監査は本番と同じ Firestore を使う。 */
export function createHarness() {
  const tenantId = newTenantId()
  const services = createBusinessServices(new AccessService(readRepository()), readRepository(), unitOfWork())
  async function seed(collection: string, caseId: string | null, id: string, data: Record<string, unknown>) {
    const path = caseId ? `tenants/${tenantId}/cases/${caseId}/${collection}/${id}` : `tenants/${tenantId}/${collection}/${id}`
    const now = new Date().toISOString()
    await firestore().doc(path).set({ id, tenantId, caseId, version: 1, schemaVersion: 1, createdAt: now, updatedAt: now, ...data })
  }
  const ready = (async () => {
    await Promise.all([CASE_A, CASE_B].map(id => seed('cases', null, id, { deceasedName: 'テスト', status: 'ACTIVE' })))
    await Promise.all([
      [CASE_A, OWNER, 'OWNER'], [CASE_A, MEMBER, 'EDITOR'], [CASE_A, VIEWER, 'VIEWER'], [CASE_B, OUTSIDER, 'OWNER'],
    ].map(([caseId, userId, role]) => seed('caseMembers', caseId!, userId!, { userId, role, active: true, personId: null })))
  })()
  const routes = [...createPersonRoutes(services.personService), ...createEstateRoutes(services.estateService),
      ...createContractRoutes(services.contractService), ...createInsightRoutes(services.insightService)]
  const app = createApp({
    routes,
    authentication: createMiddleware<AppEnv>(async (c, next) => {
      const userId = c.req.header('x-test-user')
      if (userId) c.set('user', { tenantId, userId })
      await next()
    }),
  })
  return {
    tenantId, ready, services, seed,
    async auditActions() {
      const snapshot = await firestore().collection(`tenants/${tenantId}/cases/${CASE_A}/auditEvents`).orderBy('occurredAt', 'asc').get()
      return snapshot.docs.map(doc => doc.get('type') as string)
    },
    async request(method: string, path: string, init: {
      body?: unknown; user?: string | null; idempotencyKey?: string | null; headers?: Record<string, string>
    } = {}) {
      await ready
      const user = init.user === undefined ? OWNER : init.user
      const key = init.idempotencyKey === undefined ? (method === 'GET' ? null : randomUUID()) : init.idempotencyKey
      const response = await app.request('/api/v1' + path, {
        method,
        headers: {
          ...init.headers,
          ...(user ? { 'x-test-user': user } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}),
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      })
      const json = await response.json() as any
      if (response.ok) {
        const route = routes.find(({ spec }) => spec.method === method.toLowerCase() &&
          new RegExp('^' + spec.path.replace(/:[A-Za-z]+/g, '[^/]+') + '$').test(path.split('?')[0]!))
        route?.spec.success.schema?.parse(json)
      }
      return { status: response.status, json }
    },
  }
}
