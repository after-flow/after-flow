import type { EntityBase } from '../shared/entity.js'

/**
 * 相続方法についての本人の意思（仕様書 7・8 章）。
 *
 * 下書き、本人以外による報告、本人による確定を区別する。
 * 選択欄が埋まっただけで確定として扱うと、他人が本人の意思を
 * 決めたことになる。
 */
export type InheritanceMethod = 'SIMPLE_ACCEPTANCE' | 'LIMITED_ACCEPTANCE' | 'RENUNCIATION'

export type DecisionState =
  /** 家族が入力した下書き。本人の意思ではない。 */
  | 'DRAFT'
  /** 本人以外が「本人はこう言っている」と報告した状態。 */
  | 'REPORTED'
  /** 本人自身が確定した。 */
  | 'CONFIRMED'

export interface InheritanceDecisionEntity extends EntityBase {
  /** 対象の相続人。Case 内の Person を指す。 */
  personId: string
  method: InheritanceMethod | null
  state: DecisionState
  /** 下書き・報告を入力した利用者。 */
  reportedByUserId: string | null
  /** 本人として確定した利用者。本人と紐付く membership だけが入る。 */
  confirmedByUserId: string | null
  confirmedAt: string | null
  /** 確定の根拠として残す説明。 */
  note: string | null
}

/**
 * 制限を解除してよいか。
 *
 * 確定していない意思で放棄前ロックを外さない。method が入っているだけ、
 * 他人が報告しただけでは解除しない。
 */
export function isDecisionConfirmed(decision: InheritanceDecisionEntity): boolean {
  return decision.state === 'CONFIRMED' && decision.method !== null
}
