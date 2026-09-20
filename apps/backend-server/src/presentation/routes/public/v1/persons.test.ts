import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CASE_A, CASE_B, MEMBER, OUTSIDER, TENANT, VIEWER, createHarness } from '../../../../test-support/harness.js'

const hanako = { name: '山田 花子', relationship: '配偶者', isHeir: true }

async function seedPerson(h: ReturnType<typeof createHarness>, body: object = hanako, caseId = CASE_A) {
  const res = await h.request('POST', `/cases/${caseId}/persons`, { body })
  assert.equal(res.status, 201, JSON.stringify(res.json))
  return res.json.data
}

describe('persons API', () => {
  it('creates and lists persons with {data, meta} envelope', async () => {
    const h = createHarness()
    const created = await seedPerson(h)
    assert.equal(created.version, 1)
    assert.equal(created.role, 'HEIR_CANDIDATE')
    assert.equal(created.excludedAt, null)

    const list = await h.request('GET', `/cases/${CASE_A}/persons`)
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.data.map((p: { id: string }) => p.id), [created.id])
    assert.equal(list.json.meta.nextCursor, null)
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
    assert.equal(p2.json.meta.nextCursor, null)
  })

  it('rejects invalid bodies and unknown fields', async () => {
    const h = createHarness()
    const missing = await h.request('POST', `/cases/${CASE_A}/persons`, { body: { relationship: '妻' } })
    assert.equal(missing.status, 400)
    assert.equal(missing.json.error.code, 'VALIDATION_ERROR')
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
    assert.equal(noKey.status, 400)

    const first = await h.request('POST', `/cases/${CASE_A}/persons`, { body: hanako, idempotencyKey: 'k1' })
    const replay = await h.request('POST', `/cases/${CASE_A}/persons`, { body: hanako, idempotencyKey: 'k1' })
    assert.equal(replay.status, 201)
    assert.equal(replay.json.data.id, first.json.data.id)
    const list = await h.request('GET', `/cases/${CASE_A}/persons`)
    assert.equal(list.json.data.length, 1)

    const reused = await h.request('POST', `/cases/${CASE_A}/persons`, {
      body: { ...hanako, name: '別人' },
      idempotencyKey: 'k1',
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
    assert.equal(stale.json.error.code, 'VERSION_CONFLICT')
    assert.equal(stale.json.error.details.actualVersion, 2)

    const noVersion = await h.request('PATCH', `/cases/${CASE_A}/persons/${p.id}`, { body: { note: 'x' } })
    assert.equal(noVersion.status, 400)
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

    const audit = h.container.audit.entries.map((e) => e.action)
    assert.deepEqual(audit, ['person.created', 'person.excluded'])
  })

  it('refuses exclusion while inheritance decisions reference the person', async () => {
    const h = createHarness()
    const p = await seedPerson(h)
    h.container.personReferences.register(TENANT, CASE_A, p.id, { inheritanceDecisions: 1 })
    const ex = await h.request('POST', `/cases/${CASE_A}/persons/${p.id}/exclude`, { body: { expectedVersion: 1 } })
    assert.equal(ex.status, 409)
    assert.equal(ex.json.error.code, 'REFERENCED')
  })

  it('enforces case membership and roles', async () => {
    const h = createHarness()
    const p = await seedPerson(h)

    const anon = await h.request('GET', `/cases/${CASE_A}/persons`, { user: null })
    assert.equal(anon.status, 401)

    const outsiderList = await h.request('GET', `/cases/${CASE_A}/persons`, { user: OUTSIDER })
    assert.equal(outsiderList.status, 403)

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

  it('returns 503 when no identity verifier is configured', async () => {
    const { createApp } = await import('../../../../app.js')
    const { createContainer } = await import('../../../../composition.js')
    const app = createApp(createContainer({}))
    const res = await app.request(`/api/v1/cases/${CASE_A}/persons`, { headers: { 'x-dev-user-id': 'u' } })
    assert.equal(res.status, 503)
    const health = await app.request('/api/v1/health')
    assert.equal(health.status, 200)
  })
})

describe('relationships API', () => {
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
