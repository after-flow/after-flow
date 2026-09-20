import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ObjectStorage, StoredObject } from '../../application/ports/object-storage.js'
import { errors } from '../../shared/app-error.js'

/**
 * ローカルファイルシステムの保存先。
 *
 * 開発と CI 用。本番の Cloud Storage Adapter は別に実装し、
 * 保持期間・暗号化・アクセス制御の検証範囲をそこで明記する。
 * この実装でそれらを検証したとは扱わない。
 */
export class LocalObjectStorage implements ObjectStorage {
  constructor(private readonly root: string) {}

  /**
   * キーからファイルパスを作る。
   *
   * キーは内部で組み立てるが、万一 `..` が混ざると保存領域の外へ書ける。
   * 実体の path が root の下にあることを毎回確かめる。
   */
  private resolve(key: string): string {
    const safe = createHash('sha256').update(key).digest('hex')
    const file = path.join(this.root, safe.slice(0, 2), `${safe}.bin`)
    if (!file.startsWith(path.resolve(this.root) + path.sep) && !file.startsWith(this.root + path.sep)) {
      throw errors.internal({ internal: { reason: 'object key escapes the storage root' } })
    }
    return file
  }

  private metaPath(key: string): string {
    return `${this.resolve(key)}.meta.json`
  }

  async put(key: string, content: Uint8Array, contentType: string): Promise<void> {
    const file = this.resolve(key)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
    await writeFile(this.metaPath(key), JSON.stringify({ contentType }), 'utf8')
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const content = await readFile(this.resolve(key))
      const meta = JSON.parse(await readFile(this.metaPath(key), 'utf8')) as { contentType: string }
      return { content: new Uint8Array(content), contentType: meta.contentType }
    } catch {
      return null
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true })
    await rm(this.metaPath(key), { force: true })
  }

  async exists(key: string): Promise<boolean> {
    return (await this.get(key)) !== null
  }
}
