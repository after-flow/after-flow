import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRuntimeFirestore } from '../../src/infrastructure/runtime-storage/firestore.js'
import { FirestoreWorkflowsStorage } from '../../src/infrastructure/runtime-storage/workflows.js'

const options = { skip: !process.env.AI_RUNTIME_EMULATOR_HOST }

test('#180 restart restores WorkingState and does not repeat a successful research step', options, async () => {
  const runId = randomUUID()
  const child = (mode: 'crash' | 'restart') => new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', 'test/helpers/working-state-restart.ts', mode, runId],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
    let stdout = ''; let stderr = ''
    process.stdout.on('data', chunk => { stdout += String(chunk) }); process.stderr.on('data', chunk => { stderr += String(chunk) })
    process.once('error', reject); process.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  const crashed = await child('crash')
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr)
  const restarted = await child('restart')
  assert.equal(restarted.code, 0, restarted.stderr)
  assert.match(restarted.stdout, /"nextAction":"DONE"/)

  const db = createRuntimeFirestore()
  try {
    assert.equal((await db.collection('working_state_restart_receipts').doc(runId).get()).get('executed'), 1)
    const store = new FirestoreWorkflowsStorage(db)
    assert.equal((await store.loadWorkflowSnapshot({ workflowName: 'working-state-restart', runId }))?.status, 'success')
    await store.deleteWorkflowRunById({ workflowName: 'working-state-restart', runId })
    await db.collection('working_state_restart_receipts').doc(runId).delete()
  } finally { await db.terminate() }
})
