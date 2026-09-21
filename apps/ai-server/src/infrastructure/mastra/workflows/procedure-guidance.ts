import type { AgentBudget } from '../budget-processors.js'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import type { ModelWithRetries } from '@mastra/core/agent'
import type { MastraModelConfig } from '@mastra/core/llm'
import { z } from 'zod'
import { GUIDANCE_LIMITS, artifactEnvelopeSchema, internalId } from '@aftercare/internal-contracts'
import type { BackendClient } from '../../backend-client/client.js'
import { buildCoreContext, assertContextFresh, buildResearchBrief, minimizedModelInput, reviewedResearchScopeSchema } from '../../../orchestration/context/builder.js'
import { guidanceDraftSchema, guidanceResult, unresolvedApplicability } from '../../../orchestration/playbooks/guidance-output.js'
import type { GuidanceDiagnostics } from '../../../orchestration/playbooks/guidance-output.js'
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
  /** 案内の組み立てで除いた項目などの診断情報（本文なし）。評価とメトリクスに使う。 */
  observeGuidance?: (diagnostics: GuidanceDiagnostics) => void
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
        goal: `各questionに、渡した公式資料の本文だけで回答してください。
- 回答ごとにevidenceを1〜5件付ける。evidenceは根拠となる本文をsections[].textからそのまま写したquote（2〜200文字）と、そのsourceIdとsectionIdにする。要約・言い換え・補足をquoteに入れない。
- quoteに無い金額・期限・提出先・提出方法をtextに書かない。
- 資料で確認できない問いはanswersに入れずmissingに残す。資料どうしの記載が食い違う場合はconflictsに書く。
- すべての問いを確認できた場合だけstatusをcompleteにする。
引用は本文と照合し、一致しない回答は採用しません。`,
        brief: selection.brief,
        // 主要コンテンツを見出し単位で渡す。ナビゲーション等は抽出時に除いている（#165）。
        sources: sources.map(({ id, title, issuer, url, fetchedAt, sections }) => ({ id, title, issuer, url, fetchedAt, sections })),
      }), {
        maxSteps: 1, toolChoice: 'none', abortSignal: deps.signal,
        structuredOutput: { schema: researchSynthesisSchema, errorStrategy: 'strict' },
      })
      // 引用が本文と一致しない回答はここで捨てる（#163）。
      const findings = finalizeResearchSynthesis(researchResponse.object, selection.brief, sources)
      const research = researchEvidenceSchema.parse({ briefs: [selection.brief], outcomes: [{ briefId: selection.brief.briefId, findings }] })
      const response = await coreAgent.generate(JSON.stringify({
        goal: `対象手続きの案内を次の区分で作成してください。
- where: 提出先・提出方法を1件（${GUIDANCE_LIMITS.where}文字以内）。
- bring: 主な必要書類と条件付き追加書類を、書類ごとの配列にする（各${GUIDANCE_LIMITS.bringItem}文字以内）。stepsへまとめず、必ず1件以上を入れる。
- steps: 申請手順、支給額、申請期限、注意点を項目ごとの配列にする（各${GUIDANCE_LIMITS.stepItem}文字以内）。
- missing: 公式資料で確認できない事項だけを入れる（各${GUIDANCE_LIMITS.missingItem}文字以内）。
各項目のquestionIdsには、その項目の根拠となるanswersのquestionIdを入れる。
answersのtextとevidenceに書かれていない金額・期限・提出先・提出方法（窓口への持参、特定の支部名や自治体など）を足さない。条件によって内容が変わる場合は条件を省かない。
ハーネスが各項目をevidenceと照合し、根拠の無い項目は表示しません。すべてのquestionを扱えた場合だけstatusをcompleteにする。
これは制度の一般的な案内です。この案件に当てはまるかの確認はハーネスが別に行います。`,
        // allowlistの項目だけを送る。Case全体は鮮度・scope検証のためハーネスに残す（#166）。
        context: minimizedModelInput(context, 'task_guidance'),
        questions: selection.brief.questions,
        answers: findings.answers.map(({ questionId, text, evidence }) => ({ questionId, text, evidence: evidence?.map(item => item.quote) ?? [] })),
        researchStatus: findings.status,
        researchMissing: findings.missing,
        constraint: '調査はハーネスが完了しています。Research Agentへ再委譲せず、answersだけを根拠に案内してください。',
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
      const result = guidanceResult({ draft: inputData.draft, sources: inputData.sources, research: inputData.research, proof: latest.proof, resultId: inputData.resultId, target, unresolved,
        rules: scope.groundingRules, onDiagnostics: deps.observeGuidance })
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
