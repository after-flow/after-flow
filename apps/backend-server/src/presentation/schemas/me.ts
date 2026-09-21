import { z } from 'zod'
import { isoDateTimeSchema } from './common.js'

/**
 * `MeResource` の公開契約スキーマ（`packages/public-contracts/src/dto/me.ts`）。
 * メールアドレスは保存も応答もしない。
 */
export const meResourceSchema = z.object({
  userId: z.string(),
  tenantId: z.string(),
  registered: z.boolean(),
  active: z.boolean(),
  emailVerified: z.boolean(),
  registeredAt: isoDateTimeSchema.nullable(),
})
