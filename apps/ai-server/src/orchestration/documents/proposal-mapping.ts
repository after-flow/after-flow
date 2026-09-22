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
 * 読み取れなければ提案は作らない（口座を特定できないため）。
 */
export function draftProposalsFromCandidates(candidates: readonly Candidate[]): DraftProposal[] {
  const byField = new Map(candidates.map(candidate => [candidate.fieldId, candidate]))
  const institution = byField.get('institution')
  if (!institution) return []
  const amount = byField.get('amount')
  return [{
    kind: 'ASSET_PROPOSAL',
    title: '預金口座を財産として登録する',
    summary: `通帳から「${institution.value}」の口座を見つけました。`,
    payload: {
      operation: 'CREATE',
      fields: {
        name: institution.value, kind: 'BANK', institution: institution.value,
        amount: amount ? parseYenAmount(amount.value) : null,
        taxAttention: false, note: null,
      },
    },
  }]
}
