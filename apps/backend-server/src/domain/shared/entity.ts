/**
 * 業務 Entity の共通形（仕様書 15.1）。
 *
 * すべての Entity が `id / tenantId / caseId / version / schemaVersion /
 * createdAt / updatedAt` を持つ。所属 ID を文書にも持たせるのは、
 * 保存パスと中身の不一致を検出するため。
 */
export interface EntityBase {
  id: string
  tenantId: string
  /** tenant 直下の Entity（membership など）は Case に属さない。 */
  caseId: string | null
  /**
   * 楽観ロックの版。更新のたびに 1 増える。
   * クライアントは expectedVersion にこの値を指定する。
   */
  version: number
  /** 保存形式の版。移行の要否を判定するために保持する。 */
  schemaVersion: number
  createdAt: string
  updatedAt: string
}

/** 新規作成時に呼び出し側が渡す部分。版と時刻はサーバーが決める。 */
export type NewEntity<T extends EntityBase> = Omit<
  T,
  'version' | 'schemaVersion' | 'createdAt' | 'updatedAt'
>

/** 更新時に差し替えてよい部分。ID と所属は変更させない。 */
export type EntityPatch<T extends EntityBase> = Partial<
  Omit<T, 'id' | 'tenantId' | 'caseId' | 'version' | 'schemaVersion' | 'createdAt' | 'updatedAt'>
>

export const CURRENT_SCHEMA_VERSION = 1
