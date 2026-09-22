import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dataset } from '../eval/dataset.js'
import { contractScorer, extractionMetrics } from '../eval/scorers.js'
import { executeFixture } from '../eval/target.js'

test('synthetic dataset has disjoint reviewed partitions and each development case meets its declared contract', async () => {
  assert.equal(dataset.length, 38); assert.equal(new Set(dataset.map(item => item.id)).size, dataset.length)
  for (const split of ['development', 'holdout']) {
    const partition = dataset.filter(item => item.split === split)
    assert.equal(new Set(partition.map(item => item.input.family)).size, 4)
    assert.ok(partition.some(item => item.expected.state !== 'REJECTED'))
  }
  for (const item of dataset.filter(item => item.split === 'development')) {
    const result = await contractScorer.run({ input: item.input, output: executeFixture(item.input), groundTruth: item.expected })
    assert.equal(result.score, 1, item.id)
  }
})
test('scoring detects fabricated extraction, omitted fields, unconditional refusal and external completion', async () => {
  const item = dataset.find(item => item.id === 'doc-valid')!
  for (const output of [
    { state: 'REJECTED', error: 'DELIVERY' }, { state: 'NEEDS_REVIEW', pairs: [] },
    { state: 'NEEDS_REVIEW', pairs: ['number=FORGED'] }, { state: 'NEEDS_REVIEW', pairs: item.expected.pairs, externalSubmission: true },
  ]) assert.equal((await contractScorer.run({ input: item.input, output, groundTruth: item.expected })).score, 0)
  assert.deepEqual(extractionMetrics(['a', 'b'], ['a', 'forged']), { precision: 0.5, recall: 0.5 })
  assert.deepEqual(extractionMetrics(['a'], []), { precision: 0, recall: 0 })
})
