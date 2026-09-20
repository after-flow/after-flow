import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import type { Hono } from 'hono'
import type { AppContext, AppEnv } from '../http/context.js'
import type { RouteSpec } from '../http/route.js'
import {
  buildOpenApiDocument,
  PUBLIC_API_BASE_PATH,
  PUBLIC_API_VERSION,
} from './document.js'

const API_DOCS_PATH = '/api-docs'
const OPENAPI_PATH = `${API_DOCS_PATH}/openapi.json`
const ASSET_PATH = `${API_DOCS_PATH}/assets`

const require = createRequire(import.meta.url)

const assets = {
  'swagger-ui.css': {
    contentType: 'text/css; charset=utf-8',
    path: require.resolve('swagger-ui-dist/swagger-ui.css'),
  },
  'swagger-ui-bundle.js': {
    contentType: 'text/javascript; charset=utf-8',
    path: require.resolve('swagger-ui-dist/swagger-ui-bundle.js'),
  },
} as const

type AssetName = keyof typeof assets

const assetContents = new Map<AssetName, Promise<ArrayBuffer>>()

function readAsset(name: AssetName): Promise<ArrayBuffer> {
  const cached = assetContents.get(name)
  if (cached) return cached
  const content = readFile(assets[name].path).then((value) => {
    const copy = new Uint8Array(value.byteLength)
    copy.set(value)
    return copy.buffer
  })
  assetContents.set(name, content)
  return content
}

function docsHtml(): string {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="after-flow 公開APIのローカルテスト画面" />
    <title>after-flow 公開API</title>
    <link rel="stylesheet" href="${ASSET_PATH}/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${ASSET_PATH}/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '${OPENAPI_PATH}',
        dom_id: '#swagger-ui',
        deepLinking: true,
        displayRequestDuration: true,
        filter: true,
        operationsSorter: 'alpha',
        tagsSorter: 'alpha',
        tryItOutEnabled: true,
        requestSnippetsEnabled: true,
        persistAuthorization: false,
        validatorUrl: null
      })
    </script>
  </body>
</html>`
}

const docsHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
} as const

/**
 * ローカル開発用の公開APIテスト画面。
 *
 * internal OpenAPI は渡さず、実際にmountした公開routeから文書を組み立てる。
 * UI資産も同じサーバーから配信し、仕様やBearer tokenを外部CDNへ送らない。
 */
export function registerApiDocs(app: Hono<AppEnv>, specs: RouteSpec[]): void {
  const document = buildOpenApiDocument(specs, {
    version: PUBLIC_API_VERSION,
    basePath: PUBLIC_API_BASE_PATH,
  })

  const renderDocs = (c: AppContext) => c.html(docsHtml(), 200, docsHeaders)

  app.get(API_DOCS_PATH, renderDocs)
  app.get(`${API_DOCS_PATH}/`, renderDocs)
  app.get(OPENAPI_PATH, (c) => c.json(document, 200, docsHeaders))

  for (const name of Object.keys(assets) as AssetName[]) {
    app.get(`${ASSET_PATH}/${name}`, async (c) => {
      return c.body(await readAsset(name), 200, {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': assets[name].contentType,
        'X-Content-Type-Options': 'nosniff',
      })
    })
  }
}
