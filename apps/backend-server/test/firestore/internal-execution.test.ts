import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { it } from 'node:test'
import type { TestContext } from 'node:test'
import { serve } from '@hono/node-server'
import { SignJWT } from 'jose'
import { artifactEnvelopeSchema, dispatchSchema, INTERNAL_LIMITS } from '@aftercare/internal-contracts'
import type { ContextArtifact, ExecutionClaims } from '@aftercare/internal-contracts'
import { InternalExecutionService } from '../../src/application/agent/internal-execution-service.js'
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
import { describeFirestore, firestore, newTenantId, readRepository, unitOfWork } from './helpers/emulator.js'
import { startFakeAiServer } from './helpers/fake-ai-server.js'

const signingKey = 'synthetic-test-signing-key-not-a-production-secret'
const incoming = 'synthetic-incoming-service-identity'
const outgoing = 'synthetic-outgoing-service-identity'
const proof = (a: ContextArtifact) => ({ caseVersion: a.caseVersion, contextSnapshotId: a.contextSnapshotId, artifactVersion: a.artifactVersion, contentHash: a.contentHash, fencingToken: a.fencingToken })

async function setup(t: TestContext) {
  const tenantId = newTenantId(), userId = 'owner'
  await seedTenantMember(tenantId, userId)
  const app = buildApp(tenantId, userId, { connectedOperations: ['case_planning', 'task_guidance', 'chat_reply'] })
  const read = readRepository(), uow = new ContextVersionUnitOfWork(unitOfWork())
  const consent = new ConsentService(PLACEHOLDER_CATALOG, new AccessService(read), read, uow)
  const proposals = new ProposalService(new AccessService(read), read, uow, [taskProposalApplier, ...entityProposalAppliers, ...taskActionProposalAppliers])
  const service = new InternalExecutionService(read, uow, consent, new AgentResultIntake(read, uow), proposals)
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
  return { tenantId, userId, caseId, app, service, authorization, ai, client, accept, request, context, baseUrl }
}

describeFirestore('Run scoped内部API / Fake AI HTTP contract', () => {
  it('個人本文のないdispatch→context→artifact→heartbeat→progress→resultを実HTTPで検証する', async t => {
    const h = await setup(t), exec = await h.accept()
    dispatchSchema.parse(exec.dispatch)
    assert.deepEqual(Object.keys(exec.dispatch).sort(), ['jobId', 'runId', 'executionAttempt', 'operation', 'issuedAt', 'expiresAt', 'executionAuthorization'].sort())
    assert.equal(JSON.stringify(exec.dispatch).includes('架空人物'), false)
    const context = await h.context(exec)
    assert.equal(context.content.case && (context.content.case as any).deceasedName, '架空人物')
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
    const result = { ...proof(context), resultId: randomUUID(), kind: 'task_guidance', status: 'PARTIAL',
      steps: ['対象機関に確認してください'], missing: ['地域の詳細'], basis: [{ type: 'TASK', id: task.body.data.id, version: task.body.data.version }] }
    assert.equal((await h.request(exec, 'result', result)).status, 200)
    assert.equal((await h.request(exec, 'result', result)).status, 200)
    const saved = await call(h.app, `/cases/${h.caseId}/tasks/${task.body.data.id}/guidance`)
    assert.equal(saved.body.data.status, 'PARTIAL')
    assert.deepEqual(saved.body.data.missing, ['地域の詳細'])
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
})
