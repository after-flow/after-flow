import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import { ReadinessService, syncCheck } from '../src/application/operations/readiness-service.js'
import type { InternalExecutionService } from '../src/application/agent/internal-execution-service.js'
import type { ExecutionAuthorization } from '../src/application/ports/execution-authorization.js'
import { createExecutionApp } from '../src/presentation/routes/internal/v1/execution.js'
import { createReadinessApp } from '../src/presentation/routes/internal/v1/readiness.js'

/**
 * internalApp（AI実行API）とreadinessApp（運用/デプロイ専用）は同じ
 * '/internal/v1' prefixに同居する。両者が異なるアクセス制御を持つため、
 * 一方のmiddlewareがもう一方のpathまで奪って認証エラーにしないことを
 * 実際にcreateExecutionApp + createReadinessAppを組み立てて確認する。
 *
 * これはFable 5.1レビュー（#123 Fix round 1）で確認された回帰:
 * internalAppが先にmountされていると、`/internal/v1/health/ready`への
 * 正しいreadiness tokenでの要求がAI実行APIの`app.use('*', ...)`に
 * 奪われて401になっていた。
 */

const READINESS_TOKEN = 'readiness-access-token-0123456789'
const AI_TOKEN = 'ai-execution-service-token-0123456789'
const RUN_ID = 'run-1'

function fakeAuthorization(): ExecutionAuthorization {
  return {
    issue: async () => 'issued-token',
    // token引数の中身は問わない。scoping確認が目的であり、
    // 内部実行の業務ロジックそのものはinternal-execution.test.ts（Emulator）で検証する。
    verify: async () => ({
      tenantId: 't1', caseId: 'c1', runId: RUN_ID, jobId: 'job-1',
      executionAttempt: 'attempt-1', operation: 'chat_reply', scopes: ['context'],
    }),
  }
}

function buildApp() {
  const readinessApp = createReadinessApp({
    service: new ReadinessService([syncCheck('ok', () => ({ ok: true }))]),
    accessToken: READINESS_TOKEN,
  })
  // service本体は呼ばれるところまで到達すれば十分。呼ばれたらTypeErrorになるが、
  // それは401ではないことをもって「AI実行API側の認証は通過した」証拠にする。
  const internalApp = createExecutionApp({
    service: {} as unknown as InternalExecutionService,
    authorization: fakeAuthorization(),
    serviceCredential: AI_TOKEN,
  })
  return createApp({ internalApp, readinessApp })
}

function executionHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Request-Id': 'req-1',
    'X-Job-Id': 'job-1',
    'X-Execution-Attempt': 'attempt-1',
    'X-Issued-At': String(Math.floor(Date.now() / 1000) - 1),
    'X-Expires-At': String(Math.floor(Date.now() / 1000) + 60),
  }
}

describe('internal/v1: AI実行APIとreadinessの共存', () => {
  it('readinessは自身のtokenで200になる（AI実行APIが同じprefixに同居していても）', async () => {
    const app = buildApp()
    const response = await app.request('/internal/v1/health/ready', {
      headers: { Authorization: `Bearer ${READINESS_TOKEN}` },
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as any
    assert.equal(body.data.status, 'ready')
  })

  it('readinessはAI実行API側のtokenでは401のままになる', async () => {
    const app = buildApp()
    const response = await app.request('/internal/v1/health/ready', {
      headers: { Authorization: `Bearer ${AI_TOKEN}` },
    })
    assert.equal(response.status, 401)
  })

  it('AI実行APIはreadinessのtokenでは401になる（readinessが同じprefixに同居していても）', async () => {
    const app = buildApp()
    const response = await app.request(`/internal/v1/runs/${RUN_ID}/context`, {
      headers: { Authorization: `Bearer ${READINESS_TOKEN}` },
    })
    assert.equal(response.status, 401)
  })

  it('AI実行APIは自身のtokenなら認証を通過する（readinessが同じprefixに同居していても401にならない）', async () => {
    const app = buildApp()
    const response = await app.request(`/internal/v1/runs/${RUN_ID}/context`, {
      headers: executionHeaders(AI_TOKEN),
    })
    // fakeのserviceには実装が無いため後段でエラーにはなるが、
    // ここで確認したいのは「readinessのmiddlewareに奪われて401にならないこと」。
    assert.notEqual(response.status, 401)
  })

  it('AI実行APIはtoken無しでは401になる', async () => {
    const app = buildApp()
    const response = await app.request(`/internal/v1/runs/${RUN_ID}/context`)
    assert.equal(response.status, 401)
  })
})
