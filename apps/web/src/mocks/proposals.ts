import type { ApprovalResource, ProposalKindResource, ProposalResource } from '@aftercare/public-contracts'

/**
 * Proposal と、それに紐づく PENDING の Approval を1組つくる（モック専用）。
 * 実際の Backend は Proposal 確定後に別要求（POST .../approval-requests）で Approval を作るが、
 * フィクスチャでは「確認待ち」の状態から始めたいので、2つをまとめて作る。
 */
export function makeProposalAndApproval(args: {
  id: string
  caseId: string
  kind: ProposalKindResource
  title: string
  summary: string
  payload: Record<string, unknown>
  basis: ProposalResource['basis']
  agentRunId?: string
  assetDisposal?: boolean
  createdAt?: string
}): { proposal: ProposalResource; approval: ApprovalResource } {
  const createdAt = args.createdAt ?? new Date().toISOString()
  const payloadHash = stableHash(args.payload)
  const proposal: ProposalResource = {
    id: args.id,
    caseId: args.caseId,
    kind: args.kind,
    status: 'AWAITING_APPROVAL',
    source: args.agentRunId ? 'AI' : 'SYSTEM',
    agentRunId: args.agentRunId ?? null,
    title: args.title,
    summary: args.summary,
    proposalVersion: 1,
    payload: args.payload,
    payloadHash,
    basis: args.basis,
    caseVersionAtProposal: 1,
    assetDisposal: args.assetDisposal ?? false,
    supersedesProposalVersion: null,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  }
  const approval: ApprovalResource = {
    id: `apr_${args.id}`,
    caseId: args.caseId,
    proposalId: proposal.id,
    proposalVersion: proposal.proposalVersion,
    payloadHash: proposal.payloadHash,
    status: 'PENDING',
    applicationStatus: 'NOT_APPLIED',
    applicationFailureReason: null,
    decidedByUserId: null,
    decidedAt: null,
    decisionNote: null,
    expiresAt: new Date(Date.parse(createdAt) + 30 * 86_400_000).toISOString(),
    assetDisposal: proposal.assetDisposal,
    sourceDocumentId: args.basis.find((item) => item.type === 'DOCUMENT')?.id ?? null,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  }
  return { proposal, approval }
}

/** 実物の sha256/内容ハッシュではなく、内容の見分けがつけば十分な安定ハッシュ（モック専用）。 */
export function stableHash(value: unknown): string {
  const s = JSON.stringify(value)
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return `h_${(h >>> 0).toString(16)}`
}
