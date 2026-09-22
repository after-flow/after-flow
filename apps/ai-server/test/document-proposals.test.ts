import assert from 'node:assert/strict'
import { test } from 'node:test'
import { draftProposalsFromCandidates } from '../src/orchestration/documents/proposal-mapping.js'

const basis = { documentId: 'doc', documentVersion: 1, artifactId: 'artifact', artifactVersion: 1, contentHash: 'h'.repeat(43) }
let offset = 0
const candidate = (fieldId: string, value: string, quote = value) => ({ fieldId, value, quote, page: 1, start: offset, end: (offset += quote.length),
  state: 'extracted_candidate' as const, difference: 'NEW' as const, requiresHumanReview: true as const, preservesCorrection: false, basis })
const fields = (proposals: ReturnType<typeof draftProposalsFromCandidates>) => proposals.map(item => item.payload.fields as Record<string, unknown>)

test('金融機関が1つなら、その口座と残高を提案する', () => {
  const proposals = draftProposalsFromCandidates({ conflictingFields: [], candidates: [candidate('institution', '架空信用金庫'), candidate('amount', '1,234,567円', '残高 1,234,567円')] })
  assert.deepEqual(fields(proposals).map(item => [item.institution, item.amount]), [['架空信用金庫', 1234567]])
  assert.equal(proposals[0]!.summary, '書類から「架空信用金庫」の口座を見つけました。')
})

test('残高が複数の値に分かれるときは金額を空にし、その理由を説明に書く', () => {
  const proposals = draftProposalsFromCandidates({ conflictingFields: ['amount'], candidates: [
    candidate('institution', '架空銀行'), candidate('amount', '975,300'), candidate('amount', '856,320'),
  ] })
  assert.equal(fields(proposals)[0]!.amount, null)
  assert.match(proposals[0]!.summary, /残高の記載が複数ある/)
})

test('複数の口座が載った書類は口座ごとに提案し、同じ行の残高だけを結び付ける', () => {
  // 以前は金融機関名の食い違いとして提案を作らず、利用者に何も届かなかった。
  const proposals = draftProposalsFromCandidates({ conflictingFields: ['institution', 'amount'], candidates: [
    candidate('institution', '架空銀行'), candidate('institution', '架空信用金庫'),
    candidate('amount', '1,000,000円', '架空銀行 みなと支店 普通 1,000,000円'), candidate('amount', '2,000,000円', '架空信用金庫 本店 定期 2,000,000円'),
  ] })
  assert.deepEqual(fields(proposals).map(item => [item.institution, item.amount]), [['架空銀行', 1000000], ['架空信用金庫', 2000000]])
  assert.ok(proposals.every(item => /2件の口座/.test(item.summary)))
  // 残高の引用に金融機関名が無ければ、どの口座の残高か決められないので結び付けない。
  const unpaired = draftProposalsFromCandidates({ conflictingFields: ['institution', 'amount'], candidates: [
    candidate('institution', '架空銀行'), candidate('institution', '架空信用金庫'), candidate('amount', '1,000,000円'), candidate('amount', '2,000,000円'),
  ] })
  assert.deepEqual(fields(unpaired).map(item => item.amount), [null, null])
})

test('同じ金融機関の重複は1件にまとめ、金融機関が無ければ提案しない', () => {
  assert.equal(draftProposalsFromCandidates({ conflictingFields: [], candidates: [candidate('institution', '架空銀行'), candidate('institution', '架空銀行')] }).length, 1)
  assert.deepEqual(draftProposalsFromCandidates({ conflictingFields: [], candidates: [candidate('amount', '1,000円')] }), [])
})
