import { describeFirestore } from './helpers/emulator.js'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { InsightResultInput } from '../../src/application/insights/insight-service.js'
import { AppError } from '../../src/shared/app-error.js'
import { CASE_A, CASE_B, MEMBER, OUTSIDER, OWNER, VIEWER, createHarness } from './helpers/business.js'

type H = ReturnType<typeof createHarness>

const RUN_A = 'run_a'
const RUN_B = 'run_b'

async function prepare(h: H) {
  await h.ready
  await h.seed('agentRuns', CASE_A, RUN_A, { status: 'RUNNING', currentAttemptId: 'attempt-1' })
  await h.seed('agentRuns', CASE_B, RUN_B, { status: 'RUNNING', currentAttemptId: 'attempt-1' })
  await h.seed('documents', CASE_A, 'doc_1', { storageState: 'STORED', archivedAt: null })
  await h.seed('tasks', CASE_A, 'task_1', { version: 3 })
  await h.seed('documents', CASE_B, 'doc_b', { storageState: 'STORED', archivedAt: null })
}

const result: InsightResultInput = {
  runId: RUN_A,
  currentAttemptId: 'attempt-1',
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
  return h.services.insightService.receiveInsightResult(h.tenantId, CASE_A, input)
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof AppError && e.code === code, `expected ${code}`)
}

describeFirestore('insights API', () => {
  it('lists received insights with evidence, run and actor-specific NEW status', async () => {
    const h = createHarness()
    await prepare(h)
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
    await prepare(h)
    await rejects(receive(h, { ...result, runId: 'run_unknown' }), 'NOT_FOUND')
    await rejects(receive(h, { ...result, evidence: [] }), 'VALIDATION_FAILED')
    await rejects(
      receive(h, { ...result, evidence: [{ label: 'x', value: 'y', documentId: 'doc_b' }] }),
      'VALIDATION_FAILED',
    )
    await rejects(receive(h, { ...result, relatedTaskId: 'task_other' }), 'VALIDATION_FAILED')
    await rejects(receive(h, { ...result, requiresProfessional: true }), 'VALIDATION_FAILED')
    await receive(h)
    await rejects(receive(h), 'CONFLICT')
    await receive(h, { ...result, resultId: 'r2' })
    assert.equal((await h.request('GET', `/cases/${CASE_A}/insights`)).json.data.length, 2)
  })

  it('marks evidence STALE or UNAVAILABLE when the referenced target changes', async () => {
    const h = createHarness()
    await prepare(h)
    await receive(h)
    await h.seed('documents', CASE_A, 'doc_1', { version: 2, storageState: 'STORED', archivedAt: null })
    await h.seed('tasks', CASE_A, 'task_1', { version: 4 })
    const list = await h.request('GET', `/cases/${CASE_A}/insights`)
    assert.deepEqual(
      list.json.data[0].evidence.map((e: { freshness: string }) => e.freshness),
      ['STALE', 'STALE'],
    )
  })

  it('acknowledges and dismisses per actor without affecting other members', async () => {
    const h = createHarness()
    await prepare(h)
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
    await prepare(h)
    const ins = await receive(h)
    const url = `/cases/${CASE_A}/insights/${ins.id}`
    const first = await h.request('POST', `${url}/acknowledge`, { body: {}, idempotencyKey: 'test-key-a1' })
    const replay = await h.request('POST', `${url}/acknowledge`, { body: {}, idempotencyKey: 'test-key-a1' })
    assert.equal(replay.status, 200)
    assert.equal(replay.json.data.statusUpdatedAt, first.json.data.statusUpdatedAt)

    const again = await h.request('POST', `${url}/acknowledge`, { body: {} })
    assert.equal(again.status, 409)
    assert.equal(again.json.error.code, 'PRECONDITION_FAILED')

    const dismissed = await h.request('POST', `${url}/dismiss`, { body: {} })
    assert.equal(dismissed.status, 200)
    const back = await h.request('POST', `${url}/acknowledge`, { body: {} })
    assert.equal(back.status, 409)

    assert.equal((await h.request('POST', `${url}/dismiss`, { body: {}, idempotencyKey: null })).status, 428)
    assert.equal((await h.request('POST', `${url}/dismiss`, { body: { status: 'DISMISSED' } })).status, 400)
  })

  it('enforces Case membership and isolation', async () => {
    const h = createHarness()
    await prepare(h)
    const ins = await receive(h)
    assert.equal((await h.request('GET', `/cases/${CASE_A}/insights`, { user: OUTSIDER })).status, 404)
    const cross = await h.request('POST', `/cases/${CASE_B}/insights/${ins.id}/acknowledge`, {
      body: {},
      user: OUTSIDER,
    })
    assert.equal(cross.status, 404)
    assert.equal((await h.request('POST', `/cases/${CASE_A}/insights`, { body: {} })).status, 404)
  })
  it('rejects old attempts and cancelled runs, and commits concurrent results only once', async () => {
    const h = createHarness()
    await prepare(h)
    await rejects(receive(h, { ...result, currentAttemptId: 'old-attempt' }), 'CONFLICT')
    await h.seed('agentRuns', CASE_A, RUN_A, { status: 'CANCELLED', currentAttemptId: 'attempt-1' })
    await rejects(receive(h), 'CONFLICT')
    await h.seed('agentRuns', CASE_A, RUN_A, { status: 'RUNNING', currentAttemptId: 'attempt-1' })
    const received = await Promise.allSettled([receive(h), receive(h)])
    assert.equal(received.filter(outcome => outcome.status === 'fulfilled').length, 1)
    assert.equal((await h.request('GET', `/cases/${CASE_A}/insights`)).json.data.length, 1)
    assert.equal((await h.auditActions()).filter(action => action === 'insight.received').length, 1)
  })

})
