import type { Insight } from '@aftercare/public-contracts'

/**
 * 画面に出してよい気づきか。
 *
 * 根拠（evidence）のない指摘は、利用者が自分で確かめられないため表示しない。
 * 件数を数える側もこの関数を通す。そろえておかないと、
 * バッジは「3件」なのに一覧には何も出ない、という食い違いが起きる。
 */
export function isDisplayableInsight(insight: Insight): boolean {
  return insight.evidence.length > 0
}

/**
 * 前回からの持ち越しにあたる気づきか（止まっている手続き・前提の変化）。
 * 放っておくと手続きが進まなくなるものなので、ホームと手続きの画面で目立たせる。
 */
export function isCarriedOver(insight: Insight): boolean {
  return insight.kind === 'STALLED_TASK' || insight.kind === 'INCONSISTENCY'
}
