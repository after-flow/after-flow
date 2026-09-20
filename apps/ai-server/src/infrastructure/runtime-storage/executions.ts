import { createHash } from 'node:crypto'
import type { Firestore, Transaction } from '@google-cloud/firestore'
import { internalId } from '@aftercare/internal-contracts'
import { budgetSchema, emptyBudget, ExecutionRejected, receiptSchema } from '../../application/execution/contracts.js'
import type { Budget, BudgetCharge, Receipt } from '../../application/execution/contracts.js'

const key = (id: string) => createHash('sha256').update(internalId.parse(id)).digest('hex')
/** AI execution ownership only; Backend owns business lease, Outbox and Inbox. */
export class FirestoreExecutions {
  readonly limits: Budget
  constructor(private readonly db: Firestore, limits: Budget, private readonly now: () => number = Date.now) {
    this.limits = budgetSchema.parse(limits)
  }
  private run(id: string) { return this.db.collection('execution_runs').doc(key(id)) }
  private job(id: string) { return this.db.collection('execution_receipts').doc(key(id)) }
  async get(jobId: string): Promise<Receipt | null> {
    const doc = await this.job(jobId).get()
    return doc.exists ? receiptSchema.parse(doc.data()) : null
  }
  async admit(input: Receipt): Promise<'ACCEPTED' | 'DUPLICATE'> {
    const receipt = receiptSchema.parse(input)
    return this.db.runTransaction(async tx => {
      const [job, run] = await Promise.all([tx.get(this.job(receipt.jobId)), tx.get(this.run(receipt.runId))])
      if (job.exists) {
        const previous = receiptSchema.parse(job.data())
        if (['runId', 'jobId', 'executionAttempt', 'operation', 'kind', 'workflowName'].some(k => previous[k as keyof Receipt] !== receipt[k as keyof Receipt]) || run.get('jobId') !== receipt.jobId) throw new ExecutionRejected('CONFLICT')
        if (previous.state === 'QUEUED') tx.update(job.ref, { encryptedDispatch: receipt.encryptedDispatch, updatedAt: this.now() })
        return 'DUPLICATE'
      }
      if (run.exists) {
        if (run.get('operation') !== receipt.operation || !receipt.resume || receipt.resume.previousAttemptId !== run.get('executionAttempt')) throw new ExecutionRejected('CONFLICT')
        // The Backend authorizes the next attempt; its resume must refer to our exact previous snapshot.
        const previousDoc = await tx.get(this.job(run.get('jobId') as string))
        const previous = receiptSchema.parse(previousDoc.data())
        if (receipt.resume.snapshotId !== null && receipt.resume.snapshotId !== previous.workflowRunId) throw new ExecutionRejected('CONFLICT')
        if (receipt.resume.kind === 'WAIT') {
          const snapshotKey = createHash('sha256').update(JSON.stringify([previous.workflowName, previous.workflowRunId])).digest('hex')
          const snapshot = await tx.get(this.db.collection('workflow_snapshots').doc(snapshotKey))
          if (!receipt.resume.snapshotId || receipt.resume.waitRequestId !== previous.waitRequestId || !snapshot.exists || snapshot.get('status') !== 'suspended') throw new ExecutionRejected('CONFLICT')
        }
        if (previous.state === 'QUEUED' || previous.state === 'RUNNING') tx.update(previousDoc.ref, {
          state: 'STOPPED', owner: null, leaseUntil: 0, encryptedDispatch: 'erased', failure: 'STOPPED', updatedAt: this.now(),
        })
      } else if (receipt.resume) throw new ExecutionRejected('CONFLICT')
      tx.create(this.job(receipt.jobId), receipt)
      tx.set(this.run(receipt.runId), { jobId: receipt.jobId, executionAttempt: receipt.executionAttempt, operation: receipt.operation,
        used: run.exists ? run.get('used') : emptyBudget(), limits: run.exists ? run.get('limits') : this.limits })
      return 'ACCEPTED'
    })
  }
  async claim(owner: string, leaseMs: number): Promise<Receipt | null> {
    internalId.parse(owner)
    if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60_000) throw new Error('Invalid runtime lease')
    const candidates = await this.db.collection('execution_receipts').where('state', '==', 'QUEUED').orderBy('createdAt').limit(20).get()
    for (const candidate of candidates.docs) {
      const claimed = await this.db.runTransaction(async tx => {
        const doc = await tx.get(candidate.ref)
        const receipt = receiptSchema.parse(doc.data())
        const run = await tx.get(this.run(receipt.runId))
        if (receipt.state !== 'QUEUED') return null
        if (run.get('jobId') !== receipt.jobId) {
          tx.update(doc.ref, { state: 'STOPPED', encryptedDispatch: 'erased', updatedAt: this.now() })
          return null
        }
        const updated: Receipt = { ...receipt, state: 'RUNNING', owner, leaseUntil: this.now() + leaseMs, updatedAt: this.now() }
        tx.set(doc.ref, updated)
        return updated
      })
      if (claimed) return claimed
    }
    // Do not steal expired attempts: Backend reconciliation issues a new fenced attempt.
    return null
  }
  private async owned(tx: Transaction, jobId: string, owner: string) {
    const doc = await tx.get(this.job(jobId)); const receipt = receiptSchema.parse(doc.data())
    const run = await tx.get(this.run(receipt.runId))
    if (receipt.state !== 'RUNNING' || receipt.owner !== owner || receipt.leaseUntil <= this.now() || run.get('jobId') !== jobId) throw new ExecutionRejected('STALE_OWNER')
    return { doc, receipt, run }
  }
  async renew(jobId: string, owner: string, leaseMs: number): Promise<void> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60_000) throw new Error('Invalid runtime lease')
    await this.db.runTransaction(async tx => {
      const { doc } = await this.owned(tx, jobId, owner)
      tx.update(doc.ref, { leaseUntil: this.now() + leaseMs, updatedAt: this.now() })
    })
  }
  /** Reserve a proven upper bound before an external attempt, including failures/retries. No automatic refunds. */
  async charge(jobId: string, owner: string, charge: BudgetCharge): Promise<Budget> {
    for (const [name, amount] of Object.entries(charge)) {
      if (!Object.hasOwn(emptyBudget(), name) || !Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid budget reservation')
    }
    return this.db.runTransaction(async tx => {
      const { run } = await this.owned(tx, jobId, owner)
      const used = run.get('used') as Budget; const limits = budgetSchema.parse(run.get('limits'))
      const next = { ...used }
      for (const name of Object.keys(next) as (keyof Budget)[]) {
        next[name] += charge[name] ?? 0
        if (!Number.isSafeInteger(next[name]) || next[name] > Math.min(limits[name], this.limits[name])) throw new ExecutionRejected('BUDGET_EXCEEDED')
      }
      tx.update(run.ref, { used: next }); return next
    })
  }
  async registerWait(jobId: string, owner: string, waitRequestId: string): Promise<void> {
    internalId.parse(waitRequestId)
    await this.db.runTransaction(async tx => {
      const { doc } = await this.owned(tx, jobId, owner)
      tx.update(doc.ref, { waitRequestId, updatedAt: this.now() })
    })
  }
  async finish(jobId: string, owner: string, state: 'WAITING' | 'COMPLETED' | 'STOPPED' | 'FAILED', failure: Receipt['failure'] = null): Promise<void> {
    await this.db.runTransaction(async tx => {
      const { doc, receipt } = await this.owned(tx, jobId, owner)
      if (state === 'WAITING' && !receipt.waitRequestId) throw new ExecutionRejected('CONFLICT')
      tx.update(doc.ref, { state, failure, owner: null, leaseUntil: 0, encryptedDispatch: 'erased', updatedAt: this.now() })
    })
  }
}
