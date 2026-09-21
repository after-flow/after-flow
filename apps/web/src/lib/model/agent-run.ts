import type { AgentRunResource } from '@aftercare/public-contracts'

/** 「いま動いている」とみなす状態。待機系も含む（待機は失敗ではない）。 */
export function agentRunIsActive(run: AgentRunResource): boolean {
  return (
    run.status === 'QUEUED' ||
    run.status === 'RUNNING' ||
    run.status === 'WAITING_DOCUMENT' ||
    run.status === 'WAITING_APPROVAL' ||
    run.status === 'RETRY_SCHEDULED'
  )
}
