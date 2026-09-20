import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useInsights, useUpdateInsightStatus } from '@/lib/api/queries'
import { Card, EmptyState, ErrorState, PageHeader, Spinner } from '@/components/ui/Primitives'
import { Banner } from '@/components/ui/Banner'
import { InsightCard } from '@/components/domain/InsightCard'
import { isDisplayableInsight } from '@/lib/insights'

export function InsightsPage() {
  const { caseId = '' } = useParams()
  const { data, isLoading, isError, refetch } = useInsights(caseId)
  const update = useUpdateInsightStatus(caseId)
  const [showClosed, setShowClosed] = useState(false)

  // 表示できないものは件数にも含めない（InsightCard 側の判定とそろえる）
  const all = (data?.items ?? []).filter(isDisplayableInsight)
  const items = all.filter((i) => (showClosed ? true : i.status !== 'DISMISSED'))
  const newCount = all.filter((i) => i.status === 'NEW').length

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="AIが気づいたこと"
        title="気づきの一覧"
        description={
          newCount > 0
            ? `まだ見ていない気づきが ${newCount} 件あります。`
            : 'AIが手続きの状況を見ていて気づいたことをお伝えします。'
        }
      />

      <Banner tone="info" title="ここに出るのは「気づき」です">
        手続きの進み具合や書類の内容を見ていて気づいたことをお伝えしています。承認や操作は必要ありません。
        法律・税務の判断は行いませんので、判断が必要な場合は専門家へご相談ください。
      </Banner>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-5 w-5 accent-[var(--color-brand)]"
          checked={showClosed}
          onChange={(e) => setShowClosed(e.target.checked)}
        />
        閉じた指摘も表示する
      </label>

      {isLoading && <Spinner />}
      {isError && (
        <ErrorState message="気づきを取得できませんでした。" onRetry={() => void refetch()} />
      )}

      {data && items.length === 0 && (
        <Card>
          <EmptyState
            title="いまお伝えすることはありません"
            description="手続きが止まっていたり、書類から気になる点が見つかったときにここへ表示します。"
          />
        </Card>
      )}

      <ul className="flex flex-col gap-3">
        {items.map((insight) => (
          <li key={insight.id} className={insight.status === 'DISMISSED' ? 'opacity-60' : ''}>
            <InsightCard
              caseId={caseId}
              insight={insight}
              onAcknowledge={() =>
                void update.mutateAsync({ id: insight.id, status: 'ACKNOWLEDGED' })
              }
              onDismiss={
                insight.status === 'DISMISSED'
                  ? undefined
                  : () => void update.mutateAsync({ id: insight.id, status: 'DISMISSED' })
              }
            />
          </li>
        ))}
      </ul>
    </div>
  )
}
