import assert from 'node:assert/strict'
import { it } from 'node:test'
import { collections } from '../../src/domain/shared/collections.js'
import type { EntityBase } from '../../src/domain/shared/entity.js'
import { AppError } from '../../src/shared/app-error.js'
import {
  describeFirestore,
  newId,
  newTenantId,
  readRepository,
  unitOfWork,
  workContext,
} from './helpers/emulator.js'

interface TestCase extends EntityBase {
  deceasedName: string
  status: 'ACTIVE' | 'CLOSED'
}

async function seedCases(tenantId: string, count: number): Promise<string[]> {
  const uow = unitOfWork()
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const id = newId('case')
    ids.push(id)
    // updatedAt がサーバー時刻なので、1 件ずつ別の Transaction で作る。
    await uow.run(workContext(tenantId), async (tx) => {
      tx.create<TestCase>(
        { collection: collections.cases, caseId: null, id },
        { id, deceasedName: `架空 ${index}`, status: 'ACTIVE' },
      )
    })
  }
  return ids
}

describeFirestore('カーソルページング', () => {
  it('ページをまたいでも欠落と重複が起きない', async () => {
    const tenantId = newTenantId()
    const seeded = await seedCases(tenantId, 7)
    const repository = readRepository()

    const collected: string[] = []
    let cursor: string | undefined
    let pages = 0

    do {
      const page = await repository.list<TestCase>(tenantId, collections.cases, null, {
        limit: 3,
        cursor,
      })
      collected.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
      pages += 1
      assert.ok(pages <= 5, 'ページングが終わらない')
    } while (cursor)

    assert.equal(collected.length, seeded.length)
    assert.equal(new Set(collected).size, seeded.length, '重複が無い')
    assert.deepEqual([...collected].sort(), [...seeded].sort(), '欠落が無い')
  })

  it('最終ページでは nextCursor を返さない', async () => {
    const tenantId = newTenantId()
    await seedCases(tenantId, 2)
    const page = await readRepository().list<TestCase>(tenantId, collections.cases, null, { limit: 10 })
    assert.equal(page.items.length, 2)
    assert.equal(page.nextCursor, undefined)
  })

  it('ちょうど limit 件のときも続きがなければ nextCursor を返さない', async () => {
    const tenantId = newTenantId()
    await seedCases(tenantId, 3)
    const page = await readRepository().list<TestCase>(tenantId, collections.cases, null, { limit: 3 })
    assert.equal(page.items.length, 3)
    assert.equal(page.nextCursor, undefined)
  })

  it('条件が異なる一覧へカーソルを持ち込めない', async () => {
    const tenantId = newTenantId()
    await seedCases(tenantId, 5)
    const repository = readRepository()

    const page = await repository.list<TestCase>(tenantId, collections.cases, null, { limit: 2 })
    assert.ok(page.nextCursor)

    await assert.rejects(
      repository.list<TestCase>(tenantId, collections.cases, null, {
        limit: 2,
        cursor: page.nextCursor,
        orderBy: { field: 'createdAt', direction: 'asc' },
      }),
      (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_FAILED',
    )
  })

  it('壊れたカーソルを拒否する', async () => {
    const tenantId = newTenantId()
    await seedCases(tenantId, 1)
    await assert.rejects(
      readRepository().list<TestCase>(tenantId, collections.cases, null, {
        limit: 2,
        cursor: 'bm90LWEtY3Vyc29y',
      }),
      (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_FAILED',
    )
  })

  it('別 tenant のデータは混ざらない', async () => {
    const tenantA = newTenantId()
    const tenantB = newTenantId()
    await seedCases(tenantA, 3)
    await seedCases(tenantB, 2)

    const page = await readRepository().list<TestCase>(tenantA, collections.cases, null, { limit: 50 })
    assert.equal(page.items.length, 3)
    assert.ok(page.items.every((item) => item.tenantId === tenantA))
  })

  it('Transaction の外の取得でも別 tenant を跨げない', async () => {
    const tenantA = newTenantId()
    const tenantB = newTenantId()
    const [caseId] = await seedCases(tenantA, 1)
    assert.ok(caseId)

    const repository = readRepository()
    assert.ok(await repository.get<TestCase>(tenantA, { collection: collections.cases, caseId: null, id: caseId }))
    assert.equal(
      await repository.get<TestCase>(tenantB, { collection: collections.cases, caseId: null, id: caseId }),
      null,
    )
  })
})
