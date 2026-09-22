import type { ExecutionSnapshotStatus } from '@aftercare/internal-contracts'
import type { AgentRunEntity } from '../../domain/agent/agent-run.js'
import { isRunTerminal } from '../../domain/agent/agent-run.js'
import type { CaseLeaseEntity } from '../../domain/agent/case-lease.js'
import { isLeaseExpired } from '../../domain/agent/case-lease.js'
import type { RunInboxEntity, WaitRequestEntity } from '../../domain/agent/wait-request.js'
import type { ApprovalEntity } from '../../domain/proposal/approval.js'
import type { ProposalEntity } from '../../domain/proposal/proposal.js'
import type { CaseEntity } from '../../domain/case/case.js'
import type { OutboxEvent } from '../../domain/shared/outbox.js'
import { collections } from '../../domain/shared/collections.js'
import { AppError, errors } from '../../shared/app-error.js'
import { fingerprintOf } from '../../shared/fingerprint.js'
import type { ReadRepository, Tx, UnitOfWork } from '../ports/persistence.js'
import type { ExecutionSnapshots } from '../ports/execution-snapshots.js'
import type { InternalExecutionService } from './internal-execution-service.js'
import type { LocalOutboxHandler } from './outbox-dispatcher.js'
import { leaseLocation, releaseLease } from './lease-service.js'
import { recordWaiting, waitLocation } from './wait-requests.js'
import { recordRunTransitionEvent } from './agent-run-events.js'
import { failRunTargets } from './run-termination.js'

const runLocation = (caseId: string, id: string) => ({ collection: collections.agentRuns, caseId, id })
const inboxTypes = new Set(['proposal.applied', 'approval.rejected', 'document.registered'])

/** Backendのみが業務イベントを解釈する。AIへ汎用Outbox payloadを転送しない。 */
export class RunReconciler implements LocalOutboxHandler {
  readonly types = new Set([...inboxTypes, 'approval.requested', 'consent.revoked'])
  constructor(private readonly read: ReadRepository, private readonly uow: UnitOfWork,
    private readonly execution: InternalExecutionService, private readonly snapshots: ExecutionSnapshots) {}

  async deliverLocal(event: OutboxEvent) {
    if (!inboxTypes.has(event.type)) return { status: 'ACCEPTED' as const }
    const targetId = event.type === 'document.registered' ? event.payload.documentId : event.payload.approvalId
    if (!event.caseId || typeof targetId !== 'string') return { status: 'REJECTED' as const, reason: 'INVALID_INBOX_EVENT' }
    await this.uow.run({ tenantId: event.tenantId, actor: { type: 'SYSTEM', userId: null, agentRunId: null }, requestId: event.id }, async tx => {
      const location = { collection: collections.runInbox, caseId: event.caseId, id: event.id }
      const old = await tx.get<RunInboxEntity>(location)
      const payloadHash = fingerprintOf({ type: event.type, payload: event.payload })
      if (old) {
        if (old.payloadHash !== payloadHash) throw errors.idempotencyKeyReused()
        return
      }
      tx.create<RunInboxEntity>(location, { id: event.id, eventId: event.id, type: event.type as RunInboxEntity['type'],
        targetId, payloadHash })
    })
    return { status: 'ACCEPTED' as const }
  }

  /** createdAt+idの安定したページング。1件のHTTP障害で後続Runを飢餓状態にしない。 */
  async tick(tenantId: string) {
    let cursor: string | undefined
    let checked = 0
    let failed = 0
    do {
      const page = await this.read.listGroup<AgentRunEntity>(tenantId, collections.agentRuns, {
        limit: 100, cursor, orderBy: { field: 'createdAt', direction: 'asc' }, tiebreakField: 'id',
      })
      for (const run of page.items) {
        if (!run.caseId || isRunTerminal(run.status) || run.status === 'NEEDS_ATTENTION') continue
        try { await this.reconcile(tenantId, run.caseId, run.id); checked++ } catch { failed++ }
      }
      cursor = page.nextCursor
    } while (cursor)
    return { checked, failed }
  }

  async reconcile(tenantId: string, caseId: string, runId: string) {
    const context = { tenantId, actor: { type: 'SYSTEM' as const, userId: null, agentRunId: runId }, requestId: null }
    // 外部照会前に権限を確認。撤回済みならSnapshotの可用性によらず止める。
    const candidate = await this.uow.run(context, async tx => {
      const run = await tx.require<AgentRunEntity>(runLocation(caseId, runId))
      if (isRunTerminal(run.status) || run.status === 'NEEDS_ATTENTION' || !run.currentJobId) return null
      if (!await this.authorizeOrStop(tx, run)) return null
      const wait = run.activeWaitRequestId ? await tx.require<WaitRequestEntity>(waitLocation(caseId, run.activeWaitRequestId)) : null
      if (!wait && run.status !== 'RUNNING') return null
      const lease = await tx.get<CaseLeaseEntity>(leaseLocation(caseId))
      if (!wait && lease?.holderRunId === run.id && lease.fencingToken === run.fencingToken && !isLeaseExpired(lease, Date.now())) return null
      return { run, wait }
    })
    if (!candidate) return
    const { run, wait } = candidate
    const query = { runId, jobId: run.currentJobId!, executionAttempt: run.currentAttemptId, waitRequestId: wait?.id ?? null }
    const snapshot = await this.snapshots.status(query)
    if (snapshot.runId !== runId || snapshot.jobId !== query.jobId || snapshot.executionAttempt !== query.executionAttempt
      || snapshot.waitRequestId !== query.waitRequestId) throw errors.conflict({ details: { reason: 'SNAPSHOT_SCOPE_MISMATCH' } })
    if (wait && snapshot.state === 'WAITING' && snapshot.snapshotId) {
      await this.uow.run(context, async tx => {
        const current = await tx.require<AgentRunEntity>(runLocation(caseId, runId))
        if (current.currentJobId !== query.jobId || current.currentAttemptId !== query.executionAttempt || isRunTerminal(current.status)
          || current.status === 'NEEDS_ATTENTION') return
        if (!await this.authorizeOrStop(tx, current)) return
        const stored = await tx.require<WaitRequestEntity>(waitLocation(caseId, wait.id))
        if (stored.state === 'PENDING_SNAPSHOT') await recordWaiting(tx, current, wait.id, snapshot.snapshotId!)
      })
      await this.resumeWait(tenantId, caseId, runId, wait.id, snapshot)
    } else if (wait && snapshot.state === 'MISSING' && Date.parse(wait.updatedAt) < Date.now() - 600_000) {
      await this.uow.run(context, async tx => {
        const current = await tx.require<AgentRunEntity>(runLocation(caseId, runId))
        const stored = await tx.require<WaitRequestEntity>(waitLocation(caseId, wait.id))
        if (current.currentAttemptId !== query.executionAttempt || current.currentJobId !== query.jobId
          || current.activeWaitRequestId !== stored.id || isRunTerminal(current.status) || current.status === 'NEEDS_ATTENTION'
          || Date.parse(stored.updatedAt) >= Date.now() - 600_000) return
        if (!await this.authorizeOrStop(tx, current)) return
        if (current.fencingToken) await releaseLease(tx, caseId, runId, current.fencingToken)
        tx.update<AgentRunEntity>(runLocation(caseId, runId), current.version, {
          status: 'NEEDS_ATTENTION', failureReason: '待機Snapshotの保存を確認できません。再試行が必要です。',
          ...(current.operation === 'task_guidance' ? { guidanceOutcome: 'FAILED' as const } : {}),
        })
        await recordRunTransitionEvent(tx, current, 'RESULT', 'NEEDS_ATTENTION', {
          eventId: fingerprintOf({ runId, attemptId: current.currentAttemptId, reason: 'snapshot_missing', waitRequestId: wait.id }),
          detail: { operation: 'RECONCILE', failureReason: 'SNAPSHOT_MISSING' },
        })
        await failRunTargets(tx, caseId, current, { failureReason: 'SNAPSHOT_MISSING', attemptId: current.currentAttemptId })
        tx.audit({ caseId, type: 'agent_run.snapshot_missing', target: { collection: collections.agentRuns.name, id: runId, version: current.version + 1 }, detail: { waitRequestId: wait.id } })
      })
    } else if (!wait) {
      await this.uow.run(context, async tx => {
        const current = await tx.require<AgentRunEntity>(runLocation(caseId, runId))
        if (current.status !== 'RUNNING' || current.currentAttemptId !== query.executionAttempt || current.activeWaitRequestId) return
        if (!await this.authorizeOrStop(tx, current)) return
        const lease = await tx.get<CaseLeaseEntity>(leaseLocation(caseId))
        if (lease?.holderRunId === runId && lease.fencingToken === current.fencingToken && !isLeaseExpired(lease, Date.now())) return
        if (snapshot.state === 'COMPLETED' || snapshot.state === 'WAITING' || current.attempt >= 3) {
          tx.update<AgentRunEntity>(runLocation(caseId, runId), current.version, {
            status: 'NEEDS_ATTENTION', failureReason: '実行結果または待機状態の確認が必要です。',
            ...(current.operation === 'task_guidance' ? { guidanceOutcome: 'FAILED' as const } : {}),
          })
          await recordRunTransitionEvent(tx, current, 'RESULT', 'NEEDS_ATTENTION', {
            eventId: fingerprintOf({ runId, attemptId: current.currentAttemptId, reason: 'recovery_attention' }),
            detail: { operation: 'RECONCILE', failureReason: 'RECOVERY_ATTENTION' },
          })
          await failRunTargets(tx, caseId, current, { failureReason: 'RECOVERY_ATTENTION', attemptId: current.currentAttemptId })
          tx.audit({ caseId, type: 'agent_run.recovery_attention', target: { collection: collections.agentRuns.name, id: runId, version: current.version + 1 }, detail: {} })
          return
        }
        await this.enqueue(tx, current, null, snapshot.state === 'RUNNING_CHECKPOINT' ? snapshot.snapshotId : null,
          snapshot.state === 'RUNNING_CHECKPOINT' ? 'CHECKPOINT' : 'RETRY', 'RECOVERED', null)
      })
    }
  }

  private async authorizeOrStop(tx: Tx, run: AgentRunEntity) {
    try { await this.execution.assertAccess(tx, run); return true }
    catch (cause) {
      if (!(cause instanceof AppError) || cause.status !== 403) throw cause
      if (run.fencingToken) await releaseLease(tx, run.caseId!, run.id, run.fencingToken)
      if (run.activeWaitRequestId) {
        const location = waitLocation(run.caseId!, run.activeWaitRequestId)
        const wait = await tx.require<WaitRequestEntity>(location)
        tx.update<WaitRequestEntity>(location, wait.version, { state: 'CANCELLED' })
      }
      tx.update<AgentRunEntity>(runLocation(run.caseId!, run.id), run.version, {
        status: 'CANCELLED', failureReason: '実行権限または同意が失効しました。', finishedAt: new Date().toISOString(),
        ...(run.operation === 'task_guidance' ? { guidanceOutcome: 'FAILED' as const } : {}),
      })
      await recordRunTransitionEvent(tx, run, 'CANCELLED', 'CANCELLED', {
        eventId: fingerprintOf({ runId: run.id, attemptId: run.currentAttemptId, reason: 'permission_revoked' }),
        detail: { previousStatus: run.status },
      })
      await failRunTargets(tx, run.caseId!, run, { failureReason: 'PERMISSION_REVOKED', attemptId: run.currentAttemptId })
      tx.audit({ caseId: run.caseId, type: 'agent_run.permission_revoked', target: { collection: collections.agentRuns.name, id: run.id, version: run.version + 1 }, detail: {} })
      return false
    }
  }

  private async resumeWait(tenantId: string, caseId: string, runId: string, waitId: string, snapshot: ExecutionSnapshotStatus) {
    const wait = await this.read.get<WaitRequestEntity>(tenantId, waitLocation(caseId, waitId))
    // 書類本文の実配信が#25-27で接続されるまでDOCUMENTSは再開しない。
    if (!wait || wait.condition.kind !== 'APPROVAL') return
    const events = await this.read.list<RunInboxEntity>(tenantId, collections.runInbox, caseId, {
      limit: 1, where: [{ field: 'targetId', op: '==', value: wait.condition.approvalId }],
    })
    const event = events.items[0]
    if (!event) return
    await this.uow.run({ tenantId, actor: { type: 'SYSTEM', userId: null, agentRunId: runId }, requestId: event.id }, async tx => {
      const current = await tx.require<AgentRunEntity>(runLocation(caseId, runId))
      const stored = await tx.require<WaitRequestEntity>(waitLocation(caseId, waitId))
      if (current.currentAttemptId !== stored.executionAttempt || current.currentJobId !== stored.jobId
        || current.activeWaitRequestId !== stored.id || stored.state !== 'WAITING' || stored.snapshotId !== snapshot.snapshotId
        || !['WAITING_APPROVAL', 'WAITING_DOCUMENT'].includes(current.status) || stored.condition.kind !== 'APPROVAL') return
      if (!await this.authorizeOrStop(tx, current)) return
      const inbox = await tx.require<RunInboxEntity>({ collection: collections.runInbox, caseId, id: event.id })
      const approval = await tx.require<ApprovalEntity>({ collection: collections.approvals, caseId, id: stored.condition.approvalId })
      const proposal = await tx.require<ProposalEntity>({ collection: collections.proposals, caseId, id: approval.proposalId })
      if (proposal.agentRunId !== runId || proposal.proposalVersion !== approval.proposalVersion || proposal.payloadHash !== approval.payloadHash) return
      const applied = inbox.type === 'proposal.applied' && approval.applicationStatus === 'APPLIED' && proposal.status === 'APPLIED'
      const rejected = inbox.type === 'approval.rejected' && approval.status === 'REJECTED'
      if (!applied && !rejected) return
      await this.enqueue(tx, current, stored, snapshot.snapshotId, 'WAIT', applied ? 'APPLIED' : 'REJECTED', inbox.id)
    })
  }

  private async enqueue(tx: Tx, run: AgentRunEntity, wait: WaitRequestEntity | null, snapshotId: string | null,
    kind: 'WAIT' | 'CHECKPOINT' | 'RETRY', outcome: string, inboxId: string | null) {
    const caseId = run.caseId!
    const entity = await tx.require<CaseEntity>({ collection: collections.cases, caseId: null, id: caseId })
    if (run.fencingToken) await releaseLease(tx, caseId, run.id, run.fencingToken)
    const jobId = fingerprintOf({ runId: run.id, previousAttemptId: run.currentAttemptId, waitId: wait?.id ?? null, kind })
    const attemptId = fingerprintOf({ jobId, type: 'attempt' })
    tx.update<AgentRunEntity>(runLocation(caseId, run.id), run.version, { status: 'QUEUED', currentJobId: jobId,
      currentAttemptId: attemptId, attempt: run.attempt + 1, caseVersionAtAccept: entity.caseVersion, fencingToken: null,
      activeWaitRequestId: null, waitingFor: null, failureReason: null, progressSequence: -1,
      pendingResume: { waitRequestId: wait?.id ?? null, snapshotId, previousAttemptId: run.currentAttemptId, kind, outcome } })
    if (wait) tx.update<WaitRequestEntity>(waitLocation(caseId, wait.id), wait.version, { state: 'RESUME_QUEUED', resumeJobId: jobId, inboxId })
    tx.outbox({ id: jobId, type: kind === 'WAIT' ? 'agent.resume' : 'agent.recover', caseId, payload: { runId: run.id } })
    await recordRunTransitionEvent(tx, run, 'RESUMED', 'QUEUED', {
      eventId: jobId, attempt: run.attempt + 1, detail: { kind, outcome, waitRequestId: wait?.id ?? null },
    })
    tx.audit({ caseId, type: 'agent_run.resume_queued', target: { collection: collections.agentRuns.name, id: run.id, version: run.version + 1 }, detail: { jobId, kind, waitRequestId: wait?.id ?? null, inboxId } })
  }
}
