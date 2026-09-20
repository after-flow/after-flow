import { describeFirestore } from './helpers/emulator.js'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { CASE_A, CASE_B, OUTSIDER, OWNER, VIEWER, createHarness } from './helpers/business.js'

const electricity = { name: '電気（従量電灯B）', kind: 'UTILITY', provider: '○○電力' }
const insurance = { name: '生命保険金', kind: 'INSURANCE_PAYOUT', provider: '□□生命', amount: 5_000_000 }

type H = ReturnType<typeof createHarness>

async function seedContract(h: H, body: object = electricity) {
  const res = await h.request('POST', `/cases/${CASE_A}/contracts`, { body })
  assert.equal(res.status, 201, JSON.stringify(res.json))
  return res.json.data
}

async function seedBenefit(h: H, body: object = insurance) {
  const res = await h.request('POST', `/cases/${CASE_A}/benefits`, { body })
  assert.equal(res.status, 201, JSON.stringify(res.json))
  return res.json.data
}

describeFirestore('contracts / benefits API', () => {
  it('creates contracts and benefits with UNDECIDED / NOT_STARTED defaults', async () => {
    const h = createHarness()
    const c = await seedContract(h)
    assert.equal(c.policy, 'UNDECIDED')
    assert.equal(c.progress, 'NOT_STARTED')
    assert.equal(c.source, 'MANUAL')
    assert.equal(c.progressRecord.source, null)
    assert.equal('guidance' in c, false)

    const b = await seedBenefit(h)
    assert.equal(b.progress, 'NOT_STARTED')
    assert.equal(b.amount, 5_000_000)
    assert.equal('deadline' in b, false)

    assert.equal((await h.request('GET', `/cases/${CASE_A}/contracts`)).json.data.length, 1)
    assert.equal((await h.request('GET', `/cases/${CASE_A}/benefits`)).json.data.length, 1)
  })

  it('does not accept policy / progress / guidance / deadline / source through registration or PATCH', async () => {
    const h = createHarness()
    for (const extra of [{ policy: 'CANCEL' }, { progress: 'COMPLETED' }, { source: 'AI' }, { guidance: { where: 'x' } }]) {
      const res = await h.request('POST', `/cases/${CASE_A}/contracts`, { body: { ...electricity, ...extra } })
      assert.equal(res.status, 400, JSON.stringify(extra))
    }
    for (const extra of [{ progress: 'COMPLETED' }, { deadline: {} }, { amount: -1 }]) {
      const res = await h.request('POST', `/cases/${CASE_A}/benefits`, { body: { ...insurance, ...extra } })
      assert.equal(res.status, 400, JSON.stringify(extra))
    }
    const c = await seedContract(h)
    const patch = await h.request('PATCH', `/cases/${CASE_A}/contracts/${c.id}`, {
      body: { expectedVersion: 1, policy: 'CANCEL' },
    })
    assert.equal(patch.status, 400)
    const okPatch = await h.request('PATCH', `/cases/${CASE_A}/contracts/${c.id}`, {
      body: { expectedVersion: 1, provider: '△△電力' },
    })
    assert.equal(okPatch.status, 200)
    assert.equal(okPatch.json.data.version, 2)
  })

  it('records policy via Command with decider and time; CANCEL is only a recorded intent', async () => {
    const h = createHarness()
    const c = await seedContract(h)
    const set = await h.request('POST', `/cases/${CASE_A}/contracts/${c.id}/policy`, {
      body: { expectedVersion: 1, policy: 'CANCEL', note: '使わないので解約予定' },
    })
    assert.equal(set.status, 200, JSON.stringify(set.json))
    assert.equal(set.json.data.policy, 'CANCEL')
    assert.equal(set.json.data.progress, 'NOT_STARTED')
    assert.equal(set.json.data.policyRecord.decidedBy, OWNER)
    assert.ok(set.json.data.policyRecord.decidedAt)

    const same = await h.request('POST', `/cases/${CASE_A}/contracts/${c.id}/policy`, {
      body: { expectedVersion: 2, policy: 'CANCEL' },
    })
    assert.equal(same.status, 409)
    assert.equal(same.json.error.code, 'PRECONDITION_FAILED')

    const stale = await h.request('POST', `/cases/${CASE_A}/contracts/${c.id}/policy`, {
      body: { expectedVersion: 1, policy: 'CONTINUE' },
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.json.error.code, 'CONFLICT')
  })

  it('reports progress as USER_REPORTED and enforces transitions', async () => {
    const h = createHarness()
    const c = await seedContract(h)
    const url = `/cases/${CASE_A}/contracts/${c.id}/progress`

    const undecidedComplete = await h.request('POST', url, { body: { expectedVersion: 1, progress: 'COMPLETED' } })
    assert.equal(undecidedComplete.status, 409)
    assert.equal(undecidedComplete.json.error.code, 'PRECONDITION_FAILED')

    const contacted = await h.request('POST', url, { body: { expectedVersion: 1, progress: 'CONTACTED' } })
    assert.equal(contacted.status, 200)
    assert.equal(contacted.json.data.progressRecord.source, 'USER_REPORTED')
    assert.equal(contacted.json.data.progressRecord.reportedBy, OWNER)

    await h.request('POST', `/cases/${CASE_A}/contracts/${c.id}/policy`, {
      body: { expectedVersion: 2, policy: 'CANCEL' },
    })
    const completed = await h.request('POST', url, { body: { expectedVersion: 3, progress: 'COMPLETED' } })
    assert.equal(completed.status, 200)
    assert.equal(completed.json.data.progress, 'COMPLETED')
    assert.equal(completed.json.data.progressRecord.source, 'USER_REPORTED')

    const policyAfterComplete = await h.request('POST', `/cases/${CASE_A}/contracts/${c.id}/policy`, {
      body: { expectedVersion: 4, policy: 'CONTINUE' },
    })
    assert.equal(policyAfterComplete.status, 409)

    const revertNoNote = await h.request('POST', url, { body: { expectedVersion: 4, progress: 'CONTACTED' } })
    assert.equal(revertNoNote.status, 409)
    const revert = await h.request('POST', url, {
      body: { expectedVersion: 4, progress: 'CONTACTED', note: '実際は書類が差し戻された' },
    })
    assert.equal(revert.status, 200)
    assert.equal(revert.json.data.progress, 'CONTACTED')
  })

  it('reports benefit progress and replays idempotent requests', async () => {
    const h = createHarness()
    const b = await seedBenefit(h)
    const url = `/cases/${CASE_A}/benefits/${b.id}/progress`
    const body = { expectedVersion: 1, progress: 'COMPLETED' }
    const first = await h.request('POST', url, { body, idempotencyKey: 'test-key-p1' })
    assert.equal(first.status, 200)
    const replay = await h.request('POST', url, { body, idempotencyKey: 'test-key-p1' })
    assert.equal(replay.status, 200)
    assert.equal(replay.json.data.version, first.json.data.version)
    const reused = await h.request('POST', url, { body: { ...body, expectedVersion: 2 }, idempotencyKey: 'test-key-p1' })
    assert.equal(reused.status, 409)
    assert.equal(reused.json.error.code, 'IDEMPOTENCY_KEY_REUSED')
    const noKey = await h.request('POST', url, { body, idempotencyKey: null })
    assert.equal(noKey.status, 428)
  })

  it('enforces Case membership, roles and Case isolation', async () => {
    const h = createHarness()
    const c = await seedContract(h)
    assert.equal((await h.request('GET', `/cases/${CASE_A}/contracts`, { user: OUTSIDER })).status, 404)
    const viewer = await h.request('POST', `/cases/${CASE_A}/contracts/${c.id}/policy`, {
      body: { expectedVersion: 1, policy: 'CONTINUE' },
      user: VIEWER,
    })
    assert.equal(viewer.status, 403)
    const cross = await h.request('POST', `/cases/${CASE_B}/contracts/${c.id}/policy`, {
      body: { expectedVersion: 1, policy: 'CONTINUE' },
      user: OUTSIDER,
    })
    assert.equal(cross.status, 404)
  })
})
