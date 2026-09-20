import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { artifactEnvelopeSchema, dispatchSchema } from '@aftercare/internal-contracts'
import type { ContextArtifact, ExecutionSnapshotStatus, RunDispatch } from '@aftercare/internal-contracts'
import type { ExecutionRuntime } from '../../application/ports/execution-runtime.js'
import { contentHash } from '../../orchestration/context/builder.js'
import type { BackendClient } from '../backend-client/client.js'
import type { FirestoreExecutions } from '../runtime-storage/executions.js'
import type { FirestoreWorkflowsStorage } from '../runtime-storage/workflows.js'
import type { DispatchVault } from '../runtime-storage/credential-vault.js'
import { ExecutionRejected, resumeSchema } from '../../application/execution/contracts.js'
import type { BudgetCharge, Receipt } from '../../application/execution/contracts.js'

type Client = Pick<BackendClient, 'control' | 'context' | 'heartbeat' | 'event'>
export interface ExecutionSession {
  receipt: Receipt; context: ContextArtifact; signal: AbortSignal
  /** Use immediately before every external action, including subagents and model retries. */
  guard(charge?: BudgetCharge): Promise<void>
  /** Call after Backend wait registration, before Mastra suspend. */
  registerWait(waitRequestId: string): Promise<void>
}
export interface WorkflowHandler {
  workflowName: string
  execute(session: ExecutionSession): Promise<'WAITING' | 'COMPLETED'>
}
export interface RuntimeDependencies {
  store: FirestoreExecutions; snapshots: FirestoreWorkflowsStorage; vault: DispatchVault
  client(dispatch: RunDispatch): Client
  handlers: Partial<Record<RunDispatch['operation'], WorkflowHandler>>
  /** Reserve this upper bound per active section. Human wait consumes none. */
  sectionTimeoutMs: number
  leaseMs?: number
}

export class DurableExecutionRuntime implements ExecutionRuntime {
  private readonly leaseMs: number
  constructor(private readonly deps: RuntimeDependencies) {
    this.leaseMs = deps.leaseMs ?? 30_000
    if (!Number.isInteger(this.leaseMs) || this.leaseMs < 6000 || this.leaseMs > 60_000 ||
      !Number.isInteger(deps.sectionTimeoutMs) || deps.sectionTimeoutMs < 1 || deps.sectionTimeoutMs > 300_000) throw new Error('Invalid execution timing')
  }
  private async context(client: Client, dispatch: RunDispatch, signal?: AbortSignal) {
    if ((await client.control({ signal })).instruction !== 'CONTINUE') throw new ExecutionRejected('STOPPED')
    const context = artifactEnvelopeSchema.parse(await client.context({ signal }))
    if (context.content.operation !== dispatch.operation || context.contentHash !== contentHash(context.content) || Date.parse(context.expiresAt) <= Date.now()) throw new ExecutionRejected('CONFLICT')
    return context
  }
  async accept(input: RunDispatch, kind: 'dispatch' | 'resume') {
    const dispatch = dispatchSchema.parse(input)
    const handler = this.deps.handlers[dispatch.operation]
    if (!handler) throw new Error('Operation is not connected')
    const now = Date.now(); const seconds = Math.floor(now / 1000)
    if (dispatch.issuedAt > seconds || dispatch.expiresAt <= seconds || dispatch.expiresAt - dispatch.issuedAt > 60) throw new ExecutionRejected('CONFLICT')
    const client = this.deps.client(dispatch)
    const context = await this.context(client, dispatch)
    const resume = context.content.resume == null ? null : resumeSchema.parse(context.content.resume)
    if ((kind === 'resume') !== (resume?.kind === 'WAIT')) throw new ExecutionRejected('CONFLICT')
    return this.deps.store.admit({
      ...dispatchIdentity(dispatch), kind, resume, workflowName: handler.workflowName,
      workflowRunId: createHash('sha256').update(dispatch.jobId).digest('hex'), encryptedDispatch: this.deps.vault.seal(dispatch),
      state: 'QUEUED', owner: null, leaseUntil: 0, waitRequestId: null, createdAt: now, updatedAt: now, failure: null,
    })
  }
  async snapshot(input: Parameters<ExecutionRuntime['snapshot']>[0]): Promise<ExecutionSnapshotStatus> {
    const missing: ExecutionSnapshotStatus = { ...input, state: 'MISSING', snapshotId: null }
    const receipt = await this.deps.store.get(input.jobId)
    if (!receipt || receipt.runId !== input.runId || receipt.executionAttempt !== input.executionAttempt ||
      (input.waitRequestId !== null && receipt.waitRequestId !== input.waitRequestId)) return missing
    const snapshot = await this.deps.snapshots.loadWorkflowSnapshot({ workflowName: receipt.workflowName, runId: receipt.workflowRunId })
    if (!snapshot) return missing
    if (snapshot.status === 'success' && receipt.state === 'COMPLETED') return { ...input, state: 'COMPLETED', snapshotId: receipt.workflowRunId }
    // Snapshot is the durable proof, even if the worker died before recording WAITING in its receipt.
    if (snapshot.status === 'suspended' && receipt.waitRequestId && input.waitRequestId === receipt.waitRequestId) return { ...input, state: 'WAITING', snapshotId: receipt.workflowRunId }
    // Running workflow snapshots need a handler-specific replay policy. Do not claim checkpoint readiness yet.
    return missing
  }
  /** A process supervisor awaits this loop and aborts it on shutdown; ingress never launches it. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const worked = await this.runOnce(signal)
      if (!worked) await delay(500, undefined, { signal }).catch(() => signal.throwIfAborted())
    }
  }
  async runOnce(shutdown: AbortSignal): Promise<boolean> {
    shutdown.throwIfAborted()
    const owner = randomUUID()
    const receipt = await this.deps.store.claim(owner, this.leaseMs)
    if (!receipt) return false
    const controller = new AbortController()
    const signal = AbortSignal.any([shutdown, controller.signal, AbortSignal.timeout(this.deps.sectionTimeoutMs)])
    const pulseStop = new AbortController()
    let pulse: Promise<void> | undefined
    try {
      const dispatch = this.deps.vault.open(receipt.encryptedDispatch, receipt.jobId)
      const client = this.deps.client(dispatch)
      const guard = async (charge: BudgetCharge = {}) => {
        signal.throwIfAborted()
        if ((await client.control({ signal })).instruction !== 'CONTINUE') throw new ExecutionRejected('STOPPED')
        await this.deps.store.charge(receipt.jobId, owner, charge)
        signal.throwIfAborted()
      }
      await guard({ activeMs: this.deps.sectionTimeoutMs })
      const context = await this.context(client, dispatch, signal)
      pulse = (async () => {
        while (!pulseStop.signal.aborted && !signal.aborted) {
          await delay(Math.floor(this.leaseMs / 3), undefined, { signal: AbortSignal.any([pulseStop.signal, signal]) })
          await guard()
          await client.heartbeat({ signal })
          await this.deps.store.renew(receipt.jobId, owner, this.leaseMs)
        }
      })().catch(error => { if (!pulseStop.signal.aborted) controller.abort(error) })
      const handler = this.deps.handlers[receipt.operation]
      if (!handler || handler.workflowName !== receipt.workflowName) throw new Error('Workflow version is not connected')
      const result = await handler.execute({ receipt, context, signal, guard,
        registerWait: waitRequestId => this.deps.store.registerWait(receipt.jobId, owner, waitRequestId) })
      signal.throwIfAborted()
      const snapshot = await this.deps.snapshots.loadWorkflowSnapshot({ workflowName: receipt.workflowName, runId: receipt.workflowRunId })
      if (!snapshot || snapshot.status !== (result === 'WAITING' ? 'suspended' : 'success')) throw new Error('Durable workflow state is missing')
      await this.deps.store.finish(receipt.jobId, owner, result)
      // Wait event is recoverable through snapshot-status if delivery fails or the process dies here.
      if (result === 'WAITING') {
        const saved = await this.deps.store.get(receipt.jobId)
        await client.event({ eventId: receipt.workflowRunId, type: 'WAITING', waitRequestId: saved!.waitRequestId!, snapshotId: receipt.workflowRunId }, { signal, requestId: receipt.workflowRunId })
      }
    } catch (error) {
      controller.abort()
      const failure = error instanceof ExecutionRejected && error.code === 'BUDGET_EXCEEDED' ? 'BUDGET_EXCEEDED' :
        error instanceof ExecutionRejected && error.code === 'STOPPED' ? 'STOPPED' : 'EXECUTION_FAILED'
      // A lost owner must never overwrite the new attempt. No credential/body is logged.
      try { await this.deps.store.finish(receipt.jobId, owner, failure === 'STOPPED' ? 'STOPPED' : 'FAILED', failure) }
      catch (finishError) { if (!(finishError instanceof ExecutionRejected && finishError.code === 'STALE_OWNER')) throw finishError }
    } finally {
      pulseStop.abort(); await pulse
    }
    return true
  }
}
function dispatchIdentity(input: RunDispatch) {
  return { runId: input.runId, jobId: input.jobId, executionAttempt: input.executionAttempt, operation: input.operation }
}
