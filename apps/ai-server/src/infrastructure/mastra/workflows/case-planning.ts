import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { internalId, artifactEnvelopeSchema } from '@aftercare/internal-contracts'
import { assertContextFresh, buildPlanningContext } from '../../../orchestration/context/builder.js'
import { planningDraftSchema, reviewedTaskTemplateSchema, validatePlan } from '../../../orchestration/playbooks/planning-output.js'
import type { ReviewedTaskTemplate } from '../../../orchestration/playbooks/planning-output.js'
import { proposalDraftSchema } from '../../../orchestration/actions/contracts.js'
import { sourceDocumentSchema } from '../../../orchestration/research/sources.js'
import { assertCompleteResearch, researchEvidenceSchema } from '../../../orchestration/research/contracts.js'
import type { GuidanceAgentDependencies } from '../agents/guidance-agents.js'
import { createPlaybookAgents } from '../agents/guidance-agents.js'
import type { BackendClient } from '../../backend-client/client.js'

const inputSchema = z.object({ runId: internalId }).strict()
const generatedSchema = inputSchema.extend({ artifact: artifactEnvelopeSchema, draft: planningDraftSchema,
  sources: z.array(sourceDocumentSchema).max(20), research: researchEvidenceSchema, routeEvidenceId: internalId })
const outputSchema = z.object({
  proposals: z.array(z.object({ actionId: internalId, draft: proposalDraftSchema, dependencyTaskIds: z.array(internalId), requiredDocuments: z.array(z.string()) })).max(10),
  questions: z.array(z.string()), skipped: z.array(z.object({ templateId: internalId, reason: z.enum(['EXISTING_TASK', 'PREVIOUS_PROPOSAL', 'PREREQUISITE_UNKNOWN']) })),
}).strict()
export function createCasePlanningWorkflow(deps: {
  backend: Pick<BackendClient, 'context' | 'control'>; templates: readonly ReviewedTaskTemplate[]; signal: AbortSignal; maxSourceAgeMs: number
  /** Creates approved research tools and bounded models for this section. */
  prepare(): Promise<{ agents: GuidanceAgentDependencies; sources(): z.infer<typeof sourceDocumentSchema>[]; routeEvidenceId: string }>
}) {
  const templates = deps.templates.map(value => reviewedTaskTemplateSchema.parse(value))
  if (!templates.length || templates.length > 20 || !Number.isSafeInteger(deps.maxSourceAgeMs) || deps.maxSourceAgeMs <= 0) throw new Error('Bounded reviewed planning configuration is required')
  const generate = createStep({ id: 'generate-reviewed-plan', inputSchema, outputSchema: generatedSchema, execute: async ({ inputData }) => {
    deps.signal.throwIfAborted()
    if ((await deps.backend.control({ signal: deps.signal })).instruction !== 'CONTINUE') throw new Error('Planning stopped')
    const artifact = await deps.backend.context({ signal: deps.signal }); const context = buildPlanningContext(artifact)
    const prepared = await deps.prepare()
    internalId.parse(prepared.routeEvidenceId)
    const agents = createPlaybookAgents({ ...prepared.agents, playbookId: 'case-planning', signal: deps.signal })
    const response = await agents.coreAgent.generate(JSON.stringify({
      goal: '既存Task・本人意思・訂正・却下を尊重して、候補Template IDと既存Task IDへの依存だけを選んでください。法律上の期限や本人意思を決めず、不足・判断が必要な点は質問にしてください。新規Task同士のIDを捏造しません。',
      context: context.modelInput, templates,
    }), { structuredOutput: { schema: planningDraftSchema, errorStrategy: 'strict' }, abortSignal: deps.signal })
    return { ...inputData, artifact, draft: planningDraftSchema.parse(response.object), sources: prepared.sources(), research: agents.researchEvidence(), routeEvidenceId: prepared.routeEvidenceId }
  } })
  const validate = createStep({ id: 'validate-plan-difference', inputSchema: generatedSchema, outputSchema, execute: async ({ inputData }) => {
    deps.signal.throwIfAborted()
    if ((await deps.backend.control({ signal: deps.signal })).instruction !== 'CONTINUE') throw new Error('Planning stopped')
    const latest = buildPlanningContext(await deps.backend.context({ signal: deps.signal }))
    assertContextFresh(buildPlanningContext(inputData.artifact), latest)
    if (inputData.sources.some(source => Date.now() - Date.parse(source.fetchedAt) > deps.maxSourceAgeMs)) throw new Error('Planning sources expired')
    if (inputData.draft.tasks.length) assertCompleteResearch(inputData.research, new Set(inputData.sources.map(source => source.id)))
    return validatePlan({ ...inputData, context: latest, templates })
  } })
  return createWorkflow({ id: 'case-planning-v1', inputSchema, outputSchema }).then(generate).then(validate).commit()
}
