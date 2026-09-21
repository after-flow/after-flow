import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEmptyWorkflowSnapshot } from '@mastra/core/storage'
import { createRuntimeFirestore } from '../src/infrastructure/runtime-storage/firestore.js'
import { decodeSnapshot, encodeSnapshot, SNAPSHOT_CODEC, MAX_SNAPSHOT_BYTES } from '../src/infrastructure/runtime-storage/snapshot-codec.js'

test('runtime configuration fails closed for implicit databases and business credentials', async () => {
  const env = { AI_RUNTIME_PROJECT_ID: 'ai-runtime-project', AI_RUNTIME_DATABASE_ID: 'ai-runtime' }
  for (const invalid of [{}, { ...env, AI_RUNTIME_DATABASE_ID: '(default)' }, { ...env, FIRESTORE_PROJECT_ID: 'business' },
    { ...env, GOOGLE_APPLICATION_CREDENTIALS: '/business.json' }, { ...env, AI_RUNTIME_EMULATOR_HOST: 'business:8085' }]) {
    assert.throws(() => createRuntimeFirestore(invalid))
  }
  const db = createRuntimeFirestore({ ...env, AI_RUNTIME_EMULATOR_HOST: '127.0.0.1:8085' })
  assert.equal(db.databaseId, 'ai-runtime'); await db.terminate()
})

test('snapshot codec preserves typed values and rejects secrets, oversized or mismatched payloads', () => {
  const snapshot = createEmptyWorkflowSnapshot('run-1')
  const data = { at: new Date('2026-01-01'), missing: undefined, bytes: new Uint8Array([1, 2]) }
  snapshot.context.input = data
  const bytes = encodeSnapshot(snapshot)
  assert.deepEqual(decodeSnapshot(bytes, 'run-1', SNAPSHOT_CODEC).context.input, data)
  assert.throws(() => decodeSnapshot(bytes, 'other-run', SNAPSHOT_CODEC))
  assert.throws(() => decodeSnapshot(bytes, 'run-1', 'future-codec'))
  snapshot.requestContext = { nested: { executionAuthorization: 'secret' } }
  assert.throws(() => encodeSnapshot(snapshot), /Credentials/)
  snapshot.requestContext = {}; snapshot.context.input = { huge: 'x'.repeat(MAX_SNAPSHOT_BYTES) }
  assert.throws(() => encodeSnapshot(snapshot), /size limit/)
})
