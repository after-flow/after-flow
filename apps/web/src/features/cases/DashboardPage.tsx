import { Link, useParams } from 'react-router-dom'
import { useCaseOverview, useInsights, useTasks } from '@/lib/api/queries'
import { Button, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/Primitives'
import { Banner } from '@/components/ui/Banner'
import { RenunciationLockBanner } from '@/components/domain/RenunciationLock'
import { NextActionCard } from '@/components/domain/NextActionCard'
import { TaskRow } from '@/components/domain/TaskRow'
import { InsightCard } from '@/components/domain/InsightCard'
import { isDisplayableInsight } from '@/lib/insights'
import { AGENT_RUN_TYPE_LABEL } from '@/lib/labels'
import { formatDate, formatDateTime } from '@/lib/format'
import { Icon } from '@/components/ui/Icon'
import type { FlowStage } from '@aftercare/public-contracts'

export function DashboardPage() {
  const { caseId = '' } = useParams()
  const { data } = useCaseOverview(caseId)
  const tasks = useTasks(caseId)
  const insights = useInsights(caseId)

  if (!data) return <Spinner />

  const { case: kase, upcomingDeadlines, pendingApprovalCount, flowStages, recentAgentRuns } = data
  const urgentAll = upcomingDeadlines.filter(
    (d) => d.severity === 'OVERDUE' || d.severity === 'URGENT',
  )
  const totalTasks = flowStages.reduce((n, s) => n + s.totalTasks, 0)
  const doneTasks = flowStages.reduce((n, s) => n + s.completedTasks, 0)
  // 「次にやること」は、期限がいちばん近い未完了の手続き
  const openTasks = (tasks.data?.items ?? [])
    .filter((t) => t.status !== 'COMPLETED' && !(!data.inheritanceDecision.decided && t.assetDisposal))
    .sort((a, b) => (a.deadline?.dueDate ?? '9999').localeCompare(b.deadline?.dueDate ?? '9999'))
  const nextTask = openTasks[0]
  const soonTasks = openTasks.filter((t) => (t.deadline?.daysRemaining ?? 999) <= 7).slice(0, 5)
  // 「次にやること」で大きく出しているものは、上の通知で繰り返さない
  const urgent = urgentAll.filter((d) => d.taskId !== nextTask?.id)
  const openInsights = (insights.data?.items ?? []).filter(
    (i) => i.status === 'NEW' && isDisplayableInsight(i),
  )

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="ケースの状況"
        title={`${kase.deceasedName} 様`}
        description={`ご逝去日 ${formatDate(kase.dateOfDeath)} ・ ${kase.relationshipToDeceased}として手続きを進めています`}
      />

      {/* 期限当日・超過はダッシュボード最上部に固定表示（仕様書セクション9） */}
      {urgent.length > 0 && (
        <Banner tone="critical" title="期限が来ている手続きがあります" role="alert">
          <ul className="mt-1 flex flex-col gap-1">
            {urgent.map((d) => (
              <li key={d.id}>
                <Link className="font-bold underline" to={`/cases/${caseId}/tasks/${d.taskId}`}>
                  {d.taskTitle ?? d.label}
                </Link>
                {' — '}
                <span className="font-bold">{formatDate(d.dueDate)}まで</span>
              </li>
            ))}
          </ul>
        </Banner>
      )}

      {/*
        放棄前ロック警告は常時表示だが、最優先は「いま何をすべきか」。
        期限超過の通知（仕様書セクション9で最上部固定）の次に行動の導線を置き、
        法的な注意はその直後に置く。
      */}
      {totalTasks === 0 && !data.inheritanceDecision.decided && (
        <RenunciationLockBanner caseId={caseId} decision={data.inheritanceDecision} />
      )}

      {totalTasks === 0 ? (
        <Card>
          <EmptyState
            title="まだ手続きが登録されていません"
            description="まず死亡診断書などの書類をアップロードしてください。内容をもとに、必要な手続きと期限の候補を整理します。"
            action={
              <Link className="btn btn-primary" to={`/cases/${caseId}/documents`}>
                書類をアップロードする
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          {/* いちばん知りたいこと（次に何をするか）を最初に、大きく置く */}
          <NextActionCard caseId={caseId} task={nextTask} />

          {!data.inheritanceDecision.decided && (
            <RenunciationLockBanner caseId={caseId} decision={data.inheritanceDecision} />
          )}

          <SummaryStrip
            caseId={caseId}
            doneTasks={doneTasks}
            totalTasks={totalTasks}
            pendingApprovalCount={pendingApprovalCount}
          />

          <div className="grid gap-5 lg:grid-cols-[1.05fr_1fr]">
            <div className="flex min-w-0 flex-col gap-5">
              <Card
                title="期限が近い手続き"
                action={
                  <Link
                    className="text-sm font-bold text-[var(--color-brand)] underline"
                    to={`/cases/${caseId}/tasks`}
                  >
                    すべて見る
                  </Link>
                }
                bodyClassName="p-3 sm:p-4"
              >
                {soonTasks.length === 0 ? (
                  <p className="p-1 text-[var(--color-ink-muted)]">
                    直近7日以内に期限を迎える手続きはありません。
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {soonTasks.map((t) => (
                      <li key={t.id}>
                        <TaskRow caseId={caseId} task={t} />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {/*
                AIが自分で気づいたこと。
                承認や操作を伴わない情報として、実行ログより上に置く。
              */}
              {openInsights.length > 0 && (
                <Card
                  title="AIが気づいたこと"
                  action={
                    <Link
                      className="text-sm font-bold text-[var(--color-brand)] underline"
                      to={`/cases/${caseId}/insights`}
                    >
                      すべて見る
                    </Link>
                  }
                  bodyClassName="flex flex-col gap-3 p-3 sm:p-4"
                >
                  {openInsights.slice(0, 2).map((i) => (
                    <InsightCard key={i.id} caseId={caseId} insight={i} compact />
                  ))}
                  {openInsights.length > 2 && (
                    <Link
                      className="btn btn-secondary btn-sm self-start"
                      to={`/cases/${caseId}/insights`}
                    >
                      ほか {openInsights.length - 2} 件の気づきを見る
                    </Link>
                  )}
                </Card>
              )}

              <Card title="直近のAIの動き">
                {recentAgentRuns.length === 0 ? (
                  <p className="text-[var(--color-ink-muted)]">まだ実行履歴はありません。</p>
                ) : (
                  <ul className="flex flex-col gap-3.5">
                    {recentAgentRuns.map((run) => (
                      <li key={run.id} className="flex gap-3">
                        <span
                          aria-hidden
                          className={`mt-2 h-2 w-2 shrink-0 rounded-full ${
                            run.status === 'RUNNING'
                              ? 'bg-[var(--color-state-blue)]'
                              : 'bg-[var(--color-line-strong)]'
                          }`}
                        />
                        <div className="min-w-0">
                          <p className="text-sm text-[var(--color-ink-faint)]">
                            {run.status === 'RUNNING' ? '実行中' : AGENT_RUN_TYPE_LABEL[run.type]}
                            {' ・ '}
                            {formatDateTime(run.finishedAt ?? run.startedAt)}
                          </p>
                          <p>{run.summary}</p>
                          {(run.producedApprovalIds?.length ?? 0) > 0 && (
                            <Link
                              className="text-sm font-bold text-[var(--color-brand)] underline"
                              to={`/cases/${caseId}/approvals`}
                            >
                              提案を確認する
                            </Link>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <div className="flex min-w-0 flex-col gap-5">
              <Card title="全体の進み具合">
                <ol className="flex flex-col">
                  {flowStages.map((stage, i) => (
                    <StageRow key={stage.id} stage={stage} index={i + 1} />
                  ))}
                </ol>
              </Card>
            </div>
          </div>
        </>
      )}

      <Card title="ご自身で行っていただくこと">
        <p className="text-[var(--color-ink-muted)]">
          本サービスは、必要な手続きの整理・期限の管理・持ち物のご案内までを行います。役所や金融機関への提出・送信・解約・お支払いは、ご本人（ご遺族）に行っていただきます。
        </p>
        <div className="mt-3">
          <Link to={`/cases/${caseId}/chat`}>
            <Button>わからないことをAIに相談する</Button>
          </Link>
        </div>
      </Card>
    </div>
  )
}

/** 進捗・確認待ちを横一列で俯瞰させる */
function SummaryStrip({
  caseId,
  doneTasks,
  totalTasks,
  pendingApprovalCount,
}: {
  caseId: string
  doneTasks: number
  totalTasks: number
  pendingApprovalCount: number
}) {
  const remaining = totalTasks - doneTasks
  const pct = totalTasks === 0 ? 0 : Math.round((doneTasks / totalTasks) * 100)

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="card-quiet p-4">
        <p className="eyebrow">残っている手続き</p>
        <p className="mt-0.5 text-2xl font-bold">
          {remaining}
          <span className="ml-1 text-base font-normal text-[var(--color-ink-faint)]">件</span>
        </p>
      </div>

      <div className="card-quiet p-4">
        <p className="eyebrow">完了した手続き</p>
        <p className="mt-0.5 text-2xl font-bold">
          {doneTasks}
          <span className="ml-1 text-base font-normal text-[var(--color-ink-faint)]">
            / {totalTasks} 件
          </span>
        </p>
        <div className="meter mt-2">
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>

      {pendingApprovalCount > 0 ? (
        <Link to={`/cases/${caseId}/approvals`} className="row-card p-4">
          <p className="eyebrow">確認をお待ちしています</p>
          <p className="mt-0.5 text-2xl font-bold text-[var(--color-state-yellow)]">
            {pendingApprovalCount}
            <span className="ml-1 text-base font-normal text-[var(--color-ink-faint)]">件の提案</span>
          </p>
          <p className="mt-1 text-sm text-[var(--color-brand)] underline">内容を確認する</p>
        </Link>
      ) : (
        <div className="card-quiet p-4">
          <p className="eyebrow">確認をお待ちしています</p>
          <p className="mt-0.5 text-2xl font-bold text-[var(--color-ink-faint)]">0</p>
          <p className="mt-1 text-sm text-[var(--color-ink-faint)]">未確認の提案はありません</p>
        </div>
      )}
    </div>
  )
}

function StageRow({ stage, index }: { stage: FlowStage; index: number }) {
  const label = {
    COMPLETED: '完了',
    IN_PROGRESS: '進行中',
    NOT_STARTED: '未着手',
  }[stage.state]

  const pct =
    stage.totalTasks === 0 ? 0 : Math.round((stage.completedTasks / stage.totalTasks) * 100)

  return (
    <li className="timeline-item" data-state={stage.state}>
      <span className="timeline-marker" aria-hidden>
        {stage.state === 'COMPLETED' ? <Icon name="check" size={15} strokeWidth={2.4} /> : index}
      </span>

      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={`font-bold ${stage.state === 'NOT_STARTED' ? 'text-[var(--color-ink-faint)]' : ''}`}>
          {stage.label}
        </span>
        <span className="text-sm text-[var(--color-ink-faint)]">
          {stage.totalTasks === 0 ? '該当なし' : `${stage.completedTasks}/${stage.totalTasks} 件`}
        </span>
        <span className="visually-hidden">{label}</span>
      </div>

      {stage.totalTasks > 0 && stage.state !== 'NOT_STARTED' && (
        <div className="meter mt-1.5 max-w-56">
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
    </li>
  )
}
