import { z } from 'zod'

export { idSchema, isoDateSchema as isoDate } from '../../../../schemas/common.js'
export const shortText = z.string().max(200)
export const longText = z.string().max(2000)
export const expectedVersion = z.number().int().min(1)

export const excludeRequestSchema = z.object({
  expectedVersion,
  reason: longText.optional(),
}).strict()
