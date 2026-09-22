import type { CaseStatus, ISODate, ISODateTime } from './resources.js'
import type { CaseProfileResource } from './case-profile.js'

/**
 * 新しい公開契約の Case。
 *
 * 既存の `Case` はモックのフロントが参照しているため変更しない。
 * 旧 DTO への変換は Web の公開クライアント境界で行う（#3 の対応表）。
 */

/**
 * この利用者がこの Case に対して行える操作。
 *
 * フロントは自前で権限を推測せず、ここに無い操作の導線を出さない。
 * 表示の都合で導線を出しても、Backend は同じ条件で再検証する。
 */
export type CaseAction = 'UPDATE_BASIC_INFO' | 'ADMINISTER'

export interface CaseResource {
  id: string
  deceasedName: string
  deceasedNameKana: string | null
  dateOfDeath: ISODate
  dateOfBirth: ISODate | null
  /**
   * 相続の開始を知った日。
   * 死亡日とは別の事実。不明な場合は null で、死亡日で補完しない。
   */
  knownAt: ISODate | null
  /** 手続きの出し分け条件（申し送り 3-1）。未回答（欠落）ならキー自体を出さない。 */
  profile?: CaseProfileResource
  /** 申告された手続き担当者名。認証上の本人確認の根拠ではない。 */
  ownerName: string
  /** 申告された続柄。法的な相続人の認定ではない。 */
  relationshipToDeceased: string
  municipality: string | null
  /** 葬儀・火葬が済んだと利用者が記録した日時。null は「まだ」。 */
  funeralCompletedAt: ISODateTime | null
  /**
   * 作成者本人に対応する Person の ID。
   * 作成時に本人を Person として同時登録した場合だけ入る。それ以外は null。
   * 作成時点の紐付けを記録した履歴値であり、以後の membership の付け替えには
   * 追従しない。呼び出し主体が本人かどうかの判定には使わず `selfPersonId` を使う。
   */
  ownerPersonId: string | null
  /**
   * 呼び出している利用者自身に紐付く Person の ID（membership 由来）。
   * 放棄前ロックなど「ログインしている本人」の判定はこちらを使う。
   * allowedActions と同じく呼び出し主体ごとに変わる値。未紐付けなら null。
   * 紐付いた Person が非相続人（isHeir false）のこともあり、その場合は
   * 相続方法の確定はできない（対象は有効な相続人候補ではない扱いになる）。
   */
  selfPersonId: string | null
  /** Owner-managed pause of AI task proposals. null means unrestricted. */
  aiPlanningRestriction: { reason: string } | null
  status: CaseStatus
  /**
   * 保存層の楽観ロックの版。Context の変更（タスク・書類・メッセージ等）でも
   * 副次的に進むため、UPDATE_BASIC_INFO / ADMINISTER の expectedVersion には使わない。
   */
  version: number
  /** Case 全体の版。Context の鮮度判定に使う。 */
  caseVersion: number
  /**
   * 基本情報（自治体・生年月日・profile・葬儀完了日など）専用の楽観ロックの版。
   * UPDATE_BASIC_INFO / ADMINISTER の PATCH では expectedVersion にこれを使う。
   * `version` と違い、Context 側の書き込みだけでは進まない。
   */
  basicInfoVersion: number
  createdAt: ISODateTime
  updatedAt: ISODateTime
  allowedActions: CaseAction[]
}
