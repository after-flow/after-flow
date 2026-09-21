import type { CaseStatus, ISODate, ISODateTime } from './resources.js'

/**
 * 新しい公開契約の Case。
 *
 * 既存の `Case` はモックのフロントが参照しているため変更しない。
 * 旧 DTO への変換は Web の公開クライアント境界で行う（#3 の対応表）。
 */

/**
 * この利用者がこの Case に対して行える操作。
 *
 * フロントは自前で権限を推測せず、ここに無い操作の導線を出さない。
 * 表示の都合で導線を出しても、Backend は同じ条件で再検証する。
 */
export type CaseAction = 'UPDATE_BASIC_INFO' | 'ADMINISTER'

export interface CaseResource {
  id: string
  deceasedName: string
  deceasedNameKana: string | null
  dateOfDeath: ISODate
  dateOfBirth: ISODate | null
  /**
   * 相続の開始を知った日。
   * 死亡日とは別の事実。不明な場合は null で、死亡日で補完しない。
   */
  knownAt: ISODate | null
  /** 申告された手続き担当者名。認証上の本人確認の根拠ではない。 */
  ownerName: string
  /** 申告された続柄。法的な相続人の認定ではない。 */
  relationshipToDeceased: string
  municipality: string | null
  /** Owner-managed pause of AI task proposals. null means unrestricted. */
  aiPlanningRestriction: { reason: string } | null
  status: CaseStatus
  /** 楽観ロックの版。更新時に expectedVersion として送り返す。 */
  version: number
  /** Case 全体の版。Context の鮮度判定に使う。 */
  caseVersion: number
  createdAt: ISODateTime
  updatedAt: ISODateTime
  allowedActions: CaseAction[]
}
