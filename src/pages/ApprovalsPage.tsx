import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useApprovals } from '@/api/queries'
import { Card, EmptyState, ErrorState, PageHeader, Spinner } from '@/components/ui/Primitives'
import { Banner } from '@/components/ui/Banner'
import { APPROVAL_KIND_LABEL, APPROVAL_STATUS_META } from '@/lib/labels'
import { formatDateTime } from '@/lib/format'
import { Icon } from '@/components/ui/Icon'
import type { ApprovalKind } from '@/api/types'

export function ApprovalsPage() {
  const { caseId = '' } = useParams()
  const { data, isLoading, isError, refetch } = useApprovals(caseId)
  const [kind, setKind] = useState<'all' | ApprovalKind>('all')
  const [showDecided, setShowDecided] = useState(false)

  const items = (data?.items ?? [])
    .filter((a) => kind === 'all' || a.kind === kind)
    .filter((a) => (showDecided ? true : a.status === 'PENDING'))

  const pendingCount = (data?.items ?? []).filter((a) => a.status === 'PENDING').length

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="承認"
        title="AIからの提案の確認"
        description={`確認をお待ちしている提案が ${pendingCount} 件あります。`}
      />

      {/* 「反映確認であって実行許可ではない」ことを一覧の時点で明示する */}
      <Banner tone="info" title="ここでの確認は「ケースの情報に反映してよいか」の確認です">
        承認しても、役所・金融機関への提出・送信・解約・お支払いは行われません。これらはご本人（ご遺族）に行っていただきます。
      </Banner>

      <Card bodyClassName="p-3 sm:p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm font-bold">
            種別
            <select
              className="select"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'all' | ApprovalKind)}
            >
              <option value="all">すべて</option>
              {(Object.keys(APPROVAL_KIND_LABEL) as ApprovalKind[]).map((k) => (
                <option key={k} value={k}>
                  {APPROVAL_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 pb-2.5">
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--color-brand)]"
              checked={showDecided}
              onChange={(e) => setShowDecided(e.target.checked)}
            />
            確認済みのものも表示する
          </label>
        </div>
      </Card>

      {isLoading && <Spinner />}
      {isError && <ErrorState message="提案を取得できませんでした。" onRetry={() => void refetch()} />}

      {data && items.length === 0 && (
        <Card>
          <EmptyState
            title="確認をお待ちしている提案はありません"
            description="書類をアップロードすると、内容に応じた提案が作成されます。"
          />
        </Card>
      )}

      <ul className="flex flex-col gap-2.5">
        {items.map((a) => {
          const status = APPROVAL_STATUS_META[a.status]
          return (
            <li key={a.id}>
              <Link
                to={`/cases/${caseId}/approvals/${a.id}`}
                className="row-card p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="badge badge-blue">
                    <Icon name="pencil" size={14} />
                    反映のご確認
                  </span>
                  <span className="badge badge-gray">{APPROVAL_KIND_LABEL[a.kind]}</span>
                  <span className={`badge ${status.className}`}>{status.label}</span>
                  {a.assetDisposal && (
                    <span className="badge badge-red">
                      <Icon name="warning" size={14} />
                      財産の処分に関わる可能性
                    </span>
                  )}
                </div>
                <p className="mt-1.5 font-bold">{a.title}</p>
                <p className="text-[var(--color-ink-muted)]">{a.summary}</p>
                <p className="mt-0.5 text-sm text-[var(--color-ink-faint)]">
                  {formatDateTime(a.createdAt)}
                  {a.sourceDocumentName ? ` ・ ${a.sourceDocumentName} から` : ''}
                </p>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
