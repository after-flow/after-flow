import type { InspectionResult } from '../../domain/document/inspection.js'

/**
 * 書類検査のポート（ADR 0002 の分割 1）。
 *
 * 採用する検知・マスキング方式は未決定。Application が方式に依存しないよう、
 * 入力と出力だけを固定する。実 Adapter は方式決定後の Issue で実装する。
 */
export interface InspectionRequest {
  tenantId: string
  caseId: string
  documentId: string
  /** 隔離領域に置かれた検査対象の参照。公開領域の原本ではない。 */
  quarantineObjectKey: string
  contentType: string
  sizeBytes: number
}

export interface DocumentInspector {
  /** 検査実装の識別子。どの版で合格したかを記録するために使う。 */
  readonly id: string
  readonly version: string
  inspect(request: InspectionRequest): Promise<InspectionResult>
}

/**
 * 隔離保存領域。
 *
 * 検査前の書類を置く一時領域で、「原本を保持しない」こととは別。
 * 保持期間と削除条件は方式決定時に定める。
 */
export interface QuarantineStorage {
  put(key: string, content: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  /** 検査後の移動・破棄。孤立オブジェクトの回収にも使う。 */
  delete(key: string): Promise<void>
}
