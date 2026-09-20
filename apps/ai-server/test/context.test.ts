import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertContextFresh, buildCoreContext, buildResearchBrief, contentHash, ContextError } from '../src/orchestration/context/builder.js'

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
