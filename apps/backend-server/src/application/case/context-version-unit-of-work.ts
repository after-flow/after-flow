import type { CaseEntity } from '../../domain/case/case.js'
import { collections } from '../../domain/shared/collections.js'
import type { CollectionDescriptor } from '../../domain/shared/collections.js'
import type { EntityPatch } from '../../domain/shared/entity.js'
import { errors } from '../../shared/app-error.js'
import type { DocLocation, Tx, UnitOfWork, WorkContext } from '../ports/persistence.js'

/** AI の前提になる業務事実。Proposal / Approval / 実行状態は含めない。 */
const CONTEXT_COLLECTIONS = new Set<CollectionDescriptor>([
  collections.caseMembers, collections.persons, collections.relationships,
  collections.documents, collections.tasks, collections.deadlines, collections.evidence,
  collections.assets, collections.liabilities, collections.contracts, collections.benefits,
  collections.decisions, collections.messages,
])

/**
 * 業務状態の変更と Context の版を同一 transaction に束ねる Application policy。
 * 1 transaction / Case につき一度だけ進める。Firestore の再試行・冪等再送でも
 * 余分に増えない。HTTP と独立 worker は必ずこの UnitOfWork を共有する。
 */
export class ContextVersionUnitOfWork implements UnitOfWork {
  constructor(private readonly storage: UnitOfWork) {}

  run<T>(context: WorkContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.storage.run(context, async tx => {
      const changed = new Set<string>()
      const created = new Set<string>()
      const caseUpdates = new Map<string, { expectedVersion: number; patch: EntityPatch<CaseEntity> }>()
      const track = (location: DocLocation) => {
        if (location.caseId && CONTEXT_COLLECTIONS.has(location.collection)) changed.add(location.caseId)
      }
      const assertMutable = (location: DocLocation) => {
        if (location.collection === collections.proposalVersions) {
          throw errors.internal({ internal: { reason: 'proposal versions are append-only' } })
        }
      }
      const wrapped: Tx = {
        get: location => tx.get(location), require: location => tx.require(location),
        audit: event => tx.audit(event), outbox: event => tx.outbox(event),
        create: (location, data) => {
          track(location)
          if (location.collection === collections.cases) created.add(location.id)
          tx.create(location, data)
        },
        update: (location, expectedVersion, patch) => {
          assertMutable(location)
          const keys = Object.keys(patch)
          const runtimeOnly = keys.length > 0 && (
            (location.collection === collections.messages && keys.every(key => key === 'replyRunId'))
            || (location.collection === collections.documents && keys.every(key => key === 'analysisState' || key === 'agentRunId'))
          )
          // 実行へのリンクや解析進捗だけで、受付済みRun自身をstaleにしない。
          if (!runtimeOnly) track(location)
          if (location.collection === collections.cases) {
            if (caseUpdates.has(location.id)) throw errors.internal({ internal: { reason: 'multiple Case updates in one command' } })
            changed.add(location.id)
            caseUpdates.set(location.id, { expectedVersion, patch: patch as EntityPatch<CaseEntity> })
          } else tx.update(location, expectedVersion, patch)
        },
        delete: (location, expectedVersion) => {
          assertMutable(location)
          if (location.collection === collections.cases) throw errors.internal({ internal: { reason: 'Case physical deletion is not supported' } })
          track(location)
          tx.delete(location, expectedVersion)
        },
      }
      const result = await fn(wrapped)
      for (const caseId of changed) {
        if (created.has(caseId)) continue
        const location = { collection: collections.cases, caseId: null, id: caseId }
        const current = await tx.require<CaseEntity>(location)
        if (!Number.isSafeInteger(current.caseVersion) || current.caseVersion < 1) {
          throw errors.internal({ internal: { reason: 'invalid Case context version', caseId } })
        }
        const update = caseUpdates.get(caseId)
        tx.update<CaseEntity>(location, update?.expectedVersion ?? current.version, {
          ...update?.patch, caseVersion: current.caseVersion + 1,
        })
        tx.audit({ caseId, type: 'case.context_changed',
          target: { collection: collections.cases.name, id: caseId, version: current.version + 1 },
          detail: { from: current.caseVersion, to: current.caseVersion + 1 } })
      }
      return result
    })
  }
}
