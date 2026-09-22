import { z } from 'zod'
import { internalId } from '@aftercare/internal-contracts'
import { contentHash } from '../context/builder.js'

const hash = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const documentScopeSchema = z.object({ caseId: internalId, runId: internalId, documentId: internalId, documentVersion: z.number().int().positive() }).strict()
export type DocumentScope = z.infer<typeof documentScopeSchema>
/** A proposed delivery port, not a claim that the current Backend artifact endpoint delivers text. */
export const processedDocumentSchema = documentScopeSchema.extend({
  caseVersion: z.number().int().positive(), artifactId: internalId, artifactVersion: z.number().int().positive(),
  inspectedDocumentVersion: z.number().int().positive(), inspection: z.literal('PASSED'), maskingPolicyVersion: internalId,
  expiresAt: z.string().datetime(), contentHash: hash,
  pages: z.array(z.object({ number: z.number().int().positive().max(1000), text: z.string().max(12000) }).strict()).min(1).max(20),
  fields: z.array(z.object({ id: internalId, label: z.string().min(1).max(120), required: z.boolean(),
    current: z.object({ value: z.string().max(500), state: z.enum(['confirmed', 'user_reported', 'extracted_candidate', 'unknown']), corrected: z.boolean() }).strict().nullable(),
  }).strict()).min(1).max(30),
}).strict()
export type ProcessedDocument = z.infer<typeof processedDocumentSchema>
export const extractionSchema = z.object({
  candidates: z.array(z.object({ fieldId: internalId, value: z.string().min(1).max(500), page: z.number().int().positive(),
    start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1).max(1000),
  }).strict()).max(60),
  unreadableFields: z.array(internalId).max(30),
}).strict()
export const documentReviewSchema = z.object({
  candidates: z.array(extractionSchema.shape.candidates.element.extend({ state: z.literal('extracted_candidate'), difference: z.enum(['CONFLICT', 'MATCH', 'NEW']),
    requiresHumanReview: z.literal(true), preservesCorrection: z.boolean(),
    basis: z.object({ documentId: internalId, documentVersion: z.number().int().positive(), artifactId: internalId, artifactVersion: z.number().int().positive(), contentHash: hash }).strict(),
  }).strict()).max(60),
  conflictingFields: z.array(internalId).max(30), missingFields: z.array(internalId).max(30), unreadableFields: z.array(internalId).max(30), status: z.literal('NEEDS_REVIEW'),
}).strict()
export function assertDeliveredDocument(input: unknown, expected: DocumentScope, now = Date.now()): ProcessedDocument {
  const document = processedDocumentSchema.parse(input)
  if (Object.entries(documentScopeSchema.parse(expected)).some(([key, value]) => document[key as keyof DocumentScope] !== value) ||
    document.inspectedDocumentVersion !== document.documentVersion || Date.parse(document.expiresAt) <= now ||
    contentHash(document.pages) !== document.contentHash || new Set(document.pages.map(page => page.number)).size !== document.pages.length ||
    new Set(document.fields.map(field => field.id)).size !== document.fields.length || Buffer.byteLength(JSON.stringify(document)) > 100000) throw new Error('Document delivery is outside the authorized version or bounds')
  return document
}
/** 値と引用の照合用。全角半角・空白・数字の桁区切りの違いだけを吸収する。 */
function evidenceKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').replace(/(\d),(?=\d)/g, '$1')
}

/**
 * 引用の位置は、モデルの申告ではなく本文から決める。
 *
 * モデルは文字数を正確に数えられず、実モデルでは引用が本文にあっても申告位置がずれていた。
 * 申告位置の切り出しが引用と一致すればそれを使い、一致しなければ本文中の出現位置を探す
 * （複数あれば申告位置に最も近いもの）。引用が本文に無ければ根拠なしとする。
 */
function locateQuote(text: string, quote: string, hint: { start: number; end: number }): { start: number; end: number } | null {
  if (hint.start < hint.end && text.slice(hint.start, hint.end) === quote) return hint
  let best: number | null = null
  for (let index = text.indexOf(quote); index !== -1; index = text.indexOf(quote, index + 1)) {
    if (best === null || Math.abs(index - hint.start) < Math.abs(best - hint.start)) best = index
  }
  return best === null ? null : { start: best, end: best + quote.length }
}

export function reviewExtraction(document: ProcessedDocument, raw: unknown) {
  const extraction = extractionSchema.parse(raw)
  const fields = new Map(document.fields.map(field => [field.id, field]))
  if (new Set(extraction.unreadableFields).size !== extraction.unreadableFields.length || extraction.unreadableFields.some(id => !fields.has(id))) throw new Error('Unknown or duplicate unreadable field')
  const seen = new Set<string>()
  const candidates = extraction.candidates.map(raw => {
    const field = fields.get(raw.fieldId); const page = document.pages.find(page => page.number === raw.page)
    const position = page ? locateQuote(page.text, raw.quote, raw) : null
    const candidate = position ? { ...raw, ...position } : raw
    const key = contentHash(candidate)
    if (!field || !page || !position || !evidenceKey(candidate.quote).includes(evidenceKey(candidate.value)) ||
      seen.has(key) || extraction.unreadableFields.includes(candidate.fieldId)) throw new Error('Extraction lacks exact document evidence')
    seen.add(key)
    const conflicts = field.current && field.current.state !== 'unknown' && field.current.value !== candidate.value
    return { ...candidate, state: 'extracted_candidate' as const, difference: conflicts ? 'CONFLICT' as const : field.current?.value === candidate.value ? 'MATCH' as const : 'NEW' as const,
      requiresHumanReview: true as const, preservesCorrection: field.current?.corrected ?? false,
      basis: { documentId: document.documentId, documentVersion: document.documentVersion, artifactId: document.artifactId, artifactVersion: document.artifactVersion, contentHash: document.contentHash } }
  })
  const conflictingFields = [...new Set(candidates.filter(candidate => candidate.difference === 'CONFLICT' || candidates.some(other => other.fieldId === candidate.fieldId && other.value !== candidate.value)).map(candidate => candidate.fieldId))]
  const missingFields = document.fields.filter(field => field.required && !candidates.some(candidate => candidate.fieldId === field.id)).map(field => field.id)
  return { candidates, conflictingFields, missingFields, unreadableFields: extraction.unreadableFields, status: 'NEEDS_REVIEW' as const }
}
