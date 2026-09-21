import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import type { AgentOperation } from '../../src/domain/agent/agent-run.js'
import { PLACEHOLDER_CATALOG } from '../../src/domain/consent/catalog.js'
import type { ConsentCatalog } from '../../src/domain/consent/consent.js'
import { INFRASTRUCTURE_COLLECTIONS } from '../../src/domain/shared/collections.js'
import type { DocumentInspector } from '../../src/application/ports/inspection.js'
import type { createApp } from '../../src/app.js'
import {
  agreeExternalAiConsent,
  agreeRequiredConsents,
  buildApp,
  call,
  jsonRequest,
  seedTenantMember,
} from './helpers/app.js'
import { describeFirestore, firestore, newTenantId } from './helpers/emulator.js'

const CROSS_BORDER = PLACEHOLDER_CATALOG.documents.find((d) => d.kind === 'CROSS_BORDER_AI')!
const REVISED_CROSS_BORDER_VERSION = '0.0.1-draft'

function revisedCatalog(): ConsentCatalog {
  return {
    ...PLACEHOLDER_CATALOG,
    documents: PLACEHOLDER_CATALOG.documents.map((document) =>
      document.kind === 'CROSS_BORDER_AI' ? { ...document, version: REVISED_CROSS_BORDER_VERSION } : document,
    ),
  }
}

const caseBody = {
  deceasedName: '架空 太郎',
  dateOfDeath: '2026-04-01',
  knownAt: '2026-04-03',
  ownerName: '架空 花子',
  relationshipToDeceased: '配偶者',
}

let keyCounter = 0
function nextKey(prefix: string): string {
  keyCounter += 1
  return `${prefix}-${String(keyCounter).padStart(8, '0')}`
}

function syntheticPdf(marker = 'synthetic'): Uint8Array {
  return new Uint8Array([...Buffer.from('%PDF-1.7\n'), ...Buffer.from(marker), 0x0a])
}

function uploadRequest(content: Uint8Array): RequestInit {
  const form = new FormData()
  form.append('file', new File([new Uint8Array(content)], 'synthetic.pdf', { type: 'application/pdf' }))
  form.append('kind', 'DEATH_CERTIFICATE')
  return { method: 'POST', body: form }
}

function withKey(init: RequestInit, key: string): RequestInit {
  return { ...init, headers: { 'Idempotency-Key': key } }
}

/** LocalObjectStorage は put 時にしかディレクトリーを作らない。0件なら原本は一切書かれていない。 */
function countStoredFiles(root: string): number {
  let count = 0
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else count += 1
    }
  }
  walk(root)
  return count
}

type ConsentState = 'none' | 'outdated' | 'agreed'

async function setup(
  state: ConsentState,
  options: { connectedOperations?: AgentOperation[] } = {},
) {
  const tenantId = newTenantId()
  const userId = 'user-owner'
  await seedTenantMember(tenantId, userId)
  const storageRoot = mkdtempSync(path.join(tmpdir(), 'after-flow-consent-'))
  const connectedOperations = options.connectedOperations ?? ['chat_reply', 'task_guidance']

  let app = buildApp(tenantId, userId, { connectedOperations, storageRoot })
  await agreeRequiredConsents(app)
  if (state !== 'none') {
    await agreeExternalAiConsent(app)
  }
  if (state === 'outdated') {
    // 版が改定された、という体で catalog だけ差し替えたアプリを作り直す。
    // 同意記録そのものは Firestore 上にそのまま残る（consents-api.test.ts と同じ手法）。
    app = buildApp(tenantId, userId, { connectedOperations, storageRoot, catalog: revisedCatalog() })
  }

  const created = await call(app, '/cases', jsonRequest('POST', caseBody, nextKey('idem-case')))
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const caseId = created.body.data.id as string

  const task = await call(
    app,
    `/cases/${caseId}/tasks`,
    jsonRequest('POST', { title: '架空の窓口手続き', stage: 'government', category: '行政手続き' }, nextKey('idem-task')),
  )
  const taskId = task.body.data.id as string

  return { tenantId, userId, app, caseId, taskId, storageRoot }
}

async function assertNoSideEffects(tenantId: string, caseId: string, storageRoot: string): Promise<void> {
  for (const sub of ['documents', 'messages', 'agentRuns', 'guidance']) {
    const snap = await firestore().collection(`tenants/${tenantId}/cases/${caseId}/${sub}`).get()
    assert.equal(snap.size, 0, `${sub} は空のままのはず`)
  }
  const audits = await firestore().collection(`tenants/${tenantId}/cases/${caseId}/auditEvents`).get()
  const forbidden = new Set(['document.registered', 'message.posted', 'guidance.requested', 'agent_run.accepted'])
  for (const doc of audits.docs) {
    assert.ok(!forbidden.has(doc.get('type') as string), `監査に ${doc.get('type')} が記録されてはいけない`)
  }
  const outbox = await firestore().collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`).get()
  for (const doc of outbox.docs) {
    const type = doc.get('type') as string
    assert.ok(!type.startsWith('agent.') && type !== 'document.registered', `Outboxに ${type} が積まれてはいけない`)
  }
  assert.equal(countStoredFiles(storageRoot), 0, '原本が一切書かれていないはず')
}

async function countIdempotencyRecords(tenantId: string): Promise<number> {
  const snap = await firestore().collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.idempotency}`).get()
  return snap.size
}

interface Entrypoint {
  name: string
  invoke: (app: ReturnType<typeof createApp>, caseId: string, taskId: string) => Promise<{ status: number; body: any }>
}

const entrypoints: Entrypoint[] = [
  {
    name: '書類登録',
    invoke: (app, caseId) =>
      call(app, `/cases/${caseId}/documents`, withKey(uploadRequest(syntheticPdf()), nextKey('idem-doc'))),
  },
  {
    name: 'チャット送信',
    invoke: (app, caseId) =>
      call(app, `/cases/${caseId}/messages`, jsonRequest('POST', { body: '同意の確認' }, nextKey('idem-message'))),
  },
  {
    name: '窓口調査依頼',
    invoke: (app, caseId, taskId) =>
      call(app, `/cases/${caseId}/tasks/${taskId}/guidance/requests`, jsonRequest('POST', {}, nextKey('idem-guidance'))),
  },
]

describeFirestore('外部AI同意（CROSS_BORDER_AI）のサーバー側強制', () => {
  for (const state of ['none', 'outdated'] as const) {
    for (const entrypoint of entrypoints) {
      it(`${entrypoint.name}: 同意が${state === 'none' ? '無い' : '版ずれ'}場合は保存前に403 CONSENT_REQUIREDで拒否する`, async () => {
        const { app, caseId, taskId, tenantId, storageRoot } = await setup(state)
        const idempotencyBefore = await countIdempotencyRecords(tenantId)
        const response = await entrypoint.invoke(app, caseId, taskId)

        assert.equal(response.status, 403, JSON.stringify(response.body))
        assert.equal(await countIdempotencyRecords(tenantId), idempotencyBefore, '冪等性記録が増えてはいけない')
        assert.equal(response.body.error.code, 'CONSENT_REQUIRED')
        assert.equal(response.body.error.retryable, false)
        assert.equal(response.body.error.details.requiredConsent, 'CROSS_BORDER_AI')
        assert.equal(
          response.body.error.details.currentVersion,
          state === 'outdated' ? REVISED_CROSS_BORDER_VERSION : CROSS_BORDER.version,
        )
        assert.equal(response.body.error.details.agreedVersion, state === 'outdated' ? CROSS_BORDER.version : null)
        assert.ok(response.body.error.details.missingOptional.includes('CROSS_BORDER_AI'))
        assert.ok(response.body.error.details.availableFeatures.length > 0)

        await assertNoSideEffects(tenantId, caseId, storageRoot)
      })
    }
  }

  for (const entrypoint of entrypoints) {
    it(`${entrypoint.name}: 同意済みなら受け付ける`, async () => {
      const { app, caseId, taskId } = await setup('agreed')
      const response = await entrypoint.invoke(app, caseId, taskId)
      assert.ok([201, 202].includes(response.status), JSON.stringify(response.body))
    })
  }

  it('書類登録: 同意済みなら STORED になる', async () => {
    const { app, caseId } = await setup('agreed')
    const response = await call(app, `/cases/${caseId}/documents`, withKey(uploadRequest(syntheticPdf()), nextKey('idem-doc')))
    assert.equal(response.status, 201)
    assert.equal(response.body.data.storageState, 'STORED')
  })

  it('チャット送信: 同意済みなら回答の実行を受け付ける', async () => {
    const { app, caseId } = await setup('agreed')
    const response = await call(app, `/cases/${caseId}/messages`, jsonRequest('POST', { body: '相談です' }, nextKey('idem-message')))
    assert.equal(response.status, 202)
    assert.equal(response.body.data.runAccepted, true)
  })

  it('窓口調査依頼: 同意済みなら RESEARCHING で受け付ける', async () => {
    const { app, caseId, taskId } = await setup('agreed')
    const response = await call(
      app,
      `/cases/${caseId}/tasks/${taskId}/guidance/requests`,
      jsonRequest('POST', {}, nextKey('idem-guidance')),
    )
    assert.equal(response.status, 202)
    assert.equal(response.body.data.status, 'RESEARCHING')
  })

  it('同意検査は接続判定より先: 未接続でも未同意なら403（501ではない）', async () => {
    const { app, caseId, taskId } = await setup('none', { connectedOperations: [] })
    const response = await call(
      app,
      `/cases/${caseId}/tasks/${taskId}/guidance/requests`,
      jsonRequest('POST', {}, nextKey('idem-guidance')),
    )
    assert.equal(response.status, 403)
    assert.equal(response.body.error.code, 'CONSENT_REQUIRED')
  })

  it('未接続だが同意済みなら501（順序を対で固定する）', async () => {
    const { app, caseId, taskId } = await setup('agreed', { connectedOperations: [] })
    const response = await call(
      app,
      `/cases/${caseId}/tasks/${taskId}/guidance/requests`,
      jsonRequest('POST', {}, nextKey('idem-guidance')),
    )
    assert.equal(response.status, 501)
    assert.equal(response.body.error.code, 'FEATURE_NOT_CONNECTED')
  })

  it('撤回後、同一Idempotency-Keyの再送は既存結果を返す（応答喪失時の再送と区別しない）', async () => {
    const { app, tenantId, caseId } = await setup('agreed')
    const key = nextKey('idem-doc-resend')
    const first = await call(app, `/cases/${caseId}/documents`, withKey(uploadRequest(syntheticPdf()), key))
    assert.equal(first.status, 201, JSON.stringify(first.body))

    assert.equal((await call(app, '/consents/revocations', jsonRequest('POST', { kind: 'CROSS_BORDER_AI' }))).status, 200)

    const second = await call(app, `/cases/${caseId}/documents`, withKey(uploadRequest(syntheticPdf()), key))
    assert.equal(second.status, 201, JSON.stringify(second.body))
    assert.equal(second.body.data.id, first.body.data.id)
    assert.equal(second.body.data.version, first.body.data.version)

    const stored = await firestore().collection(`tenants/${tenantId}/cases/${caseId}/documents`).get()
    assert.equal(stored.size, 1)
  })

  it('撤回後、新しい書類（別キー）の登録は403で拒否する', async () => {
    const { app, caseId } = await setup('agreed')
    const first = await call(app, `/cases/${caseId}/documents`, withKey(uploadRequest(syntheticPdf('a')), nextKey('idem-doc-a')))
    assert.equal(first.status, 201)

    assert.equal((await call(app, '/consents/revocations', jsonRequest('POST', { kind: 'CROSS_BORDER_AI' }))).status, 200)

    const second = await call(app, `/cases/${caseId}/documents`, withKey(uploadRequest(syntheticPdf('b')), nextKey('idem-doc-b')))
    assert.equal(second.status, 403)
    assert.equal(second.body.error.code, 'CONSENT_REQUIRED')
  })

  it('基本同意不足の403には requiredConsent が無い（外部AI同意不足と判別できる）', async () => {
    const tenantId = newTenantId()
    const userId = 'user-owner'
    await seedTenantMember(tenantId, userId)
    const app = buildApp(tenantId, userId, {})
    const response = await call(app, '/cases', jsonRequest('POST', caseBody, nextKey('idem-case')))
    assert.equal(response.status, 403)
    assert.equal(response.body.error.code, 'CONSENT_REQUIRED')
    assert.equal(response.body.error.details.requiredConsent, undefined)
    assert.ok(Array.isArray(response.body.error.details.availableOperations))
  })

  it('同意・AI接続・検査合格がそろえば解析を依頼でき、撤回後は再びCONSENT_REQUIREDに戻る', async () => {
    const passingInspector: DocumentInspector = {
      id: 'test-double',
      version: '0.0.0',
      inspect: async () => ({
        status: 'PASSED',
        findings: [],
        inspectorId: 'test-double',
        inspectorVersion: '0.0.0',
        maskedObjectKey: null,
      }),
    }
    const tenantId = newTenantId()
    const userId = 'user-owner'
    await seedTenantMember(tenantId, userId)
    const storageRoot = mkdtempSync(path.join(tmpdir(), 'after-flow-consent-view-'))
    const app = buildApp(tenantId, userId, { storageRoot, inspector: passingInspector, aiConnected: true })
    await agreeRequiredConsents(app)
    await agreeExternalAiConsent(app)
    const created = await call(app, '/cases', jsonRequest('POST', caseBody, nextKey('idem-case')))
    const caseId = created.body.data.id as string

    const registered = await call(app, `/cases/${caseId}/documents`, withKey(uploadRequest(syntheticPdf()), nextKey('idem-doc')))
    assert.equal(registered.status, 201, JSON.stringify(registered.body))
    assert.deepEqual(registered.body.data.analysis.blockedReasons, [])
    assert.equal(registered.body.data.analysis.canRequest, true)

    assert.equal((await call(app, '/consents/revocations', jsonRequest('POST', { kind: 'CROSS_BORDER_AI' }))).status, 200)

    const after = await call(app, `/cases/${caseId}/documents/${registered.body.data.id}`)
    assert.deepEqual(after.body.data.analysis.blockedReasons, ['CONSENT_REQUIRED'])
    assert.equal(after.body.data.analysis.canRequest, false)
  })
})
