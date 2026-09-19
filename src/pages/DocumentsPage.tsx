import { Link, useParams } from 'react-router-dom'
import { useDocuments } from '@/api/queries'
import { Card, EmptyState, ErrorState, PageHeader, Spinner } from '@/components/ui/Primitives'
import { Banner } from '@/components/ui/Banner'
import { DocumentUploader } from '@/components/domain/DocumentUploader'
import { DOCUMENT_KIND_ICON, DOCUMENT_KIND_LABEL, DOCUMENT_STATUS_META } from '@/lib/labels'
import { Icon } from '@/components/ui/Icon'
import { formatDateTime, formatFileSize } from '@/lib/format'

export function DocumentsPage() {
  const { caseId = '' } = useParams()
  const { data, isLoading, isError, refetch } = useDocuments(caseId, {
    // 解析中の書類があるうちは定期的に更新する
    refetchInterval: 10_000,
  })

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="書類"
        title="書類の管理"
        description="死亡診断書や戸籍、契約書などをアップロードすると、内容から必要な手続きの候補を整理します。"
      />

      <Card title="書類をアップロードする">
        <DocumentUploader caseId={caseId} />
      </Card>

      <Card title="アップロード済みの書類" bodyClassName="p-3 sm:p-4">
        {isLoading && <Spinner />}
        {isError && (
          <ErrorState message="書類一覧を取得できませんでした。" onRetry={() => void refetch()} />
        )}
        {data && data.items.length === 0 && (
          <EmptyState
            title="まだ書類がありません"
            description="まずは死亡診断書からアップロードしてみてください。"
          />
        )}
        {data && data.items.length > 0 && (
          <ul className="flex flex-col gap-2">
            {data.items.map((doc) => {
              const status = DOCUMENT_STATUS_META[doc.analysisStatus]
              const ic = DOCUMENT_KIND_ICON[doc.kind]
              return (
                <li key={doc.id}>
                  <Link to={`/cases/${caseId}/documents/${doc.id}`} className="row-card flex items-center gap-3 p-3.5">
                    <span
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-xl"
                      style={{ background: ic.bg, color: ic.fg }}
                      aria-hidden
                    >
                      <Icon name={ic.icon} size={22} />
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[1.02rem] font-bold">{doc.fileName}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-[var(--color-ink-faint)]">
                        <span className="badge badge-gray">
                          {DOCUMENT_KIND_LABEL[doc.kind]}
                          {doc.kindSource === 'AI' && '（AI推定）'}
                        </span>
                        <span className={`badge ${status.className}`}>
                          {doc.analysisStatus === 'ANALYZING' && (
                            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                          )}
                          {status.label}
                        </span>
                        {doc.myNumberScan === 'MASKED' && (
                          <span className="badge badge-yellow">一部を隠して保存</span>
                        )}
                      </span>
                      <span className="mt-1 block text-xs text-[var(--color-ink-faint)]">
                        {formatDateTime(doc.uploadedAt)} ・ {formatFileSize(doc.sizeBytes)}
                        {(doc.extractions?.length ?? 0) > 0 &&
                          ` ・ ${doc.extractions!.length}件を読み取り`}
                      </span>
                    </span>

                    <Icon
                      name="chevron-right"
                      size={18}
                      className="shrink-0 text-[var(--color-ink-faint)]"
                    />
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Banner tone="warning">
        解析結果はすべての財産・契約を見つけられるとは限りません。表示されていない財産・契約がある場合は、財産・契約の画面から手動で追加してください。
      </Banner>
    </div>
  )
}
