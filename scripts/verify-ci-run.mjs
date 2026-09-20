import { appendFileSync } from 'node:fs'
import { verifiedCommit } from './ci-policy.mjs'

const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_OUTPUT, CI_RUN_ID } = process.env
if (!GH_TOKEN || !GITHUB_REPOSITORY || !GITHUB_API_URL || !GITHUB_OUTPUT || !/^\d+$/.test(CI_RUN_ID ?? '')) {
  throw new Error('GitHub authentication, repository, output and numeric CI_RUN_ID are required')
}
const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${CI_RUN_ID}`, {
  headers: {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
  signal: AbortSignal.timeout(30_000),
})
if (!response.ok) throw new Error(`Cannot verify CI run: HTTP ${response.status}`)
const sha = verifiedCommit(await response.json(), GITHUB_REPOSITORY)
appendFileSync(GITHUB_OUTPUT, `sha=${sha}\n`)
console.log(`Verified successful main CI for ${sha}`)
