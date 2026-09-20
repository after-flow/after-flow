import { createHash } from 'node:crypto'
import type { Firestore, DocumentSnapshot, Transaction, Query } from '@google-cloud/firestore'
import { MastraCompositeStore, WorkflowsStorage, matchesExpectedWorkflowStatus, mergeWorkflowStepResult } from '@mastra/core/storage'
import type { WorkflowRun, StorageListWorkflowRunsInput, WorkflowRuns } from '@mastra/core/storage'
import type { WorkflowRunState } from '@mastra/core/workflows'
import { decodeSnapshot, encodeSnapshot, SNAPSHOT_CODEC } from './snapshot-codec.js'

type Scope = { workflowName: string; runId: string }
const collectionName = 'workflow_snapshots'
const id = (value: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid workflow identity')
  return value
}

/** Only workflow snapshots; memory/business/observability domains are not supplied. */
export class FirestoreWorkflowsStorage extends WorkflowsStorage {
  constructor(private readonly db: Firestore) { super() }
  supportsConcurrentUpdates() { return true }
  private ref(scope: Scope) {
    return this.db.collection(collectionName).doc(createHash('sha256').update(JSON.stringify([id(scope.workflowName), id(scope.runId)])).digest('hex'))
  }
  private read(doc: DocumentSnapshot): WorkflowRun | null {
    if (!doc.exists) return null
    const data = doc.data()!
    const runId = id(data.runId as string)
    const workflowName = id(data.workflowName as string)
    return { runId, workflowName, snapshot: decodeSnapshot(data.payload as Buffer, runId, data.codec),
      createdAt: new Date(data.createdAt as number), updatedAt: new Date(data.updatedAt as number),
      ...(typeof data.resourceId === 'string' ? { resourceId: data.resourceId } : {}) }
  }
  private write(tx: Transaction, scope: Scope, run: WorkflowRun) {
    const snapshot = run.snapshot as WorkflowRunState
    if (snapshot.runId !== scope.runId) throw new Error('Snapshot run mismatch')
    tx.set(this.ref(scope), { workflowName: scope.workflowName, runId: scope.runId, resourceId: run.resourceId ?? null,
      payload: encodeSnapshot(snapshot), codec: SNAPSHOT_CODEC, status: snapshot.status,
      createdAt: run.createdAt.getTime(), updatedAt: run.updatedAt.getTime() })
  }
  async persistWorkflowSnapshot(input: Parameters<WorkflowsStorage['persistWorkflowSnapshot']>[0]): Promise<void> {
    const payload = encodeSnapshot(input.snapshot)
    if (!payload.length) throw new Error('Empty snapshot')
    await this.db.runTransaction(async tx => {
      const previous = this.read(await tx.get(this.ref(input)))
      const now = new Date()
      this.write(tx, input, { workflowName: input.workflowName, runId: input.runId,
        snapshot: input.snapshot, resourceId: input.resourceId ?? previous?.resourceId,
        createdAt: input.createdAt ?? previous?.createdAt ?? now, updatedAt: input.updatedAt ?? now })
    })
  }
  async loadWorkflowSnapshot(scope: Scope): Promise<WorkflowRunState | null> {
    return (this.read(await this.ref(scope).get())?.snapshot as WorkflowRunState | undefined) ?? null
  }
  async updateWorkflowResults(input: Parameters<WorkflowsStorage['updateWorkflowResults']>[0]) {
    return this.db.runTransaction(async tx => {
      const previous = this.read(await tx.get(this.ref(input)))
      if (!previous) return {}
      const snapshot = previous.snapshot as WorkflowRunState
      const result = mergeWorkflowStepResult({ snapshot, stepId: input.stepId, result: input.result, requestContext: input.requestContext })
      this.write(tx, input, { ...previous, snapshot, updatedAt: new Date() })
      return result
    })
  }
  async updateWorkflowState(input: Parameters<WorkflowsStorage['updateWorkflowState']>[0]) {
    return this.db.runTransaction(async tx => {
      const previous = this.read(await tx.get(this.ref(input)))
      if (!previous) return undefined
      const snapshot = previous.snapshot as WorkflowRunState
      const { expectedStatus, ...state } = input.opts
      if (!matchesExpectedWorkflowStatus(snapshot.status, expectedStatus)) return undefined
      const updated = { ...snapshot, ...state }
      this.write(tx, input, { ...previous, snapshot: updated, updatedAt: new Date() })
      return updated
    })
  }
  async getWorkflowRunById(input: { runId: string; workflowName?: string }): Promise<WorkflowRun | null> {
    if (input.workflowName) return this.read(await this.ref({ ...input, workflowName: input.workflowName }).get())
    const docs = await this.db.collection(collectionName).where('runId', '==', id(input.runId)).limit(2).get()
    // A run ID without its workflow must not select an unrelated workflow arbitrarily.
    if (docs.size > 1) throw new Error('Workflow name is required for an ambiguous run ID')
    return docs.docs[0] ? this.read(docs.docs[0]) : null
  }
  async listWorkflowRuns(input: StorageListWorkflowRunsInput = {}): Promise<WorkflowRuns> {
    const { page, perPage } = input
    if (page !== undefined && (!Number.isSafeInteger(page) || page < 0)) throw new Error('Invalid page')
    if (perPage !== undefined && perPage !== false && (!Number.isSafeInteger(perPage) || perPage < 0 || perPage > 1000)) throw new Error('Invalid page size')
    let query: Query = this.db.collection(collectionName)
    if (input.workflowName) query = query.where('workflowName', '==', id(input.workflowName))
    if (input.resourceId) query = query.where('resourceId', '==', input.resourceId)
    if (input.status) query = query.where('status', '==', input.status)
    if (input.fromDate) query = query.where('createdAt', '>=', input.fromDate.getTime())
    if (input.toDate) query = query.where('createdAt', '<=', input.toDate.getTime())
    const total = (await query.count().get()).data().count
    // No unbounded admin scan, including when Mastra requests perPage:false.
    if ((perPage === false || perPage === undefined || page === undefined) && total > 1000) throw new Error('Workflow listing requires bounded pagination')
    if (perPage === 0) return { runs: [], total }
    query = query.orderBy('createdAt', 'desc').orderBy('__name__')
    if (typeof perPage === 'number' && page !== undefined) query = query.offset(page * perPage).limit(perPage)
    else query = query.limit(1000)
    return { runs: (await query.get()).docs.map(doc => this.read(doc)!), total }
  }
  async deleteWorkflowRunById(scope: Scope): Promise<void> { await this.ref(scope).delete() }
  /** Backend-authorized next attempt receives an isolated copy; completed steps are not replayed. */
  async forkSuspendedSnapshot(input: { workflowName: string; fromRunId: string; toRunId: string }): Promise<void> {
    if (input.fromRunId === input.toRunId) throw new Error('Resume requires a new attempt snapshot identity')
    const source = { workflowName: input.workflowName, runId: input.fromRunId }
    const target = { workflowName: input.workflowName, runId: input.toRunId }
    await this.db.runTransaction(async tx => {
      const [previousDoc, nextDoc] = await Promise.all([tx.get(this.ref(source)), tx.get(this.ref(target))])
      const previous = this.read(previousDoc)
      if (!previous || (previous.snapshot as WorkflowRunState).status !== 'suspended' || nextDoc.exists) throw new Error('Resume snapshot is unavailable or target already exists')
      const now = new Date()
      this.write(tx, target, { ...previous, runId: target.runId, snapshot: { ...(previous.snapshot as WorkflowRunState), runId: target.runId }, createdAt: now, updatedAt: now })
    })
  }
  async dangerouslyClearAll(): Promise<void> { throw new Error('Bulk clearing runtime storage is disabled; delete named runs') }

  /** Explicit bounded retention cleanup; never deletes running or waiting executions. */
  async deleteFinishedBefore(before: Date, limit = 100): Promise<number> {
    if (!Number.isFinite(before.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 400) throw new Error('Invalid retention request')
    const docs = await this.db.collection(collectionName).where('status', 'in', ['success', 'failed', 'canceled'])
      .where('updatedAt', '<', before.getTime()).orderBy('updatedAt').limit(limit).get()
    let deleted = 0
    for (const doc of docs.docs) {
      deleted += await this.db.runTransaction(async tx => {
        const current = await tx.get(doc.ref)
        const data = current.data()
        if (!data || !['success', 'failed', 'canceled'].includes(data.status as string) || Number(data.updatedAt) >= before.getTime()) return 0
        tx.delete(doc.ref)
        return 1
      })
    }
    return deleted
  }
}

export function createRuntimeStore(db: Firestore): MastraCompositeStore {
  return new MastraCompositeStore({ id: 'ai-runtime', domains: { workflows: new FirestoreWorkflowsStorage(db) } })
}
