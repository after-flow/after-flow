import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createApp } from '../src/app.js'

it('serves public liveness without exposing the AI internal API', async () => {
  const app = createApp()
  const response = await app.request('/api/v1/health')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  assert.deepEqual((await response.json()).data, { service: 'backend-server', status: 'ok' })
  assert.equal((await app.request('/internal/v1/health')).status, 404)
  assert.equal((await app.request('/api/v1/missing')).status, 404)
})
