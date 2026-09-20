import { z } from 'zod'
import { internalId } from '@aftercare/internal-contracts'
import { contentHash } from '../context/builder.js'
import type { ProposalDraft } from '../actions/contracts.js'

const taskSchema = z.object({ id: internalId, version: z.number().int().positive(), title: z.string().min(1).max(120) }).strict()
const base = z.object({ id: internalId, caseId: internalId, caseVersion: z.number().int().positive(), expiresAt: z.string().datetime(), task: taskSchema })
/** Issued by an authenticated Backend detector, not by a model or public request. */
export const insightEventSchema = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('DEADLINE_REVIEW'), deadline: z.object({ id: internalId, version: z.number().int().positive(), dueDate: z.iso.date(), confirmation: z.literal('CONFIRMED'), ruleId: internalId, ruleVersion: internalId }).strict() }).strict(),
  base.extend({ kind: z.literal('DOCUMENTS_MISSING'), documents: z.array(z.object({ id: internalId, label: z.string().min(1).max(120) }).strict()).min(1).max(20) }).strict(),
  base.extend({ kind: z.literal('PROFESSIONAL_REVIEW'), reason: z.string().min(1).max(1000) }).strict(),
  base.extend({ kind: z.literal('CASE_CHANGED') }).strict(),
])
export type InsightEvent = z.infer<typeof insightEventSchema>
export function buildEventInsight(raw: unknown, expected: { caseId: string; caseVersion: number; taskId: string; taskVersion: number }) {
  const event = insightEventSchema.parse(raw)
  if (event.caseId !== expected.caseId || event.caseVersion !== expected.caseVersion || event.task.id !== expected.taskId || event.task.version !== expected.taskVersion || Date.parse(event.expiresAt) <= Date.now()) throw new Error('Insight event basis is stale or outside scope')
  const resultId = contentHash({ caseId: event.caseId, eventId: event.id, version: 'event-insights-v1' })
  if (event.kind === 'CASE_CHANGED') return { status: 'UNSUPPORTED' as const, resultId, insight: null, proposal: null }
  let proposal: ProposalDraft | null = null
  const requiresProfessional = event.kind === 'PROFESSIONAL_REVIEW'
  const body = event.kind === 'DEADLINE_REVIEW' ? `「${event.task.title}」に登録された期限 ${event.deadline.dueDate} を確認してください。` :
    event.kind === 'DOCUMENTS_MISSING' ? `「${event.task.title}」で不足している書類: ${event.documents.map(doc => doc.label).join('、')}` :
      `「${event.task.title}」について専門家への確認が必要です。${event.reason}`
  const evidenceValue = event.kind === 'DEADLINE_REVIEW' ? `${event.deadline.dueDate} / Rule ${event.deadline.ruleId}@${event.deadline.ruleVersion}` : event.kind === 'DOCUMENTS_MISSING' ? event.documents.map(doc => doc.label).join('、') : event.reason
  const kind = event.kind === 'DEADLINE_REVIEW' ? 'DEADLINE_RISK' as const : event.kind === 'DOCUMENTS_MISSING' ? 'MISSING_DOCUMENT' as const : 'PROFESSIONAL_NEEDED' as const
  const basis = [{ type: 'TASK' as const, id: event.task.id, version: event.task.version, label: event.task.title }]
  if (event.kind === 'DOCUMENTS_MISSING') {
    if (new Set(event.documents.map(doc => doc.id)).size !== event.documents.length) throw new Error('Duplicate missing document')
    proposal = { kind: 'DOCUMENT_REQUEST', title: '不足書類の確認', summary: body, payload: { taskId: event.task.id, expectedTaskVersion: event.task.version, documents: event.documents }, basis, assetDisposal: false }
  }
  if (event.kind === 'PROFESSIONAL_REVIEW') proposal = { kind: 'ESCALATION_PROPOSAL', title: '専門家への確認提案', summary: body,
    payload: { taskId: event.task.id, expectedTaskVersion: event.task.version, reason: event.reason, documents: [] }, basis, assetDisposal: false }
  return { status: 'DRAFT' as const, resultId, insight: { kind, body, relatedTaskId: event.task.id, relatedTaskTitle: event.task.title,
    evidence: [{ label: event.task.title, value: evidenceValue, taskId: event.task.id, capturedVersion: event.task.version }],
    requiresProfessional, professionalReviewNote: requiresProfessional ? '本人の確認後に専門家へ相談してください。自動連絡は行いません。' : null }, proposal }
}
