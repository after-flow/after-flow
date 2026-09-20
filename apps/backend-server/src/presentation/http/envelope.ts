import type { ApiErrorBody, ApiFailure, ApiSuccess, ResponseMeta } from '@aftercare/public-contracts'
import type { StatusCode } from 'hono/utils/http-status'
import type { AppContext } from './context.js'
import { requestIdOf } from './context.js'

/**
 * 成功応答。
 *
 * すべての route がこれを通ることで、`{ data, meta }` の形と requestId の付与を
 * route ごとの書き分けに依存させない。
 */
export function ok<T>(c: AppContext, data: T, init: { status?: StatusCode; nextCursor?: string } = {}) {
  const meta: ResponseMeta = { requestId: requestIdOf(c) }
  if (init.nextCursor !== undefined) meta.nextCursor = init.nextCursor
  const body: ApiSuccess<T> = { data, meta }
  return c.json(body, (init.status ?? 200) as never)
}

/**
 * 非同期受付 (202)。
 * 受け付けただけで完了ではないため、結果は別途取得させる。
 */
export function accepted<T>(c: AppContext, data: T) {
  return ok(c, data, { status: 202 })
}

export function failure(c: AppContext, status: StatusCode, error: ApiErrorBody) {
  const body: ApiFailure = { error, meta: { requestId: requestIdOf(c) } }
  return c.json(body, status as never)
}
