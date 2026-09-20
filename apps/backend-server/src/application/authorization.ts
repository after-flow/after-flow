import { forbidden } from '../domain/shared/errors.js'
import type { CommandContext } from './context.js'
import type { CaseMembership, CaseMembershipPort, CaseRole } from './ports.js'

export type CaseAction = 'READ' | 'WRITE'

const WRITE_ROLES: ReadonlySet<CaseRole> = new Set(['OWNER', 'MEMBER'])

/**
 * Case への所属を確認する。所属が無い場合は存在の有無を漏らさないため
 * 404 ではなく一律 403 とする（他Caseの ID を推測されても区別できない）。
 */
export async function authorizeCase(
  ctx: CommandContext,
  memberships: CaseMembershipPort,
  action: CaseAction,
): Promise<CaseMembership> {
  const m = await memberships.findMembership(ctx.principal.tenantId, ctx.caseId, ctx.principal.userId)
  if (!m) throw forbidden('このCaseにアクセスする権限がありません')
  if (action === 'WRITE' && !WRITE_ROLES.has(m.role)) {
    throw forbidden('このCaseを変更する権限がありません')
  }
  return m
}
