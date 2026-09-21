import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { businessToday, findCaseDateIssues } from '../src/domain/case/case-dates.js'
import { assertCaseDatesValid } from '../src/application/case/case-service.js'
import { isAppError } from '../src/shared/app-error.js'

describe('businessToday（Asia/Tokyo の暦日）', () => {
  it('UTC 深夜でも JST の暦日に進む', () => {
    assert.equal(businessToday(new Date('2026-09-21T15:30:00Z')), '2026-09-22')
  })

  it('JST の日付境界の手前ではまだ進まない', () => {
    assert.equal(businessToday(new Date('2026-09-21T14:59:00Z')), '2026-09-21')
  })
})

describe('findCaseDateIssues', () => {
  const today = '2026-09-21'

  it('違反が無ければ空配列', () => {
    assert.deepEqual(findCaseDateIssues({ dateOfDeath: '2026-04-01', knownAt: '2026-04-03' }, today), [])
  })

  it('knownAt が null なら死亡日だけを見る', () => {
    assert.deepEqual(findCaseDateIssues({ dateOfDeath: '2026-04-01', knownAt: null }, today), [])
  })

  it('未来の死亡日を検出する', () => {
    const issues = findCaseDateIssues({ dateOfDeath: '2026-09-22', knownAt: null }, today)
    assert.equal(issues.length, 1)
    assert.equal(issues[0]?.path, 'dateOfDeath')
    assert.equal(issues[0]?.code, 'DATE_OF_DEATH_IN_FUTURE')
  })

  it('死亡日より前の知った日を検出する', () => {
    const issues = findCaseDateIssues({ dateOfDeath: '2026-04-10', knownAt: '2026-04-01' }, today)
    assert.equal(issues.length, 1)
    assert.equal(issues[0]?.path, 'knownAt')
    assert.equal(issues[0]?.code, 'KNOWN_AT_BEFORE_DATE_OF_DEATH')
  })

  it('未来の知った日を検出する', () => {
    const issues = findCaseDateIssues({ dateOfDeath: '2026-04-01', knownAt: '2026-09-22' }, today)
    assert.equal(issues.length, 1)
    assert.equal(issues[0]?.path, 'knownAt')
    assert.equal(issues[0]?.code, 'KNOWN_AT_IN_FUTURE')
  })

  it('複数違反をまとめて返す', () => {
    const issues = findCaseDateIssues({ dateOfDeath: '2026-09-22', knownAt: '2026-04-01' }, today)
    assert.equal(issues.length, 2)
    assert.deepEqual(issues.map(i => i.path).sort(), ['dateOfDeath', 'knownAt'])
  })

  it('境界（等号）はすべて有効', () => {
    assert.deepEqual(findCaseDateIssues({ dateOfDeath: today, knownAt: today }, today), [])
    assert.deepEqual(findCaseDateIssues({ dateOfDeath: '2026-04-01', knownAt: '2026-04-01' }, today), [])
  })
})

describe('assertCaseDatesValid（Application: route と同じ details 形に整形する）', () => {
  const today = '2026-09-21'

  it('違反が無ければ何も投げない', () => {
    assert.doesNotThrow(() => assertCaseDatesValid({ dateOfDeath: '2026-04-01', knownAt: '2026-04-03' }, today))
  })

  it('VALIDATION_FAILED を、route の Zod 検証と同じ details.issues 形で投げる', () => {
    try {
      assertCaseDatesValid({ dateOfDeath: '2026-09-22', knownAt: null }, today)
      assert.fail('例外が発生しなかった')
    } catch (error) {
      assert.ok(isAppError(error))
      if (!isAppError(error)) return
      assert.equal(error.code, 'VALIDATION_FAILED')
      assert.equal(error.status, 400)
      assert.equal(error.details?.source, 'body')
      const issues = error.details?.issues as { path: string; code: string }[]
      assert.equal(issues.length, 1)
      assert.equal(issues[0]?.path, 'dateOfDeath')
      assert.equal(issues[0]?.code, 'DATE_OF_DEATH_IN_FUTURE')
    }
  })
})
