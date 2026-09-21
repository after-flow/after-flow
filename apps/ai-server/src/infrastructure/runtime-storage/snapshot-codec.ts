import { serialize, deserialize } from 'node:v8'
import type { WorkflowRunState } from '@mastra/core/workflows'

export const MAX_SNAPSHOT_BYTES = 524288
export const SNAPSHOT_CODEC = 'node22-v8-v1'
const secretKey = /^(?:authorization|executionAuthorization|serviceToken|apiKey|private_key|access_token|refresh_token)$/i

/** Do not silently JSON-coerce Date/undefined/typed values emitted by Mastra. */
export function encodeSnapshot(snapshot: WorkflowRunState): Buffer {
  const seen = new WeakSet<object>()
  function inspect(value: unknown, depth: number) {
    if (depth > 64) throw new Error('Runtime snapshot is too deeply nested')
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    for (const [key, entry] of Object.entries(value)) {
      if (secretKey.test(key)) throw new Error('Credentials must not enter workflow snapshots')
      inspect(entry, depth + 1)
    }
    if (value instanceof Map) for (const [key, entry] of value) { inspect({ [String(key)]: entry }, depth + 1) }
    if (value instanceof Set) for (const entry of value) inspect(entry, depth + 1)
  }
  inspect(snapshot, 0)
  const bytes = serialize(snapshot)
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('Runtime snapshot exceeds size limit')
  return bytes
}

export function decodeSnapshot(bytes: Buffer, runId: string, codec: unknown): WorkflowRunState {
  if (codec !== SNAPSHOT_CODEC || !Buffer.isBuffer(bytes) || bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('Unsupported runtime snapshot')
  const value: unknown = deserialize(bytes)
  if (!value || typeof value !== 'object' || !('runId' in value) || value.runId !== runId || !('context' in value) || !('status' in value)) {
    throw new Error('Invalid runtime snapshot identity')
  }
  return value as WorkflowRunState
}
