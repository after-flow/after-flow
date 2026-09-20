import type { EntityBase } from '../shared/entity.js'
import type { InspectionFinding, InspectionStatus } from './inspection.js'
import type { SupportedContentType } from './content-type.js'

/**
 * 原本の保存状態（仕様書 15.4）。
 *
 * Cloud Storage への書き込みと Firestore の更新は原子的ではない。
 * 「メタデータだけ作った」段階と「原本まで置けた」段階を分けて持つ。
 */
export type DocumentStorageState =
  /** メタデータだけ作成済み。原本はまだ置けていない。 */
  | 'UPLOADING'
  /** 原本まで保存できた。 */
  | 'STORED'
  /** 途中で失敗し、回収済み。再登録が必要。 */
  | 'FAILED'

/**
 * 解析の受付状態。
 *
 * 保存完了と解析受付は別の状態。AI が未接続のまま QUEUED にすると、
 * 画面は解析が始まったように見える。
 */
export type DocumentAnalysisState =
  | 'NOT_REQUESTED'
  /** 機能が接続されていないため受け付けられない。 */
  | 'NOT_CONNECTED'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'

export type DocumentKind =
  | 'DEATH_CERTIFICATE'
  | 'FAMILY_REGISTER'
  | 'WILL'
  | 'CONTRACT'
  | 'BANK_STATEMENT'
  | 'INSURANCE_POLICY'
  | 'OTHER'

export interface DocumentInspectionState {
  status: InspectionStatus
  findings: InspectionFinding[]
  /** どの検査実装のどの版で判定したか。未検査なら null。 */
  inspectorId: string | null
  inspectorVersion: string | null
  maskedObjectKey: string | null
}

export interface DocumentEntity extends EntityBase {
  fileName: string
  contentType: SupportedContentType
  sizeBytes: number
  /** 原本の内容ハッシュ。重複の検出と改変の検知に使う。 */
  sha256: string
  /** 原本の保存先。Web には渡さない。 */
  objectKey: string
  storageState: DocumentStorageState
  kind: DocumentKind
  /** 種別を誰が決めたか。AI 由来は利用者入力から偽装できない。 */
  kindSource: 'MANUAL' | 'AI'
  inspection: DocumentInspectionState
  analysisState: DocumentAnalysisState
  agentRunId: string | null
  /**
   * 通常の一覧からの除外。
   *
   * 個人データの完全消去とは別。監査や根拠からの参照は壊さない。
   */
  archived: boolean
  archivedAt: string | null
}

/** 通常の一覧に出すか。 */
export function isListedNormally(document: DocumentEntity): boolean {
  return !document.archived && document.storageState === 'STORED'
}
