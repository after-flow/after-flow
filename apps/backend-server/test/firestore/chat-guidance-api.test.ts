import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { createApp } from '../../src/app.js'
import { PLACEHOLDER_CATALOG } from '../../src/domain/consent/catalog.js'
import { AgentResultIntake } from '../../src/application/chat/result-intake.js'
import type { UnitOfWork } from '../../src/application/ports/persistence.js'
import { agreeRequiredConsents, buildApp, call, jsonRequest, seedTenantMember } from './helpers/app.js'
import type { Json } from './helpers/app.js'
import { agentRunEvents, describeFirestore, firestore, newTenantId, readRepository, unitOfWork } from './helpers/emulator.js'

const SERVICE_TOKEN = 'test-backend-service-token'
const CROSS_BORDER = PLACEHOLDER_CATALOG.documents.find((d) => d.kind === 'CROSS_BORDER_AI')!

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

async function setup(
  options: { connectedOperations?: string[]; agreeExternalAi?: boolean } = {},
) {
  const tenantId = newTenantId()
  const userId = 'user-owner'
  await seedTenantMember(tenantId, userId)
  const app = buildApp(tenantId, userId, {
    connectedOperations: (options.connectedOperations ?? ['chat_reply', 'task_guidance']) as never,
    serviceToken: SERVICE_TOKEN,
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
  const caseId = created.body.data.id as string

  const task = await call(
    app,
    `/cases/${caseId}/tasks`,
    jsonRequest(
      'POST',
      { title: '架空の窓口手続き', stage: 'government', category: '行政手続き' },
      nextKey('idem-task'),
    ),
  )

  return { tenantId, userId, app, caseId, taskId: task.body.data.id as string }
}

/** AI からの結果受領を模す。実際の HTTP で内部 API を叩く。 */
async function submitResult(
  app: ReturnType<typeof createApp>,
  tenantId: string,
  caseId: string,
  body: unknown,
  options: { token?: string; audience?: string } = {},
): Promise<{ status: number; body: Json }> {
  const response = await app.request(
    `http://localhost/internal/v1/tenants/${tenantId}/cases/${caseId}/results`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.token ?? SERVICE_TOKEN}`,
        'X-Audience': options.audience ?? 'backend-server',
      },
      body: JSON.stringify(body),
    },
  )
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as Json) : {} }
}

async function currentAttemptId(tenantId: string, caseId: string, runId: string): Promise<string> {
  const run = await firestore().doc(`tenants/${tenantId}/cases/${caseId}/agentRuns/${runId}`).get()
  return run.get('currentAttemptId') as string
}

describeFirestore('チャットの受付と回答', () => {
  it('発言を保存し、回答の実行を202で受け付ける', async () => {
    const { app, caseId } = await setup()
    const response = await call(
      app,
      `/cases/${caseId}/messages`,
      jsonRequest('POST', { body: '相続の手続きを教えてください' }, nextKey('idem-message')),
    )

    assert.equal(response.status, 202)
    assert.equal(response.body.data.message.role, 'user')
    assert.equal(response.body.data.runAccepted, true)
    assert.ok(response.body.data.runId)

    // 受け付けただけで回答は入っていない。
    const history = await call(app, `/cases/${caseId}/messages`)
    assert.equal(history.body.data.length, 1)
    assert.equal(history.body.data[0].role, 'user')
  })

  it('回答が始まらない場合も発言は残し、理由を返す', async () => {
    const { app, caseId } = await setup({ connectedOperations: [] })
    const response = await call(
      app,
      `/cases/${caseId}/messages`,
      jsonRequest('POST', { body: '未接続の状態での発言' }, nextKey('idem-message')),
    )

    assert.equal(response.status, 202)
    assert.equal(response.body.data.runAccepted, false)
    assert.equal(response.body.data.reason, 'FEATURE_NOT_CONNECTED')
    // 送信が失敗したように見せない。
    const history = await call(app, `/cases/${caseId}/messages`)
    assert.equal(history.body.data.length, 1)
  })

  it('外部AI同意が無ければ発言を保存せず403で拒否する', async () => {
    const { app, caseId } = await setup({ agreeExternalAi: false })
    const response = await call(
      app,
      `/cases/${caseId}/messages`,
      jsonRequest('POST', { body: '同意前の発言' }, nextKey('idem-message')),
    )
    assert.equal(response.status, 403)
    assert.equal(response.body.error.code, 'CONSENT_REQUIRED')
    assert.equal(response.body.error.details.requiredConsent, 'CROSS_BORDER_AI')

    // 保存前に拒否しているので、発言そのものが残らない。
    const history = await call(app, `/cases/${caseId}/messages`)
    assert.equal(history.body.data.length, 0)
  })

  it('受付から回答取得までを実HTTPで通す', async () => {
    const { tenantId, app, caseId } = await setup()
    const posted = await call(
      app,
      `/cases/${caseId}/messages`,
      jsonRequest('POST', { body: '窓口の場所は？' }, nextKey('idem-message')),
    )
    const runId = posted.body.data.runId as string

    const result = await submitResult(app, tenantId, caseId, {
      kind: 'chat_reply',
      runId,
      attemptId: await currentAttemptId(tenantId, caseId, runId),
      resultId: 'result-chat-0001',
      body: '窓口は市区町村によって異なります。',
      professionalNotice: true,
    })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.data.applied, true)

    const history = await call(app, `/cases/${caseId}/messages`)
    assert.equal(history.body.data.length, 2)
    const reply = history.body.data[1]
    // 誰が書いたかを区別できる。
    assert.equal(reply.role, 'assistant')
    assert.equal(reply.professionalNotice, true)
    assert.equal(reply.agentRunId, runId)

    const run = await call(app, `/cases/${caseId}/agent-runs/${runId}`)
    assert.equal(run.body.data.status, 'SUCCEEDED')

    // chat_replyの結果も公開履歴へ記録する(Issue #125)。本文は含めない。
    const events = await agentRunEvents(tenantId, caseId, runId)
    assert.deepEqual(events.map((e) => e.kind), ['ACCEPTED', 'RESULT'])
    assert.equal(events[1]!.status, 'SUCCEEDED')
    assert.equal(events[1]!.eventId, 'result-chat-0001')
    assert.deepEqual(events[1]!.detail, { operation: 'chat_reply' })
  })

  it('同じ結果の再送で回答が重複しない', async () => {
    const { tenantId, app, caseId } = await setup()
    const posted = await call(
      app,
      `/cases/${caseId}/messages`,
      jsonRequest('POST', { body: '重複の確認' }, nextKey('idem-message')),
    )
    const runId = posted.body.data.runId as string
    const attemptId = await currentAttemptId(tenantId, caseId, runId)

    const payload = {
      kind: 'chat_reply',
      runId,
      attemptId,
      resultId: 'result-chat-0002',
      body: '同じ回答',
    }
    await submitResult(app, tenantId, caseId, payload)
    const second = await submitResult(app, tenantId, caseId, payload)

    assert.equal(second.body.data.applied, false)
    assert.equal(second.body.data.reason, 'DUPLICATE_RESULT')

    const history = await call(app, `/cases/${caseId}/messages`)
    assert.equal(history.body.data.filter((m: Json) => m.role === 'assistant').length, 1)
  })

  it('取消後に届いた結果を適用しない', async () => {
    const { tenantId, app, caseId } = await setup()
    const posted = await call(
      app,
      `/cases/${caseId}/messages`,
      jsonRequest('POST', { body: '取消の確認' }, nextKey('idem-message')),
    )
    const runId = posted.body.data.runId as string
    const attemptId = await currentAttemptId(tenantId, caseId, runId)

    const run = await call(app, `/cases/${caseId}/agent-runs/${runId}`)
    await call(
      app,
      `/cases/${caseId}/agent-runs/${runId}/cancel`,
      jsonRequest('POST', { expectedVersion: run.body.data.version }),
    )

    const result = await submitResult(app, tenantId, caseId, {
      kind: 'chat_reply',
      runId,
      attemptId,
      resultId: 'result-chat-0003',
      body: '取消後の回答',
    })
    assert.equal(result.status, 409)
    assert.equal(result.body.error.details.reason, 'RUN_ALREADY_FINISHED')

    const history = await call(app, `/cases/${caseId}/messages`)
    assert.equal(history.body.data.filter((m: Json) => m.role === 'assistant').length, 0)
  })

  it('古い試行の結果を受け付けない', async () => {
    const { tenantId, app, caseId } = await setup()
    const posted = await call(
      app,
      `/cases/${caseId}/messages`,
      jsonRequest('POST', { body: '古い試行の確認' }, nextKey('idem-message')),
    )
    const runId = posted.body.data.runId as string
    const staleAttemptId = await currentAttemptId(tenantId, caseId, runId)

    // 失敗させてから再試行し、試行の世代を進める。
    await firestore()
      .doc(`tenants/${tenantId}/cases/${caseId}/agentRuns/${runId}`)
      .update({ status: 'FAILED' })
    const run = await call(app, `/cases/${caseId}/agent-runs/${runId}`)
    await call(
      app,
      `/cases/${caseId}/agent-runs/${runId}/retry`,
      jsonRequest('POST', { expectedVersion: run.body.data.version }),
    )

    const result = await submitResult(app, tenantId, caseId, {
      kind: 'chat_reply',
      runId,
      attemptId: staleAttemptId,
      resultId: 'result-chat-0004',
      body: '古い試行の回答',
    })
    assert.equal(result.status, 409)
    assert.equal(result.body.error.details.reason, 'STALE_ATTEMPT')
  })
})

describeFirestore('手順案内', () => {
  it('未依頼と依頼済みを区別する', async () => {
    const { app, caseId, taskId } = await setup()
    const before = await call(app, `/cases/${caseId}/tasks/${taskId}/guidance`)
    assert.equal(before.status, 200)
    assert.equal(before.body.data.status, 'NOT_REQUESTED')

    const requested = await call(
      app,
      `/cases/${caseId}/tasks/${taskId}/guidance/requests`,
      jsonRequest('POST', {}, nextKey('idem-guidance')),
    )
    assert.equal(requested.status, 202)
    assert.equal(requested.body.data.status, 'RESEARCHING')
    assert.ok(requested.body.data.agentRunId)
  })

  it('案内の結果は出典と未確認項目を保持する', async () => {
    const { tenantId, app, caseId, taskId } = await setup()
    const requested = await call(
      app,
      `/cases/${caseId}/tasks/${taskId}/guidance/requests`,
      jsonRequest('POST', {}, nextKey('idem-guidance')),
    )
    const runId = requested.body.data.agentRunId as string

    const result = await submitResult(app, tenantId, caseId, {
      kind: 'task_guidance',
      runId,
      attemptId: await currentAttemptId(tenantId, caseId, runId),
      resultId: 'result-guidance-0001',
      status: 'PARTIAL',
      target: '架空市 戸籍住民課',
      where: '架空市役所 1階',
      bring: ['本人確認書類'],
      steps: ['窓口で申請書を受け取る'],
      sources: [
        { label: '架空市の案内', url: 'https://example.test/guide', checkedAt: '2026-09-20T00:00:00+09:00' },
      ],
      missing: ['夜間窓口の有無'],
    })
    assert.equal(result.status, 200, JSON.stringify(result.body))

    const guidance = await call(app, `/cases/${caseId}/tasks/${taskId}/guidance`)
    assert.equal(guidance.body.data.status, 'PARTIAL')
    assert.equal(guidance.body.data.sources.length, 1)
    assert.equal(guidance.body.data.sources[0].checkedAt, '2026-09-20T00:00:00+09:00')
    // 調べきれなかった項目を落とさない。
    assert.deepEqual(guidance.body.data.missing, ['夜間窓口の有無'])

    // 部分成功を成功に丸めない。
    const run = await call(app, `/cases/${caseId}/agent-runs/${runId}`)
    assert.equal(run.body.data.status, 'NEEDS_ATTENTION')

    // task_guidanceの結果も公開履歴へ記録する(Issue #125)。出典・手順本文は含めない。
    const events = await agentRunEvents(tenantId, caseId, runId)
    const resultEvent = events.find((e) => e.kind === 'RESULT')
    assert.ok(resultEvent, 'RESULTイベントが記録されていない')
    assert.equal(resultEvent!.status, 'NEEDS_ATTENTION')
    assert.equal(resultEvent!.eventId, 'result-guidance-0001')
    assert.deepEqual(resultEvent!.detail, { operation: 'task_guidance', outcomeStatus: 'PARTIAL' })
  })

  it('待機を失敗にしない', async () => {
    const { tenantId, app, caseId, taskId } = await setup()
    const requested = await call(
      app,
      `/cases/${caseId}/tasks/${taskId}/guidance/requests`,
      jsonRequest('POST', {}, nextKey('idem-guidance')),
    )
    const runId = requested.body.data.agentRunId as string

    await submitResult(app, tenantId, caseId, {
      kind: 'task_guidance',
      runId,
      attemptId: await currentAttemptId(tenantId, caseId, runId),
      resultId: 'result-guidance-0002',
      status: 'WAITING',
    })

    const run = await call(app, `/cases/${caseId}/agent-runs/${runId}`)
    assert.equal(run.body.data.status, 'WAITING_DOCUMENT')
    assert.equal(run.body.data.waiting, true)
  })

  it('失敗の理由を保持する', async () => {
    const { tenantId, app, caseId, taskId } = await setup()
    const requested = await call(
      app,
      `/cases/${caseId}/tasks/${taskId}/guidance/requests`,
      jsonRequest('POST', {}, nextKey('idem-guidance')),
    )
    const runId = requested.body.data.agentRunId as string

    await submitResult(app, tenantId, caseId, {
      kind: 'task_guidance',
      runId,
      attemptId: await currentAttemptId(tenantId, caseId, runId),
      resultId: 'result-guidance-0003',
      status: 'FAILED',
      failureReason: '公式の案内を確認できませんでした。',
    })

    const guidance = await call(app, `/cases/${caseId}/tasks/${taskId}/guidance`)
    assert.equal(guidance.body.data.status, 'FAILED')
    assert.equal(guidance.body.data.failureReason, '公式の案内を確認できませんでした。')
    assert.deepEqual(guidance.body.data.steps, [])
  })

  it('案内の結果だけでは手続きを完了しない', async () => {
    const { tenantId, app, caseId, taskId } = await setup()
    const requested = await call(
      app,
      `/cases/${caseId}/tasks/${taskId}/guidance/requests`,
      jsonRequest('POST', {}, nextKey('idem-guidance')),
    )
    const runId = requested.body.data.agentRunId as string

    await submitResult(app, tenantId, caseId, {
      kind: 'task_guidance',
      runId,
      attemptId: await currentAttemptId(tenantId, caseId, runId),
      resultId: 'result-guidance-0004',
      status: 'COMPLETED',
      steps: ['窓口で手続きする'],
    })

    const task = await call(app, `/cases/${caseId}/tasks/${taskId}`)
    // 案内は説明であって、正式な状態を変えない。
    assert.equal(task.body.data.status, 'NOT_STARTED')

    const proposals = await call(app, `/cases/${caseId}/proposals`)
    assert.equal(proposals.body.data.length, 0, '案内だけで提案を作らない')
  })

  it('別の実行の種類の結果を受け付けない', async () => {
    const { tenantId, app, caseId, taskId } = await setup()
    const requested = await call(
      app,
      `/cases/${caseId}/tasks/${taskId}/guidance/requests`,
      jsonRequest('POST', {}, nextKey('idem-guidance')),
    )
    const runId = requested.body.data.agentRunId as string

    const result = await submitResult(app, tenantId, caseId, {
      kind: 'chat_reply',
      runId,
      attemptId: await currentAttemptId(tenantId, caseId, runId),
      resultId: 'result-mismatch-0001',
      body: '種類の違う結果',
    })
    assert.equal(result.status, 409)
    assert.equal(result.body.error.details.reason, 'OPERATION_MISMATCH')
  })
})

describeFirestore('内部APIの認証と境界', () => {
  it('サービストークンが無い要求を拒否する', async () => {
    const { tenantId, app, caseId } = await setup()
    const result = await submitResult(
      app,
      tenantId,
      caseId,
      { kind: 'chat_reply', runId: 'x', attemptId: 'a', resultId: 'r', body: 'x' },
      { token: 'wrong-token' },
    )
    assert.equal(result.status, 401)
  })

  it('宛先違いの要求を拒否する', async () => {
    const { tenantId, app, caseId } = await setup()
    const result = await submitResult(
      app,
      tenantId,
      caseId,
      { kind: 'chat_reply', runId: 'x', attemptId: 'a', resultId: 'r', body: 'x' },
      { audience: 'another-service' },
    )
    assert.equal(result.status, 401)
  })

  it('別Caseの実行へ結果を差し込めない', async () => {
    const owner = await setup()
    const posted = await call(
      owner.app,
      `/cases/${owner.caseId}/messages`,
      jsonRequest('POST', { body: '境界の確認' }, nextKey('idem-message')),
    )
    const runId = posted.body.data.runId as string

    const another = await call(
      owner.app,
      '/cases',
      jsonRequest('POST', caseBody, nextKey('idem-case')),
    )

    const result = await submitResult(owner.app, owner.tenantId, another.body.data.id, {
      kind: 'chat_reply',
      runId,
      attemptId: await currentAttemptId(owner.tenantId, owner.caseId, runId),
      resultId: 'result-cross-0001',
      body: '別Caseへの差し込み',
    })
    assert.equal(result.status, 404)
  })

  it('サービストークンが未設定なら内部APIを公開しない', async () => {
    const tenantId = newTenantId()
    await seedTenantMember(tenantId, 'user-owner')
    const app = buildApp(tenantId, 'user-owner')

    const response = await app.request(
      `http://localhost/internal/v1/tenants/${tenantId}/cases/x/results`,
      { method: 'POST' },
    )
    assert.equal(response.status, 404)
  })
})

describeFirestore('結果受領の競合と案内再依頼', () => {
  for (const kind of ['chat_reply', 'task_guidance'] as const) {
    for (const change of ['cancel', 'retry'] as const) {
      it(`${kind}: 事前検証後の${change}を保存Transactionで再検証する`, async () => {
        const { tenantId, app, caseId, taskId } = await setup()
        const requested = kind === 'chat_reply'
          ? await call(app, `/cases/${caseId}/messages`, jsonRequest('POST', { body: '競合試験' }))
          : await call(app, `/cases/${caseId}/tasks/${taskId}/guidance/requests`, jsonRequest('POST', {}))
        const runId = (kind === 'chat_reply' ? requested.body.data.runId : requested.body.data.agentRunId) as string
        const attemptId = await currentAttemptId(tenantId, caseId, runId)
        const interleaved: UnitOfWork = {
          async run(context, fn) {
            // 外側のverifyRunが済み、保存Transactionに入る直前に別要求が確定する。
            await firestore().doc(`tenants/${tenantId}/cases/${caseId}/agentRuns/${runId}`)
              .update({ status: change === 'cancel' ? 'CANCELLED' : 'QUEUED',
                currentAttemptId: 'new-attempt', version: 2 })
            return unitOfWork().run(context, fn)
          },
        }
        const intake = new AgentResultIntake(readRepository(), interleaved)
        const envelope = { runId, attemptId, resultId: 'racing-result' }
        await assert.rejects(
          kind === 'chat_reply'
            ? intake.submitChatReply(tenantId, caseId, { ...envelope, body: '遅着' })
            : intake.submitGuidanceResult(tenantId, caseId, { ...envelope, status: 'COMPLETED' }),
          (error: any) => error.details.reason === (change === 'cancel' ? 'RUN_ALREADY_FINISHED' : 'STALE_ATTEMPT'),
        )
        const run = await call(app, `/cases/${caseId}/agent-runs/${runId}`)
        assert.notEqual(run.body.data.status, 'SUCCEEDED')
        const replies = await call(app, `/cases/${caseId}/messages`)
        assert.equal(replies.body.data.filter((m: Json) => m.role === 'assistant').length, 0)
        const guidance = await call(app, `/cases/${caseId}/tasks/${taskId}/guidance`)
        assert.notEqual(guidance.body.data.status, 'COMPLETED')
      })
    }
  }

  it('再依頼後に古いRunの結果と受付の再送が最新の案内を上書きしない', async () => {
    const { tenantId, app, caseId, taskId } = await setup()
    const path = `/cases/${caseId}/tasks/${taskId}/guidance/requests`
    const firstRequest = jsonRequest('POST', {}, nextKey('first-guidance'))
    const first = await call(app, path, firstRequest)
    const oldRunId = first.body.data.agentRunId as string
    const second = await call(app, path, jsonRequest('POST', {}))
    const runId = second.body.data.agentRunId as string
    const late = await submitResult(app, tenantId, caseId, {
      kind: 'task_guidance', runId: oldRunId,
      attemptId: await currentAttemptId(tenantId, caseId, oldRunId),
      resultId: 'late-guidance', status: 'COMPLETED',
    })
    assert.equal(late.status, 409)
    assert.equal(late.body.error.details.reason, 'GUIDANCE_SUPERSEDED')
    await call(app, path, firstRequest)
    const guidance = await call(app, `/cases/${caseId}/tasks/${taskId}/guidance`)
    assert.equal(guidance.body.data.agentRunId, runId)
    const result = await submitResult(app, tenantId, caseId, {
      kind: 'task_guidance', runId, attemptId: await currentAttemptId(tenantId, caseId, runId),
      resultId: 'current-guidance', status: 'COMPLETED',
    })
    assert.equal(result.body.data.applied, true)
  })

  it('部分結果からのretryと完了後の新しい依頼を受け付ける', async () => {
    const { tenantId, app, caseId, taskId } = await setup()
    const path = `/cases/${caseId}/tasks/${taskId}/guidance/requests`
    const requested = await call(app, path, jsonRequest('POST', {}))
    const runId = requested.body.data.agentRunId as string
    await submitResult(app, tenantId, caseId, {
      kind: 'task_guidance', runId, attemptId: await currentAttemptId(tenantId, caseId, runId),
      resultId: 'partial', status: 'PARTIAL', steps: ['古い手順'],
    })
    const run = await call(app, `/cases/${caseId}/agent-runs/${runId}`)
    const retried = await call(app, `/cases/${caseId}/agent-runs/${runId}/retry`,
      jsonRequest('POST', { expectedVersion: run.body.data.version }))
    assert.equal(retried.status, 202)
    const result = await submitResult(app, tenantId, caseId, {
      kind: 'task_guidance', runId, attemptId: await currentAttemptId(tenantId, caseId, runId),
      resultId: 'retry-completed', status: 'COMPLETED', steps: ['新しい手順'],
    })
    assert.equal(result.body.data.applied, true)
    const next = await call(app, path, jsonRequest('POST', {}))
    assert.deepEqual(next.body.data.steps, [])
    const nextId = next.body.data.agentRunId as string
    const nextResult = await submitResult(app, tenantId, caseId, {
      kind: 'task_guidance', runId: nextId, attemptId: await currentAttemptId(tenantId, caseId, nextId),
      resultId: 'new-request-completed', status: 'COMPLETED',
    })
    assert.equal(nextResult.body.data.applied, true)
  })
})
