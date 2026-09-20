import type { CommandContext } from '../../../../application/context.js'
import { requireUser } from '../../../http/authentication.js'
import type { AppContext } from '../../../http/context.js'

export function businessContext(c: AppContext, caseId: string, idempotencyKey: string | null): CommandContext {
  return { principal: requireUser(c), caseId, idempotencyKey, requestId: c.get('requestId') ?? '' }
}
