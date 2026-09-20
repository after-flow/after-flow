import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function previousState(service) {
  const url = new URL(service.status.url)
  assert.equal(url.protocol, 'https:')
  const allocations = (service.status.traffic ?? []).filter((entry) => entry.percent > 0)
  assert.equal(allocations.reduce((total, entry) => total + entry.percent, 0), 100, 'Existing traffic must total 100%')
  for (const entry of allocations) {
    assert.match(entry.revisionName, /^[a-z][a-z0-9-]+$/)
    assert.ok(Number.isInteger(entry.percent))
  }
  return {
    url: url.origin,
    traffic: allocations.map((entry) => `${entry.revisionName}=${entry.percent}`).join(','),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const state = previousState(JSON.parse(readFileSync(process.argv[2], 'utf8')))
  console.log(`url=${state.url}\ntraffic=${state.traffic}`)
}
