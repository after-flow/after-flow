import { actorOf, type CommandContext } from './context.js'
import type { AuditLogPort } from './ports.js'

export interface AuditInput {
  action: string
  targetType: string
  targetId: string
  occurredAt: string
  detail?: unknown
}

export function appendAudit(audit: AuditLogPort, ctx: CommandContext, input: AuditInput): Promise<void> {
  return audit.append({
    tenantId: ctx.principal.tenantId,
    caseId: ctx.caseId,
    actor: actorOf(ctx.principal),
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    requestId: ctx.requestId,
    occurredAt: input.occurredAt,
    ...(input.detail !== undefined && { detail: input.detail }),
  })
}
