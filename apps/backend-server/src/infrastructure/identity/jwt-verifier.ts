import type { JWTPayload, JWTVerifyGetKey } from 'jose'
import { createLocalJWKSet, createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose'
import type { TokenVerifier, VerifiedIdentity } from '../../application/ports/identity.js'
import { errors } from '../../shared/app-error.js'
import { assertWithinSessionCap } from './session-age.js'

/**
 * OIDC 形式の ID トークンを検証する Adapter に共通の設定。
 *
 * 採用 Provider は Firebase Authentication（ADR 0001）。issuer・audience・
 * 鍵の取得元は設定で受け取り、「とりあえず通す」既定値は持たせない。
 * 設定が無ければ起動時に失敗する。
 */
export interface IdentityVerifierConfig {
  issuer: string
  audience: string
  /** 時計ずれの許容。過大にすると期限切れトークンを通す。 */
  clockToleranceSeconds: number
  /**
   * メール確認を必須にするか（ADR 0001 §1）。
   *
   * BE がメール確認の唯一の判定者になる。FE は自前で emailVerified を
   * 見て遮断せず、この検証が投げる FORBIDDEN に従う。
   */
  requireEmailVerified: boolean
  /** `auth_time` の無いトークンを拒否するか。static-jwks の試験用トークン以外は true。 */
  requireAuthTime: boolean
}

export interface JwtVerifierConfig extends IdentityVerifierConfig {
  /** 許可する署名アルゴリズム。`none` や対称鍵を紛れ込ませない。 */
  algorithms: string[]
}

export const DEFAULT_ALGORITHMS = ['RS256', 'ES256'] as const

/** メール確認・7日上限の検証は Provider 共通のため、両 Adapter から呼ぶ。 */
export function assertIdentityClaims(payload: JWTPayload, config: IdentityVerifierConfig): void {
  if (config.requireEmailVerified && payload.email_verified !== true) {
    // トークン自体は正当なので 401 ではなく 403。FE はこれで /verify-email へ送る。
    throw errors.forbidden({
      message: 'メールアドレスの確認が必要です。',
      details: { reason: 'EMAIL_NOT_VERIFIED' },
    })
  }
  const authTimeSeconds = typeof payload.auth_time === 'number' ? payload.auth_time : undefined
  assertWithinSessionCap(authTimeSeconds, Math.floor(Date.now() / 1000), config.clockToleranceSeconds, config.requireAuthTime)
}

export function identityFrom(payload: JWTPayload, issuer: string): VerifiedIdentity {
  const subject = payload.sub
  if (typeof subject !== 'string' || subject.length === 0) {
    throw errors.unauthenticated({ internal: { reason: 'missing subject' } })
  }
  if (typeof payload.exp !== 'number') {
    throw errors.unauthenticated({ internal: { reason: 'missing exp' } })
  }
  const email = typeof payload.email === 'string' ? payload.email : null
  const authTime = typeof payload.auth_time === 'number' ? new Date(payload.auth_time * 1000).toISOString() : null
  return {
    subject,
    email,
    emailVerified: payload.email_verified === true,
    authTime,
    issuer,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  }
}

export class JwtTokenVerifier implements TokenVerifier {
  constructor(
    private readonly config: JwtVerifierConfig,
    private readonly keys: JWTVerifyGetKey,
  ) {}

  async verify(token: string): Promise<VerifiedIdentity> {
    let payload: JWTPayload
    try {
      const result = await jwtVerify(token, this.keys, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: this.config.algorithms,
        clockTolerance: this.config.clockToleranceSeconds,
        // 署名が無いトークンを通さない。
        requiredClaims: ['sub', 'exp', 'iat'],
      })
      payload = result.payload
    } catch (cause) {
      throw translateVerificationError(cause)
    }

    assertIdentityClaims(payload, this.config)
    return identityFrom(payload, this.config.issuer)
  }
}

/**
 * 検証失敗と一時障害を分ける。
 *
 * 鍵の取得に失敗しただけで 401 を返すと、利用者はログインし直しても
 * 復旧せず、クライアントはトークンを捨て続ける。
 */
function translateVerificationError(cause: unknown): unknown {
  if (cause instanceof joseErrors.JWKSNoMatchingKey || cause instanceof joseErrors.JWKSMultipleMatchingKeys) {
    return errors.unauthenticated({ internal: { reason: 'no matching key' } })
  }
  if (cause instanceof joseErrors.JWKSTimeout || cause instanceof joseErrors.JWKSInvalid) {
    return errors.unavailable({
      message: '認証基盤へ一時的に接続できませんでした。時間をおいてやり直してください。',
      cause,
    })
  }
  if (cause instanceof joseErrors.JOSEError) {
    // 期限切れ、issuer/audience 不一致、署名不正はすべてここ。
    // 理由を応答で細かく返すと、トークンの当て推量を助ける。
    return errors.unauthenticated({ internal: { reason: cause.code } })
  }
  // fetch の失敗など、jose の外で起きた障害。
  return errors.unavailable({
    message: '認証基盤へ一時的に接続できませんでした。時間をおいてやり直してください。',
    cause,
  })
}

export function remoteKeySet(jwksUri: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUri), {
    // 取得できた鍵を使い回し、要求ごとに Provider を叩かない。
    cacheMaxAge: 10 * 60 * 1000,
    timeoutDuration: 5_000,
  })
}

/** 試験用の固定 JWKS。本番の既定にしない（設定で明示的に選んだ場合だけ使う）。 */
export function staticKeySet(jwks: { keys: Record<string, unknown>[] }): JWTVerifyGetKey {
  return createLocalJWKSet(jwks as never)
}
