import type { IconName } from '@/kit/Icon'
import type {
  ContractProgress,
  DocumentKind,
  InheritanceMethod,
  InsightKind,
  TaskStatus,
} from '@aftercare/public-contracts'

/**
 * 仕様書セクション9のタスク状態の記号。
 * 色覚特性に配慮し、色だけでなくアイコン（記号）でも区別する。
 * 画面に出す言葉は kit/words.ts の TASK_STATUS_WORD を使う。
 */
export const TASK_STATUS_META: Record<
  TaskStatus,
  { label: string; icon: IconName }
> = {
  NOT_STARTED: { label: '未着手', icon: 'circle' },
  COLLECTING_INFORMATION: { label: '情報収集中', icon: 'progress' },
  WAITING_DOCUMENTS: { label: '書類待ち', icon: 'document' },
  READY: { label: '準備完了', icon: 'diamond' },
  SUBMITTED: { label: '提出済み', icon: 'check' },
  WAITING_EXTERNAL: { label: '先方処理待ち', icon: 'clock' },
  ACTION_REQUIRED: { label: '要対応', icon: 'alert' },
  COMPLETED: { label: '完了', icon: 'check-circle' },
  ESCALATED: { label: '専門家対応中', icon: 'star' },
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

export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  DEATH_CERTIFICATE: '死亡診断書',
  FAMILY_REGISTER: '戸籍',
  WILL: '遺言',
  CONTRACT: '契約書',
  BANK_STATEMENT: '預金関係書類',
  INSURANCE_POLICY: '保険証券',
  OTHER: 'その他',
}

export const CONTRACT_PROGRESS_META: Record<
  ContractProgress,
  { label: string }
> = {
  NOT_STARTED: { label: '未対応' },
  CONTACTED: { label: '連絡済み' },
  COMPLETED: { label: '完了' },
}

export const INHERITANCE_METHOD_LABEL: Record<InheritanceMethod, string> = {
  SIMPLE_ACCEPTANCE: '単純承認',
  LIMITED_ACCEPTANCE: '限定承認',
  RENUNCIATION: '相続放棄',
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
    label: '前提の変化・食い違い',
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
