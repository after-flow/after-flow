import type { WaitCondition } from '@aftercare/internal-contracts'
import type { EntityBase } from '../shared/entity.js'

export interface WaitRequestEntity extends EntityBase {
  runId: string
  jobId: string
  executionAttempt: string
  fencingToken: number
  condition: WaitCondition
  state: 'PENDING_SNAPSHOT' | 'WAITING' | 'RESUME_QUEUED' | 'RESUMED' | 'CANCELLED'
  snapshotId: string | null
  resumeJobId: string | null
  inboxId: string | null
}

export interface RunInboxEntity extends EntityBase {
  /** 業務OutboxのID。先行イベントも待機要求ができるまで保持する。 */
  eventId: string
  type: 'proposal.applied' | 'approval.rejected' | 'document.registered'
  targetId: string
  payloadHash: string
  /** 消費の記録はWaitRequest.inboxId。イベントに無制限のconsumer配列を持たせない。 */
}
