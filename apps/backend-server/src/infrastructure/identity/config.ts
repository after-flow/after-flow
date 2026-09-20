import type { TokenVerifier } from '../../application/ports/identity.js'
import type { JwtVerifierConfig } from './jwt-verifier.js'
import { DEFAULT_ALGORITHMS, JwtTokenVerifier, remoteKeySet, staticKeySet } from './jwt-verifier.js'

/**
 * 認証の設定読み込み。
 *
 * 採用 Provider が未決定のため（仕様書 19 章）、issuer・audience・鍵の取得元は
 * すべて設定で受け取る。設定が無いときに「検証を省略して通す」既定値は作らない。
 *
 * 実接続の着手条件:
 *   - 採用する認証 Provider の決定
 *   - その Provider の issuer / audience / JWKS URI
 *   - tenant を載せるクレーム名と、その値を誰が書き込めるか
 * これらが未確定の間、ログイン導線まで完了したとは扱わない。
 */
export type AuthMode = 'jwks' | 'static-jwks'

export interface AuthConfig extends JwtVerifierConfig {
  mode: AuthMode
  /** mode = jwks のときの鍵取得元 */
  jwksUri?: string
  /** mode = static-jwks のときの固定鍵（試験・ローカル専用） */
  staticJwks?: { keys: Record<string, unknown>[] }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`${key} が未設定です。認証の設定を省略した状態で起動しない。`)
  return value
}

export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const mode = (env.AUTH_MODE ?? 'jwks') as AuthMode
  if (mode !== 'jwks' && mode !== 'static-jwks') {
    throw new Error(`AUTH_MODE が不正です: ${String(env.AUTH_MODE)}`)
  }

  // 固定鍵は試験とローカル開発のためのもの。本番相当の環境では選べない。
  if (mode === 'static-jwks' && env.NODE_ENV === 'production') {
    throw new Error('AUTH_MODE=static-jwks は本番では使用できません。')
  }

  const base = {
    mode,
    issuer: required(env, 'AUTH_ISSUER'),
    audience: required(env, 'AUTH_AUDIENCE'),
    algorithms: env.AUTH_ALGORITHMS ? env.AUTH_ALGORITHMS.split(',') : [...DEFAULT_ALGORITHMS],
    tenantClaim: env.AUTH_TENANT_CLAIM ?? 'tenant_id',
    clockToleranceSeconds: Number(env.AUTH_CLOCK_TOLERANCE_SECONDS ?? 5),
  } satisfies Omit<AuthConfig, 'jwksUri' | 'staticJwks'>

  if (base.algorithms.some((algorithm) => !algorithm.startsWith('RS') && !algorithm.startsWith('ES'))) {
    // 対称鍵や none を許すと、公開鍵を知る者が署名を作れてしまう。
    throw new Error('AUTH_ALGORITHMS には非対称鍵の署名方式のみを指定してください。')
  }

  if (mode === 'static-jwks') {
    return { ...base, staticJwks: JSON.parse(required(env, 'AUTH_STATIC_JWKS')) }
  }
  return { ...base, jwksUri: required(env, 'AUTH_JWKS_URI') }
}

export function createTokenVerifier(config: AuthConfig): TokenVerifier {
  const keys =
    config.mode === 'static-jwks'
      ? staticKeySet(config.staticJwks ?? { keys: [] })
      : remoteKeySet(config.jwksUri ?? '')
  return new JwtTokenVerifier(config, keys)
}
