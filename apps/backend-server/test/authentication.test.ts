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

const config = {
  issuer: ISSUER,
  audience: AUDIENCE,
  algorithms: ['RS256', 'ES256'],
  tenantClaim: TENANT_CLAIM,
  clockToleranceSeconds: 0,
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

function verifier() {
  return new JwtTokenVerifier(config, staticKeySet(jwks as never))
}

interface TokenOptions {
  issuer?: string
  audience?: string
  subject?: string | null
  tenant?: string | null
  expiresIn?: string
  key?: KeyObject
}

async function signToken(options: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = {}
  if (options.tenant !== null) claims[TENANT_CLAIM] = options.tenant ?? 'tenant-a'

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
  it('正しいトークンから subject と tenant の主張を取り出す', async () => {
    const identity = await verifier().verify(await signToken())
    assert.equal(identity.subject, 'user-1')
    assert.equal(identity.claimedTenantId, 'tenant-a')
    assert.equal(identity.issuer, ISSUER)
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
        [TENANT_CLAIM]: 'tenant-a',
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
        [TENANT_CLAIM]: 'tenant-other',
      }),
    ).toString('base64url')
    const tampered = `${header}.${forged}.${signature}`
    assert.equal((await rejection(() => verifier().verify(tampered))).code, 'UNAUTHENTICATED')
  })

  it('subject や tenant クレームが無いトークンを拒否する', async () => {
    const withoutSubject = await signToken({ subject: null })
    const withoutTenant = await signToken({ tenant: null })
    assert.equal((await rejection(() => verifier().verify(withoutSubject))).code, 'UNAUTHENTICATED')
    assert.equal((await rejection(() => verifier().verify(withoutTenant))).code, 'UNAUTHENTICATED')
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
    AUTH_STATIC_JWKS: '{"keys":[]}',
  }

  it('issuer と audience が無ければ起動を止める', () => {
    assert.throws(() => readAuthConfig({ AUTH_MODE: 'jwks' } as NodeJS.ProcessEnv), /AUTH_ISSUER/)
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
})

describe('認証 middleware', () => {
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
      authentication: authentication(verifier(), new AccessService(read)),
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

  it('tenant の membership が無い利用者を拒否する', async () => {
    const { response, body } = await callWith(`Bearer ${await signToken()}`)
    assert.equal(response.status, 403)
    assert.equal(body.error.code, 'FORBIDDEN')
  })

  it('停止済みの membership を拒否する', async () => {
    const read: ReadRepository = {
      get: async () => ({ userId: 'user-1', active: false }) as never,
      list: async () => ({ items: [] }),
      listGroup: async () => ({ items: [] }),
      count: async () => 0,
    }
    const { response } = await callWith(`Bearer ${await signToken()}`, read)
    assert.equal(response.status, 403)
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
