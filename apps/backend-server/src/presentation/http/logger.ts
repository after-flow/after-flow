/**
 * 応答に出せない情報をログにだけ残すための最小のロガー。
 *
 * Authorization ヘッダーやトークンをログに残さないことが要件のため、
 * 呼び出し側が組み立てた構造だけを出力し、リクエスト全体は渡さない。
 */
type Level = 'info' | 'warn' | 'error'

const SECRET_KEY = /(authorization|token|password|secret|credential|cookie|idempotency-key)/i

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1))
  // SDK例外のmessage/name/stackには接続URLや入力が入る。分類だけを記録する。
  if (value instanceof Error) return { type: 'Error' }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? '[redacted]' : redact(item, depth + 1),
      ]),
    )
  }
  if (typeof value === 'string' && value.length > 512) return `${value.slice(0, 512)}…`
  return value
}

function emit(level: Level, message: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({
    level,
    message,
    time: new Date().toISOString(),
    ...(redact(fields) as Record<string, unknown>),
  })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logger = {
  info: (message: string, fields: Record<string, unknown> = {}) => emit('info', message, fields),
  warn: (message: string, fields: Record<string, unknown> = {}) => emit('warn', message, fields),
  error: (message: string, fields: Record<string, unknown> = {}) => emit('error', message, fields),
}
