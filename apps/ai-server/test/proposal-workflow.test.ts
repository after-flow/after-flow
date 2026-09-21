import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProposalWorkflow } from '../src/infrastructure/mastra/workflows/proposal.js'
import { actionIdFor } from '../src/orchestration/actions/contracts.js'
import { contentHash } from '../src/orchestration/context/builder.js'

test('action identity is independent of attempt and denied/bad-hash proposals never enter waiting', async () => {
  const actionId = actionIdFor('run', 'planning-v1', 'slot')
  assert.equal(actionIdFor('run', 'planning-v1', 'slot'), actionId)
  assert.notEqual(actionIdFor('other-run', 'planning-v1', 'slot'), actionId)
  for (const allowed of [false, true]) {
    let submitted = 0; let waits = 0
    const content = { operation: 'case_planning', planningRestriction: null, documents: [], tasks: [] }
    const context = { caseVersion: 1, contextSnapshotId: 'context', fencingToken: 1, artifactVersion: 1, contentHash: contentHash(content), content, expiresAt: new Date(Date.now() + 60000).toISOString() }
    const workflow = createProposalWorkflow({ signal: new AbortController().signal, previousAttemptId: null, allowedKinds: allowed ? ['TASK_PROPOSAL'] : [], guard: async () => {},
      registerWait: async () => { waits++ }, backend: {
        context: async () => context, control: async () => ({ instruction: 'CONTINUE', reason: null, caseVersion: 1 }),
        propose: async () => { submitted++; return { proposalId: 'proposal', approvalId: 'approval', proposalVersion: 1, payloadHash: contentHash({ tampered: true }), waitRequestId: 'wait', applicationStatus: 'NOT_APPLIED' } },
      } })
    const result = await (await workflow.createRun()).start({ inputData: { actionId, context, draft: { kind: 'TASK_PROPOSAL', title: 'fixture', summary: '', payload: {}, basis: [], assetDisposal: false } } })
    assert.equal(result.status, 'failed'); assert.equal(submitted, allowed ? 1 : 0); assert.equal(waits, 0)
  }
})


test('proposal submission fails closed for missing or active owner restriction before contacting Backend', async () => {
  for (const restriction of [undefined, { reason: 'do not plan' }]) {
    const content = { operation: 'case_planning', documents: [], tasks: [], ...(restriction ? { planningRestriction: restriction } : {}) }
    const context = { caseVersion: 1, contextSnapshotId: 'context', fencingToken: 1, artifactVersion: 1,
      content, contentHash: contentHash(content), expiresAt: new Date(Date.now() + 60000).toISOString() }
    const workflow = createProposalWorkflow({ signal: new AbortController().signal, previousAttemptId: null,
      allowedKinds: ['TASK_PROPOSAL'], guard: async () => {}, registerWait: async () => assert.fail('unexpected wait'),
      backend: { context: async () => context, control: async () => ({ instruction: 'CONTINUE', reason: null, caseVersion: 1 }),
        propose: async () => assert.fail('unexpected proposal') } })
    const result = await (await workflow.createRun()).start({ inputData: { actionId: 'action', context,
      draft: { kind: 'TASK_PROPOSAL', title: 'fixture', summary: '', payload: {}, basis: [], assetDisposal: false } } })
    assert.equal(result.status, 'failed')
  }
})
