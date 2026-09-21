import { z } from 'zod'
import { executionFailureReasonSchema, internalId, operationSchema, interruptedResultSchema, runSummarySchema } from '@aftercare/internal-contracts'
import type { ExecutionFailureReason } from '@aftercare/internal-contracts'

export const budgetSchema = z.object({
  tools: z.number().int().positive().max(1000), research: z.number().int().positive().max(100),
  searches: z.number().int().positive().max(1000), reads: z.number().int().positive().max(1000),
  inferenceAttempts: z.number().int().positive().max(1000), replans: z.number().int().nonnegative().max(100),
  tokens: z.number().int().positive().safe(), costMicros: z.number().int().positive().safe(),
  activeMs: z.number().int().positive().max(86_400_000),
}).strict()
export type Budget = z.infer<typeof budgetSchema>
export type BudgetCharge = Partial<Budget>
export const emptyBudget = (): Budget => ({ tools: 0, research: 0, searches: 0, reads: 0, inferenceAttempts: 0, replans: 0, tokens: 0, costMicros: 0, activeMs: 0 })
export const resumeSchema = z.object({
  waitRequestId: internalId.nullable(), snapshotId: internalId.nullable(), previousAttemptId: internalId,
  kind: z.enum(['WAIT', 'CHECKPOINT', 'RETRY']), outcome: z.string().min(1).max(100),
}).strict()
export type ResumeContext = z.infer<typeof resumeSchema>
export const receiptSchema = z.object({
  runId: internalId, jobId: internalId, executionAttempt: internalId, operation: operationSchema,
  kind: z.enum(['dispatch', 'resume']), resume: resumeSchema.nullable(),
  workflowName: internalId, workflowRunId: internalId,
  encryptedDispatch: z.string().min(1).max(12000),
  state: z.enum(['QUEUED', 'RUNNING', 'WAITING', 'COMPLETED', 'STOPPED', 'FAILED', 'REPORTING']),
  owner: internalId.nullable(), leaseUntil: z.number().int().nonnegative(),
  waitRequestId: internalId.nullable(), createdAt: z.number().int(), updatedAt: z.number().int(),
  failure: z.union([z.literal('STOPPED'), executionFailureReasonSchema]).nullable(),
  progress: z.object({ caseVersion: z.number().int().positive(), output: runSummarySchema }).strict().nullable().optional(),
  pendingResult: interruptedResultSchema.nullable().optional(),
}).strict()
export type Receipt = z.infer<typeof receiptSchema>
export class ExecutionRejected extends Error {
  constructor(readonly code: 'STALE_OWNER' | 'CONFLICT' | 'STOPPED' | 'BUDGET_EXCEEDED') { super(code) }
}

/** Safe, enumerable execution classification. Raw provider/model errors stay internal. */
export class ClassifiedExecutionError extends Error {
  constructor(readonly code: ExecutionFailureReason) {
    super(code)
    this.name = 'ClassifiedExecutionError'
  }
}

export function classifyWorkflowFailure(error: unknown): ExecutionFailureReason {
  const seen = new Set<unknown>()
  const messages: string[] = []
  let current: unknown = error
  while (current && !seen.has(current)) {
    seen.add(current)
    if (current instanceof ClassifiedExecutionError) return current.code
    if (typeof current === 'string') messages.push(current)
    if (current instanceof Error) messages.push(current.name, current.message)
    if (typeof current === 'object') {
      const value = current as Record<string, unknown>
      if (typeof value.code === 'string' && executionFailureReasonSchema.safeParse(value.code).success) return value.code as ExecutionFailureReason
      current = value.cause
    } else current = null
  }
  const text = messages.join(' ')
  if (/OUTPUT_CONTRACT_REJECTED|Structured output validation failed|output contract/i.test(text)) return 'OUTPUT_CONTRACT_REJECTED'
  if (/CONTEXT_CHANGED|stale context/i.test(text)) return 'CONTEXT_CHANGED'
  if (/EVIDENCE_INSUFFICIENT|evidence insufficient|unresolved research cannot produce complete/i.test(text)) return 'EVIDENCE_INSUFFICIENT'
  if (/RESEARCH_UNAVAILABLE|research agent did not return|official source.*unavailable/i.test(text)) return 'RESEARCH_UNAVAILABLE'
  if (/Provider request failed|PROVIDER_UNAVAILABLE|exhausted all fallback models/i.test(text)) return 'PROVIDER_UNAVAILABLE'
  if (/BUDGET_EXCEEDED/i.test(text)) return 'BUDGET_EXCEEDED'
  return 'EXECUTION_FAILED'
}
