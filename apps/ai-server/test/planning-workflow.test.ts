import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCasePlanningWorkflow } from '../src/infrastructure/mastra/workflows/case-planning.js'
import { buildPlanningContext, contentHash } from '../src/orchestration/context/builder.js'
import { planningDraftSchema, validatePlan } from '../src/orchestration/playbooks/planning-output.js'
import type { ReviewedTaskTemplate } from '../src/orchestration/playbooks/planning-output.js'
import { scriptedModel } from './helpers/scripted-model.js'
import { createResearchTools } from '../src/infrastructure/mastra/tools/research.js'

const template: ReviewedTaskTemplate = { id: 'template', version: 'v1', reviewedAt: '2026-09-01T00:00:00Z', expiresAt: new Date(Date.now() + 600000).toISOString(), reviewReference: 'synthetic', sourceCatalogIds: ['catalog'],
  task: { title: '合成手続き', summary: '合成窓口に確認', stage: 'government', category: 'fixture', submitTo: '架空機関', evidenceRequired: true, assetDisposal: false },
  prerequisites: [{ group: 'case', field: 'municipality', value: '架空市', state: 'user_reported' }], requiredDocuments: ['合成資料'] }
const candidate = { id: 'source', catalogId: 'catalog', title: '合成資料', issuer: '架空機関', url: 'https://official.example/fixture' }
const source = { ...candidate, text: '合成手続きの確認に合成資料を用いる。', location: '1項', fetchedAt: new Date().toISOString(), updatedAt: null }
function artifact() {
  const content = { operation: 'case_planning', case: { id: 'case', version: 1, municipality: '架空市' }, documents: [],
    tasks: [{ id: 'existing', version: 2, title: '既存の手動手続き', source: 'MANUAL', submitTo: '架空機関', dependencyTaskIds: [] }],
    planningHistory: { complete: true, proposals: [], versions: [], approvals: [] } }
  return { caseVersion: 1, contextSnapshotId: 'context', fencingToken: 1, artifactVersion: 1, contentHash: contentHash(content), content, expiresAt: new Date(Date.now() + 60000).toISOString() }
}
const draft = { tasks: [{ templateId: 'template', sourceIds: ['source'], dependencyTaskIds: ['existing'] }], questions: [] }

test('planner produces bounded template differences through two native Mastra agents', async () => {
  const signal = new AbortController().signal
  const core = scriptedModel([{ tool: 'agent-researchAgent', input: { prompt: JSON.stringify({ briefId: 'brief' }) } }, { text: JSON.stringify(draft) }])
  const research = scriptedModel([{ tool: 'searchOfficialSources', input: { query: '必要資料' } }, { tool: 'readOfficialSource', input: { sourceId: 'source' } },
    { text: JSON.stringify({ status: 'complete', answers: [{ questionId: 'requirements', text: '合成資料', sourceIds: ['source'], applicability: '架空市' }], missing: [], conflicts: [] }) }])
  const brief = { briefId: 'brief', procedure: '合成手続き', institution: '架空機関', jurisdiction: '架空市', sourceCatalogIds: ['catalog'], questions: [{ id: 'requirements', text: '必要な資料' }] }
  const tools = createResearchTools({ briefs: [brief], catalogs: [{ id: 'catalog', allowedHosts: ['official.example'] }], signal, timeoutMs: 1000, maxSourceAgeMs: 60000,
    beforeTool: async () => {}, provider: { search: async () => [candidate], read: async () => source } })
  const context = artifact()
  const workflow = createCasePlanningWorkflow({ signal, templates: [template], maxSourceAgeMs: 60000,
    backend: { context: async () => structuredClone(context), control: async () => ({ instruction: 'CONTINUE', reason: null, caseVersion: 1 }) },
    prepare: async () => ({ routing: { routeId: 'case-planning/v1', evidenceId: 'synthetic-orch' }, agents: { models: { core: core.model, research: research.model }, signal, briefs: [brief], researchTools: tools.tools, retrievedSourceIds: tools.retrievedSourceIds }, sources: () => tools.sources('brief') }) })
  const result = await (await workflow.createRun()).start({ inputData: { runId: 'run' } })
  assert.equal(result.status, 'success', JSON.stringify(result))
  if (result.status !== 'success') assert.fail()
  assert.equal(result.result.proposals.length, 1)
  const proposal = result.result.proposals[0]!
  assert.deepEqual(proposal.draft.payload.dependencyTaskIds, ['existing'])
  assert.equal((proposal.draft.payload.requiredDocuments as { label: string }[])[0]?.label, '合成資料')
  assert.deepEqual(proposal.draft.basis.map(ref => [ref.id, ref.version]), [['existing', 2]])
})

test('planning gates preserve manual tasks and previous rejected/changed titles, and refuse foreign dependencies or invented deadlines', () => {
  const input = artifact(); const context = buildPlanningContext(input)
  const validate = (templates = [template]) => validatePlan({ runId: 'run', context, draft, templates, sources: [source] })
  assert.equal(validate([{ ...template, task: { ...template.task, title: '既存の手動手続き' } }]).skipped[0]?.reason, 'EXISTING_TASK')
  assert.equal(validate([{ ...template, prerequisites: [{ ...template.prerequisites[0]!, value: '別の市' }] }]).skipped[0]?.reason, 'PREREQUISITE_UNKNOWN')
  context.modelInput.planningHistory!.versions.push({ proposalId: 'old', proposalVersion: 1, payloadHash: contentHash({}), title: '過去案', summary: '', targetTitle: template.task.title, supersedesProposalVersion: null })
  assert.equal(validate().skipped[0]?.reason, 'PREVIOUS_PROPOSAL')
  context.modelInput.planningHistory!.versions = []
  assert.throws(() => validatePlan({ runId: 'run', context, draft: { ...draft, tasks: [{ ...draft.tasks[0]!, dependencyTaskIds: ['foreign'] }] }, templates: [template], sources: [source] }), /outside/)
  assert.equal(planningDraftSchema.safeParse({ ...draft, deadline: '2026-10-01' }).success, false)
})
