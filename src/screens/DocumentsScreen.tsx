import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useDeleteDocument, useDocument, useDocuments } from '@/api/queries'
import type { DocumentAnalysisStatus } from '@/api/types'
import { Icon } from '@/kit/Icon'
import { formatDate, formatDateTime, formatFileSize } from '@/lib/format'
import { DOCUMENT_KIND_ICON, DOCUMENT_KIND_LABEL } from '@/lib/labels'
import {
  Badge,
  Button,
  Confirm,
  DList,
  Empty,
  ErrorState,
  LinkButton,
  Loading,
  Notice,
  Page,
  PageHeader,
  Panel,
  type Tone,
} from '@/kit/kit'
import { useCaseBase } from '@/kit/domain'
import { UploadDialog } from './parts/UploadDialog'

const STATUS: Record<DocumentAnalysisStatus, { label: string; tone: Tone }> = {
  NOT_ANALYZED: { label: '読み取り前', tone: 'gray' },
  ANALYZING: { label: '読み取り中', tone: 'blue' },
  ANALYZED: { label: '読み取り済み', tone: 'green' },
  NEEDS_REVIEW: { label: '内容の確認が必要', tone: 'yellow' },
}

/**
 * API が新しい種類や状態を返しても画面が落ちないよう、知らない値は「その他」「読み取り前」として出す。
 */
const kindIcon = (k: string) => DOCUMENT_KIND_ICON[k as keyof typeof DOCUMENT_KIND_ICON] ?? DOCUMENT_KIND_ICON.OTHER
const kindLabel = (k: string) => DOCUMENT_KIND_LABEL[k as keyof typeof DOCUMENT_KIND_LABEL] ?? DOCUMENT_KIND_LABEL.OTHER
const statusOf = (st: string) => STATUS[st as DocumentAnalysisStatus] ?? STATUS.NOT_ANALYZED
/** 読み取った値が日付（YYYY-MM-DD）なら、和暦に慣れた方にも読みやすい形にする */
const showValue = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDate(v) : v)

/** 追加した書類の一覧。書類は追加して任せるものであり、ここで何かを処理する必要はない。 */
export function DocumentsScreen() {
  const { caseId, base } = useCaseBase()
  const docs = useDocuments(caseId, {
    // 読み取り中のものがあれば、終わるまで追いかける
    refetchInterval: (q) => (q.state.data?.items.some((d) => d.analysisStatus === 'ANALYZING') ? 3_000 : false),
  })
  const [upload, setUpload] = useState(false)

  if (docs.isError) return <ErrorState message="書類を読み込めませんでした。" onRetry={() => void docs.refetch()} />
  if (!docs.data) return <Loading />

  const items = [...docs.data.items].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))

  return (
    <Page>
      <PageHeader
        title="書類"
        description="追加した書類の一覧です。読み取った内容は「AIからの確認」に届きます。"
        actions={
          <Button variant="primary" icon="upload" onClick={() => setUpload(true)}>
            書類を追加
          </Button>
        }
      />

      <div className="overflow-hidden rounded-lg border border-rd-border bg-rd-card">
        {items.length === 0 ? (
          <Empty icon="folder" title="まだ書類を追加していません">
            死亡診断書・通帳・保険証券などを追加すると、AIが手続きと期限を洗い出します。
          </Empty>
        ) : (
          // 列の幅を固定する（table-fixed）。長いファイル名に表が押し広げられて、狭い画面で「状態」が切れるのを防ぐ
          <table className="w-full table-fixed text-left text-[0.94rem]">
            <thead className="border-b border-rd-border bg-rd-bg text-[0.82rem] text-rd-text-2">
              <tr>
                <th className="px-4 py-2 font-bold">書類</th>
                <th className="hidden w-36 px-4 py-2 font-bold md:table-cell">種類</th>
                <th className="w-[9.5rem] px-3 py-2 font-bold sm:w-44 sm:px-4">状態</th>
                <th className="hidden w-48 px-4 py-2 font-bold sm:table-cell">追加した日時</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => {
                const k = kindIcon(d.kind)
                const s = statusOf(d.analysisStatus)
                return (
                  <tr key={d.id} className="border-b border-rd-border-2 last:border-b-0 hover:bg-rd-bg">
                    <td className="px-4 py-2.5">
                      <Link to={`${base}/documents/${d.id}`} className="flex items-center gap-2.5">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md" style={{ background: k.bg, color: k.fg }}>
                          <Icon name={k.icon} size={17} />
                        </span>
                        <span className="min-w-0 truncate font-bold hover:underline">{d.fileName}</span>
                      </Link>
                    </td>
                    <td className="hidden px-4 py-2.5 text-rd-text-2 md:table-cell">
                      {d.analysisStatus === 'ANALYZING' ? '読み取り中' : kindLabel(d.kind)}
                    </td>
                    <td className="px-3 py-2.5 sm:px-4">
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </td>
                    <td className="hidden px-4 py-2.5 text-[0.9rem] text-rd-text-2 sm:table-cell">{formatDateTime(d.uploadedAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <UploadDialog caseId={caseId} open={upload} onClose={() => setUpload(false)} />
    </Page>
  )
}

export function DocumentScreen() {
  const { documentId = '' } = useParams()
  const { caseId, base } = useCaseBase()
  const navigate = useNavigate()
  const { data: doc, isLoading, isError, refetch } = useDocument(documentId)
  const del = useDeleteDocument(caseId)
  const [deleting, setDeleting] = useState(false)

  if (isLoading) return <Loading />
  if (isError || !doc) return <ErrorState message="書類を読み込めませんでした。" onRetry={() => void refetch()} />

  const s = statusOf(doc.analysisStatus)
  const linked = (doc.extractions ?? []).filter((e) => e.approvalId)

  return (
    <Page narrow>
      <PageHeader
        back={{ to: `${base}/documents`, label: '書類' }}
        title={doc.fileName}
        badges={<Badge tone={s.tone}>{s.label}</Badge>}
        actions={
          linked.length > 0 ? (
            <LinkButton to={`${base}/approvals`} variant="primary">
              AIからの確認を見る（{linked.length}件）
            </LinkButton>
          ) : undefined
        }
      />

      {doc.myNumberScan === 'MASKED' && (
        <Notice tone="warning">マイナンバーらしき記載があったため、その部分を隠して保存しています。</Notice>
      )}

      {doc.analysisStatus === 'NEEDS_REVIEW' && (
        <Notice tone="warning" title="AIがこの書類を読み取れませんでした">
          写真が暗い・ぼやけている・一部が切れている場合は、明るい場所で書類全体が入るように撮り直し、もう一度追加してください。
          読み取れなくても、書類はこのまま保存されています。
        </Notice>
      )}

      <Panel title="読み取った内容">
        {doc.analysisStatus === 'ANALYZING' ? (
          <p className="text-[0.94rem] text-rd-text-2">読み取っています。しばらくお待ちください。</p>
        ) : (doc.extractions?.length ?? 0) === 0 ? (
          <p className="text-[0.94rem] text-rd-text-2">読み取れた内容はありませんでした。</p>
        ) : (
          <DList
            rows={doc.extractions!.map((e) => ({
              label: e.label,
              value: (
                <span className="flex flex-wrap items-center gap-x-3">
                  {showValue(e.value)}
                  {e.approvalId && (
                    <Link to={`${base}/approvals/${e.approvalId}`} className="text-[0.86rem] font-bold text-rd-primary-text underline">
                      確認する
                    </Link>
                  )}
                </span>
              ),
            }))}
          />
        )}
        <p className="mt-3 text-[0.82rem] leading-relaxed text-rd-text-3">
          AIがすべての財産・契約を見つけられるとは限りません。ほかに心当たりがあれば「財産・契約」から追加してください。
        </p>
      </Panel>

      <Panel title="書類の情報">
        <DList
          rows={[
            { label: '種類', value: doc.analysisStatus === 'ANALYZING' ? '読み取り中' : <>{kindLabel(doc.kind)}{doc.kindSource === 'AI' && <span className="ml-2 text-[0.82rem] text-rd-text-3">（AIが判定）</span>}</> },
            { label: '追加した日時', value: formatDateTime(doc.uploadedAt) },
            { label: 'ファイルの大きさ', value: formatFileSize(doc.sizeBytes) },
          ]}
        />
      </Panel>

      <div>
        <Button variant="ghost" className="text-rd-danger-text" onClick={() => setDeleting(true)}>
          この書類を削除する
        </Button>
      </div>

      <Confirm
        open={deleting}
        title="この書類を削除しますか？"
        description="書類と読み取り結果が消えます。すでに登録した財産・契約・手続きの情報は残ります。"
        confirmLabel="削除する"
        danger
        busy={del.isPending}
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          await del.mutateAsync(doc.id)
          navigate(`${base}/documents`)
        }}
      />
    </Page>
  )
}
