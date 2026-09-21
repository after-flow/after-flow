import type { EntityBase } from '../shared/entity.js'

/** Case（案件）。仕様書 7.1 の中核 Entity。 */
export type CaseStatus = 'ACTIVE' | 'CLOSED'

export interface CaseEntity extends EntityBase {
  deceasedName: string
  deceasedNameKana: string | null
  dateOfDeath: string
  dateOfBirth: string | null
  /**
   * 相続の開始を知った日。
   *
   * 死亡日とは別の事実として保持する。熟慮期間などの起算日は
   * 「知った日」を使う手続きがあり、不明なまま死亡日で補完すると
   * 期限を誤って早める。不明は null のままにする。
   */
  knownAt: string | null
  /** 申告された手続き担当者名。認証上の本人確認の根拠にはしない。 */
  ownerName: string
  /** 申告された続柄。法的な相続人の認定ではない。 */
  relationshipToDeceased: string
  /** 手続き先の市区町村。番地は保持しない。 */
  municipality: string | null
  /** Human-controlled pause of AI planning; absent only on legacy records. */
  aiPlanningRestriction?: { reason: string } | null
  status: CaseStatus
  /**
   * Case 全体の版。
   *
   * Entity 自身の楽観ロック（version）とは別。Context に影響する変更で
   * 増やし、AI の提案が古い Context に基づいていないかの判定に使う。
   */
  caseVersion: number
}

/** Case 配下の変更から Case 全体の版を進める。 */
export function nextCaseVersion(current: number): number {
  return current + 1
}
