import { randomUUID } from 'node:crypto'
import type { ProposalVersionResource } from '@aftercare/public-contracts'
import type { AiProposalInput } from '@aftercare/internal-contracts'
import type { AgentRunEntity } from '../../domain/agent/agent-run.js'
import type { CaseLeaseEntity } from '../../domain/agent/case-lease.js'
import { isLeaseExpired } from '../../domain/agent/case-lease.js'
import { leaseLocation, assertLease } from '../agent/lease-service.js'
import { createPendingWait } from '../agent/wait-requests.js'
import type { CaseMember } from '../../domain/authorization/case-role.js'
import { roleAllows } from '../../domain/authorization/case-role.js'
import type { TenantMember } from '../authorization/case-access.js'
import type { CaseEntity } from '../../domain/case/case.js'
import type {
  ApplicationStatus,
  ApprovalEntity,
  ApprovalStatus,
} from '../../domain/proposal/approval.js'
import { isApprovalOpen, matchesProposal } from '../../domain/proposal/approval.js'
import type {
  ProposalBasis,
  ProposalEntity,
  ProposalKind,
  ProposalSource,
  ProposalStatus,
} from '../../domain/proposal/proposal.js'
import { canApply, canRequestApproval, isProposalFinal } from '../../domain/proposal/proposal.js'
import type { ProposalVersionEntity } from '../../domain/proposal/proposal-version.js'
import { collections } from '../../domain/shared/collections.js'
import type { EntityBase } from '../../domain/shared/entity.js'
import { errors } from '../../shared/app-error.js'
import { fingerprintOf } from '../../shared/fingerprint.js'
import type { AccessService } from '../authorization/case-access.js'
import type { CommandMeta } from '../case/case-service.js'
import type { AuthenticatedUser } from '../ports/identity.js'
import type { DocLocation, Page, ReadRepository, Tx, UnitOfWork } from '../ports/persistence.js'

/** 承認の有効期間。過ぎた承認では適用しない。 */
export const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 提案の種類ごとの適用処理。
 *
 * Entity ごとの反映は、その Entity を担当する Issue が登録する。
 * ここに無い種類は適用できず、理由を添えて拒否する。
 */
export interface ProposalApplier {
  kind: ProposalKind
  /** 提出・訂正時にも同じ型固有の検証を行う。承認後にpayloadを補正しない。 */
  validate?(payload: Record<string, unknown>): void
  /**
   * 承認後の再検証と反映。
   *
   * 同じ Transaction の中で呼ばれる。ここで外部 HTTP や Storage 操作を
   * 行わない。前提が変わっていれば例外を投げて適用を止める。
   */
  apply(tx: Tx, context: { caseId: string; proposal: ProposalEntity; userId: string }): Promise<void>
}

export interface SubmitProposalInput {
  kind: ProposalKind
  title: string
  summary: string
  payload: Record<string, unknown>
  basis?: ProposalBasis[]
  assetDisposal?: boolean
  source?: ProposalSource
  agentRunId?: string | null
}

export interface ProposalView {
  id: string
  caseId: string
  kind: ProposalKind
  status: ProposalStatus
  source: ProposalSource
  agentRunId: string | null
  title: string
  summary: string
  proposalVersion: number
  payload: Record<string, unknown>
  payloadHash: string
  basis: ProposalBasis[]
  caseVersionAtProposal: number
  assetDisposal: boolean
  supersedesProposalVersion: number | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface ApprovalView {
  id: string
  caseId: string
  proposalId: string
  proposalVersion: number
  payloadHash: string
  status: ApprovalStatus
  /** 承認の結果が業務状態へ反映されたか。承認受付とは別。 */
  applicationStatus: ApplicationStatus
  applicationFailureReason: string | null
  decidedByUserId: string | null
  decidedAt: string | null
  decisionNote: string | null
  expiresAt: string
  assetDisposal: boolean
  version: number
  createdAt: string
  updatedAt: string
}

function proposalLocation(caseId: string, id: string): DocLocation {
  return { collection: collections.proposals, caseId, id }
}

function approvalLocation(caseId: string, id: string): DocLocation {
  return { collection: collections.approvals, caseId, id }
}

export function hashPayload(payload: Record<string, unknown>): string {
  return fingerprintOf(payload)
}

function versionLocation(caseId: string, proposalId: string, version: number): DocLocation {
  return { collection: collections.proposalVersions, caseId,
    id: fingerprintOf({ proposalId, version }) }
}

function proposalContent(proposal: ProposalEntity): ProposalVersionEntity['content'] {
  return {
    ...(proposal.actionId ? { actionId: proposal.actionId } : {}),
    ...(proposal.execution ? { execution: proposal.execution } : {}),
    kind: proposal.kind, source: proposal.source, agentRunId: proposal.agentRunId,
    title: proposal.title, summary: proposal.summary, proposalVersion: proposal.proposalVersion,
    payload: proposal.payload, payloadHash: proposal.payloadHash, basis: proposal.basis,
    caseVersionAtProposal: proposal.caseVersionAtProposal, assetDisposal: proposal.assetDisposal,
    supersedesProposalVersion: proposal.supersedesProposalVersion,
  }
}

/** 既存提案は次の変更の前に現存版を保存する。過去に失われた版は捏造しない。 */
async function preserveVersion(tx: Tx, caseId: string, proposalId: string, content: ProposalVersionEntity['content']) {
  if (content.payloadHash !== hashPayload(content.payload)) {
    throw errors.internal({ internal: { reason: 'proposal payload does not match its hash' } })
  }
  const location = versionLocation(caseId, proposalId, content.proposalVersion)
  const existing = await tx.get<ProposalVersionEntity>(location)
  if (existing) {
    if (fingerprintOf(existing.content) !== fingerprintOf(content)) {
      throw errors.internal({ internal: { reason: 'immutable proposal version mismatch' } })
    }
    return
  }
  tx.create<ProposalVersionEntity>(location, { id: location.id, proposalId, content })
}

function toProposalView(entity: ProposalEntity): ProposalView {
  return {
    id: entity.id,
    caseId: entity.caseId ?? '',
    kind: entity.kind,
    status: entity.status,
    source: entity.source,
    agentRunId: entity.agentRunId,
    title: entity.title,
    summary: entity.summary,
    proposalVersion: entity.proposalVersion,
    payload: entity.payload,
    payloadHash: entity.payloadHash,
    basis: entity.basis,
    caseVersionAtProposal: entity.caseVersionAtProposal,
    assetDisposal: entity.assetDisposal,
    supersedesProposalVersion: entity.supersedesProposalVersion,
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  }
}

function toApprovalView(entity: ApprovalEntity): ApprovalView {
  return {
    id: entity.id,
    caseId: entity.caseId ?? '',
    proposalId: entity.proposalId,
    proposalVersion: entity.proposalVersion,
    payloadHash: entity.payloadHash,
    status: entity.status,
    applicationStatus: entity.applicationStatus,
    applicationFailureReason: entity.applicationFailureReason,
    decidedByUserId: entity.decidedByUserId,
    decidedAt: entity.decidedAt,
    decisionNote: entity.decisionNote,
    expiresAt: entity.expiresAt,
    assetDisposal: entity.assetDisposal,
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  }
}

/**
 * 提案から確定までの共通経路（仕様書 8 章）。
 *
 * 承認は「その人が見た版の内容」に結び付く。内容を訂正したときは
 * 新しい版を作り、再検証したうえでその版を人が承認する。
 */
export class ProposalService {
  private readonly appliers: Map<ProposalKind, ProposalApplier>

  constructor(
    private readonly access: AccessService,
    private readonly read: ReadRepository,
    private readonly uow: UnitOfWork,
    appliers: ProposalApplier[] = [],
    private readonly approvalTtlMs: number = DEFAULT_APPROVAL_TTL_MS,
  ) {
    this.appliers = new Map(appliers.map((applier) => [applier.kind, applier]))
  }

  /** 認可済み内部実行のtransaction内だけで呼ぶ。全種類に人の承認を要求する。 */
  async submitAi(tx: Tx, caseId: string, run: AgentRunEntity, input: AiProposalInput) {
    if (!run.currentJobId || run.operation !== 'case_planning') throw errors.forbidden()
    const current = await tx.require<AgentRunEntity>({ collection: collections.agentRuns, caseId, id: run.id })
    if (current.currentAttemptId !== run.currentAttemptId || current.currentJobId !== run.currentJobId
      || current.fencingToken !== input.fencingToken || current.status !== 'RUNNING') throw errors.conflict({ details: { reason: 'STALE_EXECUTION' } })
    await assertLease(tx, caseId, current.id, input.fencingToken)
    const entity = await tx.require<CaseEntity>({ collection: collections.cases, caseId: null, id: caseId })
    if (entity.caseVersion !== input.caseVersion) throw errors.conflict({ details: { reason: 'STALE_CONTEXT' } })
    const applier = this.appliers.get(input.kind)
    if (!applier) throw errors.featureNotConnected()
    applier.validate?.(input.payload)
    await this.assertBasisBelongsToCase(tx, caseId, input.basis)
    const proposalId = fingerprintOf({ runId: run.id, proposalId: input.proposalId })
    const previous = await tx.get<ProposalEntity>(proposalLocation(caseId, proposalId))
    if (previous?.status === 'APPLIED') {
      if (previous.kind !== input.kind || previous.payloadHash !== hashPayload(input.payload)) throw errors.idempotencyKeyReused()
      return { proposalId, approvalId: fingerprintOf({ proposalId, proposalVersion: previous.proposalVersion }),
        proposalVersion: previous.proposalVersion, payloadHash: previous.payloadHash, waitRequestId: null, applicationStatus: 'APPLIED' as const }
    }
    if (previous && (previous.status === 'REJECTED' || previous.execution?.attemptId === run.currentAttemptId)) throw errors.conflict()
    const proposalVersion = (previous?.proposalVersion ?? 0) + 1
    if (previous) {
      await preserveVersion(tx, caseId, proposalId, proposalContent(previous))
      const oldId = fingerprintOf({ proposalId, proposalVersion: previous.proposalVersion })
      const old = await tx.get<ApprovalEntity>(approvalLocation(caseId, oldId))
      if (old?.status === 'PENDING') tx.update<ApprovalEntity>(approvalLocation(caseId, oldId), old.version, { status: 'EXPIRED' })
    }
    const approvalId = fingerprintOf({ proposalId, proposalVersion })
    const content: ProposalVersionEntity['content'] = {
      kind: input.kind, source: 'AI', agentRunId: run.id, title: input.title, summary: input.summary,
      actionId: input.proposalId, proposalVersion, payload: input.payload, payloadHash: hashPayload(input.payload), basis: input.basis,
      caseVersionAtProposal: input.caseVersion, assetDisposal: input.assetDisposal, supersedesProposalVersion: previous?.proposalVersion ?? null,
      execution: { attemptId: run.currentAttemptId, jobId: run.currentJobId, fencingToken: input.fencingToken, contextSnapshotId: input.contextSnapshotId },
    }
    await preserveVersion(tx, caseId, proposalId, content)
    if (previous) tx.update<ProposalEntity>(proposalLocation(caseId, proposalId), previous.version, { ...content, status: 'AWAITING_APPROVAL' })
    else tx.create<ProposalEntity>(proposalLocation(caseId, proposalId), { id: proposalId, ...content, status: 'AWAITING_APPROVAL' })
    tx.create<ApprovalEntity>(approvalLocation(caseId, approvalId), {
      id: approvalId, proposalId, proposalVersion, payloadHash: content.payloadHash, status: 'PENDING',
      applicationStatus: 'NOT_APPLIED', applicationFailureReason: null, decidedByUserId: null, decidedAt: null,
      decisionNote: null, expiresAt: new Date(Date.now() + this.approvalTtlMs).toISOString(), assetDisposal: input.assetDisposal,
    })
    tx.audit({ caseId, type: 'proposal.ai_submitted', target: { collection: collections.proposals.name, id: proposalId, version: (previous?.version ?? 0) + 1 },
      detail: { runId: run.id, proposalVersion, fencingToken: input.fencingToken, approvalId } })
    tx.outbox({ type: 'approval.requested', caseId, payload: { runId: run.id, proposalId, approvalId } })
    const wait = await createPendingWait(tx, current, `approval-${approvalId}`, { kind: 'APPROVAL', approvalId })
    return { proposalId, approvalId, proposalVersion, payloadHash: content.payloadHash, waitRequestId: wait.waitRequestId, applicationStatus: 'NOT_APPLIED' as const }
  }

  /** 公開APIからの利用者提案。AI は認可済み内部APIを使う。 */
  async submit(
    user: AuthenticatedUser,
    caseId: string,
    input: SubmitProposalInput,
    meta: CommandMeta,
  ): Promise<ProposalView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')
    if ((input.source && input.source !== 'USER') || input.agentRunId) {
      throw errors.forbidden({ details: { reason: 'SOURCE_NOT_ALLOWED' } })
    }
    this.appliers.get(input.kind)?.validate?.(input.payload)
    const proposalId = randomUUID()
    const payloadHash = hashPayload(input.payload)

    const storedId = await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      const caseEntity = await tx.require<CaseEntity>({
        collection: collections.cases,
        caseId: null,
        id: caseId,
      })
      await this.assertBasisBelongsToCase(tx, caseId, input.basis ?? [])

      const content: ProposalVersionEntity['content'] = {
        kind: input.kind,
        source: input.source ?? 'USER',
        agentRunId: input.agentRunId ?? null,
        title: input.title,
        summary: input.summary,
        proposalVersion: 1,
        payload: input.payload,
        payloadHash,
        basis: input.basis ?? [],
        caseVersionAtProposal: caseEntity.caseVersion,
        assetDisposal: input.assetDisposal ?? false,
        supersedesProposalVersion: null,
      }
      await preserveVersion(tx, caseId, proposalId, content)
      tx.create<ProposalEntity>(proposalLocation(caseId, proposalId), {
        id: proposalId, status: 'VALIDATED', ...content,
      })
      tx.audit({
        caseId,
        type: 'proposal.submitted',
        target: { collection: collections.proposals.name, id: proposalId, version: 1 },
        detail: { kind: input.kind, source: input.source ?? 'USER', proposalVersion: 1 },
      })
      return proposalId
    })

    return toProposalView(await this.requireProposal(user.tenantId, caseId, storedId))
  }

  /**
   * 承認を依頼する。
   *
   * 承認は提案の版と payload hash に結び付く。後から内容が変われば
   * この承認は対象を失う。
   */
  async requestApproval(
    user: AuthenticatedUser,
    caseId: string,
    proposalId: string,
    expectedVersion: number,
    meta: CommandMeta,
  ): Promise<ApprovalView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')
    const approvalId = randomUUID()

    const storedId = await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      const proposal = await tx.require<ProposalEntity>(proposalLocation(caseId, proposalId))
      if (!canRequestApproval(proposal.status)) {
        throw errors.preconditionFailed({
          message: 'この提案は承認を依頼できる状態ではありません。',
          details: { status: proposal.status },
        })
      }

      await preserveVersion(tx, caseId, proposalId, proposalContent(proposal))

      tx.create<ApprovalEntity>(approvalLocation(caseId, approvalId), {
        id: approvalId,
        proposalId,
        proposalVersion: proposal.proposalVersion,
        payloadHash: proposal.payloadHash,
        status: 'PENDING',
        // 承認を受け付けただけでは反映されていない。
        applicationStatus: 'NOT_APPLIED',
        applicationFailureReason: null,
        decidedByUserId: null,
        decidedAt: null,
        decisionNote: null,
        expiresAt: new Date(Date.now() + this.approvalTtlMs).toISOString(),
        assetDisposal: proposal.assetDisposal,
      })
      tx.update<ProposalEntity>(proposalLocation(caseId, proposalId), expectedVersion, {
        status: 'AWAITING_APPROVAL',
      })
      tx.audit({
        caseId,
        type: 'approval.requested',
        target: { collection: collections.approvals.name, id: approvalId, version: 1 },
        detail: { proposalId, proposalVersion: proposal.proposalVersion },
      })
      return approvalId
    })

    return toApprovalView(await this.requireApproval(user.tenantId, caseId, storedId))
  }

  /**
   * 内容の訂正。
   *
   * 既存の版の payload は変えない。新しい版と hash を作り、
   * 対象を失った承認は期限切れにする。人は新しい版を承認する。
   */
  async reviseProposal(
    user: AuthenticatedUser,
    caseId: string,
    proposalId: string,
    expectedVersion: number,
    payload: Record<string, unknown>,
    meta: CommandMeta,
  ): Promise<ProposalView> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')

    await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      const proposal = await tx.require<ProposalEntity>(proposalLocation(caseId, proposalId))
      if (isProposalFinal(proposal.status)) {
        throw errors.preconditionFailed({
          message: 'この提案は既に確定しているため訂正できません。',
          details: { status: proposal.status },
        })
      }

      const nextVersion = proposal.proposalVersion + 1
      this.appliers.get(proposal.kind)?.validate?.(payload)
      await preserveVersion(tx, caseId, proposalId, proposalContent(proposal))
      await preserveVersion(tx, caseId, proposalId, {
        ...proposalContent(proposal), proposalVersion: nextVersion, payload,
        payloadHash: hashPayload(payload), supersedesProposalVersion: proposal.proposalVersion,
      })
      tx.update<ProposalEntity>(proposalLocation(caseId, proposalId), expectedVersion, {
        proposalVersion: nextVersion,
        payload,
        payloadHash: hashPayload(payload),
        supersedesProposalVersion: proposal.proposalVersion,
        // 新しい版は改めて検証を通った状態から始める。
        status: 'VALIDATED',
      })
      tx.audit({
        caseId,
        type: 'proposal.revised',
        target: { collection: collections.proposals.name, id: proposalId, version: expectedVersion + 1 },
        detail: { from: proposal.proposalVersion, to: nextVersion },
      })
    })

    // 旧版に結び付く承認は対象を失う。期限切れとして閉じる。
    await this.expireApprovalsForOldVersions(user, caseId, proposalId, meta)
    return toProposalView(await this.requireProposal(user.tenantId, caseId, proposalId))
  }

  private async expireApprovalsForOldVersions(
    user: AuthenticatedUser,
    caseId: string,
    proposalId: string,
    meta: CommandMeta,
  ): Promise<void> {
    const access = await this.access.authorizeCase(user, caseId, 'case.write')
    let cursor: string | undefined
    do {
      const page = await this.read.list<ApprovalEntity>(user.tenantId, collections.approvals, caseId, {
        limit: 100, cursor,
        where: [{ field: 'proposalId', op: '==', value: proposalId }],
        orderBy: { field: 'createdAt', direction: 'desc' },
      })

      for (const approval of page.items) {
        if (approval.status !== 'PENDING') continue
        await this.uow.run(access.toWorkContext(meta.requestId, null), async (tx) => {
          const current = await tx.require<ApprovalEntity>(approvalLocation(caseId, approval.id))
          if (current.status !== 'PENDING') return
          const proposal = await tx.require<ProposalEntity>(proposalLocation(caseId, proposalId))
          if (matchesProposal(current, proposal.proposalVersion, proposal.payloadHash)) return
          tx.update<ApprovalEntity>(approvalLocation(caseId, approval.id), current.version, {
            status: 'EXPIRED',
          })
          tx.audit({
            caseId,
            type: 'approval.expired',
            target: { collection: collections.approvals.name, id: approval.id, version: current.version + 1 },
            detail: { reason: 'proposal revised' },
          })
        })
      }
      cursor = page.nextCursor
    } while (cursor)
  }

  /**
   * 承認して反映する。
   *
   * 承認の応答だけで反映済みにしない。承認したのがどの版かを要求に
   * 含めさせ、最新の状態と根拠を再検証してから原子的に適用する。
   */
  async approve(
    user: AuthenticatedUser,
    caseId: string,
    approvalId: string,
    input: { expectedVersion: number; proposalVersion: number; payloadHash: string; note?: string | null },
    meta: CommandMeta,
  ): Promise<ApprovalView> {
    const access = await this.access.authorizeCase(user, caseId, 'approval.decide')

    try {
      await this.runApproval(access, user, caseId, approvalId, input, meta)
    } catch (cause) {
      await this.markStaleIfNeeded(access, caseId, cause, meta)
      throw cause
    }

    return toApprovalView(await this.requireApproval(user.tenantId, caseId, approvalId))
  }

  /**
   * 前提が変わった提案を STALE として残す。
   *
   * 適用の Transaction を中断した後に別で書き込む。中断した Transaction の
   * 中で書いても巻き戻るため、次回も同じ提案が承認待ちのまま見える。
   */
  private async markStaleIfNeeded(
    access: Awaited<ReturnType<AccessService['authorizeCase']>>,
    caseId: string,
    cause: unknown,
    meta: CommandMeta,
  ): Promise<void> {
    const staleProposalId = (cause as { internal?: { staleProposalId?: unknown } })?.internal
      ?.staleProposalId
    const staleVersion = (cause as { internal?: { staleProposalEntityVersion?: unknown } })?.internal?.staleProposalEntityVersion
    if (typeof staleProposalId !== 'string') return

    await this.uow.run(access.toWorkContext(meta.requestId, null), async (tx) => {
      const proposal = await tx.require<ProposalEntity>(proposalLocation(caseId, staleProposalId))
      if (proposal.status === 'STALE' || isProposalFinal(proposal.status)
        || (typeof staleVersion === 'number' && proposal.version !== staleVersion)) return
      tx.update<ProposalEntity>(proposalLocation(caseId, staleProposalId), proposal.version, {
        status: 'STALE',
      })
      tx.audit({
        caseId,
        type: 'proposal.stale',
        target: { collection: collections.proposals.name, id: staleProposalId, version: proposal.version + 1 },
        detail: { reason: 'case changed after the proposal was made' },
      })
    })
  }

  private async runApproval(
    access: Awaited<ReturnType<AccessService['authorizeCase']>>,
    user: AuthenticatedUser,
    caseId: string,
    approvalId: string,
    input: { expectedVersion: number; proposalVersion: number; payloadHash: string; note?: string | null },
    meta: CommandMeta,
  ): Promise<void> {
    await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      const approval = await tx.require<ApprovalEntity>(approvalLocation(caseId, approvalId))
      // 外側の認可後に権限が撤回されても適用しない。
      const member = await tx.get<CaseMember>({ collection: collections.caseMembers, caseId, id: user.userId })
      const tenantMember = await tx.get<TenantMember>({ collection: collections.members, caseId: null, id: user.userId })
      if (!member?.active || member.userId !== user.userId || !roleAllows(member.role, 'approval.decide')
        || !tenantMember?.active || tenantMember.userId !== user.userId) throw errors.forbidden()
      const now = Date.now()

      if (approval.status !== 'PENDING') {
        throw errors.preconditionFailed({
          message: 'この承認は既に処理されています。',
          details: { status: approval.status },
        })
      }
      if (!isApprovalOpen(approval, now)) {
        throw errors.preconditionFailed({
          message: 'この承認は期限切れです。',
          details: { expiresAt: approval.expiresAt },
        })
      }
      // 利用者が見た版と、いま承認しようとしている版が同じかを確かめる。
      if (!matchesProposal(approval, input.proposalVersion, input.payloadHash)) {
        throw errors.conflict({
          message: '承認の対象が変更されています。最新の内容を確認してからやり直してください。',
          details: {
            expectedProposalVersion: approval.proposalVersion,
            expectedPayloadHash: approval.payloadHash,
          },
        })
      }

      const proposal = await tx.require<ProposalEntity>(proposalLocation(caseId, approval.proposalId))
      const caseEntity = await tx.require<CaseEntity>({
        collection: collections.cases,
        caseId: null,
        id: caseId,
      })

      // 承認後の再検証。提案が作られてから前提が変わっていないかを見る。
      if (!matchesProposal(approval, proposal.proposalVersion, proposal.payloadHash)) {
        throw errors.conflict({
          message: '提案の内容が承認後に変更されています。',
          details: { reason: 'PROPOSAL_REVISED' },
        })
      }
      if (!canApply(proposal.status)) {
        throw errors.preconditionFailed({
          message: 'この提案は反映できる状態ではありません。',
          details: { status: proposal.status },
        })
      }
      if (proposal.caseVersionAtProposal !== caseEntity.caseVersion) {
        // 利用者の更新を、古い前提の提案で上書きしない。
        // 状態を STALE にする書き込みは、この Transaction を中断した後に別で行う。
        // ここで書いても中断で巻き戻る。
        throw errors.conflict({
          message: '案件の内容が変わったため、この提案は反映できません。再作成が必要です。',
          details: {
            reason: 'STALE_PROPOSAL',
            caseVersionAtProposal: proposal.caseVersionAtProposal,
            currentCaseVersion: caseEntity.caseVersion,
          },
          internal: { staleProposalId: approval.proposalId, staleProposalEntityVersion: proposal.version },
        })
      }
      await this.assertBasisBelongsToCase(tx, caseId, proposal.basis)
      await preserveVersion(tx, caseId, proposal.id, proposalContent(proposal))

      const applier = this.appliers.get(proposal.kind)
      if (!applier) {
        throw errors.featureNotConnected({
          message: 'この種類の提案を反映する処理がまだ接続されていません。',
          details: { kind: proposal.kind },
        })
      }

      // 反映と承認の記録を同じ Transaction で確定する。
      await this.fenceAiApplication(tx, caseId, proposal)
      await applier.apply(tx, { caseId, proposal, userId: user.userId })

      tx.update<ApprovalEntity>(approvalLocation(caseId, approvalId), input.expectedVersion, {
        status: 'APPROVED',
        applicationStatus: 'APPLIED',
        decidedByUserId: user.userId,
        decidedAt: new Date(now).toISOString(),
        decisionNote: input.note ?? null,
      })
      tx.update<ProposalEntity>(proposalLocation(caseId, approval.proposalId), proposal.version, {
        status: 'APPLIED',
      })
      tx.audit({
        caseId,
        type: 'approval.approved',
        target: { collection: collections.approvals.name, id: approvalId, version: input.expectedVersion + 1 },
        detail: {
          proposalId: approval.proposalId,
          proposalVersion: approval.proposalVersion,
          kind: proposal.kind,
        },
      })
      tx.outbox({
        type: 'proposal.applied',
        caseId,
        payload: { caseId, proposalId: approval.proposalId, approvalId, kind: proposal.kind },
      })
    })
  }

  async reject(
    user: AuthenticatedUser,
    caseId: string,
    approvalId: string,
    input: { expectedVersion: number; note?: string | null },
    meta: CommandMeta,
  ): Promise<ApprovalView> {
    const access = await this.access.authorizeCase(user, caseId, 'approval.decide')

    await this.uow.run(access.toWorkContext(meta.requestId, meta.idempotency), async (tx) => {
      const approval = await tx.require<ApprovalEntity>(approvalLocation(caseId, approvalId))
      if (approval.status !== 'PENDING') {
        throw errors.preconditionFailed({
          message: 'この承認は既に処理されています。',
          details: { status: approval.status },
        })
      }
      const proposal = await tx.require<ProposalEntity>(proposalLocation(caseId, approval.proposalId))

      // 古い承認への却下で、訂正後の新しい版を却下しない。
      if (!matchesProposal(approval, proposal.proposalVersion, proposal.payloadHash)) {
        throw errors.conflict({ details: { reason: 'PROPOSAL_REVISED' } })
      }
      if (isProposalFinal(proposal.status)) throw errors.preconditionFailed()

      tx.update<ApprovalEntity>(approvalLocation(caseId, approvalId), input.expectedVersion, {
        status: 'REJECTED',
        decidedByUserId: user.userId,
        decidedAt: new Date().toISOString(),
        decisionNote: input.note ?? null,
      })
      tx.update<ProposalEntity>(proposalLocation(caseId, approval.proposalId), proposal.version, {
        status: 'REJECTED',
      })
      tx.audit({
        caseId,
        type: 'approval.rejected',
        target: { collection: collections.approvals.name, id: approvalId, version: input.expectedVersion + 1 },
        detail: { proposalId: approval.proposalId },
      })
      tx.outbox({ type: 'approval.rejected', caseId, payload: { approvalId, proposalId: approval.proposalId } })
    })

    return toApprovalView(await this.requireApproval(user.tenantId, caseId, approvalId))
  }

  async listProposals(
    user: AuthenticatedUser,
    caseId: string,
    options: { limit: number; cursor?: string | undefined },
  ): Promise<Page<ProposalView>> {
    await this.access.authorizeCase(user, caseId, 'case.read')
    const page = await this.read.list<ProposalEntity>(user.tenantId, collections.proposals, caseId, options)
    const items = page.items.map(toProposalView)
    return page.nextCursor === undefined ? { items } : { items, nextCursor: page.nextCursor }
  }

  async listApprovals(
    user: AuthenticatedUser,
    caseId: string,
    options: { limit: number; cursor?: string | undefined },
  ): Promise<Page<ApprovalView>> {
    await this.access.authorizeCase(user, caseId, 'case.read')
    const page = await this.read.list<ApprovalEntity>(user.tenantId, collections.approvals, caseId, options)
    const items = page.items.map(toApprovalView)
    return page.nextCursor === undefined ? { items } : { items, nextCursor: page.nextCursor }
  }

  async getApproval(user: AuthenticatedUser, caseId: string, approvalId: string): Promise<ApprovalView> {
    await this.access.authorizeCase(user, caseId, 'case.read')
    return toApprovalView(await this.requireApproval(user.tenantId, caseId, approvalId))
  }

  async getProposal(user: AuthenticatedUser, caseId: string, proposalId: string): Promise<ProposalView> {
    await this.access.authorizeCase(user, caseId, 'case.read')
    return toProposalView(await this.requireProposal(user.tenantId, caseId, proposalId))
  }

  async getVersion(user: AuthenticatedUser, caseId: string, proposalId: string, version: number): Promise<ProposalVersionResource> {
    await this.access.authorizeCase(user, caseId, 'case.read')
    const snapshot = await this.read.get<ProposalVersionEntity>(user.tenantId, versionLocation(caseId, proposalId, version))
    if (!snapshot) throw errors.notFound()
    const content = { ...snapshot.content }
    delete content.execution
    return { proposalId, caseId, ...content, recordedAt: snapshot.createdAt }
  }

  /**
   * 人の承認は古いAIのcapabilityでは行わない。現在のleaseを再検査し、
   * Backendの短い適用区間として世代を進め、同じcommitで解放する。
   * 待機中のlease失効だけで、保存済みの承認対象を不変履歴ごと失効させない。
   */
  private async fenceAiApplication(tx: Tx, caseId: string, proposal: ProposalEntity) {
    if (proposal.source !== 'AI') return
    if (!proposal.agentRunId || !proposal.execution) throw errors.preconditionFailed({ details: { reason: 'MISSING_EXECUTION_PROVENANCE' } })
    const run = await tx.require<AgentRunEntity>({ collection: collections.agentRuns, caseId, id: proposal.agentRunId })
    if (run.currentAttemptId !== proposal.execution.attemptId || run.currentJobId !== proposal.execution.jobId
      || ['CANCELLED', 'FAILED', 'NEEDS_ATTENTION'].includes(run.status)) throw errors.conflict({
        details: { reason: 'STALE_EXECUTION' },
        internal: { staleProposalId: proposal.id, staleProposalEntityVersion: proposal.version },
      })
    const location = leaseLocation(caseId)
    const lease = await tx.require<CaseLeaseEntity>(location)
    if (lease.holderRunId && lease.holderRunId !== run.id && !isLeaseExpired(lease, Date.now())) {
      throw errors.conflict({ details: { reason: 'CASE_BUSY' } })
    }
    const fencingToken = lease.fencingToken + 1
    tx.update<CaseLeaseEntity>(location, lease.version, { holderRunId: null, expiresAt: null, fencingToken })
    tx.audit({ caseId, type: 'proposal.application_fenced',
      target: { collection: collections.proposals.name, id: proposal.id, version: proposal.version },
      detail: { submissionFencingToken: proposal.execution.fencingToken, applicationFencingToken: fencingToken } })
  }

  /**
   * 根拠が同じ Case に属し、参照した版のままかを確かめる。
   *
   * 別 Case の documentId へ差し替えた提案を反映させない。
   */
  private async assertBasisBelongsToCase(
    tx: Tx,
    caseId: string,
    basis: ProposalBasis[],
  ): Promise<void> {
    for (const item of basis) {
      const collection =
        item.type === 'DOCUMENT'
          ? collections.documents
          : item.type === 'TASK'
            ? collections.tasks
            : collections.messages
      const found = await tx.get<EntityBase>({ collection, caseId, id: item.id })
      if (!found) {
        throw errors.preconditionFailed({
          message: '提案の根拠が見つかりません。',
          details: { reason: 'BASIS_NOT_FOUND', basisType: item.type, basisId: item.id },
        })
      }
      if (found.version !== item.version) {
        throw errors.conflict({
          message: '提案の根拠が更新されています。最新の内容で作り直してください。',
          details: {
            reason: 'BASIS_VERSION_CHANGED',
            basisId: item.id,
            expectedVersion: item.version,
            currentVersion: found.version,
          },
        })
      }
    }
  }

  private async requireProposal(
    tenantId: string,
    caseId: string,
    proposalId: string,
  ): Promise<ProposalEntity> {
    const entity = await this.read.get<ProposalEntity>(tenantId, proposalLocation(caseId, proposalId))
    if (!entity) throw errors.notFound()
    return entity
  }

  private async requireApproval(
    tenantId: string,
    caseId: string,
    approvalId: string,
  ): Promise<ApprovalEntity> {
    const entity = await this.read.get<ApprovalEntity>(tenantId, approvalLocation(caseId, approvalId))
    if (!entity) throw errors.notFound()
    return entity
  }
}
