import { createHash, timingSafeEqual } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { executionClaimsSchema, INTERNAL_LIMITS } from '@aftercare/internal-contracts'
import type { ExecutionClaims } from '@aftercare/internal-contracts'
import type { ExecutionAuthorization } from '../../application/ports/execution-authorization.js'
import { errors } from '../../shared/app-error.js'

export class SignedExecutionAuthorization implements ExecutionAuthorization {
  private readonly key: Uint8Array
  constructor(secret: string, private readonly audience: string = 'backend-internal', private readonly issuer = 'backend-execution') {
    if (Buffer.byteLength(secret) < 32) throw new Error('Execution signing key must contain at least 32 bytes')
    this.key = new TextEncoder().encode(secret)
  }
  issue(claims: ExecutionClaims): Promise<string> {
    const validated = executionClaimsSchema.parse(claims)
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT(validated).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.issuer).setAudience(this.audience).setSubject('ai-execution')
      .setIssuedAt(now).setExpirationTime(now + INTERNAL_LIMITS.authorizationSeconds).sign(this.key)
  }
  async verify(token: string): Promise<ExecutionClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'], issuer: this.issuer, audience: this.audience, subject: 'ai-execution',
        requiredClaims: ['iat', 'exp'], maxTokenAge: INTERNAL_LIMITS.authorizationSeconds,
      })
      const now = Math.floor(Date.now() / 1000)
      if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number' || payload.iat > now
        || payload.exp - payload.iat > INTERNAL_LIMITS.authorizationSeconds) throw new Error('invalid lifetime')
      return executionClaimsSchema.parse(payload)
    } catch {
      throw errors.unauthenticated({ internal: { reason: 'invalid execution authorization' } })
    }
  }
}

/** 入力長や秘密値をログに残さず、固定長digestで比較する。 */
export function matchesServiceCredential(received: string, expected: string): boolean {
  return timingSafeEqual(createHash('sha256').update(received).digest(), createHash('sha256').update(expected).digest())
}

export function readExecutionAuthorization(env: NodeJS.ProcessEnv): SignedExecutionAuthorization | null {
  return env.BACKEND_EXECUTION_SIGNING_KEY
    ? new SignedExecutionAuthorization(env.BACKEND_EXECUTION_SIGNING_KEY, env.BACKEND_SERVICE_AUDIENCE ?? 'backend-internal') : null
}
