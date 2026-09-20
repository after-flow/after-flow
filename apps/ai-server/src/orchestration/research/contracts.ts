import { z } from 'zod'

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)

/** Only the application may construct these from authorized, minimized context. */
export const researchBriefSchema = z.object({
  briefId: id,
  procedure: z.string().min(1).max(200),
  institution: z.string().min(1).max(200),
  jurisdiction: z.string().min(1).max(200),
  questions: z.array(z.object({ id, text: z.string().min(1).max(300) }).strict()).min(1).max(12),
  sourceCatalogIds: z.array(id).min(1).max(20),
}).strict().superRefine((brief, ctx) => {
  if (new Set(brief.questions.map((question) => question.id)).size !== brief.questions.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate question ID' })
  }
})
export type ResearchBrief = z.infer<typeof researchBriefSchema>
export const delegationSelectionSchema = z.object({ briefId: id }).strict()

// IDs, attempts, timestamps, context proof and cost are attached by the harness, never by the model.
export const researchFindingsSchema = z.object({
  status: z.enum(['complete', 'partial', 'needs_input', 'failed']),
  answers: z.array(z.object({
    questionId: id, text: z.string().min(1).max(2000),
    sourceIds: z.array(id).min(1).max(12),
    applicability: z.string().min(1).max(1000),
  }).strict()).max(12),
  missing: z.array(z.string().min(1).max(500)).max(20),
  conflicts: z.array(z.string().min(1).max(1000)).max(20),
}).strict().superRefine((result, ctx) => {
  if (result.status === 'complete' && (!result.answers.length || result.missing.length || result.conflicts.length)) {
    ctx.addIssue({ code: 'custom', message: 'Incomplete findings cannot be complete' })
  }
  if (result.status !== 'complete' && !result.missing.length && !result.conflicts.length) {
    ctx.addIssue({ code: 'custom', message: 'Non-complete findings must explain what is unresolved' })
  }
  if (new Set(result.answers.map((answer) => answer.questionId)).size !== result.answers.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate answer' })
  }
})
export type ResearchFindings = z.infer<typeof researchFindingsSchema>

/** Harness-owned evidence. Null means started but not successfully validated. */
export const researchEvidenceSchema = z.object({
  briefs: z.array(researchBriefSchema).max(2),
  outcomes: z.array(z.object({ briefId: id, findings: researchFindingsSchema.nullable() }).strict()).max(2),
}).strict()
export type ResearchEvidence = z.infer<typeof researchEvidenceSchema>

export function assertCompleteResearch(input: ResearchEvidence, sourceIds: ReadonlySet<string>): void {
  const evidence = researchEvidenceSchema.parse(input)
  const briefs = new Map(evidence.briefs.map(brief => [brief.briefId, brief]))
  if (!briefs.size || briefs.size !== evidence.briefs.length ||
      evidence.briefs.some(brief => !evidence.outcomes.some(outcome => outcome.briefId === brief.briefId))) {
    throw new Error('Guidance requires completed research for every approved brief')
  }
  for (const outcome of evidence.outcomes) {
    const brief = briefs.get(outcome.briefId)
    if (!brief || !outcome.findings || outcome.findings.status !== 'complete') {
      throw new Error('Unresolved research cannot produce complete guidance')
    }
    // Recheck missing/conflicts, required questions and source references after snapshot transport.
    validateFindings(outcome.findings, brief, sourceIds)
  }
}

/** Referential validation, not a semantic truthfulness scorer. */
export function validateFindings(input: unknown, brief: ResearchBrief, retrievedSourceIds: ReadonlySet<string>): ResearchFindings {
  const result = researchFindingsSchema.parse(input)
  const questions = new Set(brief.questions.map((question) => question.id))
  for (const answer of result.answers) {
    if (!questions.has(answer.questionId) || answer.sourceIds.some((sourceId) => !retrievedSourceIds.has(sourceId))) {
      throw new Error('Unrecognized question or unverified source reference')
    }
  }
  if (result.status === 'complete' && result.answers.length !== questions.size) {
    throw new Error('Research omitted required questions')
  }
  return result
}
