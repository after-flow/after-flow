import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { ProposalResource } from '@aftercare/public-contracts'
import { applyProposalEdits, editError, proposalRows } from './approval'

function proposal(kind: ProposalResource['kind'], payload: Record<string, unknown>): ProposalResource {
  return {
    id: 'prop_1',
    caseId: 'case_1',
    kind,
    status: 'AWAITING_APPROVAL',
    source: 'AI',
    agentRunId: null,
    title: '',
    summary: '',
    proposalVersion: 1,
    payload,
    payloadHash: 'h',
    basis: [],
    caseVersionAtProposal: 1,
    assetDisposal: false,
    supersedesProposalVersion: null,
    version: 1,
    createdAt: '2026-09-22T00:00:00Z',
    updatedAt: '2026-09-22T00:00:00Z',
  }
}

const asset = proposal('ASSET_PROPOSAL', {
  operation: 'CREATE',
  fields: { name: '○○銀行 普通預金', kind: 'BANK', institution: null, amount: 3240000, taxAttention: false, note: null },
})

it('shows asset fields with Japanese labels and readable values', () => {
  const rows = new Map(proposalRows(asset).map((r) => [r.key, r]))
  assert.equal(rows.get('amount')?.label, '金額（円）')
  assert.equal(rows.get('amount')?.display, '3,240,000円')
  assert.equal(rows.get('kind')?.display, '預金')
  assert.equal(rows.get('taxAttention')?.display, 'いいえ')
  assert.equal(rows.get('institution')?.value, '')
})

it('sends edited values back with the types the Backend validates', () => {
  const payload = applyProposalEdits(asset, { amount: '３，２５０，０００円', taxAttention: 'true', kind: 'SECURITIES', note: '' })
  const fields = payload.fields as Record<string, unknown>
  assert.equal(fields.amount, 3250000)
  assert.equal(fields.taxAttention, true)
  assert.equal(fields.kind, 'SECURITIES')
  // もともと空の欄を空のままにしたら null に戻す
  assert.equal(fields.note, null)
  // 直していない項目はそのまま
  assert.equal(fields.name, '○○銀行 普通預金')
  assert.equal(fields.institution, null)
})

it('clears an amount to null and rejects amounts that are not whole numbers', () => {
  const fields = applyProposalEdits(asset, { amount: '' }).fields as Record<string, unknown>
  assert.equal(fields.amount, null)
  const amount = proposalRows(asset).find((r) => r.key === 'amount')!
  assert.equal(editError(amount, '3,240,000'), null)
  assert.notEqual(editError(amount, '約300万'), null)
  assert.notEqual(editError(amount, '-1'), null)
})

it('clears a person birth date to null instead of an empty string', () => {
  const person = proposal('PERSON_PROPOSAL', {
    operation: 'CREATE',
    fields: { name: '山田 次郎', dateOfBirth: '1960-01-02', isHeir: true, specialCircumstance: null },
  })
  const fields = applyProposalEdits(person, { dateOfBirth: '', specialCircumstance: 'MINOR' }).fields as Record<string, unknown>
  assert.equal(fields.dateOfBirth, null)
  assert.equal(fields.specialCircumstance, 'MINOR')
  assert.equal(fields.isHeir, true)
})
