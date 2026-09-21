import { fingerprintOf } from '../../src/shared/fingerprint.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { it } from 'node:test'
import type { TestContext } from 'node:test'
import { serve } from '@hono/node-server'
import { SignJWT } from 'jose'
import { artifactEnvelopeSchema, dispatchSchema, INTERNAL_LIMITS } from '@aftercare/internal-contracts'
import type { ContextArtifact, ExecutionClaims } from '@aftercare/internal-contracts'
import { InternalExecutionService } from '../../src/application/agent/internal-execution-service.js'
import { RunReconciler } from '../../src/application/agent/run-reconciler.js'
import { OutboxDispatcher } from '../../src/application/agent/outbox-dispatcher.js'
import { acknowledgeLocally } from '../../src/application/agent/outbox-worker.js'
import type { GuidanceEntity } from '../../src/domain/task/guidance.js'
import type { OutboxEvent } from '../../src/domain/shared/outbox.js'
import { ContextVersionUnitOfWork } from '../../src/application/case/context-version-unit-of-work.js'
import { AccessService } from '../../src/application/authorization/case-access.js'
import { ConsentService } from '../../src/application/consent/consent-service.js'
import { AgentResultIntake } from '../../src/application/chat/result-intake.js'
import { ProposalService } from '../../src/application/proposal/proposal-service.js'
import { taskProposalApplier } from '../../src/application/proposal/task-applier.js'
import { entityProposalAppliers } from '../../src/application/proposal/entity-appliers.js'
import { taskActionProposalAppliers } from '../../src/application/proposal/task-action-appliers.js'
import type { AgentRunEntity } from '../../src/domain/agent/agent-run.js'
import { PLACEHOLDER_CATALOG } from '../../src/domain/consent/catalog.js'
import { collections } from '../../src/domain/shared/collections.js'
import { SignedExecutionAuthorization } from '../../src/infrastructure/identity/execution-authorization.js'
import { ScopedHttpAgentJobClient } from '../../src/infrastructure/agent/scoped-http-agent-client.js'
import { createExecutionApp } from '../../src/presentation/routes/internal/v1/execution.js'
import { buildApp, call, jsonRequest, seedTenantMember } from './helpers/app.js'
import { agentRunEvents, describeFirestore, firestore, newTenantId, readRepository, unitOfWork } from './helpers/emulator.js'
import { startFakeAiServer } from './helpers/fake-ai-server.js'

const signingKey = 'synthetic-test-signing-key-not-a-production-secret'
const incoming = 'synthetic-incoming-service-identity'
const outgoing = 'synthetic-outgoing-service-identity'
const proof = (a: ContextArtifact) => ({ caseVersion: a.caseVersion, contextSnapshotId: a.contextSnapshotId, artifactVersion: a.artifactVersion, contentHash: a.contentHash, fencingToken: a.fencingToken })

async function setup(t: TestContext, options: { rejectDraftDefinitions?: boolean } = {}) {
  const tenantId = newTenantId(), userId = 'owner'
  await seedTenantMember(tenantId, userId)
  const app = buildApp(tenantId, userId, { connectedOperations: ['case_planning', 'task_guidance', 'chat_reply'] })
  const read = readRepository(), uow = new ContextVersionUnitOfWork(unitOfWork())
  const consent = new ConsentService(PLACEHOLDER_CATALOG, new AccessService(read), read, uow)
  const proposals = new ProposalService(new AccessService(read), read, uow, [taskProposalApplier, ...entityProposalAppliers, ...taskActionProposalAppliers])
  const service = new InternalExecutionService(read, uow, consent, new AgentResultIntake(read, uow), proposals,
    { rejectDraftDefinitions: options.rejectDraftDefinitions ?? false })
  const authorization = new SignedExecutionAuthorization(signingKey)
  app.route('/internal/v1', createExecutionApp({ service, authorization, serviceCredential: incoming }))
  await call(app, '/consents', jsonRequest('POST', { agreements: PLACEHOLDER_CATALOG.documents.map(d => ({ kind: d.kind, version: d.version })) }))
  const created = await call(app, '/cases', jsonRequest('POST', { deceasedName: '架空人物', dateOfDeath: '2026-01-01', ownerName: '架空', relationshipToDeceased: '家族' }))
  assert.equal(created.status, 201)
  const caseId = created.body.data.id as string
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  if (!server.listening) await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => {
    if ('closeAllConnections' in server) server.closeAllConnections()
    server.close(e => e ? reject(e) : resolve())
  }))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const ai = await startFakeAiServer({ expectedToken: outgoing, protocol: 'scoped' })
  t.after(() => ai.close())
  const client = new ScopedHttpAgentJobClient({ baseUrl: ai.url, serviceToken: outgoing, audience: 'ai-server', timeoutMs: 1000 }, service, authorization)
  async function accept(operation = 'case_planning', targetId = caseId, targetType = 'CASE') {
    const accepted = await call(app, `/cases/${caseId}/agent-runs`, jsonRequest('POST', { operation, targetId, targetType }))
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body))
    const run = (await read.get<AgentRunEntity>(tenantId, { collection: collections.agentRuns, caseId, id: accepted.body.data.id }))!
    const job = { eventId: run.currentJobId!, tenantId, caseId, type: `agent.${operation}`, payload: { runId: run.id }, attempt: 1 }
    assert.equal((await client.deliver(job)).status, 'ACCEPTED')
    const dispatch = ai.dispatches.at(-1)!
    const claims = await authorization.verify(dispatch.executionAuthorization)
    return { run, job, dispatch, claims }
  }
  async function request(exec: { dispatch: { executionAuthorization: string }; claims: ExecutionClaims }, path: string,
    body?: unknown, options: { token?: string; headers?: Record<string, string>; runId?: string } = {}) {
    const now = Math.floor(Date.now() / 1000)
    const response = await fetch(`${baseUrl}/internal/v1/runs/${options.runId ?? exec.claims.runId}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${incoming}`, 'X-Execution-Authorization': options.token ?? exec.dispatch.executionAuthorization,
        'X-Request-Id': randomUUID(), 'X-Job-Id': exec.claims.jobId, 'X-Execution-Attempt': exec.claims.executionAttempt,
        'X-Issued-At': String(now), 'X-Expires-At': String(now + 60), 'Content-Type': 'application/json', ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() as any }
  }
  async function context(exec: Awaited<ReturnType<typeof accept>>) {
    const result = await request(exec, 'context')
    assert.equal(result.status, 200, JSON.stringify(result.body))
    return artifactEnvelopeSchema.parse(result.body.data)
  }
  const reconciler = () => new RunReconciler(readRepository(), new ContextVersionUnitOfWork(unitOfWork()), service, client)
  async function ingest() {
    const events = await firestore().collection(`tenants/${tenantId}/outbox`).get()
    for (const doc of events.docs) {
      const event = doc.data() as OutboxEvent
      if (reconciler().types.has(event.type)) assert.equal((await reconciler().deliverLocal(event)).status, 'ACCEPTED')
    }
  }
  return { tenantId, userId, caseId, app, service, authorization, ai, client, accept, request, context, baseUrl, reconciler, ingest, read, consent }
}

describeFirestore('Run scoped内部API / Fake AI HTTP contract', () => {
  it('Backend検出イベントの気づきを公開APIへ保存し、Runを跨ぐ重複と古い根拠を扱う', async t => {
    const h = await setup(t)
    const created = await call(h.app, `/cases/${h.caseId}/tasks`, jsonRequest('POST', { title: '書類の確認', stage: 'government', category: 'fixture',
      requiredDocuments: [{ id: 'required-one', label: '合成確認資料', documentId: null }] }))
    assert.equal(created.status, 201)
    const task = created.body.data
    const exec = await h.accept(), context = await h.context(exec)
    const event = (context.content.insightEvents as any[]).find(e => e.task.id === task.id)
    assert.equal(event.kind, 'DOCUMENTS_MISSING')
    const insight = { eventId: event.id, resultId: fingerprintOf({ caseId: h.caseId, eventId: event.id, version: 'event-insights-v1' }),
      kind: 'MISSING_DOCUMENT', body: '登録済みの必要書類を確認してください。', relatedTaskId: task.id, relatedTaskTitle: task.title,
      evidence: [{ label: task.title, value: '合成確認資料', taskId: task.id, capturedVersion: task.version }], requiresProfessional: false, professionalReviewNote: null }
    const result = { ...proof(context), resultId: randomUUID(), kind: 'case_planning', status: 'NEEDS_ATTENTION', insights: [insight] }
    assert.equal((await h.request(exec, 'result', { ...result, insights: [{ ...insight, eventId: 'forged' }] })).status, 409)
    assert.equal((await h.request(exec, 'result', { ...result, insights: [{ ...insight, relatedTaskId: 'foreign' }] })).status, 403)
    assert.equal((await h.request(exec, 'result', result)).status, 200)
    let listed = await call(h.app, `/cases/${h.caseId}/insights`)
    assert.equal(listed.body.data.length, 1); assert.equal(listed.body.data[0].evidence[0].freshness, 'CURRENT')
    const next = await h.accept(), latest = await h.context(next)
    assert.equal((await h.request(next, 'result', { ...result, ...proof(latest), resultId: randomUUID() })).status, 200)
    assert.equal((await call(h.app, `/cases/${h.caseId}/insights`)).body.data.length, 1)
    assert.equal((await call(h.app, `/cases/${h.caseId}/tasks/${task.id}`, jsonRequest('PATCH', { expectedVersion: task.version, title: '修正した書類確認' }))).status, 200)
    listed = await call(h.app, `/cases/${h.caseId}/insights`)
    assert.equal(listed.body.data[0].evidence[0].freshness, 'STALE')
  })

  it('取消をOutboxへ保存し、保存済み旧attemptだけに停止を配送する', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec)
    const current = (await call(h.app, `/cases/${h.caseId}/agent-runs/${exec.run.id}`)).body.data
    assert.equal((await call(h.app, `/cases/${h.caseId}/agent-runs/${exec.run.id}/cancel`, jsonRequest('POST', { expectedVersion: current.version }))).status, 200)
    const run = (await readRepository().get<AgentRunEntity>(h.tenantId, { collection: collections.agentRuns, caseId: h.caseId, id: exec.run.id }))!
    assert.equal(run.cancellation?.executionAttempt, exec.claims.executionAttempt)
    const event = (await firestore().doc(`tenants/${h.tenantId}/outbox/${run.cancellation!.cancelId}`).get()).data() as OutboxEvent
    const job = { eventId: event.id, tenantId: h.tenantId, caseId: h.caseId, type: event.type, payload: event.payload, attempt: 1 }
    assert.equal((await h.client.deliver(job)).status, 'ACCEPTED')
    assert.equal((await h.client.deliver(job)).status, 'ACCEPTED')
    assert.equal(h.ai.countOf(event.id), 2)
    assert.equal((await h.request(exec, 'result', { ...proof(context), resultId: randomUUID(), kind: 'case_planning', status: 'SUCCEEDED' })).status, 409)
    assert.equal((await h.client.deliver({ ...job, eventId: randomUUID() })).status, 'RETRYABLE')
  })

  it('中断結果は現在のoperation/proofだけを受け、部分結果を保存して実行を終了する', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec)
    const input = { ...proof(context), resultId: 'budget-result', kind: 'execution_interrupted', operation: 'case_planning',
      status: 'NEEDS_ATTENTION', failureReason: 'BUDGET_EXCEEDED', output: { summary: '予算上限', completed: ['候補確認'], questions: ['確認事項'], remaining: ['提案確認'] } }
    assert.equal((await h.request(exec, 'result', { ...input, operation: 'chat_reply' })).status, 403)
    assert.equal((await h.request(exec, 'result', input)).status, 200)
    assert.equal((await h.request(exec, 'result', input)).status, 200)
    const run = (await call(h.app, `/cases/${h.caseId}/agent-runs/${exec.run.id}`)).body.data
    assert.equal(run.status, 'NEEDS_ATTENTION'); assert.equal(run.failureReason, 'BUDGET_EXCEEDED')
    assert.deepEqual(run.outcome.remaining, ['提案確認'])

    // 中断結果も公開履歴へ1行だけ記録する。失敗理由はBackendが定義した列挙値のみ。
    const events = await agentRunEvents(h.tenantId, h.caseId, exec.run.id)
    const resultEvents = events.filter(e => e.kind === 'RESULT')
    assert.equal(resultEvents.length, 1, '重複した再送で行が増えている')
    assert.equal(resultEvents[0]!.status, 'NEEDS_ATTENTION')
    assert.equal(resultEvents[0]!.eventId, input.resultId)
    assert.deepEqual(resultEvents[0]!.detail, { operation: 'case_planning', failureReason: 'BUDGET_EXCEEDED' })
  })

  it('個人本文のないdispatch→context→artifact→heartbeat→progress→resultを実HTTPで検証する', async t => {
    const h = await setup(t), exec = await h.accept()
    dispatchSchema.parse(exec.dispatch)
    assert.deepEqual(Object.keys(exec.dispatch).sort(), ['jobId', 'runId', 'executionAttempt', 'operation', 'issuedAt', 'expiresAt', 'executionAuthorization'].sort())
    assert.equal(JSON.stringify(exec.dispatch).includes('架空人物'), false)
    const context = await h.context(exec)
    assert.equal(context.content.planningRestriction, null)
    // 故人の氏名はどの operation でも Context に渡さない。
    assert.equal('deceasedName' in (context.content.case as object), false)
    const artifact = await h.request(exec, `artifacts/${context.contextSnapshotId}`)
    assert.deepEqual(artifact.body.data, context)
    const heartbeat = await h.request(exec, 'heartbeat', {})
    assert.equal(heartbeat.status, 200)
    assert.deepEqual(await h.authorization.verify(heartbeat.body.data.executionAuthorization), exec.claims)
    const event = { eventId: randomUUID(), sequence: 1, phase: 'PLANNING' }
    assert.equal((await h.request(exec, 'events', event)).status, 200)
    assert.equal((await h.request(exec, 'events', event)).status, 200)
    assert.equal((await h.request(exec, 'events', { ...event, sequence: 2 })).status, 409)
    const result = { ...proof(context), resultId: randomUUID(), basis: [], kind: 'case_planning', status: 'SUCCEEDED' }
    assert.equal((await h.request(exec, 'result', result)).status, 200)
    assert.equal((await h.request(exec, 'result', result)).status, 200, '終端後でも一致した再送は副作用なし')
    assert.equal((await h.request(exec, 'result', { ...result, status: 'FAILED' })).status, 409)
    assert.equal((await h.request(exec, 'control')).body.data.instruction, 'STOP')
    const run = await call(h.app, `/cases/${h.caseId}/agent-runs/${exec.run.id}`)
    assert.equal(run.body.data.status, 'SUCCEEDED')

    // 公開可能な進捗履歴（Issue #125）。同じeventId/resultIdの再送で行が増えない。
    const events = await agentRunEvents(h.tenantId, h.caseId, exec.run.id)
    assert.deepEqual(events.map(e => e.kind), ['ACCEPTED', 'PROGRESS', 'RESULT'])
    assert.ok(events[0]!.sequence < events[1]!.sequence && events[1]!.sequence < events[2]!.sequence, '発生順になっていない')
    const progress = events.find(e => e.kind === 'PROGRESS')!
    assert.equal(progress.eventId, event.eventId)
    assert.equal(progress.detail.phase, 'PLANNING')
    const resultEvent = events.find(e => e.kind === 'RESULT')!
    assert.equal(resultEvent.eventId, result.resultId)
    assert.equal(resultEvent.status, 'SUCCEEDED')
    assert.equal(resultEvent.detail.operation, 'case_planning')
    // prompt・非公開の思考・原本文・questionsを含めない。
    assert.deepEqual(Object.keys(resultEvent.detail).sort(), ['operation'])
  })

  it('planning results expose questions; user answers replan the same Run without confirming facts', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec)
    const output = { summary: '確認が必要です', completed: [], questions: ['対象の地域はどこですか', '資料はありますか'], remaining: ['地域の確認'] }
    const result = { ...proof(context), resultId: 'questions-result', kind: 'case_planning', status: 'NEEDS_ATTENTION', output }
    assert.equal((await h.request(exec, 'result', result)).status, 200)
    const path = `/cases/${h.caseId}/agent-runs/${exec.run.id}`
    const saved = (await call(h.app, path)).body.data
    assert.deepEqual(saved.outcome.questions, output.questions)
    const answer = { expectedVersion: saved.version, resultId: result.resultId, answers: [{ questionIndex: 0, answer: 'PRIVATE-USER-ANSWER' }] }
    assert.equal((await call(h.app, `${path}/answers`, jsonRequest('POST', { ...answer, resultId: 'another-result' }))).status, 409)
    assert.equal((await call(h.app, `${path}/answers`, jsonRequest('POST', { ...answer, answers: [{ questionIndex: 19, answer: 'invalid' }] }))).status, 400)
    const request = jsonRequest('POST', answer)
    const replied = await call(h.app, `${path}/answers`, request)
    assert.equal(replied.status, 202, JSON.stringify(replied.body))
    assert.equal(replied.body.data.attempt, 2)
    assert.equal((await call(h.app, `${path}/answers`, request)).body.data.attempt, 2)

    // 公開可能な履歴（Issue #125）。質問回答による再キューもRETRIEDとして残る。
    const events = await agentRunEvents(h.tenantId, h.caseId, exec.run.id)
    const retried = events.filter(e => e.kind === 'RETRIED')
    assert.equal(retried.length, 1, '質問回答による再キューのイベントが記録されていない')
    assert.equal(retried[0]!.status, 'QUEUED')
    assert.equal(retried[0]!.attempt, 2)
    assert.equal(retried[0]!.detail.outcome, 'QUESTIONS_ANSWERED')
    assert.equal((await h.request(exec, 'result', result)).status, 409)
    const next = (await readRepository().get<AgentRunEntity>(h.tenantId, { collection: collections.agentRuns, caseId: h.caseId, id: exec.run.id }))!
    const claims = await h.service.dispatchClaims(h.tenantId, h.caseId, next.id, next.currentJobId!)
    const refreshed = await h.request({ claims, dispatch: { executionAuthorization: await h.authorization.issue(claims) } }, 'context')
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body))
    assert.equal(refreshed.body.data.content.resume.kind, 'RETRY')
    assert.equal(refreshed.body.data.content.resume.previousAttemptId, exec.run.currentAttemptId)
    assert.deepEqual(refreshed.body.data.content.unresolvedQuestions, [output.questions[1]])
    assert.equal(refreshed.body.data.content.clarificationHistory[0].state, 'user_reported')
    assert.equal(refreshed.body.data.content.case.municipality, null)
    assert.deepEqual(refreshed.body.data.content.decisions, [])
    assert.equal((await call(h.app, `/cases/${h.caseId}/messages`)).body.data.length, 1)
  })

  it('wrong audience・期限切れ・未来の要求・異なるjob/attempt・不足scopeを拒否する', async t => {
    const h = await setup(t), exec = await h.accept()
    const wrongAudience = await new SignedExecutionAuthorization(signingKey, 'wrong-audience').issue(exec.claims)
    assert.equal((await h.request(exec, 'context', undefined, { token: wrongAudience })).status, 401)
    const now = Math.floor(Date.now() / 1000)
    const expired = await new SignJWT(exec.claims).setProtectedHeader({ alg: 'HS256' }).setIssuer('backend-execution')
      .setSubject('ai-execution').setAudience('backend-internal').setIssuedAt(now - 400).setExpirationTime(now - 1)
      .sign(new TextEncoder().encode(signingKey))
    assert.equal((await h.request(exec, 'context', undefined, { token: expired })).status, 401)
    for (const headers of [{ 'X-Issued-At': String(now - 90), 'X-Expires-At': String(now - 1) },
      { 'X-Issued-At': String(now + 100), 'X-Expires-At': String(now + 110) }]) {
      assert.equal((await h.request(exec, 'context', undefined, { headers })).status, 401)
    }
    assert.equal((await h.request(exec, 'context', undefined, { headers: { 'X-Job-Id': 'another-job' } })).status, 403)
    assert.equal((await h.request(exec, 'context', undefined, { headers: { 'X-Execution-Attempt': 'another-attempt' } })).status, 403)
    const limited = await h.authorization.issue({ ...exec.claims, scopes: ['control'] })
    assert.equal((await h.request(exec, 'context', undefined, { token: limited })).status, 403)
    assert.equal((await h.request(exec, 'context', undefined, { headers: { Authorization: `Bearer ${outgoing}` } })).status, 401)
  })

  it('公開チャット受付で自己staleにならず、同じ結果から返信を一度だけ保存する', async t => {
    const h = await setup(t)
    const posted = await call(h.app, `/cases/${h.caseId}/messages`, jsonRequest('POST', { body: '架空の相談' }))
    assert.equal(posted.status, 202, JSON.stringify(posted.body))
    const runId = posted.body.data.runId as string
    const run = (await readRepository().get<AgentRunEntity>(h.tenantId, { collection: collections.agentRuns, caseId: h.caseId, id: runId }))!
    const claims = await h.service.dispatchClaims(h.tenantId, h.caseId, runId, run.currentJobId!)
    const exec = { run, job: { eventId: run.currentJobId!, tenantId: h.tenantId, caseId: h.caseId, type: 'agent.chat_reply', payload: { runId }, attempt: 1 },
      claims, dispatch: { jobId: claims.jobId, runId, executionAttempt: claims.executionAttempt, operation: claims.operation,
        issuedAt: 1, expiresAt: 2, executionAuthorization: await h.authorization.issue(claims) } }
    const context = await h.context(exec)
    const result = { ...proof(context), resultId: randomUUID(), kind: 'chat_reply', body: 'これは説明です。',
      basis: [{ type: 'MESSAGE', id: (context.content.message as any).id, version: (context.content.message as any).version }] }
    assert.equal((await h.request(exec, 'result', result)).status, 200)
    assert.equal((await h.request(exec, 'result', result)).status, 200)
    assert.equal((await call(h.app, `/cases/${h.caseId}/messages`)).body.data.length, 2)
  })

  it('対象Taskの案内結果を内部認可と同じTransactionで保存する', async t => {
    const h = await setup(t)
    const task = await call(h.app, `/cases/${h.caseId}/tasks`, jsonRequest('POST', { title: '架空手続き', category: '手動', stage: 'immediate' }))
    assert.equal(task.status, 201)
    const exec = await h.accept('task_guidance', task.body.data.id, 'TASK'), context = await h.context(exec)
    // procedureId 未マッピングの手動 Task には procedure: null と識別子だけを渡し、手続きを推測しない。
    assert.equal(context.content.procedure, null)
    assert.deepEqual(Object.keys(context.content.case as object).sort(), ['id', 'version'])
    const current = (await call(h.app, `/cases/${h.caseId}/tasks/${task.body.data.id}`)).body.data
    assert.deepEqual(context.content.task, { id: task.body.data.id, version: current.version, procedureId: null })
    assert.deepEqual(context.content.documents, [])
    const audits = await firestore().collection(`tenants/${h.tenantId}/cases/${h.caseId}/auditEvents`).where('type', '==', 'agent_run.context_projected').get()
    assert.equal(audits.size, 1)
    assert.deepEqual(audits.docs[0]!.get('detail'), { procedureId: null, reason: 'PROCEDURE_UNMAPPED' })
    const result = { ...proof(context), resultId: randomUUID(), kind: 'task_guidance', status: 'PARTIAL',
      steps: ['対象機関に確認してください'], missing: ['地域の詳細'], basis: [{ type: 'TASK', id: task.body.data.id, version: current.version }],
      citations: [{ item: 'steps', index: 0, sourceUrl: 'https://official.example/a#apply', sectionHeading: '申請方法', quote: '対象機関に確認する' }] }
    assert.equal((await h.request(exec, 'result', result)).status, 200)
    assert.equal((await h.request(exec, 'result', result)).status, 200)
    const saved = await call(h.app, `/cases/${h.caseId}/tasks/${task.body.data.id}/guidance`)
    assert.equal(saved.body.data.status, 'PARTIAL')
    assert.deepEqual(saved.body.data.missing, ['地域の詳細'])
    // 項目ごとの根拠を保存し、公開APIで返す（#163）。
    assert.deepEqual(saved.body.data.citations, result.citations)
  })

  it('別Runのpath/artifact、旧attempt、取消後の結果、本文不一致requestIdを拒否する', async t => {
    const h = await setup(t), a = await h.accept(), b = await h.accept()
    const context = await h.context(a)
    assert.equal((await h.request(a, 'context', undefined, { runId: b.run.id })).status, 403)
    assert.equal((await h.request(b, `artifacts/${context.contextSnapshotId}`)).status, 404)
    const headers = { 'X-Request-Id': randomUUID() }
    assert.equal((await h.request(a, 'events', { eventId: randomUUID(), sequence: 1, phase: 'PLANNING' }, { headers })).status, 200)
    assert.equal((await h.request(a, 'events', { eventId: randomUUID(), sequence: 2, phase: 'PLANNING' }, { headers })).status, 409)
    const current = await call(h.app, `/cases/${h.caseId}/agent-runs/${a.run.id}`)
    assert.equal((await call(h.app, `/cases/${h.caseId}/agent-runs/${a.run.id}/cancel`, jsonRequest('POST', { expectedVersion: current.body.data.version }))).status, 200)
    const late = await h.request(a, 'result', { ...proof(context), resultId: randomUUID(), kind: 'case_planning', status: 'SUCCEEDED' })
    assert.equal(late.status, 409)
    await firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/agentRuns/${b.run.id}`).update({ currentAttemptId: 'new-attempt' })
    assert.equal((await h.request(b, 'heartbeat', {})).status, 409)
  })

  it('同意撤回・membership除外後は業務contextと結果を拒否しcontrolでSTOPを返す', async t => {
    const h = await setup(t), exec = await h.accept()
    await h.context(exec)
    await call(h.app, '/consents/revocations', jsonRequest('POST', { kind: 'CROSS_BORDER_AI' }))
    assert.equal((await h.request(exec, 'context')).status, 403)
    assert.equal((await h.request(exec, 'control')).body.data.instruction, 'STOP')
    const definition = PLACEHOLDER_CATALOG.documents.find(d => d.kind === 'CROSS_BORDER_AI')!
    await call(h.app, '/consents', jsonRequest('POST', { agreements: [{ kind: definition.kind, version: definition.version }] }))
    await firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/caseMembers/${h.userId}`).update({ active: false })
    assert.equal((await h.request(exec, 'context')).status, 403)
    assert.equal((await h.request(exec, 'control')).body.data.instruction, 'STOP')
  })

  it('procedureId が紐付いた Task の案内 Context は、Definition の allowlist にある項目だけを投影する', async t => {
    const h = await setup(t)
    const patched = await call(h.app, `/cases/${h.caseId}`, jsonRequest('PATCH', { expectedVersion: 1, municipality: '架空市' }))
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    const task = await call(h.app, `/cases/${h.caseId}/tasks`, jsonRequest('POST', { title: '死亡届（手動登録）', category: '手動', stage: 'immediate', procedureId: 'death-notification' }))
    assert.equal(task.status, 201, JSON.stringify(task.body))
    const exec = await h.accept('task_guidance', task.body.data.id, 'TASK'), context = await h.context(exec)
    assert.deepEqual(context.content.procedure, { id: 'death-notification', version: 1, reviewStatus: 'draft' })
    const contentCase = context.content.case as Record<string, unknown>
    assert.deepEqual(Object.keys(contentCase).sort(), ['id', 'knownAt', 'municipality', 'version'])
    assert.equal(contentCase.municipality, '架空市')
    assert.deepEqual(Object.keys(context.content.task as object).sort(), ['id', 'procedureId', 'version'])
    for (const group of ['profile', 'persons', 'assets', 'liabilities', 'tasks']) assert.equal(group in context.content, false, group)
    // optional の deadlines.dueDate を持つため group は投影されるが、対象 Task の期限だけで手動 Task には無い。
    assert.deepEqual(context.content.deadlines, [])
    assert.equal(JSON.stringify(context.content).includes('架空人物'), false)
    const audits = await firestore().collection(`tenants/${h.tenantId}/cases/${h.caseId}/auditEvents`).where('type', '==', 'agent_run.context_projected').get()
    assert.equal(audits.size, 1)
    const detail = audits.docs[0]!.get('detail')
    assert.equal(detail.procedureId, 'death-notification')
    // knownAt は未入力（null）なので使用 key には入らない。
    assert.deepEqual(detail.contextKeys, ['case.municipality'])
    assert.deepEqual(detail.missingRequiredKeys, [])
    // 監査には key しか残さず、市区町村名などの値を含めない。
    assert.equal(JSON.stringify(detail).includes('架空市'), false)
  })

  it('本番相当（rejectDraftDefinitions:true）では未レビューの Definition の案内 Context を拒否する', async t => {
    const h = await setup(t, { rejectDraftDefinitions: true })
    const task = await call(h.app, `/cases/${h.caseId}/tasks`, jsonRequest('POST', { title: '死亡届（手動登録）', category: '手動', stage: 'immediate', procedureId: 'death-notification' }))
    assert.equal(task.status, 201)
    const exec = await h.accept('task_guidance', task.body.data.id, 'TASK')
    const response = await h.request(exec, 'context')
    assert.equal(response.status, 409, JSON.stringify(response.body))
    assert.equal(response.body.error.details.reason, 'PROCEDURE_NOT_REVIEWED')
  })

  it('申請者要件を扱う案内では、除外済みPersonを落とし実行ユーザー本人だけを投影する', async t => {
    const h = await setup(t)
    const self = await call(h.app, `/cases/${h.caseId}/persons`, jsonRequest('POST', { name: '実行ユーザー本人', relationship: '子', isHeir: true }))
    assert.equal(self.status, 201, JSON.stringify(self.body))
    const selfPersonId = self.body.data.id as string
    await firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/caseMembers/${h.userId}`).update({ personId: selfPersonId })
    const activeOther = await call(h.app, `/cases/${h.caseId}/persons`, jsonRequest('POST', { name: '別の家族', relationship: '親', isHeir: true }))
    assert.equal(activeOther.status, 201, JSON.stringify(activeOther.body))
    const excluded = await call(h.app, `/cases/${h.caseId}/persons`, jsonRequest('POST', { name: '除外する家族', relationship: '兄弟', isHeir: true }))
    assert.equal(excluded.status, 201, JSON.stringify(excluded.body))
    assert.equal((await call(h.app, `/cases/${h.caseId}/persons/${excluded.body.data.id}/exclude`,
      jsonRequest('POST', { expectedVersion: 1 }))).status, 200)
    const task = await call(h.app, `/cases/${h.caseId}/tasks`, jsonRequest('POST', {
      title: '埋葬料を確認する', category: '手動', stage: 'immediate', procedureId: 'kyoukaikenpo-burial-benefit',
    }))
    assert.equal(task.status, 201, JSON.stringify(task.body))
    const exec = await h.accept('task_guidance', task.body.data.id, 'TASK')
    const context = await h.context(exec)
    const persons = context.content.persons as Record<string, unknown>[]
    assert.deepEqual(persons.map(person => person.id), [selfPersonId])
    assert.equal(JSON.stringify(persons).includes(activeOther.body.data.id), false)
    assert.equal(JSON.stringify(persons).includes(excluded.body.data.id), false)
  })

  it('task_guidanceの中断結果はRunと案内を同じTransactionで終端し、再送で二重反映しない', async t => {
    const h = await setup(t)
    const task = await call(h.app, `/cases/${h.caseId}/tasks`, jsonRequest('POST', { title: '架空手続き', category: '手動', stage: 'immediate' }))
    const exec = await h.accept('task_guidance', task.body.data.id, 'TASK'), context = await h.context(exec)
    const input = { ...proof(context), resultId: 'guidance-budget', kind: 'execution_interrupted', operation: 'task_guidance',
      status: 'NEEDS_ATTENTION', failureReason: 'BUDGET_EXCEEDED', output: { summary: '予算上限', completed: [], questions: [], remaining: ['窓口の確認'] } }
    assert.equal((await h.request(exec, 'result', input)).status, 200)
    assert.equal((await h.request(exec, 'result', input)).status, 200)
    const run = await call(h.app, `/cases/${h.caseId}/agent-runs/${exec.run.id}`)
    assert.equal(run.body.data.status, 'NEEDS_ATTENTION'); assert.equal(run.body.data.failureReason, 'BUDGET_EXCEEDED')
    const guidance = await call(h.app, `/cases/${h.caseId}/tasks/${task.body.data.id}/guidance`)
    assert.equal(guidance.body.data.status, 'FAILED'); assert.equal(guidance.body.data.failureReason, 'BUDGET_EXCEEDED')
    assert.deepEqual(guidance.body.data.missing, ['窓口の確認'])
    const stored = (await readRepository().get<GuidanceEntity>(h.tenantId, { collection: collections.guidance, caseId: h.caseId, id: task.body.data.id }))!
    assert.equal(stored.resultId, 'guidance-budget'); assert.equal(stored.attemptId, exec.run.currentAttemptId)
    assert.equal(stored.agentRunId, exec.run.id)
    const audits = await firestore().collection(`tenants/${h.tenantId}/cases/${h.caseId}/auditEvents`).where('type', '==', 'guidance.failed').get()
    assert.equal(audits.size, 1)
  })

  it('受付後にCase版が進んだQUEUEDのRunは現在の版に載せ替えて配送し、STALE_CONTEXTで再送を繰り返さない', async t => {
    const h = await setup(t)
    const task = await call(h.app, `/cases/${h.caseId}/tasks`, jsonRequest('POST', { title: '架空手続き', category: '手動', stage: 'immediate' }))
    const accepted = await call(h.app, `/cases/${h.caseId}/agent-runs`, jsonRequest('POST', { operation: 'task_guidance', targetId: task.body.data.id, targetType: 'TASK' }))
    assert.equal(accepted.status, 202)
    const before = (await h.read.get<AgentRunEntity>(h.tenantId, { collection: collections.agentRuns, caseId: h.caseId, id: accepted.body.data.id }))!
    const current = await call(h.app, `/cases/${h.caseId}`)
    await call(h.app, `/cases/${h.caseId}`, jsonRequest('PATCH', { expectedVersion: current.body.data.version, municipality: '変更市' }))
    const latest = await call(h.app, `/cases/${h.caseId}`)
    assert.notEqual(latest.body.data.caseVersion, before.caseVersionAtAccept)
    const job = { eventId: before.currentJobId!, tenantId: h.tenantId, caseId: h.caseId, type: 'agent.task_guidance', payload: { runId: before.id }, attempt: 1 }
    assert.deepEqual(await h.client.deliver(job), { status: 'ACCEPTED' })
    const after = (await h.read.get<AgentRunEntity>(h.tenantId, { collection: collections.agentRuns, caseId: h.caseId, id: before.id }))!
    assert.equal(after.caseVersionAtAccept, latest.body.data.caseVersion)
    assert.notEqual(after.currentAttemptId, before.currentAttemptId)
    assert.equal(after.currentJobId, before.currentJobId)
    const dispatch = h.ai.dispatches.at(-1)!
    const claims = await h.authorization.verify(dispatch.executionAuthorization)
    assert.equal(claims.executionAttempt, after.currentAttemptId, '配送される権限は載せ替え後の試行')
    const exec = { run: after, job, dispatch, claims }
    assert.equal((await h.request(exec, 'control')).body.data.instruction, 'CONTINUE')
    const context = await h.context(exec)
    assert.equal(context.caseVersion, latest.body.data.caseVersion)
    const audits = await firestore().collection(`tenants/${h.tenantId}/cases/${h.caseId}/auditEvents`).where('type', '==', 'agent_run.context_rebased').get()
    assert.equal(audits.size, 1)
    assert.equal((await call(h.app, `/cases/${h.caseId}/tasks/${task.body.data.id}/guidance`)).body.data.status, 'RESEARCHING')
  })

  it('配送期限を超えた一時障害は打ち切り、RunをFAILED・案内をFAILEDにしてからOutboxを終端する', async t => {
    const h = await setup(t)
    const task = await call(h.app, `/cases/${h.caseId}/tasks`, jsonRequest('POST', { title: '架空手続き', category: '手動', stage: 'immediate' }))
    const accepted = await call(h.app, `/cases/${h.caseId}/agent-runs`, jsonRequest('POST', { operation: 'task_guidance', targetId: task.body.data.id, targetType: 'TASK' }))
    const run = (await h.read.get<AgentRunEntity>(h.tenantId, { collection: collections.agentRuns, caseId: h.caseId, id: accepted.body.data.id }))!
    const outboxRef = firestore().doc(`tenants/${h.tenantId}/outbox/${run.currentJobId}`)
    const abandoned: string[] = []
    const dispatcher = new OutboxDispatcher(firestore(), h.client, h.consent, 1_000, undefined, {
      deliveryTimeoutMs: 60_000,
      onGiveUp: async (event, reason) => { abandoned.push(reason); await h.service.abandonDispatch(event.tenantId, event.caseId!, event.payload.runId as string, event.id, reason) },
    })
    for (const doc of (await firestore().collection(`tenants/${h.tenantId}/outbox`).where('type', '!=', 'agent.task_guidance').get()).docs) {
      await doc.ref.update({ status: 'DELIVERED' })
    }
    h.ai.respondWith(503)
    const first = await dispatcher.dispatchBatch(h.tenantId)
    assert.deepEqual([first.retrying.length, first.rejected.length], [1, 0], '期限内の503は再試行に回す')
    assert.equal((await outboxRef.get()).get('status'), 'PENDING')
    assert.equal((await call(h.app, `/cases/${h.caseId}/agent-runs/${run.id}`)).body.data.status, 'QUEUED')

    await outboxRef.update({ createdAt: new Date(Date.now() - 120_000).toISOString(), nextAttemptAt: new Date().toISOString() })
    h.ai.respondWith(503)
    const second = await dispatcher.dispatchBatch(h.tenantId)
    assert.deepEqual([second.retrying.length, second.rejected.length], [0, 1])
    assert.equal((await outboxRef.get()).get('status'), 'FAILED')
    assert.match((await outboxRef.get()).get('lastError'), /^DELIVERY_TIMEOUT:/)
    assert.equal(abandoned.length, 1)
    const view = await call(h.app, `/cases/${h.caseId}/agent-runs/${run.id}`)
    assert.equal(view.body.data.status, 'FAILED'); assert.match(view.body.data.failureReason, /^DELIVERY_TIMEOUT:/)
    const guidance = await call(h.app, `/cases/${h.caseId}/tasks/${task.body.data.id}/guidance`)
    assert.equal(guidance.body.data.status, 'FAILED'); assert.match(guidance.body.data.failureReason, /^DELIVERY_TIMEOUT:/)
    assert.equal(await h.service.abandonDispatch(h.tenantId, h.caseId, run.id, run.currentJobId!, 'again'), false, '終端済みのRunを上書きしない')
  })

  it('AI未接続(AI_EXECUTION_NOT_CONNECTED)は配送期限を待たず即時RunをFAILED・案内をFAILEDにする', async t => {
    const h = await setup(t)
    const task = await call(h.app, `/cases/${h.caseId}/tasks`, jsonRequest('POST', { title: '架空手続き', category: '手動', stage: 'immediate' }))
    const accepted = await call(h.app, `/cases/${h.caseId}/agent-runs`, jsonRequest('POST', { operation: 'task_guidance', targetId: task.body.data.id, targetType: 'TASK' }))
    const run = (await h.read.get<AgentRunEntity>(h.tenantId, { collection: collections.agentRuns, caseId: h.caseId, id: accepted.body.data.id }))!
    const outboxRef = firestore().doc(`tenants/${h.tenantId}/outbox/${run.currentJobId}`)
    const abandoned: string[] = []
    const dispatcher = new OutboxDispatcher(firestore(), h.client, h.consent, 1_000, undefined, {
      deliveryTimeoutMs: 60_000,
      onGiveUp: async (event, reason) => { abandoned.push(reason); await h.service.abandonDispatch(event.tenantId, event.caseId!, event.payload.runId as string, event.id, reason) },
    })
    for (const doc of (await firestore().collection(`tenants/${h.tenantId}/outbox`).where('type', '!=', 'agent.task_guidance').get()).docs) {
      await doc.ref.update({ status: 'DELIVERED' })
    }
    h.ai.respondWith(503, { error: { code: 'AI_EXECUTION_NOT_CONNECTED' } })
    const result = await dispatcher.dispatchBatch(h.tenantId)
    assert.deepEqual([result.retrying.length, result.rejected.length], [0, 1], '未接続は一時障害と区別して即時終端する')
    assert.equal((await outboxRef.get()).get('status'), 'FAILED')
    assert.equal((await outboxRef.get()).get('lastError'), 'AI_EXECUTION_NOT_CONNECTED')
    assert.equal(abandoned.length, 1)
    const view = await call(h.app, `/cases/${h.caseId}/agent-runs/${run.id}`)
    assert.equal(view.body.data.status, 'FAILED'); assert.equal(view.body.data.failureReason, 'AI_EXECUTION_NOT_CONNECTED')
    const guidance = await call(h.app, `/cases/${h.caseId}/tasks/${task.body.data.id}/guidance`)
    assert.equal(guidance.body.data.status, 'FAILED'); assert.equal(guidance.body.data.failureReason, 'AI_EXECUTION_NOT_CONNECTED')
  })

  it('取消はTask側の案内も失敗にし、受け手の無い通知イベントはローカルで配送済みにする', async t => {
    const h = await setup(t)
    const task = await call(h.app, `/cases/${h.caseId}/tasks`, jsonRequest('POST', { title: '架空手続き', category: '手動', stage: 'immediate' }))
    const exec = await h.accept('task_guidance', task.body.data.id, 'TASK')
    const current = await call(h.app, `/cases/${h.caseId}/agent-runs/${exec.run.id}`)
    assert.equal((await call(h.app, `/cases/${h.caseId}/agent-runs/${exec.run.id}/cancel`, jsonRequest('POST', { expectedVersion: current.body.data.version }))).status, 200)
    const guidance = await call(h.app, `/cases/${h.caseId}/tasks/${task.body.data.id}/guidance`)
    assert.equal(guidance.body.data.status, 'FAILED'); assert.equal(guidance.body.data.failureReason, 'CANCELLED')

    const now = new Date().toISOString()
    await firestore().doc(`tenants/${h.tenantId}/outbox/notify-1`).set({ id: 'notify-1', tenantId: h.tenantId, caseId: h.caseId, type: 'task.completed',
      payload: { taskId: task.body.data.id }, initiatedByUserId: h.userId, status: 'PENDING', attempts: 0, nextAttemptAt: now, lastError: null, createdAt: now, updatedAt: now })
    await firestore().doc(`tenants/${h.tenantId}/outbox/unknown-1`).set({ id: 'unknown-1', tenantId: h.tenantId, caseId: h.caseId, type: 'something.unhandled',
      payload: {}, initiatedByUserId: h.userId, status: 'PENDING', attempts: 0, nextAttemptAt: now, lastError: null, createdAt: now, updatedAt: now })
    for (const doc of (await firestore().collection(`tenants/${h.tenantId}/outbox`).where('type', 'in', ['agent.task_guidance', 'agent.cancel', 'case.created']).get()).docs) {
      await doc.ref.update({ status: 'DELIVERED' })
    }
    const dispatcher = new OutboxDispatcher(firestore(), h.client, h.consent, 1_000, acknowledgeLocally(['task.completed', 'decision.confirmed']))
    const result = await dispatcher.dispatchBatch(h.tenantId)
    assert.ok(result.delivered.includes('notify-1')); assert.ok(result.rejected.includes('unknown-1'))
    assert.equal((await firestore().doc(`tenants/${h.tenantId}/outbox/notify-1`).get()).get('status'), 'DELIVERED')
    assert.equal((await firestore().doc(`tenants/${h.tenantId}/outbox/unknown-1`).get()).get('lastError'), 'NO_CONSUMER')
  })

  it('案件更新後のartifactと結果を拒否する', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec)
    const current = await call(h.app, `/cases/${h.caseId}`)
    await call(h.app, `/cases/${h.caseId}`, jsonRequest('PATCH', { expectedVersion: current.body.data.version, municipality: '変更市' }))
    assert.equal((await h.request(exec, `artifacts/${context.contextSnapshotId}`)).status, 409)
    assert.equal((await h.request(exec, 'result', { ...proof(context), resultId: randomUUID(), kind: 'case_planning', status: 'SUCCEEDED' })).status, 409)
    assert.equal((await h.request(exec, 'control')).body.data.reason, 'STALE_CONTEXT')
  })

  it('未検査/検査中/拒否/失敗の書類はcontextに含まず、原本キーも配信しない', async t => {
    const h = await setup(t)
    const docs = firestore().collection(`tenants/${h.tenantId}/cases/${h.caseId}/documents`)
    for (const status of ['PENDING', 'IN_PROGRESS', 'REJECTED', 'FAILED', 'PASSED']) await docs.doc(status).set({
      id: status, tenantId: h.tenantId, caseId: h.caseId, version: 1, schemaVersion: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), storageState: 'STORED', archived: false,
      inspection: { status, maskedObjectKey: 'private-mask' }, kind: 'OTHER', fileName: 'private-original', objectKey: 'private-original-key',
    })
    const exec = await h.accept(), context = await h.context(exec)
    assert.deepEqual(context.content.documents, [{ id: 'PASSED', version: 1, kind: 'OTHER', contentAvailable: false }])
    assert.equal(JSON.stringify(context).includes('private-'), false)
    assert.equal((await h.request(exec, 'artifacts/PASSED')).status, 404, '原本IDから内容を配信しない')
    await docs.doc('PASSED').update({ 'inspection.status': 'FAILED' })
    assert.equal((await h.request(exec, `artifacts/${context.contextSnapshotId}`)).status, 409)
  })

  it('別Caseの根拠とbody上限を拒否し、旧results endpointはない', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec)
    const response = await h.request(exec, 'result', { ...proof(context), resultId: randomUUID(), kind: 'case_planning', status: 'SUCCEEDED',
      basis: [{ type: 'TASK', id: 'another-case-task', version: 1 }] })
    assert.equal(response.status, 403)
    assert.equal((await h.request(exec, 'heartbeat', { data: 'x'.repeat(INTERNAL_LIMITS.bodyBytes) })).status, 400)
    const old = await fetch(`${h.baseUrl}/internal/v1/tenants/${h.tenantId}/cases/${h.caseId}/results`, {
      method: 'POST', headers: { Authorization: `Bearer ${incoming}` }, body: '{}',
    })
    assert.equal(old.status, 404)
  })

  it('誤った409をACKとせず、確認済みの重複のみ配送成功とする', async t => {
    const h = await setup(t), exec = await h.accept()
    h.ai.respondWith(409)
    assert.equal((await h.client.deliver(exec.job)).status, 'RETRYABLE')
    assert.equal((await h.client.deliver(exec.job)).status, 'ACCEPTED')
    assert.equal(h.ai.accepted.size, 1)
  })
})

describeFirestore('AI Proposal lease / fencing / human approval', () => {
  function proposal(context: ContextArtifact) {
    return { ...proof(context), proposalId: randomUUID(), kind: 'ASSET_PROPOSAL', title: '架空財産の候補', summary: '',
      payload: { operation: 'CREATE', fields: { name: '架空預金', kind: 'BANK', institution: '架空銀行', amount: 100, taxAttention: false, note: null } },
      basis: [], assetDisposal: false }
  }
  async function approve(h: Awaited<ReturnType<typeof setup>>, submitted: any) {
    const approval = (await call(h.app, `/cases/${h.caseId}/approvals/${submitted.approvalId}`)).body.data
    return call(h.app, `/cases/${h.caseId}/approvals/${submitted.approvalId}/approve`, jsonRequest('POST', {
      expectedVersion: approval.version, proposalVersion: submitted.proposalVersion, payloadHash: submitted.payloadHash,
    }))
  }
  it('owner restriction rejects AI proposals with a fresh Context but preserves manual task creation', async t => {
    const h = await setup(t)
    const current = (await call(h.app, `/cases/${h.caseId}`)).body.data
    const paused = await call(h.app, `/cases/${h.caseId}/ai-planning-restriction`, jsonRequest('PATCH', {
      expectedVersion: current.version, restriction: { reason: '本人の確認まで停止' },
    }))
    assert.equal(paused.status, 200)
    const exec = await h.accept(), context = await h.context(exec)
    assert.deepEqual(context.content.planningRestriction, { reason: '本人の確認まで停止' })
    const response = await h.request(exec, 'proposals', proposal(context))
    assert.equal(response.status, 409, JSON.stringify(response.body))
    assert.equal(response.body.error.details.reason, 'AI_PLANNING_RESTRICTED')
    assert.equal((await call(h.app, `/cases/${h.caseId}/proposals`)).body.data.length, 0)
    const manual = await call(h.app, `/cases/${h.caseId}/tasks`, jsonRequest('POST', { title: '利用者の手続き', category: '手動', stage: 'immediate' }))
    assert.equal(manual.status, 201)
  })

  it('pausing after submission invalidates the Context and pending AI approval', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec)
    const submitted = await h.request(exec, 'proposals', proposal(context))
    assert.equal(submitted.status, 200)
    const current = (await call(h.app, `/cases/${h.caseId}`)).body.data
    assert.equal((await call(h.app, `/cases/${h.caseId}/ai-planning-restriction`, jsonRequest('PATCH', {
      expectedVersion: current.version, restriction: { reason: '計画を見直す' },
    }))).status, 200)
    assert.equal((await h.request(exec, 'proposals', proposal(context))).status, 409)
    const response = await approve(h, submitted.body.data)
    assert.equal(response.status, 409)
    assert.equal((await call(h.app, `/cases/${h.caseId}/assets`)).body.data.length, 0)
  })

  it('AI Task提案は承認時に依存と必要書類を反映し、不明・循環する依存を拒否する', async t => {
    for (const variant of ['valid', 'foreign', 'cycle']) {
      const h = await setup(t)
      const existing = (await call(h.app, `/cases/${h.caseId}/tasks`, jsonRequest('POST', { title: '先行手続き', stage: 'government', category: 'fixture' }))).body.data
      const taskDocs = firestore().collection(`tenants/${h.tenantId}/cases/${h.caseId}/tasks`)
      if (variant === 'cycle') await taskDocs.doc(existing.id).update({ dependencyTaskIds: [existing.id] })
      const exec = await h.accept(), context = await h.context(exec)
      const input = { ...proposal(context), kind: 'TASK_PROPOSAL', title: '後続手続き', payload: {
        title: '後続手続き', summary: '', stage: 'government', category: 'fixture', submitTo: '架空機関',
        dependencyTaskIds: [variant === 'foreign' ? 'foreign-task' : existing.id], requiredDocuments: [{ id: 'required-one', label: '確認資料' }],
      } }
      const submitted = await h.request(exec, 'proposals', input)
      assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
      const approved = await approve(h, submitted.body.data)
      if (variant === 'valid') {
        assert.equal(approved.status, 200, JSON.stringify(approved.body))
        const created = (await taskDocs.where('source', '==', 'AI').get()).docs.map(doc => doc.data()).find(task => task.title === '後続手続き')!
        assert.deepEqual(created.dependencyTaskIds, [existing.id])
        assert.deepEqual(created.requiredDocuments, [{ id: 'required-one', label: '確認資料', documentId: null, source: 'AI' }])
      } else {
        assert.ok(approved.status >= 400)
        assert.equal((await taskDocs.where('source', '==', 'AI').get()).size, 0)
      }
      assert.equal((await taskDocs.doc(existing.id).get()).get('source'), 'MANUAL')
    }
  })
  it('同じCaseへの並行context要求でleaseを取れる実行は一つだけ', async t => {
    const h = await setup(t), a = await h.accept(), b = await h.accept()
    const results = await Promise.all([h.request(a, 'context'), h.request(b, 'context')])
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
    const lease = await firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/coordination/writer`).get()
    assert.equal(lease.get('fencingToken'), 1)
  })
  it('同一Caseの実行区間は直列化され、失効後に引き継がれた古い所有者は提出できない', async t => {
    const h = await setup(t), a = await h.accept(), b = await h.accept()
    const aContext = await h.context(a)
    assert.equal((await h.request(b, 'context')).status, 409)
    const lease = firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/coordination/writer`)
    await lease.update({ expiresAt: new Date(0).toISOString() })
    const bContext = await h.context(b)
    assert.ok(bContext.fencingToken > aContext.fencingToken)
    assert.equal((await h.request(a, 'proposals', proposal(aContext))).status, 409)
    assert.equal((await h.request(a, 'heartbeat', {})).status, 409)
    assert.equal((await h.request(a, 'result', { ...proof(aContext), resultId: randomUUID(), kind: 'case_planning', status: 'SUCCEEDED' })).status, 409)
    const forged = proposal(bContext)
    forged.fencingToken = aContext.fencingToken
    assert.equal((await h.request(b, 'proposals', forged)).status, 409)
    assert.equal((await h.request(b, 'proposals', proposal(bContext))).status, 200)
  })

  it('AI提出は不変Proposalと承認を一度だけ作り、業務Entityと案件版は承認まで変えない', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec), input = proposal(context)
    const submitted = await h.request(exec, 'proposals', input)
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
    assert.deepEqual((await h.request(exec, 'proposals', input)).body.data, submitted.body.data)
    assert.equal((await h.request(exec, 'proposals', { ...input, title: '別の要求' })).status, 409)
    assert.equal((await call(h.app, `/cases/${h.caseId}/proposals`)).body.data.length, 1)
    assert.equal((await call(h.app, `/cases/${h.caseId}/approvals`)).body.data.length, 1)
    assert.equal((await call(h.app, `/cases/${h.caseId}`)).body.data.caseVersion, context.caseVersion)
    assert.equal((await call(h.app, `/cases/${h.caseId}/assets`)).body.data.length, 0)
    const history = await call(h.app, `/cases/${h.caseId}/proposals/${submitted.body.data.proposalId}/versions/1`)
    assert.equal(history.body.data.source, 'AI')
    assert.equal('execution' in history.body.data, false, '内部実行権を公開DTOへ渡さない')
    assert.equal((await approve(h, submitted.body.data)).status, 200)
    const assets = (await firestore().collection(`tenants/${h.tenantId}/cases/${h.caseId}/assets`).get()).docs
    assert.equal(assets.length, 1)
    assert.equal(assets[0]!.get('confirmation.state'), 'UNCONFIRMED')
    assert.equal(assets[0]!.get('provenance.source'), 'AI')
    assert.equal((await call(h.app, `/cases/${h.caseId}`)).body.data.caseVersion, context.caseVersion + 1)
    assert.equal((await approve(h, submitted.body.data)).status, 409, '二重承認で再適用しない')
  })

  it('人の承認は失効したAI権限を流用せず現在のlease世代で適用する', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec)
    const submitted = await h.request(exec, 'proposals', proposal(context))
    const lease = firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/coordination/writer`)
    await lease.update({ expiresAt: new Date(0).toISOString() })
    assert.equal((await h.request(exec, 'proposals', proposal(context))).status, 409, '期限切れAIからの新規提出は禁止')
    assert.equal((await approve(h, submitted.body.data)).status, 200, '保存済みの同一内容を人が確認する経路は独立')
    const after = await lease.get()
    assert.ok(after.get('fencingToken') > context.fencingToken)
    assert.equal(after.get('holderRunId'), null)
    assert.equal((await h.request(exec, 'proposals', proposal(context))).status, 409)
  })

  it('別の実行が現在のleaseを持つ間は人の適用も競合として拒否する', async t => {
    const h = await setup(t), a = await h.accept(), context = await h.context(a)
    const submitted = await h.request(a, 'proposals', proposal(context))
    await firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/coordination/writer`).update({ expiresAt: new Date(0).toISOString() })
    const b = await h.accept()
    await h.context(b)
    const response = await approve(h, submitted.body.data)
    assert.equal(response.status, 409)
    assert.equal(response.body.error.details.reason, 'CASE_BUSY')
    assert.equal((await call(h.app, `/cases/${h.caseId}/assets`)).body.data.length, 0)
  })

  it('人が案件内の業務を更新するとAI提出も、既存の提案適用もstaleになる', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec)
    const submitted = await h.request(exec, 'proposals', proposal(context))
    await call(h.app, `/cases/${h.caseId}/tasks`, jsonRequest('POST', { title: '新しい手続き', category: '手動', stage: 'immediate' }))
    assert.equal((await h.request(exec, 'proposals', proposal(context))).status, 409)
    const response = await approve(h, submitted.body.data)
    assert.equal(response.status, 409)
    assert.equal(response.body.error.details.reason, 'STALE_PROPOSAL')
    assert.equal((await call(h.app, `/cases/${h.caseId}/assets`)).body.data.length, 0)
  })

  it('取消や旧attemptのAI提案は提出・適用のどちらも拒否する', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec)
    const submitted = await h.request(exec, 'proposals', proposal(context))
    const run = (await call(h.app, `/cases/${h.caseId}/agent-runs/${exec.run.id}`)).body.data
    await call(h.app, `/cases/${h.caseId}/agent-runs/${exec.run.id}/cancel`, jsonRequest('POST', { expectedVersion: run.version }))
    assert.equal((await h.request(exec, 'proposals', proposal(context))).status, 409)
    assert.equal((await approve(h, submitted.body.data)).status, 409)
    const lease = await firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/coordination/writer`).get()
    assert.equal(lease.get('holderRunId'), null, '取消と同じtransactionでleaseを解放する')
  })

  it('AIに承認不要・source・本人意思の確定を申告させない', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec)
    for (const extra of [{ approvalRequired: false }, { source: 'USER' }, { role: 'OWNER' }, { kind: 'DECISION_CONFIRM' }]) {
      assert.equal((await h.request(exec, 'proposals', { ...proposal(context), ...extra })).status, 400)
    }
  })

  it('外側の認可を通った直後に権限が撤回されても承認transactionで再拒否する', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec)
    const submitted = (await h.request(exec, 'proposals', proposal(context))).body.data
    const read = readRepository(), access = new AccessService(read)
    const user = { tenantId: h.tenantId, userId: h.userId }
    const cached = await access.authorizeCase(user, h.caseId, 'approval.decide')
    access.authorizeCase = async () => cached
    await firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/caseMembers/${h.userId}`).update({ role: 'VIEWER' })
    const service = new ProposalService(access, read, new ContextVersionUnitOfWork(unitOfWork()), entityProposalAppliers)
    await assert.rejects(service.approve(user, h.caseId, submitted.approvalId, {
      expectedVersion: 1, proposalVersion: submitted.proposalVersion, payloadHash: submitted.payloadHash,
    }, { requestId: randomUUID(), idempotency: null }), { code: 'FORBIDDEN' })
    assert.equal((await firestore().collection(`tenants/${h.tenantId}/cases/${h.caseId}/assets`).get()).size, 0)
  })

  it('先行承認をInboxに保持しSnapshot保存後に一度だけ再開、fresh contextと同一Actionで再適用を防ぐ', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec), input = proposal(context)
    const submitted = (await h.request(exec, 'proposals', input)).body.data
    assert.ok(submitted.waitRequestId)
    assert.equal((await approve(h, submitted)).status, 200)
    await h.ingest(); await h.ingest()
    await h.reconciler().reconcile(h.tenantId, h.caseId, exec.run.id)
    const runRef = firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/agentRuns/${exec.run.id}`)
    assert.equal((await runRef.get()).get('status'), 'RUNNING', 'Snapshot保存前は再開しない')
    h.ai.snapshots.set(exec.run.id, { runId: exec.run.id, jobId: exec.claims.jobId, executionAttempt: exec.claims.executionAttempt,
      waitRequestId: submitted.waitRequestId, snapshotId: 'durable-snapshot', state: 'WAITING' })
    await Promise.all([h.reconciler().reconcile(h.tenantId, h.caseId, exec.run.id), h.reconciler().reconcile(h.tenantId, h.caseId, exec.run.id)])
    const queued = (await runRef.get()).data() as AgentRunEntity
    assert.equal(queued.status, 'QUEUED'); assert.equal(queued.attempt, 2)
    const outbox = await firestore().collection(`tenants/${h.tenantId}/outbox`).where('type', '==', 'agent.resume').get()
    assert.equal(outbox.size, 1)
    const job = { ...exec.job, eventId: queued.currentJobId!, type: 'agent.resume' }
    assert.equal((await h.client.deliver(job)).status, 'ACCEPTED')
    assert.equal((await h.client.deliver(job)).status, 'ACCEPTED')
    assert.equal(h.ai.accepted.has(job.eventId), true)
    const dispatch = h.ai.dispatches.at(-1)!, claims = await h.authorization.verify(dispatch.executionAuthorization)
    const resumed = { ...exec, dispatch, claims }
    const fresh = await h.context(resumed)
    assert.ok(fresh.caseVersion > context.caseVersion); assert.ok(fresh.fencingToken > context.fencingToken)
    assert.equal((fresh.content.resume as any).snapshotId, 'durable-snapshot')
    assert.equal((fresh.content.actions as any[])[0].status, 'APPLIED')
    assert.equal(typeof (fresh.content.actions as any[])[0].payloadHash, 'string')
    assert.match((fresh.content.actions as any[])[0].payloadHash, /^[A-Za-z0-9_-]{43}$/)
    const history = fresh.content.planningHistory as any
    assert.equal(history.complete, true)
    assert.equal(history.proposals[0].status, 'APPLIED')
    assert.equal(history.proposals[0].payloadHash, history.versions[0].payloadHash)
    assert.equal(history.approvals[0].applicationStatus, 'APPLIED')
    assert.equal('payload' in history.proposals[0], false)
    const repeated = await h.request(resumed, 'proposals', { ...input, ...proof(fresh) })
    assert.equal(repeated.status, 200, JSON.stringify(repeated.body))
    assert.equal(repeated.body.data.applicationStatus, 'APPLIED')
    assert.equal((await firestore().collection(`tenants/${h.tenantId}/cases/${h.caseId}/assets`).get()).size, 1)
    assert.equal((await h.request(exec, 'result', { ...proof(context), kind: 'case_planning', status: 'SUCCEEDED', resultId: randomUUID() })).status, 409)
    const result = { ...proof(fresh), kind: 'case_planning', status: 'SUCCEEDED', resultId: randomUUID() }
    assert.equal((await h.request(resumed, 'result', result)).status, 200)
    const count = h.ai.countOf(job.eventId)
    assert.equal((await h.client.deliver(job)).status, 'ACCEPTED', '結果が配送ACKより先でも再実行しない')
    assert.equal(h.ai.countOf(job.eventId), count)
  })

  it('先行承認でleaseが変わった後も待機イベントを保存し、未完のWaitがある最終結果は拒否する', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec)
    const submitted = (await h.request(exec, 'proposals', proposal(context))).body.data
    assert.equal((await h.request(exec, 'result', { ...proof(context), kind: 'case_planning', status: 'SUCCEEDED', resultId: randomUUID() })).status, 409)
    assert.equal((await approve(h, submitted)).status, 200)
    const event = { type: 'WAITING', eventId: randomUUID(), waitRequestId: submitted.waitRequestId, snapshotId: 'snapshot' }
    assert.equal((await h.request(exec, 'events', event)).status, 200)
    assert.equal((await h.request(exec, 'events', event)).status, 200)
    assert.equal((await h.request(exec, 'events', { ...event, snapshotId: 'other' })).status, 409)
    const ref = firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/coordination/writer`)
    assert.equal((await ref.get()).get('holderRunId'), null)
  })

  it('待機中の同意撤回はSnapshot HTTPが不通でも取消し、再開配送も拒否する', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec)
    const submitted = (await h.request(exec, 'proposals', proposal(context))).body.data
    await h.request(exec, 'events', { type: 'WAITING', eventId: randomUUID(), waitRequestId: submitted.waitRequestId, snapshotId: 'snapshot' })
    assert.equal((await call(h.app, '/consents/revocations', jsonRequest('POST', { kind: 'CROSS_BORDER_AI' }))).status, 200)
    const broken = new RunReconciler(readRepository(), new ContextVersionUnitOfWork(unitOfWork()), h.service,
      { status: async () => { throw new Error('must not query revoked execution') } })
    await broken.reconcile(h.tenantId, h.caseId, exec.run.id)
    assert.equal((await firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/agentRuns/${exec.run.id}`).get()).get('status'), 'CANCELLED')
    assert.equal((await h.request(exec, 'events', { type: 'WAITING', eventId: randomUUID(), waitRequestId: submitted.waitRequestId, snapshotId: 'snapshot' })).status, 403)
  })

  it('期限切れRUNNINGはcheckpoint復旧と同一Run再試行を分け、旧attemptを拒否する', async t => {
    for (const checkpoint of [false, true]) {
      const h = await setup(t), exec = await h.accept(), context = await h.context(exec)
      await firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/coordination/writer`).update({ expiresAt: new Date(0).toISOString() })
      if (checkpoint) h.ai.snapshots.set(exec.run.id, { runId: exec.run.id, jobId: exec.claims.jobId, executionAttempt: exec.claims.executionAttempt,
        waitRequestId: null, snapshotId: 'checkpoint', state: 'RUNNING_CHECKPOINT' })
      await h.reconciler().reconcile(h.tenantId, h.caseId, exec.run.id)
      const run = (await firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/agentRuns/${exec.run.id}`).get()).data() as AgentRunEntity
      assert.equal(run.pendingResume?.kind, checkpoint ? 'CHECKPOINT' : 'RETRY')
      assert.equal(run.id, exec.run.id); assert.equal(run.attempt, 2)
      assert.equal((await h.request(exec, 'result', { ...proof(context), kind: 'case_planning', status: 'SUCCEEDED', resultId: randomUUID() })).status, 409)
    }
  })

  it('書き込み権を失ったRUNNINGでAI側が完了済みなら要確認にし、公開履歴へ残す', async t => {
    const h = await setup(t), exec = await h.accept()
    await h.context(exec)
    await firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/coordination/writer`).update({ expiresAt: new Date(0).toISOString() })
    h.ai.snapshots.set(exec.run.id, { runId: exec.run.id, jobId: exec.claims.jobId, executionAttempt: exec.claims.executionAttempt,
      waitRequestId: null, snapshotId: null, state: 'COMPLETED' })
    await h.reconciler().reconcile(h.tenantId, h.caseId, exec.run.id)
    const run = (await firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/agentRuns/${exec.run.id}`).get()).data() as AgentRunEntity
    assert.equal(run.status, 'NEEDS_ATTENTION')

    // 公開可能な履歴（Issue #125）。復旧要確認もイベントに残る。
    const events = await agentRunEvents(h.tenantId, h.caseId, exec.run.id)
    const attention = events.find(e => e.status === 'NEEDS_ATTENTION' && e.kind === 'RESULT')
    assert.ok(attention, 'Reconcilerの復旧要確認イベントが記録されていない')
    assert.equal(attention!.detail.failureReason, 'RECOVERY_ATTENTION')
  })

  it('待機保存後にBackend workerを別プロセスで再起動してもresume intentを回復する', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec)
    const submitted = (await h.request(exec, 'proposals', proposal(context))).body.data
    await h.request(exec, 'events', { type: 'WAITING', eventId: randomUUID(), waitRequestId: submitted.waitRequestId, snapshotId: 'persistent' })
    h.ai.snapshots.set(exec.run.id, { runId: exec.run.id, jobId: exec.claims.jobId, executionAttempt: exec.claims.executionAttempt,
      waitRequestId: submitted.waitRequestId, snapshotId: 'persistent', state: 'WAITING' })
    assert.equal((await approve(h, submitted)).status, 200)
    const worker = async () => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker-main.ts', '--once'], {
        env: { ...process.env, NODE_ENV: 'test', OUTBOX_TENANT_IDS: h.tenantId, AI_SERVER_URL: h.ai.url,
          BACKEND_EXECUTION_SIGNING_KEY: signingKey, AI_SERVICE_TOKEN: outgoing, AI_SERVICE_TIMEOUT_MS: '1000' }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''; child.stdout.on('data', c => { output += c }); child.stderr.on('data', c => { output += c })
      const [code] = await once(child, 'exit'); assert.equal(code, 0, output)
    }
    await worker(); await worker()
    const jobs = await firestore().collection(`tenants/${h.tenantId}/outbox`).where('type', '==', 'agent.resume').get()
    assert.equal(jobs.size, 1); assert.equal(jobs.docs[0]!.get('status'), 'DELIVERED')
    assert.equal(h.ai.accepted.has(jobs.docs[0]!.id), true)
  })

  it('Snapshot保存失敗は要確認になり、手動retryで同一Actionの不変な新提案版を作る', async t => {
    const h = await setup(t), exec = await h.accept(), context = await h.context(exec), input = proposal(context)
    const submitted = (await h.request(exec, 'proposals', input)).body.data
    await firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/waitRequests/${submitted.waitRequestId}`).update({ updatedAt: new Date(0).toISOString() })
    await h.reconciler().reconcile(h.tenantId, h.caseId, exec.run.id)
    const path = `/cases/${h.caseId}/agent-runs/${exec.run.id}`
    const run = (await call(h.app, path)).body.data
    assert.equal(run.status, 'NEEDS_ATTENTION')

    // 公開可能な履歴（Issue #125）。ReconcilerによるNEEDS_ATTENTIONも記録される。
    const events = await agentRunEvents(h.tenantId, h.caseId, exec.run.id)
    const attention = events.find(e => e.status === 'NEEDS_ATTENTION' && e.kind === 'RESULT')
    assert.ok(attention, 'Reconcilerによる要確認イベントが記録されていない')
    assert.equal(attention!.detail.failureReason, 'SNAPSHOT_MISSING')

    assert.equal((await call(h.app, `${path}/retry`, jsonRequest('POST', { expectedVersion: run.version }))).status, 202)
    const eventsAfterRetry = await agentRunEvents(h.tenantId, h.caseId, exec.run.id)
    assert.equal(eventsAfterRetry.filter(e => e.kind === 'RETRIED').length, 1, '手動retryのRETRIEDイベントが記録されていない')
    const stored = (await firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/agentRuns/${exec.run.id}`).get()).data() as AgentRunEntity
    assert.equal(stored.activeWaitRequestId, null)
    assert.equal((await h.client.deliver({ ...exec.job, eventId: stored.currentJobId! })).status, 'ACCEPTED')
    const dispatch = h.ai.dispatches.at(-1)!, claims = await h.authorization.verify(dispatch.executionAuthorization)
    const retried = { ...exec, dispatch, claims }, fresh = await h.context(retried)
    const revised = await h.request(retried, 'proposals', { ...input, ...proof(fresh) })
    assert.equal(revised.status, 200, JSON.stringify(revised.body)); assert.equal(revised.body.data.proposalVersion, 2)
    assert.equal(revised.body.data.proposalId, submitted.proposalId)
    assert.equal((await call(h.app, `/cases/${h.caseId}/approvals/${submitted.approvalId}`)).body.data.status, 'EXPIRED')
    assert.equal((await call(h.app, `/cases/${h.caseId}/proposals/${submitted.proposalId}/versions/1`)).status, 200)
  })

  it('誤ったSnapshot対応を拒否し、書類待ちは実検査接続前に再開しない', async t => {
    const h = await setup(t)
    const taskResponse = await call(h.app, `/cases/${h.caseId}/tasks`, jsonRequest('POST', { title: '書類待ち', category: '手動', stage: 'immediate',
      requiredDocuments: [{ id: 'required-slot', label: '合成書類', documentId: null }] }))
    assert.equal(taskResponse.status, 201, JSON.stringify(taskResponse.body))
    const task = taskResponse.body.data
    const exec = await h.accept('task_guidance', task.id, 'TASK'), context = await h.context(exec)
    const input = { ...proof(context), waitRequestId: 'document-wait', condition: { kind: 'DOCUMENTS', taskId: task.id, requiredDocumentIds: ['required-slot'] } }
    const response = await h.request(exec, 'wait-requests', input)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal((await h.request(exec, 'wait-requests', input)).status, 200)
    assert.equal((await h.request(exec, 'wait-requests', { ...input, waitRequestId: 'other', condition: { ...input.condition, taskId: 'other-task' } })).status, 404)
    const waitRequestId = response.body.data.waitRequestId
    h.ai.snapshots.set(exec.run.id, { runId: 'other-run', jobId: exec.claims.jobId, executionAttempt: exec.claims.executionAttempt,
      waitRequestId, snapshotId: 'snapshot', state: 'WAITING' })
    await assert.rejects(h.reconciler().reconcile(h.tenantId, h.caseId, exec.run.id), { code: 'CONFLICT' })
    h.ai.snapshots.set(exec.run.id, { ...h.ai.snapshots.get(exec.run.id)!, runId: exec.run.id })
    await h.reconciler().reconcile(h.tenantId, h.caseId, exec.run.id)
    assert.equal((await firestore().doc(`tenants/${h.tenantId}/cases/${h.caseId}/agentRuns/${exec.run.id}`).get()).get('status'), 'WAITING_DOCUMENT')
    assert.equal((await firestore().collection(`tenants/${h.tenantId}/outbox`).where('type', '==', 'agent.resume').get()).size, 0)
  })
})


describeFirestore('Real AI Worker HTTP integration (synthetic model/Orch only)', () => {
  it('dispatches to an independent AI service and receives one grounded-workflow chat result through authenticated Backend APIs', async t => {
    const h = await setup(t)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(FIRESTORE_|GOOGLE_APPLICATION_CREDENTIALS|STORAGE_|DOCUMENT_STORAGE_|BACKEND_EXECUTION_SIGNING_KEY)/.test(key)))
    const ai = spawn(process.execPath, ['--import', 'tsx', 'test/helpers/runtime-http.ts'], {
      cwd: fileURLToPath(new URL('../../../ai-server/', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, AI_HTTP_FIXTURE: 'synthetic-only', AI_RUNTIME_PROJECT_ID: 'after-flow-ai-runtime-test', AI_RUNTIME_DATABASE_ID: 'ai-runtime-e2e',
        AI_RUNTIME_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST!, AI_TEST_BACKEND_ORIGIN: h.baseUrl,
        AI_TEST_BACKEND_TOKEN: incoming, AI_TEST_INGRESS_TOKEN: outgoing },
    })
    let errorOutput = ''
    ai.stderr.on('data', chunk => { errorOutput = (errorOutput + String(chunk)).slice(-4000) })
    const lines = createInterface({ input: ai.stdout })
    t.after(async () => {
      lines.close()
      if (ai.exitCode === null) {
        ai.kill('SIGTERM')
        await Promise.race([once(ai, 'exit'), delay(10000, undefined, { ref: false }).then(() => { if (ai.exitCode === null) ai.kill('SIGKILL') })])
      }
    })
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`AI fixture did not start: ${errorOutput}`)), 20000)
      lines.on('line', line => {
        try { const value = JSON.parse(line); if (value.type === 'ready' && Number.isInteger(value.port)) { clearTimeout(timer); resolve(value.port) } } catch { /* SDK log */ }
      })
      ai.once('error', error => { clearTimeout(timer); reject(error) })
      ai.once('exit', () => { clearTimeout(timer); reject(new Error(`AI fixture stopped: ${errorOutput}`)) })
    })
    const client = new ScopedHttpAgentJobClient({ baseUrl: `http://127.0.0.1:${port}`, serviceToken: outgoing, audience: 'ai-server', timeoutMs: 10000 }, h.service, h.authorization)
    const posted = await call(h.app, `/cases/${h.caseId}/messages`, jsonRequest('POST', { body: '何から始めたらいいでしょうか？' }))
    assert.equal(posted.status, 202, JSON.stringify(posted.body))
    const runId = posted.body.data.runId as string
    const run = (await readRepository().get<AgentRunEntity>(h.tenantId, { collection: collections.agentRuns, caseId: h.caseId, id: runId }))!
    const job = { eventId: run.currentJobId!, tenantId: h.tenantId, caseId: h.caseId, type: 'agent.chat_reply', payload: { runId }, attempt: 1 }
    assert.equal((await client.deliver(job)).status, 'ACCEPTED')
    assert.equal((await client.deliver(job)).status, 'ACCEPTED')
    let history: any[] = []
    for (let attempt = 0; attempt < 100; attempt++) {
      history = (await call(h.app, `/cases/${h.caseId}/messages`)).body.data
      if (history.length === 2) break
      await delay(100)
    }
    assert.equal(history.length, 2, errorOutput)
    assert.equal(history.filter(message => message.role === 'assistant').length, 1)
    assert.match(history.find(message => message.role === 'assistant').body, /対象の手続き/)
    assert.equal((await client.deliver(job)).status, 'ACCEPTED')
    assert.equal((await call(h.app, `/cases/${h.caseId}/messages`)).body.data.length, 2)
  })
})
