import { randomUUID } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from './context.js'

export const REQUEST_ID_HEADER = 'X-Request-Id'

/**
 * 受け取った X-Request-Id をそのまま信用しない。
 * 長すぎる値や制御文字はログを壊し、他の要求の追跡を妨げるため、
 * 安全な字種・長さの場合だけ引き継ぎ、それ以外は採番する。
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/

export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const inbound = c.req.header(REQUEST_ID_HEADER)
  const value = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID()
  c.set('requestId', value)
  c.header(REQUEST_ID_HEADER, value)
  await next()
})
