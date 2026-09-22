import type { DocumentKind } from './document.js'

/**
 * 書類の読み取り対象フィールド（#196 の最小実装）。
 *
 * AI サーバー側の抽出結果はこの `id` を鍵に返す（契約はサービス間で
 * 個別に持つ。`AGENTS.md` により Backend/AI はソースを共有しない）。
 * 対応する書類種別を増やすときはここへ追加する。
 */
export interface DocumentAnalysisField {
  id: string
  label: string
  required: boolean
}

const BANK_STATEMENT_FIELDS: readonly DocumentAnalysisField[] = [
  { id: 'institution', label: '金融機関名', required: true },
  { id: 'amount', label: '残高', required: true },
]

const FIELDS_BY_KIND: Partial<Record<DocumentKind, readonly DocumentAnalysisField[]>> = {
  BANK_STATEMENT: BANK_STATEMENT_FIELDS,
}

/** 読み取り対応済みの書類種別なら対象フィールドを返す。未対応は null（#196 は BANK_STATEMENT のみ）。 */
export function analysisFieldsFor(kind: DocumentKind): readonly DocumentAnalysisField[] | null {
  return FIELDS_BY_KIND[kind] ?? null
}
