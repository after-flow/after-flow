import type { EntityBase } from '../shared/entity.js'

/**
 * 同意（仕様書 6.2、ConsentPage の永続化）。
 *
 * CROSS_BORDER_AI を TERMS / PRIVACY と分けているのは、外国にある
 * 第三者への個人データの提供が包括的な同意では足りないおそれがあるため。
 * 移転先と目的を示したうえで、個別に取れる形にしておく。
 */
export type ConsentKind = 'TERMS' | 'PRIVACY' | 'CROSS_BORDER_AI'

/**
 * 同意を求める文書の定義。
 *
 * 文面・提供先・目的・保持条件は業務側が承認した設定から読み込む。
 * 実装側で架空の提供先や国名を作らない。
 */
export interface ConsentDocumentDefinition {
  kind: ConsentKind
  /** 改定のたびに上がる。同意済みの版と異なれば取り直す。 */
  version: string
  title: string
  /** 同意画面に出す要点。全文は url の先に置く。 */
  summary: string[]
  url: string
  /** false の場合、未同意でも手動管理の機能は使える。 */
  required: boolean
}

export interface ConsentCatalog {
  /**
   * 文面が確定していない仮の定義かどうか。
   *
   * 仮のまま本番で使わないための印。true の設定は本番で拒否する。
   */
  placeholder: boolean
  documents: ConsentDocumentDefinition[]
}

export type ConsentAction = 'AGREED' | 'REVOKED'

/**
 * 変更履歴の控え。
 *
 * 時刻を持たないのは、保存側が配列の中にサーバー時刻を入れられないため。
 * プロセスの時計で埋めると、環境ごとにずれた時刻が履歴として残る。
 * 時刻付きの正本は AuditEvent 側にある。
 */
export interface ConsentHistoryEntry {
  action: ConsentAction
  version: string
}

/** 利用者ごとの同意状態。 */
export interface ConsentRecord extends EntityBase {
  userId: string
  kind: ConsentKind
  /** 同意済みの版。撤回済み・未同意なら null。 */
  agreedVersion: string | null
  agreedAt: string | null
  /**
   * 直近の変更履歴。
   * 正本は監査イベント側で、ここは表示と判定のための控え。
   */
  history: ConsentHistoryEntry[]
}

export const MAX_HISTORY_ENTRIES = 50

/** 現在の版に対して有効な同意があるか。 */
export function isSatisfied(record: ConsentRecord | null, definition: ConsentDocumentDefinition): boolean {
  return record?.agreedVersion === definition.version
}
