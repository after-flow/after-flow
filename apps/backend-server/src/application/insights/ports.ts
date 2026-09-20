import type { InsightView } from '../../domain/insight/insight.js'

/** 閲覧者ごとの既読／非表示状態 */
export interface InsightViewStore {
  find(tenantId: string, caseId: string, insightId: string, actorId: string): Promise<InsightView | null>
  findMany(tenantId: string, caseId: string, actorId: string, insightIds: string[]): Promise<Map<string, InsightView>>
  save(view: InsightView): Promise<void>
}

export interface AgentRunSummary {
  tenantId: string
  caseId: string
  runId: string
  status: import('../../domain/agent/agent-run.js').AgentRunStatus
  currentAttemptId: string
}

/**
 * AgentRun の正式記録（#10）への参照。内部結果を受け取る際、Run が対象 Case のものかを確認するために使う。
 * Case と tenant で保存済み Run を解決する。
 */
export interface AgentRunLookup {
  findRun(tenantId: string, caseId: string, runId: string): Promise<AgentRunSummary | null>
}

export interface EvidenceTargetState {
  version: number
  archived: boolean
}

/** 根拠が指す Document / Task の現在状態。Case 外や存在しないものは null */
export interface EvidenceResolver {
  resolveDocument(tenantId: string, caseId: string, documentId: string): Promise<EvidenceTargetState | null>
  resolveTask(tenantId: string, caseId: string, taskId: string): Promise<EvidenceTargetState | null>
}

/** 同一 Run × resultId の重複受領を抑止する */
export interface InsightResultLedger {
  has(tenantId: string, runId: string, resultId: string): Promise<boolean>
  record(tenantId: string, runId: string, resultId: string, insightId: string): Promise<void>
}
