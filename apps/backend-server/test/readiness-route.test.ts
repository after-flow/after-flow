import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ReadinessService, syncCheck } from '../src/application/operations/readiness-service.js'
import { createApp } from '../src/app.js'
import { createReadinessApp } from '../src/presentation/routes/internal/v1/readiness.js'
import { buildOpenApiDocument } from '../src/presentation/openapi/document.js'
import { buildInternalOpenApiDocument } from '../src/presentation/openapi/internal-document.js'
import { publicV1Specs } from '../src/presentation/routes/public/v1/index.js'

const TOKEN = 'readiness-test-token-0123456789'

function appWith(service: ReadinessService) {
  return createApp({ readinessApp: createReadinessApp({ service, accessToken: TOKEN }) })
}

describe('内部readiness endpoint', () => {
  it('正しいtokenかつ全検査okなら200でreadyを返す', async () => {
    const service = new ReadinessService([syncCheck('ok', () => ({ ok: true }))])
    const response = await appWith(service).request('/internal/v1/health/ready', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, any>
    assert.equal(body.data.status, 'ready')
    assert.deepEqual(body.data.checks, [{ name: 'ok', status: 'ok' }])
    assert.ok(body.meta.requestId)
  })

  it('1つでも失敗していれば503を返し、理由コードを含める', async () => {
    const service = new ReadinessService([syncCheck('firestore', () => ({ ok: false, reason: 'NOT_CONFIGURED' }))])
    const response = await appWith(service).request('/internal/v1/health/ready', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(response.status, 503)
    const body = (await response.json()) as Record<string, any>
    assert.equal(body.error.code, 'UNAVAILABLE')
    assert.equal(body.error.retryable, true)
    assert.equal(body.error.details.status, 'not_ready')
    assert.deepEqual(body.error.details.checks, [{ name: 'firestore', status: 'fail', reason: 'NOT_CONFIGURED' }])
  })

  it('Authorizationヘッダーが無い/不正なら401を返し、検査を実行しない', async () => {
    let ran = false
    const service = new ReadinessService([{ name: 'spy', run: async () => { ran = true; return { ok: true } } }])
    const app = appWith(service)

    const missing = await app.request('/internal/v1/health/ready')
    assert.equal(missing.status, 401)

    const wrong = await app.request('/internal/v1/health/ready', {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    assert.equal(wrong.status, 401)
    assert.equal(ran, false)
  })

  it('AIの内部実行APIとは別のtokenで、AI側のtokenでは通らない', async () => {
    const service = new ReadinessService([syncCheck('ok', () => ({ ok: true }))])
    const response = await appWith(service).request('/internal/v1/health/ready', {
      headers: { Authorization: 'Bearer some-ai-service-token' },
    })
    assert.equal(response.status, 401)
  })

  it('未mount(readinessApp未指定)なら404で、公開liveness(/api/v1/health)には影響しない', async () => {
    const app = createApp()
    assert.equal((await app.request('/internal/v1/health/ready')).status, 404)
    const liveness = await app.request('/api/v1/health')
    assert.equal(liveness.status, 200)
    assert.deepEqual((await liveness.json()).data, { service: 'backend-server', status: 'ok' })
  })

  it('readinessのpathは公開OpenAPIにも内部AI実行API OpenAPIにも現れない', () => {
    const publicApi = buildOpenApiDocument(publicV1Specs, { version: 'test', basePath: '/api/v1' })
    const internalApi = buildInternalOpenApiDocument()
    assert.equal(publicApi.paths['/health/ready'], undefined)
    assert.equal(internalApi.paths['/health/ready'], undefined)
    assert.equal(Object.keys(publicApi.paths).some((path) => path.includes('health/ready')), false)
    assert.equal(Object.keys(internalApi.paths).some((path) => path.includes('health/ready')), false)
  })

  it('readiness応答はenvelopeのdata直下にstatus/checksを持つ（公開APIのenvelopeと同型のまま別contract）', async () => {
    const service = new ReadinessService([syncCheck('ok', () => ({ ok: true }))])
    const app = appWith(service)
    const response = await app.request('/internal/v1/health/ready', { headers: { Authorization: `Bearer ${TOKEN}` } })
    const body = (await response.json()) as Record<string, any>
    assert.ok('status' in body.data)
    assert.ok('checks' in body.data)
  })
})
