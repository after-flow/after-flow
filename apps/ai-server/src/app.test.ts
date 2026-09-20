import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createApp } from './app.js'

it('serves internal liveness without exposing public business routes', async () => {
  const app = createApp()
  const response = await app.request('/internal/v1/health')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  assert.deepEqual((await response.json()).data, { service: 'ai-server', status: 'ok' })
  assert.equal((await app.request('/api/v1/health')).status, 404)
  assert.equal((await app.request('/api/v1/cases')).status, 404)
})
