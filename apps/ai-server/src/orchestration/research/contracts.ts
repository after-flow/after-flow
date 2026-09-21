import { z } from 'zod'
import type { SourceDocument } from './sources.js'

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)

/**
 * 回答の根拠となる本文の逐語引用（#163）。
 *
 * 出典IDが取得済みかだけでは、主張が本文に書かれているかを確かめられない。
 * 本文からそのまま写した引用を持たせ、ハーネスが本文との一致を決定的に確かめる。
 * NLIや評価用LLMに頼らないため再現でき、言い換えや捏造は一致しない。
 */
export const evidenceQuoteSchema = z.object({
  sourceId: id,
  sectionId: z.string().regex(/^s\d{1,3}$/),
  quote: z.string().min(2).max(200),
}).strict()
export type EvidenceQuote = z.infer<typeof evidenceQuoteSchema>

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
  status: z.enum(['complete', 'partial', 'needs_input', 'failed', 'cancelled']),
  answers: z.array(z.object({
    questionId: id, text: z.string().min(1).max(2000),
    sourceIds: z.array(id).min(1).max(12),
    applicability: z.string().min(1).max(1000),
    /** 手順案内の調査ではハーネスが検証した引用だけが入る。委任経由の調査では無い場合がある。 */
    evidence: z.array(evidenceQuoteSchema).min(1).max(5).optional(),
  }).strict()).max(12),
  missing: z.array(z.string().min(1).max(500)).max(20),
  conflicts: z.array(z.string().min(1).max(1000)).max(20),
}).strict().superRefine((result, ctx) => {
  if (result.status === 'cancelled' && result.answers.length) ctx.addIssue({ code: 'custom', message: 'Cancelled research cannot claim answers' })
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

/**
 * The model extracts claims and citations. Applicability is attached by the
 * harness from the reviewed brief instead of trusting the model to restate it.
 */
export const researchSynthesisSchema = z.object({
  status: z.enum(['complete', 'partial', 'needs_input', 'failed']),
  answers: z.array(z.object({
    questionId: id, text: z.string().min(1).max(2000),
    /** 本文からそのまま写した引用。1件の回答に最大5件。 */
    evidence: z.array(evidenceQuoteSchema).min(1).max(5),
  }).strict()).max(12),
  missing: z.array(z.string().min(1).max(500)).max(20),
  conflicts: z.array(z.string().min(1).max(1000)).max(20),
}).strict()

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
  if (result.status === 'cancelled') throw new Error('Only the harness can cancel research')
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

/**
 * 引用の照合用の正規化。表記の揺れだけを吸収し、言い換えは吸収しない。
 *
 * 実モデルの評価（#164）で、照合に失敗した引用の多くは次の写し間違いだった。
 * いずれも語の並びは本文と同じなので、同じ引用として扱う。
 * - 空白と全角半角の違い
 * - 句読点・括弧の有無（文末に「。」を足す、見出しと本文を「、」でつなぐ）
 * - 注記の印（「※1」）の有無
 */
export function quoteKey(value: string): string {
  return value.normalize('NFKC').replace(/※\d*/g, '').replace(/[\s\p{P}]+/gu, '')
}

export interface QuoteCheck { evidence: EvidenceQuote; valid: boolean }

/** 引用が、指定した資料の指定した区分の本文に逐語で含まれるか。 */
export function verifyQuote(evidence: EvidenceQuote, sources: ReadonlyMap<string, SourceDocument>): boolean {
  const section = sources.get(evidence.sourceId)?.sections.find(item => item.id === evidence.sectionId)
  if (!section) return false
  const quote = quoteKey(evidence.quote)
  return quote.length >= 2 && quoteKey(`${section.heading ?? ''} ${section.text}`).includes(quote)
}

/**
 * モデルの調査結果を検証済みの記録にする（#163）。
 *
 * 本文と一致しない引用は捨てる。一致する引用が1件も無い回答は根拠が無いものとして捨て、
 * その問いは未確認として残す。引用を1件でも捨てた場合、モデルがcompleteを名乗っていても完了にしない。
 *
 * 当初は一致しない引用を1件でも含む回答を丸ごと捨てていた。実モデルの評価（#164）では、
 * 1件の写し間違いで正しい引用まで失い、必須事実の再現率を下げる主因になっていた。
 * 回答のtextは引用と照合していないため、丸ごと捨てても安全性はほとんど上がらない。
 * 案内の各項目はハーネスが検証済みの引用と照合する（guidance-grounding）。
 */
export function finalizeResearchSynthesis(input: unknown, brief: ResearchBrief, sources: readonly SourceDocument[]): ResearchFindings {
  const synthesized = researchSynthesisSchema.parse(input)
  const retrieved = new Map(sources.map(source => [source.id, source]))
  const applicability = `${brief.jurisdiction}の${brief.institution}が扱う${brief.procedure}`
  const questions = new Map(brief.questions.map(question => [question.id, question]))
  const answers: ResearchFindings['answers'] = []
  const unsupported: string[] = []
  let discardedQuotes = 0
  const partlySupported: string[] = []
  for (const answer of synthesized.answers) {
    const evidence = answer.evidence.filter(item => verifyQuote(item, retrieved))
    discardedQuotes += answer.evidence.length - evidence.length
    if (evidence.length && evidence.length < answer.evidence.length) partlySupported.push(questions.get(answer.questionId)?.text ?? '確認できない問い')
    if (!evidence.length) {
      unsupported.push(questions.get(answer.questionId)?.text ?? '確認できない問い')
      continue
    }
    answers.push({ questionId: answer.questionId, text: answer.text, applicability, evidence,
      sourceIds: [...new Set(evidence.map(item => item.sourceId))] })
  }
  const missing = [...synthesized.missing, ...unsupported.map(text => `${text}（公式資料の記載と照合できませんでした）`.slice(0, 500)),
    ...partlySupported.map(text => `${text}（一部の記載は公式資料と照合できませんでした）`.slice(0, 500))]
  const status = synthesized.status === 'complete' && (unsupported.length || discardedQuotes) ? 'partial' : synthesized.status
  return validateFindings({ status, answers, missing: missing.slice(0, 20), conflicts: synthesized.conflicts }, brief, new Set(retrieved.keys()))
}
