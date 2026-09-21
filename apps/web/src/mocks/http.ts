/**
 * モックの応答を、公開APIの封筒（仕様書6.1）と同じ形で組み立てる。
 *
 * status とエラーコードの対応は Backend の `shared/app-error.ts` と同じ表を持つ。
 * 表を分けると、同じ失敗がモックと本物で別の status になり、
 * 画面の分岐がモックでだけ通ってしまう。
 */
import { HttpResponse } from 'msw'
import type { ApiErrorCode } from '@aftercare/public-contracts'

const ERROR_STATUS: Record<ApiErrorCode, number> = {
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

/** 同じ要求をそのまま再送して成功しうるか。 */
const ERROR_RETRYABLE: Record<ApiErrorCode, boolean> = {
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

const DEFAULT_MESSAGE: Record<ApiErrorCode, string> = {
  VALIDATION_FAILED: '入力内容が正しくありません。',
  UNAUTHENTICATED: 'ログインが必要です。',
  FORBIDDEN: 'この操作を行う権限がありません。',
  NOT_FOUND: '対象が見つかりません。',
  CONFLICT: '他の更新と競合しました。最新の内容を取得してからやり直してください。',
  IDEMPOTENCY_KEY_REUSED: '同じキーで異なる内容の要求が送信されました。',
  PRECONDITION_REQUIRED: '要求に必要なヘッダーまたは版の指定がありません。',
  PRECONDITION_FAILED: '現在の状態ではこの操作を実行できません。',
  CONSENT_REQUIRED: '必要な同意が取得されていません。',
  FEATURE_NOT_CONNECTED: 'この機能はまだ接続されていません。',
  PAYLOAD_TOO_LARGE: '送信された内容が大きすぎます。',
  UNSUPPORTED_MEDIA_TYPE: '対応していない形式です。',
  RATE_LIMITED: '要求が多すぎます。時間をおいてやり直してください。',
  UNAVAILABLE: '一時的に処理できませんでした。時間をおいてやり直してください。',
  INTERNAL: 'サーバー内部でエラーが発生しました。',
}

function requestId(): string {
  return crypto.randomUUID()
}

export function ok<T>(data: T, status = 200) {
  return HttpResponse.json({ data, meta: { requestId: requestId() } }, { status })
}

/** 一覧。モックは1ページで返しきるため、既定では nextCursor を付けない。 */
export function page<T>(items: T[], nextCursor?: string) {
  const meta = nextCursor === undefined ? { requestId: requestId() } : { requestId: requestId(), nextCursor }
  return HttpResponse.json({ data: items, meta })
}

export function fail(code: ApiErrorCode, message?: string, details?: Record<string, unknown>) {
  return HttpResponse.json(
    {
      error: {
        code,
        message: message ?? DEFAULT_MESSAGE[code],
        retryable: ERROR_RETRYABLE[code],
        ...(details ? { details } : {}),
      },
      meta: { requestId: requestId() },
    },
    { status: ERROR_STATUS[code] },
  )
}

export function notFound(message = '対象が見つかりません。') {
  return fail('NOT_FOUND', message)
}

/**
 * 状態を変える要求には Idempotency-Key を要求する。
 * 付け忘れを本物と同じ 428 で落とし、契約違反を開発中に気づけるようにする。
 */
export function requireIdempotencyKey(request: Request) {
  if (request.headers.get('Idempotency-Key')) return null
  return fail('PRECONDITION_REQUIRED', 'Idempotency-Key ヘッダーが必要です。', { header: 'Idempotency-Key' })
}

/** 更新・コマンドの楽観ロック。未指定は428、食い違いは409。 */
export function requireExpectedVersion(body: unknown, entity: { version: number }) {
  const given = readBody(body).expectedVersion
  if (typeof given !== 'number') {
    return fail('PRECONDITION_REQUIRED', 'expectedVersion の指定が必要です。', { field: 'expectedVersion' })
  }
  if (given !== entity.version) {
    return fail('CONFLICT', '他の更新と競合しました。最新の内容を取得してからやり直してください。', {
      expectedVersion: given,
      currentVersion: entity.version,
    })
  }
  return null
}

/** 契約上必須の項目が無ければ400。契約に無い項目は無視する。 */
export function requireFields(body: unknown, fields: string[]) {
  const record = readBody(body)
  const missing = fields.filter((field) => record[field] === undefined || record[field] === null || record[field] === '')
  if (missing.length === 0) return null
  return fail('VALIDATION_FAILED', '入力内容が正しくありません。', { missing })
}

export function readBody(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return readBody(await request.json())
  } catch {
    return {}
  }
}
