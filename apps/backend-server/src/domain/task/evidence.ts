import type { EntityBase } from '../shared/entity.js'

/**
 * 手続きの根拠（仕様書 7.1）。
 *
 * 完了の根拠が必要な Task で、何をもって完了としたかを残す。
 * AI の判断や confidence では完了にできない。
 */
export type EvidenceKind = 'RECEIPT' | 'NOTICE' | 'PAYMENT' | 'REGISTRATION' | 'OTHER'

export interface EvidenceEntity extends EntityBase {
  taskId: string
  label: string
  kind: EvidenceKind
  note: string | null
  /** 根拠となる書類。登録済みの書類だけを指せる。 */
  documentId: string | null
  /** 誰が記録したか。認証済み actor のみ。 */
  recordedBy: string
}
