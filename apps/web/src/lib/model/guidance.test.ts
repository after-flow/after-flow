import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GuidanceOutcomeResource, GuidanceResource, GuidanceStatusResource } from '@aftercare/public-contracts'
import { guidanceDisplayState } from './guidance'

function guidance(patch: Partial<GuidanceResource> = {}): GuidanceResource {
  return {
    taskId: 'task-1',
    status: 'COMPLETED',
    outcome: 'COMPLETED_RESEARCH',
    target: '国民健康保険の資格喪失届',
    where: '保険年金の窓口',
    bring: [],
    steps: [],
    formExampleUrl: null,
    formExampleLabel: null,
    note: null,
    sources: [{ label: '案内', url: 'https://example.lg.jp/guide', checkedAt: '2026-09-01T00:00:00Z' }],
    citations: [],
    missing: [],
    failureReason: null,
    researchedBy: 'AI',
    agentRunId: 'run-1',
    version: 2,
    updatedAt: '2026-09-01T00:00:00Z',
    ...patch,
  }
}

test('未依頼と依頼済みを区別する', () => {
  assert.equal(guidanceDisplayState(undefined), 'NOT_REQUESTED')
  assert.equal(guidanceDisplayState(guidance({ status: 'NOT_REQUESTED' })), 'NOT_REQUESTED')
})

test('実行中と書類待ちは調べている扱いにする', () => {
  for (const status of ['RESEARCHING', 'WAITING'] as GuidanceStatusResource[]) {
    assert.equal(guidanceDisplayState(guidance({ status })), 'RESEARCHING')
  }
})

test('出典が残っている調査完了だけを RESEARCHED にする', () => {
  assert.equal(guidanceDisplayState(guidance()), 'RESEARCHED')
  assert.equal(guidanceDisplayState(guidance({ status: 'PARTIAL' })), 'RESEARCHED')
})

test('事前終了は調べた結果として扱わない', () => {
  assert.equal(
    guidanceDisplayState(guidance({ outcome: 'MISSING_CONTEXT', researchedBy: null, sources: [] })),
    'MISSING_CONTEXT',
  )
  for (const outcome of ['SOURCE_NOT_CONFIGURED', 'NOT_APPLICABLE'] as GuidanceOutcomeResource[]) {
    assert.equal(
      guidanceDisplayState(guidance({ outcome, researchedBy: null, sources: [] })),
      'NOT_RESEARCHABLE',
    )
  }
})

test('失敗は status と outcome のどちらからでも拾う', () => {
  assert.equal(guidanceDisplayState(guidance({ status: 'FAILED', outcome: 'FAILED', researchedBy: null, sources: [] })), 'FAILED')
  // 送信元が status だけを FAILED にした場合も失敗として扱う。
  assert.equal(guidanceDisplayState(guidance({ status: 'FAILED', outcome: null, researchedBy: null, sources: [] })), 'FAILED')
})

test('出典が無ければ「AIが調べた」と言わない', () => {
  // outcome が COMPLETED_RESEARCH でも、出典が残っていなければ確かめる先が無い。
  assert.equal(guidanceDisplayState(guidance({ sources: [] })), 'NO_SOURCES')
  // outcome を持たない古い記録も、researchedBy だけでは信用しない。
  assert.equal(guidanceDisplayState(guidance({ outcome: null, sources: [] })), 'NO_SOURCES')
  // 出典があっても、AIが調べたものでなければ同じ。
  assert.equal(guidanceDisplayState(guidance({ outcome: null, researchedBy: 'MANUAL' })), 'NO_SOURCES')
})

test('outcome を持たない古い記録でも、出典があれば調査完了として表示できる', () => {
  assert.equal(guidanceDisplayState(guidance({ outcome: null })), 'RESEARCHED')
})
