import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { FlowStageId, FlowStageResource, InheritanceMethod, TaskResource } from '@aftercare/public-contracts'
import { useCaseOverview, useTasks } from '@/lib/api/queries'
import { Icon } from '@/kit/Icon'
import { FLOW_STAGE_WORD, METHOD_HINT, TASK_STATUS_WORD } from '@/kit/words'
import { ErrorState, Loading, Page, PageHeader } from '@/kit/kit'
import { useCaseBase, useLock } from '@/kit/domain'

/**
 * 手続きの流れ。
 *
 * 相続の手続きは10の段階をおおむね上から順に進む。知りたいのは「いまどこにいて、次に何が来るか」なので、
 * 縦のワークフローで順番と分かれ道（相続の方法）を見せ、いまの段階に「いまここ」を付ける。
 * 段階を押すと、その段階に含まれる手続きが開く。
 */

/** 段階のまとまり。色で「直後／役所・生活・調査／相続・税金／その後」を見分ける */
const GROUP = {
  early: { label: '直後の対応', fg: 'text-state-red', bg: 'bg-state-red-soft', line: 'border-state-red/35' },
  admin: { label: '役所・生活・調査', fg: 'text-state-green', bg: 'bg-state-green-soft', line: 'border-state-green/35' },
  legal: { label: '相続・税金', fg: 'text-state-purple', bg: 'bg-state-purple-soft', line: 'border-state-purple/35' },
  after: { label: '終了・その後', fg: 'text-state-gray', bg: 'bg-state-gray-soft', line: 'border-state-gray/35' },
} as const
type GroupId = keyof typeof GROUP

/** 各段階の目安（期限など）。段階名だけでは何をするか分かりにくいので、ひとことを添える */
const STAGE_META: Record<FlowStageId, { group: GroupId; hint: string }> = {
  // 死亡届と一緒に火葬許可を申請し、許可証がないと火葬できない。そのため葬儀より前の段階に置く
  immediate: { group: 'early', hint: '死亡届は7日以内・火葬より前に' },
  funeral: { group: 'early', hint: '火葬後に埋葬許可証を保管' },
  government: { group: 'admin', hint: '多くは14日以内' },
  contracts: { group: 'admin', hint: '解約・名義変更' },
  investigation: { group: 'admin', hint: '遺言・相続人・財産' },
  decision: { group: 'legal', hint: '原則3か月以内に判断' },
  division: { group: 'legal', hint: '相続人全員で話し合い・協議書の作成' },
  transfer: { group: 'legal', hint: '相続登記は3年以内' },
  tax: { group: 'legal', hint: '準確定申告4か月・相続税10か月' },
  closing: { group: 'after', hint: '返却・手続きのもれの確認' },
}

/**
 * 色だけに頼らず、状態は記号と言葉でも出す。
 * 実APIは手続きが0件の段階を NO_TASKS で返す（完了ではない）。旧DTOの型には無いので、ここで受ける
 */
type StageState = FlowStageResource['state'] | 'NO_TASKS'
const STATE: Record<StageState, { word: string; icon: 'check' | 'progress' | 'circle'; fg: string }> = {
  COMPLETED: { word: '済み', icon: 'check', fg: 'text-rd-success-text' },
  IN_PROGRESS: { word: '進行中', icon: 'progress', fg: 'text-rd-primary-text' },
  NOT_STARTED: { word: 'これから', icon: 'circle', fg: 'text-rd-text-3' },
  NO_TASKS: { word: '手続きなし', icon: 'circle', fg: 'text-rd-text-3' },
}

function stageState(s: FlowStageResource): StageState {
  return s.totalTasks === 0 ? 'NO_TASKS' : s.state
}

/** 葬儀のあとに来る段階。ここに入っていれば、葬儀・火葬は終わっている */
const AFTER_FUNERAL: FlowStageId[] = ['government', 'contracts', 'investigation']

/**
 * 画面に出す状態。
 * 葬儀・火葬は手続きとして登録されないことが多く、そのままでは「済み」にならない。
 * ③〜⑤のどれかに入っていれば済みとみなす。ただし葬儀・火葬に残っている手続きがあるときは、
 * それを隠さないよう、実際の状態のまま出す
 */
function shownStates(stages: FlowStageResource[]) {
  const map = new Map(stages.map((s) => [s.id, { state: stageState(s), auto: false }]))
  const funeral = stages.find((s) => s.id === 'funeral')
  const entered = stages.some(
    (s) => AFTER_FUNERAL.includes(s.id) && (s.state === 'IN_PROGRESS' || s.state === 'COMPLETED') && s.totalTasks > 0,
  )
  if (funeral && entered && funeral.completedTasks === funeral.totalTasks) {
    map.set('funeral', { state: 'COMPLETED', auto: true })
  }
  return map
}

/*
  放棄しても「⑦〜⑨は不要」とは言えない。遺族年金・未支給年金・受取人が決まった死亡保険金は
  放棄した人も受け取れ、死亡保険金には相続税がかかることもある。また、ほかの相続人は先へ進む。
*/
const METHODS: { id: InheritanceMethod; label: string; note?: string }[] = [
  { id: 'SIMPLE_ACCEPTANCE', label: '単純承認' },
  { id: 'LIMITED_ACCEPTANCE', label: '限定承認', note: '相続人全員でそろって申し立てる' },
  { id: 'RENUNCIATION', label: '相続放棄', note: '遺産の話し合いには加わらない' },
]

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩'

export function FlowScreen() {
  const { caseId, base } = useCaseBase()
  const overview = useCaseOverview(caseId)
  const tasks = useTasks(caseId)
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

  const stages = overview.data.flowStages
  const byId = new Map(stages.map((s, i) => [s.id, { stage: s, no: i }]))
  const shown = shownStates(stages)
  const stateOf = (s: FlowStageResource) => shown.get(s.id)!.state
  const withTasks = stages.filter((s) => stateOf(s) !== 'NO_TASKS')
  const done = withTasks.filter((s) => stateOf(s) === 'COMPLETED').length
  // 「いまここ」は、進行中のうち最も前にある段階。進行中が複数あっても、目印は1つにする。
  // 手続きが0件の段階には付けない
  const here =
    withTasks.find((s) => stateOf(s) === 'IN_PROGRESS') ?? withTasks.find((s) => stateOf(s) !== 'COMPLETED')
  const perHeir = overview.data.inheritanceDecision.perHeir

  const node = (id: FlowStageId) => {
    const hit = byId.get(id)
    if (!hit) return null
    return (
      <StageNode
        key={id}
        stage={hit.stage}
        no={hit.no}
        state={shown.get(id)!.state}
        autoDone={shown.get(id)!.auto}
        here={hit.stage.id === here?.id}
        // やること・ホームと同じく、財産を動かす手続きは相続の方法が決まるまで名前も出さない
        tasks={tasks.data.items.filter((t) => t.stage === id && !(locked && t.assetDisposal))}
        hidden={tasks.data.items.filter((t) => t.stage === id && locked && t.assetDisposal).length}
        base={base}
      />
    )
  }

  return (
    <Page narrow>
      <PageHeader
        title="手続きの流れ"
        description="相続の手続きは、おおむね上から順に進みます。段階を押すと、その段階の手続きが見られます。"
      />

      {/* いまどこか、を最初に1行で伝える */}
      <section className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-rd-primary-line bg-rd-primary-soft px-5 py-4">
        <Icon name="pin" size={22} className="text-rd-primary-text" />
        <p className="min-w-0 flex-1 text-[1.05rem] font-bold leading-snug">
          {here ? (
            <>
              いまは「{CIRCLED[byId.get(here.id)!.no]} {stageName(here)}」の段階です
            </>
          ) : (
            withTasks.length > 0 ? 'すべての段階が済みました' : '手続きはまだ登録されていません'
          )}
        </p>
        <span className="text-[0.9rem] text-rd-text-2">
          対象の{withTasks.length}段階のうち <strong className="text-rd-text">{done}</strong> 段階が済み
        </span>
      </section>

      <ol className="flex flex-col items-stretch">
        <li>{node('immediate')}</li>
        <Arrow />
        <li>{node('funeral')}</li>
        <Arrow />
        <li className="rounded-lg border border-dashed border-rd-border p-3">
          <p className="mb-2 text-[0.82rem] font-bold text-rd-text-3">並行して進める</p>
          <ol className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <li>{node('government')}</li>
            <li>{node('contracts')}</li>
            <li>{node('investigation')}</li>
          </ol>
        </li>
        <Arrow />
        <li>{node('decision')}</li>
        <Arrow />
        {/* 分かれ道。誰がどの方法を選んだかを添える */}
        <li>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {METHODS.map((m) => {
              // 実APIでは関係者の登録前は名前が null になる
              const who = perHeir.filter((h) => h.method === m.id).map((h) => (h.personName ? `${h.personName}さん` : '名前未登録の方'))
              const chosen = who.length > 0
              const renounce = m.id === 'RENUNCIATION'
              return (
                <li
                  key={m.id}
                  className={`rounded-lg border px-4 py-3 text-center ${
                    renounce ? 'border-state-gray/35 bg-state-gray-soft' : 'border-state-purple/35 bg-state-purple-soft'
                  } ${chosen ? 'ring-2 ring-rd-primary' : ''}`}
                >
                  <p className={`font-bold ${renounce ? 'text-state-gray' : 'text-state-purple'}`}>{m.label}</p>
                  <p className="mt-0.5 text-[0.82rem] text-rd-text-2">{METHOD_HINT[m.id]}</p>
                  {m.note && <p className="mt-0.5 text-[0.82rem] font-bold text-rd-text-2">{m.note}</p>}
                  {chosen && (
                    <p className="mt-1.5 flex items-center justify-center gap-1 text-[0.82rem] font-bold text-rd-primary-text">
                      <Icon name="check" size={13} strokeWidth={2.4} />
                      {who.join('・')}が選択
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="mt-2 text-center text-[0.82rem] text-rd-text-3">
            放棄しなかった相続人で、この先へ進みます。放棄しても、遺族年金や死亡保険金などは受け取れることがあります
          </p>
        </li>
        <Arrow />
        <li>{node('division')}</li>
        <Arrow />
        <li>{node('transfer')}</li>
        <Arrow />
        <li>{node('tax')}</li>
        <Arrow />
        <li>{node('closing')}</li>
      </ol>

      <ul className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-[0.82rem] text-rd-text-2">
        {Object.values(GROUP).map((g) => (
          <li key={g.label} className="flex items-center gap-1.5">
            <span aria-hidden className={`h-3 w-3 rounded-sm border ${g.bg} ${g.line}`} />
            {g.label}
          </li>
        ))}
      </ul>
    </Page>
  )
}

function stageName(s: FlowStageResource) {
  return FLOW_STAGE_WORD[s.id] ?? s.label.replace(/（.*?）/, '')
}

function StageNode({
  stage,
  no,
  state,
  autoDone,
  here,
  tasks,
  hidden,
  base,
}: {
  stage: FlowStageResource
  no: number
  state: StageState
  autoDone: boolean
  here: boolean
  tasks: TaskResource[]
  hidden: number
  base: string
}) {
  // 押すまでは「いまの段階だけ開く」に従う。「いまここ」が移れば開く段階も移る
  const [toggled, setToggled] = useState<boolean | null>(null)
  const open = toggled ?? here
  const meta = STAGE_META[stage.id]
  const g = GROUP[meta?.group ?? 'after']
  const st = STATE[state]
  const hasTasks = tasks.length + hidden > 0

  return (
    <div
      className={`relative rounded-lg border ${g.bg} ${here ? 'border-rd-primary ring-2 ring-rd-primary' : g.line} ${
        state === 'COMPLETED' || state === 'NO_TASKS' ? 'opacity-80' : ''
      }`}
    >
      {here && (
        <span className="absolute -top-3 left-3 rounded-full bg-rd-primary px-2.5 py-0.5 text-[0.78rem] font-bold text-white shadow-sm">
          いまここ
        </span>
      )}
      <button
        type="button"
        onClick={() => setToggled(!open)}
        disabled={!hasTasks}
        aria-expanded={hasTasks ? open : undefined}
        className="flex w-full flex-col items-center gap-0.5 px-4 pt-3.5 pb-2.5 text-center enabled:cursor-pointer"
      >
        <span className={`font-bold leading-snug ${g.fg}`}>
          {CIRCLED[no]} {stageName(stage)}
        </span>
        {meta && <span className="text-[0.84rem] text-rd-text-2">{meta.hint}</span>}
        <span className={`mt-1 flex items-center gap-1 text-[0.8rem] font-bold whitespace-nowrap ${st.fg}`}>
          <Icon name={st.icon} size={13} strokeWidth={2.4} />
          {st.word}
          {autoDone && <span className="font-normal text-rd-text-3">（③〜⑤に進んだため）</span>}
          {hasTasks && (
            <span className="font-normal text-rd-text-3">
              （{stage.totalTasks}件中{stage.completedTasks}件）
            </span>
          )}
          {hasTasks && (
            <Icon
              name="chevron-right"
              size={13}
              className={`text-rd-text-3 transition-transform ${open ? 'rotate-90' : ''}`}
            />
          )}
        </span>
      </button>
      {open && hasTasks && (
        <ul className="mx-2 mb-2 overflow-hidden rounded-md border border-rd-border bg-rd-card text-left">
          {hidden > 0 && (
            <li className="border-b border-rd-border-2 px-3 py-2 text-[0.82rem] text-rd-text-2 last:border-b-0">
              ほか{hidden}件は、財産を動かす手続きのため、相続の方法が決まるまで表示しません
            </li>
          )}
          {tasks.map((t) => (
            <li key={t.id} className="border-b border-rd-border-2 last:border-b-0">
              <Link
                to={`${base}/tasks/${t.id}`}
                className="flex items-center gap-2 px-3 py-2 text-[0.9rem] hover:bg-rd-bg"
              >
                <Icon
                  name={t.status === 'COMPLETED' ? 'check' : 'circle'}
                  size={14}
                  strokeWidth={2.4}
                  className={t.status === 'COMPLETED' ? 'text-rd-success-text' : 'text-rd-text-3'}
                />
                <span className={`min-w-0 flex-1 ${t.status === 'COMPLETED' ? 'text-rd-text-3 line-through' : ''}`}>
                  {t.title}
                </span>
                <span className="shrink-0 text-[0.78rem] text-rd-text-3">{TASK_STATUS_WORD[t.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Arrow() {
  return (
    <li aria-hidden className="flex flex-col items-center py-1 text-rd-text-3">
      <span className="h-4 w-px bg-current" />
      <Icon name="chevron-right" size={14} className="-mt-1.5 rotate-90" />
    </li>
  )
}
