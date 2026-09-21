/**
 * 既存フロントエンド向け Public API のリソース型。
 * 期限計算・状態遷移の検証はすべて Backend の Rule Engine が行うため、
 * フロントエンドはここで受け取った値をそのまま表示する（再計算しない）。
 *
 * このファイルに残っている型は「Backend の Zod スキーマが `satisfies ZodType<…>` で
 * 直接参照している契約」（Person/Asset/Liability/Contract/Benefit/Insight/Consent と
 * その Request 型、TaskGuidance 一式）のみ。FE の画面は `dto/{case,task,proposal,
 * document,agent,chat,overview}.ts` の `*Resource` を直接使う（変換層は作らない）。
 */

import type { DeadlineResource } from './task.js'

export type ISODate = string // YYYY-MM-DD
export type ISODateTime = string

/* ---------- Envelope / Pagination (Backend Public API) ---------- */

export interface ExpectedVersion {
  expectedVersion: number
}

/* ---------- Case ---------- */

export type CaseStatus = 'ACTIVE' | 'CLOSED'

export type YesNoUnknown = 'YES' | 'NO' | 'UNKNOWN'

export interface CaseProfile {
  /** 加入していた健康保険。資格喪失届の窓口と、葬祭費か埋葬料かが決まる */
  healthInsurance?: 'NATIONAL' | 'EMPLOYEE' | 'LATE_ELDERLY' | 'UNKNOWN'
  /** 受け取っていた年金。受給停止の期限（厚生年金10日・国民年金14日）と未支給年金に関わる */
  pension?: 'EMPLOYEES' | 'NATIONAL_ONLY' | 'NONE' | 'UNKNOWN'
  /** 仕事。勤務先の手続き・個人事業の届出・死亡一時金などに関わる */
  occupation?: 'EMPLOYEE' | 'SELF_EMPLOYED' | 'NONE' | 'UNKNOWN'
  /** 持ち家や土地。相続登記（義務）と固定資産税の届出に関わる */
  realEstate?: YesNoUnknown
  /** 自動車。名義変更に関わる */
  car?: YesNoUnknown
  /** 住宅ローン。団体信用生命保険で完済される場合がある */
  mortgage?: YesNoUnknown
  /** 質問に答えた日時。未回答ならホームで回答を促す */
  answeredAt?: ISODateTime
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

/* ---------- Decision（相続方法） ---------- */

export type InheritanceMethod = 'SIMPLE_ACCEPTANCE' | 'LIMITED_ACCEPTANCE' | 'RENUNCIATION'

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

export type DocumentKind =
  | 'DEATH_CERTIFICATE'
  | 'FAMILY_REGISTER'
  | 'WILL'
  | 'CONTRACT'
  | 'BANK_STATEMENT'
  | 'INSURANCE_POLICY'
  | 'OTHER'

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

/**
 * BE の `domain/contract/contract.ts` の `Contract.guidance` が参照するため残す
 * （`ContractResource` は存在せず、BE は旧 `Contract` DTO のまま `guidance?: TaskGuidance` を返す）。
 * エージェントが「準備」できる範囲（提出先・持ち物・手順・様式の案内）まで。書類の作成・完成は行わない。 */
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

export type ContractKind = 'UTILITY' | 'TELECOM' | 'SUBSCRIPTION' | 'INSURANCE' | 'PENSION' | 'OTHER'
export type BenefitKind = 'INSURANCE_PAYOUT' | 'PENSION' | 'LUMP_SUM' | 'OTHER'

/** 方針は利用者が記録した意向であり、実際の解約・名義変更が行われたことを意味しない */
export interface PolicyRecord {
  decidedAt: ISODateTime | null
  decidedBy: string | null
  note?: string | null
}

/**
 * 進捗の出自。USER_REPORTED は利用者の自己申告（COMPLETED でも外部確認ではない）。
 * PREPARATION_COMPLETED / EXTERNALLY_CONFIRMED は将来の連携用で、公開APIからは USER_REPORTED のみ記録される。
 */
export type ProgressSource = 'USER_REPORTED' | 'PREPARATION_COMPLETED' | 'EXTERNALLY_CONFIRMED'

export interface ProgressRecord {
  reportedAt: ISODateTime | null
  reportedBy: string | null
  source: ProgressSource | null
  note?: string | null
}

export interface Contract {
  id: string
  caseId: string
  name: string
  kind: ContractKind
  provider?: string
  policy: ContractPolicy
  progress: ContractProgress
  source: RecordSource
  /** 案内文は AI 提案の承認（#11）で付与される。公開APIからは編集できない */
  guidance?: TaskGuidance
  note?: string
  policyRecord?: PolicyRecord
  progressRecord?: ProgressRecord
  version: number
}

export interface Benefit {
  id: string
  caseId: string
  name: string
  kind: BenefitKind
  provider?: string
  amount?: number
  currency?: MoneyCurrency
  progress: ContractProgress
  /**
   * 期限は #9 の期限計算で付与される。公開APIからは受給資格や金額・期限を推定しない。
   * BE の `benefitResourceSchema` には deadline が無いため、実際には来ない
   * （常に undefined 扱い）。将来 BE が返し始めたときの受け皿として型だけ用意する。
   */
  deadline?: DeadlineResource | null
  note?: string
  progressRecord?: ProgressRecord
  version: number
}

/** policy / progress / source / guidance は Command またはサーバーが決めるため、登録・編集リクエストには含めない */
export interface CreateContractRequest {
  name: string
  kind: ContractKind
  provider?: string
  note?: string
}

export type UpdateContractRequest = Partial<CreateContractRequest> & ExpectedVersion

export interface CreateBenefitRequest {
  name: string
  kind: BenefitKind
  provider?: string
  amount?: number | null
  note?: string
}

export type UpdateBenefitRequest = Partial<CreateBenefitRequest> & ExpectedVersion

/** 方針の変更 Command。CANCEL は「解約予定」を記録するだけで、解約手続きそのものではない */
export interface SetContractPolicyRequest extends ExpectedVersion {
  policy: ContractPolicy
  note?: string
}

/** 進捗の報告 Command。後退（COMPLETED→CONTACTED 等）は訂正として note が必須 */
export interface ReportProgressRequest extends ExpectedVersion {
  progress: ContractProgress
  note?: string
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
  /**
   * 参照先の現在の状態。検出時点から変わった（STALE）／保管・除外された（UNAVAILABLE）根拠は
   * 確定した事実として扱わない。省略時は CURRENT。
   */
  freshness?: EvidenceFreshness
}

export type EvidenceFreshness = 'CURRENT' | 'STALE' | 'UNAVAILABLE'

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
  /** 閲覧者（actor）ごとの既読／非表示状態。内容は共有、状態は個人ごと */
  status: InsightStatus
  statusUpdatedAt?: ISODateTime | null
  /** 専門家確認に関する注記（AI本文とは区別する） */
  professionalReviewNote?: string
}

/** 既読・非表示は閲覧者ごとの明示的な Command。NEW→ACKNOWLEDGED→DISMISSED の順で、DISMISSED から戻す操作は無い */
export interface AcknowledgeInsightRequest {
  note?: string
}

export interface DismissInsightRequest {
  reason?: string
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

