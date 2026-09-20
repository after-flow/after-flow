import { forbidden, notFound } from '../domain/shared/errors.js'
import type { CommandContext } from './context.js'
import type { CaseMembership, CaseMembershipPort, CaseRole } from './ports.js'

export type CaseAction = 'READ' | 'WRITE'

const WRITE_ROLES: ReadonlySet<CaseRole> = new Set(['OWNER', 'EDITOR'])

/**
 * Case への所属を確認する。所属が無い場合は存在の有無を漏らさないため
 * 非メンバーには一律 404 を返す（共通認可基盤と同じ契約）。
 */
export async function authorizeCase(
  ctx: CommandContext,
  memberships: CaseMembershipPort,
  action: CaseAction,
): Promise<CaseMembership> {
  const m = await memberships.findMembership(ctx.principal.tenantId, ctx.caseId, ctx.principal.userId)
  if (!m) throw notFound('Case', ctx.caseId)
  if (action === 'WRITE' && !WRITE_ROLES.has(m.role)) {
    throw forbidden('このCaseを変更する権限がありません')
  }
  return m
}
