import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { findProcedureDefinition } from '@aftercare/internal-contracts'
import { collections } from '../../domain/shared/collections.js'
import type { FlowStageId, TaskEntity } from '../../domain/task/task.js'
import { errors } from '../../shared/app-error.js'
import type { Tx } from '../ports/persistence.js'
import type { ProposalApplier } from './proposal-service.js'

/**
 * 手続きの提案を反映する。
 *
 * ここで受け取る payload は、承認された版の内容そのもの。
 * 適用時に内容を作り替えない。作り替えると、人が承認したものと
 * 反映されたものが食い違う。
 */
interface TaskProposalPayload {
  title: string
  summary: string
  stage: FlowStageId
  category: string
  submitTo?: string | null
  evidenceRequired?: boolean
  assetDisposal?: boolean
  dependencyTaskIds: string[]
  requiredDocuments: { id: string; label: string }[]
  procedureId: string | null
}

function parsePayload(payload: Record<string, unknown>): TaskProposalPayload {
  const title = payload.title
  const stage = payload.stage
  const category = payload.category
  if (typeof title !== 'string' || typeof stage !== 'string' || typeof category !== 'string') {
    throw errors.preconditionFailed({
      message: 'この提案の内容では手続きを作成できません。',
      details: { reason: 'INVALID_PAYLOAD' },
    })
  }
  const extras = z.object({ dependencyTaskIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).max(20).default([]),
    requiredDocuments: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), label: z.string().min(1).max(120) }).strict()).max(20).default([]),
    procedureId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable().optional(),
  }).safeParse(payload)
  if (!extras.success || new Set(extras.data.dependencyTaskIds).size !== extras.data.dependencyTaskIds.length || new Set(extras.data.requiredDocuments.map(doc => doc.id)).size !== extras.data.requiredDocuments.length) throw errors.validationFailed()
  const procedureId = extras.data.procedureId ?? null
  if (procedureId !== null && !findProcedureDefinition(procedureId)) throw errors.validationFailed({ details: { reason: 'UNKNOWN_PROCEDURE' } })
  return {
    ...extras.data, procedureId, title,
    summary: typeof payload.summary === 'string' ? payload.summary : '',
    stage: stage as FlowStageId,
    category,
    submitTo: typeof payload.submitTo === 'string' ? payload.submitTo : null,
    evidenceRequired: payload.evidenceRequired === true,
    assetDisposal: payload.assetDisposal === true,
  }
}

export const taskProposalApplier: ProposalApplier = {
  kind: 'TASK_PROPOSAL',
  async apply(tx: Tx, context) {
    const payload = parsePayload(context.proposal.payload)
    const taskId = randomUUID()
    const visited = new Set<string>()
    async function dependency(id: string, path: Set<string>): Promise<void> {
      if (path.has(id) || id === taskId) throw errors.validationFailed({ details: { reason: 'DEPENDENCY_CYCLE' } })
      if (visited.has(id)) return
      if (visited.size >= 100) throw errors.preconditionFailed({ details: { reason: 'DEPENDENCY_LIMIT_EXCEEDED' } })
      visited.add(id)
      const task = await tx.require<TaskEntity>({ collection: collections.tasks, caseId: context.caseId, id })
      const next = new Set(path); next.add(id)
      for (const parent of task.dependencyTaskIds ?? []) await dependency(parent, next)
    }
    for (const id of payload.dependencyTaskIds) await dependency(id, new Set())

    tx.create<TaskEntity>(
      { collection: collections.tasks, caseId: context.caseId, id: taskId },
      {
        id: taskId,
        title: payload.title,
        summary: payload.summary,
        status: 'NOT_STARTED',
        stage: payload.stage,
        category: payload.category,
        submitTo: payload.submitTo ?? null,
        assigneeId: null,
        // 由来を残す。利用者入力から AI 由来を偽装できない。
        source: context.proposal.source === 'AI' ? 'AI' : 'MANUAL',
        procedureId: payload.procedureId,
        dependencyTaskIds: payload.dependencyTaskIds,
        requiredDocuments: payload.requiredDocuments.map(doc => ({ ...doc, documentId: null, source: context.proposal.source === 'AI' ? 'AI' : 'MANUAL' })),
        evidenceRequired: payload.evidenceRequired ?? false,
        assetDisposal: payload.assetDisposal ?? false,
        completionReportedBy: null,
        completionReportedAt: null,
      },
    )

    tx.audit({
      caseId: context.caseId,
      type: 'task.created_from_proposal',
      target: { collection: collections.tasks.name, id: taskId, version: 1 },
      detail: {
        proposalId: context.proposal.id,
        proposalVersion: context.proposal.proposalVersion,
      },
    })
  },
}
