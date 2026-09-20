import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './presentation/http/context.js'
import { handleError, handleNotFound } from './presentation/http/error-handler.js'
import { requestId } from './presentation/http/request-id.js'
import type { Hono as HonoApp } from 'hono'
import type { AppContext } from './presentation/http/context.js'
import type { RegisteredRoute } from './presentation/http/route.js'
import { registerRoutes } from './presentation/http/route.js'
import { healthRoute } from './presentation/routes/public/v1/health.js'
import { registerApiDocs } from './presentation/openapi/api-docs.js'

export interface CreateAppOptions {
  routes?: RegisteredRoute[]
  /**
   * 認証 middleware。
   *
   * 未指定でも `auth: 'user'` の route は 401 になる。設定漏れが
   * 「誰でも通る API」ではなく「誰も通れない API」になるようにしてある。
   */
  authentication?: MiddlewareHandler<AppEnv>
  /**
   * 必須同意の検査。
   *
   * 同意機能が接続されている場合だけ渡す。未接続の環境で検査を
   * 通ったことにしないため、既定では検査しない。
   */
  consentGate?: (c: AppContext) => Promise<void>
  /**
   * AI からの内部 API。
   *
   * 未設定なら公開しない。設定が無いまま内部 API が開いている状態を作らない。
   * ネットワークの分離は配備側の責務。
   */
  internalApp?: HonoApp<AppEnv>
  /** ローカル開発用の公開APIテスト画面。内部APIは含めない。 */
  apiDocs?: boolean
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono<AppEnv>()

  // requestId は最初に設定する。以降のあらゆる応答が meta.requestId を持つ。
  app.use('*', requestId)

  // 例外と未定義 path を共通契約へ落とす。route 側で status を書き分けない。
  app.onError(handleError)
  app.notFound(handleNotFound)

  const routes = options.routes ?? [healthRoute]
  if (options.apiDocs) registerApiDocs(app, routes.map((route) => route.spec))

  const v1 = new Hono<AppEnv>()
  if (options.authentication) v1.use('*', options.authentication)
  registerRoutes(v1, routes, {
    ...(options.consentGate ? { consentGate: options.consentGate } : {}),
  })
  app.route('/api/v1', v1)
  if (options.internalApp) app.route('/internal/v1', options.internalApp)

  return app
}
