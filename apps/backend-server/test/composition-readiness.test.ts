import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createServer } from '../src/composition.js'

const TOKEN = 'ops-readiness-token-0123456789'

const baseEnv: NodeJS.ProcessEnv = {
  READINESS_ACCESS_TOKEN: TOKEN,
}

function checksOf(body: any): Record<string, { status: string; reason?: string }> {
  const source = body.data ?? body.error.details
  return Object.fromEntries(source.checks.map((c: any) => [c.name, { status: c.status, reason: c.reason }]))
}

async function readiness(env: NodeJS.ProcessEnv) {
  const app = createServer(env)
  const response = await app.request('/internal/v1/health/ready', { headers: { Authorization: `Bearer ${TOKEN}` } })
  return { status: response.status, body: (await response.json()) as any }
}

function ruleCatalogFixture(dir: string, overrides: Partial<{ placeholder: boolean }> = {}) {
  const file = path.join(dir, 'rules.json')
  writeFileSync(
    file,
    JSON.stringify({
      placeholder: false,
      deadlineRules: [],
      initialProcedures: [],
      deliberationDeadlineRuleId: null,
      ...overrides,
    }),
  )
  return file
}

function consentCatalogFixture(dir: string, overrides: Partial<{ placeholder: boolean }> = {}) {
  const file = path.join(dir, 'consent.json')
  writeFileSync(
    file,
    JSON.stringify({
      placeholder: false,
      documents: [
        { kind: 'TERMS', version: '1.0.0', title: 't', summary: ['s'], url: '/terms', required: true },
        { kind: 'PRIVACY', version: '1.0.0', title: 'p', summary: ['s'], url: '/privacy', required: true },
      ],
      ...overrides,
    }),
  )
  return file
}

describe('composition: 内部readiness endpointの組み立て', () => {
  it('READINESS_ACCESS_TOKEN が無ければ mount しない', async () => {
    const app = createServer({})
    assert.equal((await app.request('/internal/v1/health/ready')).status, 404)
  })

  it('READINESS_ACCESS_TOKEN と AI_SERVICE_TOKEN が同じなら起動を拒否する', () => {
    assert.throws(() => createServer({ READINESS_ACCESS_TOKEN: TOKEN, AI_SERVICE_TOKEN: TOKEN }))
  })

  it('READINESS_ACCESS_TOKEN と BACKEND_INTERNAL_SERVICE_TOKEN が同じなら起動を拒否する', () => {
    assert.throws(() => createServer({ READINESS_ACCESS_TOKEN: TOKEN, BACKEND_INTERNAL_SERVICE_TOKEN: TOKEN }))
  })

  it('何も接続していない状態は全依存が fail で not_ready、AI検査は含めない', async () => {
    const { status, body } = await readiness(baseEnv)
    assert.equal(status, 503)
    const checks = checksOf(body)
    assert.equal(checks.firestore?.status, 'fail')
    assert.equal(checks.firestore?.reason, 'NOT_CONFIGURED')
    assert.equal(checks.storage?.reason, 'NOT_CONFIGURED')
    assert.equal(checks.auth?.reason, 'NOT_CONFIGURED')
    assert.equal(checks.consent_catalog?.reason, 'PLACEHOLDER_CATALOG')
    assert.equal(checks.deadline_rules?.reason, 'PLACEHOLDER_CATALOG')
    assert.equal(checks.ai_connectivity, undefined)
    assert.equal(checks.ai_internal_auth, undefined)
  })

  it('原本Storageをローカル保存で接続すればstorageはokになる', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'after-flow-readiness-'))
    const { body } = await readiness({ ...baseEnv, DOCUMENT_STORAGE_ROOT: root })
    assert.equal(checksOf(body).storage?.status, 'ok')
  })

  it('AUTH_MODE=static-jwks は起動できてもreadinessでは本番相当ではないとして失敗する', async () => {
    const { body } = await readiness({
      ...baseEnv,
      AUTH_MODE: 'static-jwks',
      AUTH_ISSUER: 'https://issuer.example.test/',
      AUTH_AUDIENCE: 'aud',
      AUTH_STATIC_JWKS: JSON.stringify({ keys: [] }),
    })
    const auth = checksOf(body).auth
    assert.equal(auth?.status, 'fail')
    assert.equal(auth?.reason, 'STATIC_JWKS_NOT_PRODUCTION_GRADE')
  })

  it('jwks modeで必須設定が揃えばauthはokになる（JWKSへの実疎通はしない）', async () => {
    const { body } = await readiness({
      ...baseEnv,
      AUTH_ISSUER: 'https://issuer.example.test/',
      AUTH_AUDIENCE: 'aud',
      AUTH_JWKS_URI: 'https://issuer.example.test/jwks',
    })
    assert.equal(checksOf(body).auth?.status, 'ok')
  })

  it('同意カタログが仮文面(placeholder)のままならfailする', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'after-flow-readiness-'))
    const { body } = await readiness({ ...baseEnv, CONSENT_CATALOG_PATH: consentCatalogFixture(dir, { placeholder: true }) })
    assert.equal(checksOf(body).consent_catalog?.reason, 'PLACEHOLDER_CATALOG')
  })

  it('承認済みの同意カタログを設定すればokになる', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'after-flow-readiness-'))
    const { body } = await readiness({ ...baseEnv, CONSENT_CATALOG_PATH: consentCatalogFixture(dir) })
    assert.equal(checksOf(body).consent_catalog?.status, 'ok')
  })

  it('期限ルールが業務レビュー未了(placeholder)のままならfailする', async () => {
    const { body } = await readiness(baseEnv)
    assert.equal(checksOf(body).deadline_rules?.reason, 'PLACEHOLDER_CATALOG')
  })

  it('業務レビュー済みの期限ルールを設定すればokになる', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'after-flow-readiness-'))
    const { body } = await readiness({ ...baseEnv, DEADLINE_RULES_PATH: ruleCatalogFixture(dir) })
    assert.equal(checksOf(body).deadline_rules?.status, 'ok')
  })

  it('NODE_ENV=productionでDEADLINE_RULES_PATH未設定ならreadinessはNOT_CONFIGUREDに丸め込む', async () => {
    // readRuleCatalog自体は起動を止める例外を投げるが、readinessの検査はそれを
    // 汎用のNOT_CONFIGUREDとして報告する（consent_catalogと同じ扱い）。
    const { body } = await readiness({ ...baseEnv, NODE_ENV: 'production' })
    assert.equal(checksOf(body).deadline_rules?.reason, 'NOT_CONFIGURED')
  })

  describe('AI操作が有効な場合だけAI検査を追加する', () => {
    const aiEnv = {
      BACKEND_EXECUTION_SIGNING_KEY: 'x'.repeat(32),
      BACKEND_INTERNAL_SERVICE_TOKEN: 'backend-inbound-token',
      AI_SERVICE_TOKEN: 'backend-outbound-token',
      AI_CONNECTED_OPERATIONS: 'chat_reply',
    }

    it('AI操作が未接続ならAI検査は現れない', async () => {
      const { body } = await readiness(baseEnv)
      assert.equal(checksOf(body).ai_connectivity, undefined)
    })

    it('AI Serverへ到達できなければai_connectivityがfailする', async () => {
      const { body } = await readiness({ ...baseEnv, ...aiEnv, AI_SERVER_URL: 'http://127.0.0.1:1' })
      const checks = checksOf(body)
      assert.equal(checks.ai_internal_auth?.status, 'ok')
      assert.equal(checks.ai_connectivity?.status, 'fail')
      assert.equal(checks.ai_connectivity?.reason, 'UNREACHABLE')
    })

    it('AI Serverのlivenessへ認証付きで到達できればai_connectivityはokになる', async () => {
      const server = createHttpServer((req, res) => {
        assert.equal(req.headers.authorization, `Bearer ${aiEnv.AI_SERVICE_TOKEN}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: { service: 'ai-server', status: 'ok' } }))
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (typeof address !== 'object' || !address) throw new Error('unexpected address')
      try {
        const { body } = await readiness({ ...baseEnv, ...aiEnv, AI_SERVER_URL: `http://127.0.0.1:${address.port}` })
        assert.equal(checksOf(body).ai_connectivity?.status, 'ok')
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    })
  })
})
