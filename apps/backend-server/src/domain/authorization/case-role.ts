import type { EntityBase } from '../shared/entity.js'

/**
 * Case における役割と、操作ごとに必要な権限（仕様書 6・7・16 章）。
 *
 * 役割は membership から導出する。要求本文の自己申告（ownerName、
 * relationshipToDeceased、role など）は権限の根拠にしない。
 */
export type CaseRole = 'OWNER' | 'EDITOR' | 'VIEWER'

/**
 * Case に対する操作の種類。
 *
 * 個々の API 名ではなく権限の粒度で分ける。新しい API を足すたびに
 * 権限表が増えると、どこが緩いのか分からなくなる。
 */
export type CaseOperation =
  /** 基本情報・一覧・詳細の閲覧 */
  | 'case.read'
  /** 基本情報や Case 配下 Entity の更新 */
  | 'case.write'
  /** Case そのものの終了・再開・membership の変更 */
  | 'case.administer'
  /** 承認・却下の応答 */
  | 'approval.decide'
  /**
   * 本人の意思として確定する操作（相続方法の confirm など）。
   * 役割だけでは足りず、対象 Person と actor の紐付けも必要。
   */
  | 'decision.confirm.self'

const ROLE_RANK: Record<CaseRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
}

/**
 * 操作に必要な最小の役割。
 *
 * `decision.confirm.self` は OWNER でも自動的には満たせない。
 * Case の所有者だからといって、他の家族の意思を本人として確定できてはいけない。
 */
const REQUIRED_ROLE: Record<CaseOperation, CaseRole> = {
  'case.read': 'VIEWER',
  'case.write': 'EDITOR',
  'case.administer': 'OWNER',
  'approval.decide': 'EDITOR',
  'decision.confirm.self': 'VIEWER',
}

export function roleAllows(role: CaseRole, operation: CaseOperation): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[REQUIRED_ROLE[operation]]
}

/**
 * Case のメンバー。
 *
 * 退会・除外は文書の削除ではなく `active` で表す。監査や Decision からの
 * 参照を壊さずに権限だけを失わせるため。
 */
export interface CaseMember extends EntityBase {
  /** 認証済みユーザー ID。文書 ID もこの値にする。 */
  userId: string
  role: CaseRole
  active: boolean
  /**
   * この membership が紐付く Case 内の Person。
   * 本人確認を要する操作の根拠になる。Case 作成時の本人登録、または #13 が登録する。
   */
  personId: string | null
}
