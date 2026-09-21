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
 * `auth_time` が無いトークン（static-jwks 等、ADR の対象外の検証経路）は
 * 判定の対象外として通す。上限超過は 401（`details.reason: 'SESSION_EXPIRED'`）。
 * トークン自体は正当なので、他の失敗理由と区別して案内できるようにする。
 */
export function assertWithinSessionCap(
  authTimeSeconds: number | undefined,
  nowSeconds: number,
  clockToleranceSeconds: number,
): void {
  if (authTimeSeconds === undefined) return
  if (nowSeconds - authTimeSeconds > SESSION_MAX_AGE_SECONDS + clockToleranceSeconds) {
    throw errors.unauthenticated({
      message: 'ログインから7日以上経過しました。再度ログインしてください。',
      details: { reason: 'SESSION_EXPIRED' },
    })
  }
}
