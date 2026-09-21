import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildEventInsight } from '../src/orchestration/playbooks/event-insights.js'

const expected = { caseId: 'case', caseVersion: 3, taskId: 'task', taskVersion: 2 }
const base = { id: 'event', caseId: 'case', caseVersion: 3, expiresAt: new Date(Date.now() + 60000).toISOString(), task: { id: 'task', version: 2, title: '合成手続き' } }
test('event insights have stable cross-run result IDs and separate formal proposals from display', () => {
  const event = { ...base, kind: 'DOCUMENTS_MISSING', documents: [{ id: 'required', label: '合成資料' }] }
  const first = buildEventInsight(event, expected); const repeated = buildEventInsight(event, expected)
  assert.equal(first.resultId, repeated.resultId); assert.equal(first.proposal?.kind, 'DOCUMENT_REQUEST')
  assert.equal(first.insight?.evidence[0]?.capturedVersion, 2)
  const professional = buildEventInsight({ ...base, kind: 'PROFESSIONAL_REVIEW', reason: '本人が判断を確認したい' }, expected)
  assert.equal(professional.proposal?.kind, 'ESCALATION_PROPOSAL'); assert.equal(professional.insight?.requiresProfessional, true)
  const unsupported = buildEventInsight({ ...base, kind: 'CASE_CHANGED' }, expected)
  assert.equal(unsupported.status, 'UNSUPPORTED'); assert.equal(unsupported.insight, null)
})
test('event insights refuse stale, foreign and unconfirmed deadlines without inventing legal rules', () => {
  const event = { ...base, kind: 'DEADLINE_REVIEW', deadline: { id: 'deadline', version: 1, dueDate: '2026-10-01', confirmation: 'CONFIRMED', ruleId: 'synthetic-rule', ruleVersion: 'v1' } }
  assert.match(buildEventInsight(event, expected).insight!.body, /2026-10-01/)
  for (const patch of [{ caseId: 'other' }, { caseVersion: 2 }, { task: { ...base.task, version: 1 } }, { expiresAt: '2020-01-01T00:00:00Z' }, { deadline: { ...event.deadline, confirmation: 'UNKNOWN' } }]) {
    assert.throws(() => buildEventInsight({ ...event, ...patch }, expected))
  }
})
