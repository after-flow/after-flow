import type { InsightKind, InsightStatus } from '@aftercare/public-contracts'
import { invalidTransition, validation } from '../shared/errors.js'
import type { ActorRef, CaseEntity, ISODateTime } from '../shared/types.js'

/** 根拠の参照先。検出時点の version を保持し、後で「変わった／無くなった」を判定できるようにする */
export interface EvidenceRef {
  documentId: string | null
  taskId: string | null
  capturedVersion: number | null
}

export interface InsightEvidence extends EvidenceRef {
  label: string
  value: string
  documentName: string | null
}

/**
 * AI が検出した気づき。内容は Case 内で共有され、既読／非表示は InsightView で閲覧者ごとに持つ。
 * 正式な財産・契約・事実ではなく、利用者が自分で確かめるための指摘に留まる。
 */
export interface Insight extends CaseEntity {
  basisCaseVersion?: number
  eventId?: string
  kind: InsightKind
  body: string
  evidence: InsightEvidence[]
  detectedAt: ISODateTime
  agentRunId: string
  /** 同一 Run 内の結果識別子。重複受領の抑止に使う */
  resultId: string
  relatedTaskId: string | null
  relatedTaskTitle: string | null
  relatedDocumentId: string | null
  requiresProfessional: boolean
  professionalReviewNote: string | null
}

export interface InsightView {
  tenantId: string
  caseId: string
  insightId: string
  actorId: string
  status: InsightStatus
  updatedAt: ISODateTime | null
  note: string | null
}

export interface NewInsightInput {
  kind: InsightKind
  body: string
  evidence: InsightEvidence[]
  detectedAt: ISODateTime
  agentRunId: string
  resultId: string
  relatedTaskId: string | null
  relatedTaskTitle: string | null
  relatedDocumentId: string | null
  requiresProfessional: boolean
  professionalReviewNote: string | null
}

interface NewEntityMeta {
  id: string
  tenantId: string
  caseId: string
  actor: ActorRef
  now: ISODateTime
}

const BODY_MAX = 4000

export function createInsight(meta: NewEntityMeta, input: NewInsightInput): Insight {
  if (input.body.trim().length === 0) throw validation('body は必須です', { field: 'body' })
  if (input.body.length > BODY_MAX) throw validation('body が長すぎます', { field: 'body' })
  if (input.evidence.length === 0) throw validation('根拠のない気づきは登録できません', { field: 'evidence' })
  for (const e of input.evidence) {
    if (e.label.trim().length === 0 || e.value.trim().length === 0) {
      throw validation('根拠には label と value が必要です', { field: 'evidence' })
    }
  }
  if (input.requiresProfessional && !input.professionalReviewNote) {
    throw validation('専門家確認が必要な気づきには注記が必要です', { field: 'professionalReviewNote' })
  }
  return {
    id: meta.id,
    tenantId: meta.tenantId,
    caseId: meta.caseId,
    version: 1,
    createdAt: meta.now,
    updatedAt: meta.now,
    createdBy: meta.actor,
    updatedBy: meta.actor,
    ...input,
  }
}

export function initialView(insight: Insight, actorId: string): InsightView {
  return {
    tenantId: insight.tenantId,
    caseId: insight.caseId,
    insightId: insight.id,
    actorId,
    status: 'NEW',
    updatedAt: null,
    note: null,
  }
}

const ORDER: Record<InsightStatus, number> = { NEW: 0, ACKNOWLEDGED: 1, DISMISSED: 2 }

/** NEW → ACKNOWLEDGED → DISMISSED の一方向。同じ状態や後退は拒否する */
export function transitionView(view: InsightView, to: InsightStatus, note: string | null, now: ISODateTime): InsightView {
  if (view.status === to) throw invalidTransition(view.status, to, 'すでにその状態です')
  if (ORDER[to] < ORDER[view.status]) throw invalidTransition(view.status, to)
  return { ...view, status: to, updatedAt: now, note }
}
