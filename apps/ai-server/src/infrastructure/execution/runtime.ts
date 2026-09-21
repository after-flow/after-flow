import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { artifactEnvelopeSchema, dispatchSchema, contextProofSchema, runSummarySchema, cancelExecutionSchema } from '@aftercare/internal-contracts'
import type { ContextArtifact, ExecutionSnapshotStatus, RunDispatch, RunSummary, CancelExecution } from '@aftercare/internal-contracts'
import type { ExecutionRuntime } from '../../application/ports/execution-runtime.js'
import { contentHash } from '../../orchestration/context/builder.js'
import { BackendCallError } from '../backend-client/client.js'
import type { BackendClient } from '../backend-client/client.js'
import type { FirestoreExecutions } from '../runtime-storage/executions.js'
import type { FirestoreWorkflowsStorage } from '../runtime-storage/workflows.js'
import type { DispatchVault } from '../runtime-storage/credential-vault.js'
import { ExecutionRejected, resumeSchema } from '../../application/execution/contracts.js'
import type { BudgetCharge, Receipt } from '../../application/execution/contracts.js'

export type ExecutionBackend = Pick<BackendClient, 'control' | 'context' | 'heartbeat' | 'event' | 'result' | 'propose' | 'wait'>
type Client = ExecutionBackend
export interface ExecutionSession {
  receipt: Receipt; context: ContextArtifact; signal: AbortSignal; backend: ExecutionBackend
  /** Use immediately before every external action, including subagents and model retries. */
  guard(charge?: BudgetCharge): Promise<void>
  exhaust(): never
  /** Save only validated progress, never raw model output or unconfirmed formal changes. */
  checkpoint(caseVersion: number, output: RunSummary): Promise<void>
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
  private readonly active = new Map<string, AbortController>()
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
  async cancel(raw: CancelExecution): Promise<'STOPPED' | 'DUPLICATE'> {
    const input = cancelExecutionSchema.parse(raw), now = Math.floor(Date.now() / 1000)
    if (input.issuedAt > now || input.expiresAt <= now || input.expiresAt <= input.issuedAt || input.expiresAt - input.issuedAt > 60) throw new ExecutionRejected('CONFLICT')
    const status = await this.deps.store.cancel(input)
    this.active.get(input.jobId)?.abort(new ExecutionRejected('STOPPED'))
    return status
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
    this.active.set(receipt.jobId, controller)
    const sectionTimeout = AbortSignal.timeout(this.deps.sectionTimeoutMs)
    const signal = AbortSignal.any([shutdown, controller.signal, sectionTimeout])
    const pulseStop = new AbortController()
    let pulse: Promise<void> | undefined
    let client: Client | undefined
    let rejected: ExecutionRejected | undefined
    try {
      const dispatch = this.deps.vault.open(receipt.encryptedDispatch, receipt.jobId)
      client = this.deps.client(dispatch)
      const backend = client
      if (receipt.pendingResult) { await this.deliverResult(receipt, owner, backend, shutdown); return true }
      const guard = async (charge: BudgetCharge = {}) => {
        signal.throwIfAborted()
        try {
          if ((await backend.control({ signal })).instruction !== 'CONTINUE') throw new ExecutionRejected('STOPPED')
          await this.deps.store.charge(receipt.jobId, owner, charge)
        } catch (error) { if (error instanceof ExecutionRejected) rejected = error; throw error }
        signal.throwIfAborted()
      }
      await guard({ activeMs: this.deps.sectionTimeoutMs })
      const context = await this.context(client, dispatch, signal)
      await this.deps.store.checkpoint(receipt.jobId, owner, context.caseVersion, { summary: '', completed: ['案件の実行権限と最新Contextを確認'],
        questions: [], remaining: ['依頼された処理の実行と結果の確認'] })
      pulse = (async () => {
        while (!pulseStop.signal.aborted && !signal.aborted) {
          await delay(Math.floor(this.leaseMs / 3), undefined, { signal: AbortSignal.any([pulseStop.signal, signal]) })
          await guard()
          await backend.heartbeat({ signal })
          await this.deps.store.renew(receipt.jobId, owner, this.leaseMs)
        }
      })().catch(error => { if (!pulseStop.signal.aborted) controller.abort(error) })
      const handler = this.deps.handlers[receipt.operation]
      if (!handler || handler.workflowName !== receipt.workflowName) throw new Error('Workflow version is not connected')
      const result = await handler.execute({ receipt, context, signal, guard, backend,
        exhaust: () => { rejected = new ExecutionRejected('BUDGET_EXCEEDED'); controller.abort(rejected); throw rejected },
        checkpoint: (caseVersion, output) => this.deps.store.checkpoint(receipt.jobId, owner, caseVersion, output),
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
      pulseStop.abort(); await pulse; controller.abort()
      const cause = controller.signal.reason instanceof ExecutionRejected ? controller.signal.reason : rejected ?? error
      const failure = cause instanceof ExecutionRejected && cause.code === 'BUDGET_EXCEEDED' ? 'BUDGET_EXCEEDED' :
        cause instanceof ExecutionRejected && cause.code === 'STOPPED' ? 'STOPPED' : sectionTimeout.aborted ? 'TIME_LIMIT' : 'EXECUTION_FAILED'
      // Reporting has its own short transport deadline, never another inference/tool allowance.
      if (client && !shutdown.aborted && failure !== 'STOPPED' && !(cause instanceof ExecutionRejected && cause.code === 'STALE_OWNER')) {
        try {
          const saved = await this.deps.store.get(receipt.jobId)
          if (saved && !saved.waitRequestId && !saved.pendingResult) {
            const reportSignal = AbortSignal.any([shutdown, AbortSignal.timeout(10000)])
            const dispatch = this.deps.vault.open(receipt.encryptedDispatch, receipt.jobId)
            const latest = await this.context(client, dispatch, reportSignal)
            const progress = saved.progress?.caseVersion === latest.caseVersion ? saved.progress.output : {
              summary: '', completed: [], questions: [], remaining: ['最新の案件状態を確認して処理を再開してください。'],
            }
            const summary = failure === 'BUDGET_EXCEEDED' ? '実行予算の上限に達したため、ここまでの結果を保存しました。' :
              failure === 'TIME_LIMIT' ? '実行時間の上限に達したため、ここまでの結果を保存しました。' : '処理を完了できなかったため、確認が必要です。'
            const resultId = contentHash({ jobId: receipt.jobId, kind: 'interrupted-result' })
            await this.deps.store.stageResult(receipt.jobId, owner, { ...contextProofSchema.parse(latest), resultId,
              kind: 'execution_interrupted', operation: receipt.operation, status: 'NEEDS_ATTENTION', failureReason: failure,
              basis: [], output: runSummarySchema.parse({ ...progress, summary }) })
            await this.deliverResult((await this.deps.store.get(receipt.jobId))!, owner, client, shutdown)
            return true
          }
          if (saved?.pendingResult) return true // durable reporting is reclaimed after owner expiry
        } catch (reportError) {
          if (reportError instanceof ExecutionRejected && reportError.code === 'STALE_OWNER') return true
          const saved = await this.deps.store.get(receipt.jobId)
          if (saved?.pendingResult) return true
        }
      }
      // A lost owner must never overwrite the new attempt. Backend reconciliation handles unavailable/stale Context.
      try { await this.deps.store.finish(receipt.jobId, owner, failure === 'STOPPED' ? 'STOPPED' : 'FAILED', failure) }
      catch (finishError) { if (!(finishError instanceof ExecutionRejected && finishError.code === 'STALE_OWNER')) throw finishError }
    } finally {
      pulseStop.abort(); await pulse
      this.active.delete(receipt.jobId)
    }
    return true
  }
  private async deliverResult(receipt: Receipt, owner: string, client: Client, shutdown: AbortSignal) {
    if (!receipt.pendingResult) throw new Error('Missing interrupted result')
    try {
      const outcome = await client.result(receipt.pendingResult, { requestId: receipt.pendingResult.resultId,
        signal: AbortSignal.any([shutdown, AbortSignal.timeout(10000)]) })
      await this.deps.store.finish(receipt.jobId, owner, outcome.applied ? 'FAILED' : 'STOPPED', receipt.failure)
    } catch (error) {
      if (error instanceof ExecutionRejected) throw error
      if (error instanceof BackendCallError && error.status && error.status < 500 && error.status !== 429) {
        await this.deps.store.finish(receipt.jobId, owner, 'STOPPED', receipt.failure)
      } else await this.deps.store.deferResult(receipt.jobId, owner)
    }
  }
}
function dispatchIdentity(input: RunDispatch) {
  return { runId: input.runId, jobId: input.jobId, executionAttempt: input.executionAttempt, operation: input.operation }
}
