/**
 * 公開 API の共通レスポンス契約（仕様書 6.1）。
 *
 * 成功は `{ data, meta }`、失敗は `{ error, meta }` で返す。
 * どちらにも `meta.requestId` が必ず入り、利用者からの問い合わせとサーバーログを突き合わせられる。
 *
 * ここは型だけを置く。実行時検証の Zod スキーマは Backend 側に置き、
 * Web のバンドルへ検証ライブラリーが入らないようにしている。
 */

/**
 * 共通エラーコード。
 *
 * HTTP status だけでは「入力が不正」と「版が競合した」を区別できないため、
 * クライアントが分岐に使える語をコードとして固定する。
 */
export type ApiErrorCode =
  /** path/query/body が契約を満たさない */
  | 'VALIDATION_FAILED'
  /** 認証情報が無い、または検証できない */
  | 'UNAUTHENTICATED'
  /** 認証済みだが、その Case・操作の権限が無い */
  | 'FORBIDDEN'
  /** 対象が存在しない、または権限が無いため存在を明かさない */
  | 'NOT_FOUND'
  /** expectedVersion 不一致、重複登録など、現在の状態と両立しない要求 */
  | 'CONFLICT'
  /** 同じ Idempotency-Key で異なる内容が送られた */
  | 'IDEMPOTENCY_KEY_REUSED'
  /** 状態を変える要求に Idempotency-Key / expectedVersion が無い */
  | 'PRECONDITION_REQUIRED'
  /** 現在の業務状態ではその操作が許可されない（Rule による拒否） */
  | 'PRECONDITION_FAILED'
  /** 必須同意が未取得、または同意の版がずれている */
  | 'CONSENT_REQUIRED'
  /** 契約上は定義済みだが、まだ実機能が接続されていない */
  | 'FEATURE_NOT_CONNECTED'
  /** body が上限を超えた */
  | 'PAYLOAD_TOO_LARGE'
  /** Content-Type が対応外 */
  | 'UNSUPPORTED_MEDIA_TYPE'
  /** 呼び出し頻度の制限 */
  | 'RATE_LIMITED'
  /** 依存先の一時障害。時間をおけば成功しうる */
  | 'UNAVAILABLE'
  /** 予期しない例外。内部情報は応答に含めない */
  | 'INTERNAL'

export interface ApiErrorBody {
  code: ApiErrorCode
  /** 利用者に見せてよい説明。stack や入力全文は含めない。 */
  message: string
  /**
   * 同じ要求をそのまま再送して成功しうるか。
   * 冪等でない操作を無条件に再送させないため、サーバーが明示する。
   */
  retryable: boolean
  /** 入力不正の該当項目など、機械可読な補足。秘匿値は入れない。 */
  details?: Record<string, unknown>
}

export interface ResponseMeta {
  /** サーバーが採番、または受け取った X-Request-Id を引き継いだ値 */
  requestId: string
  /**
   * 次ページのカーソル。最終ページでは省略する。
   * 1 ページ目だけを全件として扱わないために、件数ではなくカーソルを正本にする。
   */
  nextCursor?: string
}

export interface ApiSuccess<T> {
  data: T
  meta: ResponseMeta
}

export interface ApiFailure {
  error: ApiErrorBody
  meta: ResponseMeta
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure

/**
 * カーソルページングの一覧。
 *
 * 旧 `Paginated<T>` の `total` は 1 ページ目だけを全件と誤解させるため、
 * 新契約では `data` に配列を置き、続きの有無は `meta.nextCursor` で表す。
 * 旧 DTO への変換は Web の公開クライアント境界で行う（#3 の対応表）。
 */
export type ApiListSuccess<T> = ApiSuccess<T[]>
