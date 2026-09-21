import { execFileSync } from 'node:child_process'

/**
 * 評価レポートに記録するコミット。
 * 開発用Dockerイメージにはgitも.gitも無いため、GIT_COMMITが無ければnullにして評価は続ける。
 */
export function sourceRevision(env: NodeJS.ProcessEnv = process.env): { commit: string | null; dirtyWorktree: boolean | null } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0
    return { commit, dirtyWorktree: dirty }
  } catch {
    const commit = env.GIT_COMMIT?.trim()
    return { commit: commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit : null, dirtyWorktree: null }
  }
}
