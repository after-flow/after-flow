import assert from 'node:assert/strict'
import { it } from 'node:test'
import { previousState } from './cloud-run-state.mjs'

const service = (traffic) => ({ status: { url: 'https://example.run.app', traffic } })
it('preserves split traffic using concrete revisions, excluding zero-traffic tags', () => {
  assert.deepEqual(previousState(service([
    { revisionName: 'backend-001', percent: 90 },
    { revisionName: 'backend-002', percent: 10, latestRevision: true },
    { revisionName: 'backend-003', tag: 'candidate' },
  ])), { url: 'https://example.run.app', traffic: 'backend-001=90,backend-002=10' })
})
it('refuses first deployments and incomplete or unresolved rollback targets', () => {
  for (const traffic of [
    [],
    [{ revisionName: 'backend-001', percent: 50 }],
    [{ latestRevision: true, percent: 100 }],
    [{ revisionName: 'LATEST', percent: 100 }],
  ]) {
    assert.throws(() => previousState(service(traffic)))
  }
})
