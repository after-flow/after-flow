import assert from 'node:assert/strict'
import { it } from 'node:test'
import { daysSince, daysUntil, formatRelativeDays, formatYen } from './format'

process.env.TZ = 'Asia/Tokyo'

it('counts Japanese calendar days across UTC midnight and leap day', (context) => {
  context.mock.method(Date, 'now', () => new Date('2024-03-01T00:15:00+09:00').getTime())
  assert.equal(daysSince('2024-02-29'), 1)
  assert.equal(daysUntil('2024-03-02'), 1)
  assert.equal(daysSince('2024-03-01T23:59:00+09:00'), 0)
  assert.equal(daysUntil('2024-02-29'), -1)
})

it('keeps unknown dates and amounts distinct from today and zero', (context) => {
  context.mock.method(Date, 'now', () => new Date('2026-09-20T23:45:00+09:00').getTime())
  assert.equal(daysSince(), null)
  assert.equal(daysUntil('invalid-date'), null)
  assert.equal(daysSince('2026-09-20'), 0)
  assert.equal(formatRelativeDays(0), '本日が期限')
  assert.equal(formatRelativeDays(-1), '1日超過')
  assert.equal(formatYen(), '—')
  assert.equal(formatYen(0), '0円')
})
