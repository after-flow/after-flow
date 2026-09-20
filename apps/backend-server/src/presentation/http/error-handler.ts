import type { ApiErrorBody } from '@aftercare/public-contracts'
import { HTTPException } from 'hono/http-exception'
import type { AppContext } from './context.js'
import { AppError, errors, isAppError } from '../../shared/app-error.js'
import { failure } from './envelope.js'
import { logger } from './logger.js'

/**
 * 既知のエラーと予期しない例外を同じ契約へ落とす。
 *
 * 予期しない例外の message をそのまま返すと、内部の識別子や
 * 依存ライブラリーの内部状態が利用者に露出する。既知でない場合は
 * 固定文言に置き換え、詳細はログにだけ残す。
 */
function toAppError(cause: unknown): AppError {
  if (isAppError(cause)) return cause

  if (cause instanceof HTTPException) {
    // Hono の bodyLimit などが投げる例外。status に応じた既知エラーへ写す。
    if (cause.status === 413) return errors.payloadTooLarge({ cause })
    if (cause.status === 415) return errors.unsupportedMediaType({ cause })
    if (cause.status === 401) return errors.unauthenticated({ cause })
    if (cause.status === 403) return errors.forbidden({ cause })
    if (cause.status === 404) return errors.notFound({ cause })
    return errors.internal({ cause })
  }

  return errors.internal({ cause })
}

export function handleError(cause: unknown, c: AppContext) {
  const error = toAppError(cause)
  const requestId = c.get('requestId')

  const logFields = {
    requestId,
    code: error.code,
    status: error.status,
    method: c.req.method,
    // path は route の形であり、query は入力全文を含みうるため出さない。
    path: c.req.routePath,
    ...(error.internal ?? {}),
  }

  if (error.status >= 500) {
    logger.error('request failed', { ...logFields, cause: error.cause ?? error })
  } else {
    logger.warn('request rejected', logFields)
  }

  const body: ApiErrorBody = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.details ? { details: error.details } : {}),
  }
  return failure(c, error.status as never, body)
}

/** 未定義の path。存在しない route から実装の有無を推測させない。 */
export function handleNotFound(c: AppContext) {
  return handleError(errors.notFound({ message: '指定された API は存在しません。' }), c)
}
