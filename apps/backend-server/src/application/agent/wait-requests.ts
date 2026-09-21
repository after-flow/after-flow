import type { WaitCondition } from '@aftercare/internal-contracts'
import type { AgentRunEntity } from '../../domain/agent/agent-run.js'
import type { WaitRequestEntity } from '../../domain/agent/wait-request.js'
import type { ApprovalEntity } from '../../domain/proposal/approval.js'
import type { ProposalEntity } from '../../domain/proposal/proposal.js'
import type { TaskEntity } from '../../domain/task/task.js'
import { collections } from '../../domain/shared/collections.js'
import { errors } from '../../shared/app-error.js'
import { fingerprintOf } from '../../shared/fingerprint.js'
import type { Tx } from '../ports/persistence.js'
import { releaseLease } from './lease-service.js'
import { recordRunTransitionEvent } from './agent-run-events.js'

export const waitLocation = (caseId: string, id: string) => ({ collection: collections.waitRequests, caseId, id })

/** 条件の所属を確かめる。AIに任意の他Runの承認を待たせない。 */
export async function validateWaitCondition(tx: Tx, run: AgentRunEntity, condition: WaitCondition) {
  if (!run.caseId) throw errors.forbidden()
  if (condition.kind === 'APPROVAL') {
    const approval = await tx.require<ApprovalEntity>({ collection: collections.approvals, caseId: run.caseId, id: condition.approvalId })
    const proposal = await tx.require<ProposalEntity>({ collection: collections.proposals, caseId: run.caseId, id: approval.proposalId })
    if (proposal.agentRunId !== run.id || proposal.execution?.attemptId !== run.currentAttemptId
      || approval.proposalVersion !== proposal.proposalVersion || approval.payloadHash !== proposal.payloadHash) throw errors.forbidden()
  } else {
    const task = await tx.require<TaskEntity>({ collection: collections.tasks, caseId: run.caseId, id: condition.taskId })
    if (run.targetType === 'TASK' && run.targetId !== task.id) throw errors.forbidden()
    if (run.targetType !== 'TASK' && run.targetType !== 'CASE') throw errors.forbidden()
    if (new Set(condition.requiredDocumentIds).size !== condition.requiredDocumentIds.length
      || condition.requiredDocumentIds.some(id => !task.requiredDocuments.some(ref => ref.id === id))) throw errors.validationFailed()
  }
}

/** 呼出し側が検証済みの条件を登録する。新しいApprovalと同じtransactionでも使える。 */
export async function createPendingWait(tx: Tx, run: AgentRunEntity, clientId: string, condition: WaitCondition) {
  if (!run.caseId || !run.currentJobId || !run.fencingToken) throw errors.preconditionFailed()
  const id = fingerprintOf({ runId: run.id, jobId: run.currentJobId, clientId })
  if (run.activeWaitRequestId && run.activeWaitRequestId !== id) throw errors.conflict({ details: { reason: 'WAIT_ALREADY_REQUESTED' } })
  const existing = await tx.get<WaitRequestEntity>(waitLocation(run.caseId, id))
  if (existing) {
    if (fingerprintOf(existing.condition) !== fingerprintOf(condition)) throw errors.idempotencyKeyReused()
    return { waitRequestId: id, state: 'PENDING_SNAPSHOT' as const }
  }
  tx.create<WaitRequestEntity>(waitLocation(run.caseId, id), {
    id, runId: run.id, jobId: run.currentJobId, executionAttempt: run.currentAttemptId, fencingToken: run.fencingToken,
    condition, state: 'PENDING_SNAPSHOT', snapshotId: null, resumeJobId: null, inboxId: null,
  })
  tx.update<AgentRunEntity>({ collection: collections.agentRuns, caseId: run.caseId, id: run.id }, run.version, { activeWaitRequestId: id })
  tx.audit({ caseId: run.caseId, type: 'agent_run.wait_requested',
    target: { collection: collections.waitRequests.name, id, version: 1 }, detail: { runId: run.id, kind: condition.kind } })
  return { waitRequestId: id, state: 'PENDING_SNAPSHOT' as const }
}

/** Snapshot保存完了の通知。先行承認でleaseが変わっていても、古い他所有者のleaseには触れない。 */
export async function recordWaiting(tx: Tx, run: AgentRunEntity, waitRequestId: string, snapshotId: string, eventId?: string) {
  if (!run.caseId || run.activeWaitRequestId !== waitRequestId) throw errors.conflict({ details: { reason: 'WAIT_MISMATCH' } })
  const wait = await tx.require<WaitRequestEntity>(waitLocation(run.caseId, waitRequestId))
  if (wait.runId !== run.id || wait.executionAttempt !== run.currentAttemptId || wait.jobId !== run.currentJobId
    || !['PENDING_SNAPSHOT', 'WAITING'].includes(wait.state)) throw errors.conflict({ details: { reason: 'STALE_WAIT' } })
  if (wait.snapshotId && wait.snapshotId !== snapshotId) throw errors.conflict({ details: { reason: 'SNAPSHOT_MISMATCH' } })
  await releaseLease(tx, run.caseId, run.id, wait.fencingToken)
  tx.update<WaitRequestEntity>(waitLocation(run.caseId, wait.id), wait.version, { state: 'WAITING', snapshotId })
  const status = wait.condition.kind === 'APPROVAL' ? 'WAITING_APPROVAL' : 'WAITING_DOCUMENT'
  tx.update<AgentRunEntity>({ collection: collections.agentRuns, caseId: run.caseId, id: run.id }, run.version, {
    status, waitingFor: wait.id,
  })
  await recordRunTransitionEvent(tx, run, 'WAITING', status, {
    eventId, detail: { waitRequestId: wait.id, conditionKind: wait.condition.kind },
  })
  tx.audit({ caseId: run.caseId, type: 'agent_run.waiting',
    target: { collection: collections.agentRuns.name, id: run.id, version: run.version + 1 }, detail: { waitRequestId, snapshotId } })
  return { applied: true, reason: null }
}
