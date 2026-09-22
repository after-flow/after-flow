import type { ApprovalResource, ProposalResource } from '@aftercare/public-contracts'
import { formatDate, formatYen } from '@/lib/format'
import { ASSET_KIND_LABEL, CONTRACT_KIND_LABEL, LIABILITY_KIND_LABEL, SPECIAL_CIRCUMSTANCE_META } from '@/lib/labels'

export interface ApprovalView {
  approval: ApprovalResource
  proposal: ProposalResource | undefined
}

/** `proposalId` で Approval と Proposal を結合する（設計 §3.1）。 */
export function joinApprovals(approvals: ApprovalResource[], proposals: ProposalResource[]): ApprovalView[] {
  const byId = new Map(proposals.map((p) => [p.id, p]))
  return approvals.map((approval) => ({ approval, proposal: byId.get(approval.proposalId) }))
}

/**
 * 項目の入力のしかた。
 * Backend は payload を型どおりに検査する（金額は整数、はい/いいえは真偽値、種類は決まった値）。
 * 文字の欄で直して文字列のまま返すと訂正が必ず弾かれるので、元の型に合った入力にして、型を戻して送る。
 */
export type ProposalInput =
  | { type: 'text' }
  | { type: 'number' }
  | { type: 'boolean' }
  | { type: 'date' }
  | { type: 'select'; options: { value: string; label: string }[]; nullable?: boolean }

export interface ProposalRow {
  key: string
  label: string
  /** 入力欄に入れる値（数値・真偽値も文字列にする。null は空） */
  value: string
  /** 直さないときに見せる文 */
  display: string
  editable: boolean
  input: ProposalInput
}

function toDisplayValue(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function options(labels: Record<string, string>): { value: string; label: string }[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }))
}

const PERSON_ROLE_LABEL: Record<string, string> = {
  HEIR_CANDIDATE: '相続人の候補',
  DECEASED: '故人',
  RELATED: '関係者',
  PROFESSIONAL: '専門家',
}

const SPECIAL_CIRCUMSTANCE_LABEL = Object.fromEntries(
  Object.entries(SPECIAL_CIRCUMSTANCE_META).map(([k, v]) => [k, v.label]),
)

type FieldMeta = { label: string; input: ProposalInput }

const COMMON_FIELDS: Record<string, FieldMeta> = {
  name: { label: '名前', input: { type: 'text' } },
  note: { label: 'メモ', input: { type: 'text' } },
}

/** 登録する項目の名前と入力のしかた（Backend の entity-appliers の項目に対応する） */
const ENTITY_FIELDS: Record<string, Record<string, FieldMeta>> = {
  ASSET_PROPOSAL: {
    kind: { label: '種類', input: { type: 'select', options: options(ASSET_KIND_LABEL) } },
    institution: { label: '金融機関など', input: { type: 'text' } },
    amount: { label: '金額（円）', input: { type: 'number' } },
    taxAttention: { label: '税金の注意', input: { type: 'boolean' } },
  },
  LIABILITY_PROPOSAL: {
    kind: { label: '種類', input: { type: 'select', options: options(LIABILITY_KIND_LABEL) } },
    creditor: { label: '借入先など', input: { type: 'text' } },
    amount: { label: '金額（円）', input: { type: 'number' } },
  },
  CONTRACT_PROPOSAL: {
    kind: { label: '種類', input: { type: 'select', options: options(CONTRACT_KIND_LABEL) } },
    provider: { label: '契約先', input: { type: 'text' } },
  },
  PERSON_PROPOSAL: {
    nameKana: { label: 'ふりがな', input: { type: 'text' } },
    relationshipLabel: { label: '続柄', input: { type: 'text' } },
    role: { label: '立場', input: { type: 'select', options: options(PERSON_ROLE_LABEL) } },
    isHeir: { label: '相続人か', input: { type: 'boolean' } },
    dateOfBirth: { label: '生年月日', input: { type: 'date' } },
    specialCircumstance: {
      label: '特別な事情',
      input: { type: 'select', options: options(SPECIAL_CIRCUMSTANCE_LABEL), nullable: true },
    },
    contact: { label: '連絡先', input: { type: 'text' } },
  },
}

/** 項目の説明が無いときは、値の型から入力のしかたを決める */
function inferInput(value: unknown): ProposalInput {
  if (typeof value === 'number') return { type: 'number' }
  if (typeof value === 'boolean') return { type: 'boolean' }
  if (typeof value === 'string' && ISO_DATE.test(value)) return { type: 'date' }
  return { type: 'text' }
}

function displayOf(key: string, value: unknown, input: ProposalInput): string {
  if (value == null || value === '') return ''
  if (input.type === 'boolean') return value === true ? 'はい' : value === false ? 'いいえ' : toDisplayValue(value)
  if (input.type === 'select') return input.options.find((o) => o.value === value)?.label ?? toDisplayValue(value)
  if (input.type === 'number' && typeof value === 'number') return key === 'amount' ? formatYen(value) : value.toLocaleString('ja-JP')
  if (typeof value === 'string' && ISO_DATE.test(value)) return formatDate(value)
  return toDisplayValue(value)
}

function row(key: string, label: string, value: unknown, editable: boolean, input: ProposalInput = inferInput(value)): ProposalRow {
  return { key, label, value: toDisplayValue(value), display: displayOf(key, value, input), editable, input }
}

const TASK_PROPOSAL_HIDDEN_KEYS = new Set(['taskId', 'expectedTaskVersion', 'operation', 'targetId', 'expectedVersion'])

function isEntityKind(kind: ProposalResource['kind']): boolean {
  return kind === 'ASSET_PROPOSAL' || kind === 'LIABILITY_PROPOSAL' || kind === 'CONTRACT_PROPOSAL' || kind === 'PERSON_PROPOSAL'
}

function entityFields(proposal: ProposalResource): Record<string, unknown> {
  const payload = proposal.payload
  return (payload.fields ?? payload) as Record<string, unknown>
}

/**
 * 提案の payload を、確認画面に並べる行に変換する（設計 §3.1）。
 * kind ごとに payload の形が違うため、既知の形はラベル付きで、未知の形はキー名のまま出す。
 */
export function proposalRows(proposal: ProposalResource): ProposalRow[] {
  const payload = proposal.payload

  if (isEntityKind(proposal.kind)) {
    const meta = { ...COMMON_FIELDS, ...ENTITY_FIELDS[proposal.kind] }
    return Object.entries(entityFields(proposal)).map(([key, value]) => {
      const m = meta[key]
      return row(key, m?.label ?? key, value, true, m?.input ?? inferInput(value))
    })
  }

  switch (proposal.kind) {
    case 'DOCUMENT_REQUEST': {
      const documents = Array.isArray(payload.documents) ? (payload.documents as { label?: string }[]) : []
      return documents.map((d, i) => row(`documents.${i}.label`, `お願いする書類 ${i + 1}`, d.label ?? '', true, { type: 'text' }))
    }
    case 'EVIDENCE_PROPOSAL': {
      const rows: ProposalRow[] = [
        row('label', '記録の内容', toDisplayValue(payload.label), true, { type: 'text' }),
        row('kind', '種類', toDisplayValue(payload.kind), false, { type: 'text' }),
      ]
      const note = toDisplayValue(payload.note)
      if (note) rows.push(row('note', 'メモ', note, true, { type: 'text' }))
      return rows
    }
    case 'ESCALATION_PROPOSAL': {
      const documents = Array.isArray(payload.documents) ? payload.documents.length : 0
      return [
        row('reason', '相談したい理由', toDisplayValue(payload.reason), false, { type: 'text' }),
        row('documents', '関連する資料', `${documents}件`, false, { type: 'text' }),
      ]
    }
    case 'TASK_PROPOSAL':
    default: {
      return Object.entries(payload)
        .filter(([key]) => !TASK_PROPOSAL_HIDDEN_KEYS.has(key))
        .map(([key, value]) => row(key, key, value, false))
    }
  }
}

/** 全角の数字や「,」「円」を含めて、金額の入力を整数にする。読めなければ null ではなく NaN を返す */
function parseInteger(value: string): number {
  const normalized = value
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,，、\s円]/g, '')
  if (!/^\d+$/.test(normalized)) return Number.NaN
  return Number(normalized)
}

/** 直した値が送れない形なら、その理由。送れるなら null */
export function editError(row: ProposalRow, value: string): string | null {
  if (row.input.type === 'number' && value.trim() !== '' && !Number.isSafeInteger(parseInteger(value))) {
    return '0以上の整数で入力してください（例：3240000）'
  }
  return null
}

/** 入力欄の文字を、元の payload と同じ型に戻す */
function coerce(row: ProposalRow | undefined, original: unknown, value: string): unknown {
  const input = row?.input ?? inferInput(original)
  const empty = value.trim() === ''
  switch (input.type) {
    case 'number':
      return empty ? null : parseInteger(value)
    case 'boolean':
      return value === 'true'
    case 'date':
      return empty ? null : value
    case 'select':
      return empty ? null : value
    case 'text':
      // もともと空（null）だった欄は、空のままなら null に戻す
      return empty && original == null ? null : value
  }
}

/**
 * 編集後の payload を作る。元の payload を複製し、`proposalRows` が示したキーだけを差し替える
 * （キーの追加・削除はしない）。値は元の型に戻す。
 */
export function applyProposalEdits(proposal: ProposalResource, edits: Record<string, string>): Record<string, unknown> {
  const payload: Record<string, unknown> = JSON.parse(JSON.stringify(proposal.payload))
  const rows = new Map(proposalRows(proposal).map((r) => [r.key, r]))
  for (const [key, value] of Object.entries(edits)) {
    if (proposal.kind === 'DOCUMENT_REQUEST' && key.startsWith('documents.')) {
      const [, indexStr] = key.split('.')
      const index = Number(indexStr)
      const documents = Array.isArray(payload.documents) ? (payload.documents as Record<string, unknown>[]) : []
      if (documents[index]) documents[index].label = value
      continue
    }
    if (isEntityKind(proposal.kind)) {
      const fields = (payload.fields ?? payload) as Record<string, unknown>
      fields[key] = coerce(rows.get(key), fields[key], value)
      continue
    }
    payload[key] = value
  }
  return payload
}
