import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { PersonService } from '../../application/persons/person-service.js'
import { EstateService } from '../../application/estate/estate-service.js'
import { ContractService } from '../../application/contracts/contract-service.js'
import { InsightService } from '../../application/insights/insight-service.js'
import type { InsightViewStore, InsightResultLedger } from '../../application/insights/ports.js'
import type { CaseScopedRepository, IdempotencyStore, AuditLogPort } from '../../application/ports.js'
import type { ReadRepository, UnitOfWork, Tx, DocLocation, WorkContext } from '../../application/ports/persistence.js'
import type { AccessService } from '../../application/authorization/case-access.js'
import type { CaseEntity } from '../../domain/shared/types.js'
import type { EntityBase, EntityPatch } from '../../domain/shared/entity.js'
import { collections, type CollectionDescriptor } from '../../domain/shared/collections.js'
import type { Person, Relationship } from '../../domain/person/person.js'
import type { Asset, Liability } from '../../domain/estate/estate-item.js'
import type { Contract, Benefit } from '../../domain/contract/contract.js'
import type { Insight, InsightView } from '../../domain/insight/insight.js'
import type { AgentRunEntity } from '../../domain/agent/agent-run.js'
import type { DocumentEntity } from '../../domain/document/document.js'
import type { TaskEntity } from '../../domain/task/task.js'
import { errors } from '../../shared/app-error.js'
import { fingerprintOf } from '../../shared/fingerprint.js'

/**
 * Application のポートを共通 Firestore UnitOfWork に束ねる。
 * 非同期コンテキストは要求ごと／Transaction の再試行ごとに分離する。
 * 変更・監査・結果の冪等性はすべて同じ commit。外部 I/O は行わない。
 */
export function createBusinessServices(access: AccessService, read: ReadRepository, uow: UnitOfWork) {
  const work = new AsyncLocalStorage<{ tx: Tx; context: WorkContext; caseId: string }>()
  function transaction() {
    const active = work.getStore()
    if (!active) throw errors.internal({ internal: { reason: 'write outside UnitOfWork' } })
    return active
  }
  async function get<T extends EntityBase>(tenantId: string, location: DocLocation): Promise<T | null> {
    const active = work.getStore()
    if (active) {
      if (active.context.tenantId !== tenantId || location.caseId !== active.caseId) throw errors.notFound()
      return active.tx.get<T>(location)
    }
    return read.get<T>(tenantId, location)
  }
  function repository<T extends CaseEntity>(collection: CollectionDescriptor, excludable = false): CaseScopedRepository<T> {
    return {
      findById: (tenantId, caseId, id) => get<T & EntityBase>(tenantId, { collection, caseId, id }),
      async list(tenantId, caseId, query) {
        const page = await read.list<T & EntityBase>(tenantId, collection, caseId, {
          limit: query.limit,
          cursor: query.cursor ?? undefined,
          ...(excludable && !query.includeExcluded ? { where: [{ field: 'excludedAt', op: '==' as const, value: null }] } : {}),
        })
        return { items: page.items, nextCursor: page.nextCursor ?? null }
      },
      async save(entity) {
        const { tx, context, caseId } = transaction()
        if (entity.tenantId !== context.tenantId || entity.caseId !== caseId) throw errors.notFound()
        const location = { collection, caseId, id: entity.id }
        // 保存基盤が持つ版・時刻・所属は上書きしない。
        const { id, tenantId: _tenant, caseId: _case, version, createdAt: _created, updatedAt: _updated, ...data } = entity
        delete (data as { schemaVersion?: number }).schemaVersion
        if (version === 1) {
          tx.create<T & EntityBase>(location, { ...data, id } as Omit<T & EntityBase, keyof EntityBase> & { id: string })
        } else {
          tx.update<T & EntityBase>(location, version - 1, data as EntityPatch<T & EntityBase>)
        }
      },
    }
  }
  const idempotency: IdempotencyStore = {
    async run(ctx, operation, input, execute) {
      if (!ctx.idempotencyKey) throw errors.preconditionRequired()
      const permission = await access.authorizeCase(ctx.principal, ctx.caseId,
        operation.startsWith('insights.') ? 'case.read' : 'case.write')
      const context = permission.toWorkContext(ctx.requestId, {
        key: ctx.idempotencyKey,
        fingerprint: fingerprintOf({ caseId: ctx.caseId, operation, input }),
      })
      return uow.run(context, tx => work.run({ tx, context, caseId: ctx.caseId }, execute))
    },
  }
  const audit: AuditLogPort = {
    async append(entry) {
      const { tx, caseId } = transaction()
      tx.audit({
        caseId, type: entry.action,
        target: { collection: entry.targetType, id: entry.targetId, version: null },
        detail: (entry.detail ?? {}) as Record<string, unknown>,
      })
    },
  }
  const shared = {
    idempotency, audit,
    memberships: {
      async findMembership(tenantId: string, caseId: string, userId: string) {
        const allowed = await access.authorizeCase({ tenantId, userId }, caseId, 'case.read')
        return { tenantId, caseId, userId, role: allowed.role }
      },
    },
    clock: { now: () => new Date().toISOString() },
    ids: { next: (prefix: string) => prefix + '_' + randomUUID() },
  }
  const viewLocation = (caseId: string, insightId: string, actorId: string) => ({
    collection: collections.insightViews, caseId, id: fingerprintOf({ insightId, actorId }),
  })
  const views: InsightViewStore = {
    find: (tenantId, caseId, insightId, actorId) => get<InsightView & EntityBase>(tenantId, viewLocation(caseId, insightId, actorId)),
    async findMany(tenantId, caseId, actorId, insightIds) {
      const result = new Map<string, InsightView>()
      await Promise.all(insightIds.map(async id => {
        const view = await views.find(tenantId, caseId, id, actorId)
        if (view) result.set(id, view)
      }))
      return result
    },
    async save(view) {
      const { tx } = transaction()
      const location = viewLocation(view.caseId, view.insightId, view.actorId)
      const current = await tx.get<EntityBase>(location)
      const data = { insightId: view.insightId, actorId: view.actorId, status: view.status, note: view.note }
      if (current) tx.update<InsightView & EntityBase>(location, current.version, data)
      else tx.create<InsightView & EntityBase>(location, { id: location.id, ...data })
    },
  }
  function resultLocation(runId: string, resultId: string) {
    return { collection: collections.insightResults, caseId: transaction().caseId, id: fingerprintOf({ runId, resultId }) }
  }
  const ledger: InsightResultLedger = {
    async has(tenantId, runId, resultId) { return !!await get(tenantId, resultLocation(runId, resultId)) },
    async record(_tenantId, runId, resultId, insightId) {
      const location = resultLocation(runId, resultId)
      transaction().tx.create<EntityBase & { insightId: string }>(location, { id: location.id, insightId })
    },
  }
  const insightService = new InsightService({
    ...shared, insights: repository<Insight>(collections.insights), views, ledger,
    caseVersion: async (tenantId, caseId) => (await get<import('../../domain/case/case.js').CaseEntity>(tenantId, { collection: collections.cases, caseId: null, id: caseId }))?.caseVersion ?? null,
    runs: {
      async findRun(tenantId, caseId, runId) {
        const run = await get<AgentRunEntity>(tenantId, { collection: collections.agentRuns, caseId, id: runId })
        return run?.caseId ? { tenantId: run.tenantId, caseId: run.caseId, runId, status: run.status, currentAttemptId: run.currentAttemptId } : null
      },
    },
    evidence: {
      async resolveDocument(tenantId, caseId, id) {
        const doc = await get<DocumentEntity>(tenantId, { collection: collections.documents, caseId, id })
        return doc ? { version: doc.version, archived: doc.archivedAt !== null || doc.storageState !== 'STORED' } : null
      },
      async resolveTask(tenantId, caseId, id) {
        const task = await get<TaskEntity>(tenantId, { collection: collections.tasks, caseId, id })
        return task ? { version: task.version, archived: false } : null
      },
    },
    async receive(tenantId, caseId, runId, execute) {
      const context: WorkContext = { tenantId, actor: { type: 'AI', userId: null, agentRunId: runId }, requestId: null }
      return uow.run(context, tx => work.run({ tx, context, caseId }, execute))
    },
  })
  return {
    personService: new PersonService({
      ...shared, persons: repository<Person>(collections.persons, true), relationships: repository<Relationship>(collections.relationships, true),
      references: {
        async countReferences(tenantId, caseId, personId) {
          // Decision の ID は Person の ID。除外と Decision 記録の競合も tx.get で検出する。
          const decision = await get(tenantId, { collection: collections.decisions, caseId, id: personId })
          return { inheritanceDecisions: decision ? 1 : 0, evidences: 0, auditEntries: 0 }
        },
      },
    }),
    estateService: new EstateService({ ...shared, assets: repository<Asset>(collections.assets), liabilities: repository<Liability>(collections.liabilities) }),
    contractService: new ContractService({ ...shared, contracts: repository<Contract>(collections.contracts), benefits: repository<Benefit>(collections.benefits) }),
    insightService,
  }
}
