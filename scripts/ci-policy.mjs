export function verifiedCommit(run, repository) {
  if (
    run.path !== '.github/workflows/ci.yml'
    || run.event !== 'push'
    || run.head_branch !== 'main'
    || run.repository?.full_name !== repository
    || run.head_repository?.full_name !== repository
    || run.status !== 'completed'
    || run.conclusion !== 'success'
    || !/^[a-f0-9]{40}$/.test(run.head_sha ?? '')
  ) {
    throw new Error('Only a successful main push from this repository CI may be released')
  }
  return run.head_sha
}
