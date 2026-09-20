import type { ExecutionSnapshotStatus, RunDispatch } from '@aftercare/internal-contracts'

/**
 * Worker boundary. ACCEPTED requires verified Backend capability and a durable receipt.
 * The receiver must reject changed job/run/attempt/operation and obsolete attempts.
 * No in-memory implementation is supplied by production composition.
 */
export interface ExecutionRuntime {
  accept(dispatch: RunDispatch, kind: 'dispatch' | 'resume'): Promise<'ACCEPTED' | 'DUPLICATE'>
  snapshot(input: {
    runId: string; jobId: string; executionAttempt: string; waitRequestId: string | null
  }): Promise<ExecutionSnapshotStatus>
}
