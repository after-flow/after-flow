import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import { apiDocsEnabled } from '../src/composition.js'
import { fixtureRoutes } from './helpers/fixture-routes.js'

describe('ローカルAPIドキュメント', () => {
  it('Swagger UIと実routeから生成した公開OpenAPIを配信する', async () => {
    const app = createApp({ routes: fixtureRoutes, apiDocs: true })

    const ui = await app.request('/api-docs')
    assert.equal(ui.status, 200)
    assert.match(ui.headers.get('content-type') ?? '', /^text\/html/)
    assert.match(await ui.text(), /SwaggerUIBundle/)

    const specification = await app.request('/api-docs/openapi.json')
    assert.equal(specification.status, 200)
    const document = await specification.json() as any
    assert.equal(document.openapi, '3.0.3')
    assert.deepEqual(document.servers, [{ url: '/api/v1' }])
    assert.ok(document.paths['/cases/{caseId}/fixtures'])
    assert.equal(document.paths['/internal/v1'], undefined)

    const css = await app.request('/api-docs/assets/swagger-ui.css')
    assert.equal(css.status, 200)
    assert.match(css.headers.get('content-type') ?? '', /^text\/css/)
    assert.ok((await css.arrayBuffer()).byteLength > 1_000)
  })

  it('無効時はドキュメント画面を公開しない', async () => {
    const app = createApp({ routes: fixtureRoutes, apiDocs: false })
    assert.equal((await app.request('/api-docs')).status, 404)
    assert.equal((await app.request('/api-docs/openapi.json')).status, 404)
  })

  it('開発では既定で有効、本番では既定で無効にする', () => {
    assert.equal(apiDocsEnabled({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), true)
    assert.equal(apiDocsEnabled({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), false)
    assert.equal(apiDocsEnabled({ NODE_ENV: 'production', API_DOCS_ENABLED: 'true' } as NodeJS.ProcessEnv), true)
    assert.equal(apiDocsEnabled({ API_DOCS_ENABLED: 'false' } as NodeJS.ProcessEnv), false)
    assert.throws(
      () => apiDocsEnabled({ API_DOCS_ENABLED: 'yes' } as NodeJS.ProcessEnv),
      /must be true or false/,
    )
  })
})
