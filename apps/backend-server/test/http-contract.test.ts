import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createApp, MAX_JSON_BODY_BYTES } from '../src/app.js'
import { fixtureRoutes, stubAuthentication } from './helpers/fixture-routes.js'

const app = createApp({ routes: fixtureRoutes, authentication: stubAuthentication })

async function call(path: string, init: RequestInit = {}) {
  const response = await app.request(`http://localhost/api/v1${path}`, init)
  const text = await response.text()
  return { response, body: text ? (JSON.parse(text) as Record<string, any>) : null }
}

function jsonInit(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }
}

describe('成功応答の共通契約', () => {
  it('data と meta.requestId を返す', async () => {
    const { response, body } = await call('/cases/case-1/fixtures')
    assert.equal(response.status, 200)
    assert.equal(body?.data.caseId, 'case-1')
    assert.match(body?.meta.requestId, /^[0-9a-f-]{36}$/)
  })

  it('既定の limit を適用し、次ページのカーソルを meta へ入れる', async () => {
    const { body } = await call('/cases/case-1/fixtures')
    assert.equal(body?.data.limit, 50)
    assert.equal(body?.meta.nextCursor, 'bmV4dA')
  })

  it('limit と cursor を query から受け取る', async () => {
    const { body } = await call('/cases/case-1/fixtures?limit=10&cursor=YWJj')
    assert.equal(body?.data.limit, 10)
    assert.equal(body?.data.cursor, 'YWJj')
  })

  it('応答ヘッダーにも requestId を返す', async () => {
    const { response, body } = await call('/cases/case-1/fixtures')
    assert.equal(response.headers.get('X-Request-Id'), body?.meta.requestId)
  })
})

describe('requestId の引き継ぎ', () => {
  it('安全な形式の X-Request-Id はそのまま引き継ぐ', async () => {
    const { body } = await call('/cases/case-1/fixtures', {
      headers: { 'X-Request-Id': 'client-req-0001' },
    })
    assert.equal(body?.meta.requestId, 'client-req-0001')
  })

  it('長大な値は引き継がず採番する', async () => {
    const hostile = 'x'.repeat(200)
    const { body } = await call('/cases/case-1/fixtures', {
      headers: { 'X-Request-Id': hostile },
    })
    assert.notEqual(body?.meta.requestId, hostile)
    assert.match(body?.meta.requestId, /^[0-9a-f-]{36}$/)
  })

  it('字種が異なる値は引き継がない', async () => {
    // HTTP 層が弾く制御文字と違い、空白や記号はヘッダーとして通る。
    // ログの列を壊す値を requestId にしないことを確かめる。
    for (const hostile of ['req id with spaces', 'req"quoted"id', 'req,comma,id']) {
      const { body } = await call('/cases/case-1/fixtures', {
        headers: { 'X-Request-Id': hostile },
      })
      assert.notEqual(body?.meta.requestId, hostile)
    }
  })
})

describe('入力検証', () => {
  it('query が契約を満たさない場合は 400 と該当項目を返す', async () => {
    const { response, body } = await call('/cases/case-1/fixtures?limit=9999')
    assert.equal(response.status, 400)
    assert.equal(body?.error.code, 'VALIDATION_FAILED')
    assert.equal(body?.error.retryable, false)
    assert.equal(body?.error.details.source, 'query')
    assert.equal(body?.error.details.issues[0].path, 'limit')
    assert.ok(body?.meta.requestId)
  })

  it('path パラメーターの字種違反を拒否する', async () => {
    const { response, body } = await call('/cases/..%2Fother/fixtures')
    assert.equal(response.status, 400)
    assert.equal(body?.error.details.source, 'params')
  })

  it('body が契約を満たさない場合は 400 を返す', async () => {
    const { response, body } = await call(
      '/cases/case-1/fixtures',
      jsonInit({ note: '' }, { 'Idempotency-Key': 'idem-0000001' }),
    )
    assert.equal(response.status, 400)
    assert.equal(body?.error.details.source, 'body')
    assert.equal(body?.error.details.issues[0].path, 'note')
  })

  it('入力値そのものをエラー応答へ写さない', async () => {
    const secret = 'PATIENT-NAME-9999999'
    const { body } = await call(
      '/cases/case-1/fixtures',
      jsonInit({ note: secret.repeat(20) }, { 'Idempotency-Key': 'idem-0000001' }),
    )
    assert.equal(body?.error.code, 'VALIDATION_FAILED')
    assert.ok(!JSON.stringify(body).includes(secret))
  })

  it('壊れた JSON は 400 として扱う', async () => {
    const { response, body } = await call('/cases/case-1/fixtures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-0000001' },
      body: '{"note":',
    })
    assert.equal(response.status, 400)
    assert.equal(body?.error.code, 'VALIDATION_FAILED')
  })

  it('JSON 以外の Content-Type は 415 を返す', async () => {
    const { response, body } = await call('/cases/case-1/fixtures', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Idempotency-Key': 'idem-0000001' },
      body: 'note=x',
    })
    assert.equal(response.status, 415)
    assert.equal(body?.error.code, 'UNSUPPORTED_MEDIA_TYPE')
  })

  it('上限を超える body は 413 を返す', async () => {
    const { response, body } = await call('/cases/case-1/fixtures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-0000001' },
      body: 'x'.repeat(MAX_JSON_BODY_BYTES + 1),
    })
    assert.equal(response.status, 413)
    assert.equal(body?.error.code, 'PAYLOAD_TOO_LARGE')
  })
})

describe('冪等性キーと版の前提条件', () => {
  it('必須の Idempotency-Key が無い場合は 428 を返す', async () => {
    const { response, body } = await call('/cases/case-1/fixtures', jsonInit({ note: 'x' }))
    assert.equal(response.status, 428)
    assert.equal(body?.error.code, 'PRECONDITION_REQUIRED')
    assert.equal(body?.error.details.header, 'Idempotency-Key')
  })

  it('形式が不正な Idempotency-Key を拒否する', async () => {
    const { response, body } = await call(
      '/cases/case-1/fixtures',
      jsonInit({ note: 'x' }, { 'Idempotency-Key': 'short' }),
    )
    assert.equal(response.status, 400)
    assert.equal(body?.error.code, 'VALIDATION_FAILED')
  })

  it('有効なキーは handler へ渡る', async () => {
    const { body } = await call(
      '/cases/case-1/fixtures',
      jsonInit({ note: 'x' }, { 'Idempotency-Key': 'idem-0000001' }),
    )
    assert.equal(body?.data.idempotencyKey, 'idem-0000001')
  })

  it('expectedVersion の欠落は検証エラーではなく 428 で返す', async () => {
    const { response, body } = await call('/cases/case-1/fixtures/f-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'x' }),
    })
    assert.equal(response.status, 428)
    assert.equal(body?.error.code, 'PRECONDITION_REQUIRED')
    assert.equal(body?.error.details.field, 'expectedVersion')
  })

  it('expectedVersion を指定した更新は通る', async () => {
    const { response, body } = await call('/cases/case-1/fixtures/f-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 4, note: 'x' }),
    })
    assert.equal(response.status, 200)
    assert.equal(body?.data.limit, 4)
  })
})

describe('エラー応答', () => {
  it('既知エラーは code・status・retryable・details を保つ', async () => {
    const { response, body } = await call('/fixtures/known-failure')
    assert.equal(response.status, 409)
    assert.equal(body?.error.code, 'CONFLICT')
    assert.equal(body?.error.retryable, false)
    assert.equal(body?.error.details.actualVersion, 5)
  })

  it('internal に入れた情報は応答へ出さない', async () => {
    const { body } = await call('/fixtures/known-failure')
    assert.ok(!JSON.stringify(body).includes('must-not-be-returned'))
  })

  it('予期しない例外は 500 の固定文言になり、内部情報を漏らさない', async () => {
    const { response, body } = await call('/fixtures/unexpected-failure')
    assert.equal(response.status, 500)
    assert.equal(body?.error.code, 'INTERNAL')
    assert.equal(body?.error.retryable, false)
    assert.ok(!JSON.stringify(body).includes('postgres://'))
    assert.ok(!JSON.stringify(body).includes('stack'))
    assert.ok(body?.meta.requestId)
  })

  it('未定義の path も共通のエラー契約で返す', async () => {
    const { response, body } = await call('/not-a-real-endpoint')
    assert.equal(response.status, 404)
    assert.equal(body?.error.code, 'NOT_FOUND')
    assert.ok(body?.meta.requestId)
  })

  it('一時障害は retryable を true にする', async () => {
    const { errors: appErrors } = await import('../src/shared/app-error.js')
    assert.equal(appErrors.unavailable().retryable, true)
    assert.equal(appErrors.rateLimited().retryable, true)
    assert.equal(appErrors.internal().retryable, false)
  })
})

describe('認証が必要な route の既定', () => {
  it('認証 middleware が無い構成では 401 になる', async () => {
    // 設定漏れが「誰でも通る API」ではなく「誰も通れない API」になることを確かめる。
    const unconfigured = createApp({ routes: fixtureRoutes })
    const response = await unconfigured.request('http://localhost/api/v1/cases/case-1/fixtures')
    assert.equal(response.status, 401)
    const body = (await response.json()) as Record<string, any>
    assert.equal(body.error.code, 'UNAUTHENTICATED')
    assert.equal(body.error.retryable, false)
  })

  it('公開 route は認証が無くても通る', async () => {
    const unconfigured = createApp()
    const response = await unconfigured.request('http://localhost/api/v1/health')
    assert.equal(response.status, 200)
  })
})
