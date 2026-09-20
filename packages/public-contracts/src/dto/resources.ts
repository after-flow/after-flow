/**
 * 既存フロントエンド向け Public API のリソース型。
 * 期限計算・状態遷移の検証はすべて Backend の Rule Engine が行うため、
 * フロントエンドはここで受け取った値をそのまま表示する（再計算しない）。
 */

export type ISODate = string // YYYY-MM-DD
export type ISODateTime = string

/* ---------- Envelope / Pagination (Backend Public API) ---------- */

export interface ResponseMeta {
  requestId: string
  /** 次ページのカーソル。一覧レスポンスのみ。無い場合は null */
  nextCursor?: string | null
}

export interface ApiSuccess<T> {
  data: T
  meta: ResponseMeta
}

export interface ApiErrorBody {
  code: string
  message: string
  /** 同じ内容で再試行して成功する見込みがあるか（503/429 など） */
  retryable: boolean
  details?: unknown
}

export interface ApiFailure {
  error: ApiErrorBody
  meta: ResponseMeta
}

/** 更新系リクエストに載せる楽観ロック用バージョン */
export interface ExpectedVersion {
  expectedVersion: number
}

/* ---------- Case ---------- */

export type CaseStatus = 'ACTIVE' | 'CLOSED'

export interface Case {
  id: string
  deceasedName: string
  deceasedNameKana?: string
  dateOfDeath: ISODate
  dateOfBirth?: ISODate
  /** 相続開始を知った日（期限の起算日として Rule Engine が使う） */
  knownAt?: ISODate
  ownerName: string
  relationshipToDeceased: string
  /**
   * 手続き先の市区町村。
   * 窓口・持ち物は自治体ごとに異なるため、エージェントが調べる対象になる。
   * 番地までは不要で、市区町村までしか持たない。
   */
  municipality?: string
  status: CaseStatus
  createdAt: ISODateTime
}

/** 企画書セクション3の10段階フロー */
export type FlowStageId =
  | 'immediate'
  | 'funeral'
  | 'government'
  | 'contracts'
  | 'investigation'
  | 'decision'
  | 'division'
  | 'transfer'
  | 'tax'
  | 'closing'

export interface FlowStage {
  id: FlowStageId
  label: string
  totalTasks: number
  completedTasks: number
  state: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED'
}

export interface CaseOverview {
  case: Case
  upcomingDeadlines: DeadlineSummary[]
  pendingApprovalCount: number
  flowStages: FlowStage[]
  /** 相続方法の確定状況。未確定の間は放棄前ロックが有効になる。 */
  inheritanceDecision: InheritanceDecisionSummary
  recentAgentRuns: AgentRunSummary[]
  taskCounts: Partial<Record<TaskStatus, number>>
}

/* ---------- Decision（相続方法） ---------- */

export type InheritanceMethod = 'SIMPLE_ACCEPTANCE' | 'LIMITED_ACCEPTANCE' | 'RENUNCIATION'

export interface InheritanceDecisionSummary {
  /** false の間は財産処分・現金化に相当する導線を出さない（放棄前ロック） */
  decided: boolean
  /** 相続人ごとの確定状況 */
  perHeir: { personId: string; personName: string; method: InheritanceMethod | null }[]
  /** 3か月の熟慮期間の期限（Rule Engine 生成） */
  deliberationDeadline?: ISODate
}

/* ---------- Person / Family ---------- */

export type PersonRole = 'HEIR_CANDIDATE' | 'DECEASED' | 'RELATED' | 'PROFESSIONAL'

export type SpecialCircumstance = 'MINOR' | 'MISSING' | 'CAPACITY_CONCERN'

export interface Person {
  id: string
  caseId: string
  name: string
  nameKana?: string
  /** 故人との続柄（利用者が入力した表示用ラベル。法的判定ではない） */
  relationship: string
  role: PersonRole
  /** 利用者が「相続人候補として扱う」と記録した値。法定相続人の判定ではない */
  isHeir: boolean
  dateOfBirth?: ISODate
  /** 未成年・行方不明・判断能力に懸念など、特別な代理が必要な状況 */
  specialCircumstance?: SpecialCircumstance | null
  contact?: string
  note?: string
  /** 楽観ロック用。更新時は expectedVersion に載せる */
  version: number
  /** 除外済みの場合の日時。除外は個人情報の完全削除ではない */
  excludedAt?: ISODateTime | null
}

export type PersonWritableFields = Pick<
  Person,
  'name' | 'nameKana' | 'relationship' | 'role' | 'isHeir' | 'dateOfBirth' | 'specialCircumstance' | 'contact' | 'note'
>

export type CreatePersonRequest = Omit<PersonWritableFields, 'role' | 'isHeir'> &
  Partial<Pick<PersonWritableFields, 'role' | 'isHeir'>>

export type UpdatePersonRequest = Partial<PersonWritableFields> & ExpectedVersion

export interface ExcludePersonRequest extends ExpectedVersion {
  reason?: string
}

export type RelationshipKind =
  | 'SPOUSE'
  | 'CHILD'
  | 'PARENT'
  | 'SIBLING'
  | 'GRANDCHILD'
  | 'GRANDPARENT'
  | 'ADOPTED_CHILD'
  | 'OTHER'

/** 同一Case内の関係者2名の関係。両端は同じ caseId でなければならない */
export interface Relationship {
  id: string
  caseId: string
  fromPersonId: string
  toPersonId: string
  /** from から見た to の関係（例: from=故人, to=長男 なら CHILD） */
  kind: RelationshipKind
  note?: string
  version: number
  excludedAt?: ISODateTime | null
}

export type CreateRelationshipRequest = Pick<Relationship, 'fromPersonId' | 'toPersonId' | 'kind' | 'note'>
export type UpdateRelationshipRequest = Partial<Pick<Relationship, 'kind' | 'note'>> & ExpectedVersion
export type ExcludeRelationshipRequest = ExcludePersonRequest

/* ---------- Document ---------- */

export type DocumentAnalysisStatus = 'NOT_ANALYZED' | 'ANALYZING' | 'ANALYZED' | 'NEEDS_REVIEW'

export type DocumentKind =
  | 'DEATH_CERTIFICATE'
  | 'FAMILY_REGISTER'
  | 'WILL'
  | 'CONTRACT'
  | 'BANK_STATEMENT'
  | 'INSURANCE_POLICY'
  | 'OTHER'

export interface CaseDocument {
  id: string
  caseId: string
  fileName: string
  kind: DocumentKind
  kindSource: 'AI' | 'MANUAL'
  analysisStatus: DocumentAnalysisStatus
  sizeBytes: number
  uploadedAt: ISODateTime
  /** マイナンバー検知の結果。REJECTED の書類は保存されない。 */
  myNumberScan: 'CLEAN' | 'MASKED' | 'REJECTED'
  agentRunId?: string
  extractions?: DocumentExtraction[]
}

export interface DocumentExtraction {
  id: string
  label: string
  value: string
  /** 生成された提案（Approval）への参照 */
  approvalId?: string
  targetType?: 'TASK' | 'ASSET' | 'LIABILITY' | 'CONTRACT'
}

/* ---------- Task / Deadline ---------- */

export type TaskStatus =
  | 'NOT_STARTED'
  | 'COLLECTING_INFORMATION'
  | 'WAITING_DOCUMENTS'
  | 'READY'
  | 'SUBMITTED'
  | 'WAITING_EXTERNAL'
  | 'ACTION_REQUIRED'
  | 'COMPLETED'
  | 'ESCALATED'

export interface Task {
  id: string
  caseId: string
  title: string
  summary: string
  /** 提出先・窓口 */
  submitTo?: string
  status: TaskStatus
  stage: FlowStageId
  category: string
  assigneeId?: string
  assigneeName?: string
  source: 'AI' | 'MANUAL' | 'RULE_ENGINE'
  deadline?: DeadlineSummary
  requiredDocuments?: RequiredDocument[]
  guidance?: TaskGuidance
  dependencies?: TaskDependency[]
  evidences?: Evidence[]
  /**
   * 財産処分・現金化に相当するタスク。
   * 相続方法が未確定の間は一覧に出さず、警告バナーへの導線のみを表示する。
   */
  assetDisposal: boolean
  updatedAt: ISODateTime
}

export interface TaskDependency {
  type: 'TASK' | 'DECISION'
  label: string
  satisfied: boolean
  taskId?: string
}

export interface RequiredDocument {
  id: string
  label: string
  collected: boolean
  source: 'AI' | 'MANUAL' | 'RULE_ENGINE'
  documentId?: string
}

/** エージェントが「準備」できる範囲（提出先・持ち物・手順・様式の案内）まで。書類の作成・完成は行わない。 */
export interface TaskGuidance {
  where?: string
  bring?: string[]
  steps?: string[]
  /** 公的機関が公開している様式・記入例へのリンク。本文の自動生成・確定は行わない。 */
  formExampleUrl?: string
  formExampleLabel?: string
  note?: string
  /**
   * 案内の出典。
   * 窓口・持ち物は自治体ごとに異なり、変更もされる。
   * AIが調べた内容をそのまま信じさせないよう、出典と確認日を必ず示す。
   */
  sources?: GuidanceSource[]
  /** この案内を誰が用意したか */
  researchedBy?: 'AI' | 'MANUAL'
  /** 自律調査の状態。エージェントが調べた案内にだけ入る。 */
  research?: GuidanceResearch
}

export interface GuidanceSource {
  label: string
  url: string
  /** いつ時点の情報か */
  checkedAt: ISODateTime
}

export type ResearchStatus =
  | 'NOT_REQUESTED'
  | 'RESEARCHING'
  | 'COMPLETED'
  /** 一部しか確認できなかった */
  | 'PARTIAL'
  | 'FAILED'

/**
 * エージェントが自分で調べた案内の状態。
 *
 * 窓口・持ち物・受付時間は自治体ごとに違い、変更もされる。
 * ここをエージェントが調べて埋めるのが「自律調査」にあたるが、
 * 調べた結果をそのまま信じさせるわけにはいかないため、
 * 進行状況・確からしさ・調べきれなかった項目を必ず添えて返す。
 */
export interface GuidanceResearch {
  status: ResearchStatus
  /** 何について調べたか（例：江戸川区 戸籍住民課） */
  target?: string
  startedAt?: ISODateTime
  completedAt?: ISODateTime
  agentRunId?: string
  /**
   * 確からしさ。
   * LOW のときフロントエンドは、そのまま行動しないよう強めに注意を表示する。
   */
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW'
  /** 調べきれなかった項目（例：夜間窓口の有無） */
  missing?: string[]
  /** FAILED のときの理由。利用者に見せる文言。 */
  failureReason?: string
}

export type DeadlineSeverity = 'NORMAL' | 'SOON' | 'URGENT' | 'OVERDUE'

export interface DeadlineSummary {
  id: string
  taskId?: string
  taskTitle?: string
  label: string
  dueDate: ISODate
  /** 起算日と根拠（例：死亡日 + 7日）。Rule Engine が生成した文字列をそのまま表示する。 */
  basisLabel: string
  startDate: ISODate
  daysRemaining: number
  severity: DeadlineSeverity
  extendable: boolean
  critical: boolean
}

export interface Evidence {
  id: string
  taskId: string
  label: string
  kind: 'RECEIPT' | 'NOTICE' | 'PAYMENT' | 'REGISTRATION' | 'OTHER'
  recordedAt: ISODateTime
  note?: string
}

/* ---------- Asset / Liability / Contract / Benefit ---------- */

export type ConfirmationState = 'UNCONFIRMED' | 'CONFIRMED'

/** 記録の出自。公開APIからの登録は常に MANUAL。AI 由来は承認（#11）を経てのみ登録される */
export type RecordSource = 'AI' | 'MANUAL'

/**
 * 金額は日本円の整数（円単位）。未入力（不明）は amount を省略／null にし、0 円と区別する。
 * 範囲は 0 以上 1,000,000,000,000,000 未満。
 */
export type MoneyCurrency = 'JPY'

/** 利用者が「確認した」と記録した事実。金融機関等による外部確認ではない */
export interface ConfirmationRecord {
  state: ConfirmationState
  confirmedAt?: ISODateTime | null
  confirmedBy?: string | null
  /** 確認時点のエンティティ version。以後に値が変わると state は UNCONFIRMED に戻る */
  confirmedVersion?: number | null
}

export type AssetKind = 'BANK' | 'REAL_ESTATE' | 'SECURITIES' | 'CRYPTO' | 'VEHICLE' | 'OTHER'

export interface Asset {
  id: string
  caseId: string
  name: string
  kind: AssetKind
  institution?: string
  amount?: number
  currency?: MoneyCurrency
  source: RecordSource
  confirmation: ConfirmationState
  confirmationRecord?: ConfirmationRecord
  /** 生前贈与・名義預金など税務判断が必要な可能性がある項目（利用者メモ。税額計算はしない） */
  taxAttention?: boolean
  note?: string
  version: number
}

export type LiabilityKind = 'LOAN' | 'CREDIT' | 'TAX' | 'GUARANTEE' | 'OTHER'

export interface Liability {
  id: string
  caseId: string
  name: string
  kind: LiabilityKind
  creditor?: string
  amount?: number
  currency?: MoneyCurrency
  source: RecordSource
  confirmation: ConfirmationState
  confirmationRecord?: ConfirmationRecord
  note?: string
  version: number
}

/** source / confirmation / 由来Run はサーバー側で決めるため、リクエストには含めない */
export interface CreateAssetRequest {
  name: string
  kind: AssetKind
  institution?: string
  amount?: number | null
  taxAttention?: boolean
  note?: string
}

export type UpdateAssetRequest = Partial<CreateAssetRequest> & ExpectedVersion

export interface CreateLiabilityRequest {
  name: string
  kind: LiabilityKind
  creditor?: string
  amount?: number | null
  note?: string
}

export type UpdateLiabilityRequest = Partial<CreateLiabilityRequest> & ExpectedVersion

/** 確認は明示的な Command。対象 version を指定し、確認者・時刻はサーバーが記録する */
export interface ConfirmEstateItemRequest extends ExpectedVersion {
  note?: string
}

export type ContractPolicy = 'UNDECIDED' | 'CONTINUE' | 'TRANSFER' | 'CANCEL'
export type ContractProgress = 'NOT_STARTED' | 'CONTACTED' | 'COMPLETED'

export interface Contract {
  id: string
  caseId: string
  name: string
  kind: 'UTILITY' | 'TELECOM' | 'SUBSCRIPTION' | 'INSURANCE' | 'PENSION' | 'OTHER'
  provider?: string
  policy: ContractPolicy
  progress: ContractProgress
  source: 'AI' | 'MANUAL'
  guidance?: TaskGuidance
  note?: string
}

export interface Benefit {
  id: string
  caseId: string
  name: string
  kind: 'INSURANCE_PAYOUT' | 'PENSION' | 'LUMP_SUM' | 'OTHER'
  provider?: string
  amount?: number
  progress: ContractProgress
  deadline?: DeadlineSummary
  note?: string
}

/* ---------- Approval ---------- */

export type ApprovalKind =
  | 'TASK_PROPOSAL'
  | 'ASSET_PROPOSAL'
  | 'LIABILITY_PROPOSAL'
  | 'CONTRACT_PROPOSAL'
  | 'DOCUMENT_REQUEST'
  | 'ESCALATION_PROPOSAL'
  | 'EVIDENCE_PROPOSAL'

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

export interface ProposalDiffRow {
  field: string
  before: string | null
  after: string | null
  /** 承認時に利用者が修正できる項目（editable proposal） */
  editable?: boolean
}

export interface Approval {
  id: string
  caseId: string
  kind: ApprovalKind
  status: ApprovalStatus
  title: string
  summary: string
  createdAt: ISODateTime
  /** 提案元 */
  sourceDocumentId?: string
  sourceDocumentName?: string
  agentRunId?: string
  diff: ProposalDiffRow[]
  /**
   * Rule Engine が「財産処分・現金化に相当する」と判定した提案。
   * 相続方法が未確定の間は追加の確認ステップを挟む。
   */
  assetDisposal: boolean
  decidedAt?: ISODateTime
  decisionNote?: string
}

/* ---------- Insight（AIが自分で気づいたこと） ---------- */

/**
 * エージェントが監視・再計画の中で見つけた気づき。
 *
 * 承認（Approval）と違い、何かを反映するものではない。
 * 「見ていて気づいたこと」を伝えるだけで、操作は伴わない。
 *
 * 法的・税務的な性質の断定は行わない。
 * 財産の法的性質の決定や課税の判断は士業の独占業務にあたるため、
 * エージェントは事実の指摘までに留め、判断が要る場合は
 * requiresProfessional を立てて専門家への確認を促す。
 */
export type InsightKind =
  | 'STALLED_TASK'
  | 'DEADLINE_RISK'
  | 'MISSING_DOCUMENT'
  | 'POSSIBLE_CONTRACT'
  | 'POSSIBLE_ASSET'
  | 'INCONSISTENCY'
  | 'PROFESSIONAL_NEEDED'

export type InsightStatus = 'NEW' | 'ACKNOWLEDGED' | 'DISMISSED'

/** 気づきの根拠。これが無いものは表示しない。 */
export interface InsightEvidence {
  label: string
  value: string
  documentId?: string
  documentName?: string
  taskId?: string
}

export interface Insight {
  id: string
  caseId: string
  kind: InsightKind
  /** AIが書いた本文。アプリ自身の文言と区別して表示する。 */
  body: string
  /** なぜそう考えたか。利用者が自分で確かめられるようにする。 */
  evidence: InsightEvidence[]
  detectedAt: ISODateTime
  agentRunId?: string
  relatedTaskId?: string
  relatedTaskTitle?: string
  relatedDocumentId?: string
  /**
   * 法律・税務・登記・裁判所手続の判断を含む場合に true。
   * true のとき、フロントエンドは専門家への確認を促す注記を必ず表示する。
   */
  requiresProfessional: boolean
  status: InsightStatus
}

/* ---------- AI Activity / Chat ---------- */

export type AgentRunType =
  | 'document_analysis'
  | 'case_planning'
  | 'case_replanning'
  | 'task_execution'
  | 'task_monitoring'
  | 'professional_escalation'
  | 'guidance'

export type AgentRunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'

export interface AgentRunSummary {
  id: string
  caseId: string
  type: AgentRunType
  status: AgentRunStatus
  summary: string
  startedAt: ISODateTime
  finishedAt?: ISODateTime
  producedApprovalIds?: string[]
}

export interface ChatMessage {
  id: string
  caseId: string
  role: 'user' | 'assistant'
  body: string
  createdAt: ISODateTime
  /** 個別の法律・税務判断が必要な内容を含む場合に付与される定型注記 */
  professionalNotice?: boolean
  /** professional_escalation と判定された場合の遷移先 Approval */
  escalationApprovalId?: string
}

/* ---------- 同意（利用規約・個人情報の取扱い） ---------- */

/**
 * 同意を取る対象。
 *
 * CROSS_BORDER_AI を TERMS / PRIVACY と分けているのは、
 * 外国にある第三者への個人データの提供（個人情報保護法28条）が
 * 包括的な同意では足りないおそれがあるため。
 * 移転先と目的を示したうえで、個別に取れる形にしておく。
 */
export type ConsentKind = 'TERMS' | 'PRIVACY' | 'CROSS_BORDER_AI'

export interface ConsentDocument {
  kind: ConsentKind
  /** 改定のたびに上がる。同意済みバージョンと異なれば取り直す。 */
  version: string
  title: string
  /** 同意画面に出す要点。全文は url 先に置く。 */
  summary: string[]
  url: string
  required: boolean
  /** 同意済みのバージョン。未同意なら null */
  agreedVersion: string | null
  agreedAt: ISODateTime | null
}

export interface ConsentStatus {
  documents: ConsentDocument[]
  /** 必須のうち、未同意または版ずれがあるか */
  outstanding: boolean
}

/* ---------- 共通 ---------- */

export interface Paginated<T> {
  items: T[]
  total: number
}

export interface ApiError {
  code: string
  message: string
  details?: Record<string, unknown>
}
