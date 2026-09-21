import { existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const tests = readdirSync('src', { recursive: true })
  .filter((file) => /\.test\.(?:ts|tsx|mjs)$/.test(file))
  .sort()
  .map((file) => path.join('src', file))

if (tests.length === 0) throw new Error('No workspace tests found')

// tsx はテストファイルの直近の tsconfig.json（ここでは references のみの空ファイル）から辿るため、
// "@/*" 等の paths を持つ tsconfig（apps/web の tsconfig.app.json）を明示する。無ければ既定のまま。
const env = { ...process.env }
if (existsSync('tsconfig.app.json')) env.TSX_TSCONFIG_PATH = './tsconfig.app.json'

const result = spawnSync(process.execPath, ['--experimental-webstorage', '--import', 'tsx', '--test', ...tests], {
  stdio: 'inherit',
  env,
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
