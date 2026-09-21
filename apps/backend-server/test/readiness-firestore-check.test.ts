import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Firestore } from '@google-cloud/firestore'
import { createFirestoreReadinessCheck } from '../src/infrastructure/firestore/readiness-check.js'
import { ReadinessService } from '../src/application/operations/readiness-service.js'

/**
 * SDK境界のFakeで検査ロジックを確認する。
 *
 * 実Firestore SDKは到達不能host相手でも内部retry/backoffのため報告まで
 * 数十秒かかり、単体試験に使うと遅くて不安定になる。実Emulatorに対する
 * 成功経路は test/firestore/readiness.test.ts（`pnpm test:firestore`）が確認する。
 */
describe('Firestore readiness (SDK境界のFake)', () => {
  it('listCollectionsが成功すればokになり、collection一覧は応答に含めない', async () => {
    const firestore = { listCollections: async () => [{ id: 'tenants' }] } as unknown as Firestore
    const result = await createFirestoreReadinessCheck(firestore).run()
    assert.deepEqual(result, { ok: true })
  })

  it('listCollectionsが失敗すれば ReadinessService 側で fail になり、接続情報を漏らさない', async () => {
    const firestore = {
      listCollections: async () => {
        throw new Error('5 NOT_FOUND: Database (default) is not found for project after-flow-broken')
      },
    } as unknown as Firestore
    const service = new ReadinessService([createFirestoreReadinessCheck(firestore)])
    const report = await service.evaluate()
    assert.equal(report.status, 'not_ready')
    assert.deepEqual(report.checks, [{ name: 'firestore', status: 'fail', reason: 'CHECK_FAILED' }])
    assert.ok(!JSON.stringify(report).includes('after-flow-broken'))
  })
})
