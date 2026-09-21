import { z } from 'zod'
import { GUIDANCE_LIMITS, internalResultSchema } from '@aftercare/internal-contracts'
import type { ContextProof, InternalResult } from '@aftercare/internal-contracts'
import type { SourceDocument } from '../research/sources.js'
import { assertCompleteResearch } from '../research/contracts.js'
import type { ResearchEvidence } from '../research/contracts.js'

/**
 * モデルが返す1項目の上限。
 *
 * 報告先の上限（GUIDANCE_LIMITS）より緩くしてある。構造化出力の段階で厳しく
 * 拒否すると、推論に成功した回答を丸ごと失う。項目の分割はハーネスが決定的に行う。
 */
const MODEL_CLAIM_MAX = 1000
const claim = z.object({ text: z.string().min(1).max(MODEL_CLAIM_MAX), sourceIds: z.array(z.string().min(1).max(128)).min(1).max(10) }).strict()
export const guidanceDraftSchema = z.object({
  status: z.enum(['complete', 'partial', 'needs_input']),
  where: claim.nullable(), bring: z.array(claim).max(GUIDANCE_LIMITS.items), steps: z.array(claim).max(GUIDANCE_LIMITS.items),
  missing: z.array(z.string().min(1).max(GUIDANCE_LIMITS.missingItem)).max(GUIDANCE_LIMITS.items),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'complete' && (!value.where || !value.bring.length || !value.steps.length || value.missing.length)) {
    ctx.addIssue({ code: 'custom', message: 'Complete guidance requires location, documents, steps and no missing information' })
  }
  if (value.status !== 'complete' && !value.missing.length) ctx.addIssue({ code: 'custom', message: 'Partial guidance must state missing information' })
})
export type GuidanceDraft = z.infer<typeof guidanceDraftSchema>
type Claim = z.infer<typeof claim>

/** 修復できない契約違反の理由。本文を含めず、原因の区分だけを残す。 */
export type GuidanceContractCode =
  | 'WHERE_TOO_LONG'
  | 'BRING_ITEM_TOO_LONG'
  | 'STEP_ITEM_TOO_LONG'
  | 'TOO_MANY_ITEMS'
  | 'MISSING_ITEM_TOO_LONG'

/**
 * 利用者に見せる失敗理由。画面はこの文言をそのまま表示するため、コードだけにしない。
 * 末尾の診断コードで、本文を見ずに原因の区分を追える。
 */
export function guidanceFailureReason(code: GuidanceContractCode): string {
  return `案内を表示できる形に整えられませんでした。もう一度調べ直してください。（診断コード: GUIDANCE_CONTRACT_${code}）`
}

export class GuidanceContractError extends Error {
  constructor(readonly code: GuidanceContractCode) { super(`GUIDANCE_CONTRACT:${code}`) }
}

/** 分割した2件目以降に付ける印。1件の説明が続いていることを利用者が読み取れるようにする。 */
export const CONTINUATION = '（続き）'
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()

/** 区切り文字の直後で分ける。区切り文字は前の断片に残す。 */
function splitAfter(text: string, delimiters: RegExp): string[] {
  const parts: string[] = []
  let current = ''
  for (const char of text) {
    current += char
    if (delimiters.test(char)) { parts.push(current); current = '' }
  }
  if (current) parts.push(current)
  return parts.map(part => part.trim()).filter(Boolean)
}

/**
 * 上限を超える説明を意味の切れ目で分ける（#162）。
 *
 * まず文（。！？）で、次に読点等（、；・）で区切り、上限内へ順に詰める。
 * カンマは「50,000円」「50，000円」のように数値の桁区切りに使われるため区切りにしない。
 * 文字数で機械的に切ると語や数値の途中で切れ、意味が壊れる。
 * 句読点の間だけで上限を超える場合は修復できないとして失敗させる。
 */
export function splitToLimit(input: string, max: number, code: GuidanceContractCode): string[] {
  const text = normalize(input)
  if (text.length <= max) return [text]
  const budget = max - CONTINUATION.length
  const pieces: string[] = []
  for (const sentence of splitAfter(text, /[。！？]/)) {
    if (sentence.length <= budget) { pieces.push(sentence); continue }
    const clauses = splitAfter(sentence, /[、；・]/)
    if (clauses.some(clause => clause.length > budget)) throw new GuidanceContractError(code)
    pieces.push(...clauses)
  }
  const chunks: string[] = []
  let current = ''
  for (const piece of pieces) {
    if (current && (current + piece).length > budget) { chunks.push(current); current = '' }
    current += piece
  }
  if (current) chunks.push(current)
  return chunks.map((chunk, index) => index === 0 ? chunk : `${CONTINUATION}${chunk}`)
}

function fitClaims(claims: readonly Claim[], max: number, code: GuidanceContractCode): Claim[] {
  const fitted = claims.flatMap(item => splitToLimit(item.text, max, code).map(text => ({ text, sourceIds: item.sourceIds })))
  if (fitted.length > GUIDANCE_LIMITS.items) throw new GuidanceContractError('TOO_MANY_ITEMS')
  return fitted
}

/**
 * 案件への適用条件（#162）。
 *
 * 一般的な制度案内が揃っても、この案件に当てはまるかは別に確かめる必要がある。
 * 加入先・申請者の区分・給付の種類が未確認のまま完了にすると、利用者は
 * 申請できるものと受け取る。確認の根拠はBackendの正式な記録だけとし、
 * モデルの推測や利用者の申告では確認済みにしない。
 */
export const applicabilityCheckSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  /** 未確認のときに利用者へ示す確認事項。 */
  question: z.string().min(1).max(GUIDANCE_LIMITS.missingItem),
  /** 確認済みとみなすBackendの記録。無ければ常に未確認として扱う。 */
  confirmedBy: z.object({ group: z.enum(['case', 'task']), field: z.string().min(1).max(64), equals: z.union([z.string(), z.number(), z.boolean()]) }).strict().optional(),
}).strict()
export type ApplicabilityCheck = z.infer<typeof applicabilityCheckSchema>

export interface ApplicabilityFact { group: string; field: string; value: unknown; state: string }

export function unresolvedApplicability(checks: readonly ApplicabilityCheck[], facts: readonly ApplicabilityFact[]): string[] {
  return checks.filter(check => !check.confirmedBy || !facts.some(fact => fact.group === check.confirmedBy!.group &&
    fact.field === check.confirmedBy!.field && fact.state === 'confirmed' && fact.value === check.confirmedBy!.equals))
    .map(check => check.question)
}

export type FittedGuidance =
  | { ok: true; status: 'COMPLETED' | 'PARTIAL'; draft: GuidanceDraft; missing: string[] }
  | { ok: false; code: GuidanceContractCode }

/**
 * モデルの下書きを報告できる形に整える。推論の直後に呼び、契約違反を
 * 報告段階まで持ち越さない。適用条件が未確認なら完了にしない。
 */
export function fitGuidance(input: GuidanceDraft, unresolved: readonly string[]): FittedGuidance {
  const draft = guidanceDraftSchema.parse(input)
  try {
    if (draft.where && normalize(draft.where.text).length > GUIDANCE_LIMITS.where) throw new GuidanceContractError('WHERE_TOO_LONG')
    const bring = fitClaims(draft.bring, GUIDANCE_LIMITS.bringItem, 'BRING_ITEM_TOO_LONG')
    const steps = fitClaims(draft.steps, GUIDANCE_LIMITS.stepItem, 'STEP_ITEM_TOO_LONG')
    const missing = [...new Set([...draft.missing, ...unresolved].map(normalize))]
    if (missing.some(item => item.length > GUIDANCE_LIMITS.missingItem)) throw new GuidanceContractError('MISSING_ITEM_TOO_LONG')
    if (missing.length > GUIDANCE_LIMITS.items) throw new GuidanceContractError('TOO_MANY_ITEMS')
    const complete = draft.status === 'complete' && unresolved.length === 0
    return { ok: true, status: complete ? 'COMPLETED' : 'PARTIAL', missing,
      draft: { ...draft, where: draft.where ? { ...draft.where, text: normalize(draft.where.text) } : null, bring, steps } }
  } catch (error) {
    if (error instanceof GuidanceContractError) return { ok: false, code: error.code }
    throw error
  }
}

export function guidanceResult(input: {
  draft: GuidanceDraft; sources: readonly SourceDocument[]; research: ResearchEvidence; proof: ContextProof; resultId: string; target: string
  /** 案件への適用で未確認の事項。省略時は確認不要として扱う。 */
  unresolved?: readonly string[]
}): InternalResult {
  const fitted = fitGuidance(input.draft, input.unresolved ?? [])
  if (!fitted.ok) {
    // 修復できない場合は成功に見せず、本文を含まない理由だけを返す。
    return internalResultSchema.parse({ ...input.proof, resultId: input.resultId, kind: 'task_guidance', status: 'FAILED',
      target: input.target, bring: [], steps: [], missing: [], sources: [], basis: [], failureReason: guidanceFailureReason(fitted.code) })
  }
  const draft = fitted.draft
  const available = new Map(input.sources.map(source => [source.id, source]))
  if (draft.status === 'complete') assertCompleteResearch(input.research, new Set(available.keys()))
  const used = new Set<string>()
  for (const item of [...(draft.where ? [draft.where] : []), ...draft.bring, ...draft.steps]) {
    for (const id of item.sourceIds) {
      if (!available.has(id)) throw new Error('Guidance cites a source which was not retrieved')
      used.add(id)
    }
  }
  const form = officialForm(input.sources.filter(source => used.has(source.id)))
  // Backend stores its current public guidance DTO; claim-to-source mapping stays in the workflow snapshot.
  return internalResultSchema.parse({
    ...(form ? { formExampleUrl: form.url, formExampleLabel: form.label } : {}),
    ...input.proof, resultId: input.resultId, kind: 'task_guidance',
    status: fitted.status, target: input.target,
    where: draft.where?.text ?? null, bring: draft.bring.map(item => item.text), steps: draft.steps.map(item => item.text),
    missing: fitted.missing, sources: [...used].map(id => {
      const source = available.get(id)!
      return { label: source.title, url: source.url, checkedAt: source.fetchedAt }
    }), basis: [],
  })
}

/**
 * 引用した公式資料に掲載された申請書（無ければ記入例）へのリンク（#165）。
 * ハーネスが本文から決定的に抽出した値だけを使い、モデルにURLを書かせない。
 */
export function officialForm(sources: readonly SourceDocument[]) {
  const forms = sources.flatMap(source => source.forms)
  return forms.find(form => form.kind === 'FORM') ?? forms.find(form => form.kind === 'EXAMPLE') ?? null
}
