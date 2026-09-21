import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GUIDANCE_LIMITS, internalResultSchema } from '@aftercare/internal-contracts'
import type { InternalResult } from '@aftercare/internal-contracts'
import { textHash } from '../src/infrastructure/research/official-catalog.js'
import {
  CONTINUATION, GuidanceContractError, fitGuidance, guidanceResult, splitToLimit, unresolvedApplicability,
} from '../src/orchestration/playbooks/guidance-output.js'
import type { GuidanceDraft } from '../src/orchestration/playbooks/guidance-output.js'
import { sourceDocument } from './helpers/source-document.js'

const proof = { caseVersion: 1, contextSnapshotId: 'snapshot-1', fencingToken: 1, artifactVersion: 1, contentHash: textHash('proof') }
const source = sourceDocument({ id: 'source-1', catalogId: 'c', title: '合成資料', issuer: '合成機関', url: 'https://official.example/a' }, '本文')
const claim = (text: string) => ({ text, sourceIds: ['source-1'] })
const draft = (patch: Partial<GuidanceDraft> = {}): GuidanceDraft => ({
  status: 'partial', where: claim('加入している支部へ郵送する。'), bring: [claim('申請書')], steps: [claim('申請書を郵送する。')], missing: ['加入支部'], ...patch,
})
const brief = { briefId: 'brief-1', procedure: '合成手続き', institution: '合成機関', jurisdiction: '日本', sourceCatalogIds: ['c'],
  questions: [{ id: 'documents', text: '必要書類は何か' }] }
/** 下書きがcompleteを名乗るには完了した調査の記録が必要。ハーネスの既存の検査はそのまま残す。 */
const research = { briefs: [brief], outcomes: [{ briefId: 'brief-1', findings: { status: 'complete' as const,
  answers: [{ questionId: 'documents', text: '申請書', sourceIds: ['source-1'], applicability: '日本の合成機関が扱う合成手続き' }], missing: [], conflicts: [] } }] }
const report = (input: GuidanceDraft, unresolved: string[] = []) => {
  const result = guidanceResult({ draft: input, sources: [source], research, proof, resultId: 'result-1', target: '合成手続き', unresolved })
  if (result.kind !== 'task_guidance') assert.fail()
  return result
}
/** 継続の印を除いて連結すると元の文と一致するか。分割で情報を失っていないことの確認。 */
const joined = (items: readonly string[]) => items.map(item => item.startsWith(CONTINUATION) ? item.slice(CONTINUATION.length) : item).join('')

test('#162 AI側と内部API側で同じ上限を使う', () => {
  const base = { ...proof, resultId: 'r', kind: 'task_guidance', status: 'PARTIAL', basis: [] }
  assert.ok(internalResultSchema.safeParse({ ...base, bring: ['あ'.repeat(GUIDANCE_LIMITS.bringItem)] }).success)
  assert.ok(!internalResultSchema.safeParse({ ...base, bring: ['あ'.repeat(GUIDANCE_LIMITS.bringItem + 1)] }).success)
  assert.ok(!internalResultSchema.safeParse({ ...base, missing: ['あ'.repeat(GUIDANCE_LIMITS.missingItem + 1)] }).success)
})

test('#162 上限ちょうどは分割せず、超えた分は文の切れ目で分ける', () => {
  const exact = 'あ'.repeat(GUIDANCE_LIMITS.bringItem - 1) + '。'
  assert.deepEqual(splitToLimit(exact, GUIDANCE_LIMITS.bringItem, 'BRING_ITEM_TOO_LONG'), [exact])

  const sentences = Array.from({ length: 6 }, (_, index) => `条件${index}の場合は合成書類${index}を添付する。`).join('').repeat(3)
  const items = splitToLimit(sentences, GUIDANCE_LIMITS.bringItem, 'BRING_ITEM_TOO_LONG')
  assert.ok(items.length > 1)
  assert.ok(items.every(item => item.length <= GUIDANCE_LIMITS.bringItem))
  assert.ok(items.slice(1).every(item => item.startsWith(CONTINUATION)))
  assert.ok(items.every(item => /[。]$/.test(item)), '文の途中で切れている')
  assert.equal(joined(items), sentences)
})

test('#162 1文が長い場合は読点で分け、数値の桁区切りでは分けない', () => {
  const sentence = `${'霊柩車代、'.repeat(30)}支給額は50,000円または50，000円の範囲内で実費とする。`
  const items = splitToLimit(sentence, GUIDANCE_LIMITS.bringItem, 'BRING_ITEM_TOO_LONG')
  assert.ok(items.every(item => item.length <= GUIDANCE_LIMITS.bringItem))
  assert.equal(joined(items), sentence)
  assert.ok(items.some(item => item.includes('50,000円')) && items.some(item => item.includes('50，000円')))
})

test('#162 句読点の間だけで上限を超える場合は修復できないとして区別する', () => {
  assert.throws(() => splitToLimit('あ'.repeat(300), GUIDANCE_LIMITS.bringItem, 'BRING_ITEM_TOO_LONG'),
    (error: unknown) => error instanceof GuidanceContractError && error.code === 'BRING_ITEM_TOO_LONG')
})

test('#162 200文字を超える必要書類説明でも報告できる形に修復する', () => {
  const long = Array.from({ length: 12 }, (_, index) => `条件${index}に当たる場合は合成書類${index}の写しを添付する。`).join('')
  assert.ok(long.length > GUIDANCE_LIMITS.bringItem)
  const result = report(draft({ bring: [claim(long), claim('申請書')] }))
  assert.equal(result.status, 'PARTIAL')
  assert.ok(result.bring.length > 2)
  assert.ok(result.bring.every(item => item.length <= GUIDANCE_LIMITS.bringItem))
  assert.equal(result.bring.at(-1), '申請書', '後続の項目の順序が保たれない')
  assert.doesNotThrow(() => internalResultSchema.parse(result))
})

test('#162 修復できない場合は成功に見せず、本文を含まない理由で失敗を返す', () => {
  const secret = '秘密の本文'.repeat(60)
  const result = report(draft({ bring: [claim(secret)] }))
  assert.equal(result.status, 'FAILED')
  assert.equal(result.failureReason, 'GUIDANCE_CONTRACT:BRING_ITEM_TOO_LONG')
  assert.deepEqual([result.bring, result.steps, result.sources], [[], [], []])
  assert.ok(!JSON.stringify(result).includes('秘密の本文'))
  assert.equal(report(draft({ where: claim('あ'.repeat(GUIDANCE_LIMITS.where + 1)) })).failureReason, 'GUIDANCE_CONTRACT:WHERE_TOO_LONG')
})

test('#162 案件への適用条件が未確認なら完了にせず、確認事項をmissingに入れる', () => {
  const complete = draft({ status: 'complete', missing: [] })
  const questions = ['加入していた支部を確認してください。', '申請者の区分を確認してください。']
  const partial = report(complete, questions)
  assert.equal(partial.status, 'PARTIAL')
  assert.deepEqual(partial.missing, questions)
  // 適用条件が揃い、調査も完了している場合だけ完了にできる。
  const fitted = fitGuidance(complete, [])
  assert.ok(fitted.ok && fitted.status === 'COMPLETED')
  assert.equal(report(complete, []).status, 'COMPLETED')
})

test('#162 確認済みとみなすのはBackendの正式な記録だけ', () => {
  const checks = [
    { id: 'enrollment', question: '加入していた支部を確認してください。', confirmedBy: { group: 'task' as const, field: 'enrollmentConfirmed', equals: true } },
    { id: 'applicant', question: '申請者の区分を確認してください。' },
  ]
  const confirmed = { group: 'task', field: 'enrollmentConfirmed', value: true, state: 'confirmed' }
  assert.deepEqual(unresolvedApplicability(checks, [confirmed]), ['申請者の区分を確認してください。'])
  // 利用者の申告や値の食い違いでは確認済みにしない。
  assert.equal(unresolvedApplicability(checks, [{ ...confirmed, state: 'user_reported' }]).length, 2)
  assert.equal(unresolvedApplicability(checks, [{ ...confirmed, value: 'true' }]).length, 2)
})

test('#162 モデルと適用条件の重複した確認事項を1件にまとめる', () => {
  const result = report(draft({ missing: ['加入支部を確認してください。'] }), ['加入支部を確認してください。', '申請者の区分を確認してください。'])
  assert.deepEqual(result.missing, ['加入支部を確認してください。', '申請者の区分を確認してください。'])
})

test('#162 報告結果は常に内部契約を満たす', () => {
  const cases: GuidanceDraft[] = [
    draft(), draft({ status: 'complete', missing: [] }), draft({ bring: [claim('あ。'.repeat(150))] }),
    draft({ steps: [claim('手順。'.repeat(200))] }), draft({ bring: Array.from({ length: GUIDANCE_LIMITS.items }, () => claim('あ。'.repeat(120))) }),
  ]
  for (const input of cases) {
    const result: InternalResult = report(input, ['加入支部を確認してください。'])
    assert.doesNotThrow(() => internalResultSchema.parse(result))
  }
})
