import assert from 'node:assert/strict'
import { it } from 'node:test'
import { verifyDeployment } from './smoke-cloud-run.mjs'

const config = { url: 'https://example.run.app', idToken: 'test-token', service: 'web' }
const healthy = (service) => Response.json({ data: { service, status: 'ok' } })

it('checks the web service and Backend proxy with platform auth and no redirects', async () => {
  const paths = []
  await verifyDeployment(config, async (url, options) => {
    paths.push(new URL(url).pathname)
    assert.equal(options.headers['X-Serverless-Authorization'], 'Bearer test-token')
    assert.equal(options.redirect, 'error')
    return healthy(paths.length === 1 ? 'web' : 'backend-server')
  })
  assert.deepEqual(paths, ['/healthz', '/api/v1/health'])
})

it('blocks promotion on HTTP failure, wrong service, or broken proxy', async () => {
  for (const response of [
    () => new Response('unavailable', { status: 503 }),
    () => healthy('ai-server'),
    () => healthy('web'),
  ]) {
    await assert.rejects(verifyDeployment(config, response))
  }
})

it('requires authenticated AI liveness and unauthenticated rejection', async () => {
  const ai = { ...config, service: 'ai-server' }
  for (const denial of [401, 403]) {
    await verifyDeployment(ai, async (_url, options) => (
      options.headers ? healthy('ai-server') : new Response(null, { status: denial })
    ))
  }
  await assert.rejects(verifyDeployment(ai, async () => healthy('ai-server')))
})
