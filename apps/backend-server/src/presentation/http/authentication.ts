import { createMiddleware } from 'hono/factory'
import type { AccessService } from '../../application/authorization/case-access.js'
import type { AuthenticatedUser, TokenVerifier } from '../../application/ports/identity.js'
import { errors } from '../../shared/app-error.js'
import type { AppContext, AppEnv } from './context.js'

/**
 * Bearer トークンから認証済み利用者を導出する。
 *
 * トークン本体はログにも応答にも残さない。検証の失敗理由も応答では
 * 区別せず、内部ログにのみ残す。理由を返すとトークンの当て推量を助ける。
 */
export function authentication(verifier: TokenVerifier, access: AccessService) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('Authorization')
    if (header !== undefined) {
      const token = bearerToken(header)
      const identity = await verifier.verify(token)
      // トークンの tenant 主張を membership で裏取りする。
      c.set('user', await access.authenticate(identity))
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

/** 認証が必要な route で利用者を取り出す。未認証はここで止まる。 */
export function requireUser(c: AppContext): AuthenticatedUser {
  const user = c.get('user')
  if (!user) throw errors.unauthenticated()
  return user
}
