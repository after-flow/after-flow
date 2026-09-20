import assert from 'node:assert/strict'
import { it } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { AccessService } from '../../src/application/authorization/case-access.js'
import { ConsentService } from '../../src/application/consent/consent-service.js'
import { CaseLeaseService } from '../../src/application/agent/lease-service.js'
import { OutboxDispatcher, backoffMs } from '../../src/application/agent/outbox-dispatcher.js'
import { caseTaskHandler } from '../../src/application/agent/outbox-worker.js'
import { TaskService } from '../../src/application/task/task-service.js'
import { PLACEHOLDER_RULE_CATALOG } from '../../src/domain/task/rule-catalog.js'
import type { OutboxEvent } from '../../src/domain/shared/outbox.js'
import { PLACEHOLDER_CATALOG } from '../../src/domain/consent/catalog.js'
import { INFRASTRUCTURE_COLLECTIONS } from '../../src/domain/shared/collections.js'
import { HttpAgentJobClient } from '../../src/infrastructure/agent/http-agent-client.js'
import { AppError } from '../../src/shared/app-error.js'
import {
  agreeRequiredConsents,
  buildApp,
  call,
  jsonRequest,
  seedTenantMember,
} from './helpers/app.js'
import type { Json } from './helpers/app.js'
import {
  describeFirestore,
  firestore,
  newId,
  newTenantId,
  readRepository,
  unitOfWork,
  workContext,
} from './helpers/emulator.js'
import { startFakeAiServer } from './helpers/fake-ai-server.js'

const SERVICE_TOKEN = 'test-service-token'

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

const CROSS_BORDER = PLACEHOLDER_CATALOG.documents.find((d) => d.kind === 'CROSS_BORDER_AI')!

async function setup(options: { connectedOperations?: string[]; agreeExternalAi?: boolean } = {}) {
  const tenantId = newTenantId()
  const userId = 'user-owner'
  await seedTenantMember(tenantId, userId)
  const app = buildApp(tenantId, userId, {
    connectedOperations: (options.connectedOperations ?? ['case_planning']) as never,
  })
  await agreeRequiredConsents(app)
  if (options.agreeExternalAi !== false) {
    await call(
      app,
      '/consents',
      jsonRequest(
        'POST',
        { agreements: [{ kind: CROSS_BORDER.kind, version: CROSS_BORDER.version }] },
        nextKey('idem-consent'),
      ),
    )
  }
  const created = await call(app, '/cases', jsonRequest('POST', caseBody, nextKey('idem-case')))
  assert.equal(created.status, 201)
  return { tenantId, userId, app, caseId: created.body.data.id as string }
}

function acceptBody(caseId: string) {
  return { operation: 'case_planning', targetType: 'CASE', targetId: caseId }
}

describeFirestore('AI実行の受付', () => {
  it('202で受け付け、完了として返さない', async () => {
    const { app, caseId } = await setup()
    const response = await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(caseId), nextKey('idem-run')),
    )

    assert.equal(response.status, 202)
    assert.equal(response.body.data.status, 'QUEUED')
    assert.equal(response.body.data.attempt, 1)
    assert.equal(response.body.data.waiting, false)
    assert.equal(response.body.data.caseVersionAtAccept, 1)
  })

  it('接続されていない操作を理由付きで拒否する', async () => {
    const { app, caseId } = await setup({ connectedOperations: [] })
    const response = await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(caseId), nextKey('idem-run')),
    )

    // UI にボタンがあるだけで全操作を有効にしない。
    assert.equal(response.status, 501)
    assert.equal(response.body.error.code, 'FEATURE_NOT_CONNECTED')
    assert.deepEqual(response.body.error.details.connectedOperations, [])
  })

  it('外部AI同意が無ければ受け付けない', async () => {
    const { app, caseId } = await setup({ agreeExternalAi: false })
    const response = await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(caseId), nextKey('idem-run')),
    )

    assert.equal(response.status, 403)
    assert.equal(response.body.error.code, 'CONSENT_REQUIRED')
    // 手動管理は引き続き使えることを伝える。
    assert.ok(response.body.error.details.availableFeatures.length > 0)
  })

  it('受付をOutboxへ積む', async () => {
    const { tenantId, app, caseId } = await setup()
    await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(caseId), nextKey('idem-run')),
    )

    const outbox = await firestore()
      .collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`)
      .where('type', '==', 'agent.case_planning')
      .get()
    assert.equal(outbox.size, 1)
    assert.equal(outbox.docs[0]?.get('status'), 'PENDING')
    // 配送時に同意を評価するため、誰の操作かを残す。
    assert.equal(outbox.docs[0]?.get('initiatedByUserId'), 'user-owner')
  })

  it('取消は実行を止めるだけで、確定済みの変更を戻さない', async () => {
    const { app, caseId } = await setup()
    const accepted = await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(caseId), nextKey('idem-run')),
    )
    const run = accepted.body.data

    const cancelled = await call(
      app,
      `/cases/${caseId}/agent-runs/${run.id}/cancel`,
      jsonRequest('POST', { expectedVersion: run.version }),
    )
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.body.data.status, 'CANCELLED')
    assert.deepEqual(cancelled.body.data.allowedActions, [])

    // 取消済みを再度取り消せない。
    const again = await call(
      app,
      `/cases/${caseId}/agent-runs/${run.id}/cancel`,
      jsonRequest('POST', { expectedVersion: cancelled.body.data.version }),
    )
    assert.equal(again.status, 409)
  })

  it('成功済みの実行を再試行できない', async () => {
    const { tenantId, app, caseId } = await setup()
    const accepted = await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(caseId), nextKey('idem-run')),
    )
    const run = accepted.body.data

    await firestore()
      .doc(`tenants/${tenantId}/cases/${caseId}/agentRuns/${run.id}`)
      .update({ status: 'SUCCEEDED', version: run.version + 1 })

    const response = await call(
      app,
      `/cases/${caseId}/agent-runs/${run.id}/retry`,
      jsonRequest('POST', { expectedVersion: run.version + 1 }),
    )
    assert.equal(response.status, 409)
    assert.equal(response.body.error.code, 'PRECONDITION_FAILED')
  })

  it('失敗した実行の再試行は新しい試行として受け付ける', async () => {
    const { tenantId, app, caseId } = await setup()
    const accepted = await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(caseId), nextKey('idem-run')),
    )
    const run = accepted.body.data

    await firestore()
      .doc(`tenants/${tenantId}/cases/${caseId}/agentRuns/${run.id}`)
      .update({ status: 'FAILED', failureReason: '架空の失敗', version: run.version + 1 })

    const response = await call(
      app,
      `/cases/${caseId}/agent-runs/${run.id}/retry`,
      jsonRequest('POST', { expectedVersion: run.version + 1 }),
    )
    assert.equal(response.status, 202)
    assert.equal(response.body.data.attempt, 2)
    assert.equal(response.body.data.status, 'QUEUED')
    assert.equal(response.body.data.failureReason, null)
  })

  it('待機中を失敗と区別して返す', async () => {
    const { tenantId, app, caseId } = await setup()
    const accepted = await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(caseId), nextKey('idem-run')),
    )
    const run = accepted.body.data

    for (const status of ['WAITING_DOCUMENT', 'WAITING_APPROVAL', 'RETRY_SCHEDULED']) {
      await firestore()
        .doc(`tenants/${tenantId}/cases/${caseId}/agentRuns/${run.id}`)
        .update({ status, waitingFor: '架空の理由' })
      const fetched = await call(app, `/cases/${caseId}/agent-runs/${run.id}`)
      assert.equal(fetched.body.data.status, status)
      assert.equal(fetched.body.data.waiting, true, `${status} が待機として返らない`)
      assert.ok(fetched.body.data.allowedActions.includes('cancel'))
    }
  })
})

describeFirestore('Case の書き込み権', () => {
  function leaseService() {
    return new CaseLeaseService(readRepository(), unitOfWork())
  }

  it('同じCaseの書き込みを直列化する', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    const service = leaseService()

    const first = await service.acquire(workContext(tenantId), caseId, 'run-1')
    assert.equal(first.fencingToken, 1)

    await assert.rejects(
      service.acquire(workContext(tenantId), caseId, 'run-2'),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    )
  })

  it('取り直すたびに世代が増える', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    const service = leaseService()

    const first = await service.acquire(workContext(tenantId), caseId, 'run-1')
    await service.release(workContext(tenantId), caseId, first)
    const second = await service.acquire(workContext(tenantId), caseId, 'run-2')

    assert.equal(second.fencingToken, first.fencingToken + 1)
  })

  it('古い世代の要求を拒否する', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    const service = leaseService()

    const stale = await service.acquire(workContext(tenantId), caseId, 'run-1')
    await service.release(workContext(tenantId), caseId, stale)
    await service.acquire(workContext(tenantId), caseId, 'run-2')

    // 期限内に見えても、世代が古ければ書き込ませない。
    await assert.rejects(
      service.assertHolder({ userId: 'u', tenantId }, caseId, stale),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'STALE_FENCING_TOKEN',
    )
  })

  it('期限切れの lease は他の実行が奪える', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    // 失効までの時間を 0 にして、取得直後から失効している状態を作る。
    const expiring = new CaseLeaseService(readRepository(), unitOfWork(), 0)

    const first = await expiring.acquire(workContext(tenantId), caseId, 'run-1')
    const second = await expiring.acquire(workContext(tenantId), caseId, 'run-2')

    assert.equal(second.fencingToken, first.fencingToken + 1)
    await assert.rejects(
      expiring.assertHolder({ userId: 'u', tenantId }, caseId, first),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    )
  })

  it('期限切れ後に戻ってきた所有者が解放しない', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    const expiring = new CaseLeaseService(readRepository(), unitOfWork(), 0)

    const stale = await expiring.acquire(workContext(tenantId), caseId, 'run-1')
    const current = await expiring.acquire(workContext(tenantId), caseId, 'run-2')

    await expiring.release(workContext(tenantId), caseId, stale)

    const lease = await firestore().doc(`tenants/${tenantId}/cases/${caseId}/coordination/writer`).get()
    assert.equal(lease.get('holderRunId'), 'run-2')
    assert.equal(lease.get('fencingToken'), current.fencingToken)
  })
})

describeFirestore('Outbox の配送', () => {
  function dispatcherFor(aiUrl: string, tenantId: string, visibilityTimeoutMs = 0) {
    const consent = new ConsentService(
      PLACEHOLDER_CATALOG,
      new AccessService(readRepository()),
      readRepository(),
      unitOfWork(),
    )
    void tenantId
    const client = new HttpAgentJobClient({
      baseUrl: aiUrl,
      serviceToken: SERVICE_TOKEN,
      timeoutMs: 3_000,
      audience: 'ai-server',
    })
    return new OutboxDispatcher(firestore(), client, consent, visibilityTimeoutMs)
  }

  /**
   * Case 作成など、試験の主題ではないイベントを先に配送しておく。
   * 残っていると、対象のイベントとどちらに応答設定が当たるか決まらない。
   */
  async function drain(dispatcher: OutboxDispatcher, tenantId: string): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
      const result = await dispatcher.dispatchBatch(tenantId)
      if (result.delivered.length === 0 && result.retrying.length === 0) return
    }
  }

  async function outboxDocs(tenantId: string, type: string) {
    const snapshot = await firestore()
      .collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`)
      .where('type', '==', type)
      .get()
    return snapshot.docs
  }

  it('並行workerの二重claimと旧世代の遅い応答を防ぐ', async t => {
    const ai = await startFakeAiServer()
    t.after(() => ai.close())
    const { tenantId, app, caseId } = await setup()
    const firstWorker = dispatcherFor(ai.url, tenantId, 120_000)
    const secondWorker = dispatcherFor(ai.url, tenantId, 120_000)
    await drain(firstWorker, tenantId)
    await call(app, `/cases/${caseId}/agent-runs`, jsonRequest('POST', acceptBody(caseId)))
    const held = ai.holdNext(503)
    const first = firstWorker.dispatchBatch(tenantId)
    const eventId = await held.received
    const second = await secondWorker.dispatchBatch(tenantId)
    assert.equal(second.delivered.length, 0)
    assert.equal(ai.countOf(eventId), 1)
    const ref = firestore().doc(`tenants/${tenantId}/outbox/${eventId}`)
    await ref.update({ nextAttemptAt: new Date(0).toISOString(), leaseExpiresAt: new Date(0).toISOString() })
    const recovered = await secondWorker.dispatchBatch(tenantId)
    assert.equal(recovered.delivered.length, 1)
    held.release()
    await first
    assert.equal((await ref.get()).get('status'), 'DELIVERED', '旧503で再配送へ戻さない')
  })

  it('workerプロセスを強制停止して再起動すると未確定配送を再開し受信側で一度だけ処理する', { timeout: 30_000 }, async t => {
    const ai = await startFakeAiServer()
    t.after(() => ai.close())
    const { tenantId, app, caseId } = await setup()
    await call(app, `/cases/${caseId}/agent-runs`, jsonRequest('POST', acceptBody(caseId)))
    function worker() {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker-main.ts', '--once'], {
        env: { ...process.env, NODE_ENV: 'test', OUTBOX_TENANT_IDS: tenantId, AI_SERVER_URL: ai.url,
          AI_SERVICE_TOKEN: SERVICE_TOKEN, AI_SERVICE_TIMEOUT_MS: '1000', OUTBOX_VISIBILITY_MS: '2000' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', chunk => { output += String(chunk) })
      child.stderr.on('data', chunk => { output += String(chunk) })
      t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
      return { child, output: () => output }
    }
    const held = ai.holdNext()
    t.after(() => held.release())
    const first = worker()
    const closed = once(first.child, 'close')
    const eventId = await held.received
    first.child.kill('SIGKILL')
    await closed
    const ref = firestore().doc(`tenants/${tenantId}/outbox/${eventId}`)
    assert.equal((await ref.get()).get('status'), 'IN_FLIGHT')
    await ref.update({ nextAttemptAt: new Date(0).toISOString(), leaseExpiresAt: new Date(0).toISOString() })
    const next = worker()
    const [exit] = await once(next.child, 'close')
    assert.equal(exit, 0, next.output())
    assert.equal((await ref.get()).get('status'), 'DELIVERED')
    assert.equal(ai.countOf(eventId), 2)
    assert.equal([...ai.accepted].filter(id => id === eventId).length, 1)
    const tasks = await call(app, `/cases/${caseId}/tasks`)
    assert.ok(tasks.body.data.length > 0, 'Case作成イベントから初期Taskが自動生成される')
  })

  it('滞留と失敗の件数・最古の経過時間を取得できる', async t => {
    const ai = await startFakeAiServer()
    t.after(() => ai.close())
    const { tenantId } = await setup({ agreeExternalAi: false })
    const docs = await outboxDocs(tenantId, 'case.created')
    await docs[0]!.ref.update({ createdAt: new Date(Date.now() - 20 * 60_000).toISOString() })
    const report = await dispatcherFor(ai.url, tenantId).backlog(tenantId)
    assert.ok(report.pending > 0)
    assert.equal(report.failed, 0)
    assert.ok(report.oldestAgeMs >= 20 * 60_000)
  })

  it('AI同意なしでもローカル配送が初期Taskと最新起算日の期限再評価を実行する', async t => {
    const ai = await startFakeAiServer()
    t.after(() => ai.close())
    const { tenantId, app, caseId } = await setup({ agreeExternalAi: false })
    const access = new AccessService(readRepository())
    const consent = new ConsentService(PLACEHOLDER_CATALOG, access, readRepository(), unitOfWork())
    const local = caseTaskHandler(new TaskService(PLACEHOLDER_RULE_CATALOG, access, readRepository(), unitOfWork()))
    const dispatcher = new OutboxDispatcher(firestore(), new HttpAgentJobClient({
      baseUrl: ai.url, serviceToken: SERVICE_TOKEN, timeoutMs: 1000, audience: 'ai-server',
    }), consent, 120_000, local)
    assert.ok((await dispatcher.dispatchBatch(tenantId)).delivered.length > 0)
    const before = await firestore().collection(`tenants/${tenantId}/cases/${caseId}/tasks`).get()
    assert.equal(before.size, PLACEHOLDER_RULE_CATALOG.initialProcedures.length)
    const current = await call(app, `/cases/${caseId}`)
    assert.equal((await call(app, `/cases/${caseId}`, jsonRequest('PATCH', {
      expectedVersion: current.body.data.version, knownAt: '2026-05-01',
    }))).status, 200)
    await dispatcher.dispatchBatch(tenantId)
    const dates = await call(app, `/cases/${caseId}/deadlines`)
    assert.ok(dates.body.data.every((deadline: Json) => deadline.startDate === '2026-05-01'))
    // 古いcase.createdを再配送しても重複せず、当時の起算日へ戻らない。
    const original = (await outboxDocs(tenantId, 'case.created'))[0]!.data() as OutboxEvent
    await local.deliverLocal(original)
    assert.equal((await firestore().collection(`tenants/${tenantId}/cases/${caseId}/tasks`).get()).size, before.size)
    assert.equal(ai.received.length, 0)
  })

  it('受け付けたイベントを配送し、認証情報を付ける', async (t) => {
    const ai = await startFakeAiServer({ expectedToken: SERVICE_TOKEN })
    t.after(() => ai.close())

    const { tenantId, app, caseId } = await setup()
    const dispatcher = dispatcherFor(ai.url, tenantId)
    await drain(dispatcher, tenantId)

    await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(caseId), nextKey('idem-run')),
    )

    const result = await dispatcher.dispatchBatch(tenantId)
    assert.equal(result.delivered.length, 1)
    const planning = ai.received.filter((entry) => entry.type === 'agent.case_planning')
    assert.equal(planning.length, 1)
    assert.equal(planning[0]?.audience, 'ai-server')
  })

  it('同じイベントを二度配送しても受信側が重複を弾く', async (t) => {
    const ai = await startFakeAiServer()
    t.after(() => ai.close())

    const { tenantId, app, caseId } = await setup()
    const dispatcher = dispatcherFor(ai.url, tenantId)
    await drain(dispatcher, tenantId)

    await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(caseId), nextKey('idem-run')),
    )
    await dispatcher.dispatchBatch(tenantId)
    const receivedAfterFirst = ai.received.length

    // 配送済みは再送の対象にならない。
    const second = await dispatcher.dispatchBatch(tenantId)
    assert.equal(second.delivered.length, 0)
    assert.equal(ai.received.length, receivedAfterFirst)
  })

  it('送信後・記録前のクラッシュでも同じIDで再配送する', async (t) => {
    const ai = await startFakeAiServer()
    t.after(() => ai.close())

    const { tenantId, app, caseId } = await setup()
    const dispatcher = dispatcherFor(ai.url, tenantId)
    await drain(dispatcher, tenantId)

    await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(caseId), nextKey('idem-run')),
    )

    // 応答を返さずに切る。Backend からは送信できたか分からない。
    ai.dropNext()
    const first = await dispatcher.dispatchBatch(tenantId)
    assert.equal(first.retrying.length, 1)

    // 再送の時刻が来た状態にして、もう一度配送する。
    const docs = await outboxDocs(tenantId, 'agent.case_planning')
    const eventId = docs[0]!.id
    await docs[0]!.ref.update({ nextAttemptAt: new Date(Date.now() - 1000).toISOString() })

    const second = await dispatcher.dispatchBatch(tenantId)
    assert.equal(second.delivered.length, 1)
    // 同じ eventId で二度届いても、受信側が受理するのは一度だけ。
    assert.equal(ai.countOf(eventId), 2)
    assert.equal([...ai.accepted].filter((id) => id === eventId).length, 1)
  })

  it('一時障害は再試行へ回し、失敗として確定しない', async (t) => {
    const ai = await startFakeAiServer()
    t.after(() => ai.close())

    const { tenantId, app, caseId } = await setup()
    const dispatcher = dispatcherFor(ai.url, tenantId)
    await drain(dispatcher, tenantId)

    await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(caseId), nextKey('idem-run')),
    )

    ai.respondWith(503)
    const result = await dispatcher.dispatchBatch(tenantId)
    assert.equal(result.retrying.length, 1)

    const docs = await outboxDocs(tenantId, 'agent.case_planning')
    assert.equal(docs[0]?.get('status'), 'PENDING')
    assert.ok(docs[0]?.get('nextAttemptAt').toMillis() > Date.now())
  })

  it('受理できない応答は再送しない', async (t) => {
    const ai = await startFakeAiServer()
    t.after(() => ai.close())

    const { tenantId, app, caseId } = await setup()
    const dispatcher = dispatcherFor(ai.url, tenantId)
    await drain(dispatcher, tenantId)

    await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(caseId), nextKey('idem-run')),
    )

    ai.respondWith(400)
    const result = await dispatcher.dispatchBatch(tenantId)
    assert.equal(result.rejected.length, 1)

    const docs = await outboxDocs(tenantId, 'agent.case_planning')
    assert.equal(docs[0]?.get('status'), 'FAILED')
  })

  it('待機中に同意が撤回されたら配送しない', async (t) => {
    const ai = await startFakeAiServer()
    t.after(() => ai.close())

    const { tenantId, app, caseId } = await setup()
    const dispatcher = dispatcherFor(ai.url, tenantId)
    await drain(dispatcher, tenantId)

    await call(
      app,
      `/cases/${caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(caseId), nextKey('idem-run')),
    )

    // 受付時には同意があったが、配送前に撤回された。
    await call(
      app,
      '/consents/revocations',
      jsonRequest('POST', { kind: 'CROSS_BORDER_AI' }, nextKey('idem-revoke')),
    )
    const receivedBefore = ai.received.length

    const docs = await outboxDocs(tenantId, 'agent.case_planning')
    const agentEventId = docs[0]!.id

    const result = await dispatcher.dispatchBatch(tenantId)
    assert.ok(result.blocked.includes(agentEventId), 'AI への配送が止まらない')
    assert.equal(
      ai.received.filter((entry) => entry.type === 'agent.case_planning').length,
      0,
      '撤回後に業務データを送らない',
    )
    // 撤回そのものの通知は届ける。止めるための通知を同意不足で止めない。
    assert.ok(ai.received.some((entry) => entry.type === 'consent.revoked'))
    void receivedBefore

    const after = await outboxDocs(tenantId, 'agent.case_planning')
    // 失敗ではないので PENDING のまま残す。
    assert.equal(after[0]?.get('status'), 'PENDING')
  })

  it('再試行の間隔は回数に応じて伸び、上限で頭打ちになる', () => {
    assert.equal(backoffMs(1), 60_000)
    assert.equal(backoffMs(2), 120_000)
    assert.equal(backoffMs(3), 240_000)
    assert.equal(backoffMs(20), 60 * 60_000)
  })
})

describeFirestore('権限と境界', () => {
  it('別 Case の runId へ差し替えても取得できない', async () => {
    const owner = await setup()
    const accepted = await call(
      owner.app,
      `/cases/${owner.caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(owner.caseId), nextKey('idem-run')),
    )
    const another = await call(
      owner.app,
      '/cases',
      jsonRequest('POST', caseBody, nextKey('idem-case')),
    )

    const response = await call(
      owner.app,
      `/cases/${another.body.data.id}/agent-runs/${accepted.body.data.id}`,
    )
    assert.equal(response.status, 404)
  })

  it('参加していない利用者は実行を見られない', async () => {
    const owner = await setup()
    const accepted = await call(
      owner.app,
      `/cases/${owner.caseId}/agent-runs`,
      jsonRequest('POST', acceptBody(owner.caseId), nextKey('idem-run')),
    )

    await seedTenantMember(owner.tenantId, 'user-outsider')
    const outsider = buildApp(owner.tenantId, 'user-outsider')
    await agreeRequiredConsents(outsider)

    const response = await call(
      outsider,
      `/cases/${owner.caseId}/agent-runs/${accepted.body.data.id}`,
    )
    assert.equal(response.status, 404)
  })

  it('一覧は受付順に取得でき、続きをカーソルで辿れる', async () => {
    const { app, caseId } = await setup()
    for (let index = 0; index < 3; index += 1) {
      await call(
        app,
        `/cases/${caseId}/agent-runs`,
        jsonRequest('POST', acceptBody(caseId), nextKey('idem-run')),
      )
    }

    const collected: string[] = []
    let cursor: string | undefined
    do {
      const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2'
      const page = await call(app, `/cases/${caseId}/agent-runs${query}`)
      collected.push(...page.body.data.map((run: Json) => run.id))
      cursor = page.body.meta.nextCursor
    } while (cursor)

    assert.equal(collected.length, 3)
    assert.equal(new Set(collected).size, 3)
  })
})
