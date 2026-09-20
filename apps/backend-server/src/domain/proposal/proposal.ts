import type { EntityBase } from '../shared/entity.js'

/**
 * 提案（仕様書 7・8 章）。
 *
 * 誰が出した提案であっても、正式な業務状態にするには同じ経路を通る。
 * AI が承認の要否や本人の意思を決めることはない。
 */
export type ProposalKind =
  | 'TASK_PROPOSAL'
  | 'ASSET_PROPOSAL'
  | 'LIABILITY_PROPOSAL'
  | 'CONTRACT_PROPOSAL'
  | 'PERSON_PROPOSAL'
  | 'DOCUMENT_REQUEST'
  | 'ESCALATION_PROPOSAL'
  | 'EVIDENCE_PROPOSAL'

export type ProposalSource = 'USER' | 'SYSTEM' | 'AI'

export type ProposalStatus =
  /** 提出された。まだ検証していない。 */
  | 'SUBMITTED'
  /** 検証を通った。承認を作れる。 */
  | 'VALIDATED'
  /** 人の承認を待っている。 */
  | 'AWAITING_APPROVAL'
  /** 承認され、業務状態へ反映された。 */
  | 'APPLIED'
  | 'REJECTED'
  /** 前提が変わり、この版のままでは適用できない。 */
  | 'STALE'
  | 'EXPIRED'

/** 提案の根拠。所属と版を適用時に再検証する。 */
export interface ProposalBasis {
  type: 'DOCUMENT' | 'TASK' | 'MESSAGE'
  id: string
  /** 根拠を参照した時点の版。後から変わっていれば再検証で弾く。 */
  version: number
  label: string
}

export interface ProposalEntity extends EntityBase {
  kind: ProposalKind
  status: ProposalStatus
  source: ProposalSource
  /** AI 由来の場合の実行 ID。利用者入力から偽装できない。 */
  agentRunId: string | null
  title: string
  summary: string
  /**
   * 提案の版。
   *
   * 内容を訂正したときは、既存の版を書き換えずに新しい版を作る。
   * 人が承認したのは、その人が見た版の内容である。
   */
  proposalVersion: number
  /** 適用する内容。承認後もこの版の内容は変えない。 */
  payload: Record<string, unknown>
  /** payload の hash。承認はこの値に結び付く。 */
  payloadHash: string
  basis: ProposalBasis[]
  /** 提案を作った時点の Case 版。適用時に鮮度を再検証する。 */
  caseVersionAtProposal: number
  /** 財産処分・現金化に相当する提案。追加の確認を要する。 */
  assetDisposal: boolean
  /** 直前の版。訂正の履歴を辿れるようにする。 */
  supersedesProposalVersion: number | null
}

const APPROVABLE: ProposalStatus[] = ['VALIDATED', 'AWAITING_APPROVAL']

export function canRequestApproval(status: ProposalStatus): boolean {
  return APPROVABLE.includes(status)
}

/** 適用してよい状態か。承認応答だけでは適用済みにしない。 */
export function canApply(status: ProposalStatus): boolean {
  return status === 'AWAITING_APPROVAL'
}

export function isProposalFinal(status: ProposalStatus): boolean {
  return status === 'APPLIED' || status === 'REJECTED' || status === 'EXPIRED'
}
