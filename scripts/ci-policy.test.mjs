import assert from 'node:assert/strict'
import { it } from 'node:test'
import { verifiedCommit } from './ci-policy.mjs'

const repository = 'example/after-flow'
const run = {
  path: '.github/workflows/ci.yml',
  event: 'push',
  head_branch: 'main',
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  status: 'completed',
  conclusion: 'success',
  head_sha: 'a'.repeat(40),
}

it('releases the tested commit rather than the latest main commit', () => {
  assert.equal(verifiedCommit(run, repository), run.head_sha)
})

for (const [field, value] of [
  ['path', '.github/workflows/other.yml'],
  ['event', 'pull_request'],
  ['event', 'workflow_dispatch'],
  ['head_branch', 'feature'],
  ['repository', { full_name: 'attacker/after-flow' }],
  ['head_repository', { full_name: 'attacker/after-flow' }],
  ['head_repository', null],
  ['status', 'in_progress'],
  ['conclusion', 'failure'],
  ['conclusion', 'cancelled'],
  ['conclusion', 'skipped'],
  ['head_sha', 'main'],
]) {
  it(`rejects untrusted CI metadata: ${field}=${JSON.stringify(value)}`, () => {
    assert.throws(() => verifiedCommit({ ...run, [field]: value }, repository))
  })
}
