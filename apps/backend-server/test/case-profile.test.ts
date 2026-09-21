import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ageAtDeath, normalizeProfile } from '../src/domain/case/case-profile.js'

describe('ageAtDeath', () => {
  it('誕生日の前日に死亡: まだ歳を重ねていない', () => {
    assert.equal(ageAtDeath('1950-06-15', '2026-06-14'), 75)
  })

  it('誕生日当日に死亡: その歳になっている', () => {
    assert.equal(ageAtDeath('1950-06-15', '2026-06-15'), 76)
  })

  it('誕生日の翌日に死亡', () => {
    assert.equal(ageAtDeath('1950-06-15', '2026-06-16'), 76)
  })

  it('閏日生まれ', () => {
    assert.equal(ageAtDeath('1952-02-29', '2026-03-01'), 74)
    assert.equal(ageAtDeath('1952-02-29', '2026-02-28'), 73)
  })

  it('生年月日が無ければ null', () => {
    assert.equal(ageAtDeath(null, '2026-06-15'), null)
  })

  it('生年月日が死亡日より後なら null', () => {
    assert.equal(ageAtDeath('2026-06-16', '2026-06-15'), null)
  })

  it('死亡日と同じ生年月日は0歳', () => {
    assert.equal(ageAtDeath('2026-06-15', '2026-06-15'), 0)
  })
})

describe('normalizeProfile', () => {
  it('省略した項目は UNKNOWN になる', () => {
    const normalized = normalizeProfile({ answeredAt: '2026-09-20T00:00:00+09:00' })
    assert.deepEqual(normalized, {
      healthInsurance: 'UNKNOWN',
      pension: 'UNKNOWN',
      occupation: 'UNKNOWN',
      realEstate: 'UNKNOWN',
      car: 'UNKNOWN',
      mortgage: 'UNKNOWN',
      answeredAt: '2026-09-20T00:00:00+09:00',
    })
  })

  it('指定した項目はそのまま保存する', () => {
    const normalized = normalizeProfile({
      healthInsurance: 'EMPLOYEE',
      pension: 'EMPLOYEES',
      occupation: 'EMPLOYEE',
      realEstate: 'YES',
      car: 'NO',
      mortgage: 'YES',
      answeredAt: '2026-09-20T00:00:00+09:00',
    })
    assert.equal(normalized.healthInsurance, 'EMPLOYEE')
    assert.equal(normalized.realEstate, 'YES')
    assert.equal(normalized.car, 'NO')
  })
})
