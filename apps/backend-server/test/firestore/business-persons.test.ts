import { describeFirestore } from './helpers/emulator.js'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { CASE_A, CASE_B, MEMBER, OUTSIDER, VIEWER, createHarness } from './helpers/business.js'

const hanako = { name: '山田 花子', relationship: '配偶者', isHeir: true }

async function seedPerson(h: ReturnType<typeof createHarness>, body: object = hanako, caseId = CASE_A) {
  const res = await h.request('POST', `/cases/${caseId}/persons`, { body })
  assert.equal(res.status, 201, JSON.stringify(res.json))
  return res.json.data
}

describeFirestore('persons API', () => {
  it('creates and lists persons with {data, meta} envelope', async () => {
    const h = createHarness()
    const created = await seedPerson(h)
    assert.equal(created.version, 1)
    assert.equal(created.role, 'HEIR_CANDIDATE')
    assert.equal(created.excludedAt, null)

    const list = await h.request('GET', `/cases/${CASE_A}/persons`)
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.data.map((p: { id: string }) => p.id), [created.id])
    assert.equal(list.json.meta.nextCursor, undefined)
    assert.ok(list.json.meta.requestId)
  })

  it('paginates with cursor', async () => {
    const h = createHarness()
    for (let i = 0; i < 3; i++) await seedPerson(h, { ...hanako, name: `p${i}` })
    const p1 = await h.request('GET', `/cases/${CASE_A}/persons?limit=2`)
    assert.equal(p1.json.data.length, 2)
    assert.ok(p1.json.meta.nextCursor)
    const p2 = await h.request('GET', `/cases/${CASE_A}/persons?limit=2&cursor=${p1.json.meta.nextCursor}`)
    assert.equal(p2.json.data.length, 1)
    assert.equal(p2.json.meta.nextCursor, undefined)
  })

  it('rejects invalid bodies and unknown fields', async () => {
    const h = createHarness()
    const missing = await h.request('POST', `/cases/${CASE_A}/persons`, { body: { relationship: '妻' } })
    assert.equal(missing.status, 400)
    assert.equal(missing.json.error.code, 'VALIDATION_FAILED')
    const forged = await h.request('POST', `/cases/${CASE_A}/persons`, { body: { ...hanako, caseId: CASE_B } })
    assert.equal(forged.status, 400)
    const deceasedHeir = await h.request('POST', `/cases/${CASE_A}/persons`, {
      body: { name: '故人', relationship: '本人', role: 'DECEASED', isHeir: true },
    })
    assert.equal(deceasedHeir.status, 400)
  })

  it('requires Idempotency-Key on writes and replays identical requests', async () => {
    const h = createHarness()
    const noKey = await h.request('POST', `/cases/${CASE_A}/persons`, { body: hanako, idempotencyKey: null })
    assert.equal(noKey.status, 428)

    const first = await h.request('POST', `/cases/${CASE_A}/persons`, { body: hanako, idempotencyKey: 'idempotency-k1' })
    const replay = await h.request('POST', `/cases/${CASE_A}/persons`, { body: hanako, idempotencyKey: 'idempotency-k1' })
    assert.equal(replay.status, 201)
    assert.equal(replay.json.data.id, first.json.data.id)
    const list = await h.request('GET', `/cases/${CASE_A}/persons`)
    assert.equal(list.json.data.length, 1)

    const reused = await h.request('POST', `/cases/${CASE_A}/persons`, {
      body: { ...hanako, name: '別人' },
      idempotencyKey: 'idempotency-k1',
    })
    assert.equal(reused.status, 409)
    assert.equal(reused.json.error.code, 'IDEMPOTENCY_KEY_REUSED')
  })

  it('updates with expectedVersion and rejects stale versions', async () => {
    const h = createHarness()
    const p = await seedPerson(h)
    const ok = await h.request('PATCH', `/cases/${CASE_A}/persons/${p.id}`, {
      body: { note: '要連絡', expectedVersion: 1 },
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.data.version, 2)
    assert.equal(ok.json.data.note, '要連絡')

    const stale = await h.request('PATCH', `/cases/${CASE_A}/persons/${p.id}`, {
      body: { note: '古い', expectedVersion: 1 },
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.json.error.code, 'CONFLICT')
    assert.equal(stale.json.error.details.actualVersion, 2)

    const noVersion = await h.request('PATCH', `/cases/${CASE_A}/persons/${p.id}`, { body: { note: 'x' } })
    assert.equal(noVersion.status, 428)
  })

  it('excludes instead of deleting and hides excluded by default', async () => {
    const h = createHarness()
    const p = await seedPerson(h)
    const ex = await h.request('POST', `/cases/${CASE_A}/persons/${p.id}/exclude`, {
      body: { expectedVersion: 1, reason: '誤登録' },
    })
    assert.equal(ex.status, 200)
    assert.ok(ex.json.data.excludedAt)

    const list = await h.request('GET', `/cases/${CASE_A}/persons`)
    assert.equal(list.json.data.length, 0)
    const withExcluded = await h.request('GET', `/cases/${CASE_A}/persons?includeExcluded=true`)
    assert.equal(withExcluded.json.data.length, 1)
    assert.equal(withExcluded.json.data[0].name, '山田 花子')

    const again = await h.request('POST', `/cases/${CASE_A}/persons/${p.id}/exclude`, {
      body: { expectedVersion: 2 },
    })
    assert.equal(again.status, 400)
    const edit = await h.request('PATCH', `/cases/${CASE_A}/persons/${p.id}`, {
      body: { note: 'x', expectedVersion: 2 },
    })
    assert.equal(edit.status, 400)

    const audit = await h.auditActions()
    assert.deepEqual(audit.filter(type => type !== 'case.context_changed'), ['person.created', 'person.excluded'])
    assert.equal(audit.filter(type => type === 'case.context_changed').length, 2)
  })

  it('refuses exclusion while inheritance decisions reference the person', async () => {
    const h = createHarness()
    const p = await seedPerson(h)
    await h.seed('decisions', CASE_A, p.id, { personId: p.id })
    const ex = await h.request('POST', `/cases/${CASE_A}/persons/${p.id}/exclude`, { body: { expectedVersion: 1 } })
    assert.equal(ex.status, 409)
    assert.equal(ex.json.error.code, 'PRECONDITION_FAILED')
  })

  it('enforces case membership and roles', async () => {
    const h = createHarness()
    const p = await seedPerson(h)

    const anon = await h.request('GET', `/cases/${CASE_A}/persons`, { user: null })
    assert.equal(anon.status, 401)

    const outsiderList = await h.request('GET', `/cases/${CASE_A}/persons`, { user: OUTSIDER })
    assert.equal(outsiderList.status, 404)

    const crossCase = await h.request('PATCH', `/cases/${CASE_B}/persons/${p.id}`, {
      user: OUTSIDER,
      body: { note: 'hijack', expectedVersion: 1 },
    })
    assert.equal(crossCase.status, 404)

    const viewerWrite = await h.request('POST', `/cases/${CASE_A}/persons`, { user: VIEWER, body: hanako })
    assert.equal(viewerWrite.status, 403)
    const viewerRead = await h.request('GET', `/cases/${CASE_A}/persons`, { user: VIEWER })
    assert.equal(viewerRead.status, 200)

    const memberWrite = await h.request('POST', `/cases/${CASE_A}/persons`, { user: MEMBER, body: hanako })
    assert.equal(memberWrite.status, 201)
  })

  it('rejects self-reported dev headers when authentication is unconfigured', async () => {
    const { createServer } = await import('../../src/composition.js')
    const app = createServer({})
    const res = await app.request(`/api/v1/cases/${CASE_A}/persons`, { headers: { 'x-dev-user-id': 'u' } })
    assert.equal(res.status, 401)
    assert.equal((await app.request('/api/v1/health')).status, 200)
  })
})

describeFirestore('Firestore の並行更新と再起動後の永続性', () => {
  it('並行した同じキーの作成は1件・監査1件で確定する', async () => {
    const h = createHarness()
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      h.request('POST', `/cases/${CASE_A}/persons`, { body: hanako, idempotencyKey: 'concurrent-person' })))
    for (const result of results) {
      assert.equal(result.status, 201, JSON.stringify(result.json))
      assert.deepEqual(result.json.data, results[0]!.json.data)
    }
    assert.equal((await h.request('GET', `/cases/${CASE_A}/persons`)).json.data.length, 1)
    assert.equal((await h.auditActions()).filter(action => action === 'person.created').length, 1)
    const { createBusinessServices } = await import('../../src/infrastructure/firestore/business-services.js')
    const { AccessService } = await import('../../src/application/authorization/case-access.js')
    const { readRepository, unitOfWork } = await import('./helpers/emulator.js')
    const fresh = createBusinessServices(new AccessService(readRepository()), readRepository(), unitOfWork())
    const page = await fresh.personService.listPersons({
      caseId: CASE_A, principal: { tenantId: h.tenantId, userId: 'user_owner' }, requestId: 'restart', idempotencyKey: null,
    }, { limit: 50, cursor: null, includeExcluded: false })
    assert.equal(page.items[0]!.id, results[0]!.json.data.id)
  })

  it('同じ版への並行更新は片方のみ確定し、失敗側の監査を残さない', async () => {
    const h = createHarness()
    const person = await seedPerson(h)
    const results = await Promise.all(['A', 'B'].map(name =>
      h.request('PATCH', `/cases/${CASE_A}/persons/${person.id}`, { body: { name, expectedVersion: 1 } })))
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
    assert.equal((await h.auditActions()).filter(action => action === 'person.updated').length, 1)
  })
})

describeFirestore('relationships API', () => {
  it('links two persons of the same case', async () => {
    const h = createHarness()
    const a = await seedPerson(h)
    const b = await seedPerson(h, { name: '山田 一郎', relationship: '長男' })
    const res = await h.request('POST', `/cases/${CASE_A}/relationships`, {
      body: { fromPersonId: a.id, toPersonId: b.id, kind: 'CHILD' },
    })
    assert.equal(res.status, 201)
    assert.equal(res.json.data.kind, 'CHILD')

    const list = await h.request('GET', `/cases/${CASE_A}/relationships`)
    assert.equal(list.json.data.length, 1)

    const upd = await h.request('PATCH', `/cases/${CASE_A}/relationships/${res.json.data.id}`, {
      body: { kind: 'ADOPTED_CHILD', expectedVersion: 1 },
    })
    assert.equal(upd.status, 200)
    assert.equal(upd.json.data.version, 2)

    const ex = await h.request('POST', `/cases/${CASE_A}/relationships/${res.json.data.id}/exclude`, {
      body: { expectedVersion: 2 },
    })
    assert.equal(ex.status, 200)
    assert.equal((await h.request('GET', `/cases/${CASE_A}/relationships`)).json.data.length, 0)
  })

  it('rejects cross-case, self, and excluded endpoints', async () => {
    const h = createHarness()
    const a = await seedPerson(h)
    const other = await h.request('POST', `/cases/${CASE_B}/persons`, { user: OUTSIDER, body: hanako })
    assert.equal(other.status, 201)

    const cross = await h.request('POST', `/cases/${CASE_A}/relationships`, {
      body: { fromPersonId: a.id, toPersonId: other.json.data.id, kind: 'SPOUSE' },
    })
    assert.equal(cross.status, 404)

    const self = await h.request('POST', `/cases/${CASE_A}/relationships`, {
      body: { fromPersonId: a.id, toPersonId: a.id, kind: 'SPOUSE' },
    })
    assert.equal(self.status, 400)

    const b = await seedPerson(h, { name: 'B', relationship: '長女' })
    await h.request('POST', `/cases/${CASE_A}/persons/${b.id}/exclude`, { body: { expectedVersion: 1 } })
    const excluded = await h.request('POST', `/cases/${CASE_A}/relationships`, {
      body: { fromPersonId: a.id, toPersonId: b.id, kind: 'CHILD' },
    })
    assert.equal(excluded.status, 400)
  })
})
