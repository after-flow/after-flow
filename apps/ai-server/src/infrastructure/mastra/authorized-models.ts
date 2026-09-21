import { createHash, randomUUID } from 'node:crypto'
import { assertOrcaModel, orcaReceipt } from '../orcarouter/models.js'
import type { OrcaReceipt } from '../orcarouter/models.js'
import type { MastraModelConfig } from '@mastra/core/llm'
import type { ModelWithRetries } from '@mastra/core/agent'
import { assertProviderAllowed, inferenceReservation, providerPolicySchema, routeDecisionSchema, routeRequestSchema } from '../../orchestration/models/policy.js'
import type { OrchRouter, ProviderGrant, ProviderPolicy, RouteRequest } from '../../orchestration/models/policy.js'
import type { BudgetCharge } from '../../application/execution/contracts.js'

type Model = Extract<MastraModelConfig, { specificationVersion: 'v2'; doGenerate: (...args: never[]) => PromiseLike<{ content: unknown[] }> }>
type ModelBinding = { charge(value: BudgetCharge): Promise<void>; role: RouteRequest['role']; operation: RouteRequest['operation'] }
const authorizedModels = new WeakMap<object, ModelBinding>()
export function assertAuthorizedModelSet(models: unknown, expected: ModelBinding): void {
  if (!Array.isArray(models) || !models.length || models.length > 2 || models.some(entry =>
    !entry || typeof entry.model !== 'object' || authorizedModels.get(entry.model)?.charge !== expected.charge ||
    authorizedModels.get(entry.model)?.role !== expected.role || authorizedModels.get(entry.model)?.operation !== expected.operation ||
    entry.maxRetries !== 0)) throw new Error('Physical provider budget adapter must match this execution')
}
export interface ProviderMetric {
  attemptId: string; policyId: string; policyRevision: string; modelId: string; routeEvidenceId: string | null; selectionId?: string; gateway?: OrcaReceipt; role: 'core' | 'research'
  fallbackFromPolicyId: string | null
  status: 'success' | 'failure'; durationMs: number; inputTokens: number | null; outputTokens: number | null
  /** Policy-price estimate and gateway response value are provisional until reconciled with billing. */
  estimatedCostUsd: number | null; gatewayReportedCostUsd: number | null
  failure: 'TRANSIENT' | 'PERMANENT' | 'INTERRUPTED' | null
}
export class ProviderFailure extends Error {
  constructor(readonly classification: 'TRANSIENT' | 'PERMANENT' | 'INTERRUPTED') { super(`Provider request failed: ${classification}`) }
}
function classify(error: unknown): ProviderFailure['classification'] {
  if (error && typeof error === 'object' && 'statusCode' in error &&
    (error.statusCode === 429 || (typeof error.statusCode === 'number' && error.statusCode >= 500 && error.statusCode <= 599))) return 'TRANSIENT'
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'TRANSIENT'
  if (error instanceof Error && /transport interrupted or unavailable/i.test(error.message)) return 'TRANSIENT'
  return 'PERMANENT'
}

/** Native Mastra fallback list; every actual SDK invocation rechecks authority and reserves its own budget. */
export interface AuthorizedModelOptions {
  request: RouteRequest; policies: readonly ProviderPolicy[]; signal: AbortSignal
  /** Must resolve current Backend-authorized consent before each transfer, never an LLM-supplied grant. */
  grant(): Promise<ProviderGrant>
  models: ReadonlyMap<string, Model>
  charge(value: BudgetCharge): Promise<void>
  record(metric: ProviderMetric): Promise<void>
}
export async function createAuthorizedModels(options: AuthorizedModelOptions & { router: OrchRouter }): Promise<{ models: ModelWithRetries[]; evidenceId: string }> {
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
  return wrapSelectedModels(options, request, policies, decision, false)
}

/** Local authorized selection, then real inference through OrcaRouter. This is NOT a remote routing receipt. */
export async function createAuthorizedOrcaModels(options: AuthorizedModelOptions) {
  const request = routeRequestSchema.parse(options.request)
  if (request.role === 'research' && request.dataClass !== 'public_research') throw new Error('Research cannot receive private case data')
  if (request.policyIds.length > 2 || new Set(request.policyIds).size !== request.policyIds.length) throw new Error('Configure one or two explicit OrcaRouter policies per role')
  const policies = new Map(options.policies.map(value => { const policy = providerPolicySchema.parse(value); return [policy.id, policy] }))
  if (policies.size !== options.policies.length) throw new Error('Duplicate model policy')
  const grant = await options.grant()
  for (const id of request.policyIds) {
    const policy = policies.get(id), model = options.models.get(id)
    if (!policy || !model) throw new Error('Unknown OrcaRouter policy')
    assertOrcaModel(model, policy.modelId)
    assertProviderAllowed(policy, grant, request.role, request.dataClass)
  }
  options.signal.throwIfAborted()
  const decision = { requestId: request.requestId, policyIds: request.policyIds,
    evidenceId: 'orca-policy-' + createHash('sha256').update(JSON.stringify({ request, policies: [...policies.values()] })).digest('hex'),
    expiresAt: new Date(Math.min(Date.parse(grant.expiresAt), ...request.policyIds.map(id => Date.parse(policies.get(id)!.expiresAt)))).toISOString() }
  return wrapSelectedModels(options, request, policies, decision, true)
}

function wrapSelectedModels(options: AuthorizedModelOptions, request: RouteRequest, policies: Map<string, ProviderPolicy>,
  decision: { policyIds: string[]; evidenceId: string; expiresAt: string }, gateway: boolean) {
  const selected = decision.policyIds.map(id => policies.get(id)!)
  if (new Set(selected.map(policy => policy.currency)).size !== 1 || new Set(selected.map(policy => policy.sdkProvider)).size !== selected.length) throw new Error('Fallback requires distinct providers in one budget currency')
  const stop = new AbortController()
  const signal = AbortSignal.any([options.signal, stop.signal])
  const models = selected.map((policy, index) => {
    const model = options.models.get(policy.id)
    if (!model || model.specificationVersion !== 'v2' || model.provider !== policy.sdkProvider || model.modelId !== policy.modelId) throw new Error('Approved SDK model is not registered')
    const reservation = inferenceReservation(policy)
    const before = async () => {
      signal.throwIfAborted()
      if (Date.parse(decision.expiresAt) <= Date.now()) throw new Error('Model selection expired')
      try {
        assertProviderAllowed(policy, await options.grant(), request.role, request.dataClass)
        await options.charge({ inferenceAttempts: 1, tokens: reservation.tokens, costMicros: reservation.costMicros })
        signal.throwIfAborted()
      } catch { stop.abort(); throw new ProviderFailure('INTERRUPTED') }
    }
    const metric = async (started: number, failure: ProviderFailure['classification'] | null, usage?: { inputTokens?: number; outputTokens?: number }, receipt?: OrcaReceipt) => {
      const safe = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value! : null
      const inputTokens = safe(usage?.inputTokens), outputTokens = safe(usage?.outputTokens)
      const estimatedCostUsd = inputTokens === null || outputTokens === null ? null
        : (inputTokens * policy.inputMicrosPerToken + outputTokens * policy.outputMicrosPerToken) / 1_000_000
      await options.record({ attemptId: randomUUID(), policyId: policy.id, policyRevision: policy.revision, modelId: policy.modelId,
        routeEvidenceId: gateway ? null : decision.evidenceId, ...(gateway ? { selectionId: decision.evidenceId } : {}), ...(receipt ? { gateway: receipt } : {}), role: request.role,
        fallbackFromPolicyId: index > 0 ? selected[index - 1]!.id : null,
        status: failure ? 'failure' : 'success', durationMs: Math.max(0, Date.now() - started),
        inputTokens, outputTokens, estimatedCostUsd, gatewayReportedCostUsd: receipt?.costUsd ?? null, failure })
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
          signal.throwIfAborted(); await metric(started, null, result.usage, gateway ? orcaReceipt(result.response?.headers, policy.modelId, result.providerMetadata) : undefined); return result
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
                if (chunk.type === 'finish') { finished = true; await metric(started, null, chunk.usage, gateway ? orcaReceipt(result.response?.headers, policy.modelId, chunk.providerMetadata) : undefined) }
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
    authorizedModels.set(wrapped, { charge: options.charge, role: request.role, operation: request.operation })
    return { model: wrapped, maxRetries: 0, modelSettings: { maxOutputTokens: reservation.maxOutputTokens } }
  })
  return { models, evidenceId: decision.evidenceId }
}
