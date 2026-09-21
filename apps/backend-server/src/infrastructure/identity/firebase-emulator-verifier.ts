import type { JWTPayload } from 'jose'
import { decodeJwt, decodeProtectedHeader } from 'jose'
import type { TokenVerifier, VerifiedIdentity } from '../../application/ports/identity.js'
import { errors } from '../../shared/app-error.js'
import type { IdentityVerifierConfig } from './jwt-verifier.js'
import { assertIdentityClaims, identityFrom } from './jwt-verifier.js'

/**
 * Firebase Auth Emulator が発行する ID token 専用の検証器。
 *
 * Emulator は `alg:"none"`・署名部が空のトークンを発行する。本物の Firebase
 * ID token（署名付き RS256）ではないため、`JwtTokenVerifier` では検証できない。
 * この Adapter は `alg:'none'` かつ iss/aud が一致するトークンだけを受理し、
 * 署名検証は行わない。`AUTH_MODE=firebase-emulator` 自体が本番では起動を
 * 拒否するモードなので、「署名なしを受理する」検証対象を Emulator 発行分だけに
 * 限定できる。
 *
 * ここに到達できる者は任意の uid を名乗れる（署名検証をしないため）。
 * 127.0.0.1 バインド前提（`docs/runbooks/local-swagger.md`）で、リモート
 * Docker ホストなど到達範囲が広がる構成では使わない。
 */
export class FirebaseEmulatorTokenVerifier implements TokenVerifier {
  constructor(private readonly config: IdentityVerifierConfig) {}

  async verify(token: string): Promise<VerifiedIdentity> {
    let header: { alg?: string }
    let payload: JWTPayload & { user_id?: unknown; firebase?: { sign_in_provider?: unknown } }
    try {
      header = decodeProtectedHeader(token)
      payload = decodeJwt(token)
    } catch (cause) {
      throw errors.unauthenticated({ internal: { reason: 'malformed token' }, cause })
    }

    // 厳密に alg:'none'。署名付き（本物の Firebase ID token を含む）はすべて拒否する。
    if (header.alg !== 'none') {
      throw errors.unauthenticated({ internal: { reason: 'unexpected alg', alg: header.alg } })
    }
    if (payload.iss !== this.config.issuer) {
      throw errors.unauthenticated({ internal: { reason: 'issuer mismatch' } })
    }
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (!audiences.includes(this.config.audience)) {
      throw errors.unauthenticated({ internal: { reason: 'audience mismatch' } })
    }
    if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
      throw errors.unauthenticated({ internal: { reason: 'missing exp/iat' } })
    }
    if (payload.exp <= Math.floor(Date.now() / 1000) - this.config.clockToleranceSeconds) {
      throw errors.unauthenticated({ internal: { reason: 'expired' } })
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub !== payload.user_id) {
      throw errors.unauthenticated({ internal: { reason: 'invalid subject' } })
    }
    if (typeof payload.firebase?.sign_in_provider !== 'string') {
      throw errors.unauthenticated({ internal: { reason: 'missing firebase.sign_in_provider' } })
    }

    assertIdentityClaims(payload, this.config)
    return identityFrom(payload, this.config.issuer)
  }
}
