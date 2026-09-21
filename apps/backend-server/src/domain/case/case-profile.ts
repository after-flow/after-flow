/**
 * Case.profile（申し送り 3-1 の出し分け条件）。
 *
 * 未回答の項目を欠落のまま扱うと、手続きの条件判定（`domain/task/procedure-conditions.ts`）
 * が毎回 `undefined` 分岐を持つことになる。保存形は未回答を `UNKNOWN` に正規化し、
 * 条件 DSL 側は常に確定した文字列だけを見ればよいようにする。
 */

export type HealthInsuranceKind = 'NATIONAL' | 'EMPLOYEE' | 'LATE_ELDERLY' | 'UNKNOWN'
export type PensionKind = 'EMPLOYEES' | 'NATIONAL_ONLY' | 'NONE' | 'UNKNOWN'
export type OccupationKind = 'EMPLOYEE' | 'SELF_EMPLOYED' | 'NONE' | 'UNKNOWN'
export type YesNoUnknown = 'YES' | 'NO' | 'UNKNOWN'

/** 保存形。未回答の項目は UNKNOWN に正規化して持つ。 */
export interface CaseProfile {
  healthInsurance: HealthInsuranceKind
  pension: PensionKind
  occupation: OccupationKind
  realEstate: YesNoUnknown
  car: YesNoUnknown
  mortgage: YesNoUnknown
  answeredAt: string
}

export const PROFILE_FIELDS = ['healthInsurance', 'pension', 'occupation', 'realEstate', 'car', 'mortgage'] as const
export type ProfileField = (typeof PROFILE_FIELDS)[number]

/** カタログ検証と Zod の両方がこれを参照する、値の唯一の出所。 */
export const PROFILE_VALUES = {
  healthInsurance: ['NATIONAL', 'EMPLOYEE', 'LATE_ELDERLY', 'UNKNOWN'],
  pension: ['EMPLOYEES', 'NATIONAL_ONLY', 'NONE', 'UNKNOWN'],
  occupation: ['EMPLOYEE', 'SELF_EMPLOYED', 'NONE', 'UNKNOWN'],
  realEstate: ['YES', 'NO', 'UNKNOWN'],
  car: ['YES', 'NO', 'UNKNOWN'],
  mortgage: ['YES', 'NO', 'UNKNOWN'],
} as const satisfies Record<ProfileField, readonly string[]>

export type ProfileInput = Partial<Omit<CaseProfile, 'answeredAt'>> & { answeredAt: string }

/** API 入力（各項目 optional）→ 保存形。省略は UNKNOWN。 */
export function normalizeProfile(input: ProfileInput): CaseProfile {
  return {
    healthInsurance: input.healthInsurance ?? 'UNKNOWN',
    pension: input.pension ?? 'UNKNOWN',
    occupation: input.occupation ?? 'UNKNOWN',
    realEstate: input.realEstate ?? 'UNKNOWN',
    car: input.car ?? 'UNKNOWN',
    mortgage: input.mortgage ?? 'UNKNOWN',
    answeredAt: input.answeredAt,
  }
}

/** 条件評価に渡す Case の事実。Task/Deadline の算定に必要なものだけ。 */
export interface ProcedureFacts {
  dateOfDeath: string
  knownAt: string | null
  dateOfBirth: string | null
  /** null = 未回答（全項目 UNKNOWN と同じに評価） */
  profile: CaseProfile | null
}

function parseIsoDate(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) }
}

/** 死亡時の満年齢。生年月日が無い、または死亡日より後なら null。 */
export function ageAtDeath(dateOfBirth: string | null, dateOfDeath: string): number | null {
  if (!dateOfBirth) return null
  const birth = parseIsoDate(dateOfBirth)
  const death = parseIsoDate(dateOfDeath)
  if (!birth || !death) return null
  if (dateOfBirth > dateOfDeath) return null
  let age = death.y - birth.y
  if (death.m < birth.m || (death.m === birth.m && death.d < birth.d)) age -= 1
  return age
}
