import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useCreateTask, useTasks } from '@/api/queries'
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  SelectInput,
  Spinner,
  TextInput,
  TextareaInput,
} from '@/components/ui/Primitives'
import { Modal } from '@/components/ui/Modal'
import { LockedActionNotice, useRenunciationLock } from '@/components/domain/RenunciationLock'
import { TaskRow } from '@/components/domain/TaskRow'
import { Icon } from '@/components/ui/Icon'
import { DEADLINE_BUCKETS, TASK_FILTER_GROUPS, deadlineBucket } from '@/lib/labels'
import type { Task } from '@/api/types'

const BUCKET_COLOR: Record<string, string> = {
  critical: 'var(--color-state-red)',
  warning: '#b57e12',
  normal: 'var(--color-ink-muted)',
  quiet: 'var(--color-ink-faint)',
}

export function TasksPage() {
  const { caseId = '' } = useParams()
  const { data, isLoading, isError, refetch } = useTasks(caseId)
  const { locked } = useRenunciationLock(caseId)

  const [group, setGroup] = useState('all')
  const [category, setCategory] = useState('all')
  const [assignee, setAssignee] = useState('all')
  const [showNew, setShowNew] = useState(false)
  const [showFilters, setShowFilters] = useState(false)

  const all = useMemo(() => data?.items ?? [], [data])

  const categories = useMemo(
    () => Array.from(new Set(all.map((t) => t.category))).sort(),
    [all],
  )
  const assignees = useMemo(
    () => Array.from(new Set(all.map((t) => t.assigneeName).filter(Boolean) as string[])).sort(),
    [all],
  )

  const hiddenByLock = locked ? all.filter((t) => t.assetDisposal).length : 0

  const visible = useMemo(() => {
    const statuses = TASK_FILTER_GROUPS.find((g) => g.id === group)?.statuses ?? []
    return all
      .filter((t) => !(locked && t.assetDisposal)) // 放棄前ロック：財産処分タスクは一覧に出さない
      .filter((t) => statuses.includes(t.status))
      .filter((t) => category === 'all' || t.category === category)
      .filter((t) => assignee === 'all' || t.assigneeName === assignee)
      .sort(sortByDeadline)
  }, [all, group, category, assignee, locked])

  // 日付の羅列ではなく「いつまでに」でまとめる
  const grouped = useMemo(() => {
    const g: Record<string, Task[]> = {}
    for (const t of visible) {
      const id = deadlineBucket(t.deadline?.daysRemaining)
      ;(g[id] ??= []).push(t)
    }
    return g
  }, [visible])

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="手続き"
        title="タスク・期限"
        description="期限が近いものから順に並べています。"
        action={
          <Button variant="secondary" onClick={() => setShowNew(true)}>
            手続きを手動で追加する
          </Button>
        }
      />

      {hiddenByLock > 0 && <LockedActionNotice caseId={caseId} />}

      {/*
        状態はチップで常に見えるようにし、細かい絞り込みは畳む。
        画面が狭いとき、選択欄だけで最初の画面が埋まってしまうため。
      */}
      <div className="flex flex-col gap-2">
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {TASK_FILTER_GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              aria-pressed={group === g.id}
              onClick={() => setGroup(g.id)}
              className={`btn btn-sm shrink-0 ${group === g.id ? 'btn-primary' : 'btn-secondary'}`}
            >
              {g.label}
            </button>
          ))}
          <button
            type="button"
            aria-expanded={showFilters}
            onClick={() => setShowFilters((v) => !v)}
            className={`btn btn-sm shrink-0 ${
              category !== 'all' || assignee !== 'all' ? 'btn-primary' : 'btn-ghost'
            }`}
          >
            <Icon name="checklist" size={16} />
            絞り込み
          </button>
        </div>

        {showFilters && (
          <Card bodyClassName="p-3 sm:p-4">
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1 text-sm font-bold">
                手続きの種類
                <select
                  className="select"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="all">すべて</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm font-bold">
                担当
                <select
                  className="select"
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                >
                  <option value="all">すべて</option>
                  {assignees.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </Card>
        )}
      </div>

      {isLoading && <Spinner />}
      {isError && <ErrorState message="タスクを取得できませんでした。" onRetry={() => void refetch()} />}

      {data && visible.length === 0 && (
        <Card>
          <EmptyState
            title="条件に合う手続きはありません"
            description="絞り込みを変えるか、書類をアップロードして手続きの候補を作成してください。"
            action={
              <Link className="btn btn-secondary" to={`/cases/${caseId}/documents`}>
                書類をアップロードする
              </Link>
            }
          />
        </Card>
      )}

      {visible.length > 0 && (
        <div className="flex flex-col gap-5">
          {DEADLINE_BUCKETS.filter((b) => grouped[b.id]?.length).map((bucket) => (
            <section key={bucket.id}>
              <h2
                className="mb-2 flex items-center gap-2 text-sm font-bold"
                style={{ color: BUCKET_COLOR[bucket.tone] }}
              >
                {(bucket.tone === 'critical' || bucket.tone === 'warning') && (
                  <Icon name="warning" size={16} />
                )}
                {bucket.label}
                <span className="font-normal text-[var(--color-ink-faint)]">
                  {grouped[bucket.id].length}件
                </span>
                <span
                  aria-hidden
                  className="h-px flex-1"
                  style={{ background: 'var(--color-line)' }}
                />
              </h2>
              <ul className="flex flex-col gap-2">
                {grouped[bucket.id].map((task) => (
                  <li key={task.id}>
                    <TaskRow caseId={caseId} task={task} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <NewTaskModal caseId={caseId} open={showNew} onClose={() => setShowNew(false)} />
    </div>
  )
}

function sortByDeadline(a: Task, b: Task): number {
  if (!a.deadline && !b.deadline) return 0
  if (!a.deadline) return 1
  if (!b.deadline) return -1
  return a.deadline.dueDate.localeCompare(b.deadline.dueDate)
}

function NewTaskModal({
  caseId,
  open,
  onClose,
}: {
  caseId: string
  open: boolean
  onClose: () => void
}) {
  const create = useCreateTask(caseId)
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [category, setCategory] = useState('その他')
  const [submitTo, setSubmitTo] = useState('')
  const [error, setError] = useState<string | undefined>()

  async function submit() {
    if (!title.trim()) {
      setError('手続きの名称を入力してください。')
      return
    }
    await create.mutateAsync({
      title: title.trim(),
      summary: summary.trim(),
      category,
      submitTo: submitTo.trim() || undefined,
    })
    setTitle('')
    setSummary('')
    setSubmitTo('')
    setError(undefined)
    onClose()
  }

  return (
    <Modal
      open={open}
      title="手続きを手動で追加する"
      description="AIが見つけられなかった手続きは、ご自身で追加できます。"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>キャンセル</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={create.isPending}>
            追加する
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextInput
          label="手続きの名称"
          required
          value={title}
          error={error}
          onChange={(e) => setTitle(e.target.value)}
        />
        <TextareaInput
          label="内容のメモ"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        <SelectInput label="種類" value={category} onChange={(e) => setCategory(e.target.value)}>
          {['役所手続き', '年金・保険', '金融機関', '契約', '相続', '税務', 'その他'].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </SelectInput>
        <TextInput
          label="提出先・窓口"
          hint="例：○○市役所 市民課"
          value={submitTo}
          onChange={(e) => setSubmitTo(e.target.value)}
        />
      </div>
    </Modal>
  )
}
