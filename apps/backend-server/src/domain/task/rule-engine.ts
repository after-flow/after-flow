import type { DeadlineBasis, DeadlineSeverity, DeadlineUnresolvedReason } from './deadline.js'
import type { FlowStageId } from './task.js'

/**
 * 期限ルールの定義。
 *
 * 仕様書や旧モックの値をそのまま本番ルールにしない。業務レビューを
 * 経たものだけ `reviewed: true` とし、それ以外から確定した期限を作らない。
 */
export interface DeadlineRule {
  id: string
  version: string
  label: string
  basis: DeadlineBasis
  /** 起算日からの日数。月単位の規定は months を使う。 */
  offsetDays?: number
  offsetMonths?: number
  jurisdiction: string
  /** 業務レビュー済みか。false のルールから確定した期限を出さない。 */
  reviewed: boolean
  sourceUrl: string | null
  sourceCheckedAt: string | null
  extendable: boolean | null
  critical: boolean
}

/** Case 作成時に生成する手続きの定義。 */
export interface InitialProcedure {
  id: string
  title: string
  summary: string
  stage: FlowStageId
  category: string
  submitTo: string | null
  evidenceRequired: boolean
  assetDisposal: boolean
  requiredDocuments: { id: string; label: string }[]
  deadlineRuleId: string | null
}

export interface RuleCatalog {
  /** 業務レビュー未了の仮定義かどうか。 */
  placeholder: boolean
  deadlineRules: DeadlineRule[]
  initialProcedures: InitialProcedure[]
}

/** 計算に用いる時間帯。日付境界の解釈を固定する。 */
export const RULE_TIMEZONE = 'Asia/Tokyo'

export interface BasisDates {
  dateOfDeath: string | null
  knownAt: string | null
}

export interface ComputedDeadline {
  startDate: string | null
  dueDate: string | null
  basisLabel: string
  unresolvedReason: DeadlineUnresolvedReason | null
}

const BASIS_LABEL: Record<DeadlineBasis, string> = {
  DATE_OF_DEATH: '死亡日',
  KNOWN_AT: '相続の開始を知った日',
}

function parseDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  // 2 月 30 日のような存在しない日付を通さない。
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null
  }
  return { year, month, day }
}

function format(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * 日付の加算。
 *
 * 暦日の計算を UTC の日付部分だけで行う。実行環境の時間帯に依存すると、
 * 同じ入力でも開発機と本番で 1 日ずれる。
 */
function addDays(date: { year: number; month: number; day: number }, days: number) {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

/**
 * 月の加算。
 *
 * 応当日が存在しない場合はその月の末日にする（1/31 の 1 か月後は 2 月末）。
 * 繰り上げて翌月にすると、期限が実際より後になる。
 */
function addMonths(date: { year: number; month: number; day: number }, months: number) {
  const totalMonths = date.year * 12 + (date.month - 1) + months
  const year = Math.floor(totalMonths / 12)
  const month = (totalMonths % 12) + 1
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { year, month, day: Math.min(date.day, lastDay) }
}

/**
 * 期限を算定する。
 *
 * 未レビューのルールと、起算日が未入力の場合は日付を出さない。
 * 推測した日付を返すと、画面はそれを確定した期限として表示する。
 */
export function computeDeadline(rule: DeadlineRule, dates: BasisDates): ComputedDeadline {
  const basisValue = rule.basis === 'DATE_OF_DEATH' ? dates.dateOfDeath : dates.knownAt
  const offsetLabel =
    rule.offsetMonths !== undefined ? `${rule.offsetMonths}か月` : `${rule.offsetDays ?? 0}日`
  const basisLabel = `${BASIS_LABEL[rule.basis]} + ${offsetLabel}`

  if (!rule.reviewed) {
    // 未レビューのルールから確定した期限を作らない。
    return { startDate: basisValue, dueDate: null, basisLabel, unresolvedReason: 'RULE_UNCONFIRMED' }
  }
  if (!basisValue) {
    return { startDate: null, dueDate: null, basisLabel, unresolvedReason: 'MISSING_BASIS_DATE' }
  }

  const start = parseDate(basisValue)
  if (!start) {
    return { startDate: null, dueDate: null, basisLabel, unresolvedReason: 'MISSING_BASIS_DATE' }
  }

  const due =
    rule.offsetMonths !== undefined
      ? addMonths(start, rule.offsetMonths)
      : addDays(start, rule.offsetDays ?? 0)

  return {
    startDate: basisValue,
    dueDate: format(due.year, due.month, due.day),
    basisLabel,
    unresolvedReason: null,
  }
}

/**
 * 残日数と重大度。
 *
 * 期限が算定できていない場合は残日数も出さない。0 日を返すと
 * 画面は「今日が期限」と表示する。
 */
export function daysRemaining(dueDate: string | null, today: string): number | null {
  if (!dueDate) return null
  const due = parseDate(dueDate)
  const now = parseDate(today)
  if (!due || !now) return null
  const dueMs = Date.UTC(due.year, due.month - 1, due.day)
  const nowMs = Date.UTC(now.year, now.month - 1, now.day)
  return Math.round((dueMs - nowMs) / 86_400_000)
}

export function severityOf(remaining: number | null): DeadlineSeverity | null {
  if (remaining === null) return null
  if (remaining < 0) return 'OVERDUE'
  if (remaining <= 3) return 'URGENT'
  if (remaining <= 14) return 'SOON'
  return 'NORMAL'
}
