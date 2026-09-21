import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { createServer } from '../../src/composition.js'
import { describeFirestore } from './helpers/emulator.js'

const TOKEN = 'ops-readiness-token-emulator-0123456789'
const AI_TOKEN = 'ai-execution-service-token-emulator-0123456789'

/**
 * 実Emulator込みで、readinessが「必須依存がすべて揃えばreadyになる」ことを確認する。
 * 個々の検査の分岐（未設定・placeholder・AI未接続など）は
 * test/composition-readiness.test.ts（Emulator不要・高速）で確認する。
 */
describeFirestore('composition: readinessの正常系（Emulator込み）', () => {
  it('Firestore/Storage/認証設定/同意カタログ/期限ルールが揃えば、失効確認未対応以外はokになる', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'after-flow-readiness-composition-'))
    const consentPath = path.join(dir, 'consent.json')
    writeFileSync(
      consentPath,
      JSON.stringify({
        placeholder: false,
        documents: [
          { kind: 'TERMS', version: '1.0.0', title: 't', summary: ['s'], url: '/terms', required: true },
          { kind: 'PRIVACY', version: '1.0.0', title: 'p', summary: ['s'], url: '/privacy', required: true },
        ],
      }),
    )
    const rulesPath = path.join(dir, 'rules.json')
    writeFileSync(rulesPath, JSON.stringify({ placeholder: false, deadlineRules: [], initialProcedures: [] }))

    const app = createServer({
      ...process.env,
      READINESS_ACCESS_TOKEN: TOKEN,
      DOCUMENT_STORAGE_ROOT: mkdtempSync(path.join(tmpdir(), 'after-flow-readiness-storage-')),
      AUTH_ISSUER: 'https://issuer.example.test/',
      AUTH_AUDIENCE: 'after-flow-api',
      AUTH_TENANT_ID: 'after-flow-demo',
      AUTH_JWKS_URI: 'https://issuer.example.test/jwks',
      CONSENT_CATALOG_PATH: consentPath,
      DEADLINE_RULES_PATH: rulesPath,
    })

    const response = await app.request('/internal/v1/health/ready', { headers: { Authorization: `Bearer ${TOKEN}` } })
    const body = (await response.json()) as any
    assert.equal(response.status, 503, JSON.stringify(body))
    // ADR 0001 §5の失効・停止確認は未実装のため、認証を設定した時点で
    // session_revocation が恒常的にfailし、他が揃っていてもnot_readyのまま
    // （docs/runbooks/readiness.md）。not_ready（503）はエラー封筒で返るため、
    // ready（200）時の body.data とは違い body.error.details を見る
    // （`readiness.ts` の throw errors.unavailable）。他の検査はすべてokであることを確認する。
    assert.equal(body.error.details.status, 'not_ready')
    assert.deepEqual(
      Object.fromEntries(body.error.details.checks.map((c: any) => [c.name, c.status])),
      {
        firestore: 'ok',
        storage: 'ok',
        auth: 'ok',
        session_revocation: 'fail',
        consent_catalog: 'ok',
        deadline_rules: 'ok',
      },
    )
  })

  /**
   * Fable 5.1レビュー（#123 Fix round 1）で確認された回帰の composition レベルでの再現防止。
   *
   * `createServer` がFirestore + AI実行APIの両方をmountする本番相当の構成でも、
   * readiness endpointが自身のtokenで到達可能であること、AI実行API側のroute
   * がreadiness tokenを拒否し続けることを確認する。
   * （unit levelの確認は test/app-internal-coexistence.test.ts、Emulator不要）
   */
  it('Firestore + AI実行APIが同時にmountされてもreadinessは自身のtokenで到達でき、AI実行APIはreadiness tokenを拒否する', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'after-flow-readiness-composition-ai-'))
    const consentPath = path.join(dir, 'consent.json')
    writeFileSync(
      consentPath,
      JSON.stringify({
        placeholder: false,
        documents: [
          { kind: 'TERMS', version: '1.0.0', title: 't', summary: ['s'], url: '/terms', required: true },
          { kind: 'PRIVACY', version: '1.0.0', title: 'p', summary: ['s'], url: '/privacy', required: true },
        ],
      }),
    )
    const rulesPath = path.join(dir, 'rules.json')
    writeFileSync(rulesPath, JSON.stringify({ placeholder: false, deadlineRules: [], initialProcedures: [] }))

    const aiServer = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { service: 'ai-server', status: 'ok' } }))
    })
    await new Promise<void>((resolve) => aiServer.listen(0, '127.0.0.1', resolve))
    const address = aiServer.address()
    if (typeof address !== 'object' || !address) throw new Error('unexpected address')

    try {
      const app = createServer({
        ...process.env,
        READINESS_ACCESS_TOKEN: TOKEN,
        DOCUMENT_STORAGE_ROOT: mkdtempSync(path.join(tmpdir(), 'after-flow-readiness-storage-ai-')),
        AUTH_ISSUER: 'https://issuer.example.test/',
        AUTH_AUDIENCE: 'after-flow-api',
        AUTH_TENANT_ID: 'after-flow-demo',
        AUTH_JWKS_URI: 'https://issuer.example.test/jwks',
        CONSENT_CATALOG_PATH: consentPath,
        DEADLINE_RULES_PATH: rulesPath,
        BACKEND_EXECUTION_SIGNING_KEY: 'x'.repeat(32),
        BACKEND_INTERNAL_SERVICE_TOKEN: AI_TOKEN,
        AI_SERVICE_TOKEN: 'backend-outbound-token-0123456789',
        AI_CONNECTED_OPERATIONS: 'chat_reply',
        AI_SERVER_URL: `http://127.0.0.1:${address.port}`,
      })

      const readiness = await app.request('/internal/v1/health/ready', { headers: { Authorization: `Bearer ${TOKEN}` } })
      const readinessBody = (await readiness.json()) as any
      // 認証設定がある限り session_revocation が恒常的にfailするため（上のテスト参照）、
      // ここでも overall は not_ready（503、エラー封筒）のまま。この test の主眼は
      // 「readinessが自身のtokenで到達でき、AI実行APIのtokenとは独立している」ことなので、
      // ai_connectivity 検査が ok であることだけを見る。
      assert.equal(readiness.status, 503, JSON.stringify(readinessBody))
      assert.equal(readinessBody.error.details.status, 'not_ready')
      assert.equal(
        Object.fromEntries(readinessBody.error.details.checks.map((c: any) => [c.name, c.status])).ai_connectivity,
        'ok',
      )

      // AI実行APIはreadiness tokenでは通らない（別のアクセス制御のまま）。
      const executionWithReadinessToken = await app.request('/internal/v1/runs/run-1/context', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      assert.equal(executionWithReadinessToken.status, 401)

      // readinessはAI実行API側のtokenでは通らない。
      const readinessWithAiToken = await app.request('/internal/v1/health/ready', {
        headers: { Authorization: `Bearer ${AI_TOKEN}` },
      })
      assert.equal(readinessWithAiToken.status, 401)
    } finally {
      await new Promise((resolve) => aiServer.close(resolve))
    }
  })
})
