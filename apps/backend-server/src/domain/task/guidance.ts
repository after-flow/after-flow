import type { EntityBase } from '../shared/entity.js'

/**
 * 手続きの案内（仕様書 6.2、GuidanceResearchPanel の永続化）。
 *
 * 窓口・持ち物・受付時間は自治体ごとに違い、変更もされる。
 * 調べた結果をそのまま信じさせないため、出典と確認日、調べきれなかった
 * 項目を必ず添える。
 */
export type GuidanceStatus =
  | 'NOT_REQUESTED'
  | 'RESEARCHING'
  /** 待機中。書類待ちなど、進められない理由がある。 */
  | 'WAITING'
  | 'COMPLETED'
  /** 一部しか確認できなかった。 */
  | 'PARTIAL'
  | 'FAILED'

export interface GuidanceSource {
  label: string
  url: string
  /** いつ時点の情報か。 */
  checkedAt: string
}

export interface GuidanceEntity extends EntityBase {
  taskId: string
  status: GuidanceStatus
  /** 何について調べたか（例: 架空市 戸籍住民課）。 */
  target: string | null
  where: string | null
  bring: string[]
  steps: string[]
  /** 公的機関が公開している様式・記入例へのリンク。本文の生成はしない。 */
  formExampleUrl: string | null
  formExampleLabel: string | null
  note: string | null
  sources: GuidanceSource[]
  /** 調べきれなかった項目。失うと、利用者は全部確認済みだと誤解する。 */
  missing: string[]
  /** FAILED のときの理由。利用者に見せる文言。 */
  failureReason: string | null
  researchedBy: 'AI' | 'MANUAL' | null
  agentRunId: string | null
  /** 結果の重複排除に使う。 */
  resultId: string | null
  /** 結果を受け取った時点の実行の試行。古い試行の結果を弾く。 */
  attemptId: string | null
}

/** 案内が実際に内容を持っているか。受付済みと内容ありを混同しない。 */
export function hasGuidanceContent(guidance: GuidanceEntity): boolean {
  return guidance.status === 'COMPLETED' || guidance.status === 'PARTIAL'
}
