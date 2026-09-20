import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  useAddEvidence,
  useCompleteTask,
  useReopenTask,
  useCaseOverview,
  useTask,
  useTasks,
  useUpdateTaskStatus,
} from '@/lib/api/queries'
import {
  Button,
  Card,
  Checkbox,
  DefinitionRow,
  ErrorState,
  SelectInput,
  Spinner,
  TextInput,
} from '@/components/ui/Primitives'
import { Banner } from '@/components/ui/Banner'
import { ConfirmDialog, Modal } from '@/components/ui/Modal'
import { DeadlineChip, TaskStatusBadge } from '@/components/domain/StatusBadges'
import { LockedActionNotice, useRenunciationLock } from '@/components/domain/RenunciationLock'
import { TASK_STATUS_META, TASK_STATUS_ORDER } from '@/lib/labels'
import { formatDateTime } from '@/lib/format'
import { safeExternalUrl, urlHostname } from '@/lib/url'
import { Icon } from '@/components/ui/Icon'
import { GuidanceResearchPanel } from '@/components/domain/GuidanceResearchPanel'
import type { Evidence, TaskStatus } from '@aftercare/public-contracts'

export function TaskDetailPage() {
  const { caseId = '', taskId = '' } = useParams()
  const { data: task, isLoading, isError, refetch } = useTask(taskId)
  const { locked } = useRenunciationLock(caseId)
  const updateStatus = useUpdateTaskStatus(caseId)
  const complete = useCompleteTask(caseId)
  const reopen = useReopenTask(caseId)

  const [confirmComplete, setConfirmComplete] = useState(false)
  const [confirmedBySelf, setConfirmedBySelf] = useState(false)
  const [showEvidence, setShowEvidence] = useState(false)
  // 完了直後だけ、労をねぎらって次の一手を示すパネルを出す
  const [justCompleted, setJustCompleted] = useState(false)

  const allTasks = useTasks(caseId)
  const overview = useCaseOverview(caseId)

  if (isLoading) return <Spinner />
  if (isError || !task)
    return <ErrorState message="手続きの情報を取得できませんでした。" onRetry={() => void refetch()} />

  // 放棄前ロック：財産処分に相当する手続きは、相続方法が確定するまで内容を開かない
  if (locked && task.assetDisposal) {
    return (
      <div className="flex flex-col gap-4">
        <Link to={`/cases/${caseId}/tasks`} className="inline-flex items-center gap-1 text-sm font-bold text-[var(--color-brand)] underline">
          <Icon name="chevron-left" size={16} />
          タスク一覧へ戻る
        </Link>
        <LockedActionNotice caseId={caseId} />
      </div>
    )
  }

  const unmetDependencies = (task.dependencies ?? []).filter((d) => !d.satisfied)

  // 次に期限が近い未完了の手続き（完了直後の導線に使う）
  const nextTask = (allTasks.data?.items ?? [])
    .filter((t) => t.id !== task.id && t.status !== 'COMPLETED' && !(locked && t.assetDisposal))
    .sort((a, b) => (a.deadline?.dueDate ?? '9999').localeCompare(b.deadline?.dueDate ?? '9999'))[0]

  return (
    <div className="flex flex-col gap-4">
      <Link to={`/cases/${caseId}/tasks`} className="inline-flex items-center gap-1 text-sm font-bold text-[var(--color-brand)] underline">
        <Icon name="chevron-left" size={16} />
        タスク一覧へ戻る
      </Link>

      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold">{task.title}</h1>
        <TaskStatusBadge status={task.status} />
      </header>
      <p className="text-[var(--color-ink-muted)]">{task.summary}</p>

      {justCompleted && (
        <Banner tone="info" title="完了として記録しました" role="alert">
          <p>
            「{task.title}」はお済みですね。おつかれさまでした。記録しましたので、この手続きは一覧で完了として扱われます。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {nextTask ? (
              <Link className="btn btn-primary btn-sm" to={`/cases/${caseId}/tasks/${nextTask.id}`}>
                次の手続きへ：{nextTask.title}
              </Link>
            ) : (
              <Link className="btn btn-primary btn-sm" to={`/cases/${caseId}`}>
                全体の進み具合を見る
              </Link>
            )}
            <Button size="sm" onClick={() => setShowEvidence(true)}>
              受理通知などを記録しておく
            </Button>
          </div>
        </Banner>
      )}

      {task.deadline && (
        <Card bodyClassName="p-4">
          <p className="text-sm font-bold text-[var(--color-ink-muted)]">期限</p>
          <p className="mt-0.5 text-lg">
            <DeadlineChip deadline={task.deadline} completed={task.status === 'COMPLETED'} />
          </p>
          {task.deadline.extendable && (
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
              この期限は、家庭裁判所への申立てなどにより延長できる場合があります。
            </p>
          )}
        </Card>
      )}

      {unmetDependencies.length > 0 && (
        <Banner tone="warning" title="先に確認が必要なことがあります">
          <ul className="mt-1 list-disc pl-5">
            {unmetDependencies.map((d, i) => (
              <li key={i}>
                {d.taskId ? (
                  <Link className="underline" to={`/cases/${caseId}/tasks/${d.taskId}`}>
                    {d.label}
                  </Link>
                ) : (
                  d.label
                )}
              </li>
            ))}
          </ul>
        </Banner>
      )}

      {/* 必要書類のチェックリスト */}
      <Card title="必要な書類">
        {(task.requiredDocuments?.length ?? 0) === 0 ? (
          <p className="text-[var(--color-ink-muted)]">登録されている必要書類はありません。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {task.requiredDocuments!.map((rd) => (
              <li key={rd.id} className="flex flex-wrap items-center gap-2">
                <Icon
                  name={rd.collected ? 'check-circle' : 'circle'}
                  size={18}
                  className={rd.collected ? 'text-[var(--color-state-green)]' : 'text-[var(--color-ink-faint)]'}
                />
                <span className={rd.collected ? '' : 'font-bold'}>{rd.label}</span>
                {!rd.collected && <span className="badge badge-yellow">未取得</span>}
                {rd.source === 'AI' && <span className="badge badge-blue">AI提案</span>}
                {rd.documentId && (
                  <Link
                    className="text-sm underline"
                    to={`/cases/${caseId}/documents/${rd.documentId}`}
                  >
                    アップロード済みの書類を見る
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 手順案内：提出先・持ち物・様式の案内まで。書類の作成・完成は行わない。 */}
      <Card title="進め方のご案内">
        {task.guidance ? (
          <div className="flex flex-col gap-3">
            {task.guidance.where && (
              <p>
                <span className="font-bold">窓口：</span>
                {task.guidance.where}
              </p>
            )}
            {(task.guidance.bring?.length ?? 0) > 0 && (
              <div>
                <p className="font-bold">お持ちいただくもの</p>
                <ul className="mt-1 list-disc pl-5">
                  {task.guidance.bring!.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </div>
            )}
            {(task.guidance.steps?.length ?? 0) > 0 && (
              <div>
                <p className="font-bold">手順</p>
                <ol className="mt-1 list-decimal pl-5">
                  {task.guidance.steps!.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </div>
            )}
            {safeExternalUrl(task.guidance.formExampleUrl) && (
              <p>
                <a
                  className="font-bold text-[var(--color-brand)] underline"
                  href={safeExternalUrl(task.guidance.formExampleUrl)!}
                  target="_blank"
                  rel="noreferrer"
                >
                  {task.guidance.formExampleLabel ?? '様式と記入例を見る'}
                </a>
                <span className="ml-2 text-sm text-[var(--color-ink-muted)]">
                  外部サイトが開きます（{urlHostname(task.guidance.formExampleUrl)}）
                </span>
              </p>
            )}
            {task.guidance.note && (
              <p className="text-[var(--color-ink-muted)]">{task.guidance.note}</p>
            )}

            <GuidanceResearchPanel
              caseId={caseId}
              task={task}
              municipality={overview.data?.case.municipality}
            />
          </div>
        ) : (
          <p className="text-[var(--color-ink-muted)]">ご案内はまだ用意できていません。</p>
        )}

        <div className="mt-4">
          <Banner tone="info">
            ご案内するのは、提出先・持ち物・手順・様式の見方までです。書類の作成や記入内容の確定、窓口への提出・送信は行いません。ご本人（ご遺族）にお願いします。
          </Banner>
        </div>
      </Card>

      {/* 状態の変更 */}
      <Card title="状態の変更">
        <div className="flex flex-wrap items-end gap-3">
          <SelectInput
            plain
            label="現在の状態"
            value={task.status}
            onChange={(e) =>
              void updateStatus.mutateAsync({ taskId: task.id, status: e.target.value as TaskStatus })
            }
          >
            {TASK_STATUS_ORDER.filter((s) => s !== 'COMPLETED').map((s) => (
              <option key={s} value={s}>
                {TASK_STATUS_META[s].label}
              </option>
            ))}
            {task.status === 'COMPLETED' && <option value="COMPLETED">完了</option>}
          </SelectInput>

          {task.status === 'COMPLETED' ? (
            <Button onClick={() => void reopen.mutateAsync({ taskId: task.id })}>
              完了を取り消す
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setConfirmComplete(true)}>
              完了として記録する
            </Button>
          )}
        </div>
      </Card>

      {/* 完了証跡 */}
      <Card
        title="完了の記録（証跡）"
        action={
          <Button size="sm" onClick={() => setShowEvidence(true)}>
            記録を追加する
          </Button>
        }
      >
        {(task.evidences?.length ?? 0) === 0 ? (
          <p className="text-[var(--color-ink-muted)]">
            受理通知や振込の記録などを残しておくと、あとで確認しやすくなります。
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--color-line)]">
            {task.evidences!.map((ev) => (
              <li key={ev.id} className="py-2.5 first:pt-0 last:pb-0">
                <p className="font-bold">{ev.label}</p>
                <p className="text-sm text-[var(--color-ink-faint)]">
                  {formatDateTime(ev.recordedAt)}
                  {ev.note ? ` ・ ${ev.note}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 事務的な情報は、窓口で必要な案内より下に置く */}
      <Card title="この手続きの情報">
        <dl>
          <DefinitionRow label="提出先">{task.submitTo ?? '—'}</DefinitionRow>
          <DefinitionRow label="種類">{task.category}</DefinitionRow>
          <DefinitionRow label="担当">{task.assigneeName ?? '未設定'}</DefinitionRow>
          <DefinitionRow label="最終更新">{formatDateTime(task.updatedAt)}</DefinitionRow>
        </dl>
      </Card>

      <ConfirmDialog
        open={confirmComplete}
        title="この手続きを完了として記録しますか？"
        description="この手続きはご自身で提出・手続き済みですか？　完了の判定はご本人の確認をもって行います。"
        confirmLabel="完了として記録する"
        disabled={!confirmedBySelf || complete.isPending}
        onClose={() => {
          setConfirmComplete(false)
          setConfirmedBySelf(false)
        }}
        onConfirm={async () => {
          await complete.mutateAsync({ taskId: task.id, confirmedBySelf: true })
          setConfirmComplete(false)
          setConfirmedBySelf(false)
          setJustCompleted(true)
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }}
      >
        <Checkbox
          checked={confirmedBySelf}
          onChange={setConfirmedBySelf}
          label="この手続きは自分で行い、完了していることを確認しました"
        />
      </ConfirmDialog>

      <EvidenceModal
        caseId={caseId}
        taskId={task.id}
        open={showEvidence}
        onClose={() => setShowEvidence(false)}
      />
    </div>
  )
}

function EvidenceModal({
  caseId,
  taskId,
  open,
  onClose,
}: {
  caseId: string
  taskId: string
  open: boolean
  onClose: () => void
}) {
  const add = useAddEvidence(caseId)
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<Evidence['kind']>('RECEIPT')
  const [note, setNote] = useState('')

  return (
    <Modal
      open={open}
      title="完了の記録を追加する"
      description="受理通知・入金・解約完了・登記完了などの記録を残せます。"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>キャンセル</Button>
          <Button
            variant="primary"
            disabled={!label.trim() || add.isPending}
            onClick={async () => {
              await add.mutateAsync({ taskId, label: label.trim(), kind, note: note.trim() || undefined })
              setLabel('')
              setNote('')
              onClose()
            }}
          >
            追加する
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextInput
          label="記録の名称"
          required
          hint="例：死亡届の受理通知を受け取った"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <SelectInput
          label="種類"
          value={kind}
          onChange={(e) => setKind(e.target.value as Evidence['kind'])}
        >
          <option value="RECEIPT">受理・受付</option>
          <option value="NOTICE">通知</option>
          <option value="PAYMENT">入金・支払い</option>
          <option value="REGISTRATION">登記・登録</option>
          <option value="OTHER">その他</option>
        </SelectInput>
        <TextInput label="メモ" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  )
}
