import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createEmptyWorkflowSnapshot } from '@mastra/core/storage'
import { createRuntimeFirestore } from '../../src/infrastructure/runtime-storage/firestore.js'
import { FirestoreWorkflowsStorage, createRuntimeStore } from '../../src/infrastructure/runtime-storage/workflows.js'
const options = { skip: !process.env.AI_RUNTIME_EMULATOR_HOST }

test('Firestore snapshots survive forced process termination and resume without repeating completed steps', options, async () => {
  const runId = randomUUID()
  const child = (mode: string) => new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', 'test/helpers/runtime-restart.ts', mode, runId], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
    let stdout = ''; let stderr = ''
    process.stdout.on('data', chunk => { stdout += String(chunk) }); process.stderr.on('data', chunk => { stderr += String(chunk) })
    process.once('error', reject); process.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  const crashed = await child('crash')
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr)
  assert.match(crashed.stdout, /"status":"suspended"/)
  const resumed = await child('resume')
  assert.equal(resumed.code, 0, resumed.stderr)
  assert.match(resumed.stdout, /"status":"success","result":\{"count":41\}/)
  const db = createRuntimeFirestore()
  try {
    const store = new FirestoreWorkflowsStorage(db)
    assert.equal((await store.loadWorkflowSnapshot({ workflowName: 'restart-test', runId }))?.status, 'success')
    assert.equal((await db.collection('restart_test_receipts').doc(runId).get()).get('count'), 40)
    await store.deleteWorkflowRunById({ workflowName: 'restart-test', runId })
    await db.collection('restart_test_receipts').doc(runId).delete()
  } finally { await db.terminate() }
})

test('transactions preserve concurrent step results and enforce atomic status preconditions', options, async () => {
  const db = createRuntimeFirestore(); const db2 = createRuntimeFirestore()
  try {
    const stores = [new FirestoreWorkflowsStorage(db), new FirestoreWorkflowsStorage(db2)]
    const scope = { workflowName: 'concurrency-test', runId: randomUUID() }
    const snapshot = createEmptyWorkflowSnapshot(scope.runId)
    snapshot.status = 'running'
    await stores[0]!.persistWorkflowSnapshot({ ...scope, snapshot })
    await Promise.all(Array.from({ length: 6 }, (_, i) => stores[i % 2]!.updateWorkflowResults({ ...scope,
      stepId: `step-${i}`, result: { status: 'success', output: { index: i }, payload: {}, startedAt: Date.now(), endedAt: Date.now() }, requestContext: {},
    })))
    const loaded = await stores[0]!.loadWorkflowSnapshot(scope)
    for (let i = 0; i < 6; i++) {
      const step = loaded?.context[`step-${i}`]
      assert.equal(step?.status, 'success')
      if (step?.status !== 'success') assert.fail()
      assert.deepEqual(step.output, { index: i })
    }
    const result = await Promise.all(stores.map((store, index) => store.updateWorkflowState({ ...scope,
      opts: { expectedStatus: 'running', status: index === 0 ? 'success' : 'failed' },
    })))
    assert.equal(result.filter(Boolean).length, 1)
    assert.equal(Object.hasOwn((await stores[0]!.loadWorkflowSnapshot(scope))!, 'expectedStatus'), false)
    await stores[0]!.deleteWorkflowRunById(scope)
  } finally { await db.terminate(); await db2.terminate() }
})

test('workflow namespace, filtering, pagination and targeted deletion do not cross runs', options, async () => {
  const db = createRuntimeFirestore()
  try {
    const store = new FirestoreWorkflowsStorage(db); const name = `list-${randomUUID()}`
    const runId = randomUUID(); const snapshot = createEmptyWorkflowSnapshot(runId)
    await store.persistWorkflowSnapshot({ workflowName: name, runId, snapshot, resourceId: 'case-1' })
    await store.persistWorkflowSnapshot({ workflowName: `${name}-other`, runId, snapshot, resourceId: 'case-2' })
    await assert.rejects(store.getWorkflowRunById({ runId }), /ambiguous/)
    const result = await store.listWorkflowRuns({ workflowName: name, resourceId: 'case-1', page: 0, perPage: 1 })
    assert.equal(result.total, 1); assert.equal(result.runs[0]?.runId, runId)
    await store.deleteWorkflowRunById({ workflowName: name, runId })
    assert.equal(await store.getWorkflowRunById({ runId, workflowName: name }), null)
    assert.ok(await store.getWorkflowRunById({ runId, workflowName: `${name}-other` }))
    await store.deleteWorkflowRunById({ workflowName: `${name}-other`, runId })
    const composite = createRuntimeStore(db)
    assert.equal(await composite.getStore('memory'), undefined)
    await assert.rejects(store.dangerouslyClearAll(), /disabled/)
  } finally { await db.terminate() }
})

test('retention removes only terminal snapshots and preserves suspended work', options, async () => {
  const db = createRuntimeFirestore()
  try {
    const store = new FirestoreWorkflowsStorage(db); const workflowName = `retention-${randomUUID()}`
    const scopes = ['success', 'suspended'].map(status => ({ workflowName, runId: `${status}-${randomUUID()}` }))
    for (const scope of scopes) {
      const snapshot = createEmptyWorkflowSnapshot(scope.runId); snapshot.status = scope.runId.startsWith('success') ? 'success' : 'suspended'
      await store.persistWorkflowSnapshot({ ...scope, snapshot, updatedAt: new Date(0) })
    }
    await store.deleteFinishedBefore(new Date(1000))
    assert.equal(await store.loadWorkflowSnapshot(scopes[0]!), null)
    assert.equal((await store.loadWorkflowSnapshot(scopes[1]!))?.status, 'suspended')
    await store.deleteWorkflowRunById(scopes[1]!)
  } finally { await db.terminate() }
})
