import { Link, useNavigate, useParams } from 'react-router-dom'
import { useDeleteDocument, useDocument } from '@/api/queries'
import { Button, Card, DefinitionRow, ErrorState, Spinner } from '@/components/ui/Primitives'
import { Banner } from '@/components/ui/Banner'
import { Icon } from '@/components/ui/Icon'
import { DOCUMENT_KIND_LABEL, DOCUMENT_STATUS_META, AGENT_RUN_TYPE_LABEL } from '@/lib/labels'
import { formatDateTime, formatFileSize } from '@/lib/format'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/ui/Modal'

export function DocumentDetailPage() {
  const { caseId = '', documentId = '' } = useParams()
  const navigate = useNavigate()
  const { data: doc, isLoading, isError, refetch } = useDocument(documentId)
  const del = useDeleteDocument(caseId)
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (isLoading) return <Spinner />
  if (isError || !doc)
    return <ErrorState message="書類を取得できませんでした。" onRetry={() => void refetch()} />

  const status = DOCUMENT_STATUS_META[doc.analysisStatus]
  const linkedApprovals = (doc.extractions ?? []).filter((e) => e.approvalId)

  return (
    <div className="flex flex-col gap-4">
      <Link to={`/cases/${caseId}/documents`} className="inline-flex items-center gap-1 text-sm font-bold text-[var(--color-brand)] underline">
        <Icon name="chevron-left" size={16} />
        書類一覧へ戻る
      </Link>

      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold">{doc.fileName}</h1>
        <span className={`badge ${status.className}`}>{status.label}</span>
      </header>

      {doc.myNumberScan === 'MASKED' && (
        <Banner tone="warning" title="一部を隠して保存しています">
          マイナンバーらしき記載を検出したため、該当箇所を隠したうえで保存しています。
        </Banner>
      )}

      <Card title="書類の情報">
        <dl>
          <DefinitionRow label="書類種別">
            {DOCUMENT_KIND_LABEL[doc.kind]}
            {doc.kindSource === 'AI' && (
              <span className="badge badge-blue ml-2">AI推定</span>
            )}
          </DefinitionRow>
          <DefinitionRow label="アップロード日時">{formatDateTime(doc.uploadedAt)}</DefinitionRow>
          <DefinitionRow label="ファイルサイズ">{formatFileSize(doc.sizeBytes)}</DefinitionRow>
          <DefinitionRow label="解析の実行">
            {doc.agentRunId ? (
              <>
                {AGENT_RUN_TYPE_LABEL.document_analysis}（実行ID：{doc.agentRunId}）
              </>
            ) : (
              'まだ実行されていません'
            )}
          </DefinitionRow>
        </dl>
      </Card>

      <Card title="読み取った内容">
        {doc.analysisStatus === 'ANALYZING' && (
          <p className="text-[var(--color-ink-muted)]">解析中です。しばらくお待ちください。</p>
        )}
        {doc.analysisStatus !== 'ANALYZING' && (doc.extractions?.length ?? 0) === 0 && (
          <p className="text-[var(--color-ink-muted)]">読み取れた内容はありませんでした。</p>
        )}
        {(doc.extractions?.length ?? 0) > 0 && (
          <dl>
            {doc.extractions!.map((ex) => (
              <DefinitionRow key={ex.id} label={ex.label}>
                <span>{ex.value}</span>
                {ex.approvalId && (
                  <Link
                    className="ml-3 text-sm font-bold text-[var(--color-brand)] underline"
                    to={`/cases/${caseId}/approvals/${ex.approvalId}`}
                  >
                    関連する提案を見る
                  </Link>
                )}
              </DefinitionRow>
            ))}
          </dl>
        )}

        <div className="mt-4">
          <Banner tone="warning">
            解析結果はすべての財産・契約を見つけられるとは限りません。表示されていない財産・契約がある場合は、手動で追加してください。
          </Banner>
        </div>

        {linkedApprovals.length > 0 && (
          <div className="mt-4">
            <Link className="btn btn-primary" to={`/cases/${caseId}/approvals`}>
              関連する提案を確認する（{linkedApprovals.length} 件）
            </Link>
          </div>
        )}
      </Card>

      <div>
        <Button variant="danger" onClick={() => setConfirmDelete(true)}>
          この書類を削除する
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="この書類を削除しますか？"
        description="削除すると、この書類とその読み取り結果は表示されなくなります。すでに反映された財産・契約・タスクの情報は残ります。"
        confirmLabel="削除する"
        confirmVariant="danger"
        disabled={del.isPending}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await del.mutateAsync(doc.id)
          navigate(`/cases/${caseId}/documents`)
        }}
      />
    </div>
  )
}
