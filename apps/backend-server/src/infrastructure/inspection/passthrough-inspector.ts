import type { InspectionRequest } from '../../application/ports/inspection.js'
import type { DocumentInspector } from '../../application/ports/inspection.js'
import type { InspectionResult } from '../../domain/document/inspection.js'

/**
 * デモ・開発用の素通し検査アダプタ。
 *
 * マイナンバー等の実検知・マスキングは行わない（#25/#26で方式決定・実装するまでの仮置き）。
 * `DOCUMENT_INSPECTION_MODE=passthrough-dev` を明示指定した環境だけで使う
 * （`composition.ts` 参照）。本番でこの Adapter を使わない。
 */
export class PassthroughDocumentInspector implements DocumentInspector {
  readonly id = 'passthrough-dev'
  readonly version = '1'

  async inspect(_request: InspectionRequest): Promise<InspectionResult> {
    return { status: 'PASSED', findings: [], inspectorId: this.id, inspectorVersion: this.version, maskedObjectKey: null }
  }
}
