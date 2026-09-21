import { buildEventInsight } from '../../../orchestration/playbooks/event-insights.js'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { contentHash, buildPlanningContext } from '../../../orchestration/context/builder.js'
import type { RunSummary } from '@aftercare/internal-contracts'
import { contextProofSchema, internalId, insightEventSchema, insightDraftSchema } from '@aftercare/internal-contracts'
import { createCasePlanningWorkflow, planningOutputSchema } from './case-planning.js'
import { proposalActions, proposalInputSchema, proposalSubmittedSchema } from './proposal.js'
import type { ProposalWorkflowDependencies } from './proposal.js'
import type { BackendClient } from '../../backend-client/client.js'

export const PLANNING_EXECUTION = 'planning-execution-v1'
/** The proposal workflow is flattened into this root, so its durable wait belongs to the Worker receipt. */
export function createPlanningExecutionWorkflow(deps: Parameters<typeof createCasePlanningWorkflow>[0] & ProposalWorkflowDependencies & {
  backend: ProposalWorkflowDependencies['backend'] & Pick<BackendClient, 'result'>
  checkpoint?: (caseVersion: number, output: RunSummary) => Promise<void>
}) {
  const planning = createCasePlanningWorkflow(deps)
  const approval = proposalActions(deps)
  const inputSchema = z.object({ runId: internalId, resultId: internalId }).strict()
  // Nullable selection permits clarification-only plans to complete without a fabricated proposal.
  const selectedSchema = z.object({ plan: planningOutputSchema, proposal: proposalInputSchema.nullable() })
  const submittedSchema = selectedSchema.extend({ submitted: proposalSubmittedSchema.nullable() })
  const verifiedSchema = selectedSchema.extend({ outcome: z.enum(['APPLIED', 'REJECTED', 'CHANGED', 'NOT_APPLIED', 'NO_PROPOSAL']) })
  const select = createStep({ id: 'select-current-proposal', inputSchema: planningOutputSchema, outputSchema: selectedSchema,
    execute: async ({ inputData }) => {
      await deps.checkpoint?.(inputData.context.caseVersion, { summary: '計画候補を作成しました。', completed: [],
        questions: inputData.questions, remaining: inputData.proposals.map(item => item.draft.title) })
      await deps.guard()
      const first = inputData.proposals[0]
      return { plan: inputData, proposal: first ? { actionId: first.actionId, draft: first.draft, context: inputData.context } : null }
    } })
  const currentReview = (plan: z.infer<typeof planningOutputSchema>) => plan.reviewConfigHash === contentHash(deps.templates) && Date.parse(plan.reviewValidUntil) > Date.now()
  const submit = createStep({ id: 'submit-plan-proposal', inputSchema: selectedSchema, outputSchema: submittedSchema,
    execute: async args => {
      if (args.inputData.proposal && !currentReview(args.inputData.plan)) throw new Error('Plan review changed before submission')
      return { ...args.inputData, submitted: args.inputData.proposal ? await approval.submit(args.inputData.proposal) : null }
    } })
  const wait = createStep({ id: 'wait-plan-proposal', inputSchema: submittedSchema, outputSchema: verifiedSchema,
    resumeSchema: z.object({ resume: z.literal(true) }).strict(), suspendSchema: z.object({ waitRequestId: internalId }).strict(),
    execute: async args => {
      if (!args.inputData.submitted) return { plan: args.inputData.plan, proposal: null, outcome: 'NO_PROPOSAL' as const }
      const receipt = args.inputData.submitted.receipt
      if (receipt.applicationStatus === 'APPLIED') return { plan: args.inputData.plan, proposal: args.inputData.proposal, outcome: 'APPLIED' as const }
      if (!args.resumeData) { await deps.registerWait(receipt.waitRequestId!); return args.suspend({ waitRequestId: receipt.waitRequestId! }) }
      const output = await approval.verify(receipt)
      return { plan: args.inputData.plan, proposal: args.inputData.proposal, outcome: output.outcome }

    } })
  const report = createStep({ id: 'report-plan-outcome', inputSchema: verifiedSchema,
    outputSchema: z.object({ applied: z.boolean(), reason: z.string().nullable(), status: z.enum(['SUCCEEDED', 'NEEDS_ATTENTION']), remaining: z.number().int().nonnegative() }),
    execute: async ({ inputData, getInitData }) => {
      await deps.guard()
      const { resultId } = inputSchema.parse(getInitData())
      const remaining = Math.max(0, inputData.plan.proposals.length - (inputData.proposal ? 1 : 0))
      const latest = await deps.backend.context({ signal: deps.signal })
      const restricted = buildPlanningContext(latest).planningRestriction !== null
      const status = !restricted && inputData.outcome === 'APPLIED' && currentReview(inputData.plan) && !remaining && !inputData.plan.questions.length ? 'SUCCEEDED' as const : 'NEEDS_ATTENTION' as const
      const events = z.array(insightEventSchema).max(20).parse(latest.content.insightEvents ?? [])
      const caseId = z.object({ id: internalId }).parse(latest.content.case).id
      const tasks = z.array(z.object({ id: internalId, version: z.number().int().positive() })).parse(latest.content.tasks ?? [])
      const insights = events.flatMap(event => {
        const task = tasks.find(task => task.id === event.task.id)
        if (!task) throw new Error('Insight task is outside the current Context')
        const result = buildEventInsight(event, { caseId, caseVersion: latest.caseVersion, taskId: task.id, taskVersion: task.version })
        // Display-only. Formal document requests/escalations remain on the separate Proposal approval path.
        return result.insight ? [insightDraftSchema.parse({ ...result.insight, eventId: event.id, resultId: result.resultId })] : []
      })
      const proof = contextProofSchema.parse(latest)
      const response = await deps.backend.result({ ...proof, resultId, kind: 'case_planning', status, insights, output: {
        summary: status === 'SUCCEEDED' ? '承認された手続きの反映を確認しました。' : '計画には追加の確認が必要です。',
        completed: inputData.outcome === 'APPLIED' && inputData.proposal ? [`${inputData.proposal.draft.title}の正式反映を確認`] : [],
        questions: inputData.plan.questions,
        remaining: inputData.plan.proposals.slice(inputData.proposal ? 1 : 0).map(item => item.draft.title),
      }, basis: [] }, { requestId: resultId, signal: deps.signal })
      return { ...response, status, remaining }
    } })
  return createWorkflow({ id: PLANNING_EXECUTION, inputSchema, outputSchema: report.outputSchema })
    .map(async ({ inputData }) => ({ runId: inputData.runId })).then(planning).then(select).then(submit).then(wait).then(report).commit()
}
