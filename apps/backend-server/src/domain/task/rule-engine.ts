import { errors } from '../../shared/app-error.js'
import type { DeadlineBasis, DeadlineFacts, DeadlineSeverity, DeadlineUnresolvedReason } from './deadline.js'
import type { FlowStageId } from './task.js'

export type DeadlinePeriodUnit = 'DAY' | 'MONTH' | 'YEAR'

export interface DeadlinePeriod {
  unit: DeadlinePeriodUnit
  /** 正の整数。 */
  count: number
  /** 初日を算入して数えるか（戸籍法43条1項）。既定は false = 民法140条の初日不算入。 */
  includeFirstDay: boolean
}

/** 期限の法的性質。placeholder カタログで reviewed:true にできるのは STATUTORY だけ。 */
export type DeadlineLegalNature = 'STATUTORY' | 'JURISDICTIONAL'

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
  period: DeadlinePeriod
  /**
   * 利用者が自分で数え直せる根拠文。
   * 例「亡くなった日の翌日から数えて14日以内」。機械生成しない。
   */
  basisLabel: string
  legalNature: DeadlineLegalNature
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
  /** 熟慮期間（申し送り3-4）に使うルール。null なら overview に deliberationDeadline を載せない。 */
  deliberationDeadlineRuleId: string | null
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

/**
 * `KNOWN_AT` の起算日が未入力のとき、死亡日で代わりに算定したことを示す付記。
 *
 * Case 作成・更新の両経路で `knownAt >= dateOfDeath` を強制している
 * （`domain/case/case-dates.ts` の `findCaseDateIssues`）ため、この代替は
 * 常に早い側（またはちょうど同じ）にしか外れない。実際の期限より遅く
 * 見せてしまうことはない。
 */
export const KNOWN_AT_FALLBACK_NOTE = '（相続の開始を知った日が未入力のため、亡くなった日から数えています）'

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

type CalendarDate = { year: number; month: number; day: number }

/**
 * 日付の加算。
 *
 * 暦日の計算を UTC の日付部分だけで行う。実行環境の時間帯に依存すると、
 * 同じ入力でも開発機と本番で 1 日ずれる。
 */
function addDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * 月・年単位の期間を民法143条どおりに加算する。
 *
 * 143条1項は暦に従って数え、2項は起算日に応当する日の前日に満了する
 * （応当日が無ければその月の末日、2項ただし書）。この「応当日」は
 * 期間の起算日（初日不算入なら翌日）を指す。起算日が月の初日になる
 * ケース（例: 4/30 起算・初日不算入なら 5/1 が起算日）を「応当日と
 * 同じ日付を求めて末日にクランプする」やり方で扱うと、本来1項が
 * 適用されるべき満了日を最大で数日早めてしまう。ここでは常に
 * 「起算日の応当日の前日」を計算することで、起算日が月初かどうかに
 * 関わらず1項・2項を同じ式で扱う。
 */
function addLegalMonths(start: CalendarDate, months: number, includeFirstDay: boolean): CalendarDate {
  // s = 期間の起算日。初日不算入なら死亡日等の翌日、初日算入なら当日。
  const s = includeFirstDay ? start : addDays(start, 1)
  const totalMonths = s.year * 12 + (s.month - 1) + months
  const targetYear = Math.floor(totalMonths / 12)
  const targetMonth = (totalMonths % 12) + 1
  const lastDay = daysInMonth(targetYear, targetMonth)
  if (s.day <= lastDay) {
    // 応当日が対象月に存在する。その前日に満了する。
    return addDays({ year: targetYear, month: targetMonth, day: s.day }, -1)
  }
  // 応当日が存在しない（例: 2月30日）。対象月の末日に満了する。
  return { year: targetYear, month: targetMonth, day: lastDay }
}

function addPeriod(start: CalendarDate, period: DeadlinePeriod): CalendarDate {
  if (period.unit === 'DAY') {
    return period.includeFirstDay ? addDays(start, period.count - 1) : addDays(start, period.count)
  }
  const months = period.unit === 'YEAR' ? period.count * 12 : period.count
  return addLegalMonths(start, months, period.includeFirstDay)
}

/**
 * 期限を算定する。
 *
 * 未レビューのルールと、起算日が未入力の場合は日付を出さない。
 * 推測した日付を確定した期限として表示させない。
 */
export function computeDeadline(rule: DeadlineRule, dates: BasisDates): ComputedDeadline {
  // KNOWN_AT のルールで「知った日」が未入力なら死亡日で代わりに数える。
  // 逆方向（DATE_OF_DEATH のルールで死亡日が未入力なとき知った日を使う）は行わない。
  const knownAtFallback = rule.basis === 'KNOWN_AT' && dates.knownAt === null && dates.dateOfDeath !== null
  const start = rule.basis === 'DATE_OF_DEATH' ? dates.dateOfDeath : (dates.knownAt ?? dates.dateOfDeath)
  const basisLabel = knownAtFallback ? `${rule.basisLabel}${KNOWN_AT_FALLBACK_NOTE}` : rule.basisLabel

  if (!rule.reviewed) {
    // 未レビューのルールから確定した期限を作らない。起算日の事実自体は返す。
    return { startDate: start, dueDate: null, basisLabel, unresolvedReason: 'RULE_UNCONFIRMED' }
  }
  if (!start) {
    return { startDate: null, dueDate: null, basisLabel, unresolvedReason: 'MISSING_BASIS_DATE' }
  }

  const parsed = parseDate(start)
  if (!parsed) {
    return { startDate: null, dueDate: null, basisLabel, unresolvedReason: 'MISSING_BASIS_DATE' }
  }
  if (!Number.isInteger(rule.period.count) || rule.period.count < 1) {
    // カタログ読込時にも拒否するため、通常はここへ到達しない。
    throw errors.internal({
      internal: { reason: 'invalid deadline period count', ruleId: rule.id, count: rule.period.count },
    })
  }

  const due = addPeriod(parsed, rule.period)
  return { startDate: start, dueDate: format(due.year, due.month, due.day), basisLabel, unresolvedReason: null }
}

/**
 * `DeadlineEntity` の永続項目のうち、算定結果から一意に決まる部分を組み立てる。
 *
 * `TaskService.createDeadline` と熟慮期間（`deliberationDeadlineOf`）の両方で使う。
 */
export function buildDeadlineFacts(
  rule: DeadlineRule,
  dates: BasisDates,
  ids: { id: string; taskId: string | null },
): DeadlineFacts {
  const computed = computeDeadline(rule, dates)
  return {
    id: ids.id,
    taskId: ids.taskId,
    label: rule.label,
    basis: rule.basis,
    startDate: computed.startDate,
    dueDate: computed.dueDate,
    basisLabel: computed.basisLabel,
    jurisdiction: rule.jurisdiction,
    timezone: RULE_TIMEZONE,
    ruleId: rule.id,
    ruleVersion: rule.version,
    // レビュー未了のルールから算定した値を確定扱いにしない。
    confirmation: rule.reviewed ? 'CONFIRMED' : 'UNCONFIRMED',
    unresolvedReason: computed.unresolvedReason,
    sourceUrl: rule.sourceUrl,
    sourceCheckedAt: rule.sourceCheckedAt,
    extendable: rule.extendable,
    critical: rule.critical,
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
