/**
 * 日付の表示。weekday を付けると「9月28日（月）」のように曜日を添える。
 * 期限には曜日を付ける：役所は土日に閉まっているので、窓口へ行く日を決めるのに欠かせない。
 *
 * YYYY-MM-DD はその土地の暦日として読む（UTC として読むと、時差のある地域で1日ずれる）。
 */
export function formatDate(value?: string, opts?: { weekday?: boolean }): string {
  if (!value) return '—'
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const w = opts?.weekday ? `（${'日月火水木金土'[d.getDay()]}）` : ''
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日${w}`
}

export function formatDateTime(value?: string): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${formatDate(value)} ${hh}:${mm}`
}

export function formatRelativeDays(days: number): string {
  if (days < 0) return `${Math.abs(days)}日超過`
  if (days === 0) return '本日が期限'
  return `あと${days}日`
}

export function formatYen(value?: number): string {
  if (value == null) return '—'
  return `${value.toLocaleString('ja-JP')}円`
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 日付文字列をローカル時間として解釈する。
 *
 * new Date('2026-12-11') は日付のみの文字列を UTC 深夜として扱う。
 * 日本時間ではその日の午前9時にずれるため、期限の残日数が1日狂う。
 * Rule Engine 側（起算日 + N日）はローカルの暦日で数えているので、そちらに合わせる。
 */
function parseLocal(value: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`).getTime()
    : new Date(value).getTime()
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * ある日から今日までの暦日数。未来なら負。
 * 時刻ではなく日付の差で数えるので、同じ日のうちは何時に見ても 0 になる。
 */
export function daysSince(value?: string): number | null {
  if (!value) return null
  const t = parseLocal(value)
  if (Number.isNaN(t)) return null
  // 夏時間のある地域でも日数がずれないよう、双方を日の始まりに揃えてから割る
  return Math.round((startOfDay(Date.now()) - startOfDay(t)) / 86_400_000)
}

/**
 * 今日からその日までの暦日数。過ぎていれば負。
 *
 * 本来この値は Rule Engine が DeadlineSummary.daysRemaining として返すもので、
 * フロントエンドでは計算しない。熟慮期間のように残日数が返ってこない項目に限り、
 * 暫定でここを使う（README のバックエンド向け申し送りを参照）。
 */
export function daysUntil(value?: string): number | null {
  const elapsed = daysSince(value)
  return elapsed == null ? null : -elapsed
}

/** ある時刻からの経過ミリ秒。現在時刻を触る処理をここに集約する。 */
export function msSince(value?: string): number | null {
  if (!value) return null
  const t = new Date(value).getTime()
  if (Number.isNaN(t)) return null
  return new Date().getTime() - t
}
