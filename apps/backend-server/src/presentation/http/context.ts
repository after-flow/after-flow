import type { Context } from 'hono'
import type { AuthenticatedUser, VerifiedIdentity } from '../../application/ports/identity.js'

/**
 * Hono の context に載せる値。
 *
 * `identity` はトークン検証だけを通った結果（tenant の membership 未確認）。
 * `user` は `identity` を tenant の membership で裏取りできた結果だけを入れる。
 * 要求本文から組み立てた値をここへ入れない。
 */
export interface AppVariables {
  requestId: string
  identity?: VerifiedIdentity
  user?: AuthenticatedUser
}

export interface AppEnv {
  Variables: AppVariables
}

export type AppContext = Context<AppEnv>

/** requestId は middleware が必ず設定するため、未設定は実装の誤り。 */
export function requestIdOf(c: AppContext): string {
  const requestId = c.get('requestId')
  if (!requestId) throw new Error('requestId middleware is not installed')
  return requestId
}
