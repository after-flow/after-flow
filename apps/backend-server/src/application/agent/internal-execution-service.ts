import { planningHistorySchema, planningRestrictionSchema, clarificationHistorySchema } from '@aftercare/internal-contracts'
import type { ProposalVersionEntity } from '../../domain/proposal/proposal-version.js'
import type { ApprovalEntity } from '../../domain/proposal/approval.js'
import type { AiProposalInput, ContextArtifact, ContextProof, ExecutionClaims, InternalRequestMetadata, InternalResult, InternalScope, ProgressEvent, WaitRequestInput } from '@aftercare/internal-contracts'
import { INTERNAL_LIMITS } from '@aftercare/internal-contracts'
import type { AgentRunEntity } from '../../domain/agent/agent-run.js'
import type { CaseLeaseEntity } from '../../domain/agent/case-lease.js'
import { isRunTerminal, isRunWaiting } from '../../domain/agent/agent-run.js'
import type { CaseMember } from '../../domain/authorization/case-role.js'
import { roleAllows } from '../../domain/authorization/case-role.js'
import type { CaseEntity } from '../../domain/case/case.js'
import type { DocumentEntity } from '../../domain/document/document.js'
import { collections } from '../../domain/shared/collections.js'
import type { CollectionDescriptor } from '../../domain/shared/collections.js'
import type { EntityBase } from '../../domain/shared/entity.js'
import { errors } from '../../shared/app-error.js'
import { fingerprintOf } from '../../shared/fingerprint.js'
import type { TenantMember } from '../authorization/case-access.js'
import type { AgentResultIntake } from '../chat/result-intake.js'
import type { ConsentService } from '../consent/consent-service.js'
import type { ReadRepository, SnapshotReader, Tx, UnitOfWork } from '../ports/persistence.js'
import type { ProposalService } from '../proposal/proposal-service.js'
import { acquireLease, assertLease, leaseLocation, releaseLease } from './lease-service.js'
import { createPendingWait, recordWaiting, validateWaitCondition } from './wait-requests.js'
import type { ProposalEntity } from '../../domain/proposal/proposal.js'
import type { WaitRequestEntity } from '../../domain/agent/wait-request.js'

interface RunArtifactEntity extends EntityBase {
  runId: string
  jobId: string
  executionAttempt: string
  artifact: ContextArtifact
}
interface ReceiptEntity extends EntityBase { fingerprint: string; result: unknown }
export interface InternalCall {
  claims: ExecutionClaims
  meta: InternalRequestMetadata
  scope: InternalScope
  /** 正規化前のHTTP本文とpathのhash。異なる本文を同一要求として扱わない。 */
  fingerprint: string
}
const runLocation = (caseId: string, id: string) => ({ collection: collections.agentRuns, caseId, id })
const artifactLocation = (caseId: string, id: string) => ({ collection: collections.runArtifacts, caseId, id })

/** whitelist。Storage参照・資格情報・内部監査項目を丸ごとserializeしない。 */
function pick(entity: EntityBase, fields: readonly string[]): Record<string, unknown> {
  const values = entity as unknown as Record<string, unknown>
  return Object.fromEntries(['id', 'version', ...fields].filter(key => values[key] !== undefined).map(key => [key, values[key]]))
}
const taskFields = ['title', 'summary', 'status', 'stage', 'category', 'submitTo', 'source', 'dependencyTaskIds', 'requiredDocuments', 'evidenceRequired', 'assetDisposal']
const contextCollections: [CollectionDescriptor, string[]][] = [
  [collections.persons, ['name', 'relationshipLabel', 'role', 'isHeir', 'specialCircumstance', 'excludedAt']],
  [collections.relationships, ['fromPersonId', 'toPersonId', 'kind', 'excludedAt']],
  [collections.assets, ['name', 'kind', 'institution', 'amount', 'confirmation']],
  [collections.liabilities, ['name', 'kind', 'creditor', 'amount', 'confirmation']],
  [collections.contracts, ['name', 'kind', 'provider', 'policyState', 'progressState']],
  [collections.benefits, ['name', 'kind', 'provider', 'amount', 'progressState']],
  [collections.tasks, taskFields],
  [collections.deadlines, ['taskId', 'label', 'dueDate', 'startDate', 'confirmation', 'unresolvedReason', 'basis', 'basisLabel', 'jurisdiction', 'timezone', 'ruleId', 'ruleVersion', 'sourceUrl', 'sourceCheckedAt', 'extendable', 'critical']],
  [collections.decisions, ['personId', 'method', 'state']],
]

export class InternalExecutionService {
  constructor(private readonly read: SnapshotReader, private readonly uow: UnitOfWork,
    private readonly consent: ConsentService, private readonly intake: AgentResultIntake,
    private readonly proposals?: ProposalService) {}

  /** mint/delivery前にも保存済みscope、membership、同意を確認する。 */
  async dispatchClaims(tenantId: string, caseId: string, runId: string, jobId: string): Promise<ExecutionClaims> {
    return this.uow.run({ tenantId, actor: { type: 'SYSTEM', userId: null, agentRunId: runId }, requestId: null }, async tx => {
      const run = await tx.require<AgentRunEntity>(runLocation(caseId, runId))
      if (run.currentJobId !== jobId || !run.initiatedByUserId) throw errors.conflict({ details: { reason: 'STALE_JOB' } })
      await this.assertAccess(tx, run)
      this.assertActive(run)
      if (run.operation === 'document_analysis') throw errors.featureNotConnected({ details: { reason: 'DOCUMENT_DELIVERY_NOT_CONNECTED' } })
      return { tenantId, caseId, runId, jobId, executionAttempt: run.currentAttemptId,
        operation: run.operation, scopes: ['context', 'artifact', 'control', 'heartbeat', 'events', 'result', 'wait-requests',
          ...(run.operation === 'case_planning' ? ['proposals' as const] : [])] }
    })
  }

  async assertAccess(tx: Tx, run: AgentRunEntity): Promise<void> {
    if (!run.initiatedByUserId || !run.caseId) throw errors.forbidden()
    const user = { tenantId: run.tenantId, userId: run.initiatedByUserId }
    const member = await tx.get<TenantMember>({ collection: collections.members, caseId: null, id: user.userId })
    const caseMember = await tx.get<CaseMember>({ collection: collections.caseMembers, caseId: run.caseId, id: user.userId })
    if (!member?.active || member.userId !== user.userId || !caseMember?.active
      || caseMember.userId !== user.userId || !roleAllows(caseMember.role, 'case.write')) throw errors.forbidden()
    await this.consent.assertExternalAiAllowed(user, tx)
  }

  /** callbackの永続記録は、失われた配送ACKより強い受領証明。旧jobも再実行しない。 */
  async deliverySettled(tenantId: string, caseId: string, runId: string, jobId: string): Promise<boolean> {
    const run = await this.read.get<AgentRunEntity>(tenantId, runLocation(caseId, runId))
    return !!run && (run.currentJobId !== jobId || run.status !== 'QUEUED')
  }

  private assertActive(run: AgentRunEntity) {
    if (isRunTerminal(run.status) || isRunWaiting(run.status) || run.status === 'NEEDS_ATTENTION') {
      throw errors.conflict({ details: { reason: 'RUN_NOT_ACTIVE' } })
    }
  }

  private async execute<T>(call: InternalCall, fn: (tx: Tx, run: AgentRunEntity) => Promise<T>, receiptKey?: string): Promise<T> {
    const { claims, meta } = call
    return this.uow.run({ tenantId: claims.tenantId, actor: { type: 'AI', userId: null, agentRunId: claims.runId }, requestId: meta.requestId }, async tx => {
      // 再試行中に期限が切れた要求も拒否する。
      const now = Math.floor(Date.now() / 1000)
      if (meta.issuedAt > now || meta.expiresAt <= now || meta.expiresAt - meta.issuedAt > INTERNAL_LIMITS.requestSeconds) throw errors.unauthenticated()
      if (!claims.scopes.includes(call.scope) || meta.jobId !== claims.jobId || meta.executionAttempt !== claims.executionAttempt) throw errors.forbidden()
      const run = await tx.require<AgentRunEntity>(runLocation(claims.caseId, claims.runId))
      if (run.currentJobId !== claims.jobId || run.currentAttemptId !== claims.executionAttempt || run.operation !== claims.operation) {
        throw errors.conflict({ details: { reason: 'STALE_EXECUTION' } })
      }
      // 制御照会は撤回後もSTOPを伝える。業務本文は返さない。
      if (call.scope !== 'control') await this.assertAccess(tx, run)
      const keys = [`request:${meta.requestId}`, ...(receiptKey ? [receiptKey] : [])]
      const receipts = await Promise.all(keys.map(async key => {
        const location = { collection: collections.internalReceipts, caseId: claims.caseId,
          id: fingerprintOf({ runId: run.id, jobId: claims.jobId, key }) }
        const receipt = await tx.get<ReceiptEntity>(location)
        if (receipt && receipt.fingerprint !== call.fingerprint) throw errors.idempotencyKeyReused()
        return { location, receipt }
      }))
      const record = (result: unknown) => {
        for (const { location, receipt } of receipts) if (!receipt) tx.create<ReceiptEntity>(location, {
          id: location.id, fingerprint: call.fingerprint, result,
        })
      }
      const duplicate = receipts.find(item => item.receipt)?.receipt
      // controlはキャッシュされたCONTINUEを返さない。artifactも有効性を再検証。
      if (duplicate && (call.scope === 'result' || call.scope === 'events' || call.scope === 'proposals' || call.scope === 'wait-requests')) {
        record(duplicate.result)
        return duplicate.result as T
      }
      if (call.scope !== 'control') this.assertActive(run)
      const result = await fn(tx, run)
      // context本文をreceiptに複製しない。
      record(call.scope === 'context' || call.scope === 'artifact' ? null : result)
      return result
    })
  }

  async context(call: InternalCall): Promise<ContextArtifact> {
    const { claims } = call
    const snapshot = await this.read.snapshot(claims.tenantId, runLocation(claims.caseId, claims.runId), async reader => {
      const run = await reader.get<AgentRunEntity>(claims.tenantId, runLocation(claims.caseId, claims.runId))
      if (!run) throw errors.notFound()
      const entity = await reader.get<CaseEntity>(claims.tenantId, { collection: collections.cases, caseId: null, id: claims.caseId })
      if (!entity) throw errors.notFound()
      const content: Record<string, unknown> = { operation: run.operation,
        case: pick(entity, ['deceasedName', 'dateOfDeath', 'knownAt', 'municipality', 'status']) }
      content.resume = run.pendingResume ?? null
      const actions = await reader.list<ProposalEntity>(claims.tenantId, collections.proposals, claims.caseId, {
        limit: 100, where: [{ field: 'agentRunId', op: '==', value: run.id }],
      })
      if (actions.nextCursor) throw errors.preconditionFailed({ details: { reason: 'CONTEXT_LIMIT_EXCEEDED' } })
      content.actions = actions.items.map(p => ({ id: p.id, actionId: p.actionId ?? null, status: p.status, proposalVersion: p.proposalVersion, payloadHash: p.payloadHash }))
      if (run.operation === 'document_analysis') throw errors.featureNotConnected({ details: { reason: 'DOCUMENT_DELIVERY_NOT_CONNECTED' } })
      if (run.operation === 'task_guidance') {
        if (run.targetType !== 'TASK') throw errors.forbidden()
        const target = await reader.get<EntityBase>(claims.tenantId, { collection: collections.tasks, caseId: claims.caseId, id: run.targetId })
        if (!target) throw errors.notFound()
        content.task = pick(target, taskFields)
      } else if (run.operation === 'chat_reply') {
        if (run.targetType !== 'MESSAGE') throw errors.forbidden()
        const target = await reader.get<EntityBase>(claims.tenantId, { collection: collections.messages, caseId: claims.caseId, id: run.targetId })
        if (!target) throw errors.notFound()
        content.message = pick(target, ['role', 'body'])
      } else {
        if (run.targetType !== 'CASE' || run.targetId !== claims.caseId) throw errors.forbidden()
        for (const [collection, fields] of contextCollections) content[collection.name] = await this.contextList(reader, claims, collection, fields)
        const [proposals, versions, approvals] = await Promise.all([
          reader.list<ProposalEntity>(claims.tenantId, collections.proposals, claims.caseId, { limit: 100 }),
          reader.list<ProposalVersionEntity>(claims.tenantId, collections.proposalVersions, claims.caseId, { limit: 100 }),
          reader.list<ApprovalEntity>(claims.tenantId, collections.approvals, claims.caseId, { limit: 100 }),
        ])
        if (proposals.nextCursor || versions.nextCursor || approvals.nextCursor) throw errors.preconditionFailed({ details: { reason: 'PLANNING_HISTORY_LIMIT_EXCEEDED' } })
        const targetTitle = (payload: Record<string, unknown>) => typeof payload.title === 'string' ? payload.title : null
        const planningHistory = planningHistorySchema.safeParse({ complete: true,
          proposals: proposals.items.map(p => ({ id: p.id, actionId: p.actionId ?? null, kind: p.kind, source: p.source,
            status: p.status, proposalVersion: p.proposalVersion, payloadHash: p.payloadHash, title: p.title, summary: p.summary,
            targetTitle: targetTitle(p.payload), targetTaskId: typeof p.payload.taskId === 'string' ? p.payload.taskId : null,
            assetDisposal: p.assetDisposal, supersedesProposalVersion: p.supersedesProposalVersion })),
          versions: versions.items.map(v => ({ proposalId: v.proposalId, proposalVersion: v.content.proposalVersion,
            payloadHash: v.content.payloadHash, title: v.content.title, summary: v.content.summary,
            targetTitle: targetTitle(v.content.payload), supersedesProposalVersion: v.content.supersedesProposalVersion })),
          approvals: approvals.items.map(a => ({ proposalId: a.proposalId, proposalVersion: a.proposalVersion, payloadHash: a.payloadHash,
            status: a.status, applicationStatus: a.applicationStatus, decisionNote: a.decisionNote, applicationFailureReason: a.applicationFailureReason })),
        })
        if (!planningHistory.success) throw errors.preconditionFailed({ details: { reason: 'PLANNING_HISTORY_UNAVAILABLE' } })
        content.clarificationHistory = clarificationHistorySchema.parse(run.clarificationHistory ?? [])
        content.unresolvedQuestions = (run.outcome?.questions ?? []).filter((_question, index) =>
          !(run.clarificationHistory ?? []).some(answer => answer.resultId === run.outcome?.resultId && answer.questionIndex === index))
        content.planningHistory = planningHistory.data
        content.planningRestriction = planningRestrictionSchema.parse(entity.aiPlanningRestriction ?? null)
      }
      // 原本・ファイル名・Storage keyは含めない。検査済みでも文書本文は#27接続まで配信しない。
      const documents = await reader.list<DocumentEntity>(claims.tenantId, collections.documents, claims.caseId, {
        limit: 100, where: [{ field: 'inspection.status', op: '==', value: 'PASSED' }],
      })
      if (documents.nextCursor) throw errors.preconditionFailed({ details: { reason: 'CONTEXT_LIMIT_EXCEEDED' } })
      content.documents = documents.items.filter(doc => !doc.archived && doc.storageState === 'STORED')
        .map(doc => ({ id: doc.id, version: doc.version, kind: doc.kind, contentAvailable: false }))
      const safeIds = new Set((content.documents as { id: string }[]).map(doc => doc.id))
      const tasks = (content.tasks ?? (content.task ? [content.task] : [])) as Record<string, unknown>[]
      const targetDocumentIds = new Set<string>()
      for (const task of tasks) {
        const refs = task.requiredDocuments as { id: string; label: string; documentId: string | null; source: string }[] | undefined
        task.requiredDocuments = (refs ?? []).map(ref => {
          const id = ref.documentId && safeIds.has(ref.documentId) ? ref.documentId : null
          if (id) targetDocumentIds.add(id)
          return { id: ref.id, label: ref.label, documentId: id, source: ref.source }
        })
      }
      if (run.operation !== 'case_planning') {
        content.documents = (content.documents as { id: string }[]).filter(doc => targetDocumentIds.has(doc.id))
      }
      if (Buffer.byteLength(JSON.stringify(content)) > INTERNAL_LIMITS.bodyBytes) throw errors.preconditionFailed({ details: { reason: 'CONTEXT_LIMIT_EXCEEDED' } })
      return { caseVersion: entity.caseVersion, content }
    })
    return this.execute(call, async (tx, run) => {
      const entity = await tx.require<CaseEntity>({ collection: collections.cases, caseId: null, id: claims.caseId })
      if (entity.caseVersion !== snapshot.caseVersion || run.caseVersionAtAccept !== entity.caseVersion) throw errors.conflict({ details: { reason: 'STALE_CONTEXT' } })
      const grant = run.fencingToken
        ? await assertLease(tx, claims.caseId, run.id, run.fencingToken)
        : await acquireLease(tx, claims.caseId, run.id)
      const id = fingerprintOf({ runId: run.id, jobId: claims.jobId, attempt: claims.executionAttempt, caseVersion: entity.caseVersion })
      const location = artifactLocation(claims.caseId, id)
      const previous = await tx.get<RunArtifactEntity>(location)
      if (previous) {
        await this.assertArtifact(tx, call, previous)
        return previous.artifact
      }
      const artifact: ContextArtifact = { ...snapshot, contextSnapshotId: id, artifactVersion: 1,
        fencingToken: grant.fencingToken,
        contentHash: fingerprintOf(snapshot.content), expiresAt: new Date(Date.now() + 300_000).toISOString() }
      tx.create<RunArtifactEntity>(location, { id, runId: run.id, jobId: claims.jobId, executionAttempt: claims.executionAttempt, artifact })
      tx.update<AgentRunEntity>(runLocation(claims.caseId, run.id), run.version, {
        status: 'RUNNING', fencingToken: grant.fencingToken, startedAt: run.startedAt ?? new Date().toISOString(),
      })
      if (run.pendingResume?.waitRequestId) {
        const location = { collection: collections.waitRequests, caseId: claims.caseId, id: run.pendingResume.waitRequestId }
        const wait = await tx.require<WaitRequestEntity>(location)
        if (wait.resumeJobId !== run.currentJobId) throw errors.conflict()
        tx.update<WaitRequestEntity>(location, wait.version, { state: 'RESUMED' })
      }
      return artifact
    })
  }

  private async contextList(read: ReadRepository, claims: ExecutionClaims, collection: CollectionDescriptor, fields: string[]) {
    const page = await read.list<EntityBase>(claims.tenantId, collection, claims.caseId, { limit: 100 })
    if (page.nextCursor) throw errors.preconditionFailed({ details: { reason: 'CONTEXT_LIMIT_EXCEEDED', collection: collection.name } })
    return page.items.map(entity => pick(entity, fields))
  }

  private async assertArtifact(tx: Tx, call: InternalCall, stored: RunArtifactEntity, proof?: ContextProof) {
    const { claims } = call
    if (stored.runId !== claims.runId || stored.jobId !== claims.jobId || stored.executionAttempt !== claims.executionAttempt) throw errors.notFound()
    const artifact = stored.artifact
    await assertLease(tx, claims.caseId, claims.runId, artifact.fencingToken)
    const entity = await tx.require<CaseEntity>({ collection: collections.cases, caseId: null, id: claims.caseId })
    if (Date.parse(artifact.expiresAt) <= Date.now() || artifact.caseVersion !== entity.caseVersion
      || (proof && (proof.caseVersion !== artifact.caseVersion || proof.contentHash !== artifact.contentHash
        || proof.artifactVersion !== artifact.artifactVersion || proof.fencingToken !== artifact.fencingToken))
      || fingerprintOf(artifact.content) !== artifact.contentHash) throw errors.conflict({ details: { reason: 'STALE_CONTEXT' } })
    // バージョン更新を省略したlegacyデータにも安全側で対処する。
    const documents = artifact.content.documents as { id: string; version: number }[] | undefined
    for (const ref of documents ?? []) {
      const doc = await tx.get<DocumentEntity>({ collection: collections.documents, caseId: claims.caseId, id: ref.id })
      if (!doc || doc.version !== ref.version || doc.archived || doc.storageState !== 'STORED' || doc.inspection.status !== 'PASSED') {
        throw errors.conflict({ details: { reason: 'DOCUMENT_NOT_DELIVERABLE' } })
      }
    }
  }

  artifact(call: InternalCall, id: string) {
    return this.execute(call, async tx => {
      const stored = await tx.require<RunArtifactEntity>(artifactLocation(call.claims.caseId, id))
      await this.assertArtifact(tx, call, stored)
      return stored.artifact
    })
  }

  control(call: InternalCall) {
    return this.execute(call, async (tx, run) => {
      try {
        await this.assertAccess(tx, run)
        this.assertActive(run)
        if (run.fencingToken) await assertLease(tx, call.claims.caseId, run.id, run.fencingToken)
      }
      catch { return { instruction: 'STOP' as const, reason: 'EXECUTION_NOT_ALLOWED', caseVersion: null } }
      const entity = await tx.require<CaseEntity>({ collection: collections.cases, caseId: null, id: call.claims.caseId })
      return entity.caseVersion === run.caseVersionAtAccept
        ? { instruction: 'CONTINUE' as const, reason: null, caseVersion: entity.caseVersion }
        : { instruction: 'STOP' as const, reason: 'STALE_CONTEXT', caseVersion: entity.caseVersion }
    })
  }

  heartbeat(call: InternalCall) {
    return this.execute(call, async (tx, run) => {
      if (!run.fencingToken) throw errors.preconditionFailed({ details: { reason: 'CONTEXT_REQUIRED' } })
      const lease = await assertLease(tx, call.claims.caseId, run.id, run.fencingToken)
      tx.update<CaseLeaseEntity>(leaseLocation(call.claims.caseId), lease.version, { expiresAt: new Date(Date.now() + 300_000).toISOString() })
      tx.update<AgentRunEntity>(runLocation(call.claims.caseId, run.id), run.version, { heartbeatAt: new Date().toISOString() })
      return { accepted: true as const }
    })
  }

  event(call: InternalCall, input: ProgressEvent) {
    return this.execute(call, async (tx, run) => {
      if ('type' in input) return recordWaiting(tx, run, input.waitRequestId, input.snapshotId)
      if (!run.fencingToken) throw errors.preconditionFailed({ details: { reason: 'CONTEXT_REQUIRED' } })
      await assertLease(tx, call.claims.caseId, run.id, run.fencingToken)
      if (input.sequence <= (run.progressSequence ?? -1)) return { applied: false, reason: 'OLD_PROGRESS' }
      tx.update<AgentRunEntity>(runLocation(call.claims.caseId, run.id), run.version, { progressSequence: input.sequence })
      tx.audit({ caseId: call.claims.caseId, type: 'agent_run.progress',
        target: { collection: collections.agentRuns.name, id: run.id, version: run.version + 1 }, detail: { phase: input.phase, sequence: input.sequence } })
      return { applied: true, reason: null }
    }, `event:${input.eventId}`)
  }

  result(call: InternalCall, input: InternalResult) {
    return this.execute(call, async (tx, run) => {
      if (run.activeWaitRequestId) throw errors.conflict({ details: { reason: 'WAIT_OUTSTANDING' } })
      if (input.kind !== run.operation) throw errors.forbidden()
      const artifact = await tx.require<RunArtifactEntity>(artifactLocation(call.claims.caseId, input.contextSnapshotId))
      await this.assertArtifact(tx, call, artifact, input)
      await this.assertBasis(tx, call, artifact, input.basis)
      await releaseLease(tx, call.claims.caseId, run.id, input.fencingToken)
      const envelope = { runId: run.id, attemptId: run.currentAttemptId }
      if (input.kind === 'task_guidance') return this.intake.applyGuidanceResult(tx, call.claims.caseId, { ...input, ...envelope })
      if (input.kind === 'chat_reply') return this.intake.applyChatReply(tx, call.claims.caseId, { ...input, ...envelope })
      tx.update<AgentRunEntity>(runLocation(call.claims.caseId, run.id), run.version, { status: input.status, finishedAt: new Date().toISOString(),
        outcome: input.output ? { ...input.output, resultId: input.resultId, attemptId: run.currentAttemptId, caseVersion: input.caseVersion } : null })
      tx.audit({ caseId: call.claims.caseId, type: 'agent_run.result',
        target: { collection: collections.agentRuns.name, id: run.id, version: run.version + 1 }, detail: { resultId: input.resultId, status: input.status } })
      return { applied: true, reason: null }
    }, `result:${input.resultId}`)
  }

  wait(call: InternalCall, input: WaitRequestInput) {
    return this.execute(call, async (tx, run) => {
      const artifact = await tx.require<RunArtifactEntity>(artifactLocation(call.claims.caseId, input.contextSnapshotId))
      await this.assertArtifact(tx, call, artifact, input)
      await validateWaitCondition(tx, run, input.condition)
      return createPendingWait(tx, run, input.waitRequestId, input.condition)
    }, `wait:${input.waitRequestId}`)
  }

  proposal(call: InternalCall, input: AiProposalInput) {
    return this.execute(call, async (tx, run) => {
      if (!this.proposals) throw errors.featureNotConnected()
      const artifact = await tx.require<RunArtifactEntity>(artifactLocation(call.claims.caseId, input.contextSnapshotId))
      await this.assertArtifact(tx, call, artifact, input)
      await this.assertBasis(tx, call, artifact, input.basis)
      return this.proposals.submitAi(tx, call.claims.caseId, run, input)
    }, `proposal:${input.proposalId}`)
  }

  private async assertBasis(tx: Tx, call: InternalCall, artifact: RunArtifactEntity, basis: InternalResult['basis']) {
      for (const ref of basis) {
        const content = artifact.artifact.content
        const allowed = ref.type === 'DOCUMENT' ? content.documents
          : ref.type === 'TASK' ? (content.tasks ?? (content.task ? [content.task] : []))
            : content.message ? [content.message] : []
        if (!Array.isArray(allowed) || !allowed.some(item => item.id === ref.id && item.version === ref.version)) throw errors.forbidden()
        const collection = ref.type === 'DOCUMENT' ? collections.documents : ref.type === 'TASK' ? collections.tasks : collections.messages
        const current = await tx.get<EntityBase>({ collection, caseId: call.claims.caseId, id: ref.id })
        if (!current || current.version !== ref.version) throw errors.conflict({ details: { reason: 'BASIS_VERSION_CHANGED' } })
        if (ref.type === 'DOCUMENT') {
          const document = current as DocumentEntity
          if (document.archived || document.storageState !== 'STORED' || document.inspection.status !== 'PASSED') throw errors.forbidden()
        }
      }
  }
}
