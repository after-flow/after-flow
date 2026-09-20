import { z } from 'zod'
import { isoDateTimeSchema } from './common.js'

export const consentKindSchema = z.enum(['TERMS', 'PRIVACY', 'CROSS_BORDER_AI'])

/** 同意文書の版。表示した版への同意だけを受け付けるために必須にする。 */
const versionSchema = z.string().min(1).max(64)

export const consentDocumentResourceSchema = z.object({
  kind: consentKindSchema,
  version: z.string(),
  title: z.string(),
  summary: z.array(z.string()),
  url: z.string(),
  required: z.boolean(),
  agreedVersion: z.string().nullable(),
  agreedAt: isoDateTimeSchema.nullable(),
  satisfied: z.boolean(),
})

export const consentStatusResourceSchema = z.object({
  documents: z.array(consentDocumentResourceSchema),
  outstanding: z.boolean(),
  availability: z.object({
    manualManagement: z.boolean(),
    externalAi: z.boolean(),
    missingRequired: z.array(consentKindSchema),
    missingOptional: z.array(consentKindSchema),
  }),
})

export const agreeConsentsBodySchema = z
  .object({
    agreements: z
      .array(z.object({ kind: consentKindSchema, version: versionSchema }).strict())
      .min(1)
      .max(10),
  })
  .strict()

export const revokeConsentBodySchema = z.object({ kind: consentKindSchema }).strict()
