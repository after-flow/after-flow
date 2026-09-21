import { z } from 'zod'
import { insightEventSchema, insightDraftSchema } from '@aftercare/internal-contracts'
import type { ContextArtifact, InsightDraft } from '@aftercare/internal-contracts'
import { createInsight } from '../../domain/insight/insight.js'
import type { Insight } from '../../domain/insight/insight.js'
import type { AgentRunEntity } from '../../domain/agent/agent-run.js'
import type { EntityBase } from '../../domain/shared/entity.js'
import { collections } from '../../domain/shared/collections.js'
import { fingerprintOf } from '../../shared/fingerprint.js'
import { errors } from '../../shared/app-error.js'
import type { Tx } from '../ports/persistence.js'

/** Invoked inside authenticated result intake after exact Context/lease/basis checks. */
export async function saveInsightResults(tx: Tx, run: AgentRunEntity, artifact: ContextArtifact, raw: InsightDraft[]) {
  const drafts = z.array(insightDraftSchema).max(20).parse(raw)
  const events = z.array(insightEventSchema).max(20).parse(artifact.content.insightEvents)
  if (new Set(drafts.map(draft => draft.eventId)).size !== drafts.length) throw errors.validationFailed()
  for (const draft of drafts) {
    const event = events.find(event => event.id === draft.eventId)
    if (!event || event.kind === 'CASE_CHANGED' || event.caseId !== run.caseId || event.caseVersion !== artifact.caseVersion || Date.parse(event.expiresAt) <= Date.now()) throw errors.conflict()
    const kind = event.kind === 'DEADLINE_REVIEW' ? 'DEADLINE_RISK' : event.kind === 'DOCUMENTS_MISSING' ? 'MISSING_DOCUMENT' : 'PROFESSIONAL_NEEDED'
    if (draft.kind !== kind || draft.relatedTaskId !== event.task.id || draft.relatedTaskTitle !== event.task.title ||
      draft.resultId !== fingerprintOf({ caseId: event.caseId, eventId: event.id, version: 'event-insights-v1' }) ||
      draft.requiresProfessional !== (event.kind === 'PROFESSIONAL_REVIEW') ||
      draft.evidence.some(e => e.taskId !== event.task.id || e.capturedVersion !== event.task.version)) throw errors.forbidden()
    const task = await tx.require<EntityBase>({ collection: collections.tasks, caseId: run.caseId, id: event.task.id })
    if (task.version !== event.task.version) throw errors.conflict()
    const id = fingerprintOf({ caseId: event.caseId, eventId: event.id })
    const location = { collection: collections.insights, caseId: run.caseId, id }
    const previous = await tx.get<Insight & EntityBase>(location)
    if (previous) {
      if (previous.eventId !== event.id) throw errors.conflict()
      if (previous.basisCaseVersion !== artifact.caseVersion) {
        tx.update<Insight & EntityBase>(location, previous.version, { basisCaseVersion: artifact.caseVersion })
        tx.audit({ caseId: event.caseId, type: 'insight.revalidated', target: { collection: collections.insights.name, id, version: previous.version + 1 }, detail: { eventId: event.id } })
      }
      continue
    }
    const entity = createInsight({ id, tenantId: run.tenantId, caseId: event.caseId, actor: { kind: 'AI', id: run.id }, now: new Date().toISOString() }, {
      kind: draft.kind, body: draft.body, evidence: draft.evidence.map(e => ({ ...e, documentId: null, documentName: null })),
      detectedAt: new Date().toISOString(), agentRunId: run.id, resultId: draft.resultId,
      relatedTaskId: event.task.id, relatedTaskTitle: event.task.title, relatedDocumentId: null,
      requiresProfessional: draft.requiresProfessional, professionalReviewNote: draft.professionalReviewNote,
    })
    const { version: _version, tenantId: _tenant, caseId: _case, createdAt: _created, updatedAt: _updated, ...data } = entity
    tx.create<Insight & EntityBase>(location, { ...data, eventId: event.id, basisCaseVersion: artifact.caseVersion })
    tx.audit({ caseId: event.caseId, type: 'insight.received', target: { collection: collections.insights.name, id, version: 1 }, detail: { eventId: event.id, resultId: draft.resultId } })
  }
}
