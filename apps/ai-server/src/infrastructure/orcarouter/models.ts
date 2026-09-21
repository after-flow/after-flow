import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'

export const ORCA_BASE_URL = 'https://api.orcarouter.ai/v1'
const modelIdSchema = z.string().regex(/^[a-z][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/).max(200)
const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(128)
const bindings = new WeakMap<object, string>()
export interface OrcaReceipt {
  gateway: 'orcarouter'; requestId: string; requestedModel: string
  /** Model identifiers only; OrcaRouter does not disclose the physical upstream provider. */
  resolvedModel: string | null; fallbackModel: string | null; costUsd: number | null
}
export interface OrcaModelOptions { apiKey: string; modelId: string; timeoutMs?: number }

export function orcaSdkProvider(modelId: string): string {
  modelIdSchema.parse(modelId)
  if (modelId.startsWith('orcarouter/')) throw new Error('Named and automatic routers require a separately reviewed recipient policy')
  return `orcarouter-${modelId.split('/')[0]}.chat`
}
export function assertOrcaModel(model: object, modelId: string): void {
  if (bindings.get(model) !== modelId) throw new Error('Expected a fixed-model OrcaRouter transport')
}
function costMetadata(raw: unknown) {
  const parsed = z.object({ usage: z.object({ cost_usd: z.number().finite().nonnegative().optional() }).nullish() }).safeParse(raw)
  return { orcarouter: { costUsd: parsed.success ? parsed.data.usage?.cost_usd ?? null : null } }
}
export function orcaReceipt(headers: Record<string, string> | undefined, modelId: string, metadata?: Record<string, unknown>): OrcaReceipt {
  const h = new Headers(headers)
  const requestId = requestIdSchema.safeParse(h.get('x-orca-request-id'))
  if (!requestId.success) throw new Error('OrcaRouter response is missing a valid request identity')
  const optionalModel = (name: string) => {
    const value = h.get(name)
    if (value === null) return null
    const parsed = modelIdSchema.safeParse(value)
    if (!parsed.success || parsed.data !== modelId) throw new Error('OrcaRouter returned an unexpected model route')
    return parsed.data
  }
  const cost = z.object({ costUsd: z.number().finite().nonnegative().nullable() }).safeParse(metadata?.orcarouter)
  return { gateway: 'orcarouter', requestId: requestId.data, requestedModel: modelId,
    resolvedModel: optionalModel('x-orca-resolved-model'), fallbackModel: optionalModel('x-orca-fallback-model'),
    costUsd: cost.success ? cost.data.costUsd : null }
}

/** Standard AI SDK v2 protocol adapter. No custom inference loop and no extra routing/preflight API. */
export function createOrcaModel(options: OrcaModelOptions) {
  const provider = orcaSdkProvider(options.modelId)
  const apiKey = z.string().trim().min(1).max(4096).regex(/^[^\s]+$/).safeParse(options.apiKey)
  if (!apiKey.success) throw new Error('ORCAROUTER_API_KEY is missing or invalid')
  const timeoutMs = z.number().int().min(100).max(120000).parse(options.timeoutMs ?? 30000)
  const sdk = createOpenAICompatible({ name: provider.slice(0, -5), baseURL: ORCA_BASE_URL,
    apiKey: apiKey.data, includeUsage: true, supportsStructuredOutputs: true,
    metadataExtractor: {
      extractMetadata: async ({ parsedBody }) => costMetadata(parsedBody),
      createStreamExtractor: () => {
        let metadata = costMetadata(null)
        return { processChunk(chunk) { const next = costMetadata(chunk); if (next.orcarouter.costUsd !== null) metadata = next }, buildMetadata: () => metadata }
      },
    },
    fetch: async (url, init) => {
      if (String(url) !== `${ORCA_BASE_URL}/chat/completions` || init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('Unexpected OrcaRouter request')
      const body = JSON.parse(init.body) as Record<string, unknown>
      const allowed = new Set(['model', 'messages', 'max_tokens', 'temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'stop', 'seed', 'response_format', 'tools', 'tool_choice', 'stream', 'stream_options', 'parallel_tool_calls'])
      if (body.model !== options.modelId || Object.keys(body).some(key => !allowed.has(key)) || Buffer.byteLength(init.body) > 2 * 1024 * 1024) throw new Error('Unapproved OrcaRouter request options')
      // The model/host/key are deployment-owned; caller headers cannot override them or redirect the credential.
      const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)])
      signal.throwIfAborted()
      let response: Response
      try {
        response = await fetch(`${ORCA_BASE_URL}/chat/completions`, { method: 'POST', body: init.body, redirect: 'error', signal,
          headers: { Authorization: `Bearer ${apiKey.data}`, 'Content-Type': 'application/json', 'X-OrcaRouter-Include-Cost': 'true' } })
      } catch { throw new Error('OrcaRouter transport interrupted or unavailable') }
      if (!response.ok) {
        await response.body?.cancel()
        // SDK errors must never retain upstream bodies, which could echo prompts or credentials.
        return new Response(JSON.stringify({ error: { message: 'OrcaRouter request failed' } }), { status: response.status, headers: { 'Content-Type': 'application/json' } })
      }
      try { orcaReceipt(Object.fromEntries(response.headers), options.modelId) }
      catch (error) { await response.body?.cancel(); throw error }
      return response
    },
  })
  const model = sdk.chatModel(options.modelId)
  bindings.set(model, options.modelId)
  return model
}
