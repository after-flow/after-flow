import { z } from 'zod'
import { internalId, operationSchema } from '@aftercare/internal-contracts'

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
  state: z.enum(['QUEUED', 'RUNNING', 'WAITING', 'COMPLETED', 'STOPPED', 'FAILED']),
  owner: internalId.nullable(), leaseUntil: z.number().int().nonnegative(),
  waitRequestId: internalId.nullable(), createdAt: z.number().int(), updatedAt: z.number().int(),
  failure: z.enum(['STOPPED', 'EXECUTION_FAILED', 'BUDGET_EXCEEDED']).nullable(),
}).strict()
export type Receipt = z.infer<typeof receiptSchema>
export class ExecutionRejected extends Error {
  constructor(readonly code: 'STALE_OWNER' | 'CONFLICT' | 'STOPPED' | 'BUDGET_EXCEEDED') { super(code) }
}
