import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createFirestoreReadinessCheck } from '../../src/infrastructure/firestore/readiness-check.js'
import { ReadinessService } from '../../src/application/operations/readiness-service.js'
import { describeFirestore, firestore } from './helpers/emulator.js'

describeFirestore('Firestore readiness（Emulator）', () => {
  it('実Emulatorへ疎通できればokを返す', async () => {
    const service = new ReadinessService([createFirestoreReadinessCheck(firestore())])
    const report = await service.evaluate()
    assert.equal(report.status, 'ready')
    assert.deepEqual(report.checks, [{ name: 'firestore', status: 'ok' }])
  })
})
