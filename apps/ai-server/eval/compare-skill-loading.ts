import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { compareSkillLoadingReports } from './skill-loading-comparison.js'

const { values } = parseArgs({ options: {
  legacy: { type: 'string', default: resolve('../../reports/ai-eval-live-guidance-legacy-all.json') },
  staged: { type: 'string', default: resolve('../../reports/ai-eval-live-guidance.json') },
}, strict: true, allowPositionals: false })
const [legacy, staged] = await Promise.all([values.legacy, values.staged].map(async path => JSON.parse(await readFile(path, 'utf8'))))
console.log(JSON.stringify(compareSkillLoadingReports(legacy, staged), null, 2))
