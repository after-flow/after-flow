import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChatReplyWorkflow } from '../src/infrastructure/mastra/workflows/chat-reply.js'
import type { ChatReplyDependencies } from '../src/infrastructure/mastra/workflows/chat-reply.js'
import { contentHash } from '../src/orchestration/context/builder.js'
import { chatReplyResult } from '../src/orchestration/playbooks/chat-output.js'
import { scriptedModel } from './helpers/scripted-model.js'
import type { InternalResult } from '@aftercare/internal-contracts'

function setup() {
  const core = scriptedModel([{ text: JSON.stringify({ paragraphs: [], questions: ['対象の手続きを教えていただけますか？'], professionalNotice: false }) }])
  const research = scriptedModel([])
  const content = { operation: 'chat_reply', case: { id: 'case', version: 1, municipality: '架空市' }, message: { id: 'message', version: 1, role: 'user', body: 'PRIVATE-MESSAGE 手続きを教えてください。' }, documents: [] }
  const artifact = { caseVersion: 1, contextSnapshotId: 'context', fencingToken: 1, artifactVersion: 1, contentHash: contentHash(content), content,
    expiresAt: new Date(Date.now() + 60000).toISOString() }
  const reported: InternalResult[] = []
  const deps: ChatReplyDependencies = { models: { core: core.model, research: research.model }, signal: new AbortController().signal,
    backend: { context: async () => structuredClone(artifact), control: async () => ({ instruction: 'CONTINUE', reason: null, caseVersion: 1 }),
      result: async value => { reported.push(value); return { applied: true, reason: null } } },
    authorizeRoute: async () => ({ routeId: 'chat-reply/v1', evidenceId: 'fixture-orch-only' }),
    scope: { id: 'brief', version: '1', reviewedAt: '2026-09-01T00:00:00Z', procedure: '架空手続き', institution: '架空機関', jurisdiction: '架空市', municipality: '架空市',
      taskTitles: ['架空手続き'], taskCategories: ['fixture'], sourceCatalogIds: ['catalog'], questions: [{ id: 'where', text: '提出先を確認する' }] },
    catalogs: [{ id: 'catalog', allowedHosts: ['official.example'] }], timeoutMs: 1000, maxSourceAgeMs: 60000,
    beforeTool: async () => {}, research: { search: async () => { throw new Error('Unexpected external lookup') }, read: async () => { throw new Error('Unexpected read') } },
  }
  return { deps, artifact, reported, core, research }
}

test('chat clarification uses real Mastra and existing chat_reply contract without inventing facts', async () => {
  const { deps, reported, core, research } = setup()
  const result = await (await createChatReplyWorkflow(deps).createRun()).start({ inputData: { resultId: 'result' } })
  assert.equal(result.status, 'success', JSON.stringify(result)); assert.equal(core.calls.length, 1); assert.equal(research.calls.length, 0)
  assert.equal(reported[0]?.kind, 'chat_reply')
  if (reported[0]?.kind !== 'chat_reply') assert.fail()
  assert.match(reported[0].body, /対象の手続き/); assert.equal(reported[0].professionalNotice, false)
})

test('chat context change blocks delivery and factual paragraphs require completed verified research', async () => {
  const { deps, artifact, reported } = setup(); let calls = 0
  deps.backend.context = async () => { const value = structuredClone(artifact); if (++calls > 1) value.caseVersion++; return value }
  const result = await (await createChatReplyWorkflow(deps).createRun()).start({ inputData: { resultId: 'result' } })
  assert.equal(result.status, 'failed'); assert.equal(reported.length, 0)
  assert.throws(() => chatReplyResult({ resultId: 'result', proof: artifact, sources: [], research: { briefs: [], outcomes: [] },
    draft: { paragraphs: [{ text: '未確認の説明', sourceIds: ['invented'] }], questions: [], professionalNotice: false } }))
})

test('grounded chat uses the research agent and renders citations without forwarding private messages', async () => {
  const { deps, reported } = setup()
  const source = { id: 'source', catalogId: 'catalog', title: '合成資料', issuer: '架空機関', url: 'https://official.example/source' }
  const core = scriptedModel([{ tool: 'agent-researchAgent', input: { prompt: JSON.stringify({ briefId: 'brief' }) } },
    { text: JSON.stringify({ paragraphs: [{ text: '合成資料の窓口へ確認してください。', sourceIds: ['source'] }], questions: [], professionalNotice: true }) }])
  const research = scriptedModel([{ tool: 'searchOfficialSources', input: { query: '窓口' } }, { tool: 'readOfficialSource', input: { sourceId: 'source' } },
    { text: JSON.stringify({ status: 'complete', answers: [{ questionId: 'where', text: '合成窓口', sourceIds: ['source'], applicability: '架空市' }], missing: [], conflicts: [] }) }])
  deps.models = { core: core.model, research: research.model }
  deps.research = { search: async () => [source], read: async () => ({ ...source, text: '合成窓口へ確認する。', location: '1項', fetchedAt: new Date().toISOString(), updatedAt: null }) }
  const result = await (await createChatReplyWorkflow(deps).createRun()).start({ inputData: { resultId: 'grounded-result' } })
  assert.equal(result.status, 'success', JSON.stringify(result))
  assert.equal(research.calls.length, 3)
  assert.equal(JSON.stringify(research.calls).includes('PRIVATE-MESSAGE'), false)
  assert.equal(reported[0]?.kind, 'chat_reply')
  if (reported[0]?.kind !== 'chat_reply') assert.fail()
  assert.match(reported[0].body, /https:\/\/official.example\/source/)
  assert.equal(reported[0].professionalNotice, true)
})
