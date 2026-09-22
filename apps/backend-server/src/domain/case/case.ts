import type { EntityBase } from '../shared/entity.js'
import type { CaseProfile } from './case-profile.js'

/** Case（案件）。仕様書 7.1 の中核 Entity。 */
export type CaseStatus = 'ACTIVE' | 'CLOSED'

export interface CaseEntity extends EntityBase {
  deceasedName: string
  deceasedNameKana: string | null
  dateOfDeath: string
  dateOfBirth: string | null
  /**
   * 相続の開始を知った日。
   *
   * 死亡日とは別の事実として保持する。未入力は null のままにする
   * （申告を強制しない）。熟慮期間などの起算日は「知った日」を使う
   * 手続きがあり、Rule Engine（`domain/task/rule-engine.ts`
   * `computeDeadline`）は未入力の間だけ死亡日で代わりに算定する。
   * `findCaseDateIssues`（`domain/case/case-dates.ts`）が作成・更新の
   * 両経路で `knownAt >= dateOfDeath` を強制しているため、この代替は
   * 常に早い側（またはちょうど同じ）にしか外れず、期限を実際より
   * 遅く見せることはない。
   */
  knownAt: string | null
  /** 申告された手続き担当者名。認証上の本人確認の根拠にはしない。 */
  ownerName: string
  /** 申告された続柄。法的な相続人の認定ではない。 */
  relationshipToDeceased: string
  /** 手続き先の市区町村。番地は保持しない。 */
  municipality: string | null
  /**
   * 葬儀・火葬が済んだと利用者が記録した日時。null・欠落は「まだ」。
   * 葬儀は手続きとして登録されないことが多く、手続きの件数からは済んだか決められない。
   */
  funeralCompletedAt?: string | null
  /**
   * 作成者本人に対応する Person の ID。
   *
   * Case 作成時に本人を Person として同時登録した場合だけ入る。それ以外は
   * null。作成時点の紐付けを記録した履歴値であり、以後は更新しない
   * （membership の付け替えには追従しない）。名前一致で本人を推定しない
   * （改名・表記ゆれで判定がずれる）。呼び出し主体が本人かどうかの判定には
   * 使わず、CaseMember.personId（DTO では selfPersonId）を根拠にする。
   * legacy record では欠落しうるため optional。読み出し側は null に正規化する。
   */
  ownerPersonId?: string | null
  /** Human-controlled pause of AI planning; absent only on legacy records. */
  aiPlanningRestriction?: { reason: string } | null
  /**
   * 手続きの出し分け条件（健康保険・年金・職業・不動産・車・住宅ローン）。
   * 未回答は null（全項目 UNKNOWN と同じに評価する）。legacy record では欠落しうる
   * ため optional。読み出し側は null に正規化する。
   */
  profile?: CaseProfile | null
  status: CaseStatus
  /**
   * Case 全体の版。
   *
   * Entity 自身の楽観ロック（version）とは別。Context に影響する変更で
   * 増やし、AI の提案が古い Context に基づいていないかの判定に使う。
   */
  caseVersion: number
  /**
   * 基本情報（本 Entity のユーザー編集項目）専用の楽観ロックの版。
   *
   * Entity 自身の楽観ロック（version）は、ContextVersionUnitOfWork が
   * caseVersion を進めるためだけに書き込んだ場合にも増える。そのため
   * `update`/`setPlanningRestriction` の expectedVersion 照合には使えない
   * （他の Context 書き込みと空振りの競合を起こす）。この版は
   * 基本情報が実際に変わったときだけ増やす。
   * この版が導入される前に作られた legacy record では欠落しうるため optional。
   * 読み出し側は version に正規化する（導入前は version がこの役割を兼ねていたため）。
   */
  basicInfoVersion?: number
}

/** Case 配下の変更から Case 全体の版を進める。 */
export function nextCaseVersion(current: number): number {
  return current + 1
}
