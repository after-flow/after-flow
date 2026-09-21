import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  notConfiguredCheck,
  objectStorageReadinessCheck,
  ReadinessService,
  syncCheck,
} from '../src/application/operations/readiness-service.js'
import type { ObjectStorage } from '../src/application/ports/object-storage.js'

const okCheck = (name: string) => syncCheck(name, () => ({ ok: true }))

describe('ReadinessService', () => {
  it('全ての検査が ok なら ready を返す', async () => {
    const service = new ReadinessService([okCheck('a'), okCheck('b')])
    const report = await service.evaluate()
    assert.equal(report.status, 'ready')
    assert.deepEqual(report.checks, [
      { name: 'a', status: 'ok' },
      { name: 'b', status: 'ok' },
    ])
    assert.ok(report.checkedAt)
  })

  it('1つでも失敗すれば not_ready を返し、理由コードを含める', async () => {
    const service = new ReadinessService([
      okCheck('a'),
      syncCheck('b', () => ({ ok: false, reason: 'PLACEHOLDER_CATALOG' })),
    ])
    const report = await service.evaluate()
    assert.equal(report.status, 'not_ready')
    assert.deepEqual(report.checks, [
      { name: 'a', status: 'ok' },
      { name: 'b', status: 'fail', reason: 'PLACEHOLDER_CATALOG' },
    ])
  })

  it('未設定の依存は notConfiguredCheck で not_ready として報告する', async () => {
    const service = new ReadinessService([notConfiguredCheck('storage')])
    const report = await service.evaluate()
    assert.equal(report.status, 'not_ready')
    assert.deepEqual(report.checks, [{ name: 'storage', status: 'fail', reason: 'NOT_CONFIGURED' }])
  })

  it('例外を投げる検査は固定の理由コードへ丸め、message/causeを漏らさない', async () => {
    const service = new ReadinessService([
      {
        name: 'leaky',
        run: async () => {
          throw new Error('postgres://user:hunter2@internal-host/db')
        },
      },
    ])
    const report = await service.evaluate()
    assert.equal(report.status, 'not_ready')
    assert.equal(report.checks[0]?.status, 'fail')
    assert.equal(report.checks[0]?.reason, 'CHECK_FAILED')
    assert.equal(JSON.stringify(report).includes('hunter2'), false)
  })

  it('待ち時間を超えた検査は CHECK_TIMEOUT として打ち切る', async () => {
    const service = new ReadinessService(
      [{ name: 'slow', run: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 50)) }],
      5,
    )
    const report = await service.evaluate()
    assert.equal(report.status, 'not_ready')
    assert.equal(report.checks[0]?.reason, 'CHECK_TIMEOUT')
  })

  it('検査は並行して実行する', async () => {
    const started: string[] = []
    const service = new ReadinessService([
      { name: 'a', run: async () => { started.push('a'); await new Promise((r) => setTimeout(r, 10)); return { ok: true } } },
      { name: 'b', run: async () => { started.push('b'); return { ok: true } } },
    ])
    await service.evaluate()
    assert.deepEqual(started.sort(), ['a', 'b'])
  })
})

describe('objectStorageReadinessCheck', () => {
  it('exists が成功すれば ok', async () => {
    const storage: ObjectStorage = {
      put: async () => {},
      get: async () => null,
      delete: async () => {},
      exists: async () => false,
    }
    const result = await objectStorageReadinessCheck('storage', storage).run()
    assert.deepEqual(result, { ok: true })
  })

  it('exists が例外を投げれば ReadinessService 側で fail になる', async () => {
    const storage: ObjectStorage = {
      put: async () => {},
      get: async () => null,
      delete: async () => {},
      exists: async () => { throw new Error('ECONNREFUSED') },
    }
    const service = new ReadinessService([objectStorageReadinessCheck('storage', storage)])
    const report = await service.evaluate()
    assert.equal(report.status, 'not_ready')
    assert.equal(report.checks[0]?.reason, 'CHECK_FAILED')
  })

  it('書き込み・削除を行わない', async () => {
    let wrote = false
    const storage: ObjectStorage = {
      put: async () => { wrote = true },
      get: async () => null,
      delete: async () => { wrote = true },
      exists: async () => false,
    }
    await objectStorageReadinessCheck('storage', storage).run()
    assert.equal(wrote, false)
  })
})
