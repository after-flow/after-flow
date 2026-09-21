import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { TaskRequiredDocumentResource as RequiredDocument } from '@aftercare/public-contracts'
import { mergeBringRows } from './bring'

const doc = (id: string, label: string, collected = false): RequiredDocument => ({
  id,
  label,
  collected,
  documentId: null,
  source: 'RULE_ENGINE',
})

it('treats an item that differs only by a trailing note as the same item', () => {
  const rows = mergeBringRows([doc('d1', '死亡診断書', true)], ['死亡診断書（原本）', '届出人の本人確認書類'])
  assert.deepEqual(
    rows.map((r) => [r.label, r.doc?.id]),
    [
      ['死亡診断書（原本）', 'd1'],
      ['届出人の本人確認書類', undefined],
    ],
  )
  // 記録済みの印は、元の持ち物のものを引き継ぐ
  assert.equal(rows[0]?.doc?.collected, true)
})

it('keeps items whose notes differ from each other', () => {
  const rows = mergeBringRows([doc('d1', '戸籍謄本（故人のもの）')], ['戸籍謄本（相続人全員分）'])
  assert.deepEqual(rows.map((r) => r.label), ['戸籍謄本（故人のもの）', '戸籍謄本（相続人全員分）'])
})

it('keeps a guidance item in place after it is checked', () => {
  const rows = mergeBringRows(
    [doc('d1', '年金証書'), doc('bring_x', '死亡診断書（原本）', true)],
    ['死亡診断書（原本）'],
  )
  assert.deepEqual(
    rows.map((r) => [r.label, r.doc?.id]),
    [
      ['年金証書', 'd1'],
      ['死亡診断書（原本）', 'bring_x'],
    ],
  )
})

it('does not hide a guidance item that was already recorded, even if a listed item is similar', () => {
  // 以前、案内の「死亡診断書（原本）」を押して記録していた。まとめると、この記録が一覧から消えてしまう
  const rows = mergeBringRows(
    [doc('d1', '死亡診断書'), doc('bring_x', '死亡診断書（原本）', true)],
    ['死亡診断書（原本）'],
  )
  assert.deepEqual(
    rows.map((r) => [r.label, r.doc?.id, r.doc?.collected]),
    [
      ['死亡診断書', 'd1', false],
      ['死亡診断書（原本）', 'bring_x', true],
    ],
  )
})
