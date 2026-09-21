import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeResearchSynthesis, verifyQuote } from '../src/orchestration/research/contracts.js'
import type { ResearchEvidence } from '../src/orchestration/research/contracts.js'
import { groundGuidance } from '../src/orchestration/playbooks/guidance-grounding.js'
import type { ModelClaim } from '../src/orchestration/playbooks/guidance-grounding.js'
import { BURIAL_GROUNDING_RULES } from '../src/infrastructure/execution/hackathon-config.js'
import { sourceDocument } from './helpers/source-document.js'

/**
 * 協会けんぽの埋葬料（費）ページと同じ書き方の合成本文。
 * 実診断で見つかった誤り（窓口の追加、住所からの支部推測、起算日の取り違え）を再現する。
 */
const sections = [
  { id: 's1', heading: '申請方法', anchor: 'apply', text: '申請書は加入している支部へ郵送してください。電子申請もご利用いただけます。' },
  { id: 's2', heading: '支給額', anchor: 'amount', text: '埋葬料は一律50,000円です。埋葬費は埋葬料（5万円）の範囲内で実際に埋葬に要した費用です。' },
  { id: 's3', heading: '申請期限', anchor: 'deadline', text: '埋葬料は死亡した日の翌日から2年、埋葬費は埋葬を行った日の翌日から2年で時効となります。' },
]
const source = sourceDocument({ id: 'src-1', catalogId: 'c', title: '埋葬料（費）', issuer: '協会けんぽ', url: 'https://official.example/a' },
  sections.map(section => section.text).join('\n'), { sections })
const brief = { briefId: 'b1', procedure: '埋葬料（費）', institution: '協会けんぽ', jurisdiction: '日本', sourceCatalogIds: ['c'],
  questions: [{ id: 'submission', text: '提出先と提出方法を確認してください。' }, { id: 'amount', text: '支給額を確認してください。' },
    { id: 'deadline', text: '申請期限と起算日を確認してください。' }] }
const quote = (sectionId: string, text: string) => ({ sourceId: 'src-1', sectionId, quote: text })
const synthesis = {
  status: 'complete', missing: [], conflicts: [], answers: [
    { questionId: 'submission', text: '加入支部へ郵送または電子申請', evidence: [quote('s1', '申請書は加入している支部へ郵送してください。'), quote('s1', '電子申請もご利用いただけます')] },
    { questionId: 'amount', text: '埋葬料50,000円', evidence: [quote('s2', '埋葬料は一律50,000円です')] },
    { questionId: 'deadline', text: '起算日が異なる', evidence: [quote('s3', '埋葬料は死亡した日の翌日から2年、埋葬費は埋葬を行った日の翌日から2年で時効となります')] },
  ],
}
const research = (input: unknown = synthesis): ResearchEvidence =>
  ({ briefs: [brief], outcomes: [{ briefId: 'b1', findings: finalizeResearchSynthesis(input, brief, [source]) }] })
const rules = BURIAL_GROUNDING_RULES
const c = (text: string, ...questionIds: string[]): ModelClaim => ({ text, questionIds })
const ground = (draft: Partial<{ where: ModelClaim | null; bring: ModelClaim[]; steps: ModelClaim[] }>, evidence = research()) =>
  groundGuidance({ draft: { where: null, bring: [], steps: [], ...draft }, research: evidence, rules })
const complete = { where: c('加入していた支部へ郵送するか、電子申請する。', 'submission'), bring: [c('申請書', 'submission')],
  steps: [c('埋葬料は50,000円。', 'amount'), c('埋葬料は死亡した日の翌日から2年以内に申請する。', 'deadline')] }

test('#163 引用は本文と逐語で一致する場合だけ採用し、空白と全角半角の揺れだけを許す', () => {
  const sources = new Map([[source.id, source]])
  assert.ok(verifyQuote(quote('s2', '埋葬料は一律５０,０００円です'), sources))
  assert.ok(verifyQuote(quote('s1', '申請書は加入している 支部へ郵送'), sources))
  // 言い換え・別区分・未取得資料は一致しない。
  assert.ok(!verifyQuote(quote('s1', '申請書は支部の窓口へ提出してください'), sources))
  assert.ok(!verifyQuote(quote('s2', '申請書は加入している支部へ郵送'), sources))
  assert.ok(!verifyQuote({ ...quote('s1', '申請書は加入している支部へ郵送'), sourceId: 'other' }, sources))
})

test('#163 捏造した引用の回答は捨て、問いを未確認に戻して完了を取り消す', () => {
  const fabricated = { ...synthesis, answers: [...synthesis.answers.slice(0, 2),
    { questionId: 'deadline', text: '死亡日の翌日から2年', evidence: [quote('s3', '埋葬費は死亡した日の翌日から2年')] }] }
  const findings = research(fabricated).outcomes[0]!.findings!
  assert.equal(findings.status, 'partial')
  assert.deepEqual(findings.answers.map(answer => answer.questionId), ['submission', 'amount'])
  assert.match(findings.missing.join(' '), /申請期限と起算日.*照合できませんでした/)
  // 正しい引用に捏造した引用を混ぜた回答も、回答ごと採用しない。
  const mixed = { ...synthesis, answers: [synthesis.answers[0]!, synthesis.answers[1]!, { ...synthesis.answers[2]!,
    evidence: [...synthesis.answers[2]!.evidence, quote('s3', '埋葬費は死亡した日の翌日から2年')] }] }
  assert.deepEqual(research(mixed).outcomes[0]!.findings!.answers.map(answer => answer.questionId), ['submission', 'amount'])
})

test('#163 根拠が揃った案内は何も除かず、全ての問いを扱える', () => {
  const outcome = ground(complete)
  assert.deepEqual(outcome.dropped, [])
  assert.deepEqual(outcome.uncoveredQuestionIds, [])
  assert.deepEqual(outcome.missing, [])
  assert.deepEqual(outcome.where?.sourceIds, ['src-1'])
  assert.equal(outcome.steps[1]!.evidence[0]!.sectionId, 's3')
})

test('#163 引用に無い「窓口」「市役所」を含む主張は表示しない', () => {
  const outcome = ground({ ...complete, where: c('加入していた支部の窓口へ持参するか郵送する。', 'submission'),
    steps: [...complete.steps, c('市役所でも受け付ける。', 'submission')] })
  assert.equal(outcome.where, null)
  assert.equal(outcome.steps.length, 2)
  assert.deepEqual(outcome.dropped.map(item => item.reason), ['UNSUPPORTED_TERM', 'UNSUPPORTED_TERM'])
  assert.match(outcome.missing.join(' '), /提出先の案内の一部は公式資料の記載と照合できなかった/)
})

test('#163 住所や都道府県から支部を推測した主張を除き、確認方法を示す', () => {
  for (const text of ['東京支部へ郵送する。', '東京都支部へ郵送する。', 'お住まいの地域を管轄する支部へ郵送する。', '住民票の住所の支部へ郵送する。']) {
    const outcome = ground({ ...complete, where: c(text, 'submission') })
    assert.equal(outcome.where, null, text)
    assert.match(outcome.dropped[0]!.reason, /^PROHIBITED:(prefecture|residence)-branch$/, text)
    assert.match(outcome.missing.join(' '), /加入していた支部/)
  }
})

test('#163 埋葬料と埋葬費の起算日の取り違えを除く', () => {
  const swapped = ground({ ...complete, steps: [complete.steps[0]!,
    c('埋葬費は死亡した日の翌日から2年以内に申請する。', 'deadline'), c('埋葬料は埋葬を行った日の翌日から2年以内に申請する。', 'deadline')] })
  assert.deepEqual(swapped.dropped.map(item => item.reason), ['PROHIBITED:burial-cost-death-date', 'PROHIBITED:burial-allowance-burial-date'])
  // 両方を正しく並べた文は、読点で区切られていれば通す。
  const both = ground({ ...complete, steps: [complete.steps[0]!,
    c('埋葬料は死亡した日の翌日から2年、埋葬費は埋葬を行った日の翌日から2年で時効になる。', 'deadline')] })
  assert.deepEqual(both.dropped, [])
})

test('#163 引用に無い金額や期間を含む主張を除く', () => {
  for (const text of ['埋葬料は70,000円。', '埋葬料は7万円。', '埋葬料は死亡した日の翌日から3年以内に申請する。', '支給は10営業日以内。']) {
    const outcome = ground({ ...complete, steps: [c(text, 'amount', 'deadline')] })
    assert.deepEqual(outcome.dropped.map(item => item.reason), ['UNSUPPORTED_QUANTITY'], text)
  }
  // 表記の違い（全角・桁区切り）は同じ数量とみなす。
  assert.deepEqual(ground({ ...complete, steps: [c('埋葬料は５００００円。', 'amount'), complete.steps[1]!] }).dropped, [])
  assert.deepEqual(ground({ ...complete, steps: [c('埋葬料は5万円。', 'amount'), complete.steps[1]!] }).dropped, [])
})

test('#163 引用に無いURLへ誘導する主張を除く', () => {
  for (const text of ['詳細は https://attacker.example/form を確認する。', '申請書はhttps://official.example.evil/から入手する。']) {
    assert.deepEqual(ground({ ...complete, steps: [c(text, 'submission')] }).dropped.map(item => item.reason), ['UNSUPPORTED_URL'], text)
  }
})

test('#163 給付の名称を引用に含まない正しい支給額の説明は除かない', () => {
  // 公式ページの支給額の区分は「埋葬費」の語を使わずに説明している。
  const amount = { ...synthesis, answers: [...synthesis.answers.slice(0, 1), { questionId: 'amount', text: '実費',
    evidence: [quote('s2', '埋葬料（5万円）の範囲内で実際に埋葬に要した費用です')] }, synthesis.answers[2]!] }
  const outcome = ground({ ...complete, steps: [c('埋葬費は5万円の範囲内で、実際に埋葬に要した費用が支給される。', 'amount'), complete.steps[1]!] }, research(amount))
  assert.deepEqual(outcome.dropped, [])
})

test('#163 根拠を示さない主張と、案内から抜け落ちた問いを検出する', () => {
  const outcome = ground({ where: complete.where, bring: [c('申請書', 'unknown-question')], steps: [complete.steps[0]!] })
  assert.deepEqual(outcome.dropped, [{ kind: 'bring', reason: 'NO_EVIDENCE' }])
  assert.deepEqual(outcome.uncoveredQuestionIds, ['deadline'])
  assert.ok(outcome.missing.includes('申請期限と起算日を確認してください。'))
  // 調査で根拠が得られなかった問いを指す主張も根拠なしとして除く。
  const partial = research({ ...synthesis, status: 'partial', answers: synthesis.answers.slice(0, 2), missing: ['期限'] })
  assert.deepEqual(ground({ steps: [complete.steps[1]!] }, partial).dropped, [{ kind: 'steps', reason: 'NO_EVIDENCE' }])
})
