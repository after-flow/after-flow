/**
 * Rule Engine の代役（モック）。
 *
 * 期限の算定・状態遷移の可否は本来すべて Backend の Rule Engine が行う。
 * ここでは「同じ形の応答を返す」ことだけを目的にした簡易な計算を置く。
 * 本番コードからは参照しない。
 */
import type {
  DeadlineResource,
  FlowStageId,
  FlowStageResource,
  TaskBlockedReasonResource,
  TaskCommandResource,
  TaskResource,
  TaskStatusResource,
} from '@aftercare/public-contracts'

const DAY = 86_400_000

/*
  日付は「日本の暦日」として扱う。Backend（rule-engine.ts）と同じ数え方にそろえる。
  以前は UTC の日付を使っており、日本時間では朝9時まで前日になり、残り日数が1日ずれていた。
*/

/** 日本時間の今日（YYYY-MM-DD）。Backend の businessToday と同じく Asia/Tokyo で決める */
export function todayISO(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date())
}

type CalendarDate = { year: number; month: number; day: number }

function parse(iso: string): CalendarDate {
  const [year, month, day] = iso.split('-').map(Number)
  return { year, month, day }
}

function format(d: CalendarDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
}

function addDays(d: CalendarDate, days: number): CalendarDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days))
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() }
}

/** 暦日で days 日ずらす */
export function shift(base: string, days: number): string {
  return format(addDays(parse(base), days))
}

/**
 * 月・年の期間を民法143条どおりに足す（Backend の addLegalMonths と同じ）。
 * 90日・365日で近似すると、月の長さや閏年の分だけ期限がずれる。
 */
function addLegalMonths(start: CalendarDate, months: number, includeFirstDay: boolean): CalendarDate {
  const s = includeFirstDay ? start : addDays(start, 1)
  const total = s.year * 12 + (s.month - 1) + months
  const year = Math.floor(total / 12)
  const month = (total % 12) + 1
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  // 応当日があればその前日、無ければ（2月30日など）その月の末日に満了する
  return s.day <= lastDay ? addDays({ year, month, day: s.day }, -1) : { year, month, day: lastDay }
}

/** 期間。Backend の DeadlinePeriod と同じ形 */
export interface MockPeriod {
  unit: 'DAY' | 'MONTH' | 'YEAR'
  count: number
  /** 初日を含めて数えるか（死亡届の「知った日から7日以内」は含める） */
  includeFirstDay?: boolean
}

function addPeriod(start: string, period: MockPeriod): string {
  const s = parse(start)
  if (period.unit === 'DAY') return format(addDays(s, period.includeFirstDay ? period.count - 1 : period.count))
  const months = period.unit === 'YEAR' ? period.count * 12 : period.count
  return format(addLegalMonths(s, months, period.includeFirstDay ?? false))
}

function daysFromToday(iso: string): number {
  const due = parse(iso)
  const now = parse(todayISO())
  return Math.round((Date.UTC(due.year, due.month - 1, due.day) - Date.UTC(now.year, now.month - 1, now.day)) / DAY)
}

/** Backend の severityOf と同じ区切り（3日以内は URGENT、14日以内は SOON） */
function severityOf(remaining: number): DeadlineResource['severity'] {
  if (remaining < 0) return 'OVERDUE'
  if (remaining <= 3) return 'URGENT'
  if (remaining <= 14) return 'SOON'
  return 'NORMAL'
}

/** 期限が算定できている場合の DeadlineResource を組み立てる。 */
export function makeDeadline(args: {
  id: string
  taskId?: string | null
  label: string
  startDate: string
  period: MockPeriod
  basisLabel: string
  ruleId: string
  critical?: boolean
  extendable?: boolean
}): DeadlineResource {
  const dueDate = addPeriod(args.startDate, args.period)
  const remaining = daysFromToday(dueDate)
  return {
    id: args.id,
    taskId: args.taskId ?? null,
    label: args.label,
    basisLabel: args.basisLabel,
    startDate: args.startDate,
    dueDate,
    daysRemaining: remaining,
    severity: severityOf(remaining),
    confirmation: 'CONFIRMED',
    unresolvedReason: null,
    jurisdiction: '日本',
    timezone: 'Asia/Tokyo',
    ruleId: args.ruleId,
    ruleVersion: '1',
    sourceUrl: null,
    sourceCheckedAt: null,
    extendable: args.extendable ?? false,
    critical: args.critical ?? false,
  }
}

/** 起算日が無い・業務レビュー未了など、期限を算定できない場合の DeadlineResource。 */
export function unresolvedDeadline(args: {
  id: string
  taskId?: string | null
  label: string
  basisLabel: string
  ruleId: string
  reason: 'MISSING_BASIS_DATE' | 'RULE_UNCONFIRMED'
}): DeadlineResource {
  return {
    id: args.id,
    taskId: args.taskId ?? null,
    label: args.label,
    basisLabel: args.basisLabel,
    startDate: null,
    dueDate: null,
    daysRemaining: null,
    severity: null,
    confirmation: 'UNCONFIRMED',
    unresolvedReason: args.reason,
    jurisdiction: '日本',
    timezone: 'Asia/Tokyo',
    ruleId: args.ruleId,
    ruleVersion: '1',
    sourceUrl: null,
    sourceCheckedAt: null,
    extendable: null,
    critical: false,
  }
}

export const FLOW_STAGE_LABELS: { id: FlowStageId; label: string }[] = [
  // 死亡届（7日以内）は火葬許可と一緒に出すので、葬儀より前の「死亡直後」の段階に付ける
  { id: 'immediate', label: '死亡直後の対応（死亡届7日以内）' },
  { id: 'funeral', label: '葬儀・火葬' },
  { id: 'government', label: '役所・公的手続（目安14日以内）' },
  { id: 'contracts', label: '契約・生活の整理' },
  { id: 'investigation', label: '相続の調査' },
  { id: 'decision', label: '相続の方法の判断（3か月以内）' },
  { id: 'division', label: '遺産分割' },
  { id: 'transfer', label: '名義変更・受け取り' },
  { id: 'tax', label: '税務（準確定申告4か月・相続税10か月）' },
  { id: 'closing', label: '最終確認・ケースクローズ' },
]

export function computeFlowStages(tasks: TaskResource[]): FlowStageResource[] {
  return FLOW_STAGE_LABELS.map(({ id, label }) => {
    const inStage = tasks.filter((t) => t.stage === id)
    const done = inStage.filter((t) => t.status === 'COMPLETED').length
    return {
      id,
      label,
      totalTasks: inStage.length,
      completedTasks: done,
      state:
        inStage.length === 0
          ? 'NO_TASKS'
          : done === inStage.length
            ? 'COMPLETED'
            : done > 0 || inStage.some((t) => t.status !== 'NOT_STARTED')
              ? 'IN_PROGRESS'
              : 'NOT_STARTED',
    }
  })
}

/**
 * `allowedActions` / `blockedActions` を、いまの状態と付帯条件（財産処分・記録の要否）から組み立てる。
 * `escalate` は専門家引継ぎの提案経由でのみ生まれるため、ここでは出さない。
 */
export function taskActions(
  status: TaskStatusResource,
  opts: { assetDisposal: boolean; decided: boolean; evidenceRequired: boolean; hasEvidence: boolean },
): { allowed: TaskCommandResource[]; blocked: { action: TaskCommandResource; reason: TaskBlockedReasonResource }[] } {
  const FORWARD: Record<TaskStatusResource, TaskCommandResource[]> = {
    NOT_STARTED: ['start', 'requestDocuments', 'markReady'],
    COLLECTING_INFORMATION: ['requestDocuments', 'markReady'],
    WAITING_DOCUMENTS: ['markReady'],
    READY: ['reportSubmission'],
    SUBMITTED: ['awaitExternal'],
    WAITING_EXTERNAL: [],
    ACTION_REQUIRED: ['markReady'],
    COMPLETED: [],
    ESCALATED: [],
  }
  const CAN_COMPLETE: TaskStatusResource[] = ['READY', 'SUBMITTED', 'WAITING_EXTERNAL', 'ACTION_REQUIRED', 'NOT_STARTED', 'COLLECTING_INFORMATION']
  const CAN_FLAG: TaskStatusResource[] = ['NOT_STARTED', 'COLLECTING_INFORMATION', 'WAITING_DOCUMENTS', 'READY', 'SUBMITTED', 'WAITING_EXTERNAL']

  const allowed: TaskCommandResource[] = [...FORWARD[status]]
  const blocked: { action: TaskCommandResource; reason: TaskBlockedReasonResource }[] = []

  if (status === 'COMPLETED') {
    allowed.push('reopen')
  } else if (CAN_COMPLETE.includes(status)) {
    if (opts.assetDisposal && !opts.decided) {
      blocked.push({ action: 'complete', reason: 'INHERITANCE_DECISION_REQUIRED' })
    } else if (opts.evidenceRequired && !opts.hasEvidence) {
      blocked.push({ action: 'complete', reason: 'EVIDENCE_REQUIRED' })
    } else {
      allowed.push('complete')
    }
  } else {
    blocked.push({ action: 'complete', reason: 'INVALID_TRANSITION' })
  }

  if (CAN_FLAG.includes(status)) allowed.push('flagActionRequired')

  return { allowed, blocked }
}
