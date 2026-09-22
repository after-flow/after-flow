import { z } from 'zod'
import { internalId, internalResultSchema } from '@aftercare/internal-contracts'
import type { ContextProof } from '@aftercare/internal-contracts'
import type { SourceDocument } from '../research/sources.js'
import type { ResearchEvidence } from '../research/contracts.js'

export const chatDraftSchema = z.object({
  paragraphs: z.array(z.object({ text: z.string().min(1).max(1000), sourceIds: z.array(internalId).min(1).max(10) }).strict()).max(8),
  questions: z.array(z.string().min(1).max(300)).max(5), professionalNotice: z.boolean(),
}).strict().refine(value => value.paragraphs.length + value.questions.length > 0, 'Reply must provide grounded text or questions')
export type ChatDraft = z.infer<typeof chatDraftSchema>
export function chatReplyResult(input: {
  draft: ChatDraft; sources: readonly SourceDocument[]; research: ResearchEvidence; proof: ContextProof; resultId: string
}) {
  const draft = chatDraftSchema.parse(input.draft)
  const sources = new Map(input.sources.map(source => [source.id, source])); const used = new Set<string>()
  const researched = new Set(input.research.outcomes.flatMap(outcome => outcome.findings?.answers.flatMap(answer => answer.sourceIds) ?? []))
  for (const paragraph of draft.paragraphs) for (const id of paragraph.sourceIds) {
    if (!sources.has(id) || !researched.has(id)) throw new Error('Chat cites an unverified source')
    used.add(id)
  }
  const body = [
    ...draft.paragraphs.map(paragraph => paragraph.text),
    ...(draft.questions.length ? [`確認したいこと\n${draft.questions.map(question => `・${question}`).join('\n')}`] : []),
    ...(used.size ? [`出典\n${[...used].map(id => { const source = sources.get(id)!; return `${source.title}: ${source.url}` }).join('\n')}`] : []),
    ...(draft.professionalNotice ? ['個別の判断が必要な点は、専門家への確認をご検討ください。'] : []),
  ].join('\n\n')
  return internalResultSchema.parse({ ...input.proof, kind: 'chat_reply', resultId: input.resultId, body, professionalNotice: draft.professionalNotice, basis: [] })
}
