import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProposalResource } from '@aftercare/public-contracts'
import { applyProposalEdits, proposalRows } from './approval'

/** 書類の読み取り（document_analysis）から届く財産の登録の提案。 */
const assetProposal = {
  id: 'proposal-1', kind: 'ASSET_PROPOSAL', title: '預金口座を財産として登録する', summary: '書類から「架空信用金庫」の口座を見つけました。',
  payload: { operation: 'CREATE', fields: { name: '架空信用金庫', kind: 'BANK', institution: '架空信用金庫', amount: 1234567, taxAttention: false, note: null } },
} as unknown as ProposalResource

test('財産の登録は、項目名と種類を日本語で表示し、選択肢の値は直せないようにする', () => {
  const rows = Object.fromEntries(proposalRows(assetProposal).map((row) => [row.key, row]))
  assert.deepEqual(Object.values(rows).map((row) => row.label), ['名前', '種類', '金融機関', '金額（円）', '税の確認', 'メモ'])
  assert.equal(rows.kind!.value, '預金')
  assert.equal(rows.kind!.editable, false)
  assert.equal(rows.taxAttention!.value, '不要')
  assert.equal(rows.taxAttention!.editable, false)
  assert.equal(rows.amount!.value, '1234567')
})

test('直した金額は数値に戻し、ほかの項目は文字列のまま保存する', () => {
  const edited = applyProposalEdits(assetProposal, { amount: '１，２３４，０００円', note: '123', institution: '架空信用金庫 本店' })
  const fields = edited.fields as Record<string, unknown>
  assert.equal(fields.amount, 1234000)
  assert.equal(fields.note, '123')
  assert.equal(fields.institution, '架空信用金庫 本店')
  assert.equal((applyProposalEdits(assetProposal, { amount: '' }).fields as Record<string, unknown>).amount, null)
})
