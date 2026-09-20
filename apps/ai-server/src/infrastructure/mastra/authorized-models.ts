import type { MastraModelConfig } from '@mastra/core/llm'
import type { ModelWithRetries } from '@mastra/core/agent'
import { assertProviderAllowed, inferenceReservation, providerPolicySchema, routeDecisionSchema, routeRequestSchema } from '../../orchestration/models/policy.js'
import type { OrchRouter, ProviderGrant, ProviderPolicy, RouteRequest } from '../../orchestration/models/policy.js'
import type { BudgetCharge } from '../../application/execution/contracts.js'

type Model = Extract<MastraModelConfig, { specificationVersion: 'v2'; doGenerate: (...args: never[]) => PromiseLike<{ content: unknown[] }> }>
export interface ProviderMetric {
  policyId: string; policyRevision: string; routeEvidenceId: string; role: 'core' | 'research'
  status: 'success' | 'failure'; durationMs: number; inputTokens: number | null; outputTokens: number | null
  failure: 'TRANSIENT' | 'PERMANENT' | 'INTERRUPTED' | null
}
export class ProviderFailure extends Error {
  constructor(readonly classification: 'TRANSIENT' | 'PERMANENT' | 'INTERRUPTED') { super(`Provider request failed: ${classification}`) }
}
function classify(error: unknown): ProviderFailure['classification'] {
  if (error && typeof error === 'object' && 'statusCode' in error &&
    (error.statusCode === 429 || (typeof error.statusCode === 'number' && error.statusCode >= 500 && error.statusCode <= 599))) return 'TRANSIENT'
  return 'PERMANENT'
}

/** Native Mastra fallback list; every actual SDK invocation rechecks authority and reserves its own budget. */
export async function createAuthorizedModels(options: {
  request: RouteRequest; policies: readonly ProviderPolicy[]; router: OrchRouter; signal: AbortSignal
  /** Must resolve current Backend-authorized consent before each transfer, never an LLM-supplied grant. */
  grant(): Promise<ProviderGrant>
  models: ReadonlyMap<string, Model>
  charge(value: BudgetCharge): Promise<void>
  record(metric: ProviderMetric): Promise<void>
}): Promise<{ models: ModelWithRetries[]; evidenceId: string }> {
  const request = routeRequestSchema.parse(options.request)
  if (request.role === 'research' && request.dataClass !== 'public_research') throw new Error('Research cannot receive private case data')
  const policies = new Map(options.policies.map(value => { const policy = providerPolicySchema.parse(value); return [policy.id, policy] }))
  if (policies.size !== options.policies.length) throw new Error('Duplicate model policy')
  const grant = await options.grant()
  for (const id of request.policyIds) {
    const policy = policies.get(id)
    if (!policy) throw new Error('Unknown provider policy')
    assertProviderAllowed(policy, grant, request.role, request.dataClass)
  }
  options.signal.throwIfAborted()
  const decision = routeDecisionSchema.parse(await options.router.route(request, options.signal))
  if (decision.requestId !== request.requestId || Date.parse(decision.expiresAt) <= Date.now() ||
    new Set(decision.policyIds).size !== decision.policyIds.length || decision.policyIds.some(id => !request.policyIds.includes(id))) throw new Error('Orch routing result is not authorized')
  const selected = decision.policyIds.map(id => policies.get(id)!)
  if (new Set(selected.map(policy => policy.currency)).size !== 1 || new Set(selected.map(policy => policy.sdkProvider)).size !== selected.length) throw new Error('Fallback requires distinct providers in one budget currency')
  const stop = new AbortController()
  const signal = AbortSignal.any([options.signal, stop.signal])
  const models = selected.map(policy => {
    const model = options.models.get(policy.id)
    if (!model || model.specificationVersion !== 'v2' || model.provider !== policy.sdkProvider || model.modelId !== policy.modelId) throw new Error('Approved SDK model is not registered')
    const reservation = inferenceReservation(policy)
    const before = async () => {
      signal.throwIfAborted()
      if (Date.parse(decision.expiresAt) <= Date.now()) throw new Error('Orch route expired')
      try {
        assertProviderAllowed(policy, await options.grant(), request.role, request.dataClass)
        await options.charge({ inferenceAttempts: 1, tokens: reservation.tokens, costMicros: reservation.costMicros })
        signal.throwIfAborted()
      } catch { stop.abort(); throw new ProviderFailure('INTERRUPTED') }
    }
    const metric = async (started: number, failure: ProviderFailure['classification'] | null, usage?: { inputTokens?: number; outputTokens?: number }) => {
      const safe = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value! : null
      await options.record({ policyId: policy.id, policyRevision: policy.revision, routeEvidenceId: decision.evidenceId, role: request.role,
        status: failure ? 'failure' : 'success', durationMs: Math.max(0, Date.now() - started),
        inputTokens: safe(usage?.inputTokens), outputTokens: safe(usage?.outputTokens), failure })
    }
    const failed = async (error: unknown, started: number, partial = false) => {
      const failure = signal.aborted ? 'INTERRUPTED' : classify(error)
      if (failure !== 'TRANSIENT' || partial) stop.abort()
      await metric(started, failure)
      return new ProviderFailure(failure)
    }
    const wrapped: Model = {
      ...model, specificationVersion: 'v2', provider: model.provider, modelId: model.modelId, supportedUrls: model.supportedUrls,
      doGenerate: async call => {
        await before(); const started = Date.now()
        try {
          const result = await model.doGenerate({ ...call, maxOutputTokens: reservation.maxOutputTokens, abortSignal: call.abortSignal ? AbortSignal.any([signal, call.abortSignal]) : signal })
          signal.throwIfAborted(); await metric(started, null, result.usage); return result
        } catch (error) { throw await failed(error, started) }
      },
      doStream: async call => {
        await before(); const started = Date.now()
        try {
          const result = await model.doStream({ ...call, maxOutputTokens: reservation.maxOutputTokens, abortSignal: call.abortSignal ? AbortSignal.any([signal, call.abortSignal]) : signal })
          let partial = false; let finished = false
          const reader = result.stream.getReader()
          return { ...result, stream: new ReadableStream({
            pull: async controller => {
              try {
                signal.throwIfAborted()
                const { done, value: chunk } = await reader.read()
                signal.throwIfAborted()
                if (done) {
                  if (!finished) throw new Error('Incomplete provider stream')
                  controller.close(); reader.releaseLock(); return
                }
                if (chunk.type === 'error') throw chunk.error
                if (['text-delta', 'tool-call', 'reasoning-delta'].includes(chunk.type)) partial = true
                if (chunk.type === 'finish') { finished = true; await metric(started, null, chunk.usage) }
                controller.enqueue(chunk)
              } catch (error) {
                const failure = await failed(error, started, partial)
                await reader.cancel().catch(() => undefined)
                controller.error(failure)
              }
            },
            cancel: async () => { stop.abort(); await reader.cancel().catch(() => undefined) },
          }) }
        } catch (error) { throw await failed(error, started) }
      },
    }
    return { model: wrapped, maxRetries: 0, modelSettings: { maxOutputTokens: reservation.maxOutputTokens } }
  })
  return { models, evidenceId: decision.evidenceId }
}
