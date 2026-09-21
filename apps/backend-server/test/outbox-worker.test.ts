import assert from 'node:assert/strict'
import { it } from 'node:test'
import { runOutboxWorker } from '../src/application/agent/outbox-worker.js'

it('Outbox workerはバッチを重ねず定期実行し、停止指示で終了する', async () => {
  const controller = new AbortController()
  let ticks = 0
  let processing = false
  await runOutboxWorker({
    async dispatchBatch() {
      assert.equal(processing, false)
      processing = true
      ticks++
      return { delivered: [], retrying: [], rejected: [], blocked: [] }
    },
    async backlog() {
      assert.equal(processing, true)
      processing = false
      if (ticks === 3) controller.abort()
      return { pending: 0, failed: 0, oldestAgeMs: 0 }
    },
  }, { tenantIds: ['fixture-tenant'], intervalMs: 1, signal: controller.signal })
  assert.equal(ticks, 3)
  assert.equal(processing, false)
})

it('常駐workerは一時的なtick失敗後も次周期で再試行する', async () => {
  const controller = new AbortController()
  let ticks = 0
  await runOutboxWorker({
    async dispatchBatch() {
      if (++ticks === 1) throw new Error('synthetic outage')
      controller.abort()
      return { delivered: [], retrying: [], rejected: [], blocked: [] }
    },
    async backlog() { return { pending: 0, failed: 0, oldestAgeMs: 0 } },
  }, { tenantIds: ['fixture-tenant'], intervalMs: 1, signal: controller.signal })
  assert.equal(ticks, 2)
})
