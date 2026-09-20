import { createHash } from 'node:crypto'

/**
 * 要求内容の指紋。
 *
 * 同じ冪等性キーで異なる内容が送られたことを検出するために使う。
 * 内容そのものは保存しないため、個人情報を残さずに比較できる。
 * キーの順序で値が変わらないよう、object のキーを整列してから直列化する。
 */
export function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('base64url')
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
  return `{${entries.join(',')}}`
}
