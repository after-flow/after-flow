import type { ApprovalResource, ProposalResource } from '@aftercare/public-contracts'
import { ASSET_KIND_LABEL } from '@/lib/labels'

export interface ApprovalView {
  approval: ApprovalResource
  proposal: ProposalResource | undefined
}

/** `proposalId` で Approval と Proposal を結合する（設計 §3.1）。 */
export function joinApprovals(approvals: ApprovalResource[], proposals: ProposalResource[]): ApprovalView[] {
  const byId = new Map(proposals.map((p) => [p.id, p]))
  return approvals.map((approval) => ({ approval, proposal: byId.get(approval.proposalId) }))
}

export interface ProposalRow {
  key: string
  label: string
  value: string
  editable: boolean
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

/**
 * 財産の登録（書類の読み取りから届く提案）の項目。利用者に内部のキー名や列挙値を見せない。
 * 種類と税の確認は選択肢の値なので、この画面では直さず表示だけにする。
 */
const ASSET_FIELDS: Record<string, { label: string; editable: boolean; display?: (value: unknown) => string }> = {
  name: { label: '名前', editable: true },
  kind: { label: '種類', editable: false, display: (value) => ASSET_KIND_LABEL[String(value)] ?? toDisplayValue(value) },
  institution: { label: '金融機関', editable: true },
  amount: { label: '金額（円）', editable: true },
  taxAttention: { label: '税の確認', editable: false, display: (value) => (value === true ? '必要' : value === false ? '不要' : '') },
  note: { label: 'メモ', editable: true },
}

/** 直した値を保存する型に戻す。金額は数値で保存されるため、桁区切りや「円」を除いて数値にする。 */
function coerceEdit(key: string, original: unknown, value: string): unknown {
  if (key !== 'amount' && typeof original !== 'number') return value
  const normalized = value.normalize('NFKC').replace(/[,円\s]/g, '')
  if (normalized === '') return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : value
}

const TASK_PROPOSAL_HIDDEN_KEYS = new Set(['taskId', 'expectedTaskVersion', 'operation', 'targetId', 'expectedVersion'])

/**
 * 提案の payload を、確認画面に並べる行に変換する（設計 §3.1）。
 * kind ごとに payload の形が違うため、既知の形はラベル付きで、未知の形はキー名のまま出す。
 */
export function proposalRows(proposal: ProposalResource): ProposalRow[] {
  const payload = proposal.payload

  switch (proposal.kind) {
    case 'ASSET_PROPOSAL': {
      const fields = (payload.fields ?? payload) as Record<string, unknown>
      return Object.entries(fields).map(([key, value]) => {
        const field = ASSET_FIELDS[key]
        return {
          key,
          label: field?.label ?? key,
          value: field?.display ? field.display(value) : toDisplayValue(value),
          editable: field?.editable ?? true,
        }
      })
    }
    case 'LIABILITY_PROPOSAL':
    case 'CONTRACT_PROPOSAL':
    case 'PERSON_PROPOSAL': {
      const fields = (payload.fields ?? payload) as Record<string, unknown>
      return Object.entries(fields).map(([key, value]) => ({
        key,
        label: key,
        value: toDisplayValue(value),
        editable: true,
      }))
    }
    case 'DOCUMENT_REQUEST': {
      const documents = Array.isArray(payload.documents) ? (payload.documents as { label?: string }[]) : []
      return documents.map((d, i) => ({ key: `documents.${i}.label`, label: `お願いする書類 ${i + 1}`, value: d.label ?? '', editable: true }))
    }
    case 'EVIDENCE_PROPOSAL': {
      const label = toDisplayValue(payload.label)
      const kind = toDisplayValue(payload.kind)
      const note = toDisplayValue(payload.note)
      const rows: ProposalRow[] = [
        { key: 'label', label: '記録の内容', value: label, editable: true },
        { key: 'kind', label: '種類', value: kind, editable: false },
      ]
      if (note) rows.push({ key: 'note', label: 'メモ', value: note, editable: true })
      return rows
    }
    case 'ESCALATION_PROPOSAL': {
      const documents = Array.isArray(payload.documents) ? payload.documents.length : 0
      return [
        { key: 'reason', label: '相談したい理由', value: toDisplayValue(payload.reason), editable: false },
        { key: 'documents', label: '関連する資料', value: `${documents}件`, editable: false },
      ]
    }
    case 'TASK_PROPOSAL':
    default: {
      return Object.entries(payload)
        .filter(([key]) => !TASK_PROPOSAL_HIDDEN_KEYS.has(key))
        .map(([key, value]) => ({ key, label: key, value: toDisplayValue(value), editable: false }))
    }
  }
}

/**
 * 編集後の payload を作る。元の payload を複製し、`proposalRows` が示したキーだけを差し替える
 * （キーの追加・削除はしない）。
 */
export function applyProposalEdits(proposal: ProposalResource, edits: Record<string, string>): Record<string, unknown> {
  const payload: Record<string, unknown> = JSON.parse(JSON.stringify(proposal.payload))
  for (const [key, value] of Object.entries(edits)) {
    if (proposal.kind === 'DOCUMENT_REQUEST' && key.startsWith('documents.')) {
      const [, indexStr] = key.split('.')
      const index = Number(indexStr)
      const documents = Array.isArray(payload.documents) ? (payload.documents as Record<string, unknown>[]) : []
      if (documents[index]) documents[index].label = value
      continue
    }
    if (proposal.kind === 'ASSET_PROPOSAL' || proposal.kind === 'LIABILITY_PROPOSAL' || proposal.kind === 'CONTRACT_PROPOSAL' || proposal.kind === 'PERSON_PROPOSAL') {
      const fields = (payload.fields ?? payload) as Record<string, unknown>
      fields[key] = coerceEdit(key, fields[key], value)
      continue
    }
    payload[key] = value
  }
  return payload
}
