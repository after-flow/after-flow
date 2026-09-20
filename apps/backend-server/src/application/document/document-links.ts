import type { DocumentResource } from '@aftercare/public-contracts'
import type { ProposalEntity } from '../../domain/proposal/proposal.js'
import type { ApprovalEntity } from '../../domain/proposal/approval.js'
import type { EvidenceEntity } from '../../domain/task/evidence.js'
import type { EntityBase } from '../../domain/shared/entity.js'
import { collections, type CollectionDescriptor } from '../../domain/shared/collections.js'
import type { ReadRepository } from '../ports/persistence.js'

type Links = Pick<DocumentResource, 'extractionCandidates' | 'proposalRefs' | 'approvalRefs' | 'evidenceRefs'>

/** 一覧の最初のページを全件と誤認しない。Caseの一覧応答で一度だけ読み、文書ごとに再走査しない。 */
export async function readDocumentLinks(read: ReadRepository, tenantId: string, caseId: string): Promise<(id: string) => Links> {
  async function all<T extends EntityBase>(collection: CollectionDescriptor) {
    const items: T[] = []
    let cursor: string | undefined
    do {
      const page = await read.list<T>(tenantId, collection, caseId, { limit: 100, cursor, orderBy: { field: 'createdAt', direction: 'asc' } })
      items.push(...page.items); cursor = page.nextCursor
    } while (cursor)
    return items
  }
  const [proposals, approvals, evidence] = await Promise.all([
    all<ProposalEntity>(collections.proposals), all<ApprovalEntity>(collections.approvals), all<EvidenceEntity>(collections.evidence),
  ])
  return id => {
    const related = proposals.filter(p => p.basis.some(b => b.type === 'DOCUMENT' && b.id === id))
    const proposalIds = new Set(related.map(p => p.id))
    return {
      extractionCandidates: related.filter(p => p.source === 'AI').map(p => ({ id: p.id, proposalVersion: p.proposalVersion,
        kind: p.kind, title: p.title, payload: p.payload, status: p.status, basis: p.basis })),
      proposalRefs: related.map(p => ({ id: p.id, proposalVersion: p.proposalVersion, kind: p.kind, status: p.status, source: p.source })),
      approvalRefs: approvals.filter(a => proposalIds.has(a.proposalId)).map(a => ({ id: a.id, proposalId: a.proposalId,
        proposalVersion: a.proposalVersion, status: a.status, applicationStatus: a.applicationStatus })),
      evidenceRefs: evidence.filter(e => e.documentId === id).map(e => ({ id: e.id, taskId: e.taskId, label: e.label, version: e.version })),
    }
  }
}
