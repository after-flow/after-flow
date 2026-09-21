import type { MastraModelConfig } from '@mastra/core/llm'
import { z } from 'zod'
import { ORCA_BASE_URL, orcaReceipt } from '../../src/infrastructure/orcarouter/models.js'

type Model = Extract<MastraModelConfig, { specificationVersion: 'v2' }>
type StreamResult = Awaited<ReturnType<Model['doStream']>>
type Chunk = StreamResult['stream'] extends ReadableStream<infer Item> ? Item : never

/** 1回のモデル呼び出しの記録。プロンプトと応答の本文は持たない。 */
export interface CallRecord {
  role: 'core' | 'research'
  modelId: string
  requestId: string | null
  resolvedModel: string | null
  fallbackModel: string | null
  inputTokens: number | null
  outputTokens: number | null
  /** 応答に含まれる暫定費用（X-OrcaRouter-Include-Cost）。 */
  provisionalCostUsd: number | null
  /** /v1/generation で確定した費用。確定前や取得できない場合はnull。 */
  finalCostUsd: number | null
  latencyMs: number
  ok: boolean
}

/**
 * モデルを包み、呼び出しごとの識別子・token・費用・時間を記録する。
 * 実OrcaRouterでは応答ヘッダーからrequest IDを取る。fixtureではIDと費用はnullになる。
 */
export function meteredModel(model: Model, role: CallRecord['role'], sink: (record: CallRecord) => void,
  /** 調査用。応答本文を受け取る。レポートには書かない。 */
  captureText?: (text: string) => void): Model {
  const receipt = (headers: Record<string, string> | undefined, metadata: unknown) => {
    try {
      const value = orcaReceipt(headers, model.modelId, metadata as Record<string, unknown> | undefined)
      return { requestId: value.requestId, resolvedModel: value.resolvedModel, fallbackModel: value.fallbackModel, provisionalCostUsd: value.costUsd }
    } catch { return { requestId: null, resolvedModel: null, fallbackModel: null, provisionalCostUsd: null } }
  }
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property === 'doGenerate') return async (options: Parameters<Model['doGenerate']>[0]) => {
        const started = performance.now()
        try {
          const result = await target.doGenerate(options) as Awaited<ReturnType<Model['doGenerate']>> & {
            content: { type: string; text?: string }[]; usage: { inputTokens?: number; outputTokens?: number }; providerMetadata?: unknown }
          sink({ role, modelId: target.modelId, ...receipt(result.response?.headers, result.providerMetadata), finalCostUsd: null,
            inputTokens: result.usage.inputTokens ?? null, outputTokens: result.usage.outputTokens ?? null, latencyMs: performance.now() - started, ok: true })
          captureText?.(result.content.map(part => part.type === 'text' ? part.text ?? '' : '').join(''))
          return result
        } catch (error) {
          sink({ role, modelId: target.modelId, requestId: null, resolvedModel: null, fallbackModel: null, provisionalCostUsd: null, finalCostUsd: null,
            inputTokens: null, outputTokens: null, latencyMs: performance.now() - started, ok: false })
          throw error
        }
      }
      if (property === 'doStream') return async (options: Parameters<Model['doStream']>[0]) => {
        const started = performance.now()
        let result: StreamResult
        try { result = await target.doStream(options) } catch (error) {
          sink({ role, modelId: target.modelId, requestId: null, resolvedModel: null, fallbackModel: null, provisionalCostUsd: null, finalCostUsd: null,
            inputTokens: null, outputTokens: null, latencyMs: performance.now() - started, ok: false })
          throw error
        }
        let recorded = false
        let text = ''
        const record = (chunk: Extract<Chunk, { type: 'finish' }> | null) => {
          if (recorded) return
          recorded = true
          sink({ role, modelId: target.modelId, ...receipt(result.response?.headers, chunk?.providerMetadata), finalCostUsd: null,
            inputTokens: chunk?.usage.inputTokens ?? null, outputTokens: chunk?.usage.outputTokens ?? null, latencyMs: performance.now() - started, ok: chunk !== null })
        }
        return { ...result, stream: result.stream.pipeThrough(new TransformStream<Chunk, Chunk>({
          transform(chunk, controller) {
            if (chunk.type === 'text-delta' && captureText) text += chunk.delta
            if (chunk.type === 'finish') record(chunk)
            controller.enqueue(chunk)
          },
          flush() { record(null); if (captureText) captureText(text) },
        })) }
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

const cost = z.object({ total_cost: z.number().finite().nonnegative() })
const generationSchema = z.object({ data: cost }).or(cost)

/**
 * 確定費用を /v1/generation から取得する。精算前は404になるため、間隔を空けて数回だけ再試行する。
 * 応答本文は費用以外を読まない。
 */
export async function finalCostUsd(requestId: string, apiKey: string, options: { attempts?: number; delayMs?: number } = {}): Promise<number | null> {
  const attempts = options.attempts ?? 4
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 1500))
    let response: Response
    try {
      response = await fetch(`${ORCA_BASE_URL}/generation?id=${encodeURIComponent(requestId)}`, { redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${apiKey}` } })
    } catch { continue }
    if (response.status === 404) { await response.body?.cancel(); continue }
    if (!response.ok) { await response.body?.cancel(); return null }
    const parsed = generationSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) return null
    return 'data' in parsed.data ? parsed.data.data.total_cost : parsed.data.total_cost
  }
  return null
}
