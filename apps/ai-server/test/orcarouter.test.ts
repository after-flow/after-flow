import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core/mastra'
import { createOrcaModel, orcaReceipt, orcaSdkProvider, ORCA_BASE_URL } from '../src/infrastructure/orcarouter/models.js'
import { readOrcaApiKey } from '../src/infrastructure/orcarouter/environment.js'
import { createAuthorizedOrcaModels } from '../src/infrastructure/mastra/authorized-models.js'
import type { ProviderMetric } from '../src/infrastructure/mastra/authorized-models.js'
import type { ProviderPolicy, ProviderGrant, RouteRequest } from '../src/orchestration/models/policy.js'
import type { BudgetCharge } from '../src/application/execution/contracts.js'

const modelId = 'openai/gpt-4o-mini', secondId = 'google/gemini-2.5-flash'
const key = 'synthetic-key-never-live'
const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'synthetic' }] }]
const headers = { 'Content-Type': 'application/json', 'X-Orca-Request-Id': '20260921-synthetic' }
const completion = () => new Response(JSON.stringify({ id: 'chat-synthetic', model: 'gpt-4o-mini-2024-07-18', created: 1,
  choices: [{ index: 0, message: { role: 'assistant', content: '接続確認' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost_usd: 0.000002 } }), { headers })
const sse = () => new Response([
  { id: 'chat-synthetic', model: 'gpt-4o-mini', created: 1, choices: [{ index: 0, delta: { role: 'assistant', content: '接続確認' }, finish_reason: null }] },
  { id: 'chat-synthetic', model: 'gpt-4o-mini', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost_usd: 0.000002 } },
].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { ...headers, 'Content-Type': 'text/event-stream' } })
const expiry = () => new Date(Date.now() + 60000).toISOString()
function policy(id: string, model: string): ProviderPolicy {
  return { id, revision: 'v1', sdkProvider: orcaSdkProvider(model), modelId: model, roles: ['core', 'research'], dataClasses: ['minimized_case', 'public_research'],
    approvedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: expiry(), reviewReference: 'synthetic-only-not-a-production-review', trainingUse: false, retentionDays: 0,
    capabilities: { tools: true, structuredOutput: true, japanese: true }, currency: 'USD', maxInputTokens: 1000, maxOutputTokens: 100, inputMicrosPerToken: 1, outputMicrosPerToken: 2 }
}
const request: RouteRequest = { requestId: 'synthetic-run', operation: 'chat_reply', role: 'core', dataClass: 'minimized_case', policyIds: ['first', 'second'] }
const grant = (): ProviderGrant => ({ revision: 'synthetic', providerPolicyIds: ['first', 'second'], dataClasses: ['minimized_case', 'public_research'], expiresAt: expiry(), maxRetentionDays: 0 })
function options() {
  return { request, policies: [policy('first', modelId), policy('second', secondId)], signal: new AbortController().signal,
    models: new Map([['first', createOrcaModel({ apiKey: key, modelId })], ['second', createOrcaModel({ apiKey: key, modelId: secondId })]]),
    grant: async () => grant(), charge: async (_value: BudgetCharge) => {}, record: async (_metric: ProviderMetric) => {} }
}

test('real SDK pins gateway, credentials and model and extracts gateway identity and optional cost', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, `${ORCA_BASE_URL}/chat/completions`)
    assert.equal(init.redirect, 'error')
    const h = new Headers(init.headers)
    assert.equal(h.get('authorization'), `Bearer ${key}`)
    assert.equal(h.get('x-orcarouter-include-cost'), 'true')
    const body = JSON.parse(String(init.body))
    assert.equal(body.model, modelId)
    assert.equal(body.max_tokens, 8)
    return completion()
  })
  const model = createOrcaModel({ apiKey: key, modelId })
  assert.equal(model.provider, 'orcarouter-openai.chat')
  const result = await model.doGenerate({ prompt, maxOutputTokens: 8, headers: { Authorization: 'Bearer attacker' } })
  assert.equal(result.content[0]?.type, 'text')
  assert.deepEqual(orcaReceipt(result.response?.headers, modelId, result.providerMetadata), {
    gateway: 'orcarouter', requestId: '20260921-synthetic', requestedModel: modelId, resolvedModel: null, fallbackModel: null, costUsd: 0.000002,
  })
  assert.equal(orcaReceipt(headers, modelId).costUsd, null)
})

test('unreviewed overrides, named routers, missing receipts and unexpected fallback are rejected', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return completion() })
  for (const id of ['auto', 'orcarouter/auto', 'orcarouter/my-router', 'https://evil.invalid/model']) assert.throws(() => createOrcaModel({ apiKey: key, modelId: id }))
  assert.throws(() => createOrcaModel({ apiKey: '', modelId }), /missing or invalid/)
  const model = createOrcaModel({ apiKey: key, modelId })
  for (const override of [{ model: secondId }, { models: [secondId] }, { extra_body: { provider: 'other' } }] as Record<string, string | string[] | Record<string, string>>[]) {
    await assert.rejects(Promise.resolve(model.doGenerate({ prompt, providerOptions: { 'orcarouter-openai': override } })), /Unapproved/)
  }
  assert.equal(calls, 0)
  assert.throws(() => orcaReceipt({}, modelId), /identity/)
  assert.throws(() => orcaReceipt({ ...headers, 'X-Orca-Fallback-Model': secondId }, modelId), /unexpected model/)
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
  await assert.rejects(Promise.resolve(model.doGenerate({ prompt })), /identity/)
})

test('SDK failures redact upstream bodies and cancellation reaches the gateway transport', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(`secret echoed ${key}`, { status: 401 }))
  const model = createOrcaModel({ apiKey: key, modelId })
  await assert.rejects(Promise.resolve(model.doGenerate({ prompt })), (error: unknown) => {
    assert.ok(!JSON.stringify(error).includes(key))
    assert.ok(!String(error).includes(key))
    return true
  })
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.ok(init.signal)
    controller.abort()
    assert.equal(init.signal.aborted, true)
    throw new Error(`do not expose ${key}`)
  })
  await assert.rejects(Promise.resolve(model.doGenerate({ prompt, abortSignal: controller.signal })), /transport interrupted or unavailable/)
})

test('Mastra fallback checks fresh consent and budget for each actual Orca call', async t => {
  for (const status of [503, 429, 401, 402, 403]) {
    let calls = 0, grants = 0
    const charges: BudgetCharge[] = [], metrics: ProviderMetric[] = []
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      calls++
      assert.equal(charges.length, calls)
      assert.equal(grants, calls + 1)
      assert.equal(JSON.parse(String(init.body)).model, calls === 1 ? modelId : secondId)
      return calls === 1 ? new Response('redacted', { status }) : JSON.parse(String(init.body)).stream ? sse() : completion()
    })
    const selected = await createAuthorizedOrcaModels({ ...options(), grant: async () => { grants++; return grant() },
      charge: async value => { charges.push(value) }, record: async value => { metrics.push(value) } })
    const probe = new Agent({ id: 'gateway-fallback', name: 'probe', instructions: 'synthetic', model: selected.models,
      defaultOptions: { maxSteps: 1, modelSettings: { maxRetries: 0 } } })
    const agent = new Mastra({ agents: { probe }, logger: false }).getAgent('probe')
    const result = await agent.generate('synthetic').catch(() => null)
    const transient = status === 503 || status === 429
    assert.equal(calls, transient ? 2 : 1)
    assert.equal(result?.text ?? null, transient ? '接続確認' : null)
    assert.ok(metrics.every(metric => metric.routeEvidenceId === null && metric.selectionId?.startsWith('orca-policy-')))
    if (transient) {
      assert.equal(metrics[1]?.gateway?.requestId, '20260921-synthetic')
      assert.equal(metrics[1]?.gateway?.costUsd, 0.000002)
      assert.equal(metrics[1]?.inputTokens, 2)
      assert.equal(metrics[1]?.gateway?.requestedModel, secondId)
    }
    t.mock.restoreAll()
  }
})

test('revoked consent prevents fallback and direct-provider models cannot enter the Orca path', async t => {
  const o = options()
  let calls = 0, revoked = false
  t.mock.method(globalThis, 'fetch', async () => { calls++; revoked = true; return new Response('unavailable', { status: 503 }) })
  const selected = await createAuthorizedOrcaModels({ ...o, grant: async () => ({ ...grant(), providerPolicyIds: revoked ? [] : ['first', 'second'] }) })
  const first = selected.models[0]!.model as ReturnType<typeof createOrcaModel>
  const second = selected.models[1]!.model as ReturnType<typeof createOrcaModel>
  await assert.rejects(Promise.resolve(first.doGenerate({ prompt })), /TRANSIENT/)
  await assert.rejects(Promise.resolve(second.doGenerate({ prompt })), /INTERRUPTED/)
  assert.equal(calls, 1)
  o.models.set('first', { ...o.models.get('first')! } as ReturnType<typeof createOrcaModel>)
  await assert.rejects(createAuthorizedOrcaModels(o), /fixed-model/)
  await assert.rejects(createAuthorizedOrcaModels({ ...options(), request: { ...request, role: 'research' } }), /private case/)
})

test('env loader selects only the key and honors explicit environment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-env-'))
  try {
    const path = join(dir, '.env')
    await writeFile(path, `ORCAROUTER_API_KEY="${key}"\nBUSINESS_STORAGE_SECRET=backend-only\n`, { mode: 0o600 })
    const env = {}
    assert.equal(await readOrcaApiKey(path, env), key)
    assert.deepEqual(env, {})
    assert.equal(await readOrcaApiKey('/missing', { ORCAROUTER_API_KEY: 'explicit' }), 'explicit')
    await assert.rejects(readOrcaApiKey(path, { ORCAROUTER_API_KEY: '' }), /missing or invalid/)
    await assert.rejects(readOrcaApiKey('/missing', {}), /Cannot read/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})


test('partial SSE failure prevents another gateway attempt; successful SSE records usage and receipt', async t => {
  for (const broken of [false, true]) {
    let calls = 0
    const metrics: ProviderMetric[] = []
    t.mock.method(globalThis, 'fetch', async () => {
      calls++
      if (!broken) return sse()
      const chunk = { id: 'synthetic', model: 'gpt-4o-mini', created: 1, choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: invalid-json\n\n`, { headers: { ...headers, 'Content-Type': 'text/event-stream' } })
    })
    const selected = await createAuthorizedOrcaModels({ ...options(), record: async metric => { metrics.push(metric) } })
    const first = selected.models[0]!.model as ReturnType<typeof createOrcaModel>
    const second = selected.models[1]!.model as ReturnType<typeof createOrcaModel>
    const result = await first.doStream({ prompt })
    let text = ''
    const consume = async () => { for await (const chunk of result.stream) if (chunk.type === 'text-delta') text += chunk.delta }
    if (broken) {
      await assert.rejects(consume(), /PERMANENT/)
      assert.equal(text, 'partial')
      await assert.rejects(Promise.resolve(second.doGenerate({ prompt })))
    } else {
      await consume()
      assert.equal(text, '接続確認')
      assert.equal(metrics[0]?.gateway?.costUsd, 0.000002)
      assert.equal(metrics[0]?.outputTokens, 3)
    }
    assert.equal(calls, 1)
    t.mock.restoreAll()
  }
})
