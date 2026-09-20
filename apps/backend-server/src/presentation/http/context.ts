import type { Context } from 'hono'

/**
 * Hono の context に載せる値。
 * 認証済み actor は #6 でここへ追加する。
 */
export interface AppVariables {
  requestId: string
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
