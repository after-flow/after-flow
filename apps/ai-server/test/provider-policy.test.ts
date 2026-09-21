import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Agent } from '@mastra/core/agent'
import { createAuthorizedModels, assertAuthorizedModelSet } from '../src/infrastructure/mastra/authorized-models.js'
import type { ProviderMetric } from '../src/infrastructure/mastra/authorized-models.js'
import { assertProviderAllowed } from '../src/orchestration/models/policy.js'
import type { ProviderPolicy, ProviderGrant, RouteRequest } from '../src/orchestration/models/policy.js'
import { scriptedModel } from './helpers/scripted-model.js'
import type { BudgetCharge } from '../src/application/execution/contracts.js'

const expiry = () => new Date(Date.now() + 60000).toISOString()
const policy = (id: string): ProviderPolicy => ({ id, revision: 'v1', sdkProvider: id, modelId: 'scripted', roles: ['core', 'research'], dataClasses: ['minimized_case', 'public_research'],
  approvedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: expiry(), reviewReference: 'synthetic-policy-only', trainingUse: false, retentionDays: 0,
  capabilities: { tools: true, structuredOutput: true, japanese: true }, currency: 'USD', maxInputTokens: 1000, maxOutputTokens: 100,
  inputMicrosPerToken: 1, outputMicrosPerToken: 2 })
const grant = (): ProviderGrant => ({ revision: 'consent-v1', providerPolicyIds: ['first', 'second'], dataClasses: ['minimized_case', 'public_research'], expiresAt: expiry(), maxRetentionDays: 0 })
const request: RouteRequest = { requestId: 'request-one', operation: 'task_guidance', role: 'core', dataClass: 'minimized_case', policyIds: ['first', 'second'] }

async function setup(statusCode: number, revoke = false) {
  const first = scriptedModel([]); const second = scriptedModel([{ text: 'fixture-answer' }])
  const firstModel = { ...first.model, provider: 'first' }; const secondModel = { ...second.model, provider: 'second' }
  let attempts = 0; let revoked = false
  const unavailable = async () => { attempts++; if (revoke) revoked = true; throw Object.assign(new Error('secret-provider-body'), { statusCode }) }
  firstModel.doStream = unavailable; firstModel.doGenerate = unavailable
  const charges: BudgetCharge[] = []; const metrics: ProviderMetric[] = []
  const result = await createAuthorizedModels({ request, policies: [policy('first'), policy('second')], signal: new AbortController().signal,
    router: { route: async input => ({ requestId: input.requestId, evidenceId: 'fixture-orch-evidence', policyIds: ['first', 'second'], expiresAt: expiry() }) },
    grant: async () => ({ ...grant(), providerPolicyIds: revoked ? [] : ['first', 'second'] }), models: new Map([['first', firstModel], ['second', secondModel]]),
    charge: async value => { charges.push(value) }, record: async metric => { metrics.push(metric) },
  })
  const agent = new Agent({ id: 'policy-test', name: 'policy', instructions: 'fixture', model: result.models, defaultOptions: { maxSteps: 1, modelSettings: { maxRetries: 0 } } })
  const response = await agent.generate('fixture').catch(() => null)
  return { attempts, second, charges, metrics, response }
}

test('native Mastra fallback charges each actual provider attempt and succeeds on transient failure', async () => {
  const result = await setup(503)
  assert.equal(result.attempts, 1); assert.equal(result.second.calls.length, 1)
  assert.equal(result.response?.text, 'fixture-answer')
  assert.equal(result.charges.length, 2)
  assert.equal(result.metrics.length, 2)
  assert.equal(result.metrics[0]?.failure, 'TRANSIENT')
  assert.equal(JSON.stringify(result.metrics).includes('secret-provider-body'), false)
})

test('permanent errors and consent withdrawal prevent fallback network I/O', async () => {
  for (const [status, revoke] of [[403, false], [503, true]] as const) {
    const result = await setup(status, revoke)
    assert.equal(result.attempts, 1); assert.equal(result.second.calls.length, 0)
    assert.equal(result.charges.length, 1)
  }
})

test('policy rejects changed recipient, expired review, excessive retention and wrong Orch selection', async () => {
  assert.throws(() => assertProviderAllowed(policy('first'), { ...grant(), providerPolicyIds: ['other'] }, 'core', 'minimized_case'), /authorize/)
  assert.throws(() => assertProviderAllowed({ ...policy('first'), expiresAt: '2000-01-01T00:00:00Z' }, grant(), 'core', 'minimized_case'), /authorize/)
  assert.throws(() => assertProviderAllowed({ ...policy('first'), retentionDays: 1 }, grant(), 'core', 'minimized_case'), /authorize/)
  await assert.rejects(createAuthorizedModels({ request, policies: [policy('first'), policy('second')], signal: new AbortController().signal,
    router: { route: async () => ({ requestId: 'different-request', evidenceId: 'unbound', policyIds: ['first'], expiresAt: expiry() }) },
    grant: async () => grant(), models: new Map(), charge: async () => {}, record: async () => {},
  }), /not authorized/)
})

test('a partial provider stream prevents a second provider from receiving the prompt', async () => {
  const first = scriptedModel([]); const second = scriptedModel([{ text: 'must-not-run' }])
  const firstModel = { ...first.model, provider: 'first' }; const secondModel = { ...second.model, provider: 'second' }
  let index = 0
  firstModel.doStream = async () => ({ stream: new ReadableStream({ pull(controller) {
    if (index++ === 0) controller.enqueue({ type: 'text-delta', id: 'part', delta: 'partial' })
    else controller.error(Object.assign(new Error('private-error'), { statusCode: 503 }))
  } }) })
  const result = await createAuthorizedModels({ request, policies: [policy('first'), policy('second')], signal: new AbortController().signal,
    router: { route: async input => ({ requestId: input.requestId, evidenceId: 'fixture-only', policyIds: ['first', 'second'], expiresAt: expiry() }) },
    grant: async () => grant(), models: new Map([['first', firstModel], ['second', secondModel]]), charge: async () => {}, record: async () => {},
  })
  const model1 = result.models[0]!.model; const model2 = result.models[1]!.model
  if (typeof model1 !== 'object' || !('doStream' in model1) || model1.specificationVersion !== 'v2' ||
      typeof model2 !== 'object' || !('doStream' in model2) || model2.specificationVersion !== 'v2') assert.fail('Expected concrete v2 adapters')
  const stream = await model1.doStream({ prompt: [] })
  const reader = stream.stream.getReader()
  assert.equal((await reader.read()).value?.type, 'text-delta')
  await assert.rejects(reader.read(), /TRANSIENT/)
  await assert.rejects(Promise.resolve(model2.doStream({ prompt: [] })))
  assert.equal(second.calls.length, 0)
})


test('a provider adapter is bound to its execution guard, operation and agent role', async () => {
  const model = { ...scriptedModel([]).model, provider: 'first' }
  const charge = async () => {}
  const result = await createAuthorizedModels({ request: { ...request, policyIds: ['first'] }, policies: [policy('first')], signal: new AbortController().signal,
    router: { route: async input => ({ requestId: input.requestId, evidenceId: 'fixture-only', policyIds: ['first'], expiresAt: expiry() }) },
    grant: async () => grant(), models: new Map([['first', model]]), charge, record: async () => {},
  })
  const binding = { charge, role: 'core' as const, operation: 'task_guidance' as const }
  assert.doesNotThrow(() => assertAuthorizedModelSet(result.models, binding))
  assert.throws(() => assertAuthorizedModelSet(result.models, { ...binding, charge: async () => {} }), /match this execution/)
  assert.throws(() => assertAuthorizedModelSet(result.models, { ...binding, role: 'research' }), /match this execution/)
  assert.throws(() => assertAuthorizedModelSet(result.models, { ...binding, operation: 'chat_reply' }), /match this execution/)
})
