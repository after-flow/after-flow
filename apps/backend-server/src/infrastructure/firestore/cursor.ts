import { createHash } from 'node:crypto'
import { Timestamp } from '@google-cloud/firestore'
import { errors } from '../../shared/app-error.js'

/**
 * 一覧のカーソル。
 *
 * 中身はサーバーの実装都合であり、クライアントは解釈しない。
 * 別の条件の一覧へカーソルを持ち込むと、並び順の基準が変わって
 * 件数が欠けるため、問い合わせ条件の指紋を埋めて不一致を拒否する。
 */
export interface CursorPayload {
  /** orderBy と where から作る指紋 */
  fingerprint: string
  /** 並び替えキーの値と、同値を割るための文書 ID */
  values: unknown[]
  id: string
}

export function queryFingerprint(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('base64url').slice(0, 16)
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string, fingerprint: string): CursorPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw errors.validationFailed({ message: 'カーソルの形式が正しくありません。', details: { field: 'cursor' } })
  }
  const payload = parsed as Partial<CursorPayload>
  if (
    typeof payload?.fingerprint !== 'string' ||
    typeof payload.id !== 'string' ||
    !Array.isArray(payload.values)
  ) {
    throw errors.validationFailed({ message: 'カーソルの形式が正しくありません。', details: { field: 'cursor' } })
  }
  if (payload.fingerprint !== fingerprint) {
    throw errors.validationFailed({
      message: '一覧の条件が変わったため、カーソルを使用できません。最初のページから取得してください。',
      details: { field: 'cursor' },
    })
  }
  return { fingerprint: payload.fingerprint, values: payload.values, id: payload.id }
}

/**
 * 並び替えキーの値を JSON へ落とす。
 *
 * Firestore の Timestamp をそのまま JSON にすると内部表現の数値になり、
 * 復元して startAfter に渡しても一致しない。型を明示して往復させる。
 */
interface EncodedTimestamp {
  t: 'ts'
  s: number
  n: number
}

function isEncodedTimestamp(value: unknown): value is EncodedTimestamp {
  return typeof value === 'object' && value !== null && (value as { t?: unknown }).t === 'ts'
}

export function encodeCursorValue(value: unknown): unknown {
  if (value instanceof Timestamp) {
    return { t: 'ts', s: value.seconds, n: value.nanoseconds } satisfies EncodedTimestamp
  }
  return value ?? null
}

export function decodeCursorValue(value: unknown): unknown {
  if (isEncodedTimestamp(value)) return new Timestamp(value.s, value.n)
  return value
}
