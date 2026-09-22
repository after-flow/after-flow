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

/** 値の照合用。全角半角と空白の違いだけを吸収する。 */
function key(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '')
}

function distinct(candidates: readonly Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>()
  for (const candidate of candidates) if (!seen.has(key(candidate.value))) seen.set(key(candidate.value), candidate)
  return [...seen.values()]
}

/** 1回の読み取りで作る提案の上限。一覧表のような書類でも確認の件数が膨らみすぎないようにする。 */
const MAX_PROPOSALS = 10

/**
 * 抽出候補から提案候補を組み立てる（#196 の最小実装）。
 *
 * 対応する書類種別は預金関係書類（金融機関名・残高）だけ。Backend の
 * `analysis-catalog.ts` が返すフィールドIDと対になる。
 *
 * - 金融機関が1つ: その口座を提案する。残高の候補が複数の値に分かれる場合は、
 *   誤った金額を承認画面に出さないよう金額を空にし、その旨を説明に書く。
 * - 金融機関が複数（残高一覧など）: 金融機関ごとに提案する。残高は、その金融機関名を
 *   引用に含む候補（同じ行の記載）が1つの値に決まるときだけ結び付ける。
 *   以前は金融機関名の食い違いとして提案を1件も作らず、利用者に何も届かなかった。
 */
export function draftProposalsFromCandidates(
  review: { candidates: readonly Candidate[]; conflictingFields: readonly string[] },
): DraftProposal[] {
  const institutions = distinct(review.candidates.filter(candidate => candidate.fieldId === 'institution'))
  const amounts = review.candidates.filter(candidate => candidate.fieldId === 'amount')
  if (!institutions.length) return []
  const single = institutions.length === 1
  return institutions.slice(0, MAX_PROPOSALS).map(institution => {
    const related = single ? amounts : amounts.filter(amount => key(amount.quote).includes(key(institution.value)))
    const values = distinct(related)
    const amount = values.length === 1 ? parseYenAmount(values[0]!.value) : null
    const notes = [
      ...(single ? [] : [`この書類には${institutions.length}件の口座が載っています。`]),
      ...(amount === null && related.length > 1 ? ['残高の記載が複数あるため、金額は書類を見て入力してください。'] : []),
    ]
    return {
      kind: 'ASSET_PROPOSAL' as const,
      title: '預金口座を財産として登録する',
      summary: [`書類から「${institution.value}」の口座を見つけました。`, ...notes].join(''),
      payload: {
        operation: 'CREATE',
        fields: { name: institution.value, kind: 'BANK', institution: institution.value, amount, taxAttention: false, note: null },
      },
    }
  })
}
