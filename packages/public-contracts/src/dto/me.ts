import type { ISODateTime } from './resources.js'

/** 認証済み利用者の登録状態。メールアドレスは保存も応答もしない。 */
export interface MeResource {
  userId: string
  tenantId: string
  registered: boolean
  active: boolean
  emailVerified: boolean
  registeredAt: ISODateTime | null
}
