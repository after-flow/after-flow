import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useApproval, useApprovals, useApproveProposal, useRejectProposal } from '@/lib/api/queries'
import type { Approval, ApprovalKind, ProposalDiffRow } from '@aftercare/public-contracts'
import { Icon } from '@/kit/Icon'
import { formatDate, formatDateTime } from '@/lib/format'
import { APPROVAL_KIND_WORD } from '@/kit/words'
import {
  Badge,
  Button,
  Checkbox,
  Confirm,
  ErrorState,
  Loading,
  Notice,
  PageHeader,
  inputClass,
  textareaClass,
} from '@/kit/kit'
import { AiQuote, useCaseBase, useLock } from '@/kit/domain'
import { UploadDialog } from './parts/UploadDialog'
import { DocumentView } from './parts/DocumentView'

/**
 * 提案の種類ごとのボタン文言。
 * 「書類の追加依頼」に「合っているので反映」は意味が通らないため、種類ごとにやることを言葉にする。
 */
const ACTIONS: Record<ApprovalKind, { approve: string; edited: string; reject: string }> = {
  TASK_PROPOSAL: { approve: 'この手続きを追加する', edited: '直した内容で追加する', reject: '追加しない' },
  ASSET_PROPOSAL: { approve: '合っているので登録する', edited: '直した内容で登録する', reject: '登録しない' },
  LIABILITY_PROPOSAL: { approve: '合っているので登録する', edited: '直した内容で登録する', reject: '登録しない' },
  CONTRACT_PROPOSAL: { approve: '合っているので登録する', edited: '直した内容で登録する', reject: '登録しない' },
  DOCUMENT_REQUEST: { approve: '用意する書類に加える', edited: '直した内容で加える', reject: 'いまは不要' },
  ESCALATION_PROPOSAL: { approve: '専門家への相談を予定に加える', edited: '直した内容で加える', reject: 'いまは相談しない' },
  EVIDENCE_PROPOSAL: { approve: '記録として残す', edited: '直した内容で残す', reject: '残さない' },
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 読み取った内容の確認（バクラクの「証憑を見ながら項目を確かめる」画面に倣う）。
 *
 *  左：元の書類。項目を選ぶと、その値を読み取った場所を示す
 *  右：反映される項目。直せる項目はその場で直せる
 *  下：「反映して次へ」。確認待ちが複数あっても、一覧に戻らず続けて片づけられる
 *
 * 自信の低い読み取りは、確かな読み取りと同じ見た目で出さない。
 */
export function ApprovalScreen() {
  const { approvalId = '' } = useParams()
  // 別の確認に移ったとき、直しかけの値や確認のチェックを持ち越さない
  return <ApprovalScreenBody key={approvalId} approvalId={approvalId} />
}

function ApprovalScreenBody({ approvalId }: { approvalId: string }) {
  const { caseId, base } = useCaseBase()
  const navigate = useNavigate()
  const { data: approval, isLoading, isError, refetch } = useApproval(approvalId)
  const all = useApprovals(caseId)
  const { locked } = useLock(caseId)
  const approve = useApproveProposal(caseId)
  const reject = useRejectProposal(caseId)

  const [edits, setEdits] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [ack, setAck] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [uploading, setUploading] = useState(false)

  if (isLoading) return <Loading />
  if (isError || !approval)
    return <ErrorState message="内容を読み込めませんでした。" onRetry={() => void refetch()} />

  const pending = (all.data?.items ?? [])
    .filter((a) => a.status === 'PENDING')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const idx = pending.findIndex((a) => a.id === approval.id)
  // 今の次にあるものを優先し、なければ先頭へ戻る（前に残っている確認も取りこぼさない）
  const others = pending.filter((a) => a.id !== approval.id)
  const nextPending = (idx >= 0 ? others[idx] : undefined) ?? others[0]

  const decided = approval.status !== 'PENDING'
  const needsAck = approval.assetDisposal && locked
  const edited = Object.keys(edits).length > 0
  const lowRows = approval.diff.filter((r) => r.confidence === 'LOW')
  const action = ACTIONS[approval.kind]

  const goNext = () => {
    setEdits({})
    setNote('')
    setAck(false)
    setPicked(null)
    navigate(nextPending ? `${base}/approvals/${nextPending.id}` : `${base}/approvals`)
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 lg:px-8">
      <PageHeader
        back={{ to: `${base}/approvals`, label: 'AIからの確認' }}
        title={approval.title}
        badges={
          <>
            <Badge>{APPROVAL_KIND_WORD[approval.kind]}</Badge>
            {approval.status === 'APPROVED' && <Badge tone="green" icon="check">登録しました</Badge>}
            {approval.status === 'REJECTED' && <Badge>登録しませんでした</Badge>}
          </>
        }
        actions={
          !decided && pending.length > 0 && idx >= 0 ? (
            <span className="text-[0.9rem] text-rd-text-2">
              残り <strong className="text-rd-text">{pending.length}</strong> 件中 {idx + 1} 件目
            </span>
          ) : undefined
        }
      />

      {approval.possibleDuplicate && !decided && (
        <Notice tone="warning" title="よく似た書類がすでに追加されています">
          {approval.possibleDuplicate.documentName}（{formatDateTime(approval.possibleDuplicate.takenInAt)}に追加）。
          同じ内容なら「{action.reject}」を選んでください。
        </Notice>
      )}

      {needsAck && !decided && (
        <Notice tone="danger" role="alert" title="相続の方法がまだ決まっていません">
          この内容は財産の処分・現金化に関わる可能性があります。登録する前に専門家へご相談ください。
        </Notice>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <SourcePreview caseId={caseId} approval={approval} picked={picked} />

        <section className="flex flex-col rounded-lg border border-rd-border bg-rd-card">
          <div className="border-b border-rd-border p-4">
            <AiQuote label="AIが書いた説明">{approval.summary}</AiQuote>
          </div>

          <div className="p-4">
            <h2 className="text-[0.94rem] font-bold">登録される内容</h2>
            {lowRows.length > 0 && !decided && (
              <p className="mt-1 text-[0.86rem] text-rd-warning-text">
                「読み取りに自信なし」の項目は、元の書類と見比べて確かめてください。
              </p>
            )}
            <ul className="mt-2 flex flex-col">
              {approval.diff.map((row) => (
                <FieldRow
                  key={row.field}
                  row={row}
                  editable={!decided && Boolean(row.editable)}
                  value={edits[row.field] ?? row.after ?? ''}
                  active={picked === row.field}
                  onFocus={() => setPicked(row.sourceBox ? row.field : null)}
                  onChange={(v) => setEdits((p) => ({ ...p, [row.field]: v }))}
                />
              ))}
            </ul>
          </div>

          {decided ? (
            <div className="border-t border-rd-border bg-rd-bg p-4 text-[0.94rem]">
              {approval.status === 'APPROVED' ? '登録しました' : '登録しませんでした'}
              {approval.decidedAt && `（${formatDateTime(approval.decidedAt)}）`}
              {approval.decisionNote && <p className="mt-1 text-rd-text-2">メモ：{approval.decisionNote}</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-3 border-t border-rd-border bg-rd-bg p-4">
              <details>
                <summary className="cursor-pointer text-[0.9rem] text-rd-text-2">メモを残す</summary>
                <textarea
                  className={`${textareaClass} mt-2 min-h-16`}
                  aria-label="メモ"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </details>

              {needsAck && (
                <Checkbox checked={ack} onChange={setAck}>
                  相続の方法が決まっていないこと、財産の処分にあたる可能性があることを理解しました
                </Checkbox>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="lg"
                  icon="check"
                  // 文言が長い種類（「合っているので登録する」など）は、狭い画面では2行に折り返す（1行のままだと枠からはみ出す）
                  className="h-auto! min-h-12 flex-1 py-2 whitespace-normal!"
                  disabled={approve.isPending || (needsAck && !ack)}
                  onClick={async () => {
                    await approve.mutateAsync({
                      approvalId: approval.id,
                      edits: edited ? edits : undefined,
                      note: note.trim() || undefined,
                    })
                    goNext()
                  }}
                >
                  {edited ? action.edited : action.approve}
                </Button>
                <Button variant="danger" size="lg" onClick={() => setRejecting(true)}>
                  {action.reject}
                </Button>
              </div>
              {nextPending && (
                <p className="text-[0.86rem] text-rd-text-2">選ぶと、続けて次の確認（残り{pending.length - 1}件）を開きます。</p>
              )}
              {approval.kind === 'DOCUMENT_REQUEST' && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-rd-border bg-rd-card px-3 py-2.5">
                  <span className="text-[0.9rem]">手元にあれば、いま追加することもできます。</span>
                  <Button size="sm" icon="upload" onClick={() => setUploading(true)}>いま追加する</Button>
                </div>
              )}
              <p className="text-[0.82rem] leading-relaxed text-rd-text-3">
                登録されるのはこのアプリの中だけです。役所や銀行に何かが送られることはありません。
              </p>
            </div>
          )}
        </section>
      </div>

      <UploadDialog caseId={caseId} open={uploading} onClose={() => setUploading(false)} />

      <Confirm
        open={rejecting}
        title={`「${action.reject}」でよいですか？`}
        description="この内容は登録されません。あとから自分で追加することもできます。"
        confirmLabel={action.reject}
        danger
        busy={reject.isPending}
        onClose={() => setRejecting(false)}
        onConfirm={async () => {
          await reject.mutateAsync({ approvalId: approval.id, note: note.trim() || undefined })
          setRejecting(false)
          goNext()
        }}
      />
    </div>
  )
}

function FieldRow({
  row,
  editable,
  value,
  active,
  onFocus,
  onChange,
}: {
  row: ProposalDiffRow
  editable: boolean
  value: string
  active: boolean
  onFocus: () => void
  onChange: (v: string) => void
}) {
  const low = row.confidence === 'LOW'
  const changed = row.before != null && row.before !== row.after
  const display = ISO_DATE.test(row.after ?? '') ? formatDate(row.after!) : row.after

  return (
    <li
      // 狭い画面では項目名を上に置き、値（入力欄と札）に幅をすべて回す。横に並べると値の列が 120px ほどになり、札がはみ出していた
      className={`grid grid-cols-1 items-start gap-x-3 gap-y-1 border-b border-rd-border-2 py-2.5 last:border-b-0 sm:grid-cols-[7rem_1fr] ${active ? 'bg-rd-primary-soft/50' : ''}`}
      onMouseEnter={onFocus}
    >
      <div className="text-[0.9rem] text-rd-text-2 sm:pt-2">{row.field}</div>
      <div className="min-w-0">
        {editable ? (
          <input
            type={ISO_DATE.test(row.after ?? '') ? 'date' : 'text'}
            className={`${inputClass} ${low ? 'border-rd-warning bg-rd-warning-soft' : ''}`}
            aria-label={`${row.field}（直せます）`}
            value={value}
            onFocus={onFocus}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <p className="pt-2 text-[0.97rem] font-bold">{display ?? '（空欄になります）'}</p>
        )}
        {/*
          読み取りに自信が無いことは、値のすぐ下に添える。項目名の列（7rem）に置くと札が収まらず、
          はみ出した分が入力欄の下に潜り込んで重なっていた
        */}
        {low && (
          <span className="mt-1.5 block">
            <Badge tone="yellow" icon="warning">読み取りに自信なし</Badge>
          </span>
        )}
        {changed && (
          <p className="mt-1 text-[0.82rem] text-rd-text-3">いま登録されている内容：{row.before}</p>
        )}
      </div>
    </li>
  )
}

/**
 * 元の書類。
 * 原本（PDF・画像）を出し、画像なら読み取った位置に枠を重ねる。
 */
function SourcePreview({
  caseId,
  approval,
  picked,
}: {
  caseId: string
  approval: Approval
  picked: string | null
}) {
  const boxes = approval.diff.flatMap((d) => (d.sourceBox ? [{ field: d.field, box: d.sourceBox }] : []))
  if (!approval.sourceDocumentId) {
    return (
      <section className="flex flex-col items-center gap-2 rounded-lg border border-rd-border bg-rd-card px-4 py-12 text-center">
        <Icon name="info" size={24} className="text-rd-text-3" />
        <p className="text-[0.94rem] font-bold">書類から読み取ったものではありません</p>
        <p className="text-[0.86rem] text-rd-text-2">これまでに登録された情報をもとに、AIが提案した内容です。</p>
      </section>
    )
  }
  return (
    <section className="flex flex-col rounded-lg border border-rd-border bg-rd-card p-3 xl:sticky xl:top-6">
      <div className="flex items-center justify-between gap-3 px-1 pb-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[0.9rem] font-bold text-rd-text-2">
          <Icon name="document" size={15} className="shrink-0" />
          <span className="truncate">{approval.sourceDocumentName ?? '元の書類'}</span>
        </span>
        <Link
          to={`/cases/${caseId}/documents/${approval.sourceDocumentId}`}
          className="shrink-0 text-[0.86rem] font-bold text-rd-primary-text hover:underline"
        >
          書類の詳細
        </Link>
      </div>
      <DocumentView
        caseId={caseId}
        documentId={approval.sourceDocumentId}
        fileName={approval.sourceDocumentName ?? '元の書類'}
        boxes={boxes}
        picked={picked}
        heightClass="h-72 sm:h-96 xl:h-[min(36rem,calc(100vh-12rem))]"
      />
      <p className="mt-2 px-1 text-[0.82rem] text-rd-text-3">
        {boxes.length > 0
          ? '項目を選ぶと、読み取った場所に枠が付きます（画像の書類のみ）。'
          : '読み取った場所の情報はありません。書類と見比べて確かめてください。'}
      </p>
    </section>
  )
}
