import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { BackendCallError, BackendClient } from '../src/infrastructure/backend-client/client.js'
import { createApp } from '../src/app.js'
import type { ExecutionRuntime } from '../src/application/ports/execution-runtime.js'

function dispatch() {
  const now = Math.floor(Date.now() / 1000)
  return { jobId: 'job-1', runId: 'run-1', executionAttempt: 'attempt-1', operation: 'chat_reply' as const,
    issuedAt: now, expiresAt: now + 60, executionAuthorization: 'fixture-capability' }
}
const proof = { caseVersion: 1, contextSnapshotId: 'snapshot-1', fencingToken: 1, artifactVersion: 1, contentHash: 'a'.repeat(43) }

async function provider() {
  const child = fork(new URL('./helpers/backend-http-fixture.ts', import.meta.url), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const ready = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => { throw new Error('HTTP fixture exited before startup') }),
  ])
  const message = ready[0] as { type: string; port: number }
  assert.equal(message.type, 'ready')
  return { child, config: { baseUrl: `http://127.0.0.1:${message.port}`, serviceToken: 'fixture-service' } }
}

test('Backend client sends scoped metadata over independent-process HTTP and rotates capability', async t => {
  const { child, config } = await provider()
  t.after(() => child.kill())
  const client = new BackendClient(config, dispatch())
  assert.equal((await client.context()).content.operation, 'chat_reply')
  assert.equal((await client.artifact('snapshot-1')).contextSnapshotId, 'snapshot-1')
  assert.equal((await client.control()).instruction, 'CONTINUE')
  assert.deepEqual(await client.heartbeat(), { accepted: true })
  assert.equal((await client.control()).instruction, 'CONTINUE')
  assert.equal((await client.event({ eventId: 'event-1', sequence: 0, phase: 'VALIDATING' })).applied, false)
  assert.equal((await client.result({ ...proof, resultId: 'result-1', kind: 'chat_reply', body: '架空の案内', professionalNotice: false, basis: [] })).applied, false)
  assert.equal((await client.propose({ ...proof, proposalId: 'proposal-1', kind: 'TASK_PROPOSAL', title: '架空提案', summary: '', payload: {}, basis: [], assetDisposal: false })).applicationStatus, 'NOT_APPLIED')
  assert.equal((await client.wait({ ...proof, waitRequestId: 'wait-1', condition: { kind: 'APPROVAL', approvalId: 'approval-1' } })).state, 'PENDING_SNAPSHOT')
})

test('transport rejects redirect, malformed/oversized responses, timeout and authorization failure without leaking body', async t => {
  const { child, config } = await provider()
  t.after(() => child.kill())
  const client = new BackendClient({ ...config, timeoutMs: 200 }, dispatch())
  for (const [requestId, code] of [
    ['request-redirect', 'TRANSPORT'], ['request-invalid', 'INVALID_RESPONSE'],
    ['request-huge', 'RESPONSE_TOO_LARGE'], ['request-timeout', 'TRANSPORT'], ['request-error', 'HTTP_ERROR'],
  ]) {
    await assert.rejects(client.control({ requestId }), error => {
      assert.ok(error instanceof BackendCallError)
      assert.equal(error.code, code)
      assert.ok(!JSON.stringify(error).includes('SECRET'))
      return true
    })
  }
  const abort = new AbortController(); abort.abort()
  await assert.rejects(client.control({ signal: abort.signal }), { name: 'AbortError' })
  assert.throws(() => new BackendClient({ ...config, baseUrl: 'https://user:password@example.com/' }, dispatch()))
  assert.throws(() => new BackendClient({ ...config, timeoutMs: 20000 }, dispatch()))
  assert.throws(() => client.artifact('../other-run'))
})

const headers = { Authorization: 'Bearer ingress-fixture', 'X-Audience': 'ai-server',
  'X-Request-Id': 'job-1', 'Idempotency-Key': 'job-1', 'Content-Type': 'application/json' }
const input = (body: unknown = dispatch(), extraHeaders: Record<string, string> = {}) => ({ method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) })

test('liveness stays available; unconfigured runtime never acknowledges dispatch or resume', async () => {
  const app = createApp({ serviceToken: 'ingress-fixture' })
  assert.equal((await app.request('/internal/v1/health')).status, 200)
  for (const kind of ['dispatch', 'resume']) assert.equal((await app.request(`/internal/v1/runs/run-1/${kind}`, input())).status, 503)
  assert.equal((await createApp().request('/internal/v1/runs/run-1/dispatch', input())).status, 503)
})

test('ingress rejects identity, audience, run, time and idempotency substitutions before runtime', async () => {
  let calls = 0
  const runtime: ExecutionRuntime = {
    async accept() { calls++; return 'ACCEPTED' },
    async snapshot(scope) { return { ...scope, state: 'MISSING', snapshotId: null } },
  }
  const app = createApp({ serviceToken: 'ingress-fixture', runtime })
  const path = '/internal/v1/runs/run-1/dispatch'
  assert.equal((await app.request(path, input(dispatch(), { Authorization: 'Bearer wrong' }))).status, 401)
  assert.equal((await app.request(path, input(dispatch(), { 'X-Audience': 'backend-internal' }))).status, 401)
  assert.equal((await app.request(path, input(dispatch(), { 'Idempotency-Key': 'other-job' }))).status, 400)
  for (const body of [
    { ...dispatch(), runId: 'other-run' }, { ...dispatch(), expiresAt: 1 },
    { ...dispatch(), issuedAt: Math.floor(Date.now() / 1000) + 100 },
    { ...dispatch(), expiresAt: Math.floor(Date.now() / 1000) + 600 }, { ...dispatch(), prompt: 'untrusted override' },
  ]) assert.equal((await app.request(path, input(body))).status, 400)
  assert.equal(calls, 0)
  assert.equal((await app.request(path, input())).status, 202)
  assert.equal(calls, 1)
})

test('duplicate acknowledgement and snapshot response must match the requested scope', async () => {
  const runtime: ExecutionRuntime = {
    async accept() { return 'DUPLICATE' },
    async snapshot(scope) { return { ...scope, runId: 'other-run', state: 'MISSING', snapshotId: null } },
  }
  const app = createApp({ serviceToken: 'ingress-fixture', runtime })
  const response = await app.request('/internal/v1/runs/run-1/resume', input())
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { runId: 'run-1', jobId: 'job-1', status: 'DUPLICATE' })
  assert.equal((await app.request('/internal/v1/runs/run-1/snapshot-status?jobId=job-1&executionAttempt=attempt-1', { headers })).status, 503)
})
