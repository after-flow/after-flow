import type { ApiErrorCode } from '@aftercare/public-contracts'

/**
 * Application / Domain から presentation へ意図を伝える唯一のエラー型。
 *
 * HTTP status とコードの対応をここ一箇所に閉じ込め、route ごとに
 * status を書き分けて契約がずれるのを防ぐ。
 */
export class AppError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly retryable: boolean
  /** 応答に含めてよい補足のみ。入力全文・資格情報は入れない。 */
  readonly details?: Record<string, unknown>
  /** ログにだけ出す内部情報。応答には出さない。 */
  readonly internal?: Record<string, unknown>

  constructor(init: {
    code: ApiErrorCode
    message: string
    status: number
    retryable: boolean
    details?: Record<string, unknown>
    internal?: Record<string, unknown>
    cause?: unknown
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'AppError'
    this.code = init.code
    this.status = init.status
    this.retryable = init.retryable
    this.details = init.details
    this.internal = init.internal
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}

type ErrorInit = {
  message?: string
  details?: Record<string, unknown>
  internal?: Record<string, unknown>
  cause?: unknown
}

/**
 * コードと HTTP status の対応。
 *
 * route ごとに status を選ばせると、同じ失敗が API ごとに別の status で
 * 返る。ここを唯一の対応表にし、OpenAPI 生成もこの表を読む。
 */
export const ERROR_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  PRECONDITION_REQUIRED: 428,
  PRECONDITION_FAILED: 409,
  CONSENT_REQUIRED: 403,
  FEATURE_NOT_CONNECTED: 501,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  INTERNAL: 500,
}

/**
 * 同じ要求をそのまま再送して成功しうるか。
 *
 * 予期しない例外 (INTERNAL) は副作用が確定したかを判定できないため false にし、
 * クライアントの自動再送で二重実行が起きないようにする。
 */
export const ERROR_RETRYABLE: Record<ApiErrorCode, boolean> = {
  VALIDATION_FAILED: false,
  UNAUTHENTICATED: false,
  FORBIDDEN: false,
  NOT_FOUND: false,
  CONFLICT: false,
  IDEMPOTENCY_KEY_REUSED: false,
  PRECONDITION_REQUIRED: false,
  PRECONDITION_FAILED: false,
  CONSENT_REQUIRED: false,
  FEATURE_NOT_CONNECTED: false,
  PAYLOAD_TOO_LARGE: false,
  UNSUPPORTED_MEDIA_TYPE: false,
  RATE_LIMITED: true,
  UNAVAILABLE: true,
  INTERNAL: false,
}

function factory(code: ApiErrorCode, fallbackMessage: string) {
  return (init: ErrorInit = {}) =>
    new AppError({
      code,
      status: ERROR_STATUS[code],
      retryable: ERROR_RETRYABLE[code],
      message: init.message ?? fallbackMessage,
      details: init.details,
      internal: init.internal,
      cause: init.cause,
    })
}

/** 既知のエラー。status と retryable は上の対応表が決める。 */
export const errors = {
  validationFailed: factory('VALIDATION_FAILED', '入力内容が正しくありません。'),
  unauthenticated: factory('UNAUTHENTICATED', 'ログインが必要です。'),
  forbidden: factory('FORBIDDEN', 'この操作を行う権限がありません。'),
  notFound: factory('NOT_FOUND', '対象が見つかりません。'),
  conflict: factory('CONFLICT', '他の更新と競合しました。最新の内容を取得してからやり直してください。'),
  idempotencyKeyReused: factory('IDEMPOTENCY_KEY_REUSED', '同じキーで異なる内容の要求が送信されました。'),
  preconditionRequired: factory('PRECONDITION_REQUIRED', '要求に必要なヘッダーまたは版の指定がありません。'),
  preconditionFailed: factory('PRECONDITION_FAILED', '現在の状態ではこの操作を実行できません。'),
  consentRequired: factory('CONSENT_REQUIRED', '必要な同意が取得されていません。'),
  featureNotConnected: factory('FEATURE_NOT_CONNECTED', 'この機能はまだ接続されていません。'),
  payloadTooLarge: factory('PAYLOAD_TOO_LARGE', '送信された内容が大きすぎます。'),
  unsupportedMediaType: factory('UNSUPPORTED_MEDIA_TYPE', '対応していない形式です。'),
  rateLimited: factory('RATE_LIMITED', '要求が多すぎます。時間をおいてやり直してください。'),
  unavailable: factory('UNAVAILABLE', '一時的に処理できませんでした。時間をおいてやり直してください。'),
  internal: factory('INTERNAL', 'サーバー内部でエラーが発生しました。'),
} as const
