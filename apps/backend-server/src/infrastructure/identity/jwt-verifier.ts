import type { JWTPayload, JWTVerifyGetKey } from 'jose'
import { createLocalJWKSet, createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose'
import type { TokenVerifier, VerifiedIdentity } from '../../application/ports/identity.js'
import { errors } from '../../shared/app-error.js'

/**
 * OIDC 形式の ID トークンを検証する Adapter。
 *
 * 採用 Provider が未決定のため、issuer・audience・鍵の取得元を設定で受け取る。
 * 「とりあえず通す」既定値は持たせない。設定が無ければ起動時に失敗する。
 */
export interface JwtVerifierConfig {
  issuer: string
  audience: string
  /** 許可する署名アルゴリズム。`none` や対称鍵を紛れ込ませない。 */
  algorithms: string[]
  /** tenant を載せるクレーム名。Provider 選定時に確定する。 */
  tenantClaim: string
  /** 時計ずれの許容。過大にすると期限切れトークンを通す。 */
  clockToleranceSeconds: number
}

export const DEFAULT_ALGORITHMS = ['RS256', 'ES256'] as const

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

    const subject = payload.sub
    const claimedTenantId = payload[this.config.tenantClaim]
    if (typeof subject !== 'string' || subject.length === 0) {
      throw errors.unauthenticated({ internal: { reason: 'missing subject' } })
    }
    if (typeof claimedTenantId !== 'string' || claimedTenantId.length === 0) {
      throw errors.unauthenticated({ internal: { reason: 'missing tenant claim' } })
    }
    if (typeof payload.exp !== 'number') {
      throw errors.unauthenticated({ internal: { reason: 'missing exp' } })
    }

    return {
      subject,
      claimedTenantId,
      issuer: this.config.issuer,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    }
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
