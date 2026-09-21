import { Link, useSearchParams } from 'react-router-dom'
import {
  useAcknowledgeInsight,
  useApprovals,
  useDismissInsight,
  useInsights,
  useProposals,
} from '@/lib/api/queries'
import type { Insight } from '@aftercare/public-contracts'
import { Icon } from '@/kit/Icon'
import { formatDateTime } from '@/lib/format'
import { isDisplayableInsight } from '@/lib/insights'
import { INSIGHT_KIND_META } from '@/lib/labels'
import { approvalKindWord } from '@/kit/words'
import { joinApprovals, type ApprovalView } from '@/lib/model/approval'
import { Badge, Button, Empty, ErrorState, Loading, Page, PageHeader, Tabs } from '@/kit/kit'
import { useCaseBase } from '@/kit/domain'

type Tab = 'pending' | 'insights' | 'done'

/**
 * 確認待ち。
 *
 * AIが書類から読み取った内容は、利用者が「合っている」と言うまでケースに反映しない。
 * この画面は、その確認を上から順に片づけるための受信箱にあたる。
 *
 * 「気づき」は反映を伴わない情報なので、読み取りとはタブを分ける。
 * 同じ列に混ぜると、何を承認すればよいのかが曖昧になる。
 */
export function ApprovalsScreen() {
  const { caseId, base } = useCaseBase()
  const approvals = useApprovals(caseId)
  const proposals = useProposals(caseId)
  const insights = useInsights(caseId)
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab | null) ?? 'pending'

  if (approvals.isError || proposals.isError)
    return (
      <ErrorState
        message="AIからの確認を読み込めませんでした。"
        onRetry={() => {
          void approvals.refetch()
          void proposals.refetch()
        }}
      />
    )
  if (!approvals.data || !proposals.data) return <Loading />

  const views = joinApprovals(approvals.data, proposals.data)
  const pending = views
    .filter((v) => v.approval.status === 'PENDING')
    .sort((a, b) => a.approval.createdAt.localeCompare(b.approval.createdAt))
  const decided = views
    .filter((v) => v.approval.status !== 'PENDING')
    .sort((a, b) => (b.approval.decidedAt ?? '').localeCompare(a.approval.decidedAt ?? ''))
  const shownInsights = (insights.data ?? []).filter(
    (i) => i.status !== 'DISMISSED' && isDisplayableInsight(i),
  )
  const newInsights = shownInsights.filter((i) => i.status === 'NEW').length

  return (
    <Page>
      <PageHeader
        title="AIからの確認"
        description="AIが書類から読み取った内容と、AIが気づいたことが届きます。読み取った内容は、書類と見比べて合っていれば登録してください（違うところは直せます）。役所や銀行に何かが送られることはありません。"
      />

      <div className="rounded-lg border border-rd-border bg-rd-card">
        <div className="px-4 pt-1">
          <Tabs
            value={tab}
            onChange={(id) => setParams(id === 'pending' ? {} : { tab: id }, { replace: true })}
            items={[
              { id: 'pending', label: '読み取った内容', count: pending.length },
              { id: 'insights', label: 'AIの気づき', count: newInsights },
              { id: 'done', label: '確認済み' },
            ]}
          />
        </div>

        {/* タブを切り替えたら中身を短くふわっと出し、切り替わったことを伝える */}
        <div key={tab} className="animate-fade-in">
          {tab === 'pending' &&
            (pending.length === 0 ? (
              <Empty title="AIからの確認はありません">書類を追加すると、読み取った内容がここに届きます。</Empty>
            ) : (
              <ApprovalList items={pending} base={base} />
            ))}

          {tab === 'insights' && <InsightList caseId={caseId} base={base} items={shownInsights} />}

          {tab === 'done' &&
            (decided.length === 0 ? (
              <Empty title="まだ確認したものはありません" />
            ) : (
              <ApprovalList items={decided} base={base} />
            ))}
        </div>
      </div>
    </Page>
  )
}

function ApprovalList({ items, base }: { items: ApprovalView[]; base: string }) {
  return (
    <ul>
      {items.map(({ approval, proposal }) => {
        const docBasis = proposal?.basis.find((b) => b.type === 'DOCUMENT')
        return (
          <li key={approval.id} className="border-b border-rd-border-2 last:border-b-0">
            <Link to={`${base}/approvals/${approval.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-rd-bg">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-rd-primary-soft text-rd-primary-text">
                <Icon name={proposal?.kind === 'DOCUMENT_REQUEST' ? 'document' : 'seal'} size={19} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[0.82rem] font-bold text-rd-text-3">
                    {proposal ? approvalKindWord(proposal.kind) : '確認'}
                  </span>
                  {approval.assetDisposal && <Badge tone="red" icon="warning">財産の処分に関わる</Badge>}
                </span>
                <span className="text-[0.97rem] font-bold leading-snug">
                  {proposal?.title ?? '提案の内容を読み込めませんでした'}
                </span>
                <span className="block truncate text-[0.82rem] text-rd-text-2">
                  {docBasis ? `${docBasis.label} から` : 'AIの提案'}・{formatDateTime(approval.createdAt)}
                </span>
              </span>
              {approval.status === 'APPROVED' && <Badge tone="green" icon="check">登録しました</Badge>}
              {approval.status === 'REJECTED' && <Badge>登録しませんでした</Badge>}
              {approval.status === 'PENDING' && (
                <span className="hidden text-[0.9rem] font-bold text-rd-primary-text sm:block">確認する</span>
              )}
              <Icon name="chevron-right" size={16} className="text-rd-text-3" />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * AIの気づき。
 * 根拠の無いものは出さない／専門家確認の注記は消せない／反映の操作は持たせない。
 */
function InsightList({ caseId, base, items }: { caseId: string; base: string; items: Insight[] }) {
  const acknowledge = useAcknowledgeInsight(caseId)
  const dismiss = useDismissInsight(caseId)
  if (items.length === 0) return <Empty icon="star" title="いまAIが気づいたことはありません" />

  return (
    <ul>
      {items.map((ins) => {
        const meta = INSIGHT_KIND_META[ins.kind]
        const isNew = ins.status === 'NEW'
        return (
          <li key={ins.id} className="border-b border-rd-border-2 px-4 py-4 last:border-b-0">
            <div className="flex gap-3">
              <span
                aria-hidden
                className="grid h-9 w-9 shrink-0 place-items-center rounded-md"
                style={{ background: meta.bg, color: meta.fg }}
              >
                <Icon name={meta.icon} size={19} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-[0.9rem] font-bold" style={{ color: meta.fg }}>
                  {meta.label}
                  {isNew && <Badge tone="blue">新着</Badge>}
                  <span className="font-normal text-rd-text-3">{formatDateTime(ins.detectedAt)}</span>
                </p>
                <p className="mt-1 text-[0.97rem] leading-relaxed whitespace-pre-wrap">
                  <span className="mr-1 text-[0.8rem] font-bold text-rd-primary-text">[AI]</span>
                  {ins.body}
                </p>

                <div className="mt-2 rounded-md bg-rd-bg px-3 py-2">
                  <p className="text-[0.82rem] font-bold text-rd-text-2">そう考えた理由</p>
                  <ul className="mt-0.5 flex flex-col gap-0.5 text-[0.9rem]">
                    {ins.evidence.map((e, i) => (
                      <li key={i}>
                        <span className="text-rd-text-2">{e.label}：</span>
                        {e.value}
                        {e.documentId && (
                          <Link to={`${base}/documents/${e.documentId}`} className="ml-1.5 text-rd-primary-text underline">
                            {e.documentName ?? '書類を見る'}
                          </Link>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                {ins.requiresProfessional && (
                  <p className="mt-2 flex gap-1.5 text-[0.86rem] leading-relaxed text-[#6d28d9]">
                    <Icon name="star" size={15} className="mt-0.5 shrink-0" />
                    法律・税務の判断を含みます。ここでは気づいたことをお伝えするだけで、判断はしません。専門家にご確認ください。
                  </p>
                )}

                <div className="mt-2.5 flex flex-wrap gap-2">
                  {ins.relatedTaskId && (
                    <Link
                      to={`${base}/tasks/${ins.relatedTaskId}`}
                      className="inline-flex h-9 items-center rounded-md border border-rd-border px-3 text-[0.9rem] font-bold hover:bg-rd-shade"
                    >
                      {ins.relatedTaskTitle ?? '関係する手続き'}を見る
                    </Link>
                  )}
                  {isNew && (
                    <Button size="sm" onClick={() => void acknowledge.mutateAsync({ id: ins.id })}>
                      読みました
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void dismiss.mutateAsync({ id: ins.id })}>
                    非表示にする
                  </Button>
                </div>
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
