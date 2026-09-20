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
  const publicRoute = await fetch('http://ai-server:8081/api/v1/health', {
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(publicRoute.status, 404)
`)

const aiId = docker('compose', 'ps', '--quiet', 'ai-server')
assert.ok(aiId, 'AI container must be running')
const aiNetwork = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings}}', aiId))
assert.ok(Object.values(aiNetwork.Ports ?? {}).every((bindings) => bindings === null || bindings.length === 0),
  'AI must not publish any host ports')

// Inspect live network membership: DNS failure codes vary across Docker hosts,
// and a transient DNS failure alone is not evidence of network isolation.
const webId = docker('compose', 'ps', '--quiet', 'web')
assert.ok(webId, 'Web container must be running')
const webNetworks = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', webId))
const aiNetworkIds = Object.values(aiNetwork.Networks).map((network) => network.NetworkID)
const webNetworkIds = Object.values(webNetworks).map((network) => network.NetworkID)
assert.ok(aiNetworkIds.length > 0 && webNetworkIds.length > 0, 'Both services must be networked')
assert.ok(webNetworkIds.every((id) => !aiNetworkIds.includes(id)), 'Web and AI must not share a network')

console.log('Web, backend proxy, internal AI connectivity, and AI network isolation verified.')
