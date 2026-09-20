import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const tests = readdirSync('src', { recursive: true })
  .filter((file) => /\.test\.(?:ts|tsx|mjs)$/.test(file))
  .sort()
  .map((file) => path.join('src', file))

if (tests.length === 0) throw new Error('No workspace tests found')
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
