import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { DocumentResource } from '@aftercare/public-contracts'
import { qk, useDocuments } from '@/lib/api/queries'
import { pendingApprovalRefCount } from '@/lib/model/document'
import { toast } from '@/kit/toast'

function isAnalyzing(d: DocumentResource): boolean {
  return d.analysis.state === 'QUEUED' || d.analysis.state === 'RUNNING'
}

/**
 * 書類の読み取りの終わりを見張る。
 *
 * 書類はサイドバーの「書類を追加」から追加され、利用者はそのままホームなど別の画面にいることが多い。
 * 読み取りが終わると、サーバー側で確認（Approval）・気づき・必要書類の状態などが増えるが、
 * それを誰も取りに行かないと「AIからの確認」の件数も一覧も古いままになる。
 *
 * そこで画面の枠（どの画面でも表示される）で、読み取り中の書類がある間だけ書類一覧を追いかけ、
 * 読み取りが終わった書類を見つけたら関係する情報を取り直し、利用者にも知らせる。
 */
export function useAnalysisWatcher(caseId: string) {
  const qc = useQueryClient()
  const docs = useDocuments(caseId, {
    refetchInterval: (q) => (q.state.data?.items.some(isAnalyzing) ? 3_000 : false),
    // スマホで書類を撮ったあと、別のアプリへ切り替えて待つことが多い。
    // 画面が裏にある間も読み取りの終わりを取り込み、戻ったときに件数が合っているようにする（読み取り中の間だけ）
    refetchIntervalInBackground: true,
  })
  // 前回見たときに読み取り中だった書類
  const analyzing = useRef<Set<string> | null>(null)

  useEffect(() => {
    const items = docs.data?.items
    if (!items) return
    const now = new Set(items.filter(isAnalyzing).map((d) => d.id))
    const before = analyzing.current
    analyzing.current = now
    // 初回は基準を取るだけ（画面を開いた時点ですでに終わっているものは知らせない）
    if (!before) return

    const finished = items.filter((d) => before.has(d.id) && !now.has(d.id))
    if (finished.length === 0) return

    for (const key of [
      qk.insights(caseId),
      qk.overview(caseId),
      qk.tasks(caseId),
      qk.assets(caseId),
      qk.liabilities(caseId),
      qk.contracts(caseId),
      qk.approvals(caseId),
    ]) {
      void qc.invalidateQueries({ queryKey: key })
    }

    // DocumentResource は自分に紐づく approvalRefs を持つため、Approval を取り直さなくても
    // 直近の一覧取得（このフックが追いかけている docs）だけで件数を数えられる
    for (const d of finished) {
      if (d.analysis.state === 'FAILED') {
        toast(`「${d.fileName}」は読み取れませんでした。「書類」から内容を確かめてください。`, 'error')
        continue
      }
      const n = pendingApprovalRefCount(d)
      toast(
        n > 0
          ? `「${d.fileName}」の読み取りが終わりました。「AIからの確認」に${n}件届いています。`
          : `「${d.fileName}」の読み取りが終わりました。確認していただくものはありませんでした。`,
      )
    }
  }, [docs.data, caseId, qc])
}
