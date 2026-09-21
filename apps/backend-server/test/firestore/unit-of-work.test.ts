import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { DocLocation } from '../../src/application/ports/persistence.js'
import { collections, INFRASTRUCTURE_COLLECTIONS } from '../../src/domain/shared/collections.js'
import type { EntityBase } from '../../src/domain/shared/entity.js'
import { AppError } from '../../src/shared/app-error.js'
import {
  describeFirestore,
  firestore,
  newId,
  newTenantId,
  unitOfWork,
  workContext,
} from './helpers/emulator.js'

/** 基盤の検証に使う最小の Entity。業務項目は各機能の Issue が定義する。 */
interface TestCase extends EntityBase {
  deceasedName: string
  status: 'ACTIVE' | 'CLOSED'
}

function caseLocation(id: string): DocLocation {
  return { collection: collections.cases, caseId: null, id }
}

function memberLocation(caseId: string, id: string): DocLocation {
  return { collection: collections.caseMembers, caseId, id }
}

async function errorFrom(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn()
  } catch (cause) {
    assert.ok(cause instanceof AppError, `AppError ではない: ${String(cause)}`)
    return cause
  }
  throw new Error('エラーが発生しなかった')
}

describeFirestore('UnitOfWork の原子性', () => {
  it('成功時は Entity・監査・Outbox がすべて保存される', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    const uow = unitOfWork()

    await uow.run(workContext(tenantId), async (tx) => {
      tx.create<TestCase>(caseLocation(caseId), {
        id: caseId,
        deceasedName: '架空 太郎',
        status: 'ACTIVE',
      })
      tx.audit({
        caseId,
        type: 'case.created',
        target: { collection: 'cases', id: caseId, version: 1 },
        detail: { municipality: '架空市' },
      })
      tx.outbox({ type: 'case.created', payload: { caseId }, caseId })
    })

    const saved = await firestore().doc(`tenants/${tenantId}/cases/${caseId}`).get()
    assert.equal(saved.exists, true)
    assert.equal(saved.get('version'), 1)
    assert.equal(saved.get('schemaVersion'), 1)
    assert.equal(saved.get('tenantId'), tenantId)
    assert.ok(saved.get('createdAt'), 'サーバー時刻が入る')

    const audits = await firestore().collection(`tenants/${tenantId}/cases/${caseId}/auditEvents`).get()
    assert.equal(audits.size, 1)
    assert.equal(audits.docs[0]?.get('type'), 'case.created')
    assert.equal(audits.docs[0]?.get('actor').userId, 'user-test-0001')

    const outbox = await firestore()
      .collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`)
      .get()
    assert.equal(outbox.size, 1)
    assert.equal(outbox.docs[0]?.get('status'), 'PENDING')
    assert.equal(outbox.docs[0]?.get('attempts'), 0)
  })

  it('例外時は Entity・監査・Outbox のいずれも保存されない', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    const uow = unitOfWork()

    await assert.rejects(
      uow.run(workContext(tenantId), async (tx) => {
        tx.create<TestCase>(caseLocation(caseId), { id: caseId, deceasedName: '架空 花子', status: 'ACTIVE' })
        tx.audit({ caseId, type: 'case.created', target: { collection: 'cases', id: caseId, version: 1 }, detail: {} })
        tx.outbox({ type: 'case.created', payload: { caseId }, caseId })
        throw new Error('業務ルール違反')
      }),
      /業務ルール違反/,
    )

    assert.equal((await firestore().doc(`tenants/${tenantId}/cases/${caseId}`).get()).exists, false)
    assert.equal(
      (await firestore().collection(`tenants/${tenantId}/cases/${caseId}/auditEvents`).get()).size,
      0,
    )
    assert.equal(
      (await firestore().collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`).get()).size,
      0,
    )
  })

  it('Transaction 内で監査だけが残ることはない', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    const uow = unitOfWork()

    // 存在しない文書の更新は書き込み適用時に失敗する。監査だけが残ってはいけない。
    await assert.rejects(
      uow.run(workContext(tenantId), async (tx) => {
        await tx.get<TestCase>(caseLocation(caseId))
        tx.audit({ caseId, type: 'case.updated', target: { collection: 'cases', id: caseId, version: 2 }, detail: {} })
        tx.create<TestCase>(caseLocation(caseId), { id: caseId, deceasedName: 'A', status: 'ACTIVE' })
        tx.create<TestCase>(caseLocation(caseId), { id: caseId, deceasedName: 'B', status: 'ACTIVE' })
      }),
    )
    assert.equal(
      (await firestore().collection(`tenants/${tenantId}/cases/${caseId}/auditEvents`).get()).size,
      0,
    )
  })
})

describeFirestore('版の検査', () => {
  it('正しい expectedVersion の更新は版を 1 つ進める', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    const uow = unitOfWork()

    await uow.run(workContext(tenantId), async (tx) => {
      tx.create<TestCase>(caseLocation(caseId), { id: caseId, deceasedName: '架空 太郎', status: 'ACTIVE' })
    })
    await uow.run(workContext(tenantId), async (tx) => {
      const current = await tx.require<TestCase>(caseLocation(caseId))
      tx.update<TestCase>(caseLocation(caseId), current.version, { deceasedName: '架空 次郎' })
    })

    const saved = await firestore().doc(`tenants/${tenantId}/cases/${caseId}`).get()
    assert.equal(saved.get('version'), 2)
    assert.equal(saved.get('deceasedName'), '架空 次郎')
  })

  it('古い版での更新は CONFLICT になり、先行更新を上書きしない', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    const uow = unitOfWork()

    await uow.run(workContext(tenantId), async (tx) => {
      tx.create<TestCase>(caseLocation(caseId), { id: caseId, deceasedName: '初期', status: 'ACTIVE' })
    })
    await uow.run(workContext(tenantId), async (tx) => {
      const current = await tx.require<TestCase>(caseLocation(caseId))
      tx.update<TestCase>(caseLocation(caseId), current.version, { deceasedName: '先行更新' })
    })

    const error = await errorFrom(() =>
      uow.run(workContext(tenantId), async (tx) => {
        await tx.require<TestCase>(caseLocation(caseId))
        // 取得時点より古い版を指定する
        tx.update<TestCase>(caseLocation(caseId), 1, { deceasedName: '後追い更新' })
      }),
    )
    assert.equal(error.code, 'CONFLICT')
    assert.equal(error.status, 409)

    const saved = await firestore().doc(`tenants/${tenantId}/cases/${caseId}`).get()
    assert.equal(saved.get('deceasedName'), '先行更新')
    assert.equal(saved.get('version'), 2)
  })

  it('読まずに更新しようとすると実装の誤りとして拒否する', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    const uow = unitOfWork()

    await uow.run(workContext(tenantId), async (tx) => {
      tx.create<TestCase>(caseLocation(caseId), { id: caseId, deceasedName: 'A', status: 'ACTIVE' })
    })
    const error = await errorFrom(() =>
      uow.run(workContext(tenantId), async (tx) => {
        tx.update<TestCase>(caseLocation(caseId), 1, { deceasedName: 'B' })
      }),
    )
    assert.equal(error.code, 'INTERNAL')
  })

  it('管理項目を patch で書き換えられない', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    const uow = unitOfWork()

    await uow.run(workContext(tenantId), async (tx) => {
      tx.create<TestCase>(caseLocation(caseId), { id: caseId, deceasedName: 'A', status: 'ACTIVE' })
    })
    const error = await errorFrom(() =>
      uow.run(workContext(tenantId), async (tx) => {
        const current = await tx.require<TestCase>(caseLocation(caseId))
        tx.update<TestCase>(caseLocation(caseId), current.version, {
          version: 99,
        } as never)
      }),
    )
    assert.equal(error.code, 'INTERNAL')
  })

  it('同じ ID の重複作成は CONFLICT になる', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    const uow = unitOfWork()

    await uow.run(workContext(tenantId), async (tx) => {
      tx.create<TestCase>(caseLocation(caseId), { id: caseId, deceasedName: 'A', status: 'ACTIVE' })
    })
    const error = await errorFrom(() =>
      uow.run(workContext(tenantId), async (tx) => {
        tx.create<TestCase>(caseLocation(caseId), { id: caseId, deceasedName: 'B', status: 'ACTIVE' })
      }),
    )
    assert.equal(error.code, 'CONFLICT')
  })
})

describeFirestore('冪等性', () => {
  const idempotency = { key: 'idem-create-case-1', fingerprint: 'fp-aaa' }

  it('同じキーと同じ内容の再送は重複を作らず前回の結果を返す', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    const uow = unitOfWork()
    const context = workContext(tenantId, { idempotency })

    const first = await uow.run(context, async (tx) => {
      tx.create<TestCase>(caseLocation(caseId), { id: caseId, deceasedName: 'A', status: 'ACTIVE' })
      tx.outbox({ type: 'case.created', payload: { caseId }, caseId })
      return { caseId, created: true }
    })

    const second = await uow.run(context, async () => {
      throw new Error('再送では本体を実行しない')
    })

    assert.deepEqual(second, first)
    const cases = await firestore().collection(`tenants/${tenantId}/cases`).get()
    assert.equal(cases.size, 1)
    const outbox = await firestore()
      .collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`)
      .get()
    assert.equal(outbox.size, 1, 'Outbox も二重に積まれない')
  })

  it('同じキーで内容が異なる要求は拒否する', async () => {
    const tenantId = newTenantId()
    const uow = unitOfWork()

    await uow.run(workContext(tenantId, { idempotency }), async (tx) => {
      const id = newId('case')
      tx.create<TestCase>(caseLocation(id), { id, deceasedName: 'A', status: 'ACTIVE' })
      return { id }
    })

    const error = await errorFrom(() =>
      uow.run(
        workContext(tenantId, { idempotency: { key: idempotency.key, fingerprint: 'fp-different' } }),
        async (tx) => {
          const id = newId('case')
          tx.create<TestCase>(caseLocation(id), { id, deceasedName: 'B', status: 'ACTIVE' })
          return { id }
        },
      ),
    )
    assert.equal(error.code, 'IDEMPOTENCY_KEY_REUSED')
    assert.equal(error.status, 409)
  })

  it('同じキーの並行要求でも作成は 1 件に収まる', async () => {
    const tenantId = newTenantId()
    const uow = unitOfWork()
    const context = workContext(tenantId, { idempotency })

    const attempts = [1, 2, 3, 4].map(() =>
      uow.run(context, async (tx) => {
        const id = newId('case')
        tx.create<TestCase>(caseLocation(id), { id, deceasedName: '並行', status: 'ACTIVE' })
        return { id }
      }),
    )
    const results = await Promise.all(attempts)

    const cases = await firestore().collection(`tenants/${tenantId}/cases`).get()
    assert.equal(cases.size, 1, '並行要求でも Case は 1 件')
    const ids = new Set(results.map((r) => r.id))
    assert.equal(ids.size, 1, 'すべての要求が同じ結果を受け取る')
    assert.equal(cases.docs[0]?.id, [...ids][0])
  })

  it('別の actor は同じキーでも互いの結果を受け取らない', async () => {
    const tenantId = newTenantId()
    const uow = unitOfWork()

    const a = await uow.run(
      workContext(tenantId, { idempotency, actor: { type: 'USER', userId: 'user-a', agentRunId: null } }),
      async (tx) => {
        const id = newId('case')
        tx.create<TestCase>(caseLocation(id), { id, deceasedName: 'A', status: 'ACTIVE' })
        return { id }
      },
    )
    const b = await uow.run(
      workContext(tenantId, { idempotency, actor: { type: 'USER', userId: 'user-b', agentRunId: null } }),
      async (tx) => {
        const id = newId('case')
        tx.create<TestCase>(caseLocation(id), { id, deceasedName: 'B', status: 'ACTIVE' })
        return { id }
      },
    )

    assert.notEqual(a.id, b.id)
    assert.equal((await firestore().collection(`tenants/${tenantId}/cases`).get()).size, 2)
  })
})

describeFirestore('tenant と Case の境界', () => {
  it('別 tenant からは取得できない', async () => {
    const tenantA = newTenantId()
    const tenantB = newTenantId()
    const caseId = newId('case')
    const uow = unitOfWork()

    await uow.run(workContext(tenantA), async (tx) => {
      tx.create<TestCase>(caseLocation(caseId), { id: caseId, deceasedName: 'A', status: 'ACTIVE' })
    })

    const found = await uow.run(workContext(tenantB), (tx) => tx.get<TestCase>(caseLocation(caseId)))
    assert.equal(found, null)
  })

  it('別 Case の ID へ差し替えても取得できない', async () => {
    const tenantId = newTenantId()
    const caseA = newId('case')
    const caseB = newId('case')
    const memberId = newId('member')
    const uow = unitOfWork()

    await uow.run(workContext(tenantId), async (tx) => {
      tx.create(memberLocation(caseA, memberId), { id: memberId, role: 'OWNER' } as never)
    })

    const found = await uow.run(workContext(tenantId), (tx) => tx.get(memberLocation(caseB, memberId)))
    assert.equal(found, null)
  })

  it('保存内容とパスが食い違う文書は読み出しで拒否する', async () => {
    const tenantId = newTenantId()
    const caseId = newId('case')
    const uow = unitOfWork()

    // 基盤を迂回して不整合な文書を作り、検出できることを確かめる。
    await firestore().doc(`tenants/${tenantId}/cases/${caseId}`).set({
      id: caseId,
      tenantId: 'another-tenant',
      caseId: null,
      version: 1,
      schemaVersion: 1,
      deceasedName: 'X',
      status: 'ACTIVE',
    })

    const error = await errorFrom(() =>
      uow.run(workContext(tenantId), (tx) => tx.get<TestCase>(caseLocation(caseId))),
    )
    assert.equal(error.code, 'INTERNAL')
    // 不整合の中身は応答に出さない。
    assert.equal(error.details, undefined)
  })

  it('パスに使えない識別子を拒否する', async () => {
    const tenantId = newTenantId()
    const uow = unitOfWork()
    for (const hostile of ['../other', 'a/b', '', '.']) {
      const error = await errorFrom(() =>
        uow.run(workContext(tenantId), (tx) => tx.get<TestCase>(caseLocation(hostile))),
      )
      assert.equal(error.code, 'VALIDATION_FAILED', `拒否されなかった: ${hostile}`)
    }
  })

  it('tenantId 自体の形式も検査する', async () => {
    const uow = unitOfWork()
    const error = await errorFrom(() => uow.run(workContext('../evil'), async () => null))
    assert.equal(error.code, 'VALIDATION_FAILED')
  })
})
