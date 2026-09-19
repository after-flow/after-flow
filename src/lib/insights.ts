import type { Insight } from '@/api/types'

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
