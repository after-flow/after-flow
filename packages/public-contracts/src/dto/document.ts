import type { ISODateTime } from './resources.js'
import type { ProposalResource, ApprovalResource } from './proposal.js'
import type { AgentRunResource } from './agent.js'

/**
 * 新しい公開契約の書類。
 *
 * 既存の `CaseDocument` はモックのフロントが参照しているため変更しない。
 * 旧 DTO への変換は Web の公開クライアント境界で行う（#3 の対応表）。
 */

/** 原本の保存状態。保存完了と解析受付は別の状態として扱う。 */
export type DocumentStorageStateResource = 'UPLOADING' | 'STORED' | 'FAILED'

/**
 * 検査の状態。
 *
 * 未検査（PENDING）を合格として表示しない。検査が終わっていることと
 * 合格していることも別に扱う。
 */
export type DocumentInspectionStatusResource =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'PASSED'
  | 'REJECTED'
  | 'FAILED'

export type DocumentAnalysisStateResource =
  | 'NOT_REQUESTED'
  | 'NOT_CONNECTED'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'

/** 解析を受け付けられない理由。画面はこれを見て導線を出し分ける。 */
export type AnalysisBlockedReasonResource =
  | 'INSPECTION_NOT_PASSED'
  | 'AI_NOT_CONNECTED'
  | 'CONSENT_REQUIRED'
  | 'ALREADY_IN_PROGRESS'

export type DocumentKindResource =
  | 'DEATH_CERTIFICATE'
  | 'FAMILY_REGISTER'
  | 'WILL'
  | 'CONTRACT'
  | 'BANK_STATEMENT'
  | 'INSURANCE_POLICY'
  | 'OTHER'

export interface DocumentInspectionFindingResource {
  kind: 'SENSITIVE_NUMBER' | 'UNSUPPORTED_CONTENT' | 'UNREADABLE'
  /** 利用者に見せる説明。検出した値そのものは含まない。 */
  message: string
  locationHint: string | null
}

export interface DocumentResource {
  id: string
  caseId: string
  fileName: string
  contentType: string
  sizeBytes: number
  /** 原本の内容ハッシュ。同じ内容の再送を見分けるために返す。 */
  sha256: string
  kind: DocumentKindResource
  kindSource: 'MANUAL' | 'AI'
  storageState: DocumentStorageStateResource
  inspection: {
    status: DocumentInspectionStatusResource
    /** 検査が終わっているか。合格とは別。 */
    completed: boolean
    findings: DocumentInspectionFindingResource[]
  }
  analysis: {
    state: DocumentAnalysisStateResource
    agentRunId: string | null
    /** 解析を依頼できるか。false のとき理由が入る。 */
    canRequest: boolean
    blockedReasons: AnalysisBlockedReasonResource[]
    run: Pick<AgentRunResource, 'id' | 'status' | 'waiting' | 'waitingFor' | 'failureReason' | 'version'> | null
  }
  /** 保存済みAI Proposalからの候補。OCR済み/正式反映済みを意味しない。 */
  extractionCandidates: Pick<ProposalResource, 'id' | 'proposalVersion' | 'kind' | 'title' | 'payload' | 'status' | 'basis'>[]
  proposalRefs: Pick<ProposalResource, 'id' | 'proposalVersion' | 'kind' | 'status' | 'source'>[]
  approvalRefs: Pick<ApprovalResource, 'id' | 'proposalId' | 'proposalVersion' | 'status' | 'applicationStatus'>[]
  evidenceRefs: { id: string; taskId: string; label: string; version: number }[]
  /** 通常の一覧からの除外。個人データの完全消去ではない。 */
  archived: boolean
  archivedAt: ISODateTime | null
  version: number
  createdAt: ISODateTime
  updatedAt: ISODateTime
}
