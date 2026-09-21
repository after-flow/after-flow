import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createApp } from '../src/app.js'

describe('生存確認 API', () => {
  it('data と meta を返す', async () => {
    const response = await createApp().request('http://localhost/api/v1/health')
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, any>
    assert.equal(body.data.service, 'backend-server')
    assert.equal(body.data.status, 'ok')
    assert.ok(body.meta.requestId)
  })
})
