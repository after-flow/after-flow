import { z } from 'zod'

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
export const sourceCandidateSchema = z.object({
  id, catalogId: id, title: z.string().min(1).max(120), issuer: z.string().min(1).max(200), url: z.string().url().max(2000),
}).strict()

/**
 * 本文の区分（#165）。
 *
 * 見出し単位で本文を分け、根拠の位置を「どの見出しの下か」で示せるようにする。
 * ページ全体を1つの塊として渡すと、ナビゲーションまで根拠に見え、
 * 利用者はどの文章が根拠なのかを確認できない。
 */
export const sourceSectionSchema = z.object({
  /** 資料内で一意な区分ID。claimはsource IDとこのIDの組で根拠を指す。 */
  id: z.string().regex(/^s\d{1,3}$/),
  /** 見出しの文言。見出しより前の本文ではnull。 */
  heading: z.string().min(1).max(200).nullable(),
  /** HTMLの見出しに付いたid属性。URLの断片として根拠箇所へ直接移動できる。 */
  anchor: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/).nullable(),
  text: z.string().min(1).max(20000),
}).strict()

/** 公式ページに掲載された申請書・記入例。ハーネスが決定的に抽出し、モデルは生成しない。 */
export const sourceFormSchema = z.object({
  label: z.string().min(1).max(120), url: z.string().url().max(2000),
  kind: z.enum(['FORM', 'EXAMPLE']),
}).strict()

export const sourceDocumentSchema = sourceCandidateSchema.extend({
  text: z.string().min(1).max(60000), location: z.string().min(1).max(500),
  fetchedAt: z.string().datetime(),
  /**
   * 本文の更新時刻。公開ページに明記されている場合だけ入れる。
   * HTTPのLast-ModifiedはCMSの再生成でも変わり、内容の更新を意味しないため使わない。
   */
  updatedAt: z.string().datetime().nullable(),
  /** 正規化した本文のSHA-256（base64url）。取得本文の変更を検出する。 */
  contentHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  sections: z.array(sourceSectionSchema).min(1).max(60),
  forms: z.array(sourceFormSchema).max(10),
}).strict()
export type SourceCandidate = z.infer<typeof sourceCandidateSchema>
export type SourceDocument = z.infer<typeof sourceDocumentSchema>
export type SourceSection = z.infer<typeof sourceSectionSchema>
export type SourceForm = z.infer<typeof sourceFormSchema>
