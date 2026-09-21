import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { Mastra } from '@mastra/core/mastra'
import { createProposalWorkflow, PROPOSAL_WORKFLOW } from '../../src/infrastructure/mastra/workflows/proposal.js'
import type { ProposalWorkflowDependencies } from '../../src/infrastructure/mastra/workflows/proposal.js'
import { createRuntimeFirestore } from '../../src/infrastructure/runtime-storage/firestore.js'
import { createRuntimeStore, FirestoreWorkflowsStorage } from '../../src/infrastructure/runtime-storage/workflows.js'
import { actionIdFor } from '../../src/orchestration/actions/contracts.js'
import { contentHash } from '../../src/orchestration/context/builder.js'

const options = { skip: !process.env.AI_RUNTIME_EMULATOR_HOST }

test('native proposal suspend/fork/resume confirms exact applied version without resubmitting a completed step', options, async () => {
  const db = createRuntimeFirestore(); const snapshots = new FirestoreWorkflowsStorage(db)
  try {
    for (const state of ['APPLIED', 'REJECTED', 'AWAITING_APPROVAL', 'CHANGED'] as const) {
      const oldId = randomUUID(); const newId = randomUUID(); const actionId = actionIdFor('run-one', 'planning-v1', 'slot-one')
      const payload = { title: '合成確認', summary: 'fixture', stage: 'government', category: 'fixture' }
      const payloadHash = contentHash(payload)
      const initialContent = { operation: 'case_planning', planningRestriction: null, actions: [], resume: null, documents: [], tasks: [] }
      let context = { caseVersion: 1, contextSnapshotId: 'context-one', fencingToken: 1, artifactVersion: 1, contentHash: contentHash(initialContent),
        content: initialContent as Record<string, unknown>, expiresAt: new Date(Date.now() + 60000).toISOString() }
      let submissions = 0; let registered: string | undefined
      const deps: ProposalWorkflowDependencies = { signal: new AbortController().signal, previousAttemptId: null, allowedKinds: ['TASK_PROPOSAL'], guard: async () => {},
        registerWait: async id => { registered = id }, backend: {
          control: async () => ({ instruction: 'CONTINUE', reason: null, caseVersion: context.caseVersion }), context: async () => structuredClone(context),
          propose: async input => { submissions++; assert.equal(input.proposalId, actionId); return { proposalId: 'proposal-one', approvalId: 'approval-one', proposalVersion: 1, payloadHash, waitRequestId: 'wait-one', applicationStatus: 'NOT_APPLIED' } },
        } }
      const workflow = createProposalWorkflow(deps)
      const first = new Mastra({ storage: createRuntimeStore(db), workflows: { workflow } })
      const run = await first.getWorkflow('workflow').createRun({ runId: oldId })
      const initial = await run.start({ inputData: { actionId, draft: { kind: 'TASK_PROPOSAL', title: '合成提案', summary: '', payload, basis: [], assetDisposal: false }, context } })
      assert.equal(initial.status, 'suspended'); assert.equal(registered, 'wait-one')
      const newContent = { ...initialContent, actions: [{ id: 'proposal-one', actionId, status: state === 'CHANGED' ? 'APPLIED' : state,
        proposalVersion: state === 'CHANGED' ? 2 : 1, payloadHash }], resume: { previousAttemptId: 'old-attempt', kind: 'WAIT', waitRequestId: 'wait-one', snapshotId: oldId, outcome: state === 'REJECTED' ? 'REJECTED' : 'APPLIED' } }
      context = { ...context, caseVersion: 2, contextSnapshotId: 'context-two', fencingToken: 2, content: newContent, contentHash: contentHash(newContent) }
      await snapshots.forkSuspendedSnapshot({ workflowName: PROPOSAL_WORKFLOW, fromRunId: oldId, toRunId: newId })
      await assert.rejects(snapshots.forkSuspendedSnapshot({ workflowName: PROPOSAL_WORKFLOW, fromRunId: oldId, toRunId: newId }), /already exists/)
      const resumedWorkflow = createProposalWorkflow({ ...deps, previousAttemptId: 'old-attempt' })
      const next = new Mastra({ storage: createRuntimeStore(db), workflows: { workflow: resumedWorkflow } })
      const resumed = await (await next.getWorkflow('workflow').createRun({ runId: newId })).resume({ resumeData: { resume: true } })
      assert.equal(resumed.status, 'success', JSON.stringify(resumed))
      if (resumed.status !== 'success') assert.fail()
      assert.equal(resumed.result.outcome, state === 'AWAITING_APPROVAL' ? 'NOT_APPLIED' : state)
      assert.equal(submissions, 1)
      assert.equal((await snapshots.loadWorkflowSnapshot({ workflowName: PROPOSAL_WORKFLOW, runId: oldId }))?.status, 'suspended')
      assert.equal((await snapshots.loadWorkflowSnapshot({ workflowName: PROPOSAL_WORKFLOW, runId: newId }))?.status, 'success')
    }
  } finally { await db.terminate() }
})
