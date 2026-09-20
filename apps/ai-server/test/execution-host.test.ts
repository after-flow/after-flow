import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startExecutionHost } from '../src/infrastructure/execution/host.js'
import type { ExecutionRuntime } from '../src/application/ports/execution-runtime.js'

const runtime: ExecutionRuntime = { accept: async () => { throw new Error('No fixture executions configured') },
  snapshot: async scope => ({ ...scope, state: 'MISSING', snapshotId: null }) }

test('server owns worker lifetime, rejects incomplete composition and closes after cooperative shutdown', async () => {
  await assert.rejects(startExecutionHost({ port: 0, runtime }), /together/)
  let started = false; let stopped = false
  const host = await startExecutionHost({ port: 0, runtime, worker: { run: signal => new Promise<void>(resolve => {
    started = true; signal.addEventListener('abort', () => { stopped = true; resolve() }, { once: true })
  }) } })
  assert.equal(started, true)
  const response = await fetch(`http://127.0.0.1:${host.port}/internal/v1/health`)
  assert.equal(response.status, 200); await response.arrayBuffer()
  assert.equal(await host.stop(), true); assert.equal(stopped, true)
  assert.equal(await host.stop(), true)
})

test('worker failure shuts ingress instead of leaving an accepting orphan', async () => {
  const host = await startExecutionHost({ port: 0, runtime, worker: { run: async () => { throw new Error('fixture storage failure') } } })
  await host.done
  await assert.rejects(fetch(`http://127.0.0.1:${host.port}/internal/v1/health`))
  assert.equal(await host.stop(), false)
})
