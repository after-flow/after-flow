/**
 * after-flow 固有の小さな表示部品。
 * 期限・状態・AIの文章・放棄前ロックなど、どの画面でも同じ見た目で出したいもの。
 */
import type { ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import type {
  CaseOverviewResource,
  CaseProfileResource,
  CaseResource,
  DeadlineResource,
  TaskResource,
  TaskStatusResource,
} from '@aftercare/public-contracts'
import { useCaseOverview, useConsents } from '@/lib/api/queries'
import { Icon, type IconName } from '@/kit/Icon'
import { formatDate } from '@/lib/format'
import { TASK_STATUS_META, taskCategoryMeta } from '@/lib/labels'
import { Badge, Notice, type Tone } from './kit'
import { TASK_STATUS_WORD } from './words'

/** いま開いているケースのURLの起点 */
export function useCaseBase() {
  const { caseId = '' } = useParams()
  return { caseId, base: `/cases/${caseId}` }
}

/**
 * 故人の状況（`Case.profile`）。契約に無い（BE ユニット4 が `CaseResource.profile`
 * を追加するまで）ため、`CaseResource` の型には乗せず局所的な optional 読みにする。
 * マージ後に型が揃ったら `caseResource.profile` に置き換えて、この関数は消せる。
 */
export function caseProfileOf(caseResource: CaseResource): CaseProfileResource | undefined {
  return caseResource.profile
}

/* ---------- 放棄前ロック ---------- */

export type LockReason = 'undecided' | 'renunciation' | 'limited' | null
type InheritanceDecisionSummary = CaseOverviewResource['inheritanceDecision']

/**
 * 財産処分・現金化にあたる導線を閉じるかどうか。
 *
 * 開けるのは「ログインしている本人（`case.selfPersonId`）が単純承認を選んだ」と
 * 本人自身が確定した（`confirmed`）ときだけ。
 *  - 相続放棄を選んだ人が故人の財産を使ったり処分したりすると、放棄が認められなくなるおそれがある
 *    （民法921条。受理された後でも、財産を隠したり使ったりすれば同じ）
 *  - 限定承認では、財産の処分は裁判所の手続きに沿って行う。自分の判断で解約・換金するものではない
 *
 * `case.selfPersonId` が無い（本人が Person に紐付いていない）場合は、
 * 全員が単純承認で確定している場合に限って開ける。取得前・特定できない場合は安全側に倒して閉じる。
 */
export function useLock(caseId: string): {
  locked: boolean
  reason: LockReason
  decision?: InheritanceDecisionSummary
} {
  const { data } = useCaseOverview(caseId)
  if (!data) return { locked: true, reason: 'undecided' }
  const decision = data.inheritanceDecision
  if (decision.unknown) return { locked: true, reason: 'undecided', decision }

  const selfId = data.case.selfPersonId
  const self = selfId ? decision.perHeir.find((h) => h.personId === selfId) : undefined
  if (self) {
    if (self.confirmed && self.method === 'SIMPLE_ACCEPTANCE') return { locked: false, reason: null, decision }
    if (self.confirmed && self.method === 'RENUNCIATION') return { locked: true, reason: 'renunciation', decision }
    if (self.confirmed && self.method === 'LIMITED_ACCEPTANCE') return { locked: true, reason: 'limited', decision }
    return { locked: true, reason: 'undecided', decision }
  }

  if (decision.decided && decision.perHeir.length > 0 && decision.perHeir.every((h) => h.method === 'SIMPLE_ACCEPTANCE')) {
    return { locked: false, reason: null, decision }
  }
  return { locked: true, reason: 'undecided', decision }
}

const LOCK_TEXT: Record<Exclude<LockReason, null>, { title: string; body: string; link: string }> = {
  undecided: {
    title: '故人の預金や財産には、まだ手をつけないでください。',
    body: '使ったり解約したりすると、相続放棄ができなくなるおそれがあります。',
    link: '相続の方法を決める',
  },
  renunciation: {
    title: '相続放棄を選んだ方は、故人の預金や財産に手をつけないでください。',
    body: '家庭裁判所で受理された後でも、財産を使ったり隠したりすると放棄が認められなくなるおそれがあります。',
    link: '相続の方法を見る',
  },
  limited: {
    title: '限定承認では、故人の財産を自分の判断で使ったり解約したりしないでください。',
    body: '財産の処分は家庭裁判所の手続きに沿って行います。進め方は弁護士・司法書士にご相談ください。',
    link: '相続の方法を見る',
  },
}

/**
 * 常時表示の警告。閉じるボタンは付けない。
 *
 * strip：ホーム用の1行。毎日見る画面で理由まで出し続けると読み飛ばされるようになるので、
 * 行動の指示（手をつけないで）と行き先だけを残す。理由は財産・契約や家族の画面で読める。
 * compact：期限を添えた短い形。full：理由まで出す形。
 */
export function LockNotice({ caseId, compact, strip }: { caseId: string; compact?: boolean; strip?: boolean }) {
  const { locked, reason, decision } = useLock(caseId)
  if (!locked || !reason) return null
  const t = LOCK_TEXT[reason]
  const deadline = decision?.deliberationDeadline
  if (strip) {
    return (
      // 文と行き先を1つの段落に流し込む。狭い画面でも折り返しが最小（おおむね2行）で済む
      <p
        role="alert"
        className="flex gap-2 rounded-lg border border-rd-danger-line bg-rd-danger-soft px-4 py-2 text-[0.94rem] leading-snug"
      >
        <Icon name="warning" size={17} className="mt-0.5 shrink-0 text-rd-danger-text" />
        <span className="min-w-0">
          <strong className="text-rd-danger-text">{t.title}</strong>{' '}
          <Link
            to={`/cases/${caseId}/family`}
            className="inline-flex items-center font-bold whitespace-nowrap text-rd-danger-text underline underline-offset-2"
          >
            {t.link}
            <Icon name="chevron-right" size={15} />
          </Link>
        </span>
      </p>
    )
  }
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-rd-danger-line bg-rd-danger-soft px-4 py-3"
    >
      <Icon name="warning" size={18} className="shrink-0 text-rd-danger-text" />
      <p className="min-w-[12rem] flex-1 text-[0.94rem] leading-relaxed">
        <strong className="text-rd-danger-text">{t.title}</strong>
        {!compact && <> {t.body}</>}
        {reason === 'undecided' && deadline?.dueDate && (
          <span className="ml-1 inline-block text-rd-text-2">
            （相続の方法を決める期限 {formatDate(deadline.dueDate, { weekday: true })}）
          </span>
        )}
      </p>
      <Link
        to={`/cases/${caseId}/family`}
        className="shrink-0 text-[0.9rem] font-bold text-rd-danger-text underline"
      >
        {t.link}
      </Link>
    </div>
  )
}

/* ---------- 外部AIへの提供の同意 ---------- */

/**
 * 外国にある第三者（AI事業者）へ情報を送ってよいか（個人情報保護法28条）。
 *
 * この同意は任意で、断っても手続きと期限の管理は使える、と同意画面で約束している。
 * 約束どおり、同意が無い間は書類の解析・AI相談・自律調査の入口を閉じる。
 * 版ずれの判定は BE の `availability.externalAi` に任せる（自己判定をやめる）。
 */
export function useAiConsent() {
  const { data, isLoading } = useConsents()
  return { allowed: data?.availability.externalAi ?? false, loading: isLoading }
}

/** 同意が無いときに、入口の代わりに出す説明 */
export function AiConsentNotice({ feature }: { feature: string }) {
  // 同意したあと、いまの画面に戻れるようにする
  const { pathname, search } = useLocation()
  return (
    <Notice
      tone="info"
      title={`${feature}は、外部のAI事業者への情報の提供に同意すると使えます`}
      action={
        <Link
          to="/consent"
          state={{ from: pathname + search }}
          className="inline-flex h-9 items-center rounded-md border border-rd-border bg-rd-card px-3 text-[0.9rem] font-bold hover:bg-rd-shade"
        >
          内容を見て同意する
        </Link>
      }
    >
      同意しなくても、手続きと期限の管理はそのまま使えます。
    </Notice>
  )
}

/* ---------- 手続きの状態 ---------- */

export type TaskGroup = 'todo' | 'waiting' | 'done'

/**
 * 利用者にとっての状態は3つで足りる。
 * 「自分がやること」「相手の返事を待つもの」「済んだもの」。
 */
export function taskGroup(status: TaskStatusResource): TaskGroup {
  if (status === 'COMPLETED') return 'done'
  if (status === 'SUBMITTED' || status === 'WAITING_EXTERNAL' || status === 'ESCALATED') return 'waiting'
  return 'todo'
}

const STATUS_TONE: Record<TaskStatusResource, Tone> = {
  NOT_STARTED: 'gray',
  COLLECTING_INFORMATION: 'blue',
  WAITING_DOCUMENTS: 'yellow',
  READY: 'green',
  SUBMITTED: 'blue',
  WAITING_EXTERNAL: 'gray',
  ACTION_REQUIRED: 'red',
  COMPLETED: 'green',
  ESCALATED: 'purple',
}

export function TaskStatusBadge({ status }: { status: TaskStatusResource }) {
  const meta = TASK_STATUS_META[status]
  return (
    <Badge tone={STATUS_TONE[status]} icon={meta.icon}>
      {TASK_STATUS_WORD[status]}
    </Badge>
  )
}

/** 「わからない」「未回答」であてはまる可能性ありとして残している手続きに添える印。 */
export function ConditionalBadge({ task }: { task: TaskResource }) {
  if (!task.conditional) return null
  return <Badge tone="gray">あてはまる場合</Badge>
}

/**
 * 「相続の方法を決める」の前に済ませたい下準備（戸籍の収集・財産の調査・遺言書の確認）。
 *
 * これらには法律上の期限が無いが、3か月以内に相続の方法を決めるための前提で、戸籍の取り寄せには数週間かかる。
 * 期限の順に並べるだけだと「期限なし」として一番後ろに回り、判断に間に合わなくなるおそれがある。
 * そこで、相続の方法を決める期限をこの手続きの「目安」として扱い、並び順と表示に使う。
 *
 * Backend が返す目安の期限（targetDate）を使う。無いとき（モック）だけ、判断の期限を代わりに使う。
 */
export function prepDeadline(task: TaskResource, all: TaskResource[]): DeadlineResource | undefined {
  if (task.deadline || task.status === 'COMPLETED') return undefined
  if (task.targetDate) return task.targetDate
  if (task.stage !== 'investigation') return undefined
  const decisionTask = all.find((t) => t.stage === 'decision' && t.status !== 'COMPLETED')
  return decisionTask?.deadline ?? undefined
}

/**
 * 期限が近い順。期限の無いもの・未確定のものは後ろ。
 * 下準備は、その判断の期限と同じ位置の「手前」に並べる（判断より先に手を付けるものなので）。
 */
export function byDeadlineIn(all: TaskResource[]) {
  const key = (t: TaskResource) => {
    if (t.deadline?.dueDate) return `${t.deadline.dueDate}1`
    const prep = prepDeadline(t, all)
    if (prep?.dueDate) return `${prep.dueDate}0`
    // 期限を確認中（dueDate が無い）ものは、期限なしより前・確定期限より後
    if (t.deadline && t.deadline.dueDate === null) return '9998'
    return '9999'
  }
  return (a: TaskResource, b: TaskResource) => key(a).localeCompare(key(b))
}

/** 行き先（役所・銀行…）を色と形で */
export function CategoryIcon({ category, size = 36 }: { category: string; size?: number }) {
  const meta = taskCategoryMeta(category)
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-md"
      style={{ width: size, height: size, background: meta.bg, color: meta.fg }}
    >
      <Icon name={meta.icon} size={Math.round(size * 0.52)} />
    </span>
  )
}

/* ---------- 期限 ---------- */

export function dueTone(d: DeadlineResource) {
  if (d.daysRemaining == null) return 'text-rd-text-3'
  if (d.severity === 'OVERDUE' || d.severity === 'URGENT' || d.daysRemaining <= 3) return 'text-rd-danger-text'
  if (d.severity === 'SOON' || d.daysRemaining <= 7) return 'text-rd-warning-text'
  return 'text-rd-text-2'
}

/** 残日数の文言。Rule Engine の daysRemaining をそのまま使い、再計算しない。 */
export function dueWords(d: DeadlineResource): string {
  if (d.daysRemaining == null) {
    if (d.unresolvedReason === 'MISSING_BASIS_DATE') return '起算日が未入力のため期限を出せません'
    return '期限を確認中です'
  }
  if (d.daysRemaining < 0) return `${Math.abs(d.daysRemaining)}日過ぎています`
  if (d.daysRemaining === 0) return '今日まで'
  return `あと${d.daysRemaining}日`
}

export function Due({
  deadline,
  done,
  withDate = true,
  prep,
}: {
  deadline?: DeadlineResource | null
  done?: boolean
  withDate?: boolean
  /** 期限の無い下準備のとき、目安にする「相続の方法を決める」の期限 */
  prep?: DeadlineResource
}) {
  if (!deadline && prep && !done)
    return (
      <span className="inline-flex flex-col items-end leading-tight whitespace-nowrap">
        <span className="text-[0.94rem] font-bold text-rd-warning-text">早めに</span>
        {withDate && prep.dueDate && (
          <span className="hidden text-[0.8rem] text-rd-text-3 sm:block">
            判断の期限 {formatDate(prep.dueDate, { weekday: true })}より前に
          </span>
        )}
      </span>
    )
  if (!deadline) return <span className="text-[0.9rem] text-rd-text-3">期限なし</span>
  if (deadline.dueDate == null) return <span className="text-[0.9rem] text-rd-text-3">期限：要確認</span>
  if (done)
    return <span className="text-[0.9rem] text-rd-text-3">{formatDate(deadline.dueDate)}</span>
  return (
    <span className="inline-flex flex-col items-end leading-tight whitespace-nowrap">
      <span className={`text-[0.94rem] font-bold ${dueTone(deadline)}`}>{dueWords(deadline)}</span>
      {/* 狭い画面では日付を省き、手続きの名前に幅を回す（日付は手続きの詳細で見られる） */}
      {withDate && (
        <span className="hidden text-[0.8rem] text-rd-text-3 sm:block">
          {formatDate(deadline.dueDate, { weekday: true })}まで
          {deadline.confirmation === 'UNCONFIRMED' && '（確認中の目安）'}
        </span>
      )}
    </span>
  )
}

/* ---------- AIが書いた文章 ---------- */

/**
 * AIが生成した文章は、アプリ自身の案内と見分けがつくように囲む。
 * 取り込んだ書類に紛れた「必ず承認してください」のような文が、
 * アプリの指示に見えてしまうのを防ぐため。
 */
export function AiQuote({
  children,
  label = 'AIが書いた文章',
}: {
  children: ReactNode
  label?: string
}) {
  return (
    <figure className="m-0 rounded-md border-l-[3px] border-rd-primary bg-rd-bg px-3.5 py-2.5">
      <figcaption className="mb-1 flex items-center gap-1 text-[0.82rem] font-bold text-rd-primary-text">
        <Icon name="pencil" size={13} />
        {label}
      </figcaption>
      <div className="text-[0.97rem] leading-relaxed whitespace-pre-wrap">{children}</div>
    </figure>
  )
}

/** 小さな見出し付きの項目（窓口・持ち物など） */
export function InfoBlock({
  icon,
  title,
  children,
}: {
  icon: IconName
  title: string
  children: ReactNode
}) {
  return (
    <div className="flex gap-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-rd-shade text-rd-text-2">
        <Icon name={icon} size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[0.86rem] font-bold text-rd-text-2">{title}</p>
        <div className="mt-0.5 text-[0.97rem] leading-relaxed">{children}</div>
      </div>
    </div>
  )
}
