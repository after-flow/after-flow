import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

// Run after `docker compose up --wait`. Uses the caller's Compose project.
const webUrl = `http://127.0.0.1:${process.env.WEB_PORT || '5173'}`
const backendUrl = `http://127.0.0.1:${process.env.BACKEND_PORT || '8080'}`

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 20_000 }).trim()
}

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  assert.equal(response.status, 200, `GET ${url}`)
  return response
}

assert.match(await (await get(webUrl)).text(), /<title>after-flow<\/title>/)
const worker = await get(`${webUrl}/mockServiceWorker.js`)
assert.match(worker.headers.get('content-type') ?? '', /javascript/)
assert.match(await worker.text(), /Mock Service Worker/)

for (const baseUrl of [backendUrl, webUrl]) {
  const health = await (await get(`${baseUrl}/api/v1/health`)).json()
  assert.equal(health.data.service, 'backend-server')
  assert.equal(health.data.status, 'ok')
}

// This crosses the real container network, not an in-process app.request().
docker('compose', 'exec', '-T', 'backend-server', 'node', '--input-type=module', '-e', `
  import assert from 'node:assert/strict'
  const response = await fetch('http://ai-server:8081/internal/v1/health', {
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(response.status, 200)
  const health = await response.json()
  assert.equal(health.data.service, 'ai-server')
  assert.equal(health.data.status, 'ok')
  const ready = await fetch('http://ai-server:8081/internal/v1/ready', {
    signal: AbortSignal.timeout(5_000),
  })
  assert.ok([200, 503].includes(ready.status))
  if (ready.status === 200) {
    assert.equal((await ready.json()).data.execution, 'connected')
    const now = Math.floor(Date.now() / 1000)
    const body = { cancelId: 'compose-smoke-cancel', runId: 'compose-smoke-run', jobId: 'compose-smoke-job',
      executionAttempt: 'compose-smoke-attempt', issuedAt: now, expiresAt: now + 60 }
    const cancel = await fetch('http://ai-server:8081/internal/v1/runs/compose-smoke-run/cancel', {
      method: 'POST', signal: AbortSignal.timeout(5_000), body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${process.env.AI_SERVICE_TOKEN}\`,
        'X-Audience': process.env.AI_SERVICE_AUDIENCE || 'ai-server', 'X-Request-Id': body.cancelId, 'Idempotency-Key': body.cancelId },
    })
    assert.equal(cancel.status, 200)
  }
  const publicRoute = await fetch('http://ai-server:8081/api/v1/health', {
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(publicRoute.status, 404)
`)

docker('compose', 'exec', '-T', 'ai-server', 'node', '--input-type=module', '-e', `
  import assert from 'node:assert/strict'
  const response = await fetch('http://127.0.0.1:8081/internal/v1/ready')
  assert.equal(response.status, process.env.ORCAROUTER_API_KEY ? 200 : 503)
`)

const aiId = docker('compose', 'ps', '--quiet', 'ai-server')
assert.ok(aiId, 'AI container must be running')
assert.equal(JSON.parse(docker('inspect', aiId))[0].HostConfig.RestartPolicy.Name, 'unless-stopped',
  'AI container must restart after an unexpected process or Docker restart')
const aiNetwork = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings}}', aiId))
assert.ok(Object.values(aiNetwork.Ports ?? {}).every((bindings) => bindings === null || bindings.length === 0),
  'AI must not publish any host ports')

// Inspect live network membership: DNS failure codes vary across Docker hosts,
// and a transient DNS failure alone is not evidence of network isolation.
const webId = docker('compose', 'ps', '--quiet', 'web')
assert.ok(webId, 'Web container must be running')
const webNetworks = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', webId))
const aiNetworkIds = Object.values(aiNetwork.Networks).map((network) => network.NetworkID)
const aiNetworkNames = Object.keys(aiNetwork.Networks)
const webNetworkIds = Object.values(webNetworks).map((network) => network.NetworkID)
assert.ok(aiNetworkIds.length > 0 && webNetworkIds.length > 0, 'Both services must be networked')
assert.ok(webNetworkIds.every((id) => !aiNetworkIds.includes(id)), 'Web and AI must not share a network')
assert.ok(aiNetworkNames.every((name) => !/(?:^|_)(?:data|emulator-host)$/.test(name)),
  'AI must not join either local business-data network')
assert.ok(aiNetworkNames.some((name) => name.endsWith('_ai-egress')), 'AI must have outbound access without publishing a port')

const aiRuntimeId = docker('compose', 'ps', '--quiet', 'ai-runtime-emulator')
assert.ok(aiRuntimeId, 'AI runtime emulator must be running')
const aiRuntimeNetworks = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', aiRuntimeId))
const businessFirestoreId = docker('compose', 'ps', '--quiet', 'firestore-emulator')
const businessNetworks = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', businessFirestoreId))
assert.ok(Object.values(aiRuntimeNetworks).every((network) =>
  Object.values(businessNetworks).every((business) => network.NetworkID !== business.NetworkID)),
  'AI runtime and business Firestore must not share a network')

// outbox-worker (#122): independent container actually running a tick loop,
// not just declared in compose.yaml with a crash-looping process that
// `docker compose up --wait` would not catch (it has no healthcheck).
const workerId = docker('compose', 'ps', '--quiet', 'outbox-worker')
assert.ok(workerId, 'outbox-worker container must be running')
const workerState = JSON.parse(docker('inspect', '--format', '{{json .State}}', workerId))
assert.equal(workerState.Status, 'running', `outbox-worker must be running, was: ${workerState.Status}`)

const workerTickDeadline = Date.now() + 30_000
let sawWorkerTick = false
while (Date.now() < workerTickDeadline && !sawWorkerTick) {
  const workerLogs = docker('compose', 'logs', '--no-color', '--no-log-prefix', 'outbox-worker')
  sawWorkerTick = /outbox worker tick/.test(workerLogs)
  if (!sawWorkerTick) await new Promise((resolve) => setTimeout(resolve, 1_000))
}
assert.ok(sawWorkerTick, 'outbox-worker must log at least one "outbox worker tick" within 30s')

const workerNetwork = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings}}', workerId))
assert.ok(Object.values(workerNetwork.Ports ?? {}).every((bindings) => bindings === null || bindings.length === 0),
  'outbox-worker must not publish any host ports')

console.log('Web, backend proxy, internal AI connectivity, AI network isolation, and outbox-worker liveness verified.')
