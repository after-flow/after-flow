/**
 * ローカル開発・テスト用の in-memory アダプタ。
 * Firestore 実装（#5）が入るまでの暫定で、プロセス再起動で消える。
 */
import { randomUUID } from 'node:crypto'
import type {
  AuditEntry,
  AuditLogPort,
  CaseMembership,
  CaseMembershipPort,
  CaseScopedRepository,
  Clock,
  IdGenerator,
  IdempotencyRecord,
  IdempotencyStore,
  ListQuery,
  Page,
} from '../../application/ports.js'
import type { CaseEntity, Excludable } from '../../domain/shared/types.js'
import { validation } from '../../domain/shared/errors.js'

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString()
  }
}

export class UuidIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}_${randomUUID()}`
  }
}

export class InMemoryMembershipStore implements CaseMembershipPort {
  private readonly rows: CaseMembership[] = []

  grant(m: CaseMembership): void {
    this.rows.push(m)
  }

  async findMembership(tenantId: string, caseId: string, userId: string): Promise<CaseMembership | null> {
    return this.rows.find((r) => r.tenantId === tenantId && r.caseId === caseId && r.userId === userId) ?? null
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<string, IdempotencyRecord>()

  async get(scopeKey: string): Promise<IdempotencyRecord | null> {
    return this.rows.get(scopeKey) ?? null
  }

  async put(scopeKey: string, record: IdempotencyRecord): Promise<void> {
    this.rows.set(scopeKey, record)
  }
}

export class InMemoryAuditLog implements AuditLogPort {
  readonly entries: AuditEntry[] = []

  async append(entry: Omit<AuditEntry, 'id'>): Promise<void> {
    this.entries.push({ id: randomUUID(), ...entry })
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string | null): number {
  if (cursor === null) return 0
  const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'))
  if (!Number.isInteger(n) || n < 0) throw validation('cursor が不正です', { field: 'cursor' })
  return n
}

export class InMemoryCaseRepository<T extends CaseEntity & Partial<Excludable>>
  implements CaseScopedRepository<T>
{
  private readonly rows = new Map<string, T>()

  private key(tenantId: string, caseId: string, id: string) {
    return `${tenantId}/${caseId}/${id}`
  }

  async findById(tenantId: string, caseId: string, id: string): Promise<T | null> {
    return this.rows.get(this.key(tenantId, caseId, id)) ?? null
  }

  async list(tenantId: string, caseId: string, query: ListQuery): Promise<Page<T>> {
    const all = [...this.rows.values()]
      .filter((r) => r.tenantId === tenantId && r.caseId === caseId)
      .filter((r) => query.includeExcluded || !r.excludedAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const offset = decodeCursor(query.cursor)
    const items = all.slice(offset, offset + query.limit)
    const end = offset + items.length
    return { items, nextCursor: end < all.length ? encodeCursor(end) : null }
  }

  async save(entity: T): Promise<void> {
    this.rows.set(this.key(entity.tenantId, entity.caseId, entity.id), entity)
  }

  /** テスト補助 */
  snapshot(): T[] {
    return [...this.rows.values()]
  }
}
