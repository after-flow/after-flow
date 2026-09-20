import type { ConsentKind, ISODateTime } from './resources.js'

/**
 * 新しい公開契約の同意状態。
 *
 * 既存の `ConsentStatus` はモックのフロントが参照しているため変更しない。
 * 旧 DTO への変換は Web の公開クライアント境界で行う（#3 の対応表）。
 */
export interface ConsentDocumentResource {
  kind: ConsentKind
  version: string
  title: string
  /** 同意画面に出す要点。全文は url の先に置く。 */
  summary: string[]
  url: string
  /** false の文書が未同意でも、手動での管理機能は利用できる。 */
  required: boolean
  agreedVersion: string | null
  agreedAt: ISODateTime | null
  /** 現在の版に対して有効な同意があるか。版ずれは false になる。 */
  satisfied: boolean
}

export interface ConsentStatusResource {
  documents: ConsentDocumentResource[]
  /** 必須のうち、未同意または版ずれがあるか。 */
  outstanding: boolean
  /**
   * いま利用できる範囲。
   *
   * 外部AIが使えないことと、手動管理が使えないことを区別する。
   * フロントが同意の有無から機能可否を推測しないようにサーバーが返す。
   */
  availability: {
    manualManagement: boolean
    externalAi: boolean
    missingRequired: ConsentKind[]
    missingOptional: ConsentKind[]
  }
}
