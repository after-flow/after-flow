import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const base = `http://127.0.0.1:${process.env.WEB_PORT || '4173'}`
function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 20_000 }).trim()
}
async function request(path, status = 200) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, status, path)
  return response
}

const index = await (await request('/')).text()
assert.match(index, /<title>after-flow<\/title>/)
assert.equal(await (await request('/cases/example/tasks')).text(), index)
const script = index.match(/src="([^"]+\.js)"/)?.[1]
assert.ok(script, 'Production HTML must reference a built JS asset')
const asset = await request(script)
assert.match(asset.headers.get('content-type'), /javascript/)
assert.doesNotMatch(await asset.text(), /Mock Service Worker|setupWorker/)
await request('/assets/nonexistent.js', 404)
await request('/mockServiceWorker.js', 404)
await request('/internal/v1/health', 404)
await request('/.env', 404)
await request('/api/v1/nonexistent', 404)
assert.equal((await (await request('/api/v1/health')).json()).data.service, 'backend-server')
assert.equal((await (await request('/healthz')).json()).data.service, 'web')

docker('compose', 'exec', '-T', 'backend-server', 'node', '--input-type=module', '-e', `
  import assert from 'node:assert/strict'
  const response = await fetch('http://ai-server:8080/internal/v1/health')
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.service, 'ai-server')
  assert.equal((await fetch('http://ai-server:8080/api/v1/health')).status, 404)
`)

const containers = Object.fromEntries(['web', 'backend-server', 'ai-server'].map((service) => {
  const id = docker('compose', 'ps', '--quiet', service)
  const [info] = JSON.parse(docker('inspect', id))
  assert.ok(info.Config.User && !['root', '0', '0:0'].includes(info.Config.User), `${service}: non-root required`)
  assert.equal(info.Mounts.length, 0, `${service}: production must not mount source files`)
  if (service !== 'web') {
    assert.ok(Object.values(info.NetworkSettings.Ports).every((ports) => ports === null), `${service}: no host ports`)
    docker('compose', 'exec', '-T', service, 'node', '--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import { existsSync } from 'node:fs'
      assert.equal(existsSync('src'), false)
      assert.equal(existsSync('node_modules/tsx'), false)
      assert.equal(existsSync('dist/app.test.js'), false)
    `)
  }
  return [service, info]
}))
const networks = (service) => Object.values(containers[service].NetworkSettings.Networks).map((net) => net.NetworkID)
assert.ok(networks('web').every((id) => !networks('ai-server').includes(id)), 'Web must be isolated from AI')
console.log('Production SPA, assets, API proxy, internal AI HTTP, non-root images and isolation verified.')
