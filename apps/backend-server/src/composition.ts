import type { MiddlewareHandler } from 'hono'
import { AccessService } from './application/authorization/case-access.js'
import { createFirestore, readFirestoreConfig } from './infrastructure/firestore/client.js'
import { FirestoreReadRepository } from './infrastructure/firestore/read-repository.js'
import { createTokenVerifier, readAuthConfig } from './infrastructure/identity/config.js'
import { authentication } from './presentation/http/authentication.js'
import type { AppEnv } from './presentation/http/context.js'
import { logger } from './presentation/http/logger.js'

/**
 * 実行時の組み立て。
 *
 * 認証 Provider は未決定（仕様書 19 章）で、Firestore の接続先も
 * 開発環境では未設定のことがある。設定が無い場合は機能を無効のままにし、
 * 「検証を省略して通す」既定には絶対にしない。
 * `auth: 'user'` の route は認証 middleware が無ければ 401 になる。
 */
export function createAuthentication(
  env: NodeJS.ProcessEnv = process.env,
): MiddlewareHandler<AppEnv> | undefined {
  if (!env.AUTH_ISSUER) {
    logger.warn('authentication is not configured', {
      // 設定が無いこと自体を毎回はっきり残す。無効のまま本番へ出さないため。
      effect: 'routes that require a user will reject every request with 401',
      required: ['AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URI'],
    })
    return undefined
  }
  if (!env.FIRESTORE_PROJECT_ID && !env.GOOGLE_CLOUD_PROJECT) {
    // membership を確認できなければ、トークンの tenant 主張を裏取りできない。
    logger.warn('authentication is disabled because the business database is not configured', {
      effect: 'routes that require a user will reject every request with 401',
    })
    return undefined
  }

  const read = new FirestoreReadRepository(createFirestore(readFirestoreConfig(env)))
  return authentication(createTokenVerifier(readAuthConfig(env)), new AccessService(read))
}
