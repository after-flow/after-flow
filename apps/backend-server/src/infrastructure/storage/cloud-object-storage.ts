import { createHash } from 'node:crypto'
import { Storage, type Bucket } from '@google-cloud/storage'
import type { ObjectStorage } from '../../application/ports/object-storage.js'
import { MAX_DOCUMENT_BYTES } from '../../domain/document/content-type.js'
import { errors } from '../../shared/app-error.js'
import { LocalObjectStorage } from './local-object-storage.js'

const hash = (content: Uint8Array) => createHash('sha256').update(content).digest('hex')
const hasCode = (error: unknown, code: number) => !!error && typeof error === 'object' && 'code' in error && Number(error.code) === code

/** Backend専用のADC。公開URL/署名URLを作らず、元の世代だけを読み取り・回収する。 */
export class CloudObjectStorage implements ObjectStorage {
  constructor(private readonly bucket: Pick<Bucket, 'file'>) {}

  async put(key: string, content: Uint8Array, contentType: string) {
    if (content.byteLength > MAX_DOCUMENT_BYTES) throw errors.payloadTooLarge()
    try {
      await this.bucket.file(key).save(Buffer.from(content), { resumable: false, validation: 'crc32c',
        preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType, cacheControl: 'private, no-store', metadata: { sha256: hash(content) } } })
    } catch (cause) {
      if (!hasCode(cause, 412)) throw cause
      // 応答喪失後の同一再送だけを許す。既存の異なる原本を上書きしない。
      const existing = await this.get(key)
      if (!existing || existing.contentType !== contentType || hash(existing.content) !== hash(content)) throw errors.conflict({ details: { reason: 'OBJECT_ALREADY_EXISTS' } })
    }
  }

  async get(key: string) {
    try {
      const [meta] = await this.bucket.file(key).getMetadata()
      const size = Number(meta.size)
      if (!meta.generation || !Number.isSafeInteger(size) || size < 0 || size > MAX_DOCUMENT_BYTES || meta.contentEncoding) throw errors.internal({ internal: { reason: 'invalid stored object metadata' } })
      const file = this.bucket.file(key, { generation: String(meta.generation) })
      const [content] = await file.download({ validation: 'crc32c' })
      if (content.length !== size || typeof meta.metadata?.sha256 !== 'string' || hash(content) !== meta.metadata.sha256) throw errors.internal({ internal: { reason: 'stored object integrity mismatch' } })
      return { content: new Uint8Array(content), contentType: meta.contentType ?? 'application/octet-stream' }
    } catch (cause) {
      if (hasCode(cause, 404)) return null
      throw cause
    }
  }

  async delete(key: string) {
    try {
      const [meta] = await this.bucket.file(key).getMetadata()
      if (!meta.generation) throw errors.internal()
      // 現在世代が変わったら412。新しい原本を古い回収処理で削除しない。
      await this.bucket.file(key).delete({ ifGenerationMatch: meta.generation })
    } catch (cause) { if (!hasCode(cause, 404)) throw cause }
  }

  async exists(key: string) {
    try { await this.bucket.file(key).getMetadata(); return true }
    catch (cause) { if (hasCode(cause, 404)) return false; throw cause }
  }
}

export function createDocumentStorage(env: NodeJS.ProcessEnv): ObjectStorage | null {
  const bucket = env.DOCUMENT_STORAGE_BUCKET, root = env.DOCUMENT_STORAGE_ROOT
  if (bucket && root) throw new Error('Select exactly one document storage backend')
  if (bucket) {
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) throw new Error('Invalid DOCUMENT_STORAGE_BUCKET')
    if (env.STORAGE_EMULATOR_HOST) throw new Error('Production document storage must not use an emulator endpoint')
    return new CloudObjectStorage(new Storage({ retryOptions: { totalTimeout: 30, maxRetries: 3 } }).bucket(bucket))
  }
  return root ? new LocalObjectStorage(root) : null
}
