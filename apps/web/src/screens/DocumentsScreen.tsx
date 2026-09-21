import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useArchiveDocument, useDocument, useDocuments, useRequestDocumentAnalysis } from '@/lib/api/queries'
import { ApiError } from '@/lib/api/client'
import { documentDisplayStatus, isDocumentInProgress } from '@/lib/model/document'
import { Icon } from '@/kit/Icon'
import { formatDateTime, formatFileSize } from '@/lib/format'
import { DOCUMENT_KIND_ICON, DOCUMENT_KIND_LABEL } from '@/lib/labels'
import { approvalKindWord } from '@/kit/words'
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
import { toast } from '@/kit/toast'
import { UploadDialog } from './parts/UploadDialog'
import { DocumentView } from './parts/DocumentView'

/**
 * API が新しい種類を返しても画面が落ちないよう、知らない値は「その他」として出す。
 */
const kindIcon = (k: string) => DOCUMENT_KIND_ICON[k as keyof typeof DOCUMENT_KIND_ICON] ?? DOCUMENT_KIND_ICON.OTHER
const kindLabel = (k: string) => DOCUMENT_KIND_LABEL[k as keyof typeof DOCUMENT_KIND_LABEL] ?? DOCUMENT_KIND_LABEL.OTHER

function noticeTone(tone: Tone): 'info' | 'warning' | 'danger' | 'success' {
  if (tone === 'red') return 'danger'
  if (tone === 'yellow') return 'warning'
  if (tone === 'green') return 'success'
  return 'info'
}

/** 追加した書類の一覧。書類は追加して任せるものであり、ここで何かを処理する必要はない。 */
export function DocumentsScreen() {
  const { caseId, base } = useCaseBase()
  const docs = useDocuments(caseId, {
    // 保存中・検査中・読み取り中のものがあれば、終わるまで追いかける
    refetchInterval: (q) => (q.state.data?.items.some(isDocumentInProgress) ? 3_000 : false),
  })
  const [upload, setUpload] = useState(false)

  if (docs.isError) return <ErrorState message="書類を読み込めませんでした。" onRetry={() => void docs.refetch()} />
  if (!docs.data) return <Loading />

  const items = [...docs.data.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

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
                const s = documentDisplayStatus(d)
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
                    <td className="hidden px-4 py-2.5 text-rd-text-2 md:table-cell">{kindLabel(d.kind)}</td>
                    <td className="px-3 py-2.5 sm:px-4">
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </td>
                    <td className="hidden px-4 py-2.5 text-[0.9rem] text-rd-text-2 sm:table-cell">{formatDateTime(d.createdAt)}</td>
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
  const { data: doc, isLoading, isError, refetch } = useDocument(caseId, documentId)
  const archive = useArchiveDocument(caseId)
  const requestAnalysis = useRequestDocumentAnalysis(caseId)
  const [archiving, setArchiving] = useState(false)

  if (isLoading) return <Loading />
  if (isError || !doc) return <ErrorState message="書類を読み込めませんでした。" onRetry={() => void refetch()} />

  const status = documentDisplayStatus(doc)
  const requestable = doc.analysis.canRequest && (doc.analysis.state === 'NOT_REQUESTED' || doc.analysis.state === 'FAILED')

  const handleRequestAnalysis = async () => {
    try {
      await requestAnalysis.mutateAsync(doc.id)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'FEATURE_NOT_CONNECTED') {
        toast('この環境ではまだ使えません。', 'error')
      } else {
        toast('読み取りを依頼できませんでした。もう一度お試しください。', 'error')
      }
    }
  }

  return (
    <Page narrow>
      <PageHeader
        back={{ to: `${base}/documents`, label: '書類' }}
        title={doc.fileName}
        badges={<Badge tone={status.tone}>{status.label}</Badge>}
        actions={
          doc.approvalRefs.length > 0 ? (
            <LinkButton to={`${base}/approvals`} variant="primary">
              AIからの確認を見る（{doc.approvalRefs.length}件）
            </LinkButton>
          ) : undefined
        }
      />

      {status.hint && <Notice tone={noticeTone(status.tone)}>{status.hint}</Notice>}

      <Panel title="元の書類">
        <DocumentView caseId={caseId} documentId={doc.id} fileName={doc.fileName} />
      </Panel>

      <Panel
        title="読み取った内容"
        action={
          requestable && (
            <Button size="sm" variant="primary" disabled={requestAnalysis.isPending} onClick={() => void handleRequestAnalysis()}>
              {doc.analysis.state === 'FAILED' ? 'もう一度読み取りを依頼する' : '読み取りを依頼する'}
            </Button>
          )
        }
      >
        {doc.analysis.state === 'QUEUED' || doc.analysis.state === 'RUNNING' ? (
          <p className="text-[0.94rem] text-rd-text-2">読み取っています。しばらくお待ちください。</p>
        ) : doc.extractionCandidates.length === 0 ? (
          <p className="text-[0.94rem] text-rd-text-2">読み取れた内容はありませんでした。</p>
        ) : (
          <dl className="grid grid-cols-[7.5rem_1fr] gap-x-4 text-[0.94rem]">
            {doc.extractionCandidates.map((c) => {
              const approval = doc.approvalRefs.find((r) => r.proposalId === c.id && r.proposalVersion === c.proposalVersion)
              return (
                <div key={c.id} className="contents">
                  <dt className="border-b border-rd-border-2 py-2.5 text-rd-text-2">{approvalKindWord(c.kind)}</dt>
                  <dd className="m-0 min-w-0 border-b border-rd-border-2 py-2.5 break-words">
                    <span className="flex flex-wrap items-center gap-x-3">
                      {c.title}
                      {approval && (
                        <Link to={`${base}/approvals/${approval.id}`} className="text-[0.86rem] font-bold text-rd-primary-text underline">
                          確認する
                        </Link>
                      )}
                    </span>
                  </dd>
                </div>
              )
            })}
          </dl>
        )}
        <p className="mt-3 text-[0.82rem] leading-relaxed text-rd-text-3">
          AIがすべての財産・契約を見つけられるとは限りません。ほかに心当たりがあれば「財産・契約」から追加してください。
        </p>
      </Panel>

      <Panel title="書類の情報">
        <DList
          rows={[
            {
              label: '種類',
              value: (
                <>
                  {kindLabel(doc.kind)}
                  {doc.kindSource === 'AI' && <span className="ml-2 text-[0.82rem] text-rd-text-3">（AIが判定）</span>}
                </>
              ),
            },
            { label: '追加した日時', value: formatDateTime(doc.createdAt) },
            { label: 'ファイルの大きさ', value: formatFileSize(doc.sizeBytes) },
          ]}
        />
      </Panel>

      <div>
        <Button variant="ghost" className="text-rd-danger-text" onClick={() => setArchiving(true)}>
          この書類を一覧から外す
        </Button>
      </div>

      <Confirm
        open={archiving}
        title="この書類を一覧から外しますか？"
        description="書類は一覧に出なくなりますが、記録は残ります。すでに登録した財産・契約・手続きの情報は残ります。"
        confirmLabel="一覧から外す"
        danger
        busy={archive.isPending}
        onClose={() => setArchiving(false)}
        onConfirm={async () => {
          await archive.mutateAsync({ documentId: doc.id, expectedVersion: doc.version })
          navigate(`${base}/documents`)
        }}
      />
    </Page>
  )
}
