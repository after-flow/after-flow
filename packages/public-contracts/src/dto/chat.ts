import type { ISODateTime } from './resources.js'

/**
 * 新しい公開契約のチャットと手順案内。
 *
 * 既存の `ChatMessage` / `TaskGuidance` はモックのフロントが参照している
 * ため変更しない。旧 DTO への変換は Web の公開クライアント境界で行う。
 */

export interface MessageResource {
  id: string
  caseId: string
  role: 'user' | 'assistant'
  body: string
  /** 回答を生成した実行。利用者の発言では null。 */
  agentRunId: string | null
  /** 利用者の発言に対して受け付けた回答の実行。 */
  replyRunId: string | null
  professionalNotice: boolean
  escalationProposalId: string | null
  createdAt: ISODateTime
}

/** 発言の受付結果。回答が始まらない場合は理由を返す。 */
export interface MessageAcceptedResource {
  message: MessageResource
  runId: string | null
  /** 回答の実行を受け付けたか。false のとき reason に理由が入る。 */
  runAccepted: boolean
  reason: string | null
}

export type GuidanceStatusResource =
  | 'NOT_REQUESTED'
  | 'RESEARCHING'
  | 'WAITING'
  | 'COMPLETED'
  /** 一部しか確認できなかった。 */
  | 'PARTIAL'
  | 'FAILED'

/** AI案内がどの経路で終了したか。nullは実行中またはlegacyデータ。 */
export type GuidanceOutcomeResource =
  | 'COMPLETED_RESEARCH'
  | 'MISSING_CONTEXT'
  | 'SOURCE_NOT_CONFIGURED'
  | 'NOT_APPLICABLE'
  | 'FAILED'

export interface GuidanceSourceResource {
  label: string
  url: string
  /** いつ時点の情報か。 */
  checkedAt: ISODateTime
}

/** 案内の1項目の根拠となる公式資料の引用。 */
export interface GuidanceCitationResource {
  item: 'where' | 'bring' | 'steps'
  /** その区分内の項目番号（0始まり）。 */
  index: number
  sourceUrl: string
  sectionHeading: string | null
  quote: string
}

export interface GuidanceResource {
  taskId: string
  status: GuidanceStatusResource
  outcome: GuidanceOutcomeResource | null
  target: string | null
  where: string | null
  bring: string[]
  steps: string[]
  formExampleUrl: string | null
  formExampleLabel: string | null
  note: string | null
  /** 出典と確認日。これが無い案内をそのまま信じさせない。 */
  sources: GuidanceSourceResource[]
  /** 項目ごとの根拠。本文との逐語一致を確かめた引用だけが入る。 */
  citations: GuidanceCitationResource[]
  /** 調べきれなかった項目。空でないときは全件確認済みではない。 */
  missing: string[]
  failureReason: string | null
  researchedBy: 'AI' | 'MANUAL' | null
  agentRunId: string | null
  version: number
  updatedAt: ISODateTime
}
