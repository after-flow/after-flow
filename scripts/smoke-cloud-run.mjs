import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

export async function verifyDeployment({ url, idToken, service }, request = fetch) {
  assert.ok(url && idToken)
  assert.ok(['web', 'backend-server', 'ai-server'].includes(service))
  assert.equal(new URL(url).protocol, 'https:')
  const endpoints = service === 'web'
    ? [['/healthz', 'web'], ['/api/v1/health', 'backend-server']]
    : [[service === 'ai-server' ? '/internal/v1/health' : '/api/v1/health', service]]

  for (const [path, expected] of endpoints) {
    const response = await request(`${url}${path}`, {
      headers: { 'X-Serverless-Authorization': `Bearer ${idToken}` },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    })
    assert.equal(response.status, 200, `${expected}: ${response.status}`)
    const { data } = await response.json()
    assert.equal(data.service, expected)
    assert.equal(data.status, 'ok')
  }
  if (service === 'ai-server') {
    const response = await request(`${url}/internal/v1/health`, {
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    })
    assert.ok([401, 403].includes(response.status), 'AI must reject unauthenticated invocations')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyDeployment({
    url: process.env.SMOKE_URL,
    idToken: process.env.ID_TOKEN,
    service: process.env.SERVICE,
  })
  console.log(`${process.env.SERVICE} deployment smoke passed`)
}
