import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RequestContext } from '@mastra/core/request-context'
import { noopObserve } from '@mastra/core/tools'
import type { InternalResult } from '@aftercare/internal-contracts'
import { contentHash } from '../src/orchestration/context/builder.js'
import { createResearchTools } from '../src/infrastructure/mastra/tools/research.js'
import { createProcedureGuidanceWorkflow } from '../src/infrastructure/mastra/workflows/procedure-guidance.js'
import type { ProcedureGuidanceDependencies } from '../src/infrastructure/mastra/workflows/procedure-guidance.js'
import { scriptedModel } from './helpers/scripted-model.js'

const candidate = { id: 'source-1', catalogId: 'catalog-1', title: '架空機関の資料', issuer: '架空機関', url: 'https://official.example/procedure' }
const scope = { id: 'brief-1', version: '1', reviewedAt: '2026-09-01T00:00:00Z', procedure: '架空手続き',
  institution: '架空機関', jurisdiction: '架空市', municipality: '架空市', taskTitles: ['架空手続き'], taskCategories: ['insurance'],
  sourceCatalogIds: ['catalog-1'], questions: [{ id: 'documents', text: '提出先、必要書類、手順は何か' }] }
const brief = { briefId: scope.id, procedure: scope.procedure, institution: scope.institution, jurisdiction: scope.jurisdiction,
  questions: scope.questions, sourceCatalogIds: scope.sourceCatalogIds }
const claim = (text: string) => ({ text, sourceIds: ['source-1'] })
const draft = { status: 'complete', where: claim('架空機関の窓口'), bring: [claim('架空書類A')], steps: [claim('窓口で確認する')], missing: [] }
const findings = { status: 'complete', answers: [{ questionId: 'documents', text: '窓口で架空書類Aを確認する', sourceIds: ['source-1'], applicability: '架空市の架空手続き' }], missing: [], conflicts: [] }

function setup() {
  const core = scriptedModel([
    { tool: 'agent-researchAgent', input: { prompt: JSON.stringify({ briefId: 'brief-1' }) } }, { text: JSON.stringify(draft) },
  ])
  const research = scriptedModel([
    { tool: 'searchOfficialSources', input: { query: '必要書類' } },
    { tool: 'readOfficialSource', input: { sourceId: 'source-1' } }, { text: JSON.stringify(findings) },
  ])
  const content = { operation: 'task_guidance', case: { id: 'case-1', version: 1, deceasedName: 'PRIVATE-NAME', municipality: '架空市', knownAt: null },
    task: { id: 'task-1', version: 1, title: '架空手続き', category: 'insurance', submitTo: '架空機関' }, documents: [] }
  const artifact = { caseVersion: 1, contextSnapshotId: 'snapshot-1', fencingToken: 1, artifactVersion: 1, contentHash: contentHash(content),
    expiresAt: new Date(Date.now() + 60000).toISOString(), content }
  const reported: InternalResult[] = []
  const controls: string[] = []
  const deps: ProcedureGuidanceDependencies = {
    backend: {
      async control() { controls.push('control'); return { instruction: 'CONTINUE', reason: null, caseVersion: 1 } },
      async context() { return structuredClone(artifact) },
      async result(value) { reported.push(value); return { applied: true, reason: null } },
    },
    models: { core: core.model, research: research.model }, scope,
    catalogs: [{ id: 'catalog-1', allowedHosts: ['official.example'] }], signal: new AbortController().signal,
    async authorizeRoute() { return { routeId: 'procedure-guidance/v1', evidenceId: 'fixture-routing-receipt' } },
    async beforeTool(kind) { controls.push(kind) }, maxSourceAgeMs: 60000, timeoutMs: 1000,
    research: {
      async search() { return [candidate] },
      async read() { return { ...candidate, text: '架空書類Aを架空機関の窓口で確認する。', location: '第1項', fetchedAt: new Date().toISOString(), updatedAt: null } },
    },
  }
  return { deps, reported, core, research, controls, artifact }
}

test('P-01 uses both real Mastra agents and tools, rechecks context, and reports the frontend contract', async () => {
  const { deps, reported, core, research, controls } = setup()
  const run = await createProcedureGuidanceWorkflow(deps).createRun()
  const result = await run.start({ inputData: { resultId: 'result-1' } })
  assert.equal(result.status, 'success', JSON.stringify(result))
  assert.equal(reported.length, 1)
  assert.equal(reported[0].kind, 'task_guidance')
  if (reported[0].kind !== 'task_guidance') assert.fail()
  assert.equal(reported[0].status, 'COMPLETED')
  assert.deepEqual(reported[0].bring, ['架空書類A'])
  assert.deepEqual(reported[0].sources.map(source => source.url), [candidate.url])
  assert.equal(core.calls.length, 2)
  assert.equal(research.calls.length, 3)
  assert.ok(!JSON.stringify(research.calls).includes('PRIVATE-NAME'))
  assert.ok(controls.includes('search') && controls.includes('read-source'))
})

test('changed case or revoked permission prevents result submission', async () => {
  for (const revoke of [false, true]) {
    const { deps, reported, artifact } = setup()
    let contextCalls = 0
    deps.backend.context = async () => ({ ...structuredClone(artifact), caseVersion: ++contextCalls > 1 ? 2 : 1 })
    if (revoke) deps.backend.control = async () => ({ instruction: 'STOP', reason: 'CONSENT_REVOKED', caseVersion: null })
    const run = await createProcedureGuidanceWorkflow(deps).createRun()
    assert.equal((await run.start({ inputData: { resultId: 'result-1' } })).status, 'failed')
    assert.equal(reported.length, 0)
  }
})

test('unsupported institution asks for input without calling models or searching', async () => {
  const { deps, reported, core, research } = setup()
  deps.scope = { ...scope, institution: '別の機関' }
  const run = await createProcedureGuidanceWorkflow(deps).createRun()
  assert.equal((await run.start({ inputData: { resultId: 'result-1' } })).status, 'success')
  assert.equal(core.calls.length, 0)
  assert.equal(research.calls.length, 0)
  assert.equal(reported[0].kind, 'task_guidance')
  if (reported[0].kind !== 'task_guidance') assert.fail()
  assert.equal(reported[0].status, 'PARTIAL')
  assert.ok(reported[0].missing.length)
})

test('route gate must succeed before any model call', async () => {
  const { deps, reported, core, research } = setup()
  deps.authorizeRoute = async () => { throw new Error('Orch not connected') }
  const run = await createProcedureGuidanceWorkflow(deps).createRun()
  assert.equal((await run.start({ inputData: { resultId: 'result-1' } })).status, 'failed')
  assert.equal(core.calls.length + research.calls.length + reported.length, 0)
})

test('tools reject off-catalog sources, unsearched IDs and cancellation before provider I/O', async () => {
  const { deps } = setup()
  let reads = 0
  const controller = new AbortController()
  const result = createResearchTools({ ...deps, briefs: [brief], signal: controller.signal,
    provider: { async search() { return [{ ...candidate, url: 'https://attacker.example/' }] }, async read(input) { reads++; return deps.research.read(input) } },
  })
  const requestContext = new RequestContext<unknown>([['researchBriefId', 'brief-1']])
  const toolContext = { requestContext, observe: noopObserve }
  await assert.rejects(result.tools.searchOfficialSources.execute!({ query: '必要書類' }, toolContext))
  await assert.rejects(result.tools.readOfficialSource.execute!({ sourceId: 'source-1' }, toolContext))
  assert.equal(reads, 0)
  controller.abort()
  await assert.rejects(result.tools.searchOfficialSources.execute!({ query: '必要書類' }, toolContext))
})
