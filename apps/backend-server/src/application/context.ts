import type { ActorRef } from '../domain/shared/types.js'

export interface Principal {
  tenantId: string
  userId: string
}

export interface CommandContext {
  requestId: string
  principal: Principal
  caseId: string
  idempotencyKey: string | null
}

export function actorOf(principal: Principal): ActorRef {
  return { kind: 'USER', id: principal.userId }
}
