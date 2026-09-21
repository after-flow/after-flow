import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { createBudgetProcessors } from '../src/infrastructure/mastra/budget-processors.js'
import { scriptedModel } from './helpers/scripted-model.js'
import type { BudgetCharge } from '../src/application/execution/contracts.js'

const inference = { core: { tokens: 1000, costMicros: 2000, maxOutputTokens: 100 }, research: { tokens: 1000, costMicros: 2000, maxOutputTokens: 100 } }
test('Mastra budget processors block before provider IO and tool execution', async () => {
  const model = scriptedModel([{ tool: 'probe', input: {} }]); let tools = 0
  let blockInference = true
  const charges: BudgetCharge[] = []
  const factory = createBudgetProcessors({ inference, charge: async charge => {
    charges.push(charge)
    if ((blockInference && charge.inferenceAttempts) || charge.tools) throw new Error('BUDGET_EXCEEDED')
  } })
  const processors = factory('core')
  const agent = new Agent({ id: 'budget-test', name: 'budget', instructions: 'fixture', model: model.model,
    inputProcessors: [processors.input], outputProcessors: [processors.output],
    tools: { probe: createTool({ id: 'probe', description: 'fixture', inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => { tools++; return { ok: true } } }) },
    defaultOptions: { maxSteps: 2, modelSettings: { maxRetries: 0 } },
  })
  await agent.generate('fixture').catch(() => undefined)
  assert.equal(model.calls.length, 0); assert.equal(tools, 0)
  blockInference = false
  await agent.generate('fixture').catch(() => undefined)
  assert.equal(model.calls.length, 1); assert.equal(tools, 0)
  assert.ok(charges.some(charge => charge.tools === 1))
  assert.equal(model.calls[0]?.maxOutputTokens, 100)
})
