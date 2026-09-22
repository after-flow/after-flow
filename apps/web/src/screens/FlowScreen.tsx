import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type {
  DeadlineResource as DeadlineSummary,
  FlowStageId,
  FlowStageResource as FlowStage,
  InheritanceMethod,
  TaskResource as Task,
} from '@aftercare/public-contracts'
import { useCaseOverview, useTasks, useUpdateCase } from '@/lib/api/queries'
import { formatDate } from '@/lib/format'
import { Icon } from '@/kit/Icon'
import { FLOW_STAGE_WORD, METHOD_HINT } from '@/kit/words'
import { ErrorState, LinkButton, Loading, Notice, Page, PageHeader } from '@/kit/kit'
import { dueTone, dueWords, prepDeadline, useCaseBase, useLock } from '@/kit/domain'

/**
 * 手続きの流れ（ホーム）。
 *
 * 相続の手続きは10の段階をおおむね上から順に進む。知りたいのは「いまどこにいて、次に何が来るか」なので、
 * 縦のワークフローで順番と分かれ道（相続の方法）を見せ、いまの段階に「いまここ」を付ける。
 * 段階を押すと、その段階に含まれる手続きが開く。
 */

/** 段階のまとまり。色で見分ける（凡例は出さない。色は目安で、段階名と状態は言葉で出している） */
const GROUP = {
  // 直後の対応
  early: { fg: 'text-state-red', bg: 'bg-state-red-soft', line: 'border-state-red/35' },
  // 役所・生活・調査
  admin: { fg: 'text-state-green', bg: 'bg-state-green-soft', line: 'border-state-green/35' },
  // 相続・税金
  legal: { fg: 'text-state-purple', bg: 'bg-state-purple-soft', line: 'border-state-purple/35' },
  // 終了・その後
  after: { fg: 'text-state-gray', bg: 'bg-state-gray-soft', line: 'border-state-gray/35' },
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
type StageState = FlowStage['state'] | 'NO_TASKS'
const STATE: Record<StageState, { word: string; icon: 'check' | 'progress' | 'circle'; fg: string }> = {
  COMPLETED: { word: '済み', icon: 'check', fg: 'text-rd-success-text' },
  IN_PROGRESS: { word: '進行中', icon: 'progress', fg: 'text-rd-primary-text' },
  // 段階の枠は色付きの地なので、薄い文字（text-3）では AA に届かない。text-2 を使う
  NOT_STARTED: { word: 'これから', icon: 'circle', fg: 'text-rd-text-2' },
  NO_TASKS: { word: '手続きなし', icon: 'circle', fg: 'text-rd-text-2' },
}

function stageState(s: FlowStage): StageState {
  return s.totalTasks === 0 ? 'NO_TASKS' : s.state
}

/**
 * 画面に出す状態。
 * 葬儀・火葬は手続きとして登録されないことが多く、手続きの件数からは済んだか決められない。
 * そのため、利用者が「済んだ」と記録したか（Case.funeralCompletedAt）だけで決める。
 * 記録が無ければ、手続きが0件でも「手続きなし」ではなく「これから」として出し、済んだら押してもらう
 */
function shownStates(stages: FlowStage[], funeralDoneAt: string | null) {
  const map = new Map(stages.map((s) => [s.id, stageState(s)]))
  const funeral = stages.find((s) => s.id === 'funeral')
  if (funeral) {
    map.set('funeral', funeralDoneAt ? 'COMPLETED' : funeral.state === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'NOT_STARTED')
  }
  return map
}

/*
  放棄しても「⑦〜⑨は不要」とは言えない。遺族年金・未支給年金・受取人が決まった死亡保険金は
  放棄した人も受け取れ、死亡保険金には相続税がかかることもある。また、ほかの相続人は先へ進む。
*/
const METHODS: { id: InheritanceMethod; label: string; note?: string }[] = [
  { id: 'SIMPLE_ACCEPTANCE', label: '単純承認' },
  { id: 'LIMITED_ACCEPTANCE', label: '限定承認', note: '相続人全員で申し立てる' },
  { id: 'RENUNCIATION', label: '相続放棄', note: '遺産の話し合いには加わらない' },
]

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩'

export function FlowScreen() {
  const { caseId, base } = useCaseBase()
  const overview = useCaseOverview(caseId)
  const tasks = useTasks(caseId)
  const { locked } = useLock(caseId)
  const updateCase = useUpdateCase(caseId)

  /*
    「いまここ」の段階を画面の縦の中央あたりに出す。
    開いたときはすぐに、この画面にいるままメニューの「手続きの流れ」をもう一度押したときは、なめらかに運ぶ
    （同じ画面への移動でも location.key は変わる）。動きを減らす設定の方には、アニメーションしない
  */
  const location = useLocation()
  const ready = Boolean(overview.data && tasks.data)
  const centered = useRef(false)
  useEffect(() => {
    if (!ready) return
    const here = document.querySelector('[data-flow-here]')
    if (!here) return
    const smooth = centered.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollBy({ top: offsetToCenter(here), behavior: smooth ? 'smooth' : 'auto' })
    centered.current = true
  }, [ready, location.key])

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
  const funeralDoneAt = overview.data.case.funeralCompletedAt ?? null
  const shown = shownStates(stages, funeralDoneAt)
  const stateOf = (s: FlowStage) => shown.get(s.id)!
  const withTasks = stages.filter((s) => stateOf(s) !== 'NO_TASKS')
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
        state={shown.get(id)!}
        here={hit.stage.id === here?.id}
        // やること・ホームと同じく、財産を動かす手続きは相続の方法が決まるまで名前も出さない
        tasks={tasks.data.items.filter((t) => t.stage === id && !(locked && t.assetDisposal))}
        hidden={tasks.data.items.filter((t) => t.stage === id && locked && t.assetDisposal).length}
        base={base}
        allTasks={tasks.data.items}
        funeral={
          id === 'funeral'
            ? {
                doneAt: funeralDoneAt,
                busy: updateCase.isPending,
                onChange: (done) =>
                  void updateCase
                    .mutateAsync({
                      expectedVersion: overview.data!.case.basicInfoVersion,
                      funeralCompletedAt: done ? new Date().toISOString() : null,
                    })
                    .catch(() => {}),
              }
            : undefined
        }
      />
    )
  }

  return (
    <Page narrow>
      <PageHeader
        title="手続きの流れ"
        description="相続の手続きは、おおむね上から順に進みます。段階を押すと、その段階の手続きが見られます。"
      />

      {/* 故人の状況に答えていない間は、流れの前にお願いする。答えで、あてはまる手続きが絞られる */}
      {!overview.data.case.profile?.answeredAt && (
        <Notice
          tone="info"
          title="いくつか質問に答えると、必要な手続きをもれなく洗い出せます"
          action={<LinkButton to={`${base}/setup`} size="sm">質問に答える（1分ほど）</LinkButton>}
        >
          年金を受け取っていたか、家や土地があるかなどで、必要な手続きが変わります。いまは、あてはまる可能性があるものをすべて並べています。
        </Notice>
      )}

      <ol className="flex flex-col items-stretch">
        <li>{node('immediate')}</li>
        <Arrow />
        <li>{node('funeral')}</li>
        <Arrow />
        {/* 枠線の色（rd-border）では地の色とほぼ見分けがつかない。まとまりと分かる濃さと太さにする */}
        <li className="rounded-lg border-2 border-dashed border-rd-text-3/55 p-3">
          {/* 下の段階に付く「いまここ」（枠の上へ12pxはみ出す）と重ならない間を空ける */}
          <p className="mb-4 text-[0.86rem] font-bold text-rd-text-2">並行して進める</p>
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
          {/* スマホでは3つが縦に並び、順に進む段階に見えてしまう。どれか1つを選ぶものだと言葉で示す */}
          <p className="mb-2 text-center text-[0.86rem] font-bold text-rd-text-2">次のどれかを選びます</p>
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
          {/* 数行にわたるので、狭い画面では中央ぞろえにしない（行頭がそろわず読みにくい） */}
          <p className="mt-2 text-[0.82rem] text-rd-text-2 sm:text-center">
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
    </Page>
  )
}

/**
 * 「いまここ」を、見えている範囲の縦の中央に運ぶためのスクロール量。
 * 見えている範囲は、狭い画面の固定ヘッダーの下から、下に開いた相談の窓（スマホ）の上まで。
 * 画面全体の中央にすると、窓が開いているときに窓の下に隠れてしまう。
 * 範囲に収まらないほど高いときは、上端をそろえて見出しから見せる
 */
function offsetToCenter(el: Element): number {
  const header = document.querySelector('header.sticky')?.getBoundingClientRect()
  const top = header && header.height > 0 ? header.bottom : 0
  const dock = document.querySelector('aside[aria-label="AIに相談"]')?.getBoundingClientRect()
  // 下から出ている窓（横幅いっぱいで、画面の途中から始まる）だけを差し引く。横に出ている窓は縦を覆わない
  const bottom = dock && dock.top > 0 && dock.width >= window.innerWidth - 1 ? dock.top : window.innerHeight
  const r = el.getBoundingClientRect()
  if (r.height > bottom - top - 16) return r.top - (top + 8)
  return r.top + r.height / 2 - (top + bottom) / 2
}

function stageName(s: FlowStage) {
  return FLOW_STAGE_WORD[s.id] ?? s.label.replace(/（.*?）/, '')
}

function StageNode({
  stage,
  no,
  state,
  here,
  tasks,
  hidden,
  base,
  allTasks,
  funeral,
}: {
  stage: FlowStage
  no: number
  state: StageState
  here: boolean
  tasks: Task[]
  hidden: number
  base: string
  /** 期限の無い下準備に「早めに」を出すため（相続の方法を決める期限を探す） */
  allTasks: Task[]
  /** 葬儀・火葬の段階だけ：済んだかを利用者が記録する */
  funeral?: { doneAt: string | null; busy: boolean; onChange: (done: boolean) => void }
}) {
  // 押すまでは「いまの段階だけ開く」に従う。「いまここ」が移れば開く段階も移る
  const [toggled, setToggled] = useState<boolean | null>(null)
  // 葬儀・火葬は押すと「済み」が切り替わるので、手続きがあれば一覧は開閉させずに出しておく
  const open = funeral ? true : (toggled ?? here)
  const meta = STAGE_META[stage.id]
  const g = GROUP[meta?.group ?? 'after']
  const st = STATE[state]
  const hasTasks = tasks.length + hidden > 0
  // 押せる段階（手続きがある段階と、葬儀・火葬）
  const pressable = funeral ? !funeral.busy : hasTasks
  const nearest = nearestDue(tasks, allTasks)

  return (
    <div
      /*
        済んだ段階を薄く（opacity）すると、色付きの地の上の補足の文字が読みにくくなる。状態は記号と言葉で出しているので薄くしない。
        キーボードで見出しを選んだときの枠は、見出しのボタンではなく段階の枠全体に引く。
        ボタンだけを囲むと、開いた一覧との境目に線が出て、1つの枠が2つに割れて見える
      */
      className={`relative rounded-lg border ${g.bg} ${here ? 'border-rd-primary ring-2 ring-rd-primary' : g.line} ${pressable ? 'group' : ''} has-[>button:focus-visible]:outline-3 has-[>button:focus-visible]:outline-offset-2 has-[>button:focus-visible]:outline-rd-primary`}
      data-flow-here={here ? '' : undefined}
    >
      {/*
        押せる段階は、指を載せると枠全体（開いた手続きの一覧も含む）を少し明るくして、押せることを伝える。
        見出しのボタンだけを明るくすると、開いた一覧の周りが明るくならず、枠の途中で色が切れて見える。
        文字の下に敷くため、中身（ボタン・一覧）は relative にしてこの層より上に描く
      */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] bg-white/50 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
      />
      {here && (
        <span className="absolute -top-3 left-3 rounded-full bg-rd-primary px-2.5 py-0.5 text-[0.8rem] font-bold text-white shadow-sm">
          いまここ
        </span>
      )}
      {/*
        葬儀・火葬は、枠そのものを押して「これから」と「済み」を切り替える（利用者が記録する段階）。
        ほかの段階は、押すと含まれる手続きの一覧が開く
      */}
      <button
        type="button"
        // 使い方の案内は、段階の見出しだけを指す（開いた一覧まで含めると縦に長く、説明を置く場所が無くなる）
        data-tour={here ? 'flow-here' : undefined}
        {...(funeral
          ? {
              onClick: () => funeral.onChange(!funeral.doneAt),
              disabled: funeral.busy,
              'aria-pressed': Boolean(funeral.doneAt),
            }
          : {
              onClick: () => setToggled(!open),
              disabled: !hasTasks,
              'aria-expanded': hasTasks ? open : undefined,
            })}
        className={`relative flex w-full flex-col items-center gap-0.5 rounded-[inherit] px-4 pt-3.5 pb-2.5 text-center enabled:cursor-pointer focus-visible:outline-none ${
          funeral ? 'disabled:cursor-wait' : ''
        }`}
      >
        <span className={`font-bold leading-snug ${g.fg}`}>
          {CIRCLED[no]} {stageName(stage)}
        </span>
        {meta && <span className="text-[0.86rem] text-rd-text-2">{meta.hint}</span>}
        <span className={`mt-1 flex items-center gap-1 text-[0.8rem] font-bold whitespace-nowrap ${st.fg}`}>
          <Icon name={st.icon} size={13} strokeWidth={2.4} />
          {st.word}
          {funeral?.doneAt && (
            <span className="font-normal text-rd-text-2">（{formatDate(funeral.doneAt)}に記録）</span>
          )}
          {hasTasks && (
            <span className="font-normal text-rd-text-2">
              （{stage.totalTasks}件中{stage.completedTasks}件）
            </span>
          )}
          {hasTasks && !funeral && (
            <Icon
              name="chevron-right"
              size={13}
              className={`text-rd-text-2 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
            />
          )}
        </span>
        {/* 閉じていても、この段階でいちばん近い期限が分かるように。開閉で高さが変わらないよう、開いていても出す */}
        {nearest && (
          <span className="mt-1.5">
            <DueChip due={nearest} onTint withIcon />
          </span>
        )}
      </button>
      {open && hasTasks && (
        <ul className="relative mx-2 mb-2 animate-rise-in overflow-hidden rounded-md border border-rd-border bg-rd-card text-center">
          {hidden > 0 && (
            <li className="border-b border-rd-border-2 px-3 py-2 text-[0.82rem] text-rd-text-2 last:border-b-0">
              ほか{hidden}件は、財産を動かす手続きのため、相続の方法が決まるまで表示しません
            </li>
          )}
          {tasks.map((t) => (
            <li key={t.id} className="border-b border-rd-border-2 last:border-b-0">
              {/*
                1行目に名前、2行目に残り日数。段階の見出しと同じく中央にそろえる。
                ○／✓ の印は名前の先頭に置き、名前と一緒に中央へ寄せる（左端に印の列を作ると、中央の文字と揃わない）
              */}
              <Link
                to={`${base}/tasks/${t.id}`}
                className="flex flex-col items-center px-3 py-2.5 text-center transition-colors duration-150 hover:bg-rd-bg"
              >
                {/*
                  済んだものは、印と「完了」の札で分かるので、取り消し線までは引かない。
                  中央ぞろえで語の途中の折り返し（「手続／きをする」）が目立つので、見出しと同じく文節で折り返す
                */}
                <span
                  className={`text-[0.9rem] leading-snug [word-break:auto-phrase] ${t.status === 'COMPLETED' ? 'text-rd-text-2' : 'text-rd-text'}`}
                >
                  <Icon
                    name={t.status === 'COMPLETED' ? 'check' : 'circle'}
                    size={14}
                    strokeWidth={2.4}
                    className={`mr-1.5 inline-block align-[-0.1em] ${t.status === 'COMPLETED' ? 'text-rd-success-text' : 'text-rd-text-3'}`}
                  />
                  {t.title}
                </span>
                {/* 細かい状態（未着手・準備中など）はここでは出さない。知りたいのは「いつまでか」「済んだか」だけ */}
                <TaskDueChip task={t} all={allTasks} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 札に出すもの。期限があればその期限、期限の無い下準備なら「早めに」、済んだものは「完了」 */
type Due = { deadline: DeadlineSummary } | { prep: true } | { done: true }

function taskDue(task: Task, all: Task[]): Due | null {
  if (task.status === 'COMPLETED') return null
  if (task.deadline) return { deadline: task.deadline }
  return prepDeadline(task, all) ? { prep: true } : null
}

/**
 * 段階の中でいちばん近い期限（済んでいない手続きのうち、Rule Engine の daysRemaining がいちばん小さいもの）。
 * 期限のある手続きが無く、下準備だけがあれば「早めに」。
 * 相続の方法が決まるまで名前を出さない手続き（財産を動かすもの）は、ここでも数えない
 */
function nearestDue(tasks: Task[], all: Task[]): Due | null {
  const dues = tasks.map((t) => taskDue(t, all)).filter((d): d is Due => d != null)
  const dated = dues.flatMap((d) => ('deadline' in d ? [d.deadline] : []))
  // 期限を算定できていない（daysRemaining が null）ものは、確定した期限より後ろに回す
  const remaining = (d: DeadlineSummary) => d.daysRemaining ?? Number.POSITIVE_INFINITY
  if (dated.length > 0) return { deadline: dated.reduce((a, b) => (remaining(b) < remaining(a) ? b : a)) }
  return dues.length > 0 ? { prep: true } : null
}

/** 期限の近さの色（やること・手続きの画面と同じ区切り：3日以内・過ぎたものは赤、7日以内は黄） */
const CHIP_TONE: Record<string, string> = {
  'text-rd-danger-text': 'bg-rd-danger-soft text-rd-danger-text',
  'text-rd-warning-text': 'bg-rd-warning-soft text-rd-warning-text',
}

/**
 * 残り日数の札。数字の幅がそろうよう tabular-nums にする。
 * onTint：段階の色付きの地の上に置くとき。灰色の地だと沈むので、急がないものは白地にする
 */
function DueChip({ due, onTint, withIcon }: { due: Due; onTint?: boolean; withIcon?: boolean }) {
  const neutral = onTint ? 'bg-rd-card text-rd-text-2' : 'bg-rd-shade text-rd-text-2'
  const tone =
    'deadline' in due
      ? (CHIP_TONE[dueTone(due.deadline)] ?? neutral)
      : 'done' in due
        ? 'bg-rd-success-soft text-rd-success-text'
        : CHIP_TONE['text-rd-warning-text']
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.8rem] font-bold leading-tight whitespace-nowrap tabular-nums ${tone}`}
    >
      {withIcon && <Icon name="clock" size={12} strokeWidth={2.4} />}
      {'deadline' in due ? dueWords(due.deadline) : 'done' in due ? '完了' : '早めに'}
    </span>
  )
}

/** 手続きの行の札。済んだものは「完了」、そうでなければ残り日数（無ければ出さない） */
function TaskDueChip({ task, all }: { task: Task; all: Task[] }) {
  const due: Due | null = task.status === 'COMPLETED' ? { done: true } : taskDue(task, all)
  return due ? (
    <span className="mt-1 inline-flex">
      <DueChip due={due} />
    </span>
  ) : null
}

function Arrow() {
  return (
    <li aria-hidden className="flex flex-col items-center py-1 text-rd-text-3">
      <span className="h-4 w-px bg-current" />
      <Icon name="chevron-right" size={14} className="-mt-1.5 rotate-90" />
    </li>
  )
}
