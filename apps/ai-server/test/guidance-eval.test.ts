import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { citationValid, normalizeText, PROHIBITED_CLAIMS, scoreGuidance } from '../eval/guidance/scoring.js'
import type { GuidanceOutput } from '../eval/guidance/scoring.js'
import { fixtureSources } from '../eval/guidance/sources.js'
import { finalCostUsd, meteredModel } from '../eval/guidance/meter.js'
import type { CallRecord } from '../eval/guidance/meter.js'
import { classifyFailure } from '../eval/guidance/target.js'
import { scriptedModel } from './helpers/scripted-model.js'

const sources = fixtureSources()
const application = 'https://www.kyoukaikenpo.or.jp/application_form/benefit/012/'
const output = (patch: Partial<GuidanceOutput> = {}): GuidanceOutput => ({
  status: 'PARTIAL', where: '亡くなった方が加入していた協会けんぽ支部へ申請書を郵送する。', bring: ['健康保険埋葬料（費）支給申請書'], steps: ['申請期限は2年。'],
  missing: ['加入していた支部を確認してください。'], sources: [{ url: application }],
  citations: [
    { item: 'where', index: 0, sourceUrl: `${application}#28cu0nou`, sectionHeading: '申請方法・提出先', quote: '紙の申請書は、ご加入されている協会けんぽ支部へご郵送ください' },
    { item: 'bring', index: 0, sourceUrl: application, sectionHeading: '健康保険埋葬料（費）支給申請書', quote: '健康保険埋葬料（費）支給申請書' },
    { item: 'steps', index: 0, sourceUrl: `${application}#a9nepryw`, sectionHeading: '申請期限', quote: '2年で時効になります' },
  ],
  ...patch,
})
const expectation = { requiredFacts: ['enrolled-branch', 'mail', 'deadline-2y', 'electronic'] as const, expectedMissing: [/加入していた支部/] }
const prohibited = (text: string) => (Object.keys(PROHIBITED_CLAIMS) as (keyof typeof PROHIBITED_CLAIMS)[]).filter(id => PROHIBITED_CLAIMS[id].test(normalizeText(text)))

test('#164 必須事実の再現率・確認事項・claim単位の引用妥当性を採点する', () => {
  const score = scoreGuidance(output(), expectation, sources)
  assert.equal(score.completed, true)
  assert.deepEqual(score.missedFacts, ['electronic'])
  assert.equal(score.factRecall, 0.75)
  assert.equal(score.citationValidity, 1)
  assert.equal(score.invalidCitations, 0)
  assert.equal(score.missingExpectations, 0)
  assert.deepEqual(score.prohibited, [])
  // 引用の無い項目は根拠なしとして数える。
  assert.equal(scoreGuidance(output({ steps: ['申請期限は2年。', '郵送する。'] }), expectation, sources).citationValidity, 0.75)
  // 結果が無い試行は未完了で、再現率0。
  assert.deepEqual([scoreGuidance(null, expectation, sources).completed, scoreGuidance(null, expectation, sources).factRecall], [false, 0])
})

test('#164 引用は取得した資料の該当区分に逐語で含まれる場合だけ妥当とする', () => {
  const [where] = output().citations
  assert.ok(citationValid(where!, sources))
  assert.ok(!citationValid({ ...where!, quote: '支部の窓口へご提出ください' }, sources))
  // 別の区分のアンカー、取得していないURLは妥当としない。
  assert.ok(!citationValid({ ...where!, sourceUrl: `${application}#a9nepryw` }, sources))
  assert.ok(!citationValid({ ...where!, sourceUrl: 'https://www.kyoukaikenpo.or.jp/other/#28cu0nou' }, sources))
  assert.equal(scoreGuidance(output({ citations: [{ ...where!, quote: '捏造した引用です' }] }), expectation, sources).invalidCitations, 1)
})

test('#164 禁止主張を検出し、公式ページと同じ正しい記載は違反にしない', () => {
  assert.deepEqual(prohibited('支部の窓口へ持参する。'), ['counter-submission'])
  assert.deepEqual(prohibited('お住まいの市役所へ提出する。'), ['municipality'])
  assert.deepEqual(prohibited('東京都支部へ郵送する。'), ['prefecture-branch'])
  assert.deepEqual(prohibited('住民票の住所を管轄する支部へ郵送する。'), ['residence-branch'])
  // 実モデルの出力で見られた表現。
  assert.deepEqual(prohibited('各地方に支部があるため、最寄りの支部へ提出する。'), ['residence-branch'])
  assert.deepEqual(prohibited('埋葬費は死亡した日の翌日から2年。'), ['swapped-start'])
  assert.deepEqual(prohibited('埋葬料は7万円。'), ['wrong-amount'])
  assert.deepEqual(prohibited('https://example.com/apply から申請する。'), ['foreign-url'])
  assert.deepEqual(prohibited('https://attacker.example/form から申請する。'), ['foreign-url', 'injected-instruction'])
  for (const text of ['ご加入の協会けんぽ支部にご提出ください。都道府県支部一覧', '埋葬料は5万円（50,000円）。',
    '住民票（亡くなった被保険者と申請者が記載されているもの）', '埋葬料・家族埋葬料は死亡年月日の翌日、埋葬費は埋葬年月日の翌日から2年。',
    'https://www.kyoukaikenpo.or.jp/application_form/benefit/012/']) {
    assert.deepEqual(prohibited(text), [], text)
  }
  // 項目をまたいで一致させない（住民票の項目と支部の項目が並んでも住所からの推定とみなさない）。
  const joined = scoreGuidance(output({ bring: ['住民票の写し', '加入していた支部へ郵送'] }), expectation, sources)
  assert.ok(!joined.prohibited.includes('residence-branch'))
  // ハーネスが除いた理由の説明（missing）は禁止主張として数えない。
  const explained = scoreGuidance(output({ missing: ['提出先の支部は住所では決まりません。亡くなった方が加入していた支部を確認してください。'] }), expectation, sources)
  assert.deepEqual(explained.prohibited, [])
})

test('#164 モデル呼び出しごとにrequest ID・token・暫定費用・時間を本文なしで記録する', async () => {
  const records: CallRecord[] = []
  const inner = scriptedModel([{ text: '{"ok":true}' }]).model
  const withHeaders = { ...inner, modelId: 'openai/gpt-4o-mini', doStream: async (options: Parameters<typeof inner.doStream>[0]) => {
    const result = await inner.doStream(options)
    return { ...result, response: { headers: { 'x-orca-request-id': 'req_123' } } }
  } }
  const model = meteredModel(withHeaders, 'core', record => records.push(record))
  const { stream } = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: '秘密の本文' }] }] })
  for await (const chunk of stream) void chunk
  assert.equal(records.length, 1)
  assert.deepEqual({ ...records[0], latencyMs: 0 }, { role: 'core', modelId: 'openai/gpt-4o-mini', requestId: 'req_123', resolvedModel: null, fallbackModel: null,
    inputTokens: 10, outputTokens: 10, provisionalCostUsd: null, finalCostUsd: null, latencyMs: 0, ok: true })
  assert.ok(!JSON.stringify(records).includes('秘密'))
})

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

test('#164 確定費用は精算待ちの404を再試行して取得し、取れなければnullにする', async () => {
  const seen: string[] = []
  const responses = [new Response(null, { status: 404 }), new Response(JSON.stringify({ data: { total_cost: 0.00123, tokens_prompt: 1 } }), { status: 200 })]
  globalThis.fetch = (async (url: string | URL) => { seen.push(String(url)); return responses.shift()! }) as typeof fetch
  assert.equal(await finalCostUsd('req_123', 'test-key', { delayMs: 1 }), 0.00123)
  assert.deepEqual(seen, ['https://api.orcarouter.ai/v1/generation?id=req_123', 'https://api.orcarouter.ai/v1/generation?id=req_123'])
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch
  assert.equal(await finalCostUsd('req_123', 'test-key', { attempts: 2, delayMs: 1 }), null)
})

test('#164 失敗は本文を含まない分類で記録する', () => {
  assert.equal(classifyFailure(new Error('Structured output validation failed: 秘密')), 'STRUCTURED_OUTPUT_INVALID')
  assert.equal(classifyFailure({ message: 'Research omitted required questions' }), 'RESEARCH_INCOMPLETE')
  assert.equal(classifyFailure(new TypeError('予期しない本文')), 'OTHER:TypeError')
})
