import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { qk, useDocuments } from '@/lib/api/queries'
import type { Approval, Paginated } from '@aftercare/public-contracts'
import { toast } from '@/kit/toast'

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
    refetchInterval: (q) => (q.state.data?.items.some((d) => d.analysisStatus === 'ANALYZING') ? 3_000 : false),
    // スマホで書類を撮ったあと、別のアプリへ切り替えて待つことが多い。
    // 画面が裏にある間も読み取りの終わりを取り込み、戻ったときに件数が合っているようにする（読み取り中の間だけ）
    refetchIntervalInBackground: true,
  })
  // 前回見たときに読み取り中だった書類
  const analyzing = useRef<Set<string> | null>(null)

  useEffect(() => {
    const items = docs.data?.items
    if (!items) return
    const now = new Set(items.filter((d) => d.analysisStatus === 'ANALYZING').map((d) => d.id))
    const before = analyzing.current
    analyzing.current = now
    // 初回は基準を取るだけ（画面を開いた時点ですでに終わっているものは知らせない）
    if (!before) return

    const finished = items.filter((d) => before.has(d.id) && !now.has(d.id))
    if (finished.length === 0) return

    const others = [
      qk.insights(caseId),
      qk.overview(caseId),
      qk.tasks(caseId),
      qk.assets(caseId),
      qk.liabilities(caseId),
      qk.contracts(caseId),
      ['documents'],
      ['tasks'],
    ]
    for (const key of others) void qc.invalidateQueries({ queryKey: key })

    // 確認（Approval）を取り直してから、書類ごとに何件届いたかを数えて知らせる。
    // 読み取っても確認が1件も無いことはあるので、「届いています」と決めつけない
    void qc.invalidateQueries({ queryKey: qk.approvals(caseId) }).then(() => {
      const approvals = qc.getQueryData<Paginated<Approval>>(qk.approvals(caseId))?.items ?? []
      for (const d of finished) {
        if (d.analysisStatus === 'NEEDS_REVIEW') {
          toast(`「${d.fileName}」は読み取れませんでした。「書類」から内容を確かめてください。`, 'error')
          continue
        }
        const n = approvals.filter((a) => a.sourceDocumentId === d.id && a.status === 'PENDING').length
        toast(
          n > 0
            ? `「${d.fileName}」の読み取りが終わりました。「AIからの確認」に${n}件届いています。`
            : `「${d.fileName}」の読み取りが終わりました。確認していただくものはありませんでした。`,
        )
      }
    })
  }, [docs.data, caseId, qc])
}
