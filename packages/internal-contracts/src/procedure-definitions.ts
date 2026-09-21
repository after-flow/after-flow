import { z } from 'zod'

/** index.ts の internalId と同一定義。相互 import の循環を避けるためここで持つ。 */
const internalId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)

export const contextGroupSchema = z.enum(['case', 'profile', 'persons', 'relationships', 'assets', 'liabilities', 'contracts', 'benefits', 'decisions', 'deadlines'])
export type ContextGroup = z.infer<typeof contextGroupSchema>
/** Case と同じ 1 件だけの group。配列ではなく単一 entity として投影する。 */
export const SINGLE_ENTITY_GROUPS = ['case', 'profile'] as const satisfies readonly ContextGroup[]

/** 投影を許可しうるフィールド。氏名・自由文（name / note / summary / deceasedName / body）は含めない。 */
export const CONTEXT_FIELDS = {
  case: ['dateOfDeath', 'knownAt', 'municipality', 'status'],
  profile: ['healthInsurance', 'pension', 'occupation', 'realEstate', 'car', 'mortgage'],
  persons: ['relationshipLabel', 'role', 'isHeir', 'specialCircumstance'],
  relationships: ['kind'],
  assets: ['kind', 'institution', 'amount', 'confirmation'],
  liabilities: ['kind', 'creditor', 'amount', 'confirmation'],
  contracts: ['kind', 'provider', 'policyState', 'progressState'],
  benefits: ['kind', 'provider', 'amount', 'progressState'],
  decisions: ['method', 'state'],
  deadlines: ['dueDate', 'startDate', 'confirmation', 'unresolvedReason', 'basisLabel', 'ruleId', 'ruleVersion', 'critical', 'extendable'],
} as const satisfies Record<ContextGroup, readonly string[]>

/** group を投影するとき常に同伴させる参照 ID・出自フィールド。confirmation / state を失わないための固定規則。 */
export const STRUCTURAL_FIELDS = {
  case: [], profile: [], persons: ['excludedAt'], relationships: ['fromPersonId', 'toPersonId', 'excludedAt'],
  assets: ['confirmation'], liabilities: ['confirmation'], contracts: [], benefits: [],
  decisions: ['personId', 'state'], deadlines: ['taskId', 'confirmation'],
} as const satisfies Record<ContextGroup, readonly string[]>

export const contextRequirementSchema = z.object({ group: contextGroupSchema, field: z.string().min(1).max(80), purpose: z.string().min(1).max(200) })
  .strict().refine(r => (CONTEXT_FIELDS[r.group] as readonly string[]).includes(r.field), 'Unknown context field')
export type ContextRequirement = z.infer<typeof contextRequirementSchema>
export const contextKey = (r: Pick<ContextRequirement, 'group' | 'field'>) => `${r.group}.${r.field}`

export const researchScopeSchema = z.object({
  authorityType: z.string().min(1).max(100), authorityName: z.string().min(1).max(200).nullable(),
  jurisdiction: z.string().min(1).max(200), sourceCatalogIds: z.array(internalId).max(20),
}).strict()

/**
 * 手続きの案内 Context 投影層。
 *
 * 手続きの候補化・出し分け・期限・必要書類は Backend の手続きカタログ（条件 DSL 付き）が持つ。
 * ここでは「どの Case Fact を AI 案内へ渡してよいか」「何を公式情報源で調べるか」だけを持つ。
 * id は Backend カタログの手続き ID と同じ名前空間で、Task.procedureId から参照される。
 */
export const procedureDefinitionSchema = z.object({
  id: internalId, title: z.string().min(1).max(120), summary: z.string().max(500),
  guidance: z.object({
    requiredContext: z.array(contextRequirementSchema).max(20), optionalContext: z.array(contextRequirementSchema).max(20),
    researchScope: researchScopeSchema, questions: z.array(z.string().min(1).max(300)).min(1).max(12),
  }).strict(),
  version: z.number().int().positive(), reviewStatus: z.enum(['draft', 'reviewed', 'deprecated']),
}).strict().superRefine((def, ctx) => {
  const requiredKeys = new Set(def.guidance.requiredContext.map(contextKey))
  def.guidance.optionalContext.forEach((req, index) => {
    if (requiredKeys.has(contextKey(req))) ctx.addIssue({ code: 'custom', message: 'requiredContext と optionalContext が重複している', path: ['guidance', 'optionalContext', index] })
  })
})
export type ProcedureDefinition = z.infer<typeof procedureDefinitionSchema>

const req = (group: ContextGroup, field: string, purpose: string): ContextRequirement => ({ group, field, purpose })
const P = {
  municipality: req('case', 'municipality', '自治体固有の窓口・受付条件・必要書類を調査するため'),
  jurisdictionMunicipality: req('case', 'municipality', '最後の住所地から管轄の家庭裁判所・税務署を特定するため'),
  knownAt: req('case', 'knownAt', '期限の起算日や緊急度を個別に判断するため'),
  dateOfDeath: req('case', 'dateOfDeath', '死亡年・制度上の基準日・申告期間を判断するため'),
  dueDate: req('deadlines', 'dueDate', '算出済みの期限を案内に反映するため'),
  healthInsurance: req('profile', 'healthInsurance', '加入していた健康保険の種類で窓口・給付・書類を分けるため'),
  pension: req('profile', 'pension', '受給していた年金の種類で届出先・期限を分けるため'),
  occupation: req('profile', 'occupation', '勤務先・事業の有無で必要な届出を分けるため'),
  realEstate: req('profile', 'realEstate', '対象財産の有無で手続きの要否を判断するため'),
  car: req('profile', 'car', '対象財産の有無で手続きの要否を判断するため'),
  mortgage: req('profile', 'mortgage', '対象債務の有無で手続きの要否を判断するため'),
  relationshipLabel: req('persons', 'relationshipLabel', '申請者区分や取得すべき戸籍範囲を判断するため'),
  isHeir: req('persons', 'isHeir', '対象となる相続人を特定するため'),
  role: req('persons', 'role', '受取人・申請者など手続上の役割を判定するため'),
  specialCircumstance: req('persons', 'specialCircumstance', '未成年・利益相反等の追加手続可能性を確認するため'),
  relationshipKind: req('relationships', 'kind', '親族関係と相続順位・戸籍範囲を整理するため'),
  assetKind: req('assets', 'kind', '対象財産に対応する手続きを選ぶため'),
  assetInstitution: req('assets', 'institution', '金融機関固有の公式手続きを調査するため'),
  assetAmount: req('assets', 'amount', '選択・分割・申告要否の個別判断に使うため'),
  assetConfirmation: req('assets', 'confirmation', '未確認の資産情報を確定扱いしないため'),
  liabilityKind: req('liabilities', 'kind', '対象債務に対応する手続きを選ぶため'),
  liabilityCreditor: req('liabilities', 'creditor', '債権者固有の手続きを調査するため'),
  liabilityAmount: req('liabilities', 'amount', '承認・放棄や税務判断に負債を反映するため'),
  liabilityConfirmation: req('liabilities', 'confirmation', '未確認の債務情報を確定扱いしないため'),
  contractKind: req('contracts', 'kind', '対象制度・契約手続きを識別するため'),
  contractProvider: req('contracts', 'provider', '提供者固有の公式手続きを調査するため'),
  contractPolicyState: req('contracts', 'policyState', '契約の有効性・対象可否を判断するため'),
  contractProgressState: req('contracts', 'progressState', '重複案内を避け、次の行動を示すため'),
  benefitKind: req('benefits', 'kind', '対象給付を識別するため'),
  benefitProgressState: req('benefits', 'progressState', '重複案内を避け、次の行動を示すため'),
  decisionMethod: req('decisions', 'method', '選択済みまたは検討中の相続方法を把握するため'),
  decisionState: req('decisions', 'state', '本人確認済みか、未確定かを区別するため'),
}
const JP = 'Japan'
const scope = (authorityType: string, authorityName: string | null, sourceCatalogIds: string[] = []) => ({ authorityType, authorityName, jurisdiction: JP, sourceCatalogIds })
const GENERIC_QUESTIONS = ['提出先はどこか', '必要書類は何か', '提出方法・受付条件は何か', '期限の根拠は何か']

type RawDefinition = Omit<ProcedureDefinition, 'version' | 'reviewStatus'> & Partial<Pick<ProcedureDefinition, 'version' | 'reviewStatus'>>
const define = (raw: RawDefinition): ProcedureDefinition => procedureDefinitionSchema.parse({ version: 1, reviewStatus: 'draft', ...raw })

export const PROCEDURE_DEFINITIONS: readonly ProcedureDefinition[] = [
  define({ id: 'death-notification', title: '死亡届を提出する', summary: '死亡届の提出先・方法・期限・必要書類を案内する。',
    guidance: { requiredContext: [P.municipality], optionalContext: [P.knownAt, P.dueDate], researchScope: scope('municipality', null),
      questions: ['提出先はどこか', '必要書類は何か', '提出方法・受付条件は何か', '期限の根拠は何か'] } }),
  define({ id: 'cremation-permit', title: '火葬許可の手続きを確認する', summary: '火葬許可申請と許可証受領の方法を案内する。',
    guidance: { requiredContext: [P.municipality], optionalContext: [], researchScope: scope('municipality', null),
      questions: ['申請窓口はどこか', '死亡届と同時申請か', '必要書類・手数料は何か', '許可証の受領方法は何か'] } }),
  define({ id: 'kyoukaikenpo-burial-benefit', title: '健康保険の埋葬料（費）を確認する', summary: '協会けんぽの埋葬料・埋葬費について、対象者・提出先・添付書類を案内する。', reviewStatus: 'reviewed',
    guidance: { requiredContext: [P.contractKind, P.contractProvider, P.relationshipLabel], optionalContext: [P.contractPolicyState, P.benefitProgressState, P.healthInsurance],
      researchScope: scope('public-insurer', '全国健康保険協会', ['kyoukaikenpo-burial-benefit']),
      questions: ['埋葬料と埋葬費のどちらか', '申請者要件は何か', '添付書類は何か', '提出方法・期限は何か'] } }),
  define({ id: 'funeral-benefit-claim', title: '葬祭費・埋葬料を請求する', summary: '加入していた健康保険から葬祭費または埋葬料を請求する方法を案内する。',
    guidance: { requiredContext: [P.healthInsurance], optionalContext: [P.municipality, P.benefitProgressState, P.dueDate], researchScope: scope('public-insurer', null),
      questions: ['葬祭費と埋葬料のどちらの対象か', '申請者要件は何か', '添付書類は何か', '提出方法・期限は何か'] } }),
  define({ id: 'household-change', title: '世帯主変更届を出す', summary: '世帯主変更届の要否・提出先・必要書類・期限を案内する。',
    guidance: { requiredContext: [P.municipality], optionalContext: [P.dueDate], researchScope: scope('municipality', null),
      questions: ['届出が必要な世帯構成か', '届出先はどこか', '必要書類は何か', '期限はいつか'] } }),
  define({ id: 'health-insurance-loss', title: '健康保険の資格喪失の手続きをする', summary: '加入していた健康保険の種類に応じた資格喪失の手続きを案内する。',
    guidance: { requiredContext: [P.healthInsurance], optionalContext: [P.municipality, P.dueDate], researchScope: scope('public-insurer', null), questions: GENERIC_QUESTIONS } }),
  define({ id: 'long-term-care-loss', title: '介護保険の資格喪失届を出す', summary: '介護保険の資格喪失届の提出先・必要書類・期限を案内する。',
    guidance: { requiredContext: [P.municipality], optionalContext: [P.dueDate], researchScope: scope('municipality', null), questions: GENERIC_QUESTIONS } }),
  define({ id: 'pension-stop', title: '年金の受給停止の手続きをする', summary: '受給していた年金の種類に応じた受給停止の届出を案内する。',
    guidance: { requiredContext: [P.pension], optionalContext: [P.dueDate], researchScope: scope('pension-office', '日本年金機構'),
      questions: ['届出先はどこか', '必要書類は何か', '期限はいつか', 'マイナンバー登録済みで届出が不要になる条件は何か'] } }),
  define({ id: 'unpaid-pension-claim', title: '未支給年金を請求する', summary: '未支給年金の請求資格・提出先・必要書類・期限を案内する。',
    guidance: { requiredContext: [P.pension, P.relationshipLabel], optionalContext: [P.dueDate], researchScope: scope('pension-office', '日本年金機構'),
      questions: ['請求できる人の範囲は何か', '提出先はどこか', '必要書類は何か', '期限はいつか'] } }),
  define({ id: 'survivor-pension-check', title: '遺族年金を受け取れるか確かめる', summary: '遺族基礎年金・遺族厚生年金の受給要件と請求方法を案内する。',
    guidance: { requiredContext: [P.pension, P.relationshipLabel], optionalContext: [P.isHeir], researchScope: scope('pension-office', '日本年金機構'),
      questions: ['受給要件は何か', '請求先はどこか', '必要書類は何か', '請求の期限はいつか'] } }),
  define({ id: 'death-lump-sum-check', title: '死亡一時金・寡婦年金を受け取れるか確かめる', summary: '死亡一時金・寡婦年金の対象条件と請求方法を案内する。',
    guidance: { requiredContext: [P.pension, P.relationshipLabel], optionalContext: [P.dueDate], researchScope: scope('pension-office', '日本年金機構'),
      questions: ['対象となる条件は何か', '請求先はどこか', '必要書類は何か', '請求の期限はいつか'] } }),
  define({ id: 'high-cost-medical-check', title: '高額療養費の払い戻しを確かめる', summary: '高額療養費の払い戻しの対象・請求先・期限を案内する。',
    guidance: { requiredContext: [P.healthInsurance], optionalContext: [P.decisionMethod, P.decisionState], researchScope: scope('public-insurer', null),
      questions: ['払い戻しの対象になる条件は何か', '請求先はどこか', '必要書類は何か', '請求の期限はいつか'] } }),
  define({ id: 'will-check', title: '遺言書があるか確かめる', summary: '公正証書遺言の検索と自筆証書遺言の保管照会・検認の方法を案内する。',
    guidance: { requiredContext: [], optionalContext: [P.municipality, P.relationshipLabel], researchScope: scope('notary-office', '公証役場・法務局'),
      questions: ['公正証書遺言はどこで検索できるか', '法務局の保管照会はどう行うか', '検認が必要な場合は何か', '必要書類は何か'] } }),
  define({ id: 'collect-family-register', title: '相続人を調べる（戸籍の収集）', summary: '相続人確定に必要な戸籍の範囲と取得方法を整理する。',
    guidance: { requiredContext: [P.relationshipLabel, P.relationshipKind], optionalContext: [P.isHeir], researchScope: scope('municipality', null),
      questions: ['誰のどの期間の戸籍が必要か', 'どこへ請求するか', '代替できる法定相続情報はあるか', '本人確認・委任状は必要か'] } }),
  define({ id: 'estate-survey', title: '財産と借金を調べる', summary: '預貯金・不動産・有価証券・保険と債務の調べ方を案内する。',
    guidance: { requiredContext: [], optionalContext: [P.assetKind, P.assetConfirmation, P.liabilityKind, P.liabilityConfirmation], researchScope: scope('financial-institution', null),
      questions: ['調べる財産・債務の範囲は何か', '信用情報の開示はどう請求するか', '残高証明はどう取るか', '把握した内容をどう記録するか'] } }),
  define({ id: 'inheritance-choice', title: '相続の方法を決める（承認・放棄の判断）', summary: '単純承認・相続放棄・限定承認の選択に必要な情報を整理する。',
    guidance: { requiredContext: [P.knownAt, P.isHeir],
      optionalContext: [P.decisionMethod, P.decisionState, P.assetConfirmation, P.assetAmount, P.liabilityConfirmation, P.liabilityAmount, P.relationshipKind, P.dueDate],
      researchScope: scope('court', '裁判所'), questions: ['選択肢と効果は何か', '判断期限と起算日は何か', '調査不足時の対応は何か', '専門家確認が必要な条件は何か'] } }),
  define({ id: 'inheritance-renunciation', title: '相続放棄を申述する', summary: '対象相続人の相続放棄申述について、管轄・期限・必要書類を案内する。',
    guidance: { requiredContext: [P.knownAt, P.jurisdictionMunicipality, P.isHeir, P.decisionMethod, P.decisionState],
      optionalContext: [P.relationshipKind, P.assetConfirmation, P.liabilityConfirmation, P.dueDate], researchScope: scope('family-court', null),
      questions: ['申述先はどこか', '期限と起算日は何か', '申述人区分別の戸籍は何か', '追加提出の可能性はあるか'] } }),
  define({ id: 'final-income-tax-return', title: '準確定申告をする', summary: '死亡年の所得税について申告要否・提出方法・必要資料を整理する。',
    guidance: { requiredContext: [P.dateOfDeath, P.knownAt, P.isHeir], optionalContext: [P.jurisdictionMunicipality, P.occupation, P.dueDate], researchScope: scope('tax-office', '国税庁'),
      questions: ['申告要否は何で決まるか', '提出先と期限は何か', '相続人複数時の付表等は何か', 'e-Tax/書面の提出物は何か'] } }),
  define({ id: 'inheritance-tax-return', title: '相続税の申告が必要か確かめる', summary: '相続人・財産・債務・分割状況から申告要否と申告準備を整理する。',
    guidance: { requiredContext: [P.dateOfDeath, P.isHeir, P.assetKind, P.assetAmount, P.assetConfirmation],
      optionalContext: [P.liabilityAmount, P.liabilityConfirmation, P.decisionMethod, P.decisionState, P.jurisdictionMunicipality, P.benefitKind, P.dueDate],
      researchScope: scope('tax-office', '国税庁'), questions: ['申告要否は何で判定するか', '提出先と期限は何か', '評価・債務控除の資料は何か', '未分割時の扱いは何か'] } }),
  define({ id: 'estate-division', title: '遺産の分け方を話し合う（遺産分割協議）', summary: '相続人・資産・債務と合意状況を基に遺産分割を整理する。',
    guidance: { requiredContext: [P.isHeir, P.relationshipKind, P.assetKind, P.assetAmount, P.assetConfirmation, P.liabilityAmount, P.liabilityConfirmation, P.decisionMethod, P.decisionState],
      optionalContext: [P.specialCircumstance], researchScope: scope('national-government', '法務省・裁判所'),
      questions: ['協議参加者は誰か', '分割対象は何か', '合意未了項目は何か', '特別代理人等が必要か'] } }),
  define({ id: 'bank-accounts', title: '預貯金の相続手続きをする', summary: '金融機関ごとの預金払戻し・名義変更手続きを案内する。',
    guidance: { requiredContext: [P.assetKind, P.assetInstitution, P.isHeir, P.decisionMethod, P.decisionState], optionalContext: [P.assetAmount], researchScope: scope('financial-institution', null),
      questions: ['受付窓口・方法は何か', '相続形態別の書類は何か', '原本還付の扱いは何か', '払戻し・名義変更の流れは何か'] } }),
  define({ id: 'real-estate-registration', title: '不動産の相続登記をする', summary: '不動産の所在地・取得原因に応じた相続登記を案内する。',
    guidance: { requiredContext: [P.realEstate, P.isHeir, P.decisionMethod, P.decisionState], optionalContext: [P.assetKind, P.assetAmount, P.dueDate], researchScope: scope('legal-affairs-bureau', null),
      questions: ['管轄登記所はどこか', '取得原因別の申請書類は何か', '登録免許税の算定方法は何か', '申請方法は何か'] } }),
  define({ id: 'property-tax-representative', title: '固定資産税の相続人代表者を届け出る', summary: '固定資産税の相続人代表者届の提出先・必要書類・期限を案内する。',
    guidance: { requiredContext: [P.realEstate, P.municipality], optionalContext: [], researchScope: scope('municipality', null), questions: GENERIC_QUESTIONS } }),
  define({ id: 'car-transfer', title: '自動車の名義を変える', summary: '自動車の相続による名義変更・廃車の手続きを案内する。',
    guidance: { requiredContext: [P.car, P.decisionMethod, P.decisionState], optionalContext: [P.assetKind], researchScope: scope('transport-bureau', '運輸支局'),
      questions: ['手続き先はどこか', '相続による名義変更の必要書類は何か', '軽自動車の場合の窓口はどこか', '廃車にする場合の手続きは何か'] } }),
  define({ id: 'mortgage-insurance-check', title: '住宅ローンの団体信用生命保険を確かめる', summary: '団体信用生命保険による住宅ローン返済の確認方法を案内する。',
    guidance: { requiredContext: [P.mortgage], optionalContext: [P.liabilityKind, P.liabilityCreditor], researchScope: scope('financial-institution', null),
      questions: ['団信の加入をどう確かめるか', '連絡先はどこか', '必要書類は何か', '保険金で返済される流れは何か'] } }),
  define({ id: 'employer-procedures', title: '勤務先の手続きをする', summary: '勤務先への連絡と最後の給与・死亡退職金・返却物の確認を案内する。',
    guidance: { requiredContext: [P.occupation], optionalContext: [P.benefitKind, P.decisionMethod, P.decisionState], researchScope: scope('employer', null),
      questions: ['勤務先へ何を伝えるか', '最後の給与・退職金はどう扱われるか', '返却するものは何か', '相続放棄を考える場合の注意は何か'] } }),
  define({ id: 'self-employed-notification', title: '個人事業の届出をする', summary: '個人事業の廃業・死亡に関する税務署への届出を案内する。',
    guidance: { requiredContext: [P.occupation, P.dateOfDeath], optionalContext: [P.jurisdictionMunicipality, P.dueDate], researchScope: scope('tax-office', '国税庁'),
      questions: ['提出する届出書は何か', '提出先はどこか', '期限はいつか', '事業を引き継ぐ場合の追加届出は何か'] } }),
  define({ id: 'life-insurance-check', title: '生命保険・共済に入っていたか確かめる', summary: '保険会社・契約・受取人に応じた死亡保険金請求を案内する。',
    guidance: { requiredContext: [P.contractKind, P.contractProvider, P.contractPolicyState], optionalContext: [P.role, P.benefitKind, P.benefitProgressState, P.dateOfDeath],
      researchScope: scope('insurance-company', null), questions: ['請求窓口はどこか', '受取人区分別の必要書類は何か', '請求方法・期限は何か', '原本・診断書の要否は何か'] } }),
  define({ id: 'utilities-contracts', title: '公共料金・携帯電話・カードなどの契約を整理する', summary: '契約の名義変更・解約の進め方と相続放棄時の注意を案内する。',
    guidance: { requiredContext: [], optionalContext: [P.contractKind, P.contractProvider, P.contractProgressState, P.decisionMethod, P.decisionState], researchScope: scope('service-provider', null),
      questions: ['名義変更と解約のどちらを選ぶか', '手続き先はどこか', '必要書類は何か', '相続放棄を考える場合の注意は何か'] } }),
  define({ id: 'id-returns', title: '運転免許証・パスポートなどを返す', summary: '運転免許証・パスポート等の返納先と方法を案内する。',
    guidance: { requiredContext: [], optionalContext: [P.municipality], researchScope: scope('municipality', null),
      questions: ['返納先はどこか', '必要書類は何か', '期限はあるか', '返納が不要なものは何か'] } }),
]

/** id 重複を拒否する。 */
export function assertProcedureDefinitionsUsable(defs: readonly ProcedureDefinition[]): void {
  if (new Set(defs.map(def => def.id)).size !== defs.length) throw new Error('ProcedureDefinition の id が重複している')
}

export function findProcedureDefinition(id: string, defs: readonly ProcedureDefinition[] = PROCEDURE_DEFINITIONS): ProcedureDefinition | null {
  return defs.find(def => def.id === id) ?? null
}

/** required ∪ optional。STRUCTURAL_FIELDS は含めない（投影時に別途付与する）。 */
export function guidanceAllowlist(def: ProcedureDefinition): ReadonlyMap<ContextGroup, ReadonlySet<string>> {
  const map = new Map<ContextGroup, Set<string>>()
  for (const requirement of [...def.guidance.requiredContext, ...def.guidance.optionalContext]) {
    const fields = map.get(requirement.group) ?? new Set<string>()
    fields.add(requirement.field)
    map.set(requirement.group, fields)
  }
  return map
}

export type EntityContextGroup = Exclude<ContextGroup, 'case' | 'profile'>
export interface GuidanceProjectionSource {
  /** id / version を含む Case entity。余分な key があってよい。 */
  case: Record<string, unknown>
  /** Case.profile。未回答なら null。id / version は Case のものを使う。 */
  profile?: Record<string, unknown> | null
  entities: Partial<Record<EntityContextGroup, readonly Record<string, unknown>[]>>
}
export interface GuidanceProjection {
  content: { case: Record<string, unknown>; profile?: Record<string, unknown> } & Partial<Record<EntityContextGroup, Record<string, unknown>[]>>
  /** 実際に値（null 以外）を投影した group.field。ソート済み。 */
  usedKeys: string[]
  /** requiredContext のうち、どの entity にも null 以外の値がない key。 */
  missingRequired: ContextRequirement[]
  /** 入力に存在したが allowlist / STRUCTURAL_FIELDS 外だった group.field。監査用で値は含めない。 */
  droppedKeys: string[]
}

/**
 * Default deny の投影。allowlist にない group は content に含めない。allowlist にある group は
 * id, version, allowlist フィールド, STRUCTURAL_FIELDS だけを残す。値は変換しない。
 * optionalContext は存在する場合だけ残る（欠落しても missingRequired にならない）。
 */
export function projectGuidanceContext(def: ProcedureDefinition, source: GuidanceProjectionSource): GuidanceProjection {
  const allow = guidanceAllowlist(def)
  const usedKeys = new Set<string>()
  const droppedKeys = new Set<string>()
  const projectEntity = (group: ContextGroup, entity: Record<string, unknown>, identity: { id: unknown; version: unknown }): Record<string, unknown> => {
    const allowedFields = allow.get(group)
    const structuralFields: readonly string[] = STRUCTURAL_FIELDS[group]
    const projected: Record<string, unknown> = { id: identity.id, version: identity.version }
    for (const [field, value] of Object.entries(entity)) {
      if (field === 'id' || field === 'version') continue
      if (allowedFields?.has(field)) {
        projected[field] = value
        if (value !== null && value !== undefined) usedKeys.add(`${group}.${field}`)
      } else if (structuralFields.includes(field)) {
        projected[field] = value
      } else {
        droppedKeys.add(`${group}.${field}`)
      }
    }
    return projected
  }
  const caseIdentity = { id: source.case.id, version: source.case.version }
  const content: GuidanceProjection['content'] = { case: projectEntity('case', source.case, caseIdentity) }
  if (source.profile) {
    const profile = projectEntity('profile', source.profile, caseIdentity)
    if (allow.has('profile')) content.profile = profile
  }
  for (const [group, entities] of Object.entries(source.entities) as [EntityContextGroup, readonly Record<string, unknown>[] | undefined][]) {
    if (!entities) continue
    if (!contextGroupSchema.options.includes(group)) {
      for (const entity of entities) for (const field of Object.keys(entity)) if (field !== 'id' && field !== 'version') droppedKeys.add(`${group}.${field}`)
      continue
    }
    const projected = entities.map(entity => projectEntity(group, entity, { id: entity.id, version: entity.version }))
    if (allow.has(group)) content[group] = projected
  }
  const missingRequired = def.guidance.requiredContext.filter(requirement => !usedKeys.has(contextKey(requirement)))
  return { content, usedKeys: [...usedKeys].sort(), missingRequired, droppedKeys: [...droppedKeys].sort() }
}

/** Case 固有値を一切含まない Brief。questions は定義順に q1.. の id を振る。 */
export function procedureResearchBrief(def: ProcedureDefinition): {
  briefId: string; procedure: string; institution: string; jurisdiction: string
  questions: { id: string; text: string }[]; sourceCatalogIds: string[]
} {
  return {
    briefId: def.id, procedure: def.title,
    institution: def.guidance.researchScope.authorityName ?? def.guidance.researchScope.authorityType,
    jurisdiction: def.guidance.researchScope.jurisdiction,
    questions: def.guidance.questions.map((text, index) => ({ id: `q${index + 1}`, text })),
    sourceCatalogIds: [...def.guidance.researchScope.sourceCatalogIds],
  }
}

/** 'case.municipality' → '市区町村' など、CONTEXT_FIELDS の全 key を網羅する。 */
export const CONTEXT_FIELD_LABELS: Record<string, string> = {
  'case.dateOfDeath': '死亡日', 'case.knownAt': '死亡を知った日', 'case.municipality': '市区町村', 'case.status': 'ケースの状態',
  'profile.healthInsurance': '健康保険の種類', 'profile.pension': '年金の種類', 'profile.occupation': '職業区分',
  'profile.realEstate': '不動産の有無', 'profile.car': '自動車の有無', 'profile.mortgage': '住宅ローンの有無',
  'persons.relationshipLabel': '続柄', 'persons.role': '役割', 'persons.isHeir': '相続人区分', 'persons.specialCircumstance': '特別な事情',
  'relationships.kind': '続柄の種別',
  'assets.kind': '資産の種別', 'assets.institution': '資産の金融機関等', 'assets.amount': '資産の金額', 'assets.confirmation': '資産の確認状態',
  'liabilities.kind': '債務の種別', 'liabilities.creditor': '債権者', 'liabilities.amount': '債務の金額', 'liabilities.confirmation': '債務の確認状態',
  'contracts.kind': '契約の種別', 'contracts.provider': '契約の提供者', 'contracts.policyState': '契約の有効状態', 'contracts.progressState': '契約手続きの進捗',
  'benefits.kind': '給付の種別', 'benefits.provider': '給付の提供者', 'benefits.amount': '給付の金額', 'benefits.progressState': '給付手続きの進捗',
  'decisions.method': '決定した方法', 'decisions.state': '決定の確認状態',
  'deadlines.dueDate': '期限日', 'deadlines.startDate': '起算日', 'deadlines.confirmation': '期限の確認状態',
  'deadlines.unresolvedReason': '期限が未確定の理由', 'deadlines.basisLabel': '期限の根拠',
  'deadlines.ruleId': '期限ルールID', 'deadlines.ruleVersion': '期限ルールの版', 'deadlines.critical': '期限の重要度', 'deadlines.extendable': '期限の延長可否',
}

/** 不足項目を利用者向け確認質問へ変換する。値は含めない。200 文字以内。 */
export function missingContextQuestion(req: ContextRequirement): string {
  const label = CONTEXT_FIELD_LABELS[contextKey(req)] ?? req.field
  return `「${label}」が未登録です。${req.purpose}、登録してください。`
}

/** 先行手続きの ID を、同じ Case 内の Task へ解決する。Backend の手続きカタログが dependencyProcedureIds を持つ。 */
export function resolveDependencyTaskIds(dependencyProcedureIds: readonly string[], tasks: readonly { id: string; procedureId: string | null }[]): string[] {
  const wanted = new Set(dependencyProcedureIds)
  const resolved: string[] = []
  for (const task of tasks) {
    if (task.procedureId !== null && wanted.has(task.procedureId) && !resolved.includes(task.id)) resolved.push(task.id)
  }
  return resolved
}

/** 監査用。値を含めない。 */
export function guidanceContextAudit(def: ProcedureDefinition, projection: Pick<GuidanceProjection, 'usedKeys' | 'missingRequired' | 'droppedKeys'>): {
  procedureId: string; procedureVersion: number; reviewStatus: ProcedureDefinition['reviewStatus']
  contextKeys: string[]; missingRequiredKeys: string[]; droppedKeys: string[]
} {
  return {
    procedureId: def.id, procedureVersion: def.version, reviewStatus: def.reviewStatus,
    contextKeys: projection.usedKeys, missingRequiredKeys: projection.missingRequired.map(contextKey), droppedKeys: projection.droppedKeys,
  }
}
