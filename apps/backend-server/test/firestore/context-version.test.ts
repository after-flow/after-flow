import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ContextVersionUnitOfWork } from '../../src/application/case/context-version-unit-of-work.js'
import type { CaseEntity } from '../../src/domain/case/case.js'
import { collections } from '../../src/domain/shared/collections.js'
import type { EntityBase } from '../../src/domain/shared/entity.js'
import { describeFirestore, newTenantId, readRepository, unitOfWork, workContext } from './helpers/emulator.js'

describeFirestore('Case Context version policy', () => {
  const business = [collections.caseMembers, collections.persons, collections.relationships,
    collections.documents, collections.tasks, collections.deadlines, collections.evidence,
    collections.assets, collections.liabilities, collections.contracts, collections.benefits,
    collections.decisions, collections.messages]
  async function setup() {
    const tenantId = newTenantId()
    const context = workContext(tenantId)
    const uow = new ContextVersionUnitOfWork(unitOfWork())
    const location = { collection: collections.cases, caseId: null, id: 'case-context' }
    await unitOfWork().run(context, async tx => {
      tx.create<CaseEntity>(location, { id: location.id, deceasedName: '架空', deceasedNameKana: null,
        dateOfDeath: '2026-01-01', dateOfBirth: null, knownAt: null, ownerName: '架空',
        relationshipToDeceased: '家族', municipality: null, status: 'ACTIVE', caseVersion: 1 })
    })
    const readCase = async () => (await readRepository().get<CaseEntity>(tenantId, location))!
    return { tenantId, context, uow, location, readCase }
  }
  for (const collection of business) {
    it(`${collection.name}: 作成・更新・削除ごとに案件版も原子的に進む`, async () => {
      const { context, uow, location, readCase } = await setup()
      const child = { collection, caseId: location.id, id: 'fact' }
      await uow.run(context, async tx => { tx.create<EntityBase>(child, { id: child.id }) })
      assert.equal((await readCase()).caseVersion, 2)
      await uow.run(context, async tx => {
        const entity = await tx.require(child)
        tx.update(child, entity.version, {})
      })
      assert.equal((await readCase()).caseVersion, 3)
      await uow.run(context, async tx => {
        const entity = await tx.require(child)
        tx.delete(child, entity.version)
      })
      assert.equal((await readCase()).caseVersion, 4)
      assert.equal((await readCase()).version, 4)
    })
  }
  it('提案・承認・実行進捗・lease は案件版を進めない', async () => {
    const { context, uow, location, readCase } = await setup()
    await uow.run(context, async tx => {
      for (const collection of [collections.proposals, collections.proposalVersions, collections.approvals,
        collections.agentRuns, collections.caseLeases, collections.guidance]) {
        tx.create<EntityBase>({ collection, caseId: location.id, id: 'record' }, { id: 'record' })
      }
    })
    assert.equal((await readCase()).caseVersion, 1)
  })
  it('同一transactionの複数Entity・Case変更は一度だけ、冪等再送は増分なし', async () => {
    const { context, uow, location, readCase } = await setup()
    const idem = { ...context, idempotency: { key: 'same-command', fingerprint: 'same-body' } }
    const command = () => uow.run(idem, async tx => {
      const current = await tx.require<CaseEntity>(location)
      tx.update<CaseEntity>(location, current.version, { ownerName: '訂正' })
      for (const id of ['one', 'two']) tx.create<EntityBase>({ collection: collections.tasks, caseId: location.id, id }, { id })
      return 'ok'
    })
    assert.deepEqual(await Promise.all([command(), command()]), ['ok', 'ok'])
    assert.equal((await readCase()).caseVersion, 2)
    assert.equal((await readCase()).ownerName, '訂正')
  })
  it('並行する異なる業務変更は両方の案件版が進み、失敗した書込は増やさない', async () => {
    const { context, uow, location, readCase } = await setup()
    await Promise.all(['one', 'two'].map(id => uow.run(context, async tx => {
      tx.create<EntityBase>({ collection: collections.tasks, caseId: location.id, id }, { id })
    })))
    assert.equal((await readCase()).caseVersion, 3)
    await assert.rejects(uow.run(context, async tx => {
      tx.create<EntityBase>({ collection: collections.tasks, caseId: location.id, id: 'one' }, { id: 'one' })
    }))
    assert.equal((await readCase()).caseVersion, 3)
  })
  it('Proposal履歴の更新・削除を禁止する', async () => {
    const { context, uow, location } = await setup()
    const snapshot = { collection: collections.proposalVersions, caseId: location.id, id: 'immutable' }
    await uow.run(context, async tx => { tx.create<EntityBase>(snapshot, { id: snapshot.id }) })
    for (const kind of ['update', 'delete']) {
      await assert.rejects(uow.run(context, async tx => {
        const current = await tx.require(snapshot)
        if (kind === 'update') tx.update(snapshot, current.version, {})
        else tx.delete(snapshot, current.version)
      }))
    }
  })
})
