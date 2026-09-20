import type { ExecutionSnapshotStatus } from '@aftercare/internal-contracts'

/** Snapshotの本文は受け取らず、AI所有の永続化状態だけを内部HTTPで照合する。 */
export interface ExecutionSnapshots {
  status(input: { runId: string; jobId: string; executionAttempt: string; waitRequestId: string | null }): Promise<ExecutionSnapshotStatus>
}
