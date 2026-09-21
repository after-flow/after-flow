import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { createServer } from '../../src/composition.js'
import { describeFirestore } from './helpers/emulator.js'

const TOKEN = 'ops-readiness-token-emulator-0123456789'

/**
 * 実Emulator込みで、readinessが「必須依存がすべて揃えばreadyになる」ことを確認する。
 * 個々の検査の分岐（未設定・placeholder・AI未接続など）は
 * test/composition-readiness.test.ts（Emulator不要・高速）で確認する。
 */
describeFirestore('composition: readinessの正常系（Emulator込み）', () => {
  it('Firestore/Storage/認証設定/同意カタログ/期限ルールが揃えばreadyになる', async () => {
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
      AUTH_JWKS_URI: 'https://issuer.example.test/jwks',
      CONSENT_CATALOG_PATH: consentPath,
      DEADLINE_RULES_PATH: rulesPath,
    })

    const response = await app.request('/internal/v1/health/ready', { headers: { Authorization: `Bearer ${TOKEN}` } })
    const body = (await response.json()) as any
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.data.status, 'ready')
    assert.deepEqual(
      Object.fromEntries(body.data.checks.map((c: any) => [c.name, c.status])),
      { firestore: 'ok', storage: 'ok', auth: 'ok', consent_catalog: 'ok', deadline_rules: 'ok' },
    )
  })
})
