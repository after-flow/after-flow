import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { InsightResultInput } from '../../../../application/insights/insight-service.js'
import { DomainError } from '../../../../domain/shared/errors.js'
import { CASE_A, CASE_B, MEMBER, OUTSIDER, OWNER, TENANT, VIEWER, createHarness } from '../../../../test-support/harness.js'

type H = ReturnType<typeof createHarness>

const RUN_A = 'run_a'
const RUN_B = 'run_b'

function prepare(h: H) {
  h.container.agentRuns.register({ tenantId: TENANT, caseId: CASE_A, runId: RUN_A, status: 'SUCCEEDED' })
  h.container.agentRuns.register({ tenantId: TENANT, caseId: CASE_B, runId: RUN_B, status: 'SUCCEEDED' })
  h.container.evidence.setDocument(TENANT, CASE_A, 'doc_1', { version: 1, archived: false })
  h.container.evidence.setTask(TENANT, CASE_A, 'task_1', { version: 3, archived: false })
  h.container.evidence.setDocument(TENANT, CASE_B, 'doc_b', { version: 1, archived: false })
}

const result: InsightResultInput = {
  runId: RUN_A,
  resultId: 'r1',
  kind: 'POSSIBLE_CONTRACT',
  body: '通帳に毎月同じ金額の引き落としが続いています。',
  evidence: [
    { label: '引き落とし', value: '毎月27日 ・ 4,980円', documentId: 'doc_1', documentName: '通帳.jpg' },
    { label: '未着手のタスク', value: '契約の確認', taskId: 'task_1' },
  ],
  detectedAt: '2026-09-20T00:00:00.000Z',
  requiresProfessional: false,
}

async function receive(h: H, input: InsightResultInput = result) {
  return h.container.insightService.receiveInsightResult(TENANT, input)
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`)
}

describe('insights API', () => {
  it('lists received insights with evidence, run and actor-specific NEW status', async () => {
    const h = createHarness()
    prepare(h)
    const ins = await receive(h)
    const list = await h.request('GET', `/cases/${CASE_A}/insights`)
    assert.equal(list.status, 200)
    assert.equal(list.json.data.length, 1)
    const dto = list.json.data[0]
    assert.equal(dto.id, ins.id)
    assert.equal(dto.agentRunId, RUN_A)
    assert.equal(dto.status, 'NEW')
    assert.deepEqual(
      dto.evidence.map((e: { freshness: string }) => e.freshness),
      ['CURRENT', 'CURRENT'],
    )
    assert.equal((await h.request('GET', `/cases/${CASE_B}/insights`, { user: OUTSIDER })).json.data.length, 0)
  })

  it('validates run scope, evidence ownership, duplicates and missing evidence on receipt', async () => {
    const h = createHarness()
    prepare(h)
    await rejects(receive(h, { ...result, runId: 'run_unknown' }), 'NOT_FOUND')
    await rejects(receive(h, { ...result, evidence: [] }), 'VALIDATION_ERROR')
    await rejects(
      receive(h, { ...result, evidence: [{ label: 'x', value: 'y', documentId: 'doc_b' }] }),
      'VALIDATION_ERROR',
    )
    await rejects(receive(h, { ...result, relatedTaskId: 'task_other' }), 'VALIDATION_ERROR')
    await rejects(receive(h, { ...result, requiresProfessional: true }), 'VALIDATION_ERROR')
    await receive(h)
    await rejects(receive(h), 'DUPLICATE')
    await receive(h, { ...result, resultId: 'r2' })
    assert.equal((await h.request('GET', `/cases/${CASE_A}/insights`)).json.data.length, 2)
  })

  it('marks evidence STALE or UNAVAILABLE when the referenced target changes', async () => {
    const h = createHarness()
    prepare(h)
    await receive(h)
    h.container.evidence.setDocument(TENANT, CASE_A, 'doc_1', { version: 2, archived: false })
    h.container.evidence.setTask(TENANT, CASE_A, 'task_1', { version: 3, archived: true })
    const list = await h.request('GET', `/cases/${CASE_A}/insights`)
    assert.deepEqual(
      list.json.data[0].evidence.map((e: { freshness: string }) => e.freshness),
      ['STALE', 'UNAVAILABLE'],
    )
  })

  it('acknowledges and dismisses per actor without affecting other members', async () => {
    const h = createHarness()
    prepare(h)
    const ins = await receive(h)
    const ack = await h.request('POST', `/cases/${CASE_A}/insights/${ins.id}/acknowledge`, { body: {} })
    assert.equal(ack.status, 200, JSON.stringify(ack.json))
    assert.equal(ack.json.data.status, 'ACKNOWLEDGED')
    assert.ok(ack.json.data.statusUpdatedAt)

    const other = await h.request('GET', `/cases/${CASE_A}/insights`, { user: MEMBER })
    assert.equal(other.json.data[0].status, 'NEW')
    const mine = await h.request('GET', `/cases/${CASE_A}/insights`, { user: OWNER })
    assert.equal(mine.json.data[0].status, 'ACKNOWLEDGED')

    const viewerDismiss = await h.request('POST', `/cases/${CASE_A}/insights/${ins.id}/dismiss`, {
      body: { reason: '確認済み' },
      user: VIEWER,
    })
    assert.equal(viewerDismiss.status, 200)
    assert.equal(viewerDismiss.json.data.status, 'DISMISSED')
    assert.equal((await h.request('GET', `/cases/${CASE_A}/insights`, { user: OWNER })).json.data[0].status, 'ACKNOWLEDGED')
  })

  it('rejects invalid transitions, replays idempotent requests and requires a key', async () => {
    const h = createHarness()
    prepare(h)
    const ins = await receive(h)
    const url = `/cases/${CASE_A}/insights/${ins.id}`
    const first = await h.request('POST', `${url}/acknowledge`, { body: {}, idempotencyKey: 'a1' })
    const replay = await h.request('POST', `${url}/acknowledge`, { body: {}, idempotencyKey: 'a1' })
    assert.equal(replay.status, 200)
    assert.equal(replay.json.data.statusUpdatedAt, first.json.data.statusUpdatedAt)

    const again = await h.request('POST', `${url}/acknowledge`, { body: {} })
    assert.equal(again.status, 409)
    assert.equal(again.json.error.code, 'INVALID_TRANSITION')

    const dismissed = await h.request('POST', `${url}/dismiss`, { body: {} })
    assert.equal(dismissed.status, 200)
    const back = await h.request('POST', `${url}/acknowledge`, { body: {} })
    assert.equal(back.status, 409)

    assert.equal((await h.request('POST', `${url}/dismiss`, { body: {}, idempotencyKey: null })).status, 400)
    assert.equal((await h.request('POST', `${url}/dismiss`, { body: { status: 'DISMISSED' } })).status, 400)
  })

  it('enforces Case membership and isolation', async () => {
    const h = createHarness()
    prepare(h)
    const ins = await receive(h)
    assert.equal((await h.request('GET', `/cases/${CASE_A}/insights`, { user: OUTSIDER })).status, 403)
    const cross = await h.request('POST', `/cases/${CASE_B}/insights/${ins.id}/acknowledge`, {
      body: {},
      user: OUTSIDER,
    })
    assert.equal(cross.status, 404)
    assert.equal((await h.request('POST', `/cases/${CASE_A}/insights`, { body: {} })).status, 404)
  })
})
