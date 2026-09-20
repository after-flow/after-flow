import { randomUUID } from 'node:crypto'
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
  return {
    title,
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
        procedureId: null,
        requiredDocuments: [],
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
