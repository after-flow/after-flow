import { createMiddleware } from 'hono/factory'
import type { AccessService } from '../../application/authorization/case-access.js'
import type { AuthenticatedUser, TokenVerifier, VerifiedIdentity } from '../../application/ports/identity.js'
import { errors } from '../../shared/app-error.js'
import type { AppContext, AppEnv } from './context.js'

/**
 * Bearer トークンから認証済み利用者を導出する。
 *
 * トークン本体はログにも応答にも残さない。検証の失敗理由も応答では
 * 区別せず、内部ログにのみ残す。理由を返すとトークンの当て推量を助ける。
 *
 * `identity`（トークン検証済み）と `user`（tenant の membership で
 * 裏取り済み）を分けて `context` に持たせる。未登録の利用者でも
 * `identity` は設定され、`GET/POST /me`（`auth:'identity'`）へ到達できる。
 * tenant は配備単位の `tenantId` を使う（トークンの主張ではない）。
 */
export function authentication(verifier: TokenVerifier, access: AccessService, tenantId: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('Authorization')
    if (header !== undefined) {
      const token = bearerToken(header)
      const identity = await verifier.verify(token)
      c.set('identity', identity)
      // membership が無い（未登録）場合は resolveUser が null を返す。
      // ここでは 403 にせず、route 層（`auth:'user'` の判定）に委ねる。
      const user = await access.resolveUser(identity, tenantId)
      if (user) c.set('user', user)
    }
    await next()
  })
}

function bearerToken(header: string): string {
  const match = /^Bearer (?<token>[A-Za-z0-9._~+/-]+=*)$/.exec(header)
  const token = match?.groups?.token
  if (!token) {
    throw errors.unauthenticated({ internal: { reason: 'malformed authorization header' } })
  }
  return token
}

/** 認証が必要な route で利用者を取り出す。未認証・未登録はここで止まる。 */
export function requireUser(c: AppContext): AuthenticatedUser {
  const user = c.get('user')
  if (!user) throw errors.unauthenticated()
  return user
}

/** `auth:'identity'` の route で識別済み利用者を取り出す。未認証はここで止まる。 */
export function requireIdentity(c: AppContext): VerifiedIdentity {
  const identity = c.get('identity')
  if (!identity) throw errors.unauthenticated()
  return identity
}
