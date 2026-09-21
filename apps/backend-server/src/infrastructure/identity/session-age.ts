import { errors } from '../../shared/app-error.js'

/**
 * ログイン維持の上限（ADR 0001 §4）。
 *
 * token の自動更新だけでは、この上限を延長しない。`exp` ではなく
 * `auth_time`（最後にログイン・再認証した時刻）を見るのはそのため。
 */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

/**
 * `auth_time` からログイン維持の7日上限を検証する。
 *
 * `auth_time` が無いトークンは、`requireAuthTime` なら 401 で拒否する（Firebase の
 * ID トークンには必ず入る。無いものを通すと上限をすり抜ける）。static-jwks の
 * 試験用トークンだけ、`requireAuthTime:false` で判定の対象外にする。
 * 上限超過は 401（`details.reason: 'SESSION_EXPIRED'`）。
 */
export function assertWithinSessionCap(
  authTimeSeconds: number | undefined,
  nowSeconds: number,
  clockToleranceSeconds: number,
  requireAuthTime: boolean,
): void {
  if (authTimeSeconds === undefined) {
    if (!requireAuthTime) return
    throw errors.unauthenticated({
      message: 'ログイン時刻を確認できないトークンです。再度ログインしてください。',
      details: { reason: 'AUTH_TIME_REQUIRED' },
    })
  }
  if (nowSeconds - authTimeSeconds > SESSION_MAX_AGE_SECONDS + clockToleranceSeconds) {
    throw errors.unauthenticated({
      message: 'ログインから7日以上経過しました。再度ログインしてください。',
      details: { reason: 'SESSION_EXPIRED' },
    })
  }
}
