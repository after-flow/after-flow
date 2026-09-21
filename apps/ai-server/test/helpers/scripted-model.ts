import type { MastraModelConfig } from '@mastra/core/llm'

type Model = Extract<MastraModelConfig, { specificationVersion: 'v2' }>
type Call = Parameters<Model['doStream']>[0]
type StreamResult = Awaited<ReturnType<Model['doStream']>>
type Chunk = StreamResult['stream'] extends ReadableStream<infer Item> ? Item : never
type Turn = { text: string } | { tool: string; input: Record<string, unknown> }

/** A scripted provider fixture exercising the real Mastra loop, never imported by src. */
export function scriptedModel(turns: readonly Turn[]) {
  const calls: Call[] = []
  const model: Model = {
    specificationVersion: 'v2', provider: 'fixture', modelId: 'scripted', supportedUrls: {},
    doGenerate: async (options) => {
      calls.push(options)
      const turn = turns[calls.length - 1]
      if (!turn) throw new Error('Unexpected model call')
      return {
        content: 'text' in turn
          ? [{ type: 'text' as const, text: turn.text }]
          : [{ type: 'tool-call' as const, toolCallId: `call-${calls.length}`, toolName: turn.tool, input: JSON.stringify(turn.input) }],
        finishReason: 'text' in turn ? 'stop' as const : 'tool-calls' as const,
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        warnings: [],
      }
    },
    doStream: async (options) => {
      calls.push(options)
      const turn = turns[calls.length - 1]
      if (!turn) throw new Error('Unexpected model call')
      return {
        stream: new ReadableStream<Chunk>({ start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          if ('text' in turn) {
            controller.enqueue({ type: 'text-start', id: 'text' })
            controller.enqueue({ type: 'text-delta', id: 'text', delta: turn.text })
            controller.enqueue({ type: 'text-end', id: 'text' })
          } else {
            controller.enqueue({ type: 'tool-call', toolCallId: `call-${calls.length}`, toolName: turn.tool, input: JSON.stringify(turn.input) })
          }
          controller.enqueue({ type: 'finish', finishReason: 'text' in turn ? 'stop' : 'tool-calls', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } })
          controller.close()
        } }),
      }
    },
  }
  return { model, calls }
}
