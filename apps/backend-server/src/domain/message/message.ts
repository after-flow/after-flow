import type { EntityBase } from '../shared/entity.js'

/**
 * チャットの発言（仕様書 6.2）。
 *
 * 利用者の発言と AI の回答を同じ並びに保存するが、どちらが書いたかは
 * 必ず区別できるようにする。回答は説明であり、それだけで正式な事実を
 * 登録したり手続きを完了したりしない。
 */
export interface MessageEntity extends EntityBase {
  role: 'user' | 'assistant'
  body: string
  /** 回答を生成した実行。利用者の発言では null。 */
  agentRunId: string | null
  /** この発言に対する回答の実行。AI の発言では null。 */
  replyRunId: string | null
  /** 個別の法律・税務判断が必要な内容を含む場合の定型注記。 */
  professionalNotice: boolean
  /** 専門家への引継ぎが必要と判定された場合の提案参照。 */
  escalationProposalId: string | null
  /** 結果の重複排除に使う。同じ結果 ID の再送で二重に増やさない。 */
  resultId: string | null
  /** 旧保存データとの互換のため省略可能。新しいAI回答では必ず保存する。 */
  attemptId?: string
}
