import assert from 'node:assert/strict'
import { it } from 'node:test'
import { makeDeadline, shift, todayISO, type MockPeriod } from './rules'

// モックの期限は Backend（rule-engine.ts）と同じ数え方にする。ずれると、モックで見た期限と本番の期限が食い違う
const due = (startDate: string, period: MockPeriod) =>
  makeDeadline({ id: 'd', label: 'x', startDate, period, basisLabel: '', ruleId: 'r' }).dueDate

it('counts the first day when the rule says so (death notification: 7 days including the day it became known)', () => {
  assert.equal(due('2026-09-15', { unit: 'DAY', count: 7, includeFirstDay: true }), '2026-09-21')
})

it('starts counting from the next day by default', () => {
  assert.equal(due('2026-09-15', { unit: 'DAY', count: 14 }), '2026-09-29')
})

it('counts months on the calendar instead of approximating with days', () => {
  // 90日で近似すると 2026-12-14 になり、1日ずれる
  assert.equal(due('2026-09-15', { unit: 'MONTH', count: 3 }), '2026-12-15')
  assert.equal(due('2026-09-15', { unit: 'MONTH', count: 4 }), '2027-01-15')
})

it('ends on the last day of the month when the corresponding day does not exist', () => {
  // 起算日は 1/31。2月に 31日は無いので、2月の末日に満了する
  assert.equal(due('2026-01-30', { unit: 'MONTH', count: 1 }), '2026-02-28')
  // 起算日は閏年の 2/29。5年後の2月に 29日は無い
  assert.equal(due('2024-02-28', { unit: 'YEAR', count: 5 }), '2029-02-28')
})

it('shifts calendar dates without drifting across months and years', () => {
  assert.equal(shift('2026-12-31', 1), '2027-01-01')
  assert.equal(shift('2026-03-01', -1), '2026-02-28')
})

it('uses the calendar date in Japan for today', () => {
  assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(todayISO(), new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date()))
})
