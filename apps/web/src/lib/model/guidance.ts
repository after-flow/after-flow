import type { GuidanceResource } from '@aftercare/public-contracts'

/**
 * 案内の表示状態。
 *
 * `status`（実行の進み方）と `outcome`（どの経路で終わったか）は別物で、
 * 調べずに終わった案内も `status` は COMPLETED になりうる。画面はこの2つを
 * 合わせて判断する。「調べた」と言えるのは、確かめられる出典が残っている
 * ときだけ。
 */
export type GuidanceDisplayState =
  /** まだ依頼していない。 */
  | 'NOT_REQUESTED'
  /** 実行中、または書類待ち。 */
  | 'RESEARCHING'
  /** 公式の情報源を調べ、出典が残っている。 */
  | 'RESEARCHED'
  /** 案件の情報が足りず、調べる前に終わった。 */
  | 'MISSING_CONTEXT'
  /** 自動で調べられる手続きではない。 */
  | 'NOT_RESEARCHABLE'
  /** 調べたが確認できなかった。 */
  | 'FAILED'
  /** 終了しているが、出典が無く「調べた」とは言えない。 */
  | 'NO_SOURCES'

export function guidanceDisplayState(guidance: GuidanceResource | undefined): GuidanceDisplayState {
  if (!guidance || guidance.status === 'NOT_REQUESTED') return 'NOT_REQUESTED'
  if (guidance.status === 'RESEARCHING' || guidance.status === 'WAITING') return 'RESEARCHING'
  if (guidance.status === 'FAILED' || guidance.outcome === 'FAILED') return 'FAILED'
  if (guidance.outcome === 'MISSING_CONTEXT') return 'MISSING_CONTEXT'
  if (guidance.outcome === 'SOURCE_NOT_CONFIGURED' || guidance.outcome === 'NOT_APPLICABLE') return 'NOT_RESEARCHABLE'
  // outcome が無い古い記録もここへ来る。出典の有無だけで判断し、AIが調べたことにしない。
  return guidance.researchedBy === 'AI' && guidance.sources.length > 0 ? 'RESEARCHED' : 'NO_SOURCES'
}
