import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { contentHash } from '../../../orchestration/context/builder.js'
import { assertDeliveredDocument, documentReviewSchema, documentScopeSchema, extractionSchema, processedDocumentSchema, reviewExtraction } from '../../../orchestration/documents/review.js'
import type { DocumentScope, ProcessedDocument } from '../../../orchestration/documents/review.js'

/** The delivery implementation must authenticate to Backend and enforce live consent; no URL/Storage credentials enter the model. */
export const DOCUMENT_REVIEW_WORKFLOW = 'document-review-v1'
export interface DocumentReviewDependencies {
  signal: AbortSignal
  guard(): Promise<void>
  deliver(scope: DocumentScope, signal: AbortSignal): Promise<unknown>
  /** Bounded OCR/extraction tool, not a third business agent. Provider admission/budgets belong to its adapter. */
  extract(document: ProcessedDocument, signal: AbortSignal): Promise<unknown>
}
export function createDocumentReviewWorkflow(deps: DocumentReviewDependencies) {
  const generatedSchema = z.object({ document: processedDocumentSchema, extraction: extractionSchema })
  const outputSchema = documentReviewSchema
  async function guard() { deps.signal.throwIfAborted(); await deps.guard(); deps.signal.throwIfAborted() }
  const load = createStep({ id: 'load-processed-document', inputSchema: documentScopeSchema, outputSchema: processedDocumentSchema,
    execute: async ({ inputData }) => { await guard(); return assertDeliveredDocument(await deps.deliver(inputData, deps.signal), inputData) } })
  const extract = createStep({ id: 'extract-evidence-candidates', inputSchema: processedDocumentSchema, outputSchema: generatedSchema,
    execute: async ({ inputData }) => { await guard(); return { document: inputData, extraction: extractionSchema.parse(await deps.extract(inputData, deps.signal)) } } })
  const review = createStep({ id: 'revalidate-and-review-document', inputSchema: generatedSchema, outputSchema,
    execute: async ({ inputData }) => {
      await guard(); const scope = documentScopeSchema.strip().parse(inputData.document)
      const latest = assertDeliveredDocument(await deps.deliver(scope, deps.signal), scope)
      const { expiresAt: _oldExpiry, ...before } = inputData.document
      const { expiresAt: _newExpiry, ...after } = latest
      if (contentHash(before) !== contentHash(after)) throw new Error('Document or facts changed during extraction')
      return reviewExtraction(latest, inputData.extraction)
    } })
  return createWorkflow({ id: DOCUMENT_REVIEW_WORKFLOW, inputSchema: documentScopeSchema, outputSchema }).then(load).then(extract).then(review).commit()
}
