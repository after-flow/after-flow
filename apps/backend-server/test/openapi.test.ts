import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildOpenApiDocument } from '../src/presentation/openapi/document.js'
import { publicV1Specs } from '../src/presentation/routes/public/v1/index.js'
import { fixtureRoutes } from './helpers/fixture-routes.js'

const fixtureSpecs = fixtureRoutes.map((route) => route.spec)

const options = { version: '0.0.0-test', basePath: '/api/v1' }

describe('OpenAPI の生成', () => {
  it('公開 route をすべて載せる', () => {
    const document = buildOpenApiDocument(publicV1Specs, options)
    for (const spec of publicV1Specs) {
      const path = spec.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
      assert.ok(document.paths[path]?.[spec.method], `${spec.method} ${path} が欠けている`)
    }
  })

  it('path と query のパラメーターを宣言する', () => {
    const document = buildOpenApiDocument(fixtureSpecs, options)
    const operation = document.paths['/cases/{caseId}/fixtures']?.get as any
    const byName = Object.fromEntries(operation.parameters.map((p: any) => [p.name, p]))
    assert.equal(byName.caseId.in, 'path')
    assert.equal(byName.caseId.required, true)
    assert.equal(byName.limit.in, 'query')
    assert.equal(byName.limit.required, false)
  })

  it('冪等性が必要な操作はヘッダーを必須として宣言する', () => {
    const document = buildOpenApiDocument(fixtureSpecs, options)
    const operation = document.paths['/cases/{caseId}/fixtures']?.post as any
    const key = operation.parameters.find((p: any) => p.name === 'Idempotency-Key')
    assert.equal(key.in, 'header')
    assert.equal(key.required, true)
  })

  it('宣言した失敗を status ごとにまとめ、INTERNAL を必ず含める', () => {
    const document = buildOpenApiDocument(fixtureSpecs, options)
    const operation = document.paths['/cases/{caseId}/fixtures']?.post as any
    assert.ok(operation.responses['400'])
    assert.ok(operation.responses['428'])
    assert.match(operation.responses['409'].description, /IDEMPOTENCY_KEY_REUSED/)
    assert.ok(operation.responses['500'], 'INTERNAL が自動で加わる')
  })

  it('認証が必要な route に security を付ける', () => {
    const document = buildOpenApiDocument(fixtureSpecs, options)
    const operation = document.paths['/cases/{caseId}/fixtures']?.get as any
    assert.deepEqual(operation.security, [{ bearerAuth: [] }])
  })

  it('同じ method と path の二重登録を拒否する', () => {
    assert.throws(
      () => buildOpenApiDocument([...publicV1Specs, ...publicV1Specs], options),
      /duplicate route/,
    )
  })
})
