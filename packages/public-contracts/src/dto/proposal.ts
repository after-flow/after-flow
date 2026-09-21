import type { ISODateTime } from './resources.js'

/**
 * 新しい公開契約の提案・承認・本人の意思。
 *
 * 既存の `Approval` はモックのフロントが参照しているため変更しない。
 * 旧 DTO への変換は Web の公開クライアント境界で行う（#3 の対応表）。
 */

export type ProposalKindResource =
  | 'TASK_PROPOSAL'
  | 'ASSET_PROPOSAL'
  | 'LIABILITY_PROPOSAL'
  | 'CONTRACT_PROPOSAL'
  | 'PERSON_PROPOSAL'
  | 'DOCUMENT_REQUEST'
  | 'ESCALATION_PROPOSAL'
  | 'EVIDENCE_PROPOSAL'

export type ProposalStatusResource =
  | 'SUBMITTED'
  | 'VALIDATED'
  | 'AWAITING_APPROVAL'
  | 'APPLIED'
  | 'REJECTED'
  /** 前提が変わり、この版のままでは反映できない。 */
  | 'STALE'
  | 'EXPIRED'

export type ApprovalStatusResource = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'

/**
 * 承認の結果が業務状態へ反映されたか。
 * 承認を受け付けただけで「反映済み」とは表示しない。
 */
export type ApplicationStatusResource = 'NOT_APPLIED' | 'APPLIED' | 'FAILED'

export interface ProposalBasisResource {
  type: 'DOCUMENT' | 'TASK' | 'MESSAGE'
  id: string
  /** 根拠を参照した時点の版。反映時に再検証する。 */
  version: number
  label: string
}

export interface ProposalResource {
  id: string
  caseId: string
  kind: ProposalKindResource
  status: ProposalStatusResource
  source: 'USER' | 'SYSTEM' | 'AI'
  agentRunId: string | null
  title: string
  summary: string
  /** 提案の版。訂正すると増える。承認はこの版に結び付く。 */
  proposalVersion: number
  payload: Record<string, unknown>
  /** 内容のhash。承認要求で指定し、見た内容と一致することを確かめる。 */
  payloadHash: string
  basis: ProposalBasisResource[]
  caseVersionAtProposal: number
  assetDisposal: boolean
  supersedesProposalVersion: number | null
  version: number
  createdAt: ISODateTime
  updatedAt: ISODateTime
}

export interface ApprovalResource {
  id: string
  caseId: string
  proposalId: string
  proposalVersion: number
  payloadHash: string
  status: ApprovalStatusResource
  applicationStatus: ApplicationStatusResource
  applicationFailureReason: string | null
  decidedByUserId: string | null
  decidedAt: ISODateTime | null
  decisionNote: string | null
  expiresAt: ISODateTime
  assetDisposal: boolean
  version: number
  createdAt: ISODateTime
  updatedAt: ISODateTime
}

/** 状態とは独立した、提案の指定版の不変内容。 */
export interface ProposalVersionResource extends Omit<ProposalResource,
  'id' | 'status' | 'version' | 'createdAt' | 'updatedAt'> {
  proposalId: string
  recordedAt: ISODateTime
}

export type InheritanceMethodResource = 'SIMPLE_ACCEPTANCE' | 'LIMITED_ACCEPTANCE' | 'RENUNCIATION'

/** 下書き、本人以外による報告、本人による確定を区別する。 */
export type DecisionStateResource = 'DRAFT' | 'REPORTED' | 'CONFIRMED'

export interface InheritanceDecisionResource {
  personId: string
  method: InheritanceMethodResource | null
  state: DecisionStateResource
  /** 本人が確定したか。制限の解除はこれだけを根拠にする。 */
  confirmed: boolean
  reportedByUserId: string | null
  confirmedByUserId: string | null
  confirmedAt: ISODateTime | null
  note: string | null
  version: number
  updatedAt: ISODateTime
}
