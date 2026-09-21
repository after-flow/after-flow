import { z } from 'zod'
import type { MinimizedModelInput } from './context/builder.js'
import type { ResearchBrief, ResearchEvidence } from './research/contracts.js'

export const guidanceActionSchema = z.enum(['REQUEST_RESEARCH', 'GENERATE_GUIDANCE', 'REPORT', 'NEEDS_INPUT', 'DONE'])
export type GuidanceAction = z.infer<typeof guidanceActionSchema>

const planActionSchema = z.object({
  action: guidanceActionSchema.exclude(['DONE']),
  questionIds: z.array(z.string().min(1).max(128)).max(12).default([]),
}).strict()

/** The Core Agent chooses only from this finite plan surface. It does not emit reasoning text. */
export const guidancePlanDecisionSchema = z.object({
  plan: z.array(planActionSchema).min(1).max(4),
  nextAction: guidanceActionSchema.exclude(['DONE']),
}).strict().superRefine((decision, ctx) => {
  if (decision.plan[0]?.action !== decision.nextAction) {
    ctx.addIssue({ code: 'custom', message: 'nextAction must be the first planned action' })
  }
  const actions = decision.plan.map(item => item.action)
  const valid = actions.join(',') === 'REQUEST_RESEARCH,GENERATE_GUIDANCE,REPORT' || actions.join(',') === 'NEEDS_INPUT,REPORT'
  if (!valid) ctx.addIssue({ code: 'custom', message: 'Unsupported guidance plan' })
})
export type GuidancePlanDecision = z.infer<typeof guidancePlanDecisionSchema>

const knownFactSchema = z.object({
  key: z.string().min(1).max(128), value: z.string().max(300),
  state: z.enum(['confirmed', 'user_reported', 'extracted_candidate', 'unknown']),
}).strict()

const evidenceLedgerEntrySchema = z.object({
  questionId: z.string().min(1).max(128), sourceId: z.string().min(1).max(128),
  sectionId: z.string().regex(/^s\d{1,3}$/), quote: z.string().min(2).max(200),
}).strict()

/**
 * Durable, reviewable execution state. It contains decisions and evidence references only;
 * hidden reasoning, credentials and Backend clients never enter the workflow snapshot.
 */
export const guidanceWorkingStateSchema = z.object({
  goal: z.string().min(1).max(300),
  plan: z.array(planActionSchema).min(1).max(4),
  knownFacts: z.array(knownFactSchema).max(20),
  unknowns: z.array(z.object({ id: z.string().min(1).max(128), question: z.string().min(1).max(300) }).strict()).max(20),
  evidence: z.array(evidenceLedgerEntrySchema).max(60),
  completedActions: z.array(guidanceActionSchema.exclude(['DONE'])).max(4),
  currentStep: z.number().int().min(0).max(4),
  nextAction: guidanceActionSchema,
  replanCount: z.number().int().min(0).max(1),
}).strict().superRefine((state, ctx) => {
  if (new Set(state.completedActions).size !== state.completedActions.length) {
    ctx.addIssue({ code: 'custom', message: 'Completed actions must be unique' })
  }
  if (state.currentStep !== state.completedActions.length) {
    ctx.addIssue({ code: 'custom', message: 'Current step must match completed actions' })
  }
})
export type GuidanceWorkingState = z.infer<typeof guidanceWorkingStateSchema>

export function createGuidanceWorkingState(input: {
  decision: GuidancePlanDecision
  brief: ResearchBrief | null
  modelInput: MinimizedModelInput
  missing?: readonly string[]
}): GuidanceWorkingState {
  const decision = guidancePlanDecisionSchema.parse(input.decision)
  if (decision.nextAction === 'REQUEST_RESEARCH') {
    if (!input.brief) throw new Error('Research plan requires an approved brief')
    const required = new Set(input.brief.questions.map(question => question.id))
    const requested = new Set(decision.plan[0]!.questionIds)
    if (required.size !== requested.size || [...required].some(id => !requested.has(id))) {
      throw new Error('Research plan must cover every approved question')
    }
  }
  const unknowns = input.brief
    ? input.brief.questions.map(item => ({ id: item.id, question: item.text }))
    : (input.missing ?? []).map((question, index) => ({ id: `missing-${index + 1}`, question }))
  return guidanceWorkingStateSchema.parse({
    goal: '確認済みの公式資料に基づいて対象手続きの案内を作成し、未確認事項を明示する。',
    plan: decision.plan,
    knownFacts: input.modelInput.data.map(fact => ({ key: `${fact.group}.${fact.field}`, value: String(fact.value).slice(0, 300), state: fact.state })),
    unknowns, evidence: [], completedActions: [], currentStep: 0,
    nextAction: decision.nextAction, replanCount: 0,
  })
}

export function completeGuidanceAction(
  stateInput: GuidanceWorkingState,
  completed: Exclude<GuidanceAction, 'DONE'>,
  nextAction: GuidanceAction,
  research?: ResearchEvidence,
): GuidanceWorkingState {
  const state = guidanceWorkingStateSchema.parse(stateInput)
  if (state.nextAction !== completed || state.completedActions.includes(completed)) {
    throw new Error('Guidance action is out of order or already completed')
  }
  const evidence = research ? research.outcomes.flatMap(outcome => outcome.findings?.answers ?? []).flatMap(answer =>
    (answer.evidence ?? []).map(item => ({ questionId: answer.questionId, ...item }))) : state.evidence
  const answered = new Set(evidence.map(item => item.questionId))
  const unresolvedResearch = research ? research.outcomes.flatMap(outcome => {
    const findings = outcome.findings
    if (!findings) return [{ id: `research-${outcome.briefId}`, question: '公式資料の調査を完了できませんでした。' }]
    return [...findings.missing, ...findings.conflicts.map(item => `公式資料の記載が食い違っています: ${item}`)]
      .map((question, index) => ({ id: `research-${outcome.briefId}-${index + 1}`, question: question.slice(0, 300) }))
  }) : []
  const unknowns = research
    ? [...state.unknowns.filter(item => !answered.has(item.id)), ...unresolvedResearch].slice(0, 20)
    : state.unknowns
  return guidanceWorkingStateSchema.parse({
    ...state,
    evidence,
    unknowns,
    completedActions: [...state.completedActions, completed],
    currentStep: state.currentStep + 1,
    nextAction,
  })
}

export async function replanGuidanceState(
  stateInput: GuidanceWorkingState,
  decisionInput: GuidancePlanDecision,
  charge: (cost: { replans: number }) => Promise<void>,
): Promise<GuidanceWorkingState> {
  const state = guidanceWorkingStateSchema.parse(stateInput)
  if (state.replanCount >= 1) throw new Error('Guidance replan limit reached')
  await charge({ replans: 1 })
  const decision = guidancePlanDecisionSchema.parse(decisionInput)
  return guidanceWorkingStateSchema.parse({
    ...state, plan: decision.plan, nextAction: decision.nextAction, replanCount: state.replanCount + 1,
  })
}
