import { spawnSync } from 'node:child_process'

/**
 * APIキー不要のfixture評価をまとめて実行する（CIの `pnpm eval:ai [development|holdout]`）。
 * 既存の基盤評価と、task_guidanceの評価（#164）を同じsplitで実行し、どちらかが未達なら非ゼロで終了する。
 */
const split = process.argv[2] ?? 'development'
if (!['development', 'holdout'].includes(split) || process.argv.length > 3) {
  console.error('Usage: eval/all.ts [development|holdout]')
  process.exit(2)
}
const runs = [['eval/run.ts', split], ['eval/guidance/run.ts', '--split', split]]
let failed = false
for (const args of runs) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', ...args], { stdio: 'inherit' })
  if (result.status !== 0) failed = true
}
process.exitCode = failed ? 1 : 0
