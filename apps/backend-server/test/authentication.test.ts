import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import type { JWK, KeyObject } from 'jose'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { AccessService } from '../src/application/authorization/case-access.js'
import type { ReadRepository } from '../src/application/ports/persistence.js'
import { createApp } from '../src/app.js'
import { readAuthConfig } from '../src/infrastructure/identity/config.js'
import { JwtTokenVerifier, staticKeySet } from '../src/infrastructure/identity/jwt-verifier.js'
import { authentication } from '../src/presentation/http/authentication.js'
import { AppError } from '../src/shared/app-error.js'
import { fixtureRoutes } from './helpers/fixture-routes.js'

const ISSUER = 'https://issuer.example.test/'
const AUDIENCE = 'after-flow-api'
const TENANT_CLAIM = 'tenant_id'
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60

const config = {
  issuer: ISSUER,
  audience: AUDIENCE,
  algorithms: ['RS256', 'ES256'],
  clockToleranceSeconds: 0,
  requireEmailVerified: true,
}

let signingKey: KeyObject
let otherKey: KeyObject
let jwks: { keys: JWK[] }

before(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  const other = await generateKeyPair('RS256', { extractable: true })
  signingKey = pair.privateKey as KeyObject
  otherKey = other.privateKey as KeyObject
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' }] }
})

function verifier(overrides: Partial<typeof config> = {}) {
  return new JwtTokenVerifier({ ...config, ...overrides }, staticKeySet(jwks as never))
}

interface TokenOptions {
  issuer?: string
  audience?: string
  subject?: string | null
  /** 後方互換の確認用。tenant claim は検証・認可では読まない。 */
  tenant?: string | null
  expiresIn?: string
  key?: KeyObject
  emailVerified?: boolean | null
  authTimeSecondsAgo?: number
}

async function signToken(options: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = {}
  if (options.tenant !== null) claims[TENANT_CLAIM] = options.tenant ?? 'tenant-a'
  if (options.emailVerified !== null) claims.email_verified = options.emailVerified ?? true
  if (options.authTimeSecondsAgo !== undefined) {
    claims.auth_time = Math.floor(Date.now() / 1000) - options.authTimeSecondsAgo
  }

  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setExpirationTime(options.expiresIn ?? '5m')
  if (options.subject !== null) jwt.setSubject(options.subject ?? 'user-1')
  return jwt.sign(options.key ?? signingKey)
}

async function rejection(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn()
  } catch (cause) {
    assert.ok(cause instanceof AppError, `AppError ではない: ${String(cause)}`)
    return cause
  }
  throw new Error('エラーが発生しなかった')
}

describe('トークン検証', () => {
  it('正しいトークンから subject とメール確認状態を取り出す', async () => {
    const identity = await verifier().verify(await signToken())
    assert.equal(identity.subject, 'user-1')
    assert.equal(identity.emailVerified, true)
    assert.equal(identity.issuer, ISSUER)
  })

  it('tenant_id claim があっても検証結果に含めない（無視する）', async () => {
    const identity = await verifier().verify(await signToken({ tenant: 'tenant-should-be-ignored' }))
    assert.ok(!('claimedTenantId' in identity))
  })

  it('期限切れを拒否する', async () => {
    const token = await signToken({ expiresIn: '-1s' })
    assert.equal((await rejection(() => verifier().verify(token))).code, 'UNAUTHENTICATED')
  })

  it('issuer 不一致を拒否する', async () => {
    const token = await signToken({ issuer: 'https://evil.example.test/' })
    assert.equal((await rejection(() => verifier().verify(token))).code, 'UNAUTHENTICATED')
  })

  it('audience 不一致を拒否する', async () => {
    const token = await signToken({ audience: 'another-api' })
    assert.equal((await rejection(() => verifier().verify(token))).code, 'UNAUTHENTICATED')
  })

  it('別の鍵で署名されたトークンを拒否する', async () => {
    const token = await signToken({ key: otherKey })
    assert.equal((await rejection(() => verifier().verify(token))).code, 'UNAUTHENTICATED')
  })

  it('署名が無いトークンを拒否する', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'user-1',
        iss: ISSUER,
        aud: AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000),
        email_verified: true,
      }),
    ).toString('base64url')
    const unsigned = `${header}.${payload}.`
    assert.equal((await rejection(() => verifier().verify(unsigned))).code, 'UNAUTHENTICATED')
  })

  it('改竄されたペイロードを拒否する', async () => {
    const token = await signToken()
    const [header, , signature] = token.split('.')
    const forged = Buffer.from(
      JSON.stringify({
        sub: 'user-elevated',
        iss: ISSUER,
        aud: AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000),
        email_verified: true,
      }),
    ).toString('base64url')
    const tampered = `${header}.${forged}.${signature}`
    assert.equal((await rejection(() => verifier().verify(tampered))).code, 'UNAUTHENTICATED')
  })

  it('subject が無いトークンを拒否する', async () => {
    const withoutSubject = await signToken({ subject: null })
    assert.equal((await rejection(() => verifier().verify(withoutSubject))).code, 'UNAUTHENTICATED')
  })

  it('メール未確認は要求時 403 EMAIL_NOT_VERIFIED（トークン自体は正当なので401にしない）', async () => {
    const token = await signToken({ emailVerified: false })
    const error = await rejection(() => verifier().verify(token))
    assert.equal(error.code, 'FORBIDDEN')
    assert.equal(error.details?.reason, 'EMAIL_NOT_VERIFIED')
  })

  it('requireEmailVerified:false ならメール未確認でも通す', async () => {
    const token = await signToken({ emailVerified: false })
    const identity = await verifier({ requireEmailVerified: false }).verify(token)
    assert.equal(identity.emailVerified, false)
  })

  it('ログイン維持の7日上限（auth_time）を超えたトークンを401 SESSION_EXPIREDで拒否する', async () => {
    const token = await signToken({ authTimeSecondsAgo: SEVEN_DAYS_SECONDS + 60 })
    const error = await rejection(() => verifier().verify(token))
    assert.equal(error.code, 'UNAUTHENTICATED')
    assert.equal(error.details?.reason, 'SESSION_EXPIRED')
  })

  it('auth_time が7日以内なら通す', async () => {
    const token = await signToken({ authTimeSecondsAgo: SEVEN_DAYS_SECONDS - 60 })
    const identity = await verifier().verify(token)
    assert.equal(identity.subject, 'user-1')
  })

  it('auth_time が無いトークン（static-jwks 互換）は上限の対象外として通す', async () => {
    const token = await signToken()
    const identity = await verifier().verify(token)
    assert.equal(identity.authTime, null)
  })

  it('検証失敗の応答にトークンや失敗理由を載せない', async () => {
    const token = await signToken({ expiresIn: '-1s' })
    const error = await rejection(() => verifier().verify(token))
    assert.equal(error.details, undefined)
    assert.ok(!error.message.includes(token))
  })
})

describe('認証の設定', () => {
  const base = {
    AUTH_ISSUER: ISSUER,
    AUTH_AUDIENCE: AUDIENCE,
    AUTH_TENANT_ID: 'after-flow-demo',
    AUTH_STATIC_JWKS: '{"keys":[]}',
  }

  it('issuer と audience が無ければ起動を止める', () => {
    assert.throws(() => readAuthConfig({ AUTH_MODE: 'jwks' } as NodeJS.ProcessEnv), /AUTH_ISSUER/)
  })

  it('tenant が無ければ起動を止める（全モード必須）', () => {
    assert.throws(
      () =>
        readAuthConfig({
          AUTH_MODE: 'jwks',
          AUTH_ISSUER: ISSUER,
          AUTH_AUDIENCE: AUDIENCE,
          AUTH_JWKS_URI: 'https://example.test/jwks',
        } as NodeJS.ProcessEnv),
      /AUTH_TENANT_ID/,
    )
  })

  it('対称鍵の署名方式を許さない', () => {
    assert.throws(
      () =>
        readAuthConfig({
          ...base,
          AUTH_MODE: 'static-jwks',
          AUTH_ALGORITHMS: 'HS256',
        } as NodeJS.ProcessEnv),
      /非対称鍵/,
    )
  })

  it('固定鍵モードを本番で選べない', () => {
    assert.throws(
      () =>
        readAuthConfig({
          ...base,
          AUTH_MODE: 'static-jwks',
          NODE_ENV: 'production',
        } as NodeJS.ProcessEnv),
      /本番では使用できません/,
    )
  })

  it('jwks モードでは鍵の取得元を必須にする', () => {
    assert.throws(
      () => readAuthConfig({ ...base, AUTH_MODE: 'jwks' } as NodeJS.ProcessEnv),
      /AUTH_JWKS_URI/,
    )
  })

  it('firebase-emulator モードは FIREBASE_AUTH_EMULATOR_HOST を必須にする', () => {
    assert.throws(
      () => readAuthConfig({ ...base, AUTH_MODE: 'firebase-emulator' } as NodeJS.ProcessEnv),
      /FIREBASE_AUTH_EMULATOR_HOST/,
    )
  })

  it('firebase-emulator モードを本番で選べない', () => {
    assert.throws(
      () =>
        readAuthConfig({
          ...base,
          AUTH_MODE: 'firebase-emulator',
          FIREBASE_AUTH_EMULATOR_HOST: 'firebase-auth-emulator:9099',
          NODE_ENV: 'production',
        } as NodeJS.ProcessEnv),
      /本番では使用できません/,
    )
  })

  it('AUTH_REQUIRE_EMAIL_VERIFIED=false は jwks では使用できない', () => {
    assert.throws(
      () =>
        readAuthConfig({
          ...base,
          AUTH_MODE: 'jwks',
          AUTH_JWKS_URI: 'https://example.test/jwks',
          AUTH_REQUIRE_EMAIL_VERIFIED: 'false',
        } as NodeJS.ProcessEnv),
      /AUTH_REQUIRE_EMAIL_VERIFIED/,
    )
  })

  it('AUTH_REQUIRE_EMAIL_VERIFIED=false は firebase-emulator では使用できる', () => {
    const parsed = readAuthConfig({
      ...base,
      AUTH_MODE: 'firebase-emulator',
      FIREBASE_AUTH_EMULATOR_HOST: 'firebase-auth-emulator:9099',
      AUTH_REQUIRE_EMAIL_VERIFIED: 'false',
    } as NodeJS.ProcessEnv)
    assert.equal(parsed.requireEmailVerified, false)
  })
})

describe('認証 middleware', () => {
  const TENANT_ID = 'tenant-a'

  /** membership を持たない読み取り。トークン検証だけを見るための最小の Fake。 */
  const emptyRead: ReadRepository = {
    get: async () => null,
    list: async () => ({ items: [] }),
    listGroup: async () => ({ items: [] }),
    count: async () => 0,
  }

  function appWith(read: ReadRepository) {
    return createApp({
      routes: fixtureRoutes,
      authentication: authentication(verifier(), new AccessService(read), TENANT_ID),
    })
  }

  async function callWith(header: string | undefined, read: ReadRepository = emptyRead) {
    const app = appWith(read)
    const response = await app.request('http://localhost/api/v1/cases/case-1/fixtures', {
      headers: header ? { Authorization: header } : {},
    })
    return { response, body: (await response.json()) as Record<string, any> }
  }

  it('Authorization が無ければ 401 を返す', async () => {
    const { response, body } = await callWith(undefined)
    assert.equal(response.status, 401)
    assert.equal(body.error.code, 'UNAUTHENTICATED')
  })

  it('Bearer 以外の形式を拒否する', async () => {
    const { response } = await callWith('Basic dXNlcjpwYXNz')
    assert.equal(response.status, 401)
  })

  it('tenant の membership が無い利用者は 403 NOT_REGISTERED を返す（identity はあるが user が無い）', async () => {
    const { response, body } = await callWith(`Bearer ${await signToken()}`)
    assert.equal(response.status, 403)
    assert.equal(body.error.code, 'FORBIDDEN')
    assert.equal(body.error.details?.reason, 'NOT_REGISTERED')
    assert.deepEqual(body.error.details?.availableOperations, ['getMe', 'registerMe'])
  })

  it('tenant_id claim を無視し、middleware に渡した tenantId で membership を確認する', async () => {
    let seenTenantId: string | undefined
    const read: ReadRepository = {
      get: async (tenantId) => {
        seenTenantId = tenantId
        return { userId: 'user-1', active: true } as never
      },
      list: async () => ({ items: [] }),
      listGroup: async () => ({ items: [] }),
      count: async () => 0,
    }
    // トークンは別 tenant を claim しているが、無視されて TENANT_ID が使われる。
    const { response } = await callWith(`Bearer ${await signToken({ tenant: 'tenant-claimed-by-token' })}`, read)
    assert.equal(response.status, 200)
    assert.equal(seenTenantId, TENANT_ID)
  })

  it('停止済みの membership を拒否する', async () => {
    const read: ReadRepository = {
      get: async () => ({ userId: 'user-1', active: false }) as never,
      list: async () => ({ items: [] }),
      listGroup: async () => ({ items: [] }),
      count: async () => 0,
    }
    const { response, body } = await callWith(`Bearer ${await signToken()}`, read)
    assert.equal(response.status, 403)
    assert.equal(body.error.details?.reason, 'MEMBERSHIP_INACTIVE')
  })

  it('有効な membership があれば route まで到達する', async () => {
    const read: ReadRepository = {
      get: async () => ({ userId: 'user-1', active: true }) as never,
      list: async () => ({ items: [] }),
      listGroup: async () => ({ items: [] }),
      count: async () => 0,
    }
    const { response, body } = await callWith(`Bearer ${await signToken()}`, read)
    assert.equal(response.status, 200)
    assert.equal(body.data.caseId, 'case-1')
  })

  it('応答のどこにもトークンを含めない', async () => {
    const token = await signToken()
    const { response, body } = await callWith(`Bearer ${token}`)
    assert.ok(!JSON.stringify(body).includes(token))
    for (const [, value] of response.headers) {
      assert.ok(!value.includes(token))
    }
  })
})
