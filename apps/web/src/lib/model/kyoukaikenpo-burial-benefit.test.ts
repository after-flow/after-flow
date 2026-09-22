import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mergeKyoukaikenpoBurialBenefitInput,
  withKyoukaikenpoBurialBenefitMissingFields,
} from './kyoukaikenpo-burial-benefit'

test('不足項目だけを入力で補い、変更していない既存値も3項目すべて保持する', () => {
  const input = mergeKyoukaikenpoBurialBenefitInput(
    {
      branch: '東京支部',
      deceasedInsuranceStatus: 'INSURED',
      applicantStatus: null,
      missingFields: ['APPLICANT_STATUS'],
    },
    {
      branch: '',
      deceasedInsuranceStatus: '',
      applicantStatus: 'LIVELIHOOD_MAINTAINER',
    },
  )

  assert.deepEqual(input, {
    branch: '東京支部',
    deceasedInsuranceStatus: 'INSURED',
    applicantStatus: 'LIVELIHOOD_MAINTAINER',
  })
})

test('未入力値を推測せずnullのまま扱う', () => {
  const input = mergeKyoukaikenpoBurialBenefitInput(
    {
      branch: null,
      deceasedInsuranceStatus: null,
      applicantStatus: null,
      missingFields: ['BRANCH', 'DECEASED_INSURANCE_STATUS', 'APPLICANT_STATUS'],
    },
    { branch: '  ', deceasedInsuranceStatus: '', applicantStatus: '' },
  )

  assert.deepEqual(input, {
    branch: null,
    deceasedInsuranceStatus: null,
    applicantStatus: null,
  })
})

test('保存した3項目からmissingFieldsを再計算する', () => {
  assert.deepEqual(
    withKyoukaikenpoBurialBenefitMissingFields({
      branch: '大阪支部',
      deceasedInsuranceStatus: null,
      applicantStatus: 'BURIAL_EXPENSE_PAYER',
    }).missingFields,
    ['DECEASED_INSURANCE_STATUS'],
  )
  assert.deepEqual(
    withKyoukaikenpoBurialBenefitMissingFields({
      branch: '大阪支部',
      deceasedInsuranceStatus: 'DEPENDENT',
      applicantStatus: 'BURIAL_EXPENSE_PAYER',
    }).missingFields,
    [],
  )
})
