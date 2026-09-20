import { createStep, createWorkflow } from '@mastra/core/workflows'
import type { MastraModelConfig } from '@mastra/core/llm'
import { z } from 'zod'
import { artifactEnvelopeSchema, internalId } from '@aftercare/internal-contracts'
import type { BackendClient } from '../../backend-client/client.js'
import { buildCoreContext, assertContextFresh, buildResearchBrief, reviewedResearchScopeSchema } from '../../../orchestration/context/builder.js'
import { guidanceDraftSchema, guidanceResult } from '../../../orchestration/playbooks/guidance-output.js'
import { sourceDocumentSchema } from '../../../orchestration/research/sources.js'
import { createGuidanceAgents } from '../agents/guidance-agents.js'
import { createResearchTools } from '../tools/research.js'
import type { ResearchProvider } from '../tools/research.js'

const routeSchema = z.object({ routeId: z.literal('procedure-guidance/v1'), evidenceId: z.string().min(1).max(128) }).strict()
const inputSchema = z.object({ resultId: internalId }).strict()
const loadedSchema = inputSchema.extend({ artifact: artifactEnvelopeSchema, routing: routeSchema })
const generatedSchema = loadedSchema.extend({ draft: guidanceDraftSchema, sources: z.array(sourceDocumentSchema).max(20) })
const outputSchema = z.object({ resultId: internalId, applied: z.boolean(), reason: z.string().nullable() })

export interface ProcedureGuidanceDependencies {
  backend: Pick<BackendClient, 'context' | 'control' | 'result'>
  models: { core: MastraModelConfig; research: MastraModelConfig }
  scope: z.infer<typeof reviewedResearchScopeSchema>
  catalogs: readonly { id: string; allowedHosts: readonly string[] }[]
  research: ResearchProvider
  signal: AbortSignal
  /** Required host gate: verify real Orch output and record evidence before enabling this workflow. */
  authorizeRoute: () => Promise<z.infer<typeof routeSchema>>
  beforeTool: (kind: 'search' | 'read-source') => Promise<void>
  maxSourceAgeMs: number
  timeoutMs: number
}

/** Workflow definition for a durable host; main.ts does not start it in an unmanaged Promise. */
export function createProcedureGuidanceWorkflow(deps: ProcedureGuidanceDependencies) {
  const scope = reviewedResearchScopeSchema.parse(deps.scope)
  async function checkControl() {
    deps.signal.throwIfAborted()
    if ((await deps.backend.control({ signal: deps.signal })).instruction !== 'CONTINUE') throw new Error('Execution stopped by Backend')
  }
  const load = createStep({
    id: 'load-authorized-guidance-context', inputSchema, outputSchema: loadedSchema,
    execute: async ({ inputData }) => {
      await checkControl()
      const routing = routeSchema.parse(await deps.authorizeRoute())
      const artifact = await deps.backend.context({ signal: deps.signal })
      buildCoreContext(artifact, 'task_guidance')
      return { ...inputData, artifact, routing }
    },
  })
  const generate = createStep({
    id: 'research-and-generate-guidance', inputSchema: loadedSchema, outputSchema: generatedSchema,
    execute: async ({ inputData }) => {
      await checkControl()
      const context = buildCoreContext(inputData.artifact, 'task_guidance')
      const selection = buildResearchBrief(context, scope)
      if (selection.status === 'needs_input') return {
        ...inputData, draft: { status: 'needs_input' as const, where: null, bring: [], steps: [], missing: selection.missing }, sources: [],
      }
      const tools = createResearchTools({
        briefs: [selection.brief], catalogs: deps.catalogs, provider: deps.research, signal: deps.signal,
        maxSourceAgeMs: deps.maxSourceAgeMs, timeoutMs: deps.timeoutMs,
        beforeTool: async kind => { await checkControl(); await deps.beforeTool(kind) },
      })
      const { coreAgent } = createGuidanceAgents({
        models: deps.models, briefs: [selection.brief], signal: deps.signal,
        researchTools: tools.tools, retrievedSourceIds: tools.retrievedSourceIds,
      })
      const response = await coreAgent.generate(JSON.stringify({
        goal: '対象手続きの提出先、必要書類、手順を案内してください。各記述に取得済みsourceIdを対応させ、未確認ならmissingに残してください。',
        context: context.modelInput,
      }), { structuredOutput: { schema: guidanceDraftSchema, errorStrategy: 'strict' }, abortSignal: deps.signal })
      deps.signal.throwIfAborted()
      return { ...inputData, draft: guidanceDraftSchema.parse(response.object), sources: tools.sources(selection.brief.briefId) }
    },
  })
  const report = createStep({
    id: 'revalidate-and-report-guidance', inputSchema: generatedSchema, outputSchema,
    execute: async ({ inputData }) => {
      await checkControl()
      const before = buildCoreContext(inputData.artifact, 'task_guidance')
      const latest = buildCoreContext(await deps.backend.context({ signal: deps.signal }), 'task_guidance')
      assertContextFresh(before, latest)
      if (inputData.sources.some(source => Date.now() - Date.parse(source.fetchedAt) > deps.maxSourceAgeMs)) throw new Error('Guidance sources expired before reporting')
      const target = contextTaskTitle(latest.modelInput.facts)
      const result = guidanceResult({ draft: inputData.draft, sources: inputData.sources, proof: latest.proof, resultId: inputData.resultId, target })
      await checkControl()
      const outcome = await deps.backend.result(result, { requestId: inputData.resultId, signal: deps.signal })
      return { resultId: inputData.resultId, ...outcome }
    },
  })
  return createWorkflow({ id: 'procedure-guidance-v1', inputSchema, outputSchema }).then(load).then(generate).then(report).commit()
}

function contextTaskTitle(facts: ReturnType<typeof buildCoreContext>['modelInput']['facts']) {
  const title = facts.find(fact => fact.group === 'task' && fact.field === 'title')?.value
  if (typeof title !== 'string' || !title || title.length > 200) throw new Error('Task title is unavailable')
  return title
}
