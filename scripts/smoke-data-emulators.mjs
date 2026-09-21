import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDocumentStorage } from '../apps/backend-server/src/infrastructure/storage/cloud-object-storage.ts'

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST
const firestoreProject = process.env.FIRESTORE_PROJECT_ID
const storageEndpoint = process.env.DOCUMENT_STORAGE_EMULATOR_ENDPOINT
const storageBucket = process.env.DOCUMENT_STORAGE_BUCKET

assert.equal(firestoreHost, 'firestore-emulator:8085')
assert.ok(firestoreProject)
assert.equal(storageEndpoint, 'http://storage-emulator:4443')
assert.ok(storageBucket)
assert.equal(process.env.DOCUMENT_STORAGE_ROOT, '')

const firestore = await fetch(
  `http://${firestoreHost}/v1/projects/${encodeURIComponent(firestoreProject)}/databases/(default)/documents/__health`,
  { signal: AbortSignal.timeout(5_000) },
)
assert.equal(firestore.status, 200, 'Backend container must reach the Firestore emulator')

const bucket = await fetch(`${storageEndpoint}/storage/v1/b/${encodeURIComponent(storageBucket)}`, {
  signal: AbortSignal.timeout(5_000),
})
assert.equal(bucket.status, 200, 'The local document bucket must be created during startup')

const storage = createDocumentStorage(process.env)
assert.ok(storage, 'Document storage must be connected in data mode')
const key = `smoke/${randomUUID()}.pdf`
const content = new TextEncoder().encode('%PDF-1.7 emulator smoke')
try {
  assert.equal(await storage.exists(key), false)
  await storage.put(key, content, 'application/pdf')
  assert.equal(await storage.exists(key), true)
  const stored = await storage.get(key)
  assert.deepEqual(stored, { content, contentType: 'application/pdf' })
} finally {
  await storage.delete(key)
}
assert.equal(await storage.exists(key), false)

console.log('Firestore and Cloud Storage emulator access through the Backend boundary verified.')
