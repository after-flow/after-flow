import { readFile } from 'node:fs/promises'
import { reconcileOrcaCosts } from '../src/infrastructure/orcarouter/cost-reconciliation.js'

function pathAfter(flag: string): string {
  const index = process.argv.indexOf(flag)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Usage: pnpm reconcile:orca-cost --metrics <safe-metrics.json> --confirmed <confirmed-costs.json>`)
  return value
}

const metrics = JSON.parse(await readFile(pathAfter('--metrics'), 'utf8'))
const confirmed = JSON.parse(await readFile(pathAfter('--confirmed'), 'utf8'))
const report = reconcileOrcaCosts(metrics, confirmed)
console.log(JSON.stringify(report, null, 2))
if (report.missingConfirmedRequestIds.length || report.unknownConfirmedRequestIds.length) process.exitCode = 1
