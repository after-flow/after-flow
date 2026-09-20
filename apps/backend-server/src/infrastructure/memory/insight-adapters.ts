import type {
  AgentRunLookup,
  AgentRunSummary,
  EvidenceResolver,
  EvidenceTargetState,
  InsightResultLedger,
  InsightViewStore,
} from '../../application/insights/ports.js'
import type { InsightView } from '../../domain/insight/insight.js'

/** 暫定: 閲覧状態の in-memory 保存（Firestore は #5） */
export class InMemoryInsightViewStore implements InsightViewStore {
  private readonly rows = new Map<string, InsightView>()

  private key(tenantId: string, caseId: string, insightId: string, actorId: string) {
    return `${tenantId}/${caseId}/${insightId}/${actorId}`
  }

  async find(tenantId: string, caseId: string, insightId: string, actorId: string): Promise<InsightView | null> {
    return this.rows.get(this.key(tenantId, caseId, insightId, actorId)) ?? null
  }

  async findMany(tenantId: string, caseId: string, actorId: string, insightIds: string[]) {
    const out = new Map<string, InsightView>()
    for (const id of insightIds) {
      const v = this.rows.get(this.key(tenantId, caseId, id, actorId))
      if (v) out.set(id, v)
    }
    return out
  }

  async save(view: InsightView): Promise<void> {
    this.rows.set(this.key(view.tenantId, view.caseId, view.insightId, view.actorId), view)
  }
}

/** 暫定: AgentRun 正式記録（#10）ができるまでの登録式 lookup */
export class InMemoryAgentRunLookup implements AgentRunLookup {
  private readonly runs = new Map<string, AgentRunSummary>()

  register(run: AgentRunSummary): void {
    this.runs.set(`${run.tenantId}/${run.runId}`, run)
  }

  async findRun(tenantId: string, runId: string): Promise<AgentRunSummary | null> {
    return this.runs.get(`${tenantId}/${runId}`) ?? null
  }
}

/** 暫定: Document / Task の現在状態を登録式で返す。実装は各リポジトリ（#8 / #9）へ差し替える */
export class InMemoryEvidenceResolver implements EvidenceResolver {
  private readonly documents = new Map<string, EvidenceTargetState>()
  private readonly tasks = new Map<string, EvidenceTargetState>()

  setDocument(tenantId: string, caseId: string, id: string, state: EvidenceTargetState): void {
    this.documents.set(`${tenantId}/${caseId}/${id}`, state)
  }

  setTask(tenantId: string, caseId: string, id: string, state: EvidenceTargetState): void {
    this.tasks.set(`${tenantId}/${caseId}/${id}`, state)
  }

  async resolveDocument(tenantId: string, caseId: string, documentId: string) {
    return this.documents.get(`${tenantId}/${caseId}/${documentId}`) ?? null
  }

  async resolveTask(tenantId: string, caseId: string, taskId: string) {
    return this.tasks.get(`${tenantId}/${caseId}/${taskId}`) ?? null
  }
}

export class InMemoryInsightResultLedger implements InsightResultLedger {
  private readonly seen = new Map<string, string>()

  async has(tenantId: string, runId: string, resultId: string): Promise<boolean> {
    return this.seen.has(`${tenantId}/${runId}/${resultId}`)
  }

  async record(tenantId: string, runId: string, resultId: string, insightId: string): Promise<void> {
    this.seen.set(`${tenantId}/${runId}/${resultId}`, insightId)
  }
}
