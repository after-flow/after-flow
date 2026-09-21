import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useCreateTask, useInsights, usePersons, useTasks } from '@/lib/api/queries'
import type { FlowStageId, TaskResource } from '@aftercare/public-contracts'
import { Icon } from '@/kit/Icon'
import { DEADLINE_BUCKETS, TASK_CATEGORY_META, deadlineBucket } from '@/lib/labels'
import { FLOW_STAGE_WORD } from '@/kit/words'
import {
  Badge,
  Button,
  Confirm,
  Empty,
  ErrorState,
  LinkButton,
  Field,
  Loading,
  Notice,
  Page,
  PageHeader,
  Tabs,
  inputClass,
  textareaClass,
} from '@/kit/kit'
import {
  CategoryIcon,
  ConditionalBadge,
  Due,
  LockNotice,
  TaskStatusBadge,
  byDeadlineIn,
  prepDeadline,
  taskGroup,
  useCaseBase,
  useLock,
  type TaskGroup,
} from '@/kit/domain'

/**
 * やること（手続きの一覧）。
 *
 * タブは状態の細かい区別ではなく、利用者の関心で3つに分ける。
 *  - やること：自分が動く必要があるもの
 *  - 返事待ち：出し終えて、相手の処理を待っているもの
 *  - 済んだ：終わったもの
 * 「やること」は期限の近さでまとめ、上から順に片づければよい並びにする。
 */
export function TasksScreen() {
  const { caseId, base } = useCaseBase()
  const tasks = useTasks(caseId)
  const insights = useInsights(caseId)
  const persons = usePersons(caseId)
  const { locked, reason } = useLock(caseId)
  const [params, setParams] = useSearchParams()
  const rawTab = params.get('tab')
  // 想定外の値（古いリンク・手入力）は「やること」として扱う
  const tab: TaskGroup = rawTab === 'waiting' || rawTab === 'done' ? rawTab : 'todo'
  const [adding, setAdding] = useState(false)

  if (tasks.isError) return <ErrorState message="手続きを読み込めませんでした。" onRetry={() => void tasks.refetch()} />
  if (!tasks.data) return <Loading />

  const nameOf = (personId: string | null) => (personId ? persons.data?.find((p) => p.id === personId)?.name : undefined)
  const visible = tasks.data.items.filter((t) => !(locked && t.assetDisposal))
  const hiddenCount = tasks.data.items.length - visible.length

  // 家族で手分けしているときは、担当で絞り込めるようにする（誰かが担当を決めたときだけ出す）
  const assignees = [
    ...new Map(visible.flatMap((t) => (t.assigneeId ? [[t.assigneeId, nameOf(t.assigneeId) ?? '']] : []))).entries(),
  ]
  const rawWho = params.get('who')
  const who = rawWho === 'none' || assignees.some(([id]) => id === rawWho) ? rawWho : null
  const shown = who == null ? visible : visible.filter((t) => (who === 'none' ? !t.assigneeId : t.assigneeId === who))

  // 止まっている手続き（AIの気づき）には印を付ける
  const stalled = new Set(
    (insights.data ?? [])
      .filter((i) => i.kind === 'STALLED_TASK' && i.status !== 'DISMISSED' && i.relatedTaskId)
      .map((i) => i.relatedTaskId!),
  )

  const setParam = (key: string, value: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        if (value == null) next.delete(key)
        else next.set(key, value)
        return next
      },
      { replace: true },
    )

  const groups: Record<TaskGroup, TaskResource[]> = { todo: [], waiting: [], done: [] }
  for (const t of shown) groups[taskGroup(t.status)].push(t)
  const order = byDeadlineIn(visible)
  groups.todo.sort(order)
  groups.waiting.sort(order)
  groups.done.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  const list = groups[tab]

  return (
    <Page>
      <PageHeader
        title="やること"
        description="期限の近い順に並んでいます。上から順に進めれば大丈夫です。"
        actions={
          <>
            <LinkButton to={`${base}/setup`} icon="pencil">
              あてはまる手続きを見直す
            </LinkButton>
            <Button icon="plus" onClick={() => setAdding(true)}>
              手続きを追加
            </Button>
          </>
        }
      />

      <LockNotice caseId={caseId} compact />

      <div className="rounded-lg border border-rd-border bg-rd-card">
        <div className="px-4 pt-1">
          <Tabs
            value={tab}
            onChange={(id) => setParam('tab', id === 'todo' ? null : id)}
            items={[
              { id: 'todo', label: 'やること', count: groups.todo.length },
              { id: 'waiting', label: '結果待ち', count: groups.waiting.length },
              { id: 'done', label: '済んだ', count: groups.done.length },
            ]}
          />
        </div>

        {assignees.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-rd-border-2 px-4 py-2">
            <label htmlFor="who" className="text-[0.86rem] font-bold text-rd-text-2">担当</label>
            <select
              id="who"
              className={inputClass.replace('h-11 w-full', 'h-9 w-auto min-w-40')}
              value={who ?? ''}
              onChange={(e) => setParam('who', e.target.value || null)}
            >
              <option value="">全員</option>
              {assignees.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
              <option value="none">未定</option>
            </select>
          </div>
        )}

        {/* タブを切り替えたら中身を短くふわっと出し、切り替わったことを伝える */}
        <div key={tab} className="animate-fade-in">
          {list.length === 0 ? (
            <Empty
              title={
                who != null
                  ? 'この担当の手続きはありません'
                  : tab === 'todo' ? 'やることはありません' : tab === 'waiting' ? '結果待ちの手続きはありません' : 'まだ済んだ手続きはありません'
              }
            >
              {who != null ? '「担当」を「全員」にすると、すべての手続きが表示されます。' : tab === 'waiting' && '役所や金融機関に出し終えた手続きが、ここに並びます。'}
            </Empty>
          ) : tab === 'todo' ? (
            <BucketedList tasks={list} all={visible} base={base} stalled={stalled} nameOf={nameOf} />
          ) : (
            <TaskTable tasks={list} all={visible} base={base} stalled={stalled} nameOf={nameOf} />
          )}
        </div>
      </div>

      {locked && hiddenCount > 0 && (
        <Notice tone="warning">
          預金の解約など、財産を動かす手続きが{hiddenCount}件あります。
          {reason === 'undecided'
            ? '相続の方法が決まるまで、一覧には出していません。'
            : '選んだ相続の方法では自分の判断で進める手続きではないため、一覧には出していません。'}
        </Notice>
      )}

      <AddTaskDialog caseId={caseId} open={adding} onClose={() => setAdding(false)} />
    </Page>
  )
}

/**
 * 期限の近さでまとめる。「相続の方法を決める」の下準備（期限の無い調査）は「早めに始めたいこと」として、
 * 「それ以降」の手前に独立したまとまりで出す（「期限の定めなし」に埋もれさせない）。
 */
const PREP_BUCKET = { id: 'prep', label: '早めに始めたいこと（相続の方法を決める前に）', tone: 'warning' as const }

function BucketedList({
  tasks,
  all,
  base,
  stalled,
  nameOf,
}: {
  tasks: TaskResource[]
  all: TaskResource[]
  base: string
  stalled: Set<string>
  nameOf: (personId: string | null) => string | undefined
}) {
  const bucketOf = (t: TaskResource) => (prepDeadline(t, all) ? 'prep' : deadlineBucket(t.deadline))
  const buckets = DEADLINE_BUCKETS.flatMap((b) => (b.id === 'later' ? [PREP_BUCKET, b] : [b]))
  return (
    <div>
      {buckets.map((b) => {
        const items = tasks.filter((t) => bucketOf(t) === b.id)
        if (items.length === 0) return null
        const tone =
          b.tone === 'critical' ? 'text-rd-danger-text' : b.tone === 'warning' ? 'text-rd-warning-text' : 'text-rd-text-2'
        return (
          <section key={b.id}>
            <h2 className={`flex items-center gap-2 border-b border-rd-border bg-rd-bg px-4 py-1.5 text-[0.86rem] font-bold ${tone}`}>
              {b.tone === 'critical' && <Icon name="warning" size={14} />}
              {b.label}
              <span className="font-normal text-rd-text-3">{items.length}件</span>
            </h2>
            {b.id === 'overdue' && (
              <p className="border-b border-rd-border-2 px-4 py-2 text-[0.86rem] text-rd-text-2">
                期限を過ぎても受け付けてもらえる手続きもあります。まずは窓口に事情を伝えて相談してください。
              </p>
            )}
            {b.id === 'prep' && (
              <p className="border-b border-rd-border-2 px-4 py-2 text-[0.86rem] text-rd-text-2">
                法律上の期限はありませんが、相続の方法を決める前に済ませたい手続きです。戸籍の取り寄せには数週間かかることがあります。
              </p>
            )}
            <TaskTable tasks={items} all={all} base={base} stalled={stalled} nameOf={nameOf} />
          </section>
        )
      })}
    </div>
  )
}

function TaskTable({
  tasks,
  all,
  base,
  stalled,
  nameOf,
}: {
  tasks: TaskResource[]
  all: TaskResource[]
  base: string
  stalled: Set<string>
  nameOf: (personId: string | null) => string | undefined
}) {
  return (
    <ul>
      {tasks.map((t) => {
        const done = t.status === 'COMPLETED'
        // `collected` は BE ユニット2待ち。それまでは documentId の有無で代替する
        const docsLeft = t.requiredDocuments.filter((r) => r.documentId == null).length
        const assigneeName = nameOf(t.assigneeId)
        return (
          <li key={t.id} className="border-b border-rd-border-2 last:border-b-0">
            <Link to={`${base}/tasks/${t.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-rd-bg">
              <CategoryIcon category={t.category} size={34} />
              <span className="min-w-0 flex-1">
                {/* 手続きの名前は省略しない（高齢の方が「…」の先を想像しなくて済むように、折り返して全部見せる） */}
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className={`text-[0.97rem] font-bold leading-snug ${done ? 'text-rd-text-2' : ''}`}>{t.title}</span>
                  <ConditionalBadge task={t} />
                  {!done && stalled.has(t.id) && <Badge tone="yellow" icon="clock">止まっています</Badge>}
                </span>
                <span className="mt-0.5 flex flex-wrap gap-x-3 text-[0.82rem] leading-snug text-rd-text-2">
                  {t.submitTo && <span className="line-clamp-1 break-all sm:break-normal">{t.submitTo}</span>}
                  {!done && docsLeft > 0 && <span className="text-rd-warning-text">必要な書類があと{docsLeft}点</span>}
                  {assigneeName && <span>担当：{assigneeName}</span>}
                </span>
              </span>
              {/* 状態はタブでもおおよそ分かるため、幅が足りない画面では手続きの名前を優先する */}
              <span className="hidden lg:block">
                <TaskStatusBadge status={t.status} />
              </span>
              {/* 日付の行（例：2026年12月15日（火）より前に）が1行に収まる幅。狭い画面では日付を出さない */}
              <span className="w-20 shrink-0 text-right sm:w-48">
                <Due deadline={t.deadline} done={done} prep={prepDeadline(t, all)} />
              </span>
              <Icon name="chevron-right" size={16} className="hidden text-rd-text-3 sm:block" />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

function AddTaskDialog({ caseId, open, onClose }: { caseId: string; open: boolean; onClose: () => void }) {
  const create = useCreateTask(caseId)
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('その他')
  const [stage, setStage] = useState<FlowStageId>('government')
  const [submitTo, setSubmitTo] = useState('')
  const [summary, setSummary] = useState('')
  const [error, setError] = useState<string>()

  const reset = () => {
    setTitle('')
    setSubmitTo('')
    setSummary('')
    setCategory('その他')
    setStage('government')
    setError(undefined)
  }

  return (
    <Confirm
      open={open}
      title="手続きを追加"
      description="AIが見つけていない手続きを、自分で追加できます。"
      confirmLabel="追加する"
      busy={create.isPending}
      onClose={() => {
        reset()
        onClose()
      }}
      onConfirm={async () => {
        if (!title.trim()) {
          setError('手続きの名前を入れてください')
          return
        }
        await create.mutateAsync({ title: title.trim(), summary: summary.trim(), stage, category, submitTo: submitTo.trim() || undefined })
        reset()
        onClose()
      }}
    >
      <div className="flex flex-col gap-3.5">
        <Field label="手続きの名前" required error={error}>
          {(id) => (
            <input
              id={id}
              className={inputClass}
              value={title}
              aria-invalid={Boolean(error)}
              placeholder="例：クレジットカードを解約する"
              onChange={(e) => setTitle(e.target.value)}
            />
          )}
        </Field>
        <Field label="段階">
          {(id) => (
            <select id={id} className={inputClass} value={stage} onChange={(e) => setStage(e.target.value as FlowStageId)}>
              {Object.entries(FLOW_STAGE_WORD).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="種類">
          {(id) => (
            <select id={id} className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
              {Object.keys(TASK_CATEGORY_META).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="行き先・窓口">
          {(id) => (
            <input id={id} className={inputClass} value={submitTo} placeholder="例：○○カード サポートデスク" onChange={(e) => setSubmitTo(e.target.value)} />
          )}
        </Field>
        <Field label="メモ">
          {(id) => <textarea id={id} className={textareaClass} value={summary} onChange={(e) => setSummary(e.target.value)} />}
        </Field>
      </div>
    </Confirm>
  )
}
