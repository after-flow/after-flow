import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPlanningExecutionWorkflow, PLANNING_EXECUTION } from '../../src/infrastructure/mastra/workflows/planning-execution.js'
import { Mastra } from '@mastra/core/mastra'
import { randomUUID } from 'node:crypto'
import { createRuntimeFirestore } from '../../src/infrastructure/runtime-storage/firestore.js'
import { createRuntimeStore, FirestoreWorkflowsStorage } from '../../src/infrastructure/runtime-storage/workflows.js'
import { contentHash } from '../../src/orchestration/context/builder.js'
import type { ReviewedTaskTemplate } from '../../src/orchestration/playbooks/planning-output.js'
import { scriptedModel } from '../helpers/scripted-model.js'
import { createResearchTools } from '../../src/infrastructure/mastra/tools/research.js'
import { sourceDocument } from '../helpers/source-document.js'

const template: ReviewedTaskTemplate = { id: 'template', version: 'v1', reviewedAt: '2026-09-01T00:00:00Z', expiresAt: new Date(Date.now() + 600000).toISOString(), reviewReference: 'synthetic', sourceCatalogIds: ['catalog'],
  task: { title: '合成手続き', summary: '合成窓口に確認', stage: 'government', category: 'fixture', submitTo: '架空機関', evidenceRequired: true, assetDisposal: false },
  prerequisites: [{ group: 'case', field: 'municipality', value: '架空市', state: 'user_reported' }], requiredDocuments: ['合成資料'] }
const candidate = { id: 'source', catalogId: 'catalog', title: '合成資料', issuer: '架空機関', url: 'https://official.example/fixture' }
const source = sourceDocument(candidate, '合成手続きの確認に合成資料を用いる。')
function artifact() {
  const content = { operation: 'case_planning', planningRestriction: null, case: { id: 'case', version: 1, municipality: '架空市' }, documents: [],
    tasks: [{ id: 'existing', version: 2, title: '既存の手動手続き', source: 'MANUAL', submitTo: '架空機関', dependencyTaskIds: [] }],
    planningHistory: { complete: true, proposals: [], versions: [], approvals: [] } }
  return { caseVersion: 1, contextSnapshotId: 'context', fencingToken: 1, artifactVersion: 1, contentHash: contentHash(content), content, expiresAt: new Date(Date.now() + 60000).toISOString() }
}
const draft = { tasks: [{ templateId: 'template', sourceIds: ['source'], dependencyTaskIds: ['existing'] }], questions: [] }


test('planning approval resumes a stored plan without re-running agents or submitting twice', { skip: !process.env.AI_RUNTIME_EMULATOR_HOST }, async () => {
  for (const reviewState of ['current', 'changed', 'expired', 'restricted'] as const) {
  const signal = new AbortController().signal
  const core = scriptedModel([{ tool: 'agent-researchAgent', input: { prompt: JSON.stringify({ briefId: 'brief' }) } }, { text: JSON.stringify(draft) }])
  const research = scriptedModel([{ tool: 'searchOfficialSources', input: { query: '必要資料' } }, { tool: 'readOfficialSource', input: { sourceId: 'source' } },
    { text: JSON.stringify({ status: 'complete', answers: [{ questionId: 'requirements', text: '合成資料', sourceIds: ['source'], applicability: '架空市' }], missing: [], conflicts: [] }) }])
  const brief = { briefId: 'brief', procedure: '合成手続き', institution: '架空機関', jurisdiction: '架空市', sourceCatalogIds: ['catalog'], questions: [{ id: 'requirements', text: '必要な資料' }] }
  const tools = createResearchTools({ briefs: [brief], catalogs: [{ id: 'catalog', allowedHosts: ['official.example'] }], signal, timeoutMs: 1000, maxSourceAgeMs: 60000,
    beforeTool: async () => {}, provider: { search: async () => [candidate], read: async () => source } })

  const db = createRuntimeFirestore(); const snapshots = new FirestoreWorkflowsStorage(db)
  let context: Omit<ReturnType<typeof artifact>, 'content'> & { content: Record<string, unknown> } = artifact()
  let submissions = 0; let preparations = 0; let reports = 0
  let actionId = ''; let payloadHash = ''
  const oldId = randomUUID(); const newId = randomUUID()
  const deps: Parameters<typeof createPlanningExecutionWorkflow>[0] = { signal, templates: [template], maxSourceAgeMs: 60000,
    previousAttemptId: null, allowedKinds: ['TASK_PROPOSAL'], guard: async () => {}, registerWait: async id => assert.equal(id, 'wait'),
    backend: { context: async () => structuredClone(context), control: async () => ({ instruction: 'CONTINUE', reason: null, caseVersion: context.caseVersion }),
      propose: async input => { submissions++; actionId = input.proposalId; payloadHash = contentHash(input.payload); return { proposalId: 'proposal', approvalId: 'approval', proposalVersion: 1, payloadHash, waitRequestId: 'wait', applicationStatus: 'NOT_APPLIED' } },
      result: async input => { reports++; assert.equal(input.kind, 'case_planning'); assert.equal('status' in input && input.status, reviewState === 'current' ? 'SUCCEEDED' : 'NEEDS_ATTENTION'); return { applied: true, reason: null } } },
    prepare: async () => { preparations++; return { routing: { routeId: 'case-planning/v1', evidenceId: 'synthetic-orch' }, agents: { models: { core: core.model, research: research.model }, signal, briefs: [brief], researchTools: tools.tools, retrievedSourceIds: tools.retrievedSourceIds }, sources: () => tools.sources('brief') } } }
  try {
    const first = new Mastra({ storage: createRuntimeStore(db), workflows: { workflow: createPlanningExecutionWorkflow(deps) } })
    const result = await (await first.getWorkflow('workflow').createRun({ runId: oldId })).start({ inputData: { runId: 'run', resultId: 'result' } })
    assert.equal(result.status, 'suspended', JSON.stringify(result)); assert.equal(reports, 0)
    const content = { ...context.content, planningRestriction: reviewState === 'restricted' ? { reason: 'pause after approval' } : null, actions: [{ id: 'proposal', actionId, proposalVersion: 1, payloadHash, status: 'APPLIED' }], resume: { previousAttemptId: 'old', kind: 'WAIT', waitRequestId: 'wait', snapshotId: oldId, outcome: 'APPLIED' } }
    context = { ...context, caseVersion: 2, content, contentHash: contentHash(content) }
    await snapshots.forkSuspendedSnapshot({ workflowName: PLANNING_EXECUTION, fromRunId: oldId, toRunId: newId })
    const currentTemplates = reviewState === 'changed' ? [{ ...template, version: 'v2' }] : reviewState === 'expired' ? [{ ...template, expiresAt: '2020-01-01T00:00:00Z' }] : [template]
    const next = new Mastra({ storage: createRuntimeStore(db), workflows: { workflow: createPlanningExecutionWorkflow({ ...deps, templates: currentTemplates, previousAttemptId: 'old' }) } })
    const resumed = await (await next.getWorkflow('workflow').createRun({ runId: newId })).resume({ resumeData: { resume: true } })
    assert.equal(resumed.status, 'success', JSON.stringify(resumed)); assert.equal(reports, 1); assert.equal(submissions, 1); assert.equal(preparations, 1)
  } finally { await db.terminate() }
  }
})
