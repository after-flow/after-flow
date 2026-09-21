import type { ISODateTime } from './resources.js'

/**
 * `Case.profile`（申し送り 3-1 の出し分け条件）の公開契約。
 *
 * 保存形は未回答の項目を `UNKNOWN` に正規化して持つため、回答済みの
 * `CaseProfileResource` は常に 6 項目すべてを含む（部分回答は無い）。
 */
export type HealthInsuranceKindResource = 'NATIONAL' | 'EMPLOYEE' | 'LATE_ELDERLY' | 'UNKNOWN'
export type PensionKindResource = 'EMPLOYEES' | 'NATIONAL_ONLY' | 'NONE' | 'UNKNOWN'
export type OccupationKindResource = 'EMPLOYEE' | 'SELF_EMPLOYED' | 'NONE' | 'UNKNOWN'
export type YesNoUnknownResource = 'YES' | 'NO' | 'UNKNOWN'

export interface CaseProfileResource {
  healthInsurance: HealthInsuranceKindResource
  pension: PensionKindResource
  occupation: OccupationKindResource
  realEstate: YesNoUnknownResource
  car: YesNoUnknownResource
  mortgage: YesNoUnknownResource
  answeredAt: ISODateTime
}
