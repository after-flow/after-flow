import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMiddleware } from 'hono/factory'
import { AiCapabilityService } from '../src/application/agent/ai-capability-service.js'
import { createApp } from '../src/app.js'
import type { AgentOperation } from '../src/domain/agent/agent-run.js'
import type { AppEnv } from '../src/presentation/http/context.js'
import { createAiCapabilityRoutes } from '../src/presentation/routes/public/v1/ai-capabilities.js'

function buildApp(connectedOperations: AgentOperation[], options: { authenticated?: boolean } = {}) {
  const authenticated = options.authenticated ?? true
  return createApp({
    routes: createAiCapabilityRoutes(new AiCapabilityService(new Set(connectedOperations))),
    authentication: createMiddleware<AppEnv>(async (c, next) => {
      if (authenticated) c.set('user', { userId: 'user-1', tenantId: 'tenant-1' })
      await next()
    }),
  })
}

async function get(app: ReturnType<typeof createApp>) {
  const response = await app.request('http://localhost/api/v1/ai/capabilities')
  const raw = await response.text()
  return { status: response.status, raw, body: raw ? (JSON.parse(raw) as Record<string, any>) : {} }
}

describe('GET /ai/capabilities', () => {
  it('task_guidanceだけ接続済みなら task_guidance のみ利用可', async () => {
    const { status, body, raw } = await get(buildApp(['task_guidance']))
    assert.equal(status, 200)
    assert.deepEqual(body.data.features.task_guidance, { available: true, reason: null })
    assert.deepEqual(body.data.features.ai_chat, { available: false, reason: 'FEATURE_NOT_CONNECTED' })
    assert.equal(raw.includes('chat_reply'), false)
  })

  it('chat_replyだけ接続済みなら ai_chat のみ利用可（内部operation名は漏らさない）', async () => {
    const { status, body, raw } = await get(buildApp(['chat_reply']))
    assert.equal(status, 200)
    assert.deepEqual(body.data.features.task_guidance, { available: false, reason: 'FEATURE_NOT_CONNECTED' })
    assert.deepEqual(body.data.features.ai_chat, { available: true, reason: null })
    assert.equal(raw.includes('chat_reply'), false)
  })

  it('両方接続済みなら両方利用可', async () => {
    const { body, raw } = await get(buildApp(['task_guidance', 'chat_reply']))
    assert.equal(body.data.features.task_guidance.available, true)
    assert.equal(body.data.features.ai_chat.available, true)
    assert.equal(raw.includes('chat_reply'), false)
  })

  it('未接続（AI Server設定不足でconnectedOperationsが空になる場合も含む）なら両方利用不可', async () => {
    // composition.ts の connectedOperations(env) は設定不足なら空集合を返す。
    // この Service は結果の集合だけを受け取るため、空集合になった理由を問わず扱いは同じ。
    const { body, raw } = await get(buildApp([]))
    assert.equal(body.data.features.task_guidance.available, false)
    assert.equal(body.data.features.ai_chat.available, false)
    assert.equal(raw.includes('chat_reply'), false)
  })

  it('未認証は401', async () => {
    const { status } = await get(buildApp(['task_guidance', 'chat_reply'], { authenticated: false }))
    assert.equal(status, 401)
  })
})
