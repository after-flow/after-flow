import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createHash } from 'node:crypto'
import { AccessService } from '../../src/application/authorization/case-access.js'
import { ConsentService } from '../../src/application/consent/consent-service.js'
import { DocumentService } from '../../src/application/document/document-service.js'
import type { ObjectStorage, StoredObject } from '../../src/application/ports/object-storage.js'
import { PLACEHOLDER_CATALOG } from '../../src/domain/consent/catalog.js'
import { collections } from '../../src/domain/shared/collections.js'
import { agreeExternalAiConsent, agreeRequiredConsents, buildApp, call, jsonRequest, seedTenantMember } from './helpers/app.js'
import { describeFirestore, newTenantId, readRepository, unitOfWork, workContext } from './helpers/emulator.js'

async function setup() {
  const tenantId = newTenantId()
  const user = { tenantId, userId: 'owner' }
  await seedTenantMember(tenantId, user.userId)
  const app = buildApp(tenantId, user.userId)
  await agreeRequiredConsents(app)
  await agreeExternalAiConsent(app)
  const created = await call(app, '/cases', jsonRequest('POST', {
    deceasedName: '架空 太郎', dateOfDeath: '2026-04-01',
    ownerName: '架空 花子', relationshipToDeceased: '配偶者',
  }))
  assert.equal(created.status, 201)
  return { user, app, caseId: created.body.data.id as string }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describeFirestore('マージ前レビューの回帰検証', () => {
  it('重複した同意種別を400で拒否し、更新キー欠落を428で返す', async () => {
    const { app, caseId } = await setup()
    const duplicate = await call(app, '/consents', jsonRequest('POST', {
      agreements: [
        { kind: 'CROSS_BORDER_AI', version: '0.0.0-draft' },
        { kind: 'CROSS_BORDER_AI', version: '0.0.0-draft' },
      ],
    }))
    assert.equal(duplicate.status, 400)
    const missing = await call(app, `/cases/${caseId}`, jsonRequest('PATCH', {
      expectedVersion: 1, municipality: '架空市',
    }, null))
    assert.equal(missing.status, 428)
    const body = { expectedVersion: 1, municipality: '架空市' }
    const first = await call(app, `/cases/${caseId}`, jsonRequest('PATCH', body, 'update-replay'))
    const replay = await call(app, `/cases/${caseId}`, jsonRequest('PATCH', body, 'update-replay'))
    assert.equal(first.status, 200)
    assert.equal(replay.status, 200)
    assert.deepEqual(replay.body.data, first.body.data)
  })

  it('原本回収と旧アップロードの遅着が再送済み原本を壊さない', async () => {
    const { user, caseId } = await setup()
    const objects = new Map<string, StoredObject>()
    const entered = deferred()
    const release = deferred()
    let puts = 0
    const storage: ObjectStorage = {
      put: async (key, content, contentType) => {
        puts += 1
        if (puts === 1) { entered.resolve(); await release.promise }
        objects.set(key, { content, contentType })
      },
      get: async (key) => objects.get(key) ?? null,
      delete: async (key) => { objects.delete(key) },
      exists: async (key) => objects.has(key),
    }
    const read = readRepository()
    const uow = unitOfWork()
    const access = new AccessService(read)
    const consent = new ConsentService(PLACEHOLDER_CATALOG, access, read, uow)
    const service = new DocumentService(access, read, uow, storage, consent, null)
    const input = { fileName: 'fixture.pdf', kind: 'WILL' as const,
      declaredContentType: 'application/pdf', content: new Uint8Array(Buffer.from('%PDF-1.7\nfixture')) }
    const meta = { requestId: null, idempotency: { key: 'upload-race', fingerprint: 'fixture' } }
    const old = service.register(user, caseId, input, meta)
    const oldRejected = assert.rejects(old, (error: unknown) =>
      (error as { code: string }).code === 'CONFLICT')
    await entered.promise
    const reclaimed = await service.reclaimStaleUploads(user, caseId, 0)
    assert.equal(reclaimed.reclaimed.length, 1)
    const current = await service.register(user, caseId, input, meta)
    release.resolve()
    await oldRejected
    assert.equal(current.storageState, 'STORED')
    const fetched = await service.content(user, caseId, current.id)
    assert.deepEqual(fetched.content, input.content)
    assert.equal(objects.size, 1)
    await assert.rejects(service.register(user, caseId, { ...input, kind: 'CONTRACT' }, meta),
      (error: unknown) => (error as { code: string }).code === 'IDEMPOTENCY_KEY_REUSED')
    const saved = await read.get(user.tenantId, {
      collection: collections.documents, caseId, id: current.id,
    })
    assert.ok(saved)
    const key = [...objects.keys()][0]!
    objects.set(key, { content: new Uint8Array(Buffer.from('%PDF-1.7\nchanged')), contentType: 'application/pdf' })
    await assert.rejects(service.content(user, caseId, current.id),
      (error: unknown) => (error as { code: string }).code === 'INTERNAL')
    assert.equal(current.sha256, createHash('sha256').update(input.content).digest('hex'))
  })
  it('作成要求の再送は新しいIDを参照せず同じリソースを返す', async () => {
    const { app, caseId } = await setup()
    for (const [resource, body] of [
      ['tasks', { title: '手続き', summary: '試験', stage: 'immediate', category: '試験' }],
      ['proposals', { kind: 'TASK_PROPOSAL', title: '提案', payload: { title: '手続き', summary: '試験', stage: 'immediate', category: '試験' } }],
      ['messages', { body: '試験の発言' }],
    ] as const) {
      const key = 'replay-create-' + resource
      const first = await call(app, `/cases/${caseId}/${resource}`, jsonRequest('POST', body, key))
      const replay = await call(app, `/cases/${caseId}/${resource}`, jsonRequest('POST', body, key))
      assert.ok(first.status < 300, JSON.stringify(first.body))
      assert.equal(replay.status, first.status, JSON.stringify(replay.body))
      assert.deepEqual(replay.body.data, first.body.data)
      if (resource === 'proposals') {
        const path = `/cases/${caseId}/proposals/${first.body.data.id}/approval-requests`
        const approval = await call(app, path, jsonRequest('POST', { expectedVersion: 1 }, 'replay-approval'))
        const repeated = await call(app, path, jsonRequest('POST', { expectedVersion: 1 }, 'replay-approval'))
        assert.equal(approval.status, 201, JSON.stringify(approval.body))
        assert.deepEqual(repeated.body.data, approval.body.data)
      }
    }
  })

  it('Decision未登録の相続人も未確定とし、架空・除外済み人物の記録を拒否する', async () => {
    const { app, user, caseId } = await setup()
    const person = await call(app, `/cases/${caseId}/persons`, jsonRequest('POST', {
      name: '相続人', relationship: '家族', isHeir: true,
    }))
    const personId = person.body.data.id as string
    const overview = await call(app, `/cases/${caseId}/overview`)
    assert.equal(overview.body.data.inheritanceDecision.unknown, false)
    assert.equal(overview.body.data.inheritanceDecision.decided, false)
    assert.equal(overview.body.data.inheritanceDecision.perHeir[0].personName, '相続人')
    assert.equal((await call(app, `/cases/${caseId}/inheritance-decisions/absent`,
      jsonRequest('POST', { method: null, state: 'DRAFT' }))).status, 404)
    await call(app, `/cases/${caseId}/persons/${personId}/exclude`, jsonRequest('POST', { expectedVersion: 1 }))
    assert.equal((await call(app, `/cases/${caseId}/inheritance-decisions/${personId}`,
      jsonRequest('POST', { method: null, state: 'DRAFT' }))).status, 409)
    // orphan Decision は確定していても、Person が無ければ制限を解除しない。
    await unitOfWork().run(workContext(user.tenantId), async tx => {
      tx.create<import('../../src/domain/decision/inheritance-decision.js').InheritanceDecisionEntity>(
        { collection: collections.decisions, caseId, id: 'orphan' },
        { id: 'orphan', personId: 'orphan', method: 'SIMPLE_ACCEPTANCE', state: 'CONFIRMED',
          reportedByUserId: null, confirmedByUserId: user.userId, confirmedAt: null, note: null },
      )
    })
    const { StoredInheritanceDecisionReader } = await import('../../src/application/decision/decision-service.js')
    assert.equal(await new StoredInheritanceDecisionReader(readRepository()).isConfirmed(user.tenantId, caseId), false)
  })

})
