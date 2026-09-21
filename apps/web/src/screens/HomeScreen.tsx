import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApprovals, useCaseOverview, useInsights, useTasks } from '@/lib/api/queries'
import type { FlowStage, Task } from '@aftercare/public-contracts'
import { Icon } from '@/kit/Icon'
import { formatDate, formatDateTime } from '@/lib/format'
import { isDisplayableInsight } from '@/lib/insights'
import { AGENT_RUN_WORD, APPROVAL_KIND_WORD, FLOW_STAGE_WORD } from '@/kit/words'
import { Badge, Button, Empty, ErrorState, LinkButton, Loading, Notice, Page, Panel } from '@/kit/kit'
import { toast } from '@/kit/toast'
import { CompleteTaskDialog } from './parts/CompleteTaskDialog'
import {
  CategoryIcon,
  ConditionalBadge,
  Due,
  LockNotice,
  byDeadlineIn,
  prepDeadline,
  dueWords,
  taskGroup,
  useCaseBase,
  useLock,
} from '@/kit/domain'

/**
 * ホーム。
 *
 * 利用場面：朝、スマホかPCで開く。知りたいのは「今日は何をすればいいか」だけ。
 * そのため、画面の最上部に「まずはこれ」を1件だけ大きく出す。
 * 2件目以降は下に小さく並べ、全体の進みは最後に置く。
 */
export function HomeScreen() {
  const { caseId, base } = useCaseBase()
  const overview = useCaseOverview(caseId)
  const tasks = useTasks(caseId)
  const approvals = useApprovals(caseId)
  const insights = useInsights(caseId)
  const { locked } = useLock(caseId)

  if (overview.isError || tasks.isError)
    return (
      <ErrorState
        message="情報を読み込めませんでした。"
        onRetry={() => {
          void overview.refetch()
          void tasks.refetch()
        }}
      />
    )
  if (!overview.data || !tasks.data) return <Loading />

  const todo = tasks.data.items
    .filter((t) => taskGroup(t.status) === 'todo' && !(locked && t.assetDisposal))
    .sort(byDeadlineIn(tasks.data.items))
  const [first, ...rest] = todo
  // 30日以内に期限が来るものに加えて、相続の方法を決める前の下準備も出す（期限が無いと埋もれてしまうため）
  const soon = rest
    .filter((t) => (t.deadline && t.deadline.daysRemaining <= 30) || prepDeadline(t, tasks.data.items))
    .slice(0, 6)

  const pending = (approvals.data?.items ?? [])
    .filter((a) => a.status === 'PENDING')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const newInsights = (insights.data?.items ?? []).filter(
    (i) => i.status === 'NEW' && isDisplayableInsight(i),
  )
  const reviewCount = pending.length + newInsights.length
  const running = overview.data.recentAgentRuns.filter((r) => r.status === 'RUNNING')

  // 期限を過ぎたものと、これから来るものは分けて伝える
  const overdueCount = todo.filter((t) => t.deadline && t.deadline.daysRemaining < 0).length
  const weekCount = todo.filter(
    (t) => t.deadline && t.deadline.daysRemaining >= 0 && t.deadline.daysRemaining <= 7,
  ).length

  return (
    <Page>
      <header>
        <p className="text-[0.9rem] font-bold text-rd-text-2">{todayLabel()}</p>
        <h1 className="mt-0.5 text-[1.35rem] font-bold leading-snug">
          {overview.data.case.ownerName}さん、
          {overdueCount > 0 && (
            <>
              期限を過ぎたものが<span className="text-rd-danger-text">{overdueCount}件</span>
              {weekCount > 0 ? '、' : 'あります'}
            </>
          )}
          {weekCount > 0 ? (
            <>
              今週中にやることが<span className="text-rd-danger-text">{weekCount}件</span>あります
            </>
          ) : (
            overdueCount === 0 && '今週中に期限が来る手続きはありません'
          )}
        </h1>
        {/* 期限切れがあるときは、枠にせず見出しに1行だけ添える（日数は「まずはこれ」の帯にも出る） */}
        {overdueCount > 0 && (
          <p className="mt-1 text-[0.9rem] text-rd-text-2">
            期限を過ぎても受け付けてもらえる手続きもあります。まずは窓口に事情を伝えて相談してください。
          </p>
        )}
      </header>

      {/*
        「まずはこれ」の上に置くのは、見出しと、財産に手をつけないでという1行だけ。
        それ以外（質問のお願いなど）は急ぎではないので下に回し、いちばん大事なものを最初の画面に収める。
      */}
      <LockNotice caseId={caseId} strip />

      {/* まずはこれ */}
      {first ? <FirstTask task={first} base={base} caseId={caseId} /> : <AllClear />}

      {!overview.data.case.profile?.answeredAt && (
        <Notice
          tone="info"
          title="いくつか質問に答えると、必要な手続きをもれなく洗い出せます"
          action={<LinkButton to={`${base}/setup`} size="sm">質問に答える（1分ほど）</LinkButton>}
        >
          年金を受け取っていたか、家や土地があるかなどで、必要な手続きが変わります。いまは、あてはまる可能性があるものをすべて並べています。
        </Notice>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        {/* つぎにやること */}
        <Panel
          title="そのあとにやること"
          action={
            <Link to={`${base}/tasks`} className="text-[0.9rem] font-bold text-rd-primary-text hover:underline">
              すべて見る（{todo.length}件）
            </Link>
          }
          padded={false}
        >
          {soon.length === 0 ? (
            <Empty title="いま急ぐものはありません" />
          ) : (
            <ul>
              {soon.map((t) => (
                <li key={t.id} className="border-b border-rd-border-2 last:border-b-0">
                  <Link to={`${base}/tasks/${t.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-rd-bg">
                    <CategoryIcon category={t.category} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-[0.97rem] font-bold leading-snug">{t.title}</span>
                        <ConditionalBadge task={t} />
                      </span>
                      {t.submitTo && (
                        <span className="mt-0.5 line-clamp-1 text-[0.82rem] leading-snug text-rd-text-2">{t.submitTo}</span>
                      )}
                    </span>
                    <Due deadline={t.deadline} prep={prepDeadline(t, tasks.data.items)} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="flex flex-col gap-5">
          {/* 確認待ち */}
          <Panel
            title={
              <span className="flex items-center gap-2">
                AIからの確認
                {reviewCount > 0 && <Badge tone="blue">{reviewCount}件</Badge>}
              </span>
            }
            padded={false}
          >
            {reviewCount === 0 ? (
              <Empty title="AIからの確認はありません">書類を追加すると、読み取った内容がここに届きます。</Empty>
            ) : (
              <>
                <ul>
                  {pending.slice(0, 3).map((a) => (
                    <li key={a.id} className="border-b border-rd-border-2">
                      <Link to={`${base}/approvals/${a.id}`} className="block px-4 py-2.5 hover:bg-rd-bg">
                        <span className="block text-[0.8rem] font-bold text-rd-text-3">
                          {APPROVAL_KIND_WORD[a.kind]}
                        </span>
                        <span className="text-[0.94rem] font-bold leading-snug">{a.title}</span>
                      </Link>
                    </li>
                  ))}
                  {newInsights.length > 0 && (
                    <li className="border-b border-rd-border-2">
                      <Link
                        to={`${base}/approvals?tab=insights`}
                        className="flex items-center gap-2 px-4 py-2.5 text-[0.94rem] hover:bg-rd-bg"
                      >
                        <Icon name="star" size={16} className="text-rd-warning-text" />
                        AIが気づいたことが{newInsights.length}件あります
                      </Link>
                    </li>
                  )}
                </ul>
                <div className="p-3">
                  <LinkButton to={`${base}/approvals`} className="w-full">
                    AIからの確認をまとめて見る
                  </LinkButton>
                </div>
              </>
            )}
          </Panel>

          {/* AIが進めていること */}
          <Panel title="AIが進めていること">
            {running.length === 0 ? (
              <p className="text-[0.9rem] text-rd-text-2">いま進めているものはありません。</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {running.map((r) => (
                  <li key={r.id} className="flex gap-2.5">
                    <span className="relative mt-1.5 flex h-2 w-2 shrink-0">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rd-primary opacity-60" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-rd-primary" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[0.94rem]">{r.summary}</span>
                      <span className="block text-[0.8rem] text-rd-text-3">
                        {AGENT_RUN_WORD[r.type]}・{formatDateTime(r.startedAt)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-[0.82rem] leading-relaxed text-rd-text-3">
              終わると「AIからの確認」に届きます。待っている間にすることはありません。
            </p>
          </Panel>
        </div>
      </div>

      <FlowOverview stages={overview.data.flowStages} />
    </Page>
  )
}

function todayLabel() {
  const d = new Date()
  const w = '日月火水木金土'[d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日（${w}）`
}

/** 画面でいちばん大きい要素。ここを押せば次の一歩が分かる。 */
function FirstTask({ task, base, caseId }: { task: Task; base: string; caseId: string }) {
  // 死亡届のように、葬儀社や家族がもう済ませていることも多い。詳細を開かずに片づけられるようにする
  const [completing, setCompleting] = useState(false)
  const d = task.deadline
  const hot = d != null && d.daysRemaining <= 3
  // 未取得の必要書類と、案内にある持ち物（印鑑など）の両方を出す。重複は除く
  const docs = task.requiredDocuments ?? []
  const bring = [
    ...docs.filter((r) => !r.collected).map((r) => r.label),
    ...(task.guidance?.bring ?? []).filter((b) => !docs.some((r) => r.label === b)),
  ]

  return (
    <section
      data-tour="first-task"
      aria-label="まずはこれ"
      className={`overflow-hidden rounded-lg border bg-rd-card ${hot ? 'border-rd-danger-line' : 'border-rd-border'}`}
    >
      {/*
        期限は帯の中に1回だけ出す。以前は帯の日付と右側の大きな「今日まで」で同じ情報を2回出しており、
        大きな文字がボタンのすぐ上に浮いて、どちらにも属さない見え方になっていた。
      */}
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 ${hot ? 'bg-rd-danger-soft text-rd-danger-text' : 'bg-rd-primary-soft text-rd-primary-text'}`}>
        <span className="flex items-center gap-1.5 text-[0.9rem] font-bold">
          <Icon name={hot ? 'warning' : 'star'} size={16} />
          まずはこれ
        </span>
        {d && (
          <span className="ml-auto flex flex-wrap items-baseline gap-x-2">
            <strong className="text-[1.2rem] leading-tight">{dueWords(d)}</strong>
            <span className="text-[0.86rem]">
              {formatDate(d.dueDate, { weekday: true })}まで{d.critical && '・法律で定められた期限'}
            </span>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-4 p-5 xl:flex-row xl:items-center">
        <div className="flex min-w-0 flex-1 gap-4">
          <CategoryIcon category={task.category} size={48} />
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 text-[1.15rem] font-bold leading-snug">
              {task.title}
              <ConditionalBadge task={task} />
            </h2>
            {task.submitTo && (
              <p className="mt-1 flex items-center gap-1 text-[0.94rem] text-rd-text-2">
                <Icon name="pin" size={15} />
                {task.submitTo}
              </p>
            )}
            {bring.length > 0 && (
              <p className="mt-1 flex items-start gap-1 text-[0.94rem] text-rd-text-2">
                <Icon name="bag" size={15} className="mt-0.5" />
                <span>持ち物：{bring.slice(0, 3).join('、')}{bring.length > 3 && ` ほか${bring.length - 3}点`}</span>
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {task.stage === 'decision' ? (
            // 相続の方法は「家族・相続人」で人ごとに記録する。ここで完了にしても財産への制限は外れないため、記録の画面へ案内する
            <LinkButton to={`${base}/family`} size="lg">
              方法を記録する
            </LinkButton>
          ) : (
            <Button size="lg" onClick={() => setCompleting(true)}>
              もう済んでいる
            </Button>
          )}
          <LinkButton to={`${base}/tasks/${task.id}`} variant="primary" size="lg">
            やり方を見る
            <Icon name="chevron-right" size={17} />
          </LinkButton>
        </div>
      </div>
      <CompleteTaskDialog
        caseId={caseId}
        task={task}
        open={completing}
        onClose={() => setCompleting(false)}
        onDone={() => toast(`「${task.title}」を完了にしました`)}
      />
    </section>
  )
}

function AllClear() {
  return (
    <section data-tour="first-task" className="flex items-center gap-4 rounded-lg border border-rd-border bg-rd-card p-5">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-rd-success-soft text-rd-success-text">
        <Icon name="check" size={26} />
      </span>
      <div>
        <p className="text-[1.05rem] font-bold">いま、あなたがやることはありません</p>
        <p className="text-[0.94rem] text-rd-text-2">新しい書類が見つかったら「書類を追加」から追加してください。</p>
      </div>
    </section>
  )
}

/**
 * 全体の流れ。細部は出さず「いまどのあたりか」だけ分かればよい。
 *
 * 色だけでは初めて見た人に意味が伝わらないので、各段階に「済み／進めている／これから」を
 * 記号と言葉で添える。色は補助にとどめる。
 */
const STAGE_STATE = {
  COMPLETED: { word: '済み', icon: 'check', bar: 'bg-rd-success', fg: 'text-rd-success-text' },
  IN_PROGRESS: { word: '進行中', icon: 'progress', bar: 'bg-rd-primary', fg: 'text-rd-primary-text' },
  NOT_STARTED: { word: 'これから', icon: 'circle', bar: 'bg-rd-border', fg: 'text-rd-text-3' },
} as const

function FlowOverview({ stages }: { stages: FlowStage[] }) {
  const done = stages.filter((s) => s.state === 'COMPLETED').length
  return (
    <Panel
      title="全体の流れ"
      action={<span className="text-[0.86rem] text-rd-text-2">10段階のうち {done} 段階が済み</span>}
    >
      <p className="mb-3 text-[0.86rem] text-rd-text-2">
        相続の手続きは、おおむね左から右の順に進みます。
      </p>
      {/*
        段階名の長さが違っても状態の行がそろうよう、各段階を「線／名前（2行分の高さ）／状態」の
        3行に固定する。状態の言葉は折り返さない長さにそろえる。
      */}
      <ol className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-5 xl:grid-cols-10 xl:gap-x-3">
        {stages.map((s, i) => {
          const st = STAGE_STATE[s.state]
          const current = s.state === 'IN_PROGRESS'
          return (
            <li
              key={s.id}
              className="grid min-w-0 grid-rows-[auto_2.9em_auto] gap-1.5"
              title={current && s.totalTasks > 0 ? `${s.label}（${s.totalTasks}件中${s.completedTasks}件が済み）` : s.label}
            >
              <span aria-hidden className={`h-1.5 rounded-full ${st.bar}`} />
              <span
                className={`line-clamp-2 text-[0.86rem] leading-[1.45] ${current ? 'font-bold text-rd-text' : 'text-rd-text-2'}`}
              >
                {i + 1}. {FLOW_STAGE_WORD[s.id] ?? s.label.replace(/（.*?）/, '')}
              </span>
              <span className={`flex items-center gap-1 text-[0.8rem] font-bold whitespace-nowrap ${st.fg}`}>
                <Icon name={st.icon} size={13} strokeWidth={2.4} />
                {st.word}
              </span>
            </li>
          )
        })}
      </ol>
    </Panel>
  )
}
