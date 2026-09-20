import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertContextFresh, buildCoreContext, buildPlanningContext, buildResearchBrief, contentHash, ContextError } from '../src/orchestration/context/builder.js'

function artifact(operation: 'case_planning' | 'task_guidance' = 'case_planning') {
  const content = {
    operation,
    case: { id: 'case-1', version: 1, deceasedName: 'PRIVATE-NAME', dateOfDeath: '2026-01-01', knownAt: null, municipality: '架空市', status: 'ACTIVE' },
    ...(operation === 'task_guidance' ? { task: { id: 'task-1', version: 1, title: '架空手続き', category: 'insurance', submitTo: '架空機関', summary: 'PRIVATE-CONTRACT-123' } } : {
      assets: [
        { id: 'asset-1', version: 2, amount: 0, confirmation: { state: 'CONFIRMED', confirmedVersion: 1 } },
        { id: 'asset-2', version: 1, amount: 100, confirmation: { state: 'UNCONFIRMED' } },
      ],
      decisions: [
        { id: 'decision-1', version: 1, personId: 'person-1', method: 'RENUNCIATION', state: 'REPORTED' },
        { id: 'decision-2', version: 2, personId: 'person-2', method: 'SIMPLE_ACCEPTANCE', state: 'CONFIRMED' },
      ],
    }),
    documents: [{ id: 'doc-1', version: 1, kind: 'OTHER', contentAvailable: false }],
    actions: [{ id: 'proposal-1', actionId: 'action-1', status: 'APPLIED', proposalVersion: 1 }],
    resume: { snapshotId: 'snapshot-private' },
  }
  return { caseVersion: 1, contextSnapshotId: 'snapshot-1', fencingToken: 1, artifactVersion: 1,
    contentHash: contentHash(content), expiresAt: new Date(Date.now() + 60000).toISOString(), content }
}
const scope = {
  id: 'research-1', version: '1', reviewedAt: '2026-09-01T00:00:00Z', procedure: '架空手続き',
  institution: '架空機関', jurisdiction: '架空市', municipality: '架空市', sourceCatalogIds: ['catalog-1'],
  taskTitles: ['架空手続き'], taskCategories: ['insurance'],
  questions: [{ id: 'documents', text: '必要な書類は何ですか' }],
}

test('context separates confirmation, reported decisions and unknown facts without treating null as zero', () => {
  const context = buildCoreContext(artifact(), 'case_planning')
  const fact = (entity: string, field: string) => context.modelInput.facts.find(value => value.entityId === entity && value.field === field)
  assert.equal(fact('asset-1', 'amount')?.state, 'confirmed')
  assert.equal(fact('asset-1', 'amount')?.value, 0)
  assert.equal(fact('asset-2', 'amount')?.state, 'unknown')
  assert.equal(fact('case-1', 'knownAt')?.state, 'unknown')
  assert.equal(fact('case-1', 'knownAt')?.value, null)
  assert.equal(fact('decision-1', 'method')?.state, 'user_reported')
  assert.equal(fact('decision-2', 'method')?.state, 'confirmed')
  assert.ok(!JSON.stringify(context.modelInput).includes('snapshot-private'))
  assert.ok(context.modelInput.limitations.some(value => value.includes('訂正')))
})

test('artifact verification rejects hash tampering, stale context, operation mismatch and unknown fields', () => {
  const source = artifact()
  assert.throws(() => buildCoreContext({ ...source, contentHash: 'b'.repeat(43) }, 'case_planning'))
  assert.throws(() => buildCoreContext({ ...source, expiresAt: '2020-01-01T00:00:00Z' }, 'case_planning'), { code: 'EXPIRED_CONTEXT' })
  assert.throws(() => buildCoreContext(source, 'chat_reply'))
  const changed = { ...source.content, credentials: 'secret' }
  assert.throws(() => buildCoreContext({ ...source, content: changed, contentHash: contentHash(changed) }, 'case_planning'))
  const document = { ...source.content, documents: [{ id: 'doc-1', version: 1, kind: 'OTHER', contentAvailable: true, text: 'unchecked' }] }
  assert.throws(() => buildCoreContext({ ...source, content: document, contentHash: contentHash(document) }, 'case_planning'))
})

test('Backend state and descriptive facts keep distinct provenance within the same entity', () => {
  const source = artifact()
  const content = { ...source.content,
    tasks: [{ id: 'task-1', version: 1, status: 'SUBMITTED', stage: 'government', title: '申告された手続き', source: 'MANUAL', submitTo: null }],
    contracts: [{ id: 'contract-1', version: 1, progressState: 'NOT_STARTED', policyState: 'UNKNOWN', provider: '申告先' }],
    deadlines: [{ id: 'deadline-1', version: 1, confirmation: 'UNCONFIRMED', dueDate: '2026-10-01' }],
  }
  const context = buildCoreContext({ ...source, content, contentHash: contentHash(content) }, 'case_planning')
  const state = (id: string, field: string) => context.modelInput.facts.find(f => f.entityId === id && f.field === field)?.state
  for (const [id, field] of [['case-1', 'status'], ['task-1', 'status'], ['task-1', 'stage'], ['task-1', 'source'],
    ['contract-1', 'progressState'], ['contract-1', 'policyState'], ['deadline-1', 'confirmation'],
    ['asset-2', 'confirmation'], ['decision-1', 'state'], ['decision-1', 'personId']]) {
    assert.equal(state(id!, field!), 'confirmed', `${id}.${field}`)
  }
  assert.equal(state('case-1', 'deceasedName'), 'user_reported')
  assert.equal(state('case-1', 'municipality'), 'user_reported')
  for (const [id, field] of [['task-1', 'title'], ['task-1', 'submitTo'], ['contract-1', 'provider'], ['deadline-1', 'dueDate'], ['asset-2', 'amount']]) {
    assert.equal(state(id!, field!), 'unknown', `${id}.${field}`)
  }
  assert.equal(state('decision-1', 'method'), 'user_reported')
  assert.ok(context.modelInput.limitations.some(text => text.includes('外部機関による受理')))

  // The singular task_guidance target must use the same field policy as planning tasks.
  const { tasks, ...rest } = content
  const target = { ...rest, operation: 'task_guidance', task: tasks[0] }
  const guidance = buildCoreContext({ ...source, content: target, contentHash: contentHash(target) }, 'task_guidance')
  assert.equal(guidance.modelInput.facts.find(f => f.group === 'task' && f.field === 'status')?.state, 'confirmed')
  assert.equal(guidance.modelInput.facts.find(f => f.group === 'task' && f.field === 'stage')?.state, 'confirmed')
})

test('size limits reject instead of dropping decisions, and fresh checks detect case changes', () => {
  const source = artifact()
  assert.throws(() => buildCoreContext(source, 'case_planning', { maxBytes: 20 }), { code: 'CONTEXT_TOO_LARGE' })
  const before = buildCoreContext(source, 'case_planning')
  assertContextFresh(before, before)
  assert.throws(() => assertContextFresh(before, { ...before, proof: { ...before.proof, caseVersion: 2 } }), { code: 'CONTEXT_CHANGED' })
  assert.throws(() => assertContextFresh(before, { ...before, proof: { ...before.proof, contentHash: 'b'.repeat(43) } }), ContextError)
})

test('research context uses reviewed strings only, leaving names, contract titles and transport state behind', () => {
  const context = buildCoreContext(artifact('task_guidance'), 'task_guidance')
  const result = buildResearchBrief(context, scope)
  assert.equal(result.status, 'ready')
  const serialized = JSON.stringify(result)
  assert.ok(!serialized.includes('PRIVATE'))
  assert.ok(!serialized.includes('case-1'))
  assert.ok(!serialized.includes('snapshot'))
  assert.equal(buildResearchBrief(context, { ...scope, municipality: '別の市' }).status, 'needs_input')
  assert.throws(() => buildResearchBrief(context, { ...scope, sourceCatalogIds: [] }))
})

test('canonical hash is independent of object key order but preserves array order', () => {
  assert.equal(contentHash({ b: 2, a: 1 }), contentHash({ a: 1, b: 2 }))
  assert.notEqual(contentHash([1, 2]), contentHash([2, 1]))
})

test('message role is Backend metadata; only user message bodies are user reported', () => {
  for (const role of ['user', 'assistant']) {
    const source = artifact()
    const content = { operation: 'chat_reply', case: source.content.case,
      message: { id: 'message-1', version: 1, role, body: '架空の内容' }, documents: [] }
    const context = buildCoreContext({ ...source, content, contentHash: contentHash(content) }, 'chat_reply')
    const facts = context.modelInput.facts.filter(f => f.group === 'message')
    assert.equal(facts.find(f => f.field === 'role')?.state, 'confirmed')
    assert.equal(facts.find(f => f.field === 'body')?.state, role === 'user' ? 'user_reported' : 'unknown')
  }
})


test('planning requires complete versioned correction/rejection history, while guidance excludes it', () => {
  const input = artifact()
  assert.throws(() => buildPlanningContext(input), { code: 'PLANNING_HISTORY_UNAVAILABLE' })
  const hash = contentHash({ title: '合成手続き' })
  const history = { complete: true, proposals: [{ id: 'p1', actionId: 'a1', proposalVersion: 1, payloadHash: hash, status: 'REJECTED',
    kind: 'TASK_PROPOSAL', source: 'AI', title: '合成提案', summary: 'fixture', targetTitle: '合成手続き', targetTaskId: null, assetDisposal: false, supersedesProposalVersion: null }],
    versions: [{ proposalId: 'p1', proposalVersion: 1, payloadHash: hash, title: '合成提案', summary: 'fixture', targetTitle: '合成手続き', supersedesProposalVersion: null }],
    approvals: [{ proposalId: 'p1', proposalVersion: 1, payloadHash: hash, status: 'REJECTED', applicationStatus: 'NOT_APPLIED', decisionNote: 'PRIVATE-REJECTION-NOTE', applicationFailureReason: null }] }
  const content = { ...input.content, planningHistory: history }
  const result = buildPlanningContext({ ...input, content, contentHash: contentHash(content) })
  assert.equal(result.modelInput.planningHistory.proposals[0]?.status, 'REJECTED')
  const incomplete = { ...content, planningHistory: { ...history, versions: [] } }
  assert.throws(() => buildPlanningContext({ ...input, content: incomplete, contentHash: contentHash(incomplete) }))
  const guidance = artifact('task_guidance')
  const guidanceContent = { ...guidance.content, planningHistory: history }
  assert.equal(JSON.stringify(buildCoreContext({ ...guidance, content: guidanceContent, contentHash: contentHash(guidanceContent) }, 'task_guidance').modelInput).includes('PRIVATE-REJECTION-NOTE'), false)
})
