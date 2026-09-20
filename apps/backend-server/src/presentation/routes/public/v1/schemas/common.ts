import { z } from 'zod'

export const idSchema = z.string().min(1).max(128)
export const shortText = z.string().max(200)
export const longText = z.string().max(2000)
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 形式で指定してください')
export const expectedVersion = z.number().int().min(1)

export const excludeRequestSchema = z.object({
  expectedVersion,
  reason: longText.optional(),
})
