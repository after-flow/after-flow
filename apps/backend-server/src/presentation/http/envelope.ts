import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiFailure, ApiSuccess } from '@aftercare/public-contracts'
import { ZodError } from 'zod'
import { DomainError, type DomainErrorCode } from '../../domain/shared/errors.js'
import type { Page } from '../../application/ports.js'
import type { AppContext } from './types.js'

export const REQUEST_ID_KEY = 'requestId' as const

export function requestIdOf(c: AppContext): string {
  return c.get(REQUEST_ID_KEY) ?? 'unknown'
}

export function ok<T>(c: AppContext, data: T, status: ContentfulStatusCode = 200) {
  const body: ApiSuccess<T> = { data, meta: { requestId: requestIdOf(c) } }
  return c.json(body, status)
}

export function okPage<T>(c: AppContext, page: Page<T>) {
  const body: ApiSuccess<T[]> = {
    data: page.items,
    meta: { requestId: requestIdOf(c), nextCursor: page.nextCursor },
  }
  return c.json(body, 200)
}

export function fail(
  c: AppContext,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details?: unknown,
) {
  const body: ApiFailure = {
    error: { code, message, retryable: status === 503 || status === 429, ...(details !== undefined && { details }) },
    meta: { requestId: requestIdOf(c) },
  }
  return c.json(body, status)
}

const STATUS_BY_CODE: Record<DomainErrorCode, ContentfulStatusCode> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  INVALID_TRANSITION: 409,
  REFERENCED: 409,
  DUPLICATE: 409,
  PRECONDITION_FAILED: 412,
  AUTH_NOT_CONFIGURED: 503,
}

export function handleError(err: unknown, c: AppContext) {
  if (err instanceof DomainError) {
    return fail(c, STATUS_BY_CODE[err.code], err.code, err.message, err.details)
  }
  if (err instanceof ZodError) {
    return fail(c, 400, 'VALIDATION_ERROR', '入力内容に誤りがあります', err.issues)
  }
  console.error('[unhandled]', requestIdOf(c), err)
  return fail(c, 500, 'INTERNAL_ERROR', 'サーバー内部でエラーが発生しました')
}
