import type { InputProcessor, OutputProcessor } from '@mastra/core/processors'
import type { BudgetCharge } from '../../application/execution/contracts.js'
import { ExecutionRejected } from '../../application/execution/contracts.js'

export interface AgentBudget {
  /** Only with createAuthorizedModels: it charges each physical provider attempt. */
  inferenceChargedByProviderAdapter?: true
  /** Shared durable Run reservation, including Backend control/ownership verification. */
  charge(value: BudgetCharge): Promise<void>
  /** Provider policy must supply a proven whole-request token/cost upper bound, including schemas. */
  inference: Record<'core' | 'research', { tokens: number; costMicros: number; maxOutputTokens: number }>
}

/** One shared section object for both agents. Mastra retains ownership of the inference/tool loop. */
export function createBudgetProcessors(budget: AgentBudget) {
  let tools = 0
  for (const reservation of Object.values(budget.inference)) {
    if (Object.values(reservation).some(value => !Number.isSafeInteger(value) || value <= 0) || reservation.maxOutputTokens >= reservation.tokens) throw new Error('Finite inference upper bounds are required')
  }
  return (role: 'core' | 'research'): { input: InputProcessor; output: OutputProcessor } => ({
    input: {
      id: `durable-budget-${role}`,
      processInputStep: ({ modelSettings }) => ({ modelSettings: { ...modelSettings, maxRetries: 0, maxOutputTokens: budget.inference[role].maxOutputTokens } }),
      processLLMRequest: async () => {
        if (budget.inferenceChargedByProviderAdapter) { await budget.charge({}); return }
        const { tokens, costMicros } = budget.inference[role]
        await budget.charge({ inferenceAttempts: 1, tokens, costMicros })
      },
    },
    output: {
      id: `durable-tools-${role}`,
      processOutputStep: async ({ toolCalls, messages }) => {
        const count = toolCalls?.length ?? 0
        tools += count
        if (tools > 20) throw new ExecutionRejected('BUDGET_EXCEEDED')
        await budget.charge({ tools: count })
        return messages
      },
    },
  })
}
