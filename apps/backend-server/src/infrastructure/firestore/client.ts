import { Firestore } from '@google-cloud/firestore'
import { Timestamp } from '@google-cloud/firestore'

/**
 * 業務 Firestore への接続。
 *
 * この設定を持つのは Backend Server だけ。AI Server には渡さない
 * （compose と本番 IAM の両方で分離する）。
 */
export interface FirestoreConfig {
  projectId: string
  /** 既定以外のデータベースを使う場合に指定する。 */
  databaseId?: string
  /** 設定されていれば Emulator へ接続する。本番では未設定。 */
  emulatorHost?: string
}

export function readFirestoreConfig(env: NodeJS.ProcessEnv = process.env): FirestoreConfig {
  const emulatorHost = env.FIRESTORE_EMULATOR_HOST
  const projectId = env.FIRESTORE_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT

  if (!projectId) {
    throw new Error(
      'FIRESTORE_PROJECT_ID (または GOOGLE_CLOUD_PROJECT) が未設定です。' +
        '業務 Firestore の接続先を暗黙の既定値で決めない。',
    )
  }

  return {
    projectId,
    ...(env.FIRESTORE_DATABASE_ID ? { databaseId: env.FIRESTORE_DATABASE_ID } : {}),
    ...(emulatorHost ? { emulatorHost } : {}),
  }
}

export function createFirestore(config: FirestoreConfig): Firestore {
  return new Firestore({
    projectId: config.projectId,
    ...(config.databaseId ? { databaseId: config.databaseId } : {}),
    // Emulator 接続時はライブラリーが FIRESTORE_EMULATOR_HOST を読む。
    // 資格情報は不要で、実プロジェクトへは接続しない。
    ignoreUndefinedProperties: false,
  })
}

export function isEmulator(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.FIRESTORE_EMULATOR_HOST)
}

/** Firestore の Timestamp を ISO 文字列へ揃える。公開 DTO は文字列で扱う。 */
export function fromFirestoreValue(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString()
  if (Array.isArray(value)) return value.map(fromFirestoreValue)
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, fromFirestoreValue(item)]),
    )
  }
  return value
}

export function fromFirestoreDocument<T>(data: Record<string, unknown>): T {
  return fromFirestoreValue(data) as T
}
