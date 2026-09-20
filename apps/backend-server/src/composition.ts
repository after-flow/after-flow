import type { Hono } from 'hono'
import { createApp } from './app.js'
import { AccessService } from './application/authorization/case-access.js'
import { CaseService } from './application/case/case-service.js'
import { ConsentService } from './application/consent/consent-service.js'
import { readConsentCatalog } from './infrastructure/consent/catalog-config.js'
import { createFirestore, readFirestoreConfig } from './infrastructure/firestore/client.js'
import { FirestoreReadRepository } from './infrastructure/firestore/read-repository.js'
import { FirestoreUnitOfWork } from './infrastructure/firestore/unit-of-work.js'
import { createTokenVerifier, readAuthConfig } from './infrastructure/identity/config.js'
import { authentication } from './presentation/http/authentication.js'
import type { AppEnv } from './presentation/http/context.js'
import { logger } from './presentation/http/logger.js'
import { createPublicV1Routes } from './presentation/routes/public/v1/index.js'

/**
 * 実行時の組み立て。
 *
 * 認証 Provider は未決定（仕様書 19 章）で、Firestore の接続先も
 * 開発環境では未設定のことがある。設定が無い場合は、その機能を
 * 「接続されていない」として明示的に拒否する。検証を省略して通す
 * 既定値や、空配列を返して成功に見せる実装にはしない。
 */
export function createServer(env: NodeJS.ProcessEnv = process.env): Hono<AppEnv> {
  const database = createDatabase(env)

  if (!database) {
    logger.warn('business database is not configured', {
      effect: 'business APIs reject every request with FEATURE_NOT_CONNECTED',
      required: ['FIRESTORE_PROJECT_ID'],
    })
    return createApp({ routes: createPublicV1Routes(null) })
  }

  const access = new AccessService(database.read)
  const consentService = new ConsentService(
    readConsentCatalog(env),
    access,
    database.read,
    database.uow,
  )
  const routes = createPublicV1Routes({
    caseService: new CaseService(access, database.read, database.uow),
    consentService,
  })

  // 認証済み利用者にだけ同意を要求する。未認証は先に 401 で止まる。
  const consentGate = async (c: import('./presentation/http/context.js').AppContext) => {
    const user = c.get('user')
    if (user) await consentService.assertBasicConsent(user)
  }

  if (!env.AUTH_ISSUER) {
    // 設定が無いこと自体をはっきり残す。無効のまま本番へ出さないため。
    logger.warn('authentication is not configured', {
      effect: 'routes that require a user reject every request with 401',
      required: ['AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URI'],
    })
    return createApp({ routes, consentGate })
  }

  return createApp({
    routes,
    consentGate,
    authentication: authentication(createTokenVerifier(readAuthConfig(env)), access),
  })
}

function createDatabase(env: NodeJS.ProcessEnv) {
  if (!env.FIRESTORE_PROJECT_ID && !env.GOOGLE_CLOUD_PROJECT) return null
  const firestore = createFirestore(readFirestoreConfig(env))
  return {
    read: new FirestoreReadRepository(firestore),
    uow: new FirestoreUnitOfWork(firestore),
  }
}
