import { randomUUID } from 'node:crypto'
import { describe } from 'node:test'
import { Firestore } from '@google-cloud/firestore'
import type { ActorRef, WorkContext } from '../../../src/application/ports/persistence.js'
import { FirestoreReadRepository } from '../../../src/infrastructure/firestore/read-repository.js'
import { FirestoreUnitOfWork } from '../../../src/infrastructure/firestore/unit-of-work.js'

/**
 * Emulator 前提の統合テスト用ヘルパー。
 *
 * 実 Firestore の資格情報では動かさない。Emulator が無い環境では
 * 黙って成功させず、理由を表示して skip する。
 */
export const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST
export const hasEmulator = Boolean(emulatorHost)

const projectId = process.env.FIRESTORE_PROJECT_ID ?? 'after-flow-test'

let shared: Firestore | null = null

export function firestore(): Firestore {
  if (!shared) {
    if (!hasEmulator) throw new Error('FIRESTORE_EMULATOR_HOST is not set')
    shared = new Firestore({ projectId, ignoreUndefinedProperties: false })
  }
  return shared
}

export function unitOfWork(): FirestoreUnitOfWork {
  return new FirestoreUnitOfWork(firestore())
}

export function readRepository(): FirestoreReadRepository {
  return new FirestoreReadRepository(firestore())
}

/**
 * テストごとに別の tenant を使う。
 *
 * 共有の Emulator を消し合うと、並行実行で不安定になる。
 * データを消すのではなく、最初から交わらない領域を使う。
 */
export function newTenantId(): string {
  return `t-${randomUUID().replace(/-/g, '')}`
}

export function newId(prefix = 'x'): string {
  return `${prefix}-${randomUUID().replace(/-/g, '')}`
}

export const testActor: ActorRef = { type: 'USER', userId: 'user-test-0001', agentRunId: null }

export function workContext(tenantId: string, overrides: Partial<WorkContext> = {}): WorkContext {
  return {
    tenantId,
    actor: testActor,
    requestId: `req-${randomUUID()}`,
    ...overrides,
  }
}

/**
 * Emulator が必要な suite。
 * 未起動なら skip し、`pnpm test:firestore` で実行することを表示する。
 */
export function describeFirestore(name: string, fn: () => void): void {
  if (!hasEmulator) {
    describe(`${name} [skipped: FIRESTORE_EMULATOR_HOST 未設定。pnpm test:firestore で実行する]`, { skip: true }, fn)
    return
  }
  describe(name, fn)
}
