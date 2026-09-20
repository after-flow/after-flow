import { z, type ZodType } from 'zod'
import type { CommandContext, Principal } from '../../application/context.js'
import type { ListQuery } from '../../application/ports.js'
import { validation } from '../../domain/shared/errors.js'
import type { AppContext } from './types.js'

export const PRINCIPAL_KEY = 'principal' as const

export function principalOf(c: AppContext): Principal {
  const p = c.get(PRINCIPAL_KEY)
  if (!p) throw new Error('principal is not set; auth middleware must run first')
  return p
}

const IDEMPOTENCY_KEY_MAX = 128

/** 書き込み系は Idempotency-Key 必須。長さと文字種を制限する */
export function commandContext(c: AppContext, requestId: string, requireIdempotencyKey: boolean): CommandContext {
  const caseId = c.req.param('caseId')
  if (!caseId) throw new Error('route must contain :caseId')
  const key = c.req.header('Idempotency-Key') ?? null
  if (requireIdempotencyKey && !key) {
    throw validation('Idempotency-Key ヘッダーは必須です', { header: 'Idempotency-Key' })
  }
  if (key !== null && (key.length === 0 || key.length > IDEMPOTENCY_KEY_MAX || !/^[\w.:-]+$/.test(key))) {
    throw validation('Idempotency-Key の形式が不正です', { header: 'Idempotency-Key' })
  }
  return { requestId, principal: principalOf(c), caseId, idempotencyKey: key }
}

export async function parseBody<T>(c: AppContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw validation('リクエストボディは JSON である必要があります')
  }
  return schema.parse(raw)
}

const listQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  includeExcluded: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

export function parseListQuery(c: AppContext): ListQuery {
  const q = listQuerySchema.parse(c.req.query())
  return { cursor: q.cursor ?? null, limit: q.limit, includeExcluded: q.includeExcluded }
}
