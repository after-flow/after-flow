import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SignJWT, generateKeyPair } from 'jose'
import type { KeyObject } from 'jose'
import { FirebaseEmulatorTokenVerifier } from '../src/infrastructure/identity/firebase-emulator-verifier.js'
import type { IdentityVerifierConfig } from '../src/infrastructure/identity/jwt-verifier.js'
import { AppError } from '../src/shared/app-error.js'

const ISSUER = 'https://securetoken.google.com/demo-after-flow'
const AUDIENCE = 'demo-after-flow'

const config: IdentityVerifierConfig = {
  issuer: ISSUER,
  audience: AUDIENCE,
  clockToleranceSeconds: 5,
  requireEmailVerified: false,
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

interface EmulatorTokenOptions {
  header?: Record<string, unknown>
  iss?: string
  aud?: string | string[]
  sub?: string
  userId?: string
  exp?: number
  iat?: number
  emailVerified?: boolean
  signInProvider?: string | null
  /** null で auth_time を省く（Emulator の実トークンには必ず入る） */
  authTime?: number | null
}

/** Firebase Auth Emulator が発行する形（alg:'none'、署名部が空）のトークンを組み立てる。 */
function emulatorToken(options: EmulatorTokenOptions = {}): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'none', typ: 'JWT', ...options.header }
  const payload: Record<string, unknown> = {
    iss: options.iss ?? ISSUER,
    aud: options.aud ?? AUDIENCE,
    sub: options.sub ?? 'user-1',
    user_id: options.userId ?? options.sub ?? 'user-1',
    exp: options.exp ?? now + 3600,
    iat: options.iat ?? now,
    email_verified: options.emailVerified ?? true,
  }
  if (options.authTime !== null) payload.auth_time = options.authTime ?? now
  if (options.signInProvider !== null) {
    payload.firebase = { sign_in_provider: options.signInProvider ?? 'password' }
  }
  return `${base64url(header)}.${base64url(payload)}.`
}

describe('FirebaseEmulatorTokenVerifier: auth_time', () => {
  it('auth_time の無いトークンは 401 AUTH_TIME_REQUIRED で拒否する', async () => {
    const error = await rejection(() => verifier().verify(emulatorToken({ authTime: null })))
    assert.equal(error.code, 'UNAUTHENTICATED')
    assert.equal(error.details?.reason, 'AUTH_TIME_REQUIRED')
  })
})

async function rejection(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn()
  } catch (cause) {
    assert.ok(cause instanceof AppError, `AppError ではない: ${String(cause)}`)
    return cause
  }
  throw new Error('エラーが発生しなかった')
}

function verifier(overrides: Partial<IdentityVerifierConfig> = {}) {
  return new FirebaseEmulatorTokenVerifier({ ...config, ...overrides })
}

describe('FirebaseEmulatorTokenVerifier', () => {
  it('alg:none・iss/aud一致のトークンを受理する', async () => {
    const identity = await verifier().verify(emulatorToken())
    assert.equal(identity.subject, 'user-1')
    assert.equal(identity.issuer, ISSUER)
  })

  it('aud が配列でも一致を確認する', async () => {
    const identity = await verifier().verify(emulatorToken({ aud: ['other-project', AUDIENCE] }))
    assert.equal(identity.subject, 'user-1')
  })

  it('alg:HS256（署名付き）を拒否する（Emulator 発行分だけを受理する）', async () => {
    const key = new TextEncoder().encode('a'.repeat(32))
    const now = Math.floor(Date.now() / 1000)
    const token = await new SignJWT({
      user_id: 'user-1',
      email_verified: true,
      firebase: { sign_in_provider: 'password' },
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('user-1')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key)
    assert.equal((await rejection(() => verifier().verify(token))).code, 'UNAUTHENTICATED')
  })

  it('署名付き RS256（本物の Firebase ID token の形）も拒否する', async () => {
    let signingKey: KeyObject
    ;({ privateKey: signingKey } = await generateKeyPair('RS256', { extractable: true }))
    const now = Math.floor(Date.now() / 1000)
    const token = await new SignJWT({
      user_id: 'user-1',
      email_verified: true,
      firebase: { sign_in_provider: 'password' },
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'real-firebase-key' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('user-1')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(signingKey)
    assert.equal((await rejection(() => verifier().verify(token))).code, 'UNAUTHENTICATED')
  })

  it('issuer 不一致を拒否する', async () => {
    const token = emulatorToken({ iss: 'https://securetoken.google.com/other-project' })
    assert.equal((await rejection(() => verifier().verify(token))).code, 'UNAUTHENTICATED')
  })

  it('audience 不一致を拒否する', async () => {
    const token = emulatorToken({ aud: 'other-project' })
    assert.equal((await rejection(() => verifier().verify(token))).code, 'UNAUTHENTICATED')
  })

  it('期限切れを拒否する', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = emulatorToken({ exp: now - 3600 })
    assert.equal((await rejection(() => verifier().verify(token))).code, 'UNAUTHENTICATED')
  })

  it('sub と user_id が食い違うトークンを拒否する', async () => {
    const token = emulatorToken({ sub: 'user-1', userId: 'user-elevated' })
    assert.equal((await rejection(() => verifier().verify(token))).code, 'UNAUTHENTICATED')
  })

  it('firebase.sign_in_provider が無いトークンを拒否する', async () => {
    const token = emulatorToken({ signInProvider: null })
    assert.equal((await rejection(() => verifier().verify(token))).code, 'UNAUTHENTICATED')
  })

  it('requireEmailVerified:true でメール未確認は 403 EMAIL_NOT_VERIFIED', async () => {
    const token = emulatorToken({ emailVerified: false })
    const error = await rejection(() => verifier({ requireEmailVerified: true }).verify(token))
    assert.equal(error.code, 'FORBIDDEN')
    assert.equal(error.details?.reason, 'EMAIL_NOT_VERIFIED')
  })
})
