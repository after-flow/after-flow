import { z } from 'zod'

/**
 * 公開 API が共通で使う入力スキーマ。
 *
 * ここに無い形を route ごとに書き足すと、同じ概念に別の制約が付く。
 * 新しい共通概念が必要になったら、この一覧へ追加する。
 */

/** 保存側が生成する識別子。クライアントからの任意文字列を ID にしない。 */
export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'ID に使用できない文字が含まれています')

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD の形式で指定してください')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), '存在しない日付です')

export const isoDateTimeSchema = z.iso.datetime({ offset: true })

/**
 * カーソル。
 *
 * 中身はサーバーの実装都合であり、クライアントは解釈しない。
 * 長さと字種だけを検証し、改竄された値は復号側 (#5) が拒否する。
 */
export const cursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/, 'カーソルの形式が正しくありません')

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 100

/**
 * 一覧の共通 query。
 *
 * `limit` の上限を設けるのは、1 回の要求で Firestore の読み取りと
 * 応答サイズが際限なく増えるのを防ぐため。続きは cursor で取得する。
 */
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: cursorSchema.optional(),
})

export type ListQuery = z.infer<typeof listQuerySchema>

export const caseIdParamSchema = z.object({ caseId: idSchema })

/** 更新要求の共通部分。楽観ロックの版は必ずクライアントが指定する。 */
export const expectedVersionSchema = z.number().int().min(0)

/** 公開 API の共通エラーコード。public-contracts の ApiErrorCode と対応する。 */
export const apiErrorCodeSchema = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'PRECONDITION_REQUIRED',
  'PRECONDITION_FAILED',
  'CONSENT_REQUIRED',
  'FEATURE_NOT_CONNECTED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'UNAVAILABLE',
  'INTERNAL',
])

export const responseMetaSchema = z.object({
  requestId: z.string(),
  nextCursor: z.string().optional(),
})

export const apiErrorBodySchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
})

export const apiFailureSchema = z.object({
  error: apiErrorBodySchema,
  meta: responseMetaSchema,
})

export function successEnvelope<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: responseMetaSchema })
}
