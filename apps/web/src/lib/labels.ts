import type { IconName } from '@/components/ui/Icon'
import type {
  ApprovalKind,
  InsightKind,
  ApprovalStatus,
  ContractPolicy,
  ContractProgress,
  DeadlineSeverity,
  DocumentAnalysisStatus,
  DocumentKind,
  InheritanceMethod,
  TaskStatus,
  AgentRunType,
} from '@aftercare/public-contracts'

/**
 * 仕様書セクション9のタスク状態バッジ。
 * 色覚特性に配慮し、色だけでなくアイコン（記号）でも区別する。
 */
export const TASK_STATUS_META: Record<
  TaskStatus,
  { label: string; icon: IconName; className: string }
> = {
  NOT_STARTED: { label: '未着手', icon: 'circle', className: 'badge-gray' },
  COLLECTING_INFORMATION: { label: '情報収集中', icon: 'progress', className: 'badge-blue' },
  WAITING_DOCUMENTS: { label: '書類待ち', icon: 'document', className: 'badge-blue' },
  READY: { label: '準備完了', icon: 'diamond', className: 'badge-green' },
  SUBMITTED: { label: '提出済み', icon: 'check', className: 'badge-green' },
  WAITING_EXTERNAL: { label: '先方処理待ち', icon: 'clock', className: 'badge-yellow' },
  ACTION_REQUIRED: { label: '要対応', icon: 'alert', className: 'badge-red' },
  COMPLETED: { label: '完了', icon: 'check-circle', className: 'badge-gray' },
  ESCALATED: { label: '専門家対応中', icon: 'star', className: 'badge-purple' },
}

export const TASK_STATUS_ORDER: TaskStatus[] = [
  'NOT_STARTED',
  'COLLECTING_INFORMATION',
  'WAITING_DOCUMENTS',
  'READY',
  'SUBMITTED',
  'WAITING_EXTERNAL',
  'ACTION_REQUIRED',
  'COMPLETED',
  'ESCALATED',
]

/** 仕様書セクション5のフィルタ（未着手／進行中／要対応／完了） */
export const TASK_FILTER_GROUPS: { id: string; label: string; statuses: TaskStatus[] }[] = [
  { id: 'all', label: 'すべて', statuses: TASK_STATUS_ORDER },
  { id: 'not_started', label: '未着手', statuses: ['NOT_STARTED'] },
  {
    id: 'in_progress',
    label: '進行中',
    statuses: ['COLLECTING_INFORMATION', 'WAITING_DOCUMENTS', 'READY', 'SUBMITTED', 'WAITING_EXTERNAL'],
  },
  { id: 'action_required', label: '要対応', statuses: ['ACTION_REQUIRED', 'ESCALATED'] },
  { id: 'completed', label: '完了', statuses: ['COMPLETED'] },
]

export const DEADLINE_SEVERITY_META: Record<
  DeadlineSeverity,
  { label: string; icon: IconName | null; className: string }
> = {
  NORMAL: { label: '期限まで余裕あり', icon: null, className: 'deadline-normal' },
  SOON: { label: '期限が近づいています', icon: 'warning', className: 'deadline-soon' },
  URGENT: { label: '本日が期限です', icon: 'warning', className: 'deadline-urgent' },
  OVERDUE: { label: '期限を過ぎています', icon: 'warning', className: 'deadline-overdue' },
}

export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  DEATH_CERTIFICATE: '死亡診断書',
  FAMILY_REGISTER: '戸籍',
  WILL: '遺言',
  CONTRACT: '契約書',
  BANK_STATEMENT: '預金関係書類',
  INSURANCE_POLICY: '保険証券',
  OTHER: 'その他',
}

export const DOCUMENT_STATUS_META: Record<
  DocumentAnalysisStatus,
  { label: string; className: string }
> = {
  NOT_ANALYZED: { label: '未解析', className: 'badge-gray' },
  ANALYZING: { label: '解析中', className: 'badge-blue' },
  ANALYZED: { label: '解析完了', className: 'badge-green' },
  NEEDS_REVIEW: { label: '要確認', className: 'badge-yellow' },
}

export const APPROVAL_KIND_LABEL: Record<ApprovalKind, string> = {
  TASK_PROPOSAL: 'タスクの提案',
  ASSET_PROPOSAL: '財産の提案',
  LIABILITY_PROPOSAL: '債務の提案',
  CONTRACT_PROPOSAL: '契約の提案',
  DOCUMENT_REQUEST: '書類の追加依頼',
  ESCALATION_PROPOSAL: '専門家への相談の提案',
  EVIDENCE_PROPOSAL: '完了証跡の提案',
}

export const APPROVAL_STATUS_META: Record<ApprovalStatus, { label: string; className: string }> = {
  PENDING: { label: '未確認', className: 'badge-yellow' },
  APPROVED: { label: '反映済み', className: 'badge-green' },
  REJECTED: { label: '却下', className: 'badge-gray' },
}

export const CONTRACT_POLICY_LABEL: Record<ContractPolicy, string> = {
  UNDECIDED: '未選択',
  CONTINUE: '継続',
  TRANSFER: '名義変更',
  CANCEL: '解約',
}

export const CONTRACT_PROGRESS_META: Record<
  ContractProgress,
  { label: string; className: string }
> = {
  NOT_STARTED: { label: '未対応', className: 'badge-gray' },
  CONTACTED: { label: '連絡済み', className: 'badge-blue' },
  COMPLETED: { label: '完了', className: 'badge-green' },
}

export const INHERITANCE_METHOD_LABEL: Record<InheritanceMethod, string> = {
  SIMPLE_ACCEPTANCE: '単純承認',
  LIMITED_ACCEPTANCE: '限定承認',
  RENUNCIATION: '相続放棄',
}

export const AGENT_RUN_TYPE_LABEL: Record<AgentRunType, string> = {
  document_analysis: '書類の解析',
  case_planning: '手続きの計画',
  case_replanning: '手続きの再計画',
  task_execution: 'タスクの準備',
  task_monitoring: '進捗の確認',
  professional_escalation: '専門家相談の検討',
  guidance: 'ご案内',
}

export const ASSET_KIND_LABEL: Record<string, string> = {
  BANK: '預金',
  REAL_ESTATE: '不動産',
  SECURITIES: '証券',
  CRYPTO: '暗号資産',
  VEHICLE: '自動車',
  OTHER: 'その他',
}

export const LIABILITY_KIND_LABEL: Record<string, string> = {
  LOAN: '借入',
  CREDIT: 'クレジット',
  TAX: '未納税金',
  GUARANTEE: '保証債務',
  OTHER: 'その他',
}

export const CONTRACT_KIND_LABEL: Record<string, string> = {
  UTILITY: '電気・ガス・水道',
  TELECOM: '通信',
  SUBSCRIPTION: 'サブスク',
  INSURANCE: '保険',
  PENSION: '年金',
  OTHER: 'その他',
}

export const BENEFIT_KIND_LABEL: Record<string, string> = {
  INSURANCE_PAYOUT: '保険金',
  PENSION: '年金',
  LUMP_SUM: '一時金',
  OTHER: 'その他',
}

export const SPECIAL_CIRCUMSTANCE_META: Record<
  string,
  { label: string; hint: string }
> = {
  MINOR: {
    label: '未成年',
    hint: '未成年の相続人がいる場合、遺産分割には特別代理人の選任が必要になることがあります。',
  },
  MISSING: {
    label: '行方不明',
    hint: '行方が分からない相続人がいる場合、不在者財産管理人の選任などの手続きが必要になることがあります。',
  },
  CAPACITY_CONCERN: {
    label: '判断能力に不安',
    hint: '判断能力に不安がある相続人がいる場合、成年後見制度の利用を検討する必要があることがあります。',
  },
}

/**
 * 手続きの種類ごとの見た目。
 *
 * 一覧を「読む」のではなく「見て分かる」ようにするため、
 * 行き先（役所・銀行・税務署など）を色と形で表す。
 */
export const TASK_CATEGORY_META: Record<
  string,
  { icon: IconName; label: string; fg: string; bg: string }
> = {
  役所手続き: {
    icon: 'building',
    label: '役所',
    fg: 'var(--color-state-blue)',
    bg: 'var(--color-state-blue-soft)',
  },
  '年金・保険': {
    icon: 'shield',
    label: '年金・保険',
    fg: 'var(--color-state-green)',
    bg: 'var(--color-state-green-soft)',
  },
  金融機関: {
    icon: 'bank',
    label: '金融機関',
    fg: 'var(--color-state-purple)',
    bg: 'var(--color-state-purple-soft)',
  },
  契約: {
    icon: 'plug',
    label: '契約',
    fg: 'var(--color-state-yellow)',
    bg: 'var(--color-state-yellow-soft)',
  },
  相続: {
    icon: 'scroll',
    label: '相続',
    fg: 'var(--color-brand)',
    bg: 'var(--color-brand-soft)',
  },
  税務: {
    icon: 'calculator',
    label: '税務',
    fg: 'var(--color-state-red)',
    bg: 'var(--color-state-red-soft)',
  },
  その他: {
    icon: 'checklist',
    label: 'その他',
    fg: 'var(--color-state-gray)',
    bg: 'var(--color-state-gray-soft)',
  },
}

export function taskCategoryMeta(category: string) {
  return TASK_CATEGORY_META[category] ?? TASK_CATEGORY_META['その他']
}

/**
 * 期限を「いつまでに」でまとめる。
 * 日付の羅列より、人が実際に考える単位に近い。
 */
export type DeadlineBucketId = 'overdue' | 'today' | 'soon' | 'week' | 'later' | 'none'

export const DEADLINE_BUCKETS: {
  id: DeadlineBucketId
  label: string
  tone: 'critical' | 'warning' | 'normal' | 'quiet'
}[] = [
  { id: 'overdue', label: '期限を過ぎています', tone: 'critical' },
  { id: 'today', label: '今日まで', tone: 'critical' },
  { id: 'soon', label: '3日以内', tone: 'warning' },
  { id: 'week', label: '今週中', tone: 'warning' },
  { id: 'later', label: 'それ以降', tone: 'normal' },
  { id: 'none', label: '期限の定めなし', tone: 'quiet' },
]

export function deadlineBucket(daysRemaining?: number): DeadlineBucketId {
  if (daysRemaining == null) return 'none'
  if (daysRemaining < 0) return 'overdue'
  if (daysRemaining === 0) return 'today'
  if (daysRemaining <= 3) return 'soon'
  if (daysRemaining <= 7) return 'week'
  return 'later'
}

/**
 * 気づきの種類ごとの見た目。
 *
 * どれも「事実の指摘」であり、法的・税務的な断定はしない。
 * 判断が要るものは requiresProfessional 側で注記を強制する。
 */
export const INSIGHT_KIND_META: Record<
  InsightKind,
  { label: string; icon: IconName; fg: string; bg: string }
> = {
  STALLED_TASK: {
    label: '手続きが止まっています',
    icon: 'clock',
    fg: 'var(--color-state-yellow)',
    bg: 'var(--color-state-yellow-soft)',
  },
  DEADLINE_RISK: {
    label: '期限に間に合わないおそれ',
    icon: 'warning',
    fg: 'var(--color-state-red)',
    bg: 'var(--color-state-red-soft)',
  },
  MISSING_DOCUMENT: {
    label: '足りない書類',
    icon: 'document',
    fg: 'var(--color-state-blue)',
    bg: 'var(--color-state-blue-soft)',
  },
  POSSIBLE_CONTRACT: {
    label: '未登録の契約かもしれません',
    icon: 'plug',
    fg: 'var(--color-state-blue)',
    bg: 'var(--color-state-blue-soft)',
  },
  POSSIBLE_ASSET: {
    label: '未登録の財産かもしれません',
    icon: 'bank',
    fg: 'var(--color-state-blue)',
    bg: 'var(--color-state-blue-soft)',
  },
  INCONSISTENCY: {
    label: '記載の食い違い',
    icon: 'alert',
    fg: 'var(--color-state-yellow)',
    bg: 'var(--color-state-yellow-soft)',
  },
  PROFESSIONAL_NEEDED: {
    label: '専門家の確認が必要そうです',
    icon: 'star',
    fg: 'var(--color-state-purple)',
    bg: 'var(--color-state-purple-soft)',
  },
}

/** 書類種別ごとの色と形。一覧を目で分類できるようにする。 */
export const DOCUMENT_KIND_ICON: Record<DocumentKind, { icon: IconName; fg: string; bg: string }> = {
  DEATH_CERTIFICATE: {
    icon: 'document',
    fg: 'var(--color-state-purple)',
    bg: 'var(--color-state-purple-soft)',
  },
  FAMILY_REGISTER: {
    icon: 'scroll',
    fg: 'var(--color-brand)',
    bg: 'var(--color-brand-soft)',
  },
  WILL: { icon: 'scroll', fg: 'var(--color-brand)', bg: 'var(--color-brand-soft)' },
  CONTRACT: { icon: 'plug', fg: 'var(--color-state-yellow)', bg: 'var(--color-state-yellow-soft)' },
  BANK_STATEMENT: { icon: 'bank', fg: 'var(--color-state-green)', bg: 'var(--color-state-green-soft)' },
  INSURANCE_POLICY: {
    icon: 'shield',
    fg: 'var(--color-state-blue)',
    bg: 'var(--color-state-blue-soft)',
  },
  OTHER: { icon: 'document', fg: 'var(--color-state-gray)', bg: 'var(--color-state-gray-soft)' },
}
