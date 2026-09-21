import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  completeGuidanceAction,
  createGuidanceWorkingState,
  guidancePlanDecisionSchema,
  replanGuidanceState,
} from '../src/orchestration/working-state.js'

const brief = {
  briefId: 'brief-1', procedure: '架空手続き', institution: '架空機関', jurisdiction: '日本',
  sourceCatalogIds: ['catalog-1'], questions: [{ id: 'documents', text: '必要書類を確認する' }],
}
const modelInput = {
  operation: 'task_guidance' as const,
  data: [{ group: 'task' as const, field: 'title', value: '架空手続き', state: 'unknown' as const }],
  limitations: ['推定しない'],
}
const decision = guidancePlanDecisionSchema.parse({
  plan: [
    { action: 'REQUEST_RESEARCH', questionIds: ['documents'] },
    { action: 'GENERATE_GUIDANCE', questionIds: [] },
    { action: 'REPORT', questionIds: [] },
  ],
  nextAction: 'REQUEST_RESEARCH',
})

test('#180 WorkingState advances only through bounded structured actions and keeps an evidence ledger', () => {
  const initial = createGuidanceWorkingState({ decision, brief, modelInput })
  assert.equal(initial.nextAction, 'REQUEST_RESEARCH')
  assert.deepEqual(initial.unknowns, [{ id: 'documents', question: '必要書類を確認する' }])
  assert.equal(Object.hasOwn(initial, 'reasoning'), false)

  const research = { briefs: [brief], outcomes: [{ briefId: 'brief-1', findings: {
    status: 'complete' as const, answers: [{ questionId: 'documents', text: '架空書類', sourceIds: ['source-1'],
      applicability: '日本の架空機関が扱う架空手続き', evidence: [{ sourceId: 'source-1', sectionId: 's1', quote: '架空書類を提出する' }] }],
    missing: [], conflicts: [],
  } }] }
  const researched = completeGuidanceAction(initial, 'REQUEST_RESEARCH', 'GENERATE_GUIDANCE', research)
  assert.deepEqual(researched.completedActions, ['REQUEST_RESEARCH'])
  assert.deepEqual(researched.unknowns, [])
  assert.deepEqual(researched.evidence, [{ questionId: 'documents', sourceId: 'source-1', sectionId: 's1', quote: '架空書類を提出する' }])
  const generated = completeGuidanceAction(researched, 'GENERATE_GUIDANCE', 'REPORT')
  const done = completeGuidanceAction(generated, 'REPORT', 'DONE')
  assert.equal(done.currentStep, 3)
  assert.equal(done.nextAction, 'DONE')
  assert.throws(() => completeGuidanceAction(done, 'REPORT', 'DONE'), /out of order|already completed/)
})

test('#180 plans and replans fail closed outside the finite action budget', async () => {
  assert.equal(guidancePlanDecisionSchema.safeParse({ plan: [{ action: 'REPORT', questionIds: [] }], nextAction: 'REPORT' }).success, false)
  assert.throws(() => createGuidanceWorkingState({
    decision: { ...decision, plan: decision.plan.map(item => item.action === 'REQUEST_RESEARCH' ? { ...item, questionIds: [] } : item) },
    brief, modelInput,
  }), /every approved question/)

  const initial = createGuidanceWorkingState({ decision, brief, modelInput })
  let charged = 0
  const charge = async ({ replans }: { replans: number }) => { charged += replans }
  const replanned = await replanGuidanceState(initial, decision, charge)
  assert.equal(replanned.replanCount, 1)
  assert.equal(charged, 1)
  await assert.rejects(replanGuidanceState(replanned, decision, charge), /limit/)
  assert.equal(charged, 1)
})
