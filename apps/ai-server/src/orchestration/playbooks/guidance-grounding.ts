import { z } from 'zod'
import { GUIDANCE_LIMITS } from '@aftercare/internal-contracts'
import { quoteKey } from '../research/contracts.js'
import type { EvidenceQuote, ResearchEvidence } from '../research/contracts.js'


/**
 * 主張と根拠の対応を検証する規則（#163）。レビュー済みscopeから読み込む。
 *
 * 引用の逐語一致は「本文に書いてある文を指している」ことしか示さない。
 * 主張がその引用より多くを言っていないかを、実診断で起きた誤りの型に絞って確かめる。
 */
export const groundingRulesSchema = z.object({
  /** 主張に含まれていれば、その主張の引用にも含まれている必要がある語（例: 窓口、郵送）。 */
  guardedTerms: z.array(z.string().min(1).max(20)).max(50),
  /** 引用に同じ文字列が無い限り、主張してはならない内容。 */
  prohibited: z.array(z.object({
    id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
    /** Unicode正規表現。レビュー済みの設定だけから作り、利用者入力は入れない。 */
    pattern: z.string().min(1).max(300),
    /** 主張を除いたときに利用者へ示す説明。 */
    message: z.string().min(1).max(GUIDANCE_LIMITS.missingItem),
  }).strict()).max(20),
}).strict()
export type GroundingRules = z.infer<typeof groundingRulesSchema>

export const NO_GROUNDING_RULES: GroundingRules = { guardedTerms: [], prohibited: [] }

/** 金額・期間・日数などの数量表現。桁区切りと全角半角の違いは除いて比べる。 */
const QUANTITY = /\d+(?:\.\d+)?(?:円|年|か月|ヶ月|カ月|箇月|週間|営業日|日|%)/gu

function quantities(text: string): string[] {
  const normalized = text.normalize('NFKC').replace(/(\d),(?=\d)/g, '$1').replace(/\s+/g, '')
    // 「5万円」と「50,000円」を同じ数量として比べる。
    .replace(/(\d+(?:\.\d+)?)万/g, (_, value: string) => String(Math.round(Number(value) * 10000)))
  return [...new Set(normalized.match(QUANTITY) ?? [])]
}

/** URL。案内に載せるURLは引用に書かれたものだけにする。 */
const URL_PATTERN = /https?:\/\/[^\s、。「」（）()<>"']+/gu

function urls(text: string): string[] {
  return [...new Set(text.normalize('NFKC').match(URL_PATTERN) ?? [])].map(url => url.replace(/[.,]+$/, ''))
}

export type ClaimKind = 'where' | 'bring' | 'steps'

/** 根拠を付けた主張。sourceIdsは引用から導き、モデルの申告は使わない。 */
export interface GroundedClaim {
  text: string
  questionIds: string[]
  sourceIds: string[]
  evidence: EvidenceQuote[]
}

export interface ModelClaim { text: string; questionIds: string[] }

export type DropReason = 'NO_EVIDENCE' | 'UNSUPPORTED_QUANTITY' | 'UNSUPPORTED_URL' | 'UNSUPPORTED_TERM' | `PROHIBITED:${string}`

export interface GroundingOutcome {
  where: GroundedClaim | null
  bring: GroundedClaim[]
  steps: GroundedClaim[]
  /** 利用者に示す未確認事項。 */
  missing: string[]
  /** 除いた主張の区分と理由。本文は含めない。評価と診断に使う。 */
  dropped: { kind: ClaimKind; reason: DropReason }[]
  /** 調査で回答できた問いのうち、案内に反映されなかったもの。 */
  uncoveredQuestionIds: string[]
}

const DROPPED_MESSAGE: Record<ClaimKind, string> = {
  where: '提出先の案内の一部は公式資料の記載と照合できなかったため表示していません。',
  bring: '必要書類の案内の一部は公式資料の記載と照合できなかったため表示していません。',
  steps: '手順・期限・注意点の案内の一部は公式資料の記載と照合できなかったため表示していません。',
}

/**
 * 1件の主張を検証する。
 *
 * 根拠は、主張が指した問いへの検証済み回答の引用だけ。数量（金額・期限）、URL、
 * 注意すべき語は引用に同じものが書かれている必要がある。
 */
function groundClaim(claim: ModelClaim, answers: ReadonlyMap<string, EvidenceQuote[]>, rules: GroundingRules):
  { ok: true; claim: GroundedClaim } | { ok: false; reason: DropReason; message?: string } {
  const evidence = claim.questionIds.flatMap(questionId => answers.get(questionId) ?? [])
  if (!evidence.length) return { ok: false, reason: 'NO_EVIDENCE' }
  const quoted = quoteKey(evidence.map(item => item.quote).join(' '))
  const quotedQuantities = new Set(quantities(evidence.map(item => item.quote).join(' ')))
  if (quantities(claim.text).some(value => !quotedQuantities.has(value))) return { ok: false, reason: 'UNSUPPORTED_QUANTITY' }
  // 任意のURLへ誘導しない。出典URLはハーネスがcitationsとして別に付ける。
  if (urls(claim.text).some(url => !quoted.includes(quoteKey(url)))) return { ok: false, reason: 'UNSUPPORTED_URL' }
  const text = quoteKey(claim.text)
  if (rules.guardedTerms.some(term => text.includes(quoteKey(term)) && !quoted.includes(quoteKey(term)))) {
    return { ok: false, reason: 'UNSUPPORTED_TERM' }
  }
  for (const rule of rules.prohibited) {
    const match = new RegExp(rule.pattern, 'u').exec(claim.text.normalize('NFKC'))
    if (match && !quoted.includes(quoteKey(match[0]))) return { ok: false, reason: `PROHIBITED:${rule.id}`, message: rule.message }
  }
  return { ok: true, claim: { text: claim.text, questionIds: [...new Set(claim.questionIds)], evidence,
    sourceIds: [...new Set(evidence.map(item => item.sourceId))] } }
}

/**
 * 案内の各主張を調査結果の引用へ結び付ける（#163）。
 *
 * 根拠の無い主張は表示せず、その旨を未確認事項に入れる。調査で確認できた問いが
 * 案内から抜け落ちた場合も未確認事項に入れ、完了にしない。
 */
export function groundGuidance(input: {
  draft: { where: ModelClaim | null; bring: readonly ModelClaim[]; steps: readonly ModelClaim[] }
  research: ResearchEvidence
  rules: GroundingRules
}): GroundingOutcome {
  const rules = groundingRulesSchema.parse(input.rules)
  const questions = new Map(input.research.briefs.flatMap(brief => brief.questions).map(question => [question.id, question.text]))
  const answers = new Map<string, EvidenceQuote[]>()
  for (const outcome of input.research.outcomes) {
    for (const answer of outcome.findings?.answers ?? []) {
      if (answer.evidence?.length) answers.set(answer.questionId, answer.evidence)
    }
  }
  const missing: string[] = []
  const dropped: GroundingOutcome['dropped'] = []
  const covered = new Set<string>()
  const ground = (kind: ClaimKind, claims: readonly ModelClaim[]) => claims.flatMap(claim => {
    const unknown = claim.questionIds.filter(questionId => !questions.has(questionId))
    const result = unknown.length ? { ok: false as const, reason: 'NO_EVIDENCE' as const } : groundClaim(claim, answers, rules)
    if (result.ok) {
      result.claim.questionIds.forEach(questionId => covered.add(questionId))
      return [result.claim]
    }
    dropped.push({ kind, reason: result.reason })
    missing.push('message' in result && result.message ? result.message : DROPPED_MESSAGE[kind])
    return []
  })
  const [where] = ground('where', input.draft.where ? [input.draft.where] : [])
  const bring = ground('bring', input.draft.bring)
  const steps = ground('steps', input.draft.steps)
  const uncoveredQuestionIds = [...questions.keys()].filter(questionId => !covered.has(questionId))
  // 確認できなかった問いは、その問いの文をそのまま次に確かめる事項として示す。
  for (const questionId of uncoveredQuestionIds) missing.push(questions.get(questionId)!)
  return { where: where ?? null, bring, steps, missing: [...new Set(missing)], dropped, uncoveredQuestionIds }
}
