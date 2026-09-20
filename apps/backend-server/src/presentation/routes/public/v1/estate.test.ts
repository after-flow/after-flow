import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CASE_A, CASE_B, OUTSIDER, OWNER, VIEWER, createHarness } from '../../../../test-support/harness.js'

const bank = { name: '○○銀行 普通預金', kind: 'BANK', institution: '○○銀行', amount: 3_240_000 }
const card = { name: 'カード未払い', kind: 'CREDIT', creditor: '××カード', amount: 68_000 }

async function seedAsset(h: ReturnType<typeof createHarness>, body: object = bank, caseId = CASE_A) {
  const res = await h.request('POST', `/cases/${caseId}/assets`, { body })
  assert.equal(res.status, 201, JSON.stringify(res.json))
  return res.json.data
}

describe('assets / liabilities API', () => {
  it('creates MANUAL, UNCONFIRMED items and lists them', async () => {
    const h = createHarness()
    const a = await seedAsset(h)
    assert.equal(a.source, 'MANUAL')
    assert.equal(a.confirmation, 'UNCONFIRMED')
    assert.equal(a.currency, 'JPY')
    assert.equal(a.amount, 3_240_000)
    assert.equal(a.version, 1)

    const l = await h.request('POST', `/cases/${CASE_A}/liabilities`, { body: card })
    assert.equal(l.status, 201)
    assert.equal(l.json.data.source, 'MANUAL')

    const list = await h.request('GET', `/cases/${CASE_A}/assets`)
    assert.deepEqual(list.json.data.map((x: { id: string }) => x.id), [a.id])
    const llist = await h.request('GET', `/cases/${CASE_A}/liabilities`)
    assert.equal(llist.json.data.length, 1)
  })

  it('distinguishes unknown amount from zero and validates yen range', async () => {
    const h = createHarness()
    const unknown = await seedAsset(h, { name: '自宅', kind: 'REAL_ESTATE' })
    assert.equal('amount' in unknown, false)
    const zero = await seedAsset(h, { name: '残高ゼロ口座', kind: 'BANK', amount: 0 })
    assert.equal(zero.amount, 0)

    for (const amount of [-1, 1.5, 1_000_000_000_000_000]) {
      const bad = await h.request('POST', `/cases/${CASE_A}/assets`, { body: { ...bank, amount } })
      assert.equal(bad.status, 400, `amount=${amount}`)
    }
    const cleared = await h.request('PATCH', `/cases/${CASE_A}/assets/${zero.id}`, {
      body: { expectedVersion: 1, amount: null },
    })
    assert.equal(cleared.status, 200)
    assert.equal('amount' in cleared.json.data, false)
  })

  it('rejects forged source / AI run identifiers and unknown fields', async () => {
    const h = createHarness()
    for (const extra of [{ source: 'AI' }, { agentRunId: 'run_1' }, { confirmation: 'CONFIRMED' }, { caseId: CASE_B }]) {
      const res = await h.request('POST', `/cases/${CASE_A}/assets`, { body: { ...bank, ...extra } })
      assert.equal(res.status, 400, JSON.stringify(extra))
      assert.equal(res.json.error.code, 'VALIDATION_ERROR')
    }
    const patched = await h.request('PATCH', `/cases/${CASE_A}/liabilities/x`, {
      body: { expectedVersion: 1, confirmation: 'CONFIRMED' },
    })
    assert.equal(patched.status, 400)
  })

  it('confirms via explicit Command recording confirmer, time and version', async () => {
    const h = createHarness()
    const a = await seedAsset(h)
    const stale = await h.request('POST', `/cases/${CASE_A}/assets/${a.id}/confirm`, { body: { expectedVersion: 5 } })
    assert.equal(stale.status, 409)
    assert.equal(stale.json.error.code, 'VERSION_CONFLICT')

    const ok = await h.request('POST', `/cases/${CASE_A}/assets/${a.id}/confirm`, {
      body: { expectedVersion: 1, note: '通帳で確認' },
    })
    assert.equal(ok.status, 200, JSON.stringify(ok.json))
    assert.equal(ok.json.data.confirmation, 'CONFIRMED')
    assert.equal(ok.json.data.version, 2)
    assert.equal(ok.json.data.confirmationRecord.confirmedVersion, 1)
    assert.equal(ok.json.data.confirmationRecord.confirmedBy, OWNER)
    assert.ok(ok.json.data.confirmationRecord.confirmedAt)

    const twice = await h.request('POST', `/cases/${CASE_A}/assets/${a.id}/confirm`, { body: { expectedVersion: 2 } })
    assert.equal(twice.status, 409)
    assert.equal(twice.json.error.code, 'INVALID_TRANSITION')
  })

  it('replays identical confirm requests and rejects key reuse with a different body', async () => {
    const h = createHarness()
    const a = await seedAsset(h)
    const first = await h.request('POST', `/cases/${CASE_A}/assets/${a.id}/confirm`, {
      body: { expectedVersion: 1 },
      idempotencyKey: 'c1',
    })
    const replay = await h.request('POST', `/cases/${CASE_A}/assets/${a.id}/confirm`, {
      body: { expectedVersion: 1 },
      idempotencyKey: 'c1',
    })
    assert.equal(replay.status, 200)
    assert.equal(replay.json.data.version, first.json.data.version)
    const reused = await h.request('POST', `/cases/${CASE_A}/assets/${a.id}/confirm`, {
      body: { expectedVersion: 2 },
      idempotencyKey: 'c1',
    })
    assert.equal(reused.status, 409)
    assert.equal(reused.json.error.code, 'IDEMPOTENCY_KEY_REUSED')
  })

  it('resets confirmation when confirmed values change, but not for memo-only edits', async () => {
    const h = createHarness()
    const l = (await h.request('POST', `/cases/${CASE_A}/liabilities`, { body: card })).json.data
    await h.request('POST', `/cases/${CASE_A}/liabilities/${l.id}/confirm`, { body: { expectedVersion: 1 } })

    const memo = await h.request('PATCH', `/cases/${CASE_A}/liabilities/${l.id}`, {
      body: { expectedVersion: 2, note: '督促状あり' },
    })
    assert.equal(memo.status, 200)
    assert.equal(memo.json.data.confirmation, 'CONFIRMED')

    const amount = await h.request('PATCH', `/cases/${CASE_A}/liabilities/${l.id}`, {
      body: { expectedVersion: 3, amount: 70_000 },
    })
    assert.equal(amount.status, 200)
    assert.equal(amount.json.data.confirmation, 'UNCONFIRMED')
    assert.equal(amount.json.data.confirmationRecord.confirmedAt, null)

    const stale = await h.request('PATCH', `/cases/${CASE_A}/liabilities/${l.id}`, {
      body: { expectedVersion: 3, amount: 1 },
    })
    assert.equal(stale.status, 409)
  })

  it('enforces Case membership, roles and Case isolation', async () => {
    const h = createHarness()
    const a = await seedAsset(h)
    const outsider = await h.request('GET', `/cases/${CASE_A}/assets`, { user: OUTSIDER })
    assert.equal(outsider.status, 403)
    const viewerWrite = await h.request('POST', `/cases/${CASE_A}/assets/${a.id}/confirm`, {
      body: { expectedVersion: 1 },
      user: VIEWER,
    })
    assert.equal(viewerWrite.status, 403)
    const viewerRead = await h.request('GET', `/cases/${CASE_A}/assets`, { user: VIEWER })
    assert.equal(viewerRead.status, 200)

    const wrongCase = await h.request('PATCH', `/cases/${CASE_B}/assets/${a.id}`, {
      body: { expectedVersion: 1, name: 'x' },
    })
    assert.equal(wrongCase.status, 403)
    const crossCase = await h.request('PATCH', `/cases/${CASE_B}/assets/${a.id}`, {
      body: { expectedVersion: 1, name: 'x' },
      user: OUTSIDER,
    })
    assert.equal(crossCase.status, 404)
    const crossConfirm = await h.request('POST', `/cases/${CASE_B}/assets/${a.id}/confirm`, {
      body: { expectedVersion: 1 },
      user: OUTSIDER,
    })
    assert.equal(crossConfirm.status, 404)
  })
})
