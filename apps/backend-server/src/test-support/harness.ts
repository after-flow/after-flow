import { createApp } from '../app.js'
import { createContainer, type Container } from '../composition.js'
import type { CaseRole } from '../application/ports.js'

export const TENANT = 'dev'
export const CASE_A = 'case_a'
export const CASE_B = 'case_b'
export const OWNER = 'user_owner'
export const MEMBER = 'user_member'
export const VIEWER = 'user_viewer'
export const OUTSIDER = 'user_outsider'

export interface Harness {
  container: Container
  request(
    method: string,
    path: string,
    init?: { body?: unknown; user?: string | null; idempotencyKey?: string | null; headers?: Record<string, string> },
  ): Promise<{ status: number; json: any }>
}

let keySeq = 0

export function createHarness(
  memberships: { caseId: string; userId: string; role: CaseRole }[] = [
    { caseId: CASE_A, userId: OWNER, role: 'OWNER' },
    { caseId: CASE_A, userId: MEMBER, role: 'MEMBER' },
    { caseId: CASE_A, userId: VIEWER, role: 'VIEWER' },
    { caseId: CASE_B, userId: OUTSIDER, role: 'OWNER' },
  ],
): Harness {
  const container = createContainer({ AUTH_MODE: 'dev-header' })
  for (const m of memberships) container.memberships.grant({ tenantId: TENANT, ...m })
  const app = createApp(container)

  return {
    container,
    async request(method, path, init = {}) {
      const headers: Record<string, string> = { ...init.headers }
      const user = init.user === undefined ? OWNER : init.user
      if (user) {
        headers['x-dev-user-id'] = user
        headers['x-dev-tenant-id'] = TENANT
      }
      if (init.body !== undefined) headers['content-type'] = 'application/json'
      const isWrite = method !== 'GET'
      const key = init.idempotencyKey === undefined ? (isWrite ? `key_${++keySeq}` : null) : init.idempotencyKey
      if (key) headers['Idempotency-Key'] = key
      const res = await app.request(`/api/v1${path}`, {
        method,
        headers,
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      })
      const text = await res.text()
      return { status: res.status, json: text ? JSON.parse(text) : null }
    },
  }
}
