import type { TokenVerifier } from '../../application/ports/identity.js'
import { FirebaseEmulatorTokenVerifier } from './firebase-emulator-verifier.js'
import type { JwtVerifierConfig } from './jwt-verifier.js'
import { DEFAULT_ALGORITHMS, JwtTokenVerifier, remoteKeySet, staticKeySet } from './jwt-verifier.js'

/**
 * 認証の設定読み込み。
 *
 * 採用 Provider は Firebase Authentication（docs/adr/0001-authentication-provider.md）。
 * issuer・audience・鍵の取得元・tenant はすべて設定で受け取る。設定が無いときに
 * 「検証を省略して通す」既定値は作らない。
 *
 * tenant は配備単位で固定する（`AUTH_TENANT_ID`）。利用者ごとに tenant を
 * 動的に作る方式は、保存パスからの逆引きができず、Outbox worker が
 * `OUTBOX_TENANT_IDS` に明示列挙した tenant しか処理しないため選ばない
 * （`application/authorization/case-access.ts` の `resolveUser` が使う）。
 */
export type AuthMode = 'jwks' | 'static-jwks' | 'firebase-emulator'

export interface AuthConfig extends JwtVerifierConfig {
  mode: AuthMode
  /** mode = jwks のときの鍵取得元 */
  jwksUri?: string
  /** mode = static-jwks のときの固定鍵（試験・ローカル専用） */
  staticJwks?: { keys: Record<string, unknown>[] }
  /** 配備単位で固定する tenant。全モード必須。 */
  tenantId: string
  /** mode = firebase-emulator のときの Emulator 接続先（検証には使わない。設定の意図を明示させる） */
  firebaseAuthEmulatorHost?: string
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`${key} が未設定です。認証の設定を省略した状態で起動しない。`)
  return value
}

export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const mode = (env.AUTH_MODE ?? 'jwks') as AuthMode
  if (mode !== 'jwks' && mode !== 'static-jwks' && mode !== 'firebase-emulator') {
    throw new Error(`AUTH_MODE が不正です: ${String(env.AUTH_MODE)}`)
  }

  // 固定鍵・Emulator 検証は試験とローカル開発のためのもの。本番相当の環境では選べない。
  if (mode === 'static-jwks' && env.NODE_ENV === 'production') {
    throw new Error('AUTH_MODE=static-jwks は本番では使用できません。')
  }
  if (mode === 'firebase-emulator' && env.NODE_ENV === 'production') {
    throw new Error('AUTH_MODE=firebase-emulator は本番では使用できません。')
  }

  const requireEmailVerifiedRaw = env.AUTH_REQUIRE_EMAIL_VERIFIED
  if (requireEmailVerifiedRaw !== undefined && requireEmailVerifiedRaw !== 'true' && requireEmailVerifiedRaw !== 'false') {
    throw new Error('AUTH_REQUIRE_EMAIL_VERIFIED には true または false を指定してください。')
  }
  const requireEmailVerified = requireEmailVerifiedRaw !== 'false'
  // メール確認必須を外せるのは、ローカルの Auth Emulator 検証だけ。jwks（本番想定の
  // 検証経路）で外せると、本番でも同じコードパスで確認を省略できてしまう。
  if (!requireEmailVerified && mode === 'jwks') {
    throw new Error('AUTH_REQUIRE_EMAIL_VERIFIED=false は AUTH_MODE=jwks では使用できません。')
  }

  const base = {
    mode,
    issuer: required(env, 'AUTH_ISSUER'),
    audience: required(env, 'AUTH_AUDIENCE'),
    algorithms: env.AUTH_ALGORITHMS ? env.AUTH_ALGORITHMS.split(',') : [...DEFAULT_ALGORITHMS],
    tenantId: required(env, 'AUTH_TENANT_ID'),
    clockToleranceSeconds: Number(env.AUTH_CLOCK_TOLERANCE_SECONDS ?? 5),
    requireEmailVerified,
  } satisfies Omit<AuthConfig, 'jwksUri' | 'staticJwks' | 'firebaseAuthEmulatorHost'>

  if (base.algorithms.some((algorithm) => !algorithm.startsWith('RS') && !algorithm.startsWith('ES'))) {
    // 対称鍵や none を許すと、公開鍵を知る者が署名を作れてしまう。
    throw new Error('AUTH_ALGORITHMS には非対称鍵の署名方式のみを指定してください。')
  }

  if (mode === 'static-jwks') {
    return { ...base, staticJwks: JSON.parse(required(env, 'AUTH_STATIC_JWKS')) }
  }
  if (mode === 'firebase-emulator') {
    return { ...base, firebaseAuthEmulatorHost: required(env, 'FIREBASE_AUTH_EMULATOR_HOST') }
  }
  return { ...base, jwksUri: required(env, 'AUTH_JWKS_URI') }
}

export function createTokenVerifier(config: AuthConfig): TokenVerifier {
  if (config.mode === 'firebase-emulator') return new FirebaseEmulatorTokenVerifier(config)
  const keys =
    config.mode === 'static-jwks'
      ? staticKeySet(config.staticJwks ?? { keys: [] })
      : remoteKeySet(config.jwksUri ?? '')
  return new JwtTokenVerifier(config, keys)
}
