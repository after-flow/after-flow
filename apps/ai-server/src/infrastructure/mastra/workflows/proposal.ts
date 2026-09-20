import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { artifactEnvelopeSchema, contextProofSchema, internalId, proposalActionStateSchema } from '@aftercare/internal-contracts'
import type { BackendClient } from '../../backend-client/client.js'
import { actionReceiptSchema, proposalDraftSchema } from '../../../orchestration/actions/contracts.js'
import { contentHash } from '../../../orchestration/context/builder.js'
import { resumeSchema } from '../../../application/execution/contracts.js'

const inputSchema = z.object({ actionId: internalId, draft: proposalDraftSchema, context: artifactEnvelopeSchema }).strict()
const submittedSchema = inputSchema.extend({ receipt: actionReceiptSchema })
const outputSchema = z.object({ actionId: internalId, proposalId: internalId, proposalVersion: z.number().int().positive(), outcome: z.enum(['APPLIED', 'REJECTED', 'CHANGED', 'NOT_APPLIED']) }).strict()
export const PROPOSAL_WORKFLOW = 'proposal-approval-v1'

export interface ProposalWorkflowDependencies {
  backend: Pick<BackendClient, 'control' | 'context' | 'propose'>
  signal: AbortSignal
  previousAttemptId: string | null
  allowedKinds: readonly z.infer<typeof proposalDraftSchema>['kind'][]
  guard(): Promise<void>
  registerWait(waitRequestId: string): Promise<void>
}
export function createProposalWorkflow(deps: ProposalWorkflowDependencies) {
  async function current() {
    deps.signal.throwIfAborted(); await deps.guard()
    if ((await deps.backend.control({ signal: deps.signal })).instruction !== 'CONTINUE') throw new Error('Backend stopped execution')
    const context = artifactEnvelopeSchema.parse(await deps.backend.context({ signal: deps.signal }))
    if (context.content.operation !== 'case_planning' || contentHash(context.content) !== context.contentHash || Date.parse(context.expiresAt) <= Date.now()) throw new Error('Invalid proposal context')
    return context
  }
  const submit = createStep({ id: 'submit-proposal', inputSchema, outputSchema: submittedSchema,
    execute: async ({ inputData }) => {
      if (!deps.allowedKinds.includes(inputData.draft.kind)) throw new Error('Proposal kind is outside this playbook')
      const latest = await current()
      if (inputData.context.caseVersion !== latest.caseVersion || inputData.context.contentHash !== latest.contentHash) throw new Error('Proposal context changed before submission')
      for (const basis of inputData.draft.basis) {
        const content = latest.content
        const records = basis.type === 'DOCUMENT' ? content.documents : basis.type === 'TASK' ? content.tasks : content.message ? [content.message] : []
        const parsed = z.array(z.object({ id: internalId, version: z.number().int().positive() })).safeParse(records)
        if (!parsed.success || !parsed.data.some(item => item.id === basis.id && item.version === basis.version)) throw new Error('Proposal basis is outside context')
      }
      await deps.guard()
      const response = await deps.backend.propose({ ...inputData.draft, ...contextProofSchema.parse(latest), proposalId: inputData.actionId }, { requestId: inputData.actionId, signal: deps.signal })
      const receipt = actionReceiptSchema.parse({ ...response, actionId: inputData.actionId })
      if (receipt.payloadHash !== contentHash(inputData.draft.payload) || (receipt.applicationStatus === 'NOT_APPLIED' && !receipt.waitRequestId)) throw new Error('Backend proposal response does not match submitted content')
      return { ...inputData, context: latest, receipt }
    },
  })
  const wait = createStep({ id: 'wait-for-formal-application', inputSchema: submittedSchema, outputSchema,
    resumeSchema: z.object({ resume: z.literal(true) }).strict(), suspendSchema: z.object({ waitRequestId: internalId }).strict(),
    execute: async ({ inputData, resumeData, suspend }) => {
      const { receipt } = inputData
      const output = { actionId: receipt.actionId, proposalId: receipt.proposalId, proposalVersion: receipt.proposalVersion }
      if (receipt.applicationStatus === 'APPLIED') return { ...output, outcome: 'APPLIED' as const }
      if (!resumeData) {
        await deps.registerWait(receipt.waitRequestId!)
        return suspend({ waitRequestId: receipt.waitRequestId! })
      }
      const latest = await current()
      const resume = resumeSchema.parse(latest.content.resume)
      if (!deps.previousAttemptId || resume.previousAttemptId !== deps.previousAttemptId || resume.kind !== 'WAIT' || resume.waitRequestId !== receipt.waitRequestId) throw new Error('Approval resume is not bound to this wait')
      const actions = z.array(proposalActionStateSchema).max(100).parse(latest.content.actions)
      const action = actions.find(item => item.id === receipt.proposalId && item.actionId === receipt.actionId)
      if (!action) throw new Error('Formal action status is unavailable')
      if (action.proposalVersion !== receipt.proposalVersion || action.payloadHash !== receipt.payloadHash) return { ...output, outcome: 'CHANGED' as const }
      if (action.status === 'APPLIED' && resume.outcome === 'APPLIED') return { ...output, outcome: 'APPLIED' as const }
      if (action.status === 'REJECTED' && resume.outcome === 'REJECTED') return { ...output, outcome: 'REJECTED' as const }
      return { ...output, outcome: 'NOT_APPLIED' as const }
    },
  })
  return createWorkflow({ id: PROPOSAL_WORKFLOW, inputSchema, outputSchema }).then(submit).then(wait).commit()
}
