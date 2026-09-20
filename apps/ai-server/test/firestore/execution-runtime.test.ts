import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { createEmptyWorkflowSnapshot } from '@mastra/core/storage'
import { Mastra } from '@mastra/core/mastra'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { createRuntimeFirestore } from '../../src/infrastructure/runtime-storage/firestore.js'
import { FirestoreExecutions } from '../../src/infrastructure/runtime-storage/executions.js'
import { FirestoreWorkflowsStorage, createRuntimeStore } from '../../src/infrastructure/runtime-storage/workflows.js'
import { DispatchVault } from '../../src/infrastructure/runtime-storage/credential-vault.js'
import { DurableExecutionRuntime } from '../../src/infrastructure/execution/runtime.js'
import { contentHash } from '../../src/orchestration/context/builder.js'
import type { Budget, Receipt } from '../../src/application/execution/contracts.js'
import type { RunDispatch } from '@aftercare/internal-contracts'

const options = { skip: !process.env.AI_RUNTIME_EMULATOR_HOST }
const limits: Budget = { tools: 20, research: 2, searches: 6, reads: 12, inferenceAttempts: 24, replans: 2, tokens: 10000, costMicros: 100000, activeMs: 120000 }
function receipt(): Receipt {
  const suffix = randomUUID()
  return { runId: `run-${suffix}`, jobId: `job-${suffix}`, executionAttempt: `attempt-${suffix}`, operation: 'task_guidance',
    kind: 'dispatch', resume: null, workflowName: 'worker-test', workflowRunId: randomUUID(), encryptedDispatch: 'encrypted-fixture',
    state: 'QUEUED', owner: null, leaseUntil: 0, createdAt: 1, updatedAt: 1, waitRequestId: null, failure: null }
}

test('durable receipts reject collisions, single-owner claims, cumulative budgets survive attempts and owner expiry', options, async () => {
  const db = createRuntimeFirestore(); const db2 = createRuntimeFirestore(); let now = Date.now()
  const store = new FirestoreExecutions(db, limits, () => now); const second = new FirestoreExecutions(db2, limits, () => now)
  try {
    const input = receipt()
    assert.equal(await store.admit(input), 'ACCEPTED')
    assert.equal(await second.admit(input), 'DUPLICATE')
    await assert.rejects(store.admit({ ...input, operation: 'chat_reply' }), /CONFLICT/)
    const claims = await Promise.all([store.claim('owner-one', 30000), second.claim('owner-two', 30000)])
    assert.equal(claims.filter(Boolean).length, 1)
    const owner = claims.find(Boolean)!.owner!
    await store.charge(input.jobId, owner, { tools: 19, tokens: 9999 })
    const charges = await Promise.allSettled([store.charge(input.jobId, owner, { tools: 1 }), second.charge(input.jobId, owner, { tools: 1 })])
    assert.equal(charges.filter(item => item.status === 'fulfilled').length, 1)
    await assert.rejects(store.charge(input.jobId, 'wrong-owner', { tools: 0 }), /STALE_OWNER/)
    now += 30001
    await assert.rejects(store.renew(input.jobId, owner, 30000), /STALE_OWNER/)
    assert.equal(await second.claim('new-owner', 30000), null)
    const next = { ...input, jobId: randomUUID(), executionAttempt: randomUUID(), resume: {
      previousAttemptId: input.executionAttempt, kind: 'RETRY' as const, outcome: 'RECOVERED', snapshotId: null, waitRequestId: null } }
    await store.admit(next)
    await second.claim('new-owner', 30000)
    await assert.rejects(store.charge(next.jobId, 'new-owner', { tools: 1 }), /BUDGET_EXCEEDED/)
    await assert.rejects(store.admit(input), /CONFLICT/)
    await store.finish(next.jobId, 'new-owner', 'FAILED', 'BUDGET_EXCEEDED')
  } finally { await db.terminate(); await db2.terminate() }
})

test('snapshot proof can resume a wait even if worker died before receipt finish', options, async () => {
  const db = createRuntimeFirestore(); const store = new FirestoreExecutions(db, limits)
  try {
    const input = receipt(); const snapshots = new FirestoreWorkflowsStorage(db)
    await store.admit(input); await store.claim('wait-owner', 30000)
    await store.registerWait(input.jobId, 'wait-owner', 'wait-one')
    const next = { ...input, jobId: randomUUID(), executionAttempt: randomUUID(), kind: 'resume' as const, resume: {
      previousAttemptId: input.executionAttempt, kind: 'WAIT' as const, outcome: 'APPLIED', snapshotId: input.workflowRunId, waitRequestId: 'wait-one' } }
    await assert.rejects(store.admit(next), /CONFLICT/)
    const snapshot = createEmptyWorkflowSnapshot(input.workflowRunId); snapshot.status = 'suspended'
    await snapshots.persistWorkflowSnapshot({ workflowName: input.workflowName, runId: input.workflowRunId, snapshot })
    await store.admit(next)
    await assert.rejects(store.finish(input.jobId, 'wait-owner', 'COMPLETED'), /STALE_OWNER/)
    await store.claim('resume-owner', 30000); await store.finish(next.jobId, 'resume-owner', 'STOPPED')
  } finally { await db.terminate() }
})

test('worker executes a stored Mastra workflow once and exposes only verified snapshots', options, async () => {
  const db = createRuntimeFirestore(); const store = new FirestoreExecutions(db, limits)
  const snapshots = new FirestoreWorkflowsStorage(db); let effects = 0; let stopped = false; let missingSnapshot = false
  const workflowName = `worker-${randomUUID()}`
  const contextContent = { operation: 'task_guidance', resume: null }
  const context = { caseVersion: 1, contextSnapshotId: 'context-one', fencingToken: 1, artifactVersion: 1,
    contentHash: contentHash(contextContent), content: contextContent, expiresAt: new Date(Date.now() + 60000).toISOString() }
  const client = { control: async () => ({ instruction: stopped ? 'STOP' as const : 'CONTINUE' as const, reason: null, caseVersion: 1 }),
    context: async () => context, heartbeat: async () => ({ accepted: true as const }), event: async () => ({ applied: true, reason: null }) }
  const vault = new DispatchVault(randomBytes(32).toString('base64'))
  const runtime = new DurableExecutionRuntime({ store, snapshots, vault, client: () => client, sectionTimeoutMs: 10000,
    handlers: { task_guidance: { workflowName, execute: async session => {
      if (missingSnapshot) return 'COMPLETED'
      const schema = z.object({ ok: z.boolean() })
      const step = createStep({ id: 'once', inputSchema: schema, outputSchema: schema, execute: async ({ inputData }) => {
        await session.guard({ tools: 1 }); effects++; return inputData
      } })
      const workflow = createWorkflow({ id: workflowName, inputSchema: schema, outputSchema: schema }).then(step).commit()
      const mastra = new Mastra({ storage: createRuntimeStore(db), workflows: { workflow } })
      const run = await mastra.getWorkflow('workflow').createRun({ runId: session.receipt.workflowRunId })
      const result = await run.start({ inputData: { ok: true } })
      assert.equal(result.status, 'success'); return 'COMPLETED'
    } } } })
  try {
    const input = receipt(); const now = Math.floor(Date.now() / 1000)
    const dispatch: RunDispatch = { runId: input.runId, jobId: input.jobId, executionAttempt: input.executionAttempt,
      operation: input.operation, issuedAt: now, expiresAt: now + 60, executionAuthorization: 'fixture-capability' }
    assert.equal(await runtime.accept(dispatch, 'dispatch'), 'ACCEPTED')
    assert.equal(await runtime.accept(dispatch, 'dispatch'), 'DUPLICATE')
    const query = { runId: input.runId, jobId: input.jobId, executionAttempt: input.executionAttempt, waitRequestId: null }
    assert.equal((await runtime.snapshot(query)).state, 'MISSING')
    const abort = new AbortController()
    await runtime.runOnce(abort.signal)
    assert.equal(effects, 1)
    assert.equal((await runtime.snapshot(query)).state, 'COMPLETED')
    assert.equal((await runtime.snapshot({ ...query, executionAttempt: 'wrong' })).state, 'MISSING')
    assert.equal(await runtime.runOnce(abort.signal), false)
    const dispatch2 = { ...dispatch, runId: randomUUID(), jobId: randomUUID(), executionAttempt: randomUUID() }
    await runtime.accept(dispatch2, 'dispatch'); stopped = true
    await runtime.runOnce(abort.signal)
    assert.equal((await store.get(dispatch2.jobId))?.state, 'STOPPED'); assert.equal(effects, 1)
    await assert.rejects(runtime.accept({ ...dispatch2, jobId: randomUUID() }, 'dispatch'), /STOPPED/)
    stopped = false; missingSnapshot = true
    const dispatch3 = { ...dispatch, runId: randomUUID(), jobId: randomUUID(), executionAttempt: randomUUID() }
    await runtime.accept(dispatch3, 'dispatch'); await runtime.runOnce(abort.signal)
    assert.equal((await store.get(dispatch3.jobId))?.state, 'FAILED')
    assert.equal((await runtime.snapshot({ ...query, runId: dispatch3.runId, jobId: dispatch3.jobId, executionAttempt: dispatch3.executionAttempt })).state, 'MISSING')
  } finally { await db.terminate() }
})
