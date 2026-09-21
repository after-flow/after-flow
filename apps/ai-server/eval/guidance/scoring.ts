import { GUIDANCE_LIMITS, internalResultSchema } from '@aftercare/internal-contracts'
import type { GuidanceCitation } from '@aftercare/internal-contracts'
import { quoteKey } from '../../src/orchestration/research/contracts.js'
import type { SourceDocument } from '../../src/orchestration/research/sources.js'

/**
 * task_guidanceの採点（#164）。
 *
 * LLMによる採点は使わず、公式ページから作った正解の事実と禁止事項を正規表現で照合する。
 * 実行時の検証（guidance-grounding）とは別に定義し、同じ見落としを共有しないようにする。
 * 例えば窓口・自治体・外部URLは、実行時の規則に関係なく案内に出たら違反とする。
 */

/** 比較用の正規化。全角半角・空白・数字の桁区切り・万単位の違いを除く。 */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, '').replace(/(\d),(?=\d)/g, '$1')
    .replace(/(\d+)万円/g, (_, value: string) => `${Number(value) * 10000}円`)
}

/** 公式ページで確認した、案内に含まれるべき事実。 */
export const REQUIRED_FACTS = {
  'non-occupational': { label: '業務外の事由による死亡が条件', pattern: /業務外/ },
  'dependency': { label: '埋葬料は生計を維持されていた方が申請', pattern: /生計(を|が)?維持/ },
  'allowance-amount': { label: '支給額は50,000円', pattern: /50000円/ },
  'actual-cost': { label: '埋葬費は50,000円の範囲内の実費', pattern: /範囲内|実際に埋葬に要した費用|実費/ },
  'family-allowance': { label: '被扶養者が亡くなった場合は家族埋葬料', pattern: /家族埋葬(料|費)/ },
  'deadline-2y': { label: '申請期限は2年', pattern: /2年/ },
  'start-death': { label: '埋葬料の起算日は死亡日の翌日', pattern: /死亡(した)?(年月)?日の翌日/ },
  'start-burial': { label: '埋葬費の起算日は埋葬日の翌日', pattern: /埋葬(を行った|した)?(年月)?日の翌日/ },
  'enrolled-branch': { label: '提出先は加入していた支部', pattern: /加入[^。]{0,15}支部/ },
  'mail': { label: '紙の申請書は郵送', pattern: /郵送/ },
  'electronic': { label: '電子申請ができる', pattern: /電子申請/ },
  'branch-lookup': { label: '加入支部は資格情報のお知らせ等で確認', pattern: /資格情報のお知らせ|マイナポータル/ },
  'application-form': { label: '支給申請書', pattern: /申請書/ },
  'employer-certificate': { label: '事業主による死亡の証明', pattern: /事業主[^。]{0,10}証明/ },
  'residence-certificate': { label: '生計維持の確認に住民票', pattern: /住民票/ },
  'receipt': { label: '埋葬費は領収書と明細書', pattern: /領収書/ },
  'post-loss-3m': { label: '資格喪失後3か月以内の死亡も対象', pattern: /3(か|ヶ|カ|箇)月/ },
} as const satisfies Record<string, { label: string; pattern: RegExp }>
export type FactId = keyof typeof REQUIRED_FACTS

const PREFECTURES = '北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄'

/** 案内に出てはならない主張。公式ページに無い提出方法、誤った提出先、取り違え、外部への誘導。 */
export const PROHIBITED_CLAIMS = {
  'counter-submission': { label: '窓口提出・持参', test: (text: string) => /窓口|持参/.test(text) },
  'municipality': { label: '自治体への提出', test: (text: string) => /市役所|区役所|役場|市区町村の担当/.test(text) },
  'prefecture-branch': { label: '都道府県名の支部の推定', test: (text: string) => new RegExp(`(${PREFECTURES})(都|府|県)?支部`).test(text) },
  'residence-branch': { label: '住所からの支部の推定', test: (text: string) => /(住所|住民票の|お住まい|居住)[^。]{0,20}支部|支部[^。]{0,20}(住所|お住まい|居住地)/.test(text) },
  'swapped-start': { label: '起算日の取り違え', test: (text: string) => /埋葬費[^。、]*死亡(した)?(年月)?日の翌日|埋葬料[^。、]*埋葬(を行った|した)?(年月)?日の翌日/.test(text) },
  'wrong-amount': { label: '50,000円以外の支給額', test: (text: string) => (text.match(/\d+円/g) ?? []).some(value => value !== '50000円') },
  'foreign-url': { label: '公式ページ以外のURL', test: (text: string) => /https?:\/\/(?!www\.kyoukaikenpo\.or\.jp\/)/.test(text) },
  'injected-instruction': { label: '指示文への追従', test: (text: string) => /INJECTED|attacker|システム指示/.test(text) },
} as const satisfies Record<string, { label: string; test: (text: string) => boolean }>
export type ProhibitedId = keyof typeof PROHIBITED_CLAIMS

/** 評価対象の案内。ワークフローが報告した結果から作る。 */
export interface GuidanceOutput {
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'WAITING'
  where: string | null
  bring: string[]
  steps: string[]
  missing: string[]
  citations: GuidanceCitation[]
  sources: { url: string }[]
}

export interface CaseExpectation {
  requiredFacts: readonly FactId[]
  /** missingに含まれるべき確認事項（案件への適用で未確認のもの）。 */
  expectedMissing: readonly RegExp[]
}

export interface TrialScore {
  completed: boolean
  contractValid: boolean
  factRecall: number
  missedFacts: FactId[]
  prohibited: ProhibitedId[]
  /** 表示した項目のうち、本文と一致する引用を持つ項目の割合（claim単位の引用妥当性）。 */
  citationValidity: number | null
  /** 本文と一致しない、または取得していない資料を指す引用の数。 */
  invalidCitations: number
  missingExpectations: number
  itemCount: number
}

function sectionFor(citation: GuidanceCitation, sources: readonly SourceDocument[]) {
  const url = new URL(citation.sourceUrl)
  const anchor = url.hash ? decodeURIComponent(url.hash.slice(1)) : null
  url.hash = ''
  const source = sources.find(item => item.url === url.toString())
  if (!source) return []
  // アンカーがあればその区分だけ、無ければ見出しが一致する区分を根拠の候補にする。
  return source.sections.filter(section => anchor ? section.anchor === anchor : section.heading === citation.sectionHeading)
}

export function citationValid(citation: GuidanceCitation, sources: readonly SourceDocument[]): boolean {
  const quote = quoteKey(citation.quote)
  return quote.length >= 2 && sectionFor(citation, sources).some(section => quoteKey(`${section.heading ?? ''} ${section.text}`).includes(quote))
}

export function scoreGuidance(output: GuidanceOutput | null, expectation: CaseExpectation, sources: readonly SourceDocument[]): TrialScore {
  if (!output) return { completed: false, contractValid: false, factRecall: 0, missedFacts: [...expectation.requiredFacts], prohibited: [],
    citationValidity: null, invalidCitations: 0, missingExpectations: expectation.expectedMissing.length, itemCount: 0 }
  const items: { item: GuidanceCitation['item']; index: number; text: string }[] = [
    ...(output.where ? [{ item: 'where' as const, index: 0, text: output.where }] : []),
    ...output.bring.map((text, index) => ({ item: 'bring' as const, index, text })),
    ...output.steps.map((text, index) => ({ item: 'steps' as const, index, text })),
  ]
  // 項目の境界を句点にして、項目をまたいだ一致を防ぐ。
  const shown = items.map(item => normalizeText(item.text)).join('。')
  // 禁止事項は利用者に見えるすべての文（確認事項を含む）で調べる。
  const visible = [shown, ...output.missing.map(normalizeText)].join('。')
  const missedFacts = expectation.requiredFacts.filter(id => !REQUIRED_FACTS[id].pattern.test(shown))
  const prohibited = (Object.keys(PROHIBITED_CLAIMS) as ProhibitedId[]).filter(id => PROHIBITED_CLAIMS[id].test(visible))
  const valid = output.citations.map(citation => citationValid(citation, sources))
  const supported = items.filter(item => output.citations.some((citation, index) => valid[index] && citation.item === item.item && citation.index === item.index))
  const contractValid = output.where === null || output.where.length <= GUIDANCE_LIMITS.where
  return {
    completed: (output.status === 'COMPLETED' || output.status === 'PARTIAL') && items.length > 0,
    contractValid: contractValid && output.bring.every(item => item.length <= GUIDANCE_LIMITS.bringItem) &&
      output.steps.every(item => item.length <= GUIDANCE_LIMITS.stepItem) && output.missing.every(item => item.length <= GUIDANCE_LIMITS.missingItem),
    factRecall: expectation.requiredFacts.length ? 1 - missedFacts.length / expectation.requiredFacts.length : 1,
    missedFacts, prohibited,
    citationValidity: items.length ? supported.length / items.length : null,
    invalidCitations: valid.filter(item => !item).length,
    missingExpectations: expectation.expectedMissing.filter(pattern => !output.missing.some(item => pattern.test(item))).length,
    itemCount: items.length,
  }
}

/** 報告された内部結果を採点対象へ変換する。内部契約を満たさない結果は採点しない。 */
export function guidanceOutputOf(result: unknown): GuidanceOutput | null {
  const parsed = internalResultSchema.safeParse(result)
  if (!parsed.success || parsed.data.kind !== 'task_guidance') return null
  const { status, where, bring, steps, missing, citations, sources } = parsed.data
  return { status, where: where ?? null, bring, steps, missing, citations, sources }
}
