/**
 * 書類検査の状態（ADR 0002）。
 *
 * 未検査を安全側の状態として扱わないために、「まだ検査していない」と
 * 「検査して問題なかった」を別の値にしてある。
 */
export type InspectionStatus =
  /** 保存済みだが検査していない。検査器が未接続の場合もここで止まる。 */
  | 'PENDING'
  /** 検査中。結果はまだ無い。 */
  | 'IN_PROGRESS'
  /** 検査が完了し、配信してよいと判定された。 */
  | 'PASSED'
  /** 検査で拒否された。利用も配信もできない。 */
  | 'REJECTED'
  /** 検査そのものが失敗した。合格でも拒否でもない。 */
  | 'FAILED'

/** 検査で見つかった事象の種類。値そのものは記録しない。 */
export type InspectionFindingKind = 'SENSITIVE_NUMBER' | 'UNSUPPORTED_CONTENT' | 'UNREADABLE'

export interface InspectionFinding {
  kind: InspectionFindingKind
  /** 利用者に見せる説明。検出した値そのものは含めない。 */
  message: string
  /** 何ページ目かなど、確認の手がかり。値は入れない。 */
  locationHint: string | null
}

export interface InspectionResult {
  status: Extract<InspectionStatus, 'PASSED' | 'REJECTED' | 'FAILED'>
  findings: InspectionFinding[]
  /**
   * 検査した実装の識別子と版。
   *
   * どの版で合格したかを残さないと、方式を入れ替えたときに
   * 過去の合格をそのまま信用してよいか判断できない。
   */
  inspectorId: string
  inspectorVersion: string
  /** マスキング済みの版を作った場合の参照。原本とは別に保持する。 */
  maskedObjectKey: string | null
}

/**
 * 外部AIへ配信してよいか。
 *
 * 未検査・拒否・失敗はいずれも配信しない。呼び出し側で
 * `!== 'REJECTED'` のような書き方をすると未検査が通る。
 */
export function isDeliverableToAi(status: InspectionStatus): boolean {
  return status === 'PASSED'
}

/** 利用者に見せる状態から、検査が完了しているかを判定する。 */
export function isInspectionComplete(status: InspectionStatus): boolean {
  return status === 'PASSED' || status === 'REJECTED' || status === 'FAILED'
}
