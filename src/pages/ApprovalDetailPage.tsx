import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useApproval, useApproveProposal, useRejectProposal } from '@/api/queries'
import {
  Button,
  Card,
  Checkbox,
  DefinitionRow,
  ErrorState,
  Spinner,
  TextareaInput,
} from '@/components/ui/Primitives'
import { Banner } from '@/components/ui/Banner'
import { ConfirmDialog } from '@/components/ui/Modal'
import { useRenunciationLock } from '@/components/domain/RenunciationLock'
import { AiContent } from '@/components/domain/AiContent'
import { Icon } from '@/components/ui/Icon'
import { APPROVAL_KIND_LABEL, APPROVAL_STATUS_META } from '@/lib/labels'
import { formatDateTime } from '@/lib/format'

export function ApprovalDetailPage() {
  const { caseId = '', approvalId = '' } = useParams()
  const navigate = useNavigate()
  const { data: approval, isLoading, isError, refetch } = useApproval(approvalId)
  const { locked } = useRenunciationLock(caseId)
  const approve = useApproveProposal(caseId)
  const reject = useRejectProposal(caseId)

  const [edits, setEdits] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [confirmApprove, setConfirmApprove] = useState(false)
  const [confirmReject, setConfirmReject] = useState(false)

  if (isLoading) return <Spinner />
  if (isError || !approval)
    return <ErrorState message="提案を取得できませんでした。" onRetry={() => void refetch()} />

  const status = APPROVAL_STATUS_META[approval.status]
  const decided = approval.status !== 'PENDING'
  // 財産処分に相当する提案 × 相続方法が未確定 → 追加の確認ステップを挟む
  const needsExtraConfirmation = approval.assetDisposal && locked
  const canApprove = !decided && (!needsExtraConfirmation || acknowledged)

  return (
    <div className="flex flex-col gap-4">
      <Link to={`/cases/${caseId}/approvals`} className="inline-flex items-center gap-1 text-sm font-bold text-[var(--color-brand)] underline">
        <Icon name="chevron-left" size={16} />
        提案の一覧へ戻る
      </Link>

      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold">AIからの提案</h1>
        <span className={`badge ${status.className}`}>{status.label}</span>
        <span className="badge badge-gray">{APPROVAL_KIND_LABEL[approval.kind]}</span>
      </header>

      {/* 提案の件名と説明はAIが書いた文章なので、アプリの案内と区別して表示する */}
      <AiContent label="AIが作成した提案の説明です">
        <p className="text-lg font-bold">{approval.title}</p>
        <p className="mt-1">{approval.summary}</p>
      </AiContent>

      {/* 承認の意味は必ず表示する（仕様書セクション7） */}
      <Banner tone="info" title="この確認の意味">
        承認すると、この内容がケースの情報として反映されます。役所・金融機関への提出・送信・解約・お支払いは行われません。これらはご本人（ご遺族）に行っていただきます。
      </Banner>

      {needsExtraConfirmation && (
        <Banner tone="critical" title="相続方法が確定していません" role="alert">
          この提案は、財産の処分・現金化に関わる可能性があるとして扱われています。承認する前に、専門家へご相談ください。
        </Banner>
      )}

      <Card title="提案のもとになった情報">
        <dl>
          <DefinitionRow label="作成日時">{formatDateTime(approval.createdAt)}</DefinitionRow>
          <DefinitionRow label="もとになった書類">
            {approval.sourceDocumentId ? (
              <Link
                className="font-bold text-[var(--color-brand)] underline"
                to={`/cases/${caseId}/documents/${approval.sourceDocumentId}`}
              >
                {approval.sourceDocumentName ?? '書類を見る'}
              </Link>
            ) : (
              '—'
            )}
          </DefinitionRow>
          <DefinitionRow label="AIの実行">{approval.agentRunId ?? '—'}</DefinitionRow>
        </dl>
      </Card>

      <Card title="反映される内容">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-[var(--color-line)] text-sm text-[var(--color-ink-muted)]">
                <th className="py-2 pr-3 font-bold">項目</th>
                <th className="py-2 pr-3 font-bold">現在</th>
                <th className="py-2 font-bold">反映後</th>
              </tr>
            </thead>
            <tbody>
              {approval.diff.map((row) => (
                <tr key={row.field} className="border-b border-[var(--color-line)] align-top">
                  <th scope="row" className="py-2.5 pr-3 font-bold">
                    {row.field}
                  </th>
                  <td className="py-2.5 pr-3 text-[var(--color-ink-faint)]">
                    {row.before ?? '（未登録）'}
                  </td>
                  <td className="py-2.5">
                    {row.editable && !decided ? (
                      <input
                        className="input"
                        aria-label={`${row.field}（修正できます）`}
                        value={edits[row.field] ?? row.after ?? ''}
                        onChange={(e) =>
                          setEdits((prev) => ({ ...prev, [row.field]: e.target.value }))
                        }
                      />
                    ) : (
                      <span className="font-bold">{row.after ?? '（削除）'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {approval.diff.some((r) => r.editable) && !decided && (
          <p className="mt-3 text-sm text-[var(--color-ink-muted)]">
            入力欄になっている項目は、内容を直してから承認できます。
          </p>
        )}
      </Card>

      {decided ? (
        <Card title="確認の結果">
          <p>
            {approval.status === 'APPROVED' ? '反映しました。' : '却下しました。'}
            {approval.decidedAt && `（${formatDateTime(approval.decidedAt)}）`}
          </p>
          {approval.decisionNote && (
            <p className="mt-1 text-[var(--color-ink-muted)]">メモ：{approval.decisionNote}</p>
          )}
        </Card>
      ) : (
        <Card title="この提案をどうしますか？">
          <div className="flex flex-col gap-4">
            <TextareaInput
              label="メモ（任意）"
              hint="判断の理由を残しておけます。"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />

            {needsExtraConfirmation && (
              <Checkbox
                checked={acknowledged}
                onChange={setAcknowledged}
                label="相続方法がまだ確定していないこと、財産の処分にあたる可能性があることを理解しました"
              />
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={!canApprove || approve.isPending}
                onClick={() => setConfirmApprove(true)}
              >
                {Object.keys(edits).length > 0 ? '修正した内容で反映する' : 'この内容で反映する'}
              </Button>
              <Button variant="danger" disabled={reject.isPending} onClick={() => setConfirmReject(true)}>
                反映しない（却下）
              </Button>
            </div>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={confirmApprove}
        title="この内容をケースの情報に反映しますか？"
        description="反映されるのはこのアプリ内の情報だけです。役所・金融機関への提出・送信・解約は行われません。"
        confirmLabel="反映する"
        disabled={approve.isPending}
        onClose={() => setConfirmApprove(false)}
        onConfirm={async () => {
          await approve.mutateAsync({
            approvalId: approval.id,
            edits: Object.keys(edits).length > 0 ? edits : undefined,
            note: note.trim() || undefined,
          })
          setConfirmApprove(false)
          navigate(`/cases/${caseId}/approvals`)
        }}
      />

      <ConfirmDialog
        open={confirmReject}
        title="この提案を却下しますか？"
        description="却下すると、この内容はケースの情報に反映されません。あとから手動で追加することもできます。"
        confirmLabel="却下する"
        confirmVariant="danger"
        disabled={reject.isPending}
        onClose={() => setConfirmReject(false)}
        onConfirm={async () => {
          await reject.mutateAsync({ approvalId: approval.id, note: note.trim() || undefined })
          setConfirmReject(false)
          navigate(`/cases/${caseId}/approvals`)
        }}
      />
    </div>
  )
}
