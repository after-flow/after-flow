import { createHash } from 'node:crypto'
import { DomainError } from '../domain/shared/errors.js'
import type { CommandContext } from './context.js'
import type { IdempotencyStore } from './ports.js'

export interface CommandResult<T> {
  statusCode: number
  body: T
}

export function fingerprintOf(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex')
}

/**
 * Idempotency-Key 付きの Command を一度だけ実行する。
 * 同じキー・同じ入力の再送は初回の結果を返し、同じキーで入力が異なる場合は拒否する。
 * キーが無い場合はそのまま実行する（キー必須化は Presentation 側で行う）。
 */
export async function runIdempotent<T>(
  ctx: CommandContext,
  store: IdempotencyStore,
  operation: string,
  input: unknown,
  execute: () => Promise<CommandResult<T>>,
): Promise<CommandResult<T>> {
  if (!ctx.idempotencyKey) return execute()

  const scopeKey = [ctx.principal.tenantId, ctx.principal.userId, ctx.caseId, operation, ctx.idempotencyKey].join(
    '|',
  )
  const fingerprint = fingerprintOf(input)
  const existing = await store.get(scopeKey)
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_REUSED',
        '同じ Idempotency-Key が異なる内容で再利用されました',
      )
    }
    return { statusCode: existing.statusCode, body: existing.body as T }
  }

  const result = await execute()
  await store.put(scopeKey, { fingerprint, statusCode: result.statusCode, body: result.body })
  return result
}
