import type { CommandContext } from './context.js'
import type { CommandResult } from './idempotency.js'
import type { ActorRef, CaseEntity, ISODateTime } from '../domain/shared/types.js'

export type CaseRole = 'OWNER' | 'EDITOR' | 'VIEWER'

export interface CaseMembership {
  tenantId: string
  caseId: string
  userId: string
  role: CaseRole
}

export interface CaseMembershipPort {
  findMembership(tenantId: string, caseId: string, userId: string): Promise<CaseMembership | null>
}

export interface Clock {
  now(): ISODateTime
}

export interface IdGenerator {
  next(prefix: string): string
}

/** Entity・監査・冪等性の結果を同じ UnitOfWork で確定する。 */
export interface IdempotencyStore {
  run<T>(ctx: CommandContext, operation: string, input: unknown, execute: () => Promise<CommandResult<T>>): Promise<CommandResult<T>>
}

export interface AuditEntry {
  id: string
  tenantId: string
  caseId: string
  actor: ActorRef
  action: string
  targetType: string
  targetId: string
  requestId: string
  occurredAt: ISODateTime
  detail?: unknown
}

export interface AuditLogPort {
  append(entry: Omit<AuditEntry, 'id'>): Promise<void>
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface ListQuery {
  cursor: string | null
  limit: number
  includeExcluded: boolean
}

/** Case スコープの集約リポジトリ。取得は必ず tenant/case で絞る */
export interface CaseScopedRepository<T extends CaseEntity> {
  findById(tenantId: string, caseId: string, id: string): Promise<T | null>
  list(tenantId: string, caseId: string, query: ListQuery): Promise<Page<T>>
  save(entity: T): Promise<void>
}
