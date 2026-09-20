import type { EntityBase } from '../shared/entity.js'

/**
 * 期限の起算日（仕様書 7・16 章）。
 *
 * 死亡日と「相続の開始を知った日」は別の事実。手続きによって
 * どちらを起算日にするかが違うため、ルール側で指定する。
 */
export type DeadlineBasis = 'DATE_OF_DEATH' | 'KNOWN_AT'

/**
 * 期限の確認状態。
 *
 * 業務レビューを経ていないルールから計算した値を、確定した期限として
 * 表示しない。未確認は日付を出さず、要確認として返す。
 */
export type DeadlineConfirmation = 'CONFIRMED' | 'UNCONFIRMED'

/** 期限を算定できない理由。 */
export type DeadlineUnresolvedReason =
  /** 起算日となる事実が未入力。 */
  | 'MISSING_BASIS_DATE'
  /** ルールが業務レビューを経ていない。 */
  | 'RULE_UNCONFIRMED'

export type DeadlineSeverity = 'NORMAL' | 'SOON' | 'URGENT' | 'OVERDUE'

export interface DeadlineEntity extends EntityBase {
  taskId: string | null
  label: string
  basis: DeadlineBasis
  /** 起算日。基準となる事実が未入力なら null。 */
  startDate: string | null
  /** 算定した期限。算定できなければ null。 */
  dueDate: string | null
  /** 根拠の説明。Rule Engine が生成した文字列をそのまま表示する。 */
  basisLabel: string
  /** 管轄。自治体ごとに異なる手続きを区別する。 */
  jurisdiction: string
  /** 計算に用いた時間帯。日付境界の解釈を固定する。 */
  timezone: string
  ruleId: string
  ruleVersion: string
  confirmation: DeadlineConfirmation
  unresolvedReason: DeadlineUnresolvedReason | null
  /** 根拠資料の参照。未確認のルールでは null。 */
  sourceUrl: string | null
  /** いつ時点で確認した内容か。 */
  sourceCheckedAt: string | null
  /** 延長の可否。未確認のルールでは false に倒さず null にする。 */
  extendable: boolean | null
  critical: boolean
}
