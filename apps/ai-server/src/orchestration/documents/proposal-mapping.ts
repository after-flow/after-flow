import type { z } from 'zod'
import type { documentReviewSchema } from './review.js'

type Candidate = z.infer<typeof documentReviewSchema>['candidates'][number]

export interface DraftProposal {
  kind: 'ASSET_PROPOSAL'
  title: string
  summary: string
  payload: Record<string, unknown>
}

function parseYenAmount(raw: string): number | null {
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return null
  const value = Number(digits)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * 抽出候補から提案候補を組み立てる（#196 の最小実装）。
 *
 * 対応する書類種別は預金通帳（金融機関名・残高）だけ。Backend の
 * `analysis-catalog.ts` が返すフィールドIDと対になる。金融機関名が
 * 読み取れない、または複数ページで食い違う（conflictingFields）場合は
 * 口座を特定できないため提案を作らない。残高だけ食い違う場合は
 * 金額を空にして提案する（誤った金額を承認画面に出さないため）。
 */
export function draftProposalsFromCandidates(
  review: { candidates: readonly Candidate[]; conflictingFields: readonly string[] },
): DraftProposal[] {
  const byField = new Map(review.candidates.map(candidate => [candidate.fieldId, candidate]))
  const conflicting = new Set(review.conflictingFields)
  const institution = byField.get('institution')
  if (!institution || conflicting.has('institution')) return []
  const amount = byField.get('amount')
  return [{
    kind: 'ASSET_PROPOSAL',
    title: '預金口座を財産として登録する',
    summary: `通帳から「${institution.value}」の口座を見つけました。`,
    payload: {
      operation: 'CREATE',
      fields: {
        name: institution.value, kind: 'BANK', institution: institution.value,
        amount: amount && !conflicting.has('amount') ? parseYenAmount(amount.value) : null,
        taxAttention: false, note: null,
      },
    },
  }]
}
