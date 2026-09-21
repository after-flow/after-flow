import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { Bucket, File } from '@google-cloud/storage'
import { CloudObjectStorage, createDocumentStorage } from '../src/infrastructure/storage/cloud-object-storage.js'
import { MAX_DOCUMENT_BYTES } from '../src/domain/document/content-type.js'

/** SDK境界の契約Fake。本番GCS/IAM/保持設定の試験ではない。 */
function fixture() {
  let saved: { content: Buffer; meta: any } | null = null
  let fail: number | null = null
  let generation = 1
  let beforeDelete: (() => void) | null = null
  const calls: { operation: string; key: string; generation?: string; options?: any }[] = []
  const bucket = { file(key: string, options?: { generation?: string }) {
    const requireSaved = () => {
      if (fail) throw Object.assign(new Error('synthetic failure'), { code: fail })
      if (!saved) throw Object.assign(new Error('not found'), { code: 404 })
      return saved
    }
    return {
      async save(content: Buffer, opts: any) {
        calls.push({ operation: 'save', key, options: opts })
        if (fail) throw Object.assign(new Error('unavailable'), { code: fail })
        if (saved && opts.preconditionOpts.ifGenerationMatch === 0) throw Object.assign(new Error('exists'), { code: 412 })
        saved = { content, meta: { ...opts.metadata, size: String(content.length), generation: String(generation) } }
      },
      async getMetadata() { return [{ ...requireSaved().meta }] },
      async download() {
        calls.push({ operation: 'download', key, generation: options?.generation })
        return [requireSaved().content]
      },
      async delete(opts: any) {
        calls.push({ operation: 'delete', key, options: opts }); beforeDelete?.()
        const current = requireSaved()
        if (String(opts.ifGenerationMatch) !== current.meta.generation) throw Object.assign(new Error('new generation'), { code: 412 })
        saved = null
      },
    } as unknown as File
  } } satisfies Pick<Bucket, 'file'>
  return { storage: new CloudObjectStorage(bucket), calls,
    fail: (code: number | null) => { fail = code },
    corrupt: () => { saved!.content = Buffer.from('corrupt') },
    oversize: () => { saved!.meta.size = MAX_DOCUMENT_BYTES + 1 },
    raceDelete: () => { beforeDelete = () => { generation++; saved!.meta.generation = String(generation) } },
  }
}

describe('Cloud Storage原本Adapter', () => {
  it('作成限定・hash・CRC検証・private metadataを指定し、同じ世代の原本を返す', async () => {
    const f = fixture(), body = Buffer.from('%PDF-1.7 synthetic')
    await f.storage.put('tenant/case/document', body, 'application/pdf')
    assert.equal(f.calls[0]!.options.preconditionOpts.ifGenerationMatch, 0)
    assert.equal(f.calls[0]!.options.validation, 'crc32c')
    assert.equal(f.calls[0]!.options.metadata.cacheControl, 'private, no-store')
    assert.equal(f.calls[0]!.options.metadata.metadata.sha256, createHash('sha256').update(body).digest('hex'))
    assert.deepEqual((await f.storage.get('tenant/case/document'))?.content, new Uint8Array(body))
    assert.equal(f.calls.at(-1)!.generation, '1')
    await f.storage.put('tenant/case/document', body, 'application/pdf')
    await assert.rejects(f.storage.put('tenant/case/document', Buffer.from('different'), 'application/pdf'), { code: 'CONFLICT' })
    await assert.rejects(f.storage.put('tenant/case/document', body, 'image/png'), { code: 'CONFLICT' })
  })
  it('未存在だけをnull/falseとし、資格情報・可用性エラーを成功や未存在にしない', async () => {
    const f = fixture()
    assert.equal(await f.storage.get('missing'), null); assert.equal(await f.storage.exists('missing'), false)
    await f.storage.delete('missing')
    for (const code of [403, 429, 500]) {
      f.fail(code)
      await assert.rejects(f.storage.get('key'), { code }); await assert.rejects(f.storage.exists('key'), { code })
      await assert.rejects(f.storage.put('key', Buffer.from('x'), 'application/pdf'), { code })
      await assert.rejects(f.storage.delete('key'), { code })
    }
  })
  it('改変・過大metadataを拒否し、古い回収処理で新しい世代を削除しない', async () => {
    const f = fixture()
    await f.storage.put('key', Buffer.from('test'), 'application/pdf')
    f.corrupt(); await assert.rejects(f.storage.get('key'), { code: 'INTERNAL' })
    f.oversize(); await assert.rejects(f.storage.get('key'), { code: 'INTERNAL' })
    f.raceDelete(); await assert.rejects(f.storage.delete('key'), { code: 412 })
    assert.equal(await f.storage.exists('key'), true)
    await assert.rejects(f.storage.put('key', new Uint8Array(MAX_DOCUMENT_BYTES + 1), 'application/pdf'), { code: 'PAYLOAD_TOO_LARGE' })
  })
  it('本番bucketとlocalを混同せず、bucket名やemulator誤設定でfail closed', () => {
    assert.equal(createDocumentStorage({}), null)
    assert.throws(() => createDocumentStorage({ DOCUMENT_STORAGE_BUCKET: 'valid-bucket', DOCUMENT_STORAGE_ROOT: '/tmp/local' }))
    assert.throws(() => createDocumentStorage({ DOCUMENT_STORAGE_BUCKET: 'https://invalid' }))
    assert.throws(() => createDocumentStorage({ DOCUMENT_STORAGE_BUCKET: 'valid-bucket', STORAGE_EMULATOR_HOST: 'http://localhost:4443' }))
    assert.throws(() => createDocumentStorage({ DOCUMENT_STORAGE_EMULATOR_ENDPOINT: 'http://localhost:4443' }))
    assert.throws(() => createDocumentStorage({ DOCUMENT_STORAGE_BUCKET: 'valid-bucket', DOCUMENT_STORAGE_EMULATOR_ENDPOINT: 'localhost:4443' }))
    assert.throws(() => createDocumentStorage({ DOCUMENT_STORAGE_BUCKET: 'valid-bucket', DOCUMENT_STORAGE_EMULATOR_ENDPOINT: 'http://localhost:4443/path' }))
    assert.throws(() => createDocumentStorage({ NODE_ENV: 'production', DOCUMENT_STORAGE_BUCKET: 'valid-bucket', DOCUMENT_STORAGE_EMULATOR_ENDPOINT: 'http://localhost:4443' }))
    assert.ok(createDocumentStorage({ DOCUMENT_STORAGE_BUCKET: 'valid-bucket', DOCUMENT_STORAGE_EMULATOR_ENDPOINT: 'http://localhost:4443' }) instanceof CloudObjectStorage)
    assert.ok(createDocumentStorage({ DOCUMENT_STORAGE_BUCKET: 'synthetic-test-bucket' }) instanceof CloudObjectStorage)
  })
})
