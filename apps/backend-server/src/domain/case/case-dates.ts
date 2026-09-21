import { RULE_TIMEZONE } from '../task/rule-engine.js'

/**
 * Case の死亡日・知った日の整合チェック（申し送り 11-1 の前提）。
 *
 * 「今日」は業務タイムゾーン（Asia/Tokyo）の暦日で決める。サーバー UTC の
 * まま比較すると、JST 深夜に入力した当日の死亡日が「未来」と判定される。
 * ISO 日付（YYYY-MM-DD）は文字列比較で大小が決まる。
 */

export type CaseDateIssueCode =
  | 'DATE_OF_DEATH_IN_FUTURE'
  | 'KNOWN_AT_BEFORE_DATE_OF_DEATH'
  | 'KNOWN_AT_IN_FUTURE'
  | 'DATE_OF_BIRTH_AFTER_DATE_OF_DEATH'

export interface CaseDateIssue {
  path: 'dateOfDeath' | 'knownAt' | 'dateOfBirth'
  code: CaseDateIssueCode
  message: string
}

export interface CaseDates {
  dateOfDeath: string
  knownAt: string | null
  dateOfBirth?: string | null
}

/** 業務タイムゾーンでの暦日（YYYY-MM-DD）。 */
export function businessToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: RULE_TIMEZONE }).format(now)
}

/**
 * 違反をすべて集めて返す（1 件も無ければ空配列）。
 *
 * 等号は許容する: dateOfDeath == today、knownAt == dateOfDeath、
 * knownAt == today、dateOfBirth == dateOfDeath はすべて有効。
 * dateOfBirth が null（未入力）のときは検査しない。
 */
export function findCaseDateIssues(dates: CaseDates, today: string): CaseDateIssue[] {
  const issues: CaseDateIssue[] = []
  if (dates.dateOfDeath > today) {
    issues.push({
      path: 'dateOfDeath',
      code: 'DATE_OF_DEATH_IN_FUTURE',
      message: '死亡日は未来の日付にできません。',
    })
  }
  if (dates.knownAt !== null) {
    if (dates.knownAt < dates.dateOfDeath) {
      issues.push({
        path: 'knownAt',
        code: 'KNOWN_AT_BEFORE_DATE_OF_DEATH',
        message: '相続の開始を知った日は死亡日より前にできません。',
      })
    } else if (dates.knownAt > today) {
      issues.push({
        path: 'knownAt',
        code: 'KNOWN_AT_IN_FUTURE',
        message: '相続の開始を知った日は未来の日付にできません。',
      })
    }
  }
  if (dates.dateOfBirth != null && dates.dateOfBirth > dates.dateOfDeath) {
    issues.push({
      path: 'dateOfBirth',
      code: 'DATE_OF_BIRTH_AFTER_DATE_OF_DEATH',
      message: '生年月日は死亡日より後にできません。',
    })
  }
  return issues
}
