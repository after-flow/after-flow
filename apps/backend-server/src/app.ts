import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppEnv } from './presentation/http/context.js'
import { handleError, handleNotFound } from './presentation/http/error-handler.js'
import { requestId } from './presentation/http/request-id.js'
import type { RegisteredRoute } from './presentation/http/route.js'
import { registerRoutes } from './presentation/http/route.js'
import { publicV1Routes } from './presentation/routes/public/v1/index.js'
import { errors } from './shared/app-error.js'

/**
 * JSON 要求の上限。
 * 原本アップロード (#8) は multipart で別の上限を持つため、その route 側で上書きする。
 */
export const MAX_JSON_BODY_BYTES = 1024 * 1024

/**
 * 公開サーバーの構成。
 *
 * routes を差し替えられるようにしてあるのは、基盤（検証・エラー契約・
 * requestId）を本番の route 一覧に依存せず試験するため。
 */
export function createApp(routes: RegisteredRoute[] = publicV1Routes) {
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
  registerRoutes(v1, routes)
  app.route('/api/v1', v1)

  return app
}
