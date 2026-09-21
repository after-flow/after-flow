import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core/mastra'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { createOrcaModel, orcaReceipt } from '../src/infrastructure/orcarouter/models.js'
import { readOrcaApiKey } from '../src/infrastructure/orcarouter/environment.js'

// Opt-in live check: fixed synthetic prompts only, no Case, documents, or Backend grant.
let stage = 'configuration'
try {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' } }, strict: true, allowPositionals: false })
  const apiKey = await readOrcaApiKey(values['env-file'] ?? new URL('../../../.env', import.meta.url))
  const modelId = 'openai/gpt-4o-mini'
  const model = createOrcaModel({ apiKey, modelId })
  stage = 'completion'
  const result = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }], maxOutputTokens: 8 })
  assert.ok(result.content.some(part => part.type === 'text' && part.text.trim()))
  const receipt = orcaReceipt(result.response?.headers, modelId, result.providerMetadata)
  console.log(JSON.stringify({ check: stage, status: 'passed', ...receipt, usage: result.usage }))

  let toolsExecuted = 0
  const probe = new Agent({ id: 'orca-synthetic-smoke', name: 'Orca synthetic smoke', model,
    instructions: 'Follow the synthetic connectivity test instructions. Never use real personal information.',
    tools: { probe: createTool({ id: 'probe', description: 'Return a fixed synthetic connectivity status.', inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }), execute: async () => { toolsExecuted++; return { ok: true } } }) },
    defaultOptions: { maxSteps: 1, modelSettings: { maxRetries: 0, maxOutputTokens: 128, temperature: 0 } } })
  const mastra = new Mastra({ agents: { probe }, logger: false })
  const agent = mastra.getAgent('probe')
  stage = 'mastra-stream'
  const stream = await agent.stream('日本語で「接続確認」とだけ返してください。', { toolChoice: 'none' })
  assert.ok((await stream.text).includes('接続確認'))
  console.log(JSON.stringify({ check: stage, status: 'passed' }))
  stage = 'mastra-tool'
  await agent.generate('Call the probe tool once.', { toolChoice: { type: 'tool', toolName: 'probe' } })
  assert.equal(toolsExecuted, 1)
  console.log(JSON.stringify({ check: stage, status: 'passed' }))
  stage = 'mastra-structured-output'
  const structured = await agent.generate('Return JSON with ok equal to true.', {
    toolChoice: 'none', structuredOutput: { schema: z.object({ ok: z.boolean() }) },
  })
  assert.equal(structured.object?.ok, true)
  console.log(JSON.stringify({ check: stage, status: 'passed' }))
} catch {
  // Neither SDK exceptions nor raw response bodies are safe CLI diagnostics.
  console.error(JSON.stringify({ check: stage, status: 'failed', message: 'OrcaRouter接続を確認できません。キー・利用枠・通信状況を確認してください。' }))
  process.exitCode = 1
}
