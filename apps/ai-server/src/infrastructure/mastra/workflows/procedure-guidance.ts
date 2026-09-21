import type { AgentBudget } from '../budget-processors.js'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import type { ModelWithRetries } from '@mastra/core/agent'
import type { MastraModelConfig } from '@mastra/core/llm'
import { z } from 'zod'
import { GUIDANCE_LIMITS, artifactEnvelopeSchema, internalId, guidanceContextAudit } from '@aftercare/internal-contracts'
import type { BackendClient } from '../../backend-client/client.js'
import { buildCoreContext, assertContextFresh, buildProcedureResearchBrief, minimizedModelInput, reviewedResearchScopeSchema } from '../../../orchestration/context/builder.js'
import { GuidanceOutputContractError, guidanceDraftSchema, guidanceResult, unresolvedApplicability } from '../../../orchestration/playbooks/guidance-output.js'
import { sourceDocumentSchema } from '../../../orchestration/research/sources.js'
import { boundResearchSynthesis, finalizeResearchSynthesis, researchBriefSchema, researchEvidenceSchema, researchRequestSchema, researchSynthesisSchema } from '../../../orchestration/research/contracts.js'
import { completeGuidanceAction, createGuidanceWorkingState, guidancePlanDecisionSchema, guidanceResearchPlanDecisionSchema, guidanceWorkingStateSchema } from '../../../orchestration/working-state.js'
import { createGuidanceAgents } from '../agents/guidance-agents.js'
import { createResearchTools } from '../tools/research.js'
import type { ResearchProvider } from '../tools/research.js'

const routeSchema = z.object({ routeId: z.literal('procedure-guidance/v1'), evidenceId: z.string().min(1).max(128) }).strict()
export const PROCEDURE_GUIDANCE_WORKFLOW = 'procedure-guidance-v3'
const inputSchema = z.object({ resultId: internalId }).strict()
const loadedSchema = inputSchema.extend({ artifact: artifactEnvelopeSchema, routing: routeSchema })
const plannedSchema = loadedSchema.extend({ brief: researchBriefSchema.nullable(), workingState: guidanceWorkingStateSchema })
const researchedSchema = plannedSchema.extend({ researchRequest: researchRequestSchema.nullable(), sources: z.array(sourceDocumentSchema).max(20), research: researchEvidenceSchema })
const generatedSchema = researchedSchema.extend({ draft: guidanceDraftSchema })
const outputSchema = z.object({ resultId: internalId, applied: z.boolean(), reason: z.string().nullable(), workingState: guidanceWorkingStateSchema })

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
  /** 非本番だけ true。ProcedureDefinition.reviewStatus !== 'reviewed' の案内を許可する。 */
  allowDraftDefinitions: boolean
  /** 使った Definition と Context key の記録先。値は含めない。 */
  recordContextAudit?: (record: ReturnType<typeof guidanceContextAudit>) => void
}

/**
 * 構造化出力がスキーマに合わない場合だけ、1回だけ生成し直す。
 * OrcaRouter経由のjson_schemaはstrictを指定できず、実モデルの評価（#164）で
 * スキーマ外の要素を返す失敗が一定割合で起きたため。それ以外の失敗は再試行しない。
 */
async function generateStructured<T>(generate: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await generate()
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof Error && /Structured output validation failed/.test(error.message))) throw error
    return generate()
  }
}

/** Workflow definition for a durable host; main.ts does not start it in an unmanaged Promise. */
export function createProcedureGuidanceWorkflow(deps: ProcedureGuidanceDependencies) {
  const scope = reviewedResearchScopeSchema.parse(deps.scope)
  const configuredCatalogIds = new Set(deps.catalogs.map(catalog => catalog.id))
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
  const plan = createStep({
    id: 'plan-guidance-actions', inputSchema: loadedSchema, outputSchema: plannedSchema,
    execute: async ({ inputData }) => {
      await checkControl()
      const context = buildCoreContext(inputData.artifact, 'task_guidance')
      if (context.procedure) deps.recordContextAudit?.(guidanceContextAudit(context.procedure.definition, context.procedure))
      const selection = buildProcedureResearchBrief(context, { scope, allowDraftDefinitions: deps.allowDraftDefinitions, configuredCatalogIds })
      const modelInput = minimizedModelInput(context, 'task_guidance')
      if (selection.status === 'needs_input') {
        const decision = guidancePlanDecisionSchema.parse({ plan: [{ action: 'NEEDS_INPUT', questionIds: [] }, { action: 'REPORT', questionIds: [] }], nextAction: 'NEEDS_INPUT' })
        return { ...inputData, brief: null, workingState: createGuidanceWorkingState({ decision, brief: null, modelInput, missing: selection.missing }) }
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
      const agents = createGuidanceAgents({
        budget: deps.budget, models: deps.models, briefs: [selection.brief], signal: deps.signal,
        researchTools: tools.tools, retrievedSourceIds: tools.retrievedSourceIds,
        coreSkillIds: ['case-assessment'], researchSkillIds: [],
      })
      const response = await generateStructured(() => agents.coreAgent.generate(JSON.stringify({
        goal: '対象手続きの案内を作るために、許可済みの公式調査が必要かを判断してください。内部思考や説明文は出力せず、有限のAction列だけを返してください。',
        context: modelInput,
        approvedBrief: selection.brief,
        requiredPlan: {
          plan: [
            { action: 'REQUEST_RESEARCH', questionIds: selection.brief.questions.map(question => question.id) },
            { action: 'GENERATE_GUIDANCE', questionIds: [] },
            { action: 'REPORT', questionIds: [] },
          ],
          nextAction: 'REQUEST_RESEARCH',
        },
        constraint: 'approvedBriefが構築済みなので、requiredPlanを省略・追加・並べ替えず、そのまま構造化出力してください。',
      }), {
        maxSteps: 1, toolChoice: 'none', abortSignal: deps.signal,
        structuredOutput: { schema: guidanceResearchPlanDecisionSchema, errorStrategy: 'strict' },
      }), deps.signal)
      const decision = guidancePlanDecisionSchema.parse(response.object)
      return { ...inputData, brief: selection.brief, workingState: createGuidanceWorkingState({ decision, brief: selection.brief, modelInput,
        skills: agents.skillRefs.core.map(skill => ({ ...skill, phase: 'plan' as const })) }) }
    },
  })
  const research = createStep({
    id: 'execute-approved-research', inputSchema: plannedSchema, outputSchema: researchedSchema,
    execute: async ({ inputData }) => {
      await checkControl()
      if (inputData.workingState.nextAction === 'NEEDS_INPUT') {
        return { ...inputData, researchRequest: null, sources: [], research: researchEvidenceSchema.parse({ briefs: [], outcomes: [] }) }
      }
      if (inputData.workingState.nextAction !== 'REQUEST_RESEARCH' || !inputData.brief) throw new Error('Working state does not authorize research')
      const tools = createResearchTools({
        briefs: [inputData.brief], catalogs: deps.catalogs, provider: deps.research, signal: deps.signal,
        maxSourceAgeMs: deps.maxSourceAgeMs, timeoutMs: deps.timeoutMs,
        beforeTool: async kind => {
          await checkControl()
          await deps.budget?.charge(kind === 'search' ? { searches: 1 } : { reads: 1 })
          await deps.beforeTool(kind)
        },
      })
      const agents = createGuidanceAgents({
        budget: deps.budget, models: deps.models, briefs: [inputData.brief], signal: deps.signal,
        researchTools: tools.tools, retrievedSourceIds: tools.retrievedSourceIds, evidenceSources: tools.sources,
        coreSkillIds: ['research-briefing'], researchSkillIds: ['official-source-research', 'evidence-reconciliation'],
      })
      const approvedResearchRequest = researchRequestSchema.parse({
        briefId: inputData.brief.briefId,
        questionIds: inputData.brief.questions.map(question => question.id),
        sourceCatalogIds: inputData.brief.sourceCatalogIds,
      })
      await agents.coreAgent.generate(JSON.stringify({
        action: 'REQUEST_RESEARCH',
        instruction: '検索・資料取得・根拠抽出を検索Agentへ1回だけ委任してください。委任promptにはapprovedResearchRequestのJSONだけをそのまま渡し、説明、案件情報、個人情報を追加しません。検証済み結果を受け取ったら短く完了を返してください。',
        approvedResearchRequest,
      }), { maxSteps: 8, abortSignal: deps.signal })
      const requests = agents.researchRequests()
      if (requests.length !== 1) throw new Error('Core Agent did not produce exactly one approved research request')
      const researchRequest = requests[0]!
      const sources = tools.sources(inputData.brief.briefId)
      let research = agents.researchEvidence()
      let findings = research.outcomes[0]?.findings
      if (!findings && sources.length && agents.researchOutputNeedsRepair()) {
        // A schema-invalid synthesis gets one bounded repair using only the
        // already retrieved official sections. Search and read tools are not
        // repeated, and the same quote verifier still decides what is usable.
        const repaired = await agents.researchAgent.generate(JSON.stringify({
          instruction: '前回の調査出力は契約に適合しませんでした。検索や取得を繰り返さず、次の取得済み資料だけから正しいJSONを1回だけ再生成してください。各evidence.quoteは逐語引用かつ200文字以内にし、長い箇所は必要な部分だけを複数のquoteへ分けてください。',
          brief: inputData.brief,
          sources: sources.map(({ id, title, issuer, url, fetchedAt, sections }) => ({ id, title, issuer, url, fetchedAt, sections })),
        }), {
          maxSteps: 1,
          toolChoice: 'none',
          abortSignal: deps.signal,
          structuredOutput: { schema: researchSynthesisSchema, errorStrategy: 'warn' },
        })
        findings = finalizeResearchSynthesis(boundResearchSynthesis(repaired.object), inputData.brief, sources)
        research = researchEvidenceSchema.parse({ briefs: [inputData.brief], outcomes: [{ briefId: inputData.brief.briefId, findings }] })
      }
      if (!findings) throw new Error('Research Agent did not return validated findings')
      if (!sources.length) {
        const missing = findings.missing[0] ?? '確認できる公式資料が見つかりませんでした。'
        const completed = completeGuidanceAction(inputData.workingState, 'REQUEST_RESEARCH', 'NEEDS_INPUT', research,
          [...agents.skillRefs.core, ...agents.skillRefs.research].map(skill => ({ ...skill, phase: 'research' as const })))
        const workingState = guidanceWorkingStateSchema.parse({ ...completed, unknowns: [...completed.unknowns, { id: 'official-source', question: missing }] })
        return { ...inputData, researchRequest, sources, research, workingState }
      }
      const workingState = completeGuidanceAction(inputData.workingState, 'REQUEST_RESEARCH', 'GENERATE_GUIDANCE', research,
        [...agents.skillRefs.core, ...agents.skillRefs.research].map(skill => ({ ...skill, phase: 'research' as const })))
      return { ...inputData, researchRequest, sources, research, workingState }
    },
  })
  const generate = createStep({
    id: 'generate-grounded-guidance', inputSchema: researchedSchema, outputSchema: generatedSchema,
    execute: async ({ inputData }) => {
      await checkControl()
      if (inputData.workingState.nextAction === 'NEEDS_INPUT') {
        const missing = inputData.workingState.unknowns.map(item => item.question)
        const draft = guidanceDraftSchema.parse({ status: 'needs_input', where: null, bring: [], steps: [], missing })
        return { ...inputData, draft, workingState: completeGuidanceAction(inputData.workingState, 'NEEDS_INPUT', 'REPORT') }
      }
      if (inputData.workingState.nextAction !== 'GENERATE_GUIDANCE' || !inputData.brief) throw new Error('Working state does not authorize guidance generation')
      const context = buildCoreContext(inputData.artifact, 'task_guidance')
      const tools = createResearchTools({
        briefs: [inputData.brief], catalogs: deps.catalogs, provider: deps.research, signal: deps.signal,
        maxSourceAgeMs: deps.maxSourceAgeMs, timeoutMs: deps.timeoutMs,
        beforeTool: async () => { throw new Error('Guidance generation cannot execute research tools') },
      })
      const agents = createGuidanceAgents({
        budget: deps.budget, models: deps.models, briefs: [inputData.brief], signal: deps.signal,
        researchTools: tools.tools, retrievedSourceIds: tools.retrievedSourceIds,
        coreSkillIds: ['grounded-guidance'], researchSkillIds: [],
      })
      const findings = inputData.research.outcomes[0]?.findings
      if (!findings) throw new Error('Guidance generation requires a completed research action')
      const coreInput = {
        goal: `対象手続きの案内を次の区分で作成してください。
- where: 提出先・提出方法を1件（${GUIDANCE_LIMITS.where}文字以内）。
- bring: 主な必要書類と条件付き追加書類を、書類ごとの配列にする（各${GUIDANCE_LIMITS.bringItem}文字以内）。stepsへまとめず、必ず1件以上を入れる。
- steps: 申請手順、支給額、申請期限、注意点を項目ごとの配列にする（各${GUIDANCE_LIMITS.stepItem}文字以内）。
- missing: 公式資料で確認できない事項だけを入れる（各${GUIDANCE_LIMITS.missingItem}文字以内）。
各項目のquestionIdsには、その項目の根拠となるanswersのquestionIdを入れる。
- 項目はanswersのevidence（公式資料からの引用）に書かれている内容だけで書く。textは要約で、evidenceに無い書類・金額・期限・提出先・提出方法（窓口への持参、特定の支部名や自治体、最寄りの支部など）を足さない。
- answersにあるquestionIdごとに、少なくとも1つの項目で扱う。給付の種類（埋葬料・埋葬費・家族埋葬料）で条件・支給額・起算日が異なる場合は、種類ごとに書き分ける。
- 条件によって内容が変わる場合は条件を省かない。
ハーネスが各項目をevidenceと照合し、根拠の無い項目は表示しません。すべてのquestionを扱えた場合だけstatusをcompleteにする。
これは制度の一般的な案内です。この案件に当てはまるかの確認はハーネスが別に行います。`,
        // allowlistの項目だけを送る。Case全体は鮮度・scope検証のためハーネスに残す（#166）。
        context: minimizedModelInput(context, 'task_guidance'),
        questions: inputData.brief.questions,
        answers: findings.answers.map(({ questionId, text, evidence }) => ({ questionId, text, evidence: evidence?.map(item => item.quote) ?? [] })),
        researchStatus: findings.status,
        researchMissing: findings.missing,
        constraint: '調査はハーネスが完了しています。Research Agentへ再委譲せず、answersだけを根拠に案内してください。',
      }
      let draft: z.infer<typeof guidanceDraftSchema> | undefined
      let validationIssues: { path: PropertyKey[]; code: string; message: string }[] = []
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await checkControl()
        const response = await agents.coreAgent.generate(JSON.stringify({
          ...coreInput,
          ...(attempt ? { repair: {
            instruction: '前回の出力は契約に適合しませんでした。内容を省略せず、項目を分けて上限内のJSONを再生成してください。文字列を途中で切りません。',
            validationIssues,
          } } : {}),
        }), {
          maxSteps: 1, toolChoice: 'none',
          structuredOutput: { schema: guidanceDraftSchema, errorStrategy: 'warn' }, abortSignal: deps.signal,
        })
        const parsed = guidanceDraftSchema.safeParse(response.object)
        if (parsed.success) { draft = parsed.data; break }
        validationIssues = parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code, message: issue.message }))
      }
      if (!draft) throw new GuidanceOutputContractError()
      deps.signal.throwIfAborted()
      return { ...inputData, draft, workingState: completeGuidanceAction(inputData.workingState, 'GENERATE_GUIDANCE', 'REPORT', undefined,
        agents.skillRefs.core.map(skill => ({ ...skill, phase: 'generate' as const }))) }
    },
  })
  const report = createStep({
    id: 'revalidate-and-report-guidance', inputSchema: generatedSchema, outputSchema,
    execute: async ({ inputData }) => {
      await checkControl()
      if (inputData.workingState.nextAction !== 'REPORT') throw new Error('Working state does not authorize reporting')
      const before = buildCoreContext(inputData.artifact, 'task_guidance')
      const latest = buildCoreContext(await deps.backend.context({ signal: deps.signal }), 'task_guidance')
      assertContextFresh(before, latest)
      if (inputData.sources.some(source => Date.now() - Date.parse(source.fetchedAt) > deps.maxSourceAgeMs)) throw new Error('Guidance sources expired before reporting')
      // 表示名は Definition の title。Task の表示名は Context に来ない。
      const target = latest.procedure?.definition.title ?? null
      // 適用条件・grounding 規則は、この手続きに対応する審査済み scope のものだけを使う。
      const scoped = latest.procedure && scope.procedureIds.includes(latest.procedure.definition.id)
      // 適用条件は最新のContextで判定する。モデルの自己申告では確認済みにしない（#162）。
      const unresolved = unresolvedApplicability(scoped ? scope.applicabilityChecks ?? [] : [], latest.modelInput.facts)
      const result = guidanceResult({ draft: inputData.draft, sources: inputData.sources, research: inputData.research, proof: latest.proof, resultId: inputData.resultId, target, unresolved,
        ...(scoped && scope.groundingRules ? { rules: scope.groundingRules } : {}) })
      await checkControl()
      const outcome = await deps.backend.result(result, { requestId: inputData.resultId, signal: deps.signal })
      return { resultId: inputData.resultId, ...outcome,
        workingState: completeGuidanceAction(inputData.workingState, 'REPORT', 'DONE') }
    },
  })
  return createWorkflow({ id: PROCEDURE_GUIDANCE_WORKFLOW, inputSchema, outputSchema }).then(load).then(plan).then(research).then(generate).then(report).commit()
}

