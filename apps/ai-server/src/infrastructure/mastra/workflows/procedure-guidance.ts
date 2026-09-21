import type { AgentBudget } from '../budget-processors.js'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import type { ModelWithRetries } from '@mastra/core/agent'
import type { MastraModelConfig } from '@mastra/core/llm'
import { z } from 'zod'
import { GUIDANCE_LIMITS, artifactEnvelopeSchema, internalId } from '@aftercare/internal-contracts'
import type { BackendClient } from '../../backend-client/client.js'
import { buildCoreContext, assertContextFresh, buildResearchBrief, minimizedModelInput, reviewedResearchScopeSchema } from '../../../orchestration/context/builder.js'
import { guidanceDraftSchema, guidanceResult, unresolvedApplicability } from '../../../orchestration/playbooks/guidance-output.js'
import { sourceDocumentSchema } from '../../../orchestration/research/sources.js'
import { finalizeResearchSynthesis, researchEvidenceSchema, researchSynthesisSchema } from '../../../orchestration/research/contracts.js'
import { createGuidanceAgents } from '../agents/guidance-agents.js'
import { createResearchTools } from '../tools/research.js'
import type { ResearchProvider } from '../tools/research.js'

const routeSchema = z.object({ routeId: z.literal('procedure-guidance/v1'), evidenceId: z.string().min(1).max(128) }).strict()
const inputSchema = z.object({ resultId: internalId }).strict()
const loadedSchema = inputSchema.extend({ artifact: artifactEnvelopeSchema, routing: routeSchema })
const generatedSchema = loadedSchema.extend({ draft: guidanceDraftSchema, sources: z.array(sourceDocumentSchema).max(20), research: researchEvidenceSchema })
const outputSchema = z.object({ resultId: internalId, applied: z.boolean(), reason: z.string().nullable() })

export interface ProcedureGuidanceDependencies {
  budget?: AgentBudget
  backend: Pick<BackendClient, 'context' | 'control' | 'result'>
  models: { core: MastraModelConfig | ModelWithRetries[]; research: MastraModelConfig | ModelWithRetries[] }
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
        ...inputData, draft: { status: 'needs_input' as const, where: null, bring: [], steps: [], missing: selection.missing }, sources: [], research: { briefs: [], outcomes: [] },
      }
      const tools = createResearchTools({
        briefs: [selection.brief], catalogs: deps.catalogs, provider: deps.research, signal: deps.signal,
        maxSourceAgeMs: deps.maxSourceAgeMs, timeoutMs: deps.timeoutMs,
        beforeTool: async kind => {
          await checkControl()
          await deps.budget?.charge(kind === 'search' ? { searches: 1 } : { reads: 1 })
          await deps.beforeTool(kind)
        },
      })
      const { coreAgent, researchAgent } = createGuidanceAgents({
        budget: deps.budget, models: deps.models, briefs: [selection.brief], signal: deps.signal,
        researchTools: tools.tools, retrievedSourceIds: tools.retrievedSourceIds,
      })
      const query = selection.brief.questions.map(question => question.text).join(' ').slice(0, 240)
      const candidates = await tools.execute.search(selection.brief.briefId, query)
      const selectedCandidates = candidates.slice(0, 3)
      if (!selectedCandidates.length) return {
        ...inputData,
        draft: { status: 'needs_input' as const, where: null, bring: [], steps: [], missing: ['確認できる公式資料が見つかりませんでした。'] },
        sources: [],
        research: researchEvidenceSchema.parse({ briefs: [selection.brief], outcomes: [{ briefId: selection.brief.briefId,
          findings: { status: 'needs_input', answers: [], missing: ['確認できる公式資料が見つかりませんでした。'], conflicts: [] } }] }),
      }
      for (const candidate of selectedCandidates) await tools.execute.read(selection.brief.briefId, candidate.id)
      const sources = tools.sources(selection.brief.briefId)
      await deps.budget?.charge({ research: 1 })
      const researchResponse = await researchAgent.generate(JSON.stringify({
        goal: '各questionに公式資料だけで回答し、回答ごとに取得済みsourceIdを付けてください。すべて確認できた場合だけstatusをcompleteにし、確認できない項目はmissingに残してください。',
        brief: selection.brief,
        // 主要コンテンツを見出し単位で渡す。ナビゲーション等は抽出時に除いている（#165）。
        sources: sources.map(({ id, title, issuer, url, fetchedAt, sections }) => ({ id, title, issuer, url, fetchedAt, sections })),
      }), {
        maxSteps: 1, toolChoice: 'none', abortSignal: deps.signal,
        structuredOutput: { schema: researchSynthesisSchema, errorStrategy: 'strict' },
      })
      const findings = finalizeResearchSynthesis(researchResponse.object, selection.brief, tools.retrievedSourceIds(selection.brief.briefId))
      const research = researchEvidenceSchema.parse({ briefs: [selection.brief], outcomes: [{ briefId: selection.brief.briefId, findings }] })
      const response = await coreAgent.generate(JSON.stringify({
        goal: `対象手続きの案内を次の区分で作成してください。
- where: 提出先を1件（${GUIDANCE_LIMITS.where}文字以内）。根拠のsourceIdを付ける。
- bring: 主な必要書類と条件付き追加書類を、書類ごとの配列にする（各${GUIDANCE_LIMITS.bringItem}文字以内）。stepsへまとめず、必ず1件以上を入れる。
- steps: 申請手順、申請期限、注意点を項目ごとの配列にする（各${GUIDANCE_LIMITS.stepItem}文字以内）。
- missing: 公式資料で確認できない事項だけを入れる（各${GUIDANCE_LIMITS.missingItem}文字以内）。
where、bring、stepsがすべて揃いmissingが空の場合だけstatusをcompleteにする。それ以外はpartialまたはneeds_inputにする。
これは制度の一般的な案内です。この案件に当てはまるかの確認はハーネスが別に行います。`,
        // allowlistの項目だけを送る。Case全体は鮮度・scope検証のためハーネスに残す（#166）。
        context: minimizedModelInput(context, 'task_guidance'),
        verifiedResearch: research,
        sources: sources.map(({ id, title, issuer, url, fetchedAt, updatedAt, location }) => ({ id, title, issuer, url, fetchedAt, updatedAt, location })),
        constraint: '調査はハーネスが完了しています。Research Agentへ再委譲せず、verifiedResearchだけを根拠に案内してください。',
      }), {
        maxSteps: 1, toolChoice: 'none',
        structuredOutput: { schema: guidanceDraftSchema, errorStrategy: 'strict' }, abortSignal: deps.signal,
      })
      deps.signal.throwIfAborted()
      return { ...inputData, draft: guidanceDraftSchema.parse(response.object), sources, research }
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
      // 適用条件は最新のContextで判定する。モデルの自己申告では確認済みにしない（#162）。
      const unresolved = unresolvedApplicability(scope.applicabilityChecks ?? [], latest.modelInput.facts)
      const result = guidanceResult({ draft: inputData.draft, sources: inputData.sources, research: inputData.research, proof: latest.proof, resultId: inputData.resultId, target, unresolved })
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
