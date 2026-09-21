import { z } from 'zod'

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
export const sourceCandidateSchema = z.object({
  id, catalogId: id, title: z.string().min(1).max(120), issuer: z.string().min(1).max(200), url: z.string().url().max(2000),
}).strict()
export const sourceDocumentSchema = sourceCandidateSchema.extend({
  text: z.string().min(1).max(60000), location: z.string().min(1).max(500),
  fetchedAt: z.string().datetime(), updatedAt: z.string().datetime().nullable(),
}).strict()
export type SourceCandidate = z.infer<typeof sourceCandidateSchema>
export type SourceDocument = z.infer<typeof sourceDocumentSchema>
