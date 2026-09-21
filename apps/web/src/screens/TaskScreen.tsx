import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  useAcknowledgeInsight,
  useAddEvidence,
  useCaseOverview,
  useInsights,
  usePersons,
  useRunTaskCommand,
  useTask,
  useTaskGuidance,
  useTasks,
  useUpdateRequiredDocuments,
  useUpdateTask,
} from '@/lib/api/queries'
import type { TaskRequiredDocumentResource, TaskResource } from '@aftercare/public-contracts'
import { toast } from '@/kit/toast'
import { isCarriedOver, isDisplayableInsight } from '@/lib/insights'
import { INSIGHT_KIND_META } from '@/lib/labels'
import { Icon } from '@/kit/Icon'
import { formatDate, formatDateTime } from '@/lib/format'
import { TASK_COMMAND_WORD, taskDependencies, visibleActions } from '@/lib/model/task'
import { safeExternalUrl, urlHostname } from '@/lib/url'
import {
  Button,
  Confirm,
  DList,
  ErrorState,
  Field,
  LinkButton,
  Loading,
  Notice,
  Page,
  PageHeader,
  Panel,
  inputClass,
} from '@/kit/kit'
import {
  CategoryIcon,
  ConditionalBadge,
  InfoBlock,
  TaskStatusBadge,
  byDeadlineIn,
  prepDeadline,
  dueWords,
  taskGroup,
  useCaseBase,
  useLock,
} from '@/kit/domain'
import { ResearchBox } from './parts/ResearchBox'
import { CompleteTaskDialog } from './parts/CompleteTaskDialog'

const SOURCE_LABEL = { AI: 'AIが書類などから見つけた', MANUAL: '自分で追加した', RULE_ENGINE: '法律で期限が決まっている' } as const

/**
 * 手続きの詳細。
 *
 * 利用場面：窓口へ行く前に「どこへ・何を持って・どうやって」を確かめる。帰ってきたら「済んだ」を押す。
 *  左：行き先・持ち物・手順（読むもの）
 *  右：期限と、押すボタン（やること）
 * 押すボタンは右側に集め、読む場所と操作する場所を分ける。
 */
export function TaskScreen() {
  const { taskId = '' } = useParams()
  // 「次へ」で別の手続きに移ったとき、完了の表示や開いていたダイアログを持ち越さない
  return <TaskScreenBody key={taskId} taskId={taskId} />
}

function TaskScreenBody({ taskId }: { taskId: string }) {
  const { caseId, base } = useCaseBase()
  const { data: task, isLoading, isError, refetch } = useTask(caseId, taskId)
  const all = useTasks(caseId)
  const overview = useCaseOverview(caseId)
  const guidance = useTaskGuidance(caseId, taskId)
  const { locked, reason } = useLock(caseId)
  const runCommand = useRunTaskCommand(caseId)

  const [confirming, setConfirming] = useState(false)
  const [justDone, setJustDone] = useState(false)
  const [addingEvidence, setAddingEvidence] = useState(false)

  if (isLoading) return <Loading />
  if (isError || !task) return <ErrorState message="手続きを読み込めませんでした。" onRetry={() => void refetch()} />

  const back = { to: `${base}/tasks`, label: 'やること' }

  // 財産を動かす手続きは、相続方法が決まるまで中身を開かない
  if (locked && task.assetDisposal) {
    return (
      <Page narrow>
        <PageHeader title="この手続きは表示していません" back={back} />
        <Notice
          tone="warning"
          action={<LinkButton to={`${base}/family`} size="sm">相続の方法を見る</LinkButton>}
        >
          財産の処分・解約にあたる手続きです。
          {reason === 'undecided'
            ? '単純承認を選んだと記録されるまで表示しません。'
            : '相続放棄・限定承認を選んだ方が自分の判断で進めると、放棄などが認められなくなるおそれがあるため表示しません。'}
        </Notice>
      </Page>
    )
  }

  const g = guidance.data
  const d = task.deadline
  // 期限の無い下準備（戸籍の収集など）は、相続の方法を決める期限を目安として示す
  const prep = prepDeadline(task, all.data?.items ?? [])
  const done = task.status === 'COMPLETED'
  const unmet = taskDependencies(task, all.data?.items ?? []).filter((x) => !x.satisfied)
  const where = g?.where ?? task.submitTo
  const form = safeExternalUrl(g?.formExampleUrl ?? undefined)

  const dueTone = !d || done || d.daysRemaining == null
    ? 'text-rd-text-3'
    : d.daysRemaining <= 3
      ? 'text-rd-danger-text'
      : d.daysRemaining <= 7
        ? 'text-rd-warning-text'
        : ''
  const isDecision = task.stage === 'decision'
  const actions = visibleActions(task)

  const next = (all.data?.items ?? [])
    .filter((t) => t.id !== task.id && taskGroup(t.status) === 'todo' && !(locked && t.assetDisposal))
    .sort(byDeadlineIn(all.data?.items ?? []))[0]

  return (
    <Page>
      <PageHeader
        back={back}
        title={task.title}
        badges={
          <>
            <TaskStatusBadge status={task.status} />
            <ConditionalBadge task={task} />
          </>
        }
        description={task.summary}
      />

      {justDone && (
        <Notice
          tone="success"
          role="status"
          title="おつかれさまでした。完了として記録しました。"
          action={
            next ? (
              <LinkButton to={`${base}/tasks/${next.id}`} variant="primary" size="sm">
                次へ：{next.title}
              </LinkButton>
            ) : (
              <LinkButton to={base} size="sm">ホームへ</LinkButton>
            )
          }
        />
      )}

      <CarriedOver caseId={caseId} taskId={task.id} />

      {/* 1列表示のとき：窓口で真っ先に見たい「期限」を上に出す */}
      {d && (
        <div className="flex items-center gap-3 rounded-lg border border-rd-border bg-rd-card px-4 py-3 xl:hidden">
          <CategoryIcon category={task.category} size={36} />
          <div className="min-w-0 flex-1">
            <p className={`text-[1.2rem] font-bold leading-tight ${dueTone}`}>{done ? '完了' : dueWords(d)}</p>
            <p className="text-[0.86rem] text-rd-text-2">
              {d.dueDate ? `${formatDate(d.dueDate, { weekday: true })}まで（${d.basisLabel}）` : d.basisLabel}
            </p>
          </div>
        </div>
      )}

      {!d && prep && !done && (
        <div className="rounded-lg border border-rd-warning-line bg-rd-warning-soft px-4 py-3 text-[0.9rem] leading-relaxed xl:hidden">
          <strong className="text-rd-warning-text">早めに始めたい手続きです。</strong>
          {prep.dueDate && <>相続の方法を決める期限（{formatDate(prep.dueDate, { weekday: true })}）より前に済ませます。</>}
        </div>
      )}

      {unmet.length > 0 && (
        <Notice tone="warning" title="先に済ませておくことがあります">
          <ul className="list-disc pl-5">
            {unmet.map((x) => (
              <li key={x.taskId}>
                <Link className="underline" to={`${base}/tasks/${x.taskId}`}>{x.label}</Link>
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
        {/* ---- 読むもの ---- */}
        <div className="flex flex-col gap-5">
          <Panel title="進め方">
            <div className="flex flex-col gap-5">
              {isDecision && (
                <Notice
                  tone="info"
                  title="相続の方法は「家族・相続人」で、人ごとに記録します"
                  action={<LinkButton to={`${base}/family`} size="sm">方法を記録する</LinkButton>}
                >
                  この手続きを完了にしても、財産についての制限は外れません。全員の方法を記録してから、ここを完了にしてください。
                </Notice>
              )}
              <InfoBlock icon="pin" title="行き先・窓口">
                {where ?? <span className="text-rd-text-3">まだ分かっていません</span>}
              </InfoBlock>

              <InfoBlock icon="bag" title="持ち物">
                <BringList caseId={caseId} base={base} task={task} bring={g?.bring ?? []} />
              </InfoBlock>

              {(g?.steps?.length ?? 0) > 0 && (
                <InfoBlock icon="checklist" title="手順">
                  <ol className="mt-1 flex flex-col gap-2">
                    {g!.steps!.map((s, i) => (
                      <li key={i} className="flex gap-2.5">
                        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-rd-primary-soft text-[0.8rem] font-bold text-rd-primary-text">
                          {i + 1}
                        </span>
                        <span>{s}</span>
                      </li>
                    ))}
                  </ol>
                </InfoBlock>
              )}

              {form && (
                <InfoBlock icon="document" title="様式・記入例">
                  <a href={form} target="_blank" rel="noreferrer" className="font-bold text-rd-primary-text underline">
                    {g?.formExampleLabel ?? '様式と記入例を見る'}
                  </a>
                  <span className="ml-1.5 text-[0.82rem] text-rd-text-3">外部サイト（{urlHostname(g?.formExampleUrl ?? undefined)}）</span>
                </InfoBlock>
              )}

              {g?.note && <p className="rounded-md bg-rd-bg px-3 py-2 text-[0.94rem] text-rd-text-2">{g.note}</p>}

              <ResearchBox
                caseId={caseId}
                task={task}
                municipality={overview.data?.case.municipality}
                caseVersion={overview.data?.case.version}
              />

              <p className="text-[0.82rem] leading-relaxed text-rd-text-3">
                ご案内するのは、行き先・持ち物・手順までです。書類の作成や、窓口への提出・送信は行いません。
              </p>
            </div>
          </Panel>

          <Panel
            title="受け取った控えなどの記録"
            action={
              <Button size="sm" icon="plus" onClick={() => setAddingEvidence(true)}>
                記録を残す
              </Button>
            }
          >
            {task.evidences.length === 0 ? (
              <p className="text-[0.9rem] text-rd-text-2">窓口で受け付けてもらった控えや、振込の記録などを残しておくと、あとで見返せます。</p>
            ) : (
              <ul className="flex flex-col">
                {task.evidences.map((e) => (
                  <li key={e.id} className="border-b border-rd-border-2 py-2 last:border-b-0">
                    <p className="text-[0.97rem] font-bold">{e.label}</p>
                    <p className="text-[0.82rem] text-rd-text-3">
                      {formatDateTime(e.recordedAt)}
                      {e.note && `・${e.note}`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {/* ---- 押すもの ---- */}
        <aside className="flex flex-col gap-4 xl:sticky xl:top-6">
          <section className="hidden rounded-lg border border-rd-border bg-rd-card p-4 xl:block">
            <div className="flex items-center gap-3">
              <CategoryIcon category={task.category} size={40} />
              <div>
                <p className="text-[0.82rem] font-bold text-rd-text-2">期限</p>
                {d ? (
                  <p className={`text-[1.4rem] font-bold leading-tight ${dueTone}`}>
                    {done ? '完了' : dueWords(d)}
                  </p>
                ) : prep && !done ? (
                  <p className="text-[1.2rem] font-bold leading-tight text-rd-warning-text">早めに</p>
                ) : (
                  <p className="text-[1rem] font-bold text-rd-text-3">期限なし</p>
                )}
              </div>
            </div>
            {!d && prep && !done && prep.dueDate && (
              <p className="mt-3 rounded-md bg-rd-warning-soft px-3 py-2 text-[0.86rem] leading-relaxed text-rd-text">
                法律上の期限はありませんが、相続の方法を決める期限（<strong>{formatDate(prep.dueDate, { weekday: true })}</strong>）より前に済ませたい手続きです。
              </p>
            )}
            {d && (
              <div className="mt-3 rounded-md bg-rd-bg px-3 py-2 text-[0.86rem] leading-relaxed text-rd-text-2">
                {d.dueDate && <p><strong className="text-rd-text">{formatDate(d.dueDate, { weekday: true })}</strong> まで</p>}
                <p>期限の数え方：{d.basisLabel}</p>
                {d.extendable && <p>家庭裁判所への申立てで延ばせる場合があります。</p>}
              </div>
            )}

            <div className="mt-4 flex flex-col gap-2">
              {done ? (
                actions.includes('reopen') && (
                  <Button
                    onClick={() => void runCommand.mutateAsync({ taskId: task.id, command: 'reopen', expectedVersion: task.version })}
                    disabled={runCommand.isPending}
                  >
                    完了を取り消す
                  </Button>
                )
              ) : (
                <>
                  {actions.includes('complete') && (
                    <Button variant="primary" size="lg" icon="check" onClick={() => setConfirming(true)}>
                      済んだので記録する
                    </Button>
                  )}
                  {actions
                    .filter((a) => a !== 'complete')
                    .map((a) => (
                      <Button
                        key={a}
                        disabled={runCommand.isPending}
                        onClick={() => void runCommand.mutateAsync({ taskId: task.id, command: a, expectedVersion: task.version })}
                      >
                        {TASK_COMMAND_WORD[a]}
                      </Button>
                    ))}
                </>
              )}
            </div>
          </section>

          <Panel title="この手続きについて">
            <DList
              rows={[
                { label: '種類', value: task.category },
                { label: '担当', value: <AssigneeSelect caseId={caseId} task={task} ownerName={overview.data?.case.ownerName} /> },
                { label: '追加された理由', value: SOURCE_LABEL[task.source] },
                { label: '最終更新', value: formatDateTime(task.updatedAt) },
              ]}
            />
            <Link
              to={`${base}/chat`}
              className="mt-3 flex items-center gap-1.5 text-[0.9rem] font-bold text-rd-primary-text hover:underline"
            >
              <Icon name="chat" size={16} />
              この手続きについてAIに聞く
            </Link>
          </Panel>
        </aside>
      </div>

      {/* 1列表示のとき：押すボタンは画面の下に固定する（サイドバーがある幅ではその右側に） */}
      <div className="h-20 xl:hidden" aria-hidden />
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-rd-border bg-rd-card px-4 py-3 lg:left-60 xl:hidden">
        {done ? (
          actions.includes('reopen') && (
            <Button
              className="flex-1"
              onClick={() => void runCommand.mutateAsync({ taskId: task.id, command: 'reopen', expectedVersion: task.version })}
              disabled={runCommand.isPending}
            >
              完了を取り消す
            </Button>
          )
        ) : (
          <>
            {actions.includes('complete') && (
              <Button variant="primary" size="lg" icon="check" className="min-w-0 flex-1 px-3" onClick={() => setConfirming(true)}>
                済んだので記録する
              </Button>
            )}
            {(() => {
              const secondary = actions.find((a) => a !== 'complete')
              return (
                secondary && (
                  <Button
                    size="lg"
                    disabled={runCommand.isPending}
                    onClick={() => void runCommand.mutateAsync({ taskId: task.id, command: secondary, expectedVersion: task.version })}
                  >
                    {TASK_COMMAND_WORD[secondary]}
                  </Button>
                )
              )
            })()}
          </>
        )}
      </div>

      <CompleteTaskDialog
        caseId={caseId}
        task={task}
        open={confirming}
        onClose={() => setConfirming(false)}
        onDone={() => {
          setJustDone(true)
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }}
      />

      <EvidenceDialog caseId={caseId} taskId={task.id} open={addingEvidence} onClose={() => setAddingEvidence(false)} />
    </Page>
  )
}

function EvidenceDialog({ caseId, taskId, open, onClose }: { caseId: string; taskId: string; open: boolean; onClose: () => void }) {
  const add = useAddEvidence(caseId)
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<TaskResource['evidences'][number]['kind']>('RECEIPT')
  const [note, setNote] = useState('')

  return (
    <Confirm
      open={open}
      title="記録を残す"
      description="受け付けてもらった控え・入金・解約の完了・名義変更の完了などを記録できます。"
      confirmLabel="記録する"
      busy={add.isPending}
      disabled={!label.trim()}
      onClose={onClose}
      onConfirm={async () => {
        await add.mutateAsync({ taskId, label: label.trim(), kind, note: note.trim() || undefined })
        setLabel('')
        setNote('')
        onClose()
      }}
    >
      <div className="flex flex-col gap-3.5">
        <Field label="何の記録か" required hint="例：死亡届の受理証明を受け取った">
          {(id) => <input id={id} className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} />}
        </Field>
        <Field label="種類">
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={kind}
              onChange={(e) => setKind(e.target.value as TaskResource['evidences'][number]['kind'])}
            >
              <option value="RECEIPT">受理・受付</option>
              <option value="NOTICE">通知</option>
              <option value="PAYMENT">入金・支払い</option>
              <option value="REGISTRATION">登記・登録</option>
              <option value="OTHER">その他</option>
            </select>
          )}
        </Field>
        <Field label="メモ">
          {(id) => <input id={id} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Confirm>
  )
}

/**
 * 前回からの持ち越し。
 * この手続きが止まっている・前提が変わった、という気づきを、手続きを開いたときにも出す。
 */
function CarriedOver({ caseId, taskId }: { caseId: string; taskId: string }) {
  const insights = useInsights(caseId)
  const acknowledge = useAcknowledgeInsight(caseId)
  const items = (insights.data ?? []).filter(
    (i) =>
      i.relatedTaskId === taskId &&
      i.status === 'NEW' &&
      isCarriedOver(i) &&
      isDisplayableInsight(i),
  )
  if (items.length === 0) return null
  return (
    <>
      {items.map((ins) => (
        <Notice
          key={ins.id}
          tone="warning"
          title={INSIGHT_KIND_META[ins.kind].label}
          action={
            <Button size="sm" disabled={acknowledge.isPending} onClick={() => void acknowledge.mutateAsync({ id: ins.id })}>
              読みました
            </Button>
          }
        >
          <span className="mr-1 text-[0.8rem] font-bold text-rd-primary-text">[AI]</span>
          {ins.body}
          {ins.requiresProfessional && (
            <span className="mt-1 block text-[0.86rem] text-rd-text-2">法律の判断を含みます。専門家にご確認ください。</span>
          )}
        </Notice>
      ))}
    </>
  )
}

/**
 * 持ち物のチェック。
 * 窓口や家で1つずつ消し込めるよう、行全体を押せる大きさにする。
 * 案内にだけ載っている持ち物も、押したときに持ち物の一覧へ加えて記録する。
 */
function BringList({ caseId, base, task, bring }: { caseId: string; base: string; task: TaskResource; bring: string[] }) {
  const update = useUpdateRequiredDocuments(caseId)
  const docs = task.requiredDocuments
  /*
    並びは押しても変えない（窓口で消し込んでいる最中に行が動くと押し間違える）。
    持ち物の一覧 → 案内に載っている持ち物、の順。案内の持ち物は、押して記録した後も案内の位置に出す。
  */
  const fromBring = (r: TaskRequiredDocumentResource) => r.id.startsWith('bring_') && bring.includes(r.label)
  const rows: { label: string; doc?: TaskRequiredDocumentResource }[] = [
    ...docs.filter((r) => !fromBring(r)).map((r) => ({ label: r.label, doc: r })),
    ...bring
      .filter((b) => !docs.some((r) => r.label === b && !fromBring(r)))
      .map((b) => ({ label: b, doc: docs.find((r) => r.label === b && fromBring(r)) })),
  ]
  const total = rows.length
  if (total === 0) return <span className="text-rd-text-3">登録されている持ち物はありません</span>
  const isReady = (r?: TaskRequiredDocumentResource) => Boolean(r && (r.collected || r.documentId != null))
  const ready = rows.filter((r) => isReady(r.doc)).length

  const save = (next: TaskRequiredDocumentResource[]) =>
    void update.mutateAsync({ taskId: task.id, expectedVersion: task.version, requiredDocuments: next }).catch(() => {})
  const toggle = (id: string) => save(docs.map((r) => (r.id === id ? { ...r, collected: !isReady(r) } : r)))
  const addChecked = (label: string) =>
    save([...docs, { id: `bring_${crypto.randomUUID().slice(0, 8)}`, label, documentId: null, collected: true, source: 'AI' }])

  return (
    <div className="mt-1">
      <p className="text-[0.86rem] text-rd-text-2" aria-live="polite">
        {ready === total ? '全部そろいました' : `${total}点のうち${ready}点を用意できました`}
        <span className="ml-1.5 text-rd-text-3">（押すと印が付きます）</span>
      </p>
      <ul className="mt-1.5 flex flex-col">
        {rows.map(({ label, doc }) => {
          const on = doc?.documentId != null
          return (
            <li key={doc?.id ?? `bring-${label}`} className="flex flex-wrap items-center gap-x-2 border-b border-rd-border-2 last:border-b-0">
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => (doc ? toggle(doc.id) : addChecked(label))}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 py-1.5 text-left hover:bg-rd-bg"
              >
                <Icon
                  name={on ? 'check-circle' : 'circle'}
                  size={20}
                  className={`shrink-0 ${on ? 'text-rd-success-text' : 'text-rd-text-3'}`}
                />
                <span className={on ? 'text-rd-text-2 line-through decoration-rd-text-3' : ''}>{label}</span>
              </button>
              {on && doc?.documentId && (
                <Link to={`${base}/documents/${doc.documentId}`} className="py-2 text-[0.82rem] text-rd-primary-text underline">
                  追加した書類
                </Link>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** 担当者。家族で手分けするときに、誰が進めるかを決めておく。 */
function AssigneeSelect({ caseId, task, ownerName }: { caseId: string; task: TaskResource; ownerName?: string }) {
  const persons = usePersons(caseId)
  const assign = useUpdateTask(caseId)
  const people = (persons.data ?? []).filter((p) => !p.excludedAt)

  return (
    <select
      className={`${inputClass} h-9 py-0`}
      aria-label="担当"
      value={task.assigneeId ?? ''}
      disabled={assign.isPending || !persons.data}
      onChange={async (e) => {
        const id = e.target.value || null
        try {
          await assign.mutateAsync({ taskId: task.id, expectedVersion: task.version, assigneeId: id })
        } catch {
          return // 失敗の知らせは共通の処理（MutationCache）が出す
        }
        const name = people.find((p) => p.id === id)?.name
        toast(name ? `担当を${name}さんにしました` : '担当を「未定」に戻しました')
      }}
    >
      <option value="">未定</option>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {p.name === ownerName ? '（あなた）' : `（${p.relationship}）`}
        </option>
      ))}
    </select>
  )
}
