import type { OutboxStatus } from '../../domain/shared/outbox.js'

export interface OutboxJobState {
  status: OutboxStatus
  updatedAt: string
}

/** Reconcilerが配送状態だけを参照するためのread-only Port。 */
export interface OutboxJobReader {
  get(tenantId: string, jobId: string): Promise<OutboxJobState | null>
}
