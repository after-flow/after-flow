import type { EntityBase } from '../shared/entity.js'

/**
 * 承認（仕様書 8 章）。
 *
 * 承認は提案の「ある版」と、その版の payload hash に結び付く。
 * 承認後に内容が変われば、その承認は対象を失う。
 */
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'

/** 承認の結果が業務状態へ反映されたか。承認受付と反映は別。 */
export type ApplicationStatus = 'NOT_APPLIED' | 'APPLIED' | 'FAILED'

export interface ApprovalEntity extends EntityBase {
  proposalId: string
  /** 承認の対象となる提案の版。 */
  proposalVersion: number
  /** 承認の対象となる内容の hash。 */
  payloadHash: string
  status: ApprovalStatus
  applicationStatus: ApplicationStatus
  /** 反映できなかった理由。利用者に見せてよい範囲。 */
  applicationFailureReason: string | null
  decidedByUserId: string | null
  decidedAt: string | null
  decisionNote: string | null
  expiresAt: string
  /** 財産処分に相当する提案の承認。追加の確認を要する。 */
  assetDisposal: boolean
}

export function isApprovalOpen(approval: ApprovalEntity, now: number): boolean {
  return approval.status === 'PENDING' && Date.parse(approval.expiresAt) > now
}

/** 承認の対象が今も同じ内容かどうか。 */
export function matchesProposal(
  approval: ApprovalEntity,
  proposalVersion: number,
  payloadHash: string,
): boolean {
  return approval.proposalVersion === proposalVersion && approval.payloadHash === payloadHash
}
