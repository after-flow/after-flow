import type { Firestore } from '@google-cloud/firestore'
import type { OutboxJobReader, OutboxJobState } from '../../application/ports/outbox-jobs.js'
import { INFRASTRUCTURE_COLLECTIONS } from '../../domain/shared/collections.js'
import type { OutboxEvent } from '../../domain/shared/outbox.js'
import { fromFirestoreDocument } from './client.js'
import { assertValidId, infrastructurePath } from './paths.js'

export class FirestoreOutboxJobReader implements OutboxJobReader {
  constructor(private readonly firestore: Firestore) {}

  async get(tenantId: string, jobId: string): Promise<OutboxJobState | null> {
    assertValidId(tenantId, 'tenantId')
    assertValidId(jobId, 'jobId')
    const snapshot = await this.firestore
      .doc(infrastructurePath(tenantId, INFRASTRUCTURE_COLLECTIONS.outbox, jobId))
      .get()
    if (!snapshot.exists) return null
    const event = fromFirestoreDocument<OutboxEvent>(snapshot.data() as Record<string, unknown>)
    return { status: event.status, updatedAt: event.updatedAt }
  }
}
