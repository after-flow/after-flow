import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChatReplyWorkflow } from '../src/infrastructure/mastra/workflows/chat-reply.js'
import type { ChatReplyDependencies } from '../src/infrastructure/mastra/workflows/chat-reply.js'
import { contentHash } from '../src/orchestration/context/builder.js'
import { chatReplyResult } from '../src/orchestration/playbooks/chat-output.js'
import { scriptedModel } from './helpers/scripted-model.js'
import type { InternalResult } from '@aftercare/internal-contracts'
import { sourceDocument } from './helpers/source-document.js'

function setup() {
  const core = scriptedModel([{ text: JSON.stringify({ paragraphs: [], questions: ['対象の手続きを教えていただけますか？'], professionalNotice: false }) }])
  const research = scriptedModel([])
  const content = { operation: 'chat_reply', case: { id: 'case', version: 1, municipality: '架空市' }, message: { id: 'message', version: 1, role: 'user', body: 'PRIVATE-MESSAGE 手続きを教えてください。' }, documents: [] }
  const artifact = { caseVersion: 1, contextSnapshotId: 'context', fencingToken: 1, artifactVersion: 1, contentHash: contentHash(content), content,
    expiresAt: new Date(Date.now() + 60000).toISOString() }
  const reported: InternalResult[] = []
  const providerCalls = { searches: 0, reads: 0 }
  const deps: ChatReplyDependencies = { models: { core: core.model, research: research.model }, signal: new AbortController().signal,
    backend: { context: async () => structuredClone(artifact), control: async () => ({ instruction: 'CONTINUE', reason: null, caseVersion: 1 }),
      result: async value => { reported.push(value); return { applied: true, reason: null } } },
    authorizeRoute: async () => ({ routeId: 'chat-reply/v1', evidenceId: 'fixture-orch-only' }),
    scope: { id: 'brief', version: '1', reviewedAt: '2026-09-01T00:00:00Z', procedure: '架空手続き', institution: '架空機関', jurisdiction: '架空市', municipality: '架空市',
      procedureIds: ['fixture-procedure'], sourceCatalogIds: ['catalog'], sourceCatalogVersions: { catalog: '1' }, questions: [{ id: 'where', text: '提出先を確認する' }] },
    catalogs: [{ id: 'catalog', allowedHosts: ['official.example'] }], timeoutMs: 1000, maxSourceAgeMs: 60000,
    beforeTool: async () => {}, research: { search: async () => { providerCalls.searches++; return [] }, read: async () => { providerCalls.reads++; throw new Error('Unexpected read') } },
  }
  return { deps, artifact, reported, core, research, providerCalls }
}

test('chat always searches the approved catalog and asks a bounded question when no official source matches', async () => {
  const { deps, reported, core, research, providerCalls } = setup()
  const result = await (await createChatReplyWorkflow(deps).createRun()).start({ inputData: { resultId: 'result' } })
  assert.equal(result.status, 'success', JSON.stringify(result)); assert.equal(core.calls.length, 0); assert.equal(research.calls.length, 0)
  assert.equal(providerCalls.searches, 1); assert.equal(providerCalls.reads, 0)
  assert.equal(reported[0]?.kind, 'chat_reply')
  if (reported[0]?.kind !== 'chat_reply') assert.fail()
  assert.match(reported[0].body, /公式資料/); assert.equal(reported[0].professionalNotice, false)
})

test('chat context change blocks delivery and factual paragraphs require verified research', async () => {
  const { deps, artifact, reported } = setup(); let calls = 0
  deps.backend.context = async () => { const value = structuredClone(artifact); if (++calls > 1) value.caseVersion++; return value }
  const result = await (await createChatReplyWorkflow(deps).createRun()).start({ inputData: { resultId: 'result' } })
  assert.equal(result.status, 'failed'); assert.equal(reported.length, 0)
  assert.throws(() => chatReplyResult({ resultId: 'result', proof: artifact, sources: [], research: { briefs: [], outcomes: [] },
    draft: { paragraphs: [{ text: '未確認の説明', sourceIds: ['invented'] }], questions: [], professionalNotice: false } }))
})

test('grounded chat answers with partial verified findings without exposing research gaps or private messages', async () => {
  const { deps, reported, providerCalls } = setup()
  const source = { id: 'source', catalogId: 'catalog', title: '合成資料', issuer: '架空機関', url: 'https://official.example/source' }
  const core = scriptedModel([{ text: JSON.stringify({ paragraphs: [{ text: '合成資料の窓口へ確認してください。', sourceIds: ['source'] }],
    questions: ['amount（支給額の具体的金額）'], professionalNotice: true }) }])
  const research = scriptedModel([{ text: JSON.stringify({ status: 'partial', answers: [{ questionId: 'where', text: '合成窓口',
    evidence: [{ sourceId: 'source', sectionId: 's1', quote: '合成窓口へ確認する。' }] }], missing: ['支給額は未確認'], conflicts: [] }) }])
  deps.models = { core: core.model, research: research.model }
  deps.research = { search: async () => { providerCalls.searches++; return [source] },
    read: async () => { providerCalls.reads++; return sourceDocument(source, '合成窓口へ確認する。') } }
  const result = await (await createChatReplyWorkflow(deps).createRun()).start({ inputData: { resultId: 'grounded-result' } })
  assert.equal(result.status, 'success', JSON.stringify(result))
  assert.equal(research.calls.length, 1); assert.equal(core.calls.length, 1)
  assert.deepEqual(providerCalls, { searches: 1, reads: 1 })
  assert.equal(JSON.stringify(research.calls).includes('PRIVATE-MESSAGE'), false)
  assert.equal(reported[0]?.kind, 'chat_reply')
  if (reported[0]?.kind !== 'chat_reply') assert.fail()
  assert.match(reported[0].body, /https:\/\/official.example\/source/)
  assert.doesNotMatch(reported[0].body, /amount/)
  assert.equal(reported[0].professionalNotice, true)
})
