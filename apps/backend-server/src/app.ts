import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppEnv } from './presentation/http/context.js'
import { handleError, handleNotFound } from './presentation/http/error-handler.js'
import { requestId } from './presentation/http/request-id.js'
import type { AppContext } from './presentation/http/context.js'
import type { RegisteredRoute } from './presentation/http/route.js'
import { registerRoutes } from './presentation/http/route.js'
import { healthRoute } from './presentation/routes/public/v1/health.js'
import { errors } from './shared/app-error.js'

/**
 * JSON 要求の上限。
 * 原本アップロード (#8) は multipart で別の上限を持つため、その route 側で上書きする。
 */
export const MAX_JSON_BODY_BYTES = 1024 * 1024

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
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono<AppEnv>()

  // requestId は最初に設定する。以降のあらゆる応答が meta.requestId を持つ。
  app.use('*', requestId)
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_JSON_BODY_BYTES,
      onError: () => {
        throw errors.payloadTooLarge({ details: { maxBytes: MAX_JSON_BODY_BYTES } })
      },
    }),
  )

  // 例外と未定義 path を共通契約へ落とす。route 側で status を書き分けない。
  app.onError(handleError)
  app.notFound(handleNotFound)

  const v1 = new Hono<AppEnv>()
  if (options.authentication) v1.use('*', options.authentication)
  registerRoutes(v1, options.routes ?? [healthRoute], {
    ...(options.consentGate ? { consentGate: options.consentGate } : {}),
  })
  app.route('/api/v1', v1)

  return app
}
