import type {
  AcknowledgeInsightRequest,
  DismissInsightRequest,
  EvidenceFreshness,
  Insight as InsightDto,
  InsightEvidence as InsightEvidenceDto,
  InsightKind,
} from '@aftercare/public-contracts'
import {
  createInsight,
  initialView,
  transitionView,
  type Insight,
  type InsightEvidence,
  type InsightView,
} from '../../domain/insight/insight.js'
import { duplicate, notFound, validation } from '../../domain/shared/errors.js'
import type { ISODateTime } from '../../domain/shared/types.js'
import { appendAudit } from '../audit.js'
import { authorizeCase } from '../authorization.js'
import type { CommandContext } from '../context.js'
import { runIdempotent, type CommandResult } from '../idempotency.js'
import type {
  AuditLogPort,
  CaseMembershipPort,
  CaseScopedRepository,
  Clock,
  IdGenerator,
  IdempotencyStore,
  ListQuery,
  Page,
} from '../ports.js'
import type { AgentRunLookup, EvidenceResolver, EvidenceTargetState, InsightResultLedger, InsightViewStore } from './ports.js'

export interface InsightServiceDeps {
  insights: CaseScopedRepository<Insight>
  views: InsightViewStore
  runs: AgentRunLookup
  evidence: EvidenceResolver
  ledger: InsightResultLedger
  memberships: CaseMembershipPort
  idempotency: IdempotencyStore
  audit: AuditLogPort
  clock: Clock
  ids: IdGenerator
}

/**
 * 内部結果（AI Server → Backend `/internal/v1/runs/:runId/result`）から受け取る気づき 1 件分。
 * 内部 HTTP 経路と認証は #10 が提供し、ここでは検証と保存だけを担う。
 */
export interface InsightResultInput {
  runId: string
  resultId: string
  kind: InsightKind
  body: string
  evidence: {
    label: string
    value: string
    documentId?: string
    documentName?: string
    taskId?: string
  }[]
  detectedAt: ISODateTime
  relatedTaskId?: string
  relatedTaskTitle?: string
  relatedDocumentId?: string
  requiresProfessional: boolean
  professionalReviewNote?: string
}

function freshnessOf(ref: InsightEvidence, current: EvidenceTargetState | null | undefined): EvidenceFreshness {
  if (ref.documentId === null && ref.taskId === null) return 'CURRENT'
  if (current === null || current === undefined || current.archived) return 'UNAVAILABLE'
  if (ref.capturedVersion !== null && current.version !== ref.capturedVersion) return 'STALE'
  return 'CURRENT'
}

export class InsightService {
  constructor(private readonly deps: InsightServiceDeps) {}

  /* ---------- 公開 API ---------- */

  async listInsights(ctx: CommandContext, query: ListQuery): Promise<Page<InsightDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'READ')
    const tenantId = ctx.principal.tenantId
    const page = await this.deps.insights.list(tenantId, ctx.caseId, query)
    const views = await this.deps.views.findMany(
      tenantId,
      ctx.caseId,
      ctx.principal.userId,
      page.items.map((i) => i.id),
    )
    const items = await Promise.all(
      page.items.map((i) => this.toDto(i, views.get(i.id) ?? initialView(i, ctx.principal.userId))),
    )
    return { items, nextCursor: page.nextCursor }
  }

  async acknowledge(
    ctx: CommandContext,
    insightId: string,
    req: AcknowledgeInsightRequest,
  ): Promise<CommandResult<InsightDto>> {
    return this.transition(ctx, insightId, 'ACKNOWLEDGED', req.note ?? null, 'insight.acknowledged', req)
  }

  async dismiss(ctx: CommandContext, insightId: string, req: DismissInsightRequest): Promise<CommandResult<InsightDto>> {
    return this.transition(ctx, insightId, 'DISMISSED', req.reason ?? null, 'insight.dismissed', req)
  }

  private async transition(
    ctx: CommandContext,
    insightId: string,
    to: InsightView['status'],
    note: string | null,
    action: string,
    req: unknown,
  ): Promise<CommandResult<InsightDto>> {
    // 既読・非表示は本人の閲覧状態なので、Case を閲覧できれば誰でも行える
    await authorizeCase(ctx, this.deps.memberships, 'READ')
    return runIdempotent(ctx, this.deps.idempotency, `insights.${to}:${insightId}`, req, async () => {
      const tenantId = ctx.principal.tenantId
      const insight = await this.deps.insights.findById(tenantId, ctx.caseId, insightId)
      if (!insight) throw notFound('Insight', insightId)
      const actorId = ctx.principal.userId
      const view =
        (await this.deps.views.find(tenantId, ctx.caseId, insightId, actorId)) ?? initialView(insight, actorId)
      const now = this.deps.clock.now()
      const next = transitionView(view, to, note, now)
      await this.deps.views.save(next)
      await appendAudit(this.deps.audit, ctx, {
        action,
        targetType: 'Insight',
        targetId: insightId,
        occurredAt: now,
        detail: { from: view.status, to },
      })
      return { statusCode: 200, body: await this.toDto(insight, next) }
    })
  }

  /* ---------- 内部結果の受領（#10 の result handler から呼ばれる） ---------- */

  async receiveInsightResult(tenantId: string, input: InsightResultInput): Promise<Insight> {
    const run = await this.deps.runs.findRun(tenantId, input.runId)
    if (!run) throw notFound('AgentRun', input.runId)
    if (await this.deps.ledger.has(tenantId, input.runId, input.resultId)) {
      throw duplicate('同じ Run の結果はすでに受領しています', { runId: input.runId, resultId: input.resultId })
    }
    const caseId = run.caseId

    const evidence: InsightEvidence[] = []
    for (const e of input.evidence) {
      let captured: EvidenceTargetState | null = null
      if (e.documentId) {
        captured = await this.deps.evidence.resolveDocument(tenantId, caseId, e.documentId)
        if (!captured) throw validation('根拠の Document が Case 内に見つかりません', { documentId: e.documentId })
      }
      if (e.taskId) {
        captured = await this.deps.evidence.resolveTask(tenantId, caseId, e.taskId)
        if (!captured) throw validation('根拠の Task が Case 内に見つかりません', { taskId: e.taskId })
      }
      evidence.push({
        label: e.label,
        value: e.value,
        documentId: e.documentId ?? null,
        documentName: e.documentName ?? null,
        taskId: e.taskId ?? null,
        capturedVersion: captured?.version ?? null,
      })
    }
    if (input.relatedTaskId && !(await this.deps.evidence.resolveTask(tenantId, caseId, input.relatedTaskId))) {
      throw validation('関連 Task が Case 内に見つかりません', { taskId: input.relatedTaskId })
    }
    if (
      input.relatedDocumentId &&
      !(await this.deps.evidence.resolveDocument(tenantId, caseId, input.relatedDocumentId))
    ) {
      throw validation('関連 Document が Case 内に見つかりません', { documentId: input.relatedDocumentId })
    }

    const now = this.deps.clock.now()
    const insight = createInsight(
      { id: this.deps.ids.next('ins'), tenantId, caseId, actor: { kind: 'AI', id: input.runId }, now },
      {
        kind: input.kind,
        body: input.body,
        evidence,
        detectedAt: input.detectedAt,
        agentRunId: input.runId,
        resultId: input.resultId,
        relatedTaskId: input.relatedTaskId ?? null,
        relatedTaskTitle: input.relatedTaskTitle ?? null,
        relatedDocumentId: input.relatedDocumentId ?? null,
        requiresProfessional: input.requiresProfessional,
        professionalReviewNote: input.professionalReviewNote ?? null,
      },
    )
    await this.deps.insights.save(insight)
    await this.deps.ledger.record(tenantId, input.runId, input.resultId, insight.id)
    await this.deps.audit.append({
      tenantId,
      caseId,
      actor: { kind: 'AI', id: input.runId },
      action: 'insight.received',
      targetType: 'Insight',
      targetId: insight.id,
      requestId: `run:${input.runId}:${input.resultId}`,
      occurredAt: now,
    })
    return insight
  }

  /* ---------- DTO ---------- */

  private async toDto(i: Insight, view: InsightView): Promise<InsightDto> {
    const evidence: InsightEvidenceDto[] = await Promise.all(
      i.evidence.map(async (e) => {
        const current = e.documentId
          ? await this.deps.evidence.resolveDocument(i.tenantId, i.caseId, e.documentId)
          : e.taskId
            ? await this.deps.evidence.resolveTask(i.tenantId, i.caseId, e.taskId)
            : undefined
        return {
          label: e.label,
          value: e.value,
          ...(e.documentId !== null && { documentId: e.documentId }),
          ...(e.documentName !== null && { documentName: e.documentName }),
          ...(e.taskId !== null && { taskId: e.taskId }),
          freshness: freshnessOf(e, current),
        }
      }),
    )
    return {
      id: i.id,
      caseId: i.caseId,
      kind: i.kind,
      body: i.body,
      evidence,
      detectedAt: i.detectedAt,
      agentRunId: i.agentRunId,
      ...(i.relatedTaskId !== null && { relatedTaskId: i.relatedTaskId }),
      ...(i.relatedTaskTitle !== null && { relatedTaskTitle: i.relatedTaskTitle }),
      ...(i.relatedDocumentId !== null && { relatedDocumentId: i.relatedDocumentId }),
      requiresProfessional: i.requiresProfessional,
      status: view.status,
      statusUpdatedAt: view.updatedAt,
      ...(i.professionalReviewNote !== null && { professionalReviewNote: i.professionalReviewNote }),
    }
  }
}
