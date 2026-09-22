import { z } from 'zod'
import { orcaSdkProvider } from '../orcarouter/models.js'
import type { AiServiceComposition } from './composition.js'
import type { ProviderMetric } from '../mastra/authorized-models.js'
import type { GroundingRules } from '../../orchestration/playbooks/guidance-grounding.js'
import { HACKATHON_CATALOG_VERSION, HACKATHON_OFFICIAL_CATALOGS } from './hackathon-official-sources.js'

const modeSchema = z.enum(['auto', 'disabled', 'hackathon'])
const envSchema = z.object({
  ORCAROUTER_API_KEY: z.string().min(1).max(4096).regex(/^[^\s]+$/),
  AI_SERVICE_TOKEN: z.string().min(16).max(4096).regex(/^[^\r\n]+$/),
  AI_RUNTIME_ENCRYPTION_KEY: z.string().min(1).max(100),
  BACKEND_INTERNAL_URL: z.string().url(),
  BACKEND_INTERNAL_SERVICE_TOKEN: z.string().min(16).max(4096).regex(/^[^\r\n]+$/),
  BACKEND_SERVICE_AUDIENCE: z.string().min(1).max(200),
  AI_ORCA_CORE_MODEL: z.string().min(1).max(200),
  AI_ORCA_FALLBACK_MODEL: z.string().min(1).max(200),
})

const REVIEW_REFERENCE = 'https://docs.orcarouter.ai/operations/data-handling reviewed for hackathon demo 2026-09-21; upstream provider terms require separate production review'
const CATALOG_ID = 'kyoukaikenpo-burial-benefit'
const CHAT_CATALOG_IDS = HACKATHON_OFFICIAL_CATALOGS.map(catalog => catalog.id)
const POLICY_IDS = ['orca-core-primary', 'orca-core-fallback'] as const
const REVIEWED_AT = '2026-09-22T00:00:00.000Z'
const REVIEW_EXPIRES_AT = '2027-09-22T00:00:00.000Z'

/** 協会けんぽの支部名に使われる都道府県名。 */
const PREFECTURES = ['北海道', '青森', '岩手', '宮城', '秋田', '山形', '福島', '茨城', '栃木', '群馬', '埼玉', '千葉', '東京', '神奈川',
  '新潟', '富山', '石川', '福井', '山梨', '長野', '岐阜', '静岡', '愛知', '三重', '滋賀', '京都', '大阪', '兵庫', '奈良', '和歌山',
  '鳥取', '島根', '岡山', '広島', '山口', '徳島', '香川', '愛媛', '高知', '福岡', '佐賀', '長崎', '熊本', '大分', '宮崎', '鹿児島', '沖縄']

/**
 * 実出力の診断で見つかった誤りの型（窓口の追加、住所からの支部推測、起算日の取り違え）を、
 * 引用に同じ記載が無い限り表示しない（#163）。
 */
export const BURIAL_GROUNDING_RULES: GroundingRules = {
  // 給付の名称（埋葬料・埋葬費）は入れない。公式ページの支給額の区分は「埋葬費」の語を使わずに説明しており、
  // 正しい主張まで除いてしまう。名称の取り違えは起算日の禁止パターンで検出する。
  guardedTerms: ['窓口', '持参', '郵送', '電子申請', '市役所', '区役所', '役場'],
  prohibited: [
    { id: 'prefecture-branch', pattern: `(?:${PREFECTURES.join('|')})(?:都|府|県)?支部`,
      message: '提出先の支部は、亡くなった方が加入していた支部です。資格情報のお知らせやマイナポータルで確認してください。' },
    { id: 'residence-branch', pattern: '(?:住所|住民票|お住まい|居住|市区町村|最寄り|近く)[^。]{0,20}支部|支部[^。]{0,20}(?:住所|お住まい|居住地)',
      message: '提出先の支部は住所では決まりません。亡くなった方が加入していた支部を確認してください。' },
    { id: 'burial-cost-death-date', pattern: '埋葬費[^。、]*死亡(?:した)?(?:年月)?日の翌日',
      message: '埋葬費の申請期限の起算日は公式資料で確認してください。' },
    { id: 'burial-allowance-burial-date', pattern: '埋葬料[^。、]*埋葬(?:を行った|した)?(?:年月)?日の翌日',
      message: '埋葬料の申請期限の起算日は公式資料で確認してください。' },
  ],
}

/**
 * Explicit hackathon composition. It is enabled automatically only in non-production
 * when an OrcaRouter key is present. It never reads Backend Firestore or document settings.
 */
export function readHackathonComposition(
  env: NodeJS.ProcessEnv = process.env,
  writeMetric: (record: Readonly<Record<string, unknown>>) => void = record => console.info(JSON.stringify(record)),
): AiServiceComposition | null {
  const mode = modeSchema.parse(env.AI_RUNTIME_MODE?.trim() || 'auto')
  if (mode === 'disabled' || (mode === 'auto' && !env.ORCAROUTER_API_KEY?.trim())) return null
  if (env.NODE_ENV === 'production') throw new Error('Hackathon AI composition cannot run in production')

  const input = envSchema.parse({
    ORCAROUTER_API_KEY: env.ORCAROUTER_API_KEY,
    AI_SERVICE_TOKEN: env.AI_SERVICE_TOKEN,
    AI_RUNTIME_ENCRYPTION_KEY: env.AI_RUNTIME_ENCRYPTION_KEY,
    BACKEND_INTERNAL_URL: env.BACKEND_INTERNAL_URL,
    BACKEND_INTERNAL_SERVICE_TOKEN: env.BACKEND_INTERNAL_SERVICE_TOKEN,
    BACKEND_SERVICE_AUDIENCE: env.BACKEND_SERVICE_AUDIENCE ?? 'backend-internal',
    AI_ORCA_CORE_MODEL: env.AI_ORCA_CORE_MODEL ?? 'openai/gpt-4o-mini',
    AI_ORCA_FALLBACK_MODEL: env.AI_ORCA_FALLBACK_MODEL ?? 'google/gemini-2.5-flash',
  })
  if (input.AI_SERVICE_TOKEN === input.BACKEND_INTERNAL_SERVICE_TOKEN) throw new Error('Inbound and outbound service credentials must differ')

  const approvedAt = REVIEWED_AT
  const expiresAt = REVIEW_EXPIRES_AT
  const modelIds = [input.AI_ORCA_CORE_MODEL, input.AI_ORCA_FALLBACK_MODEL]
  if (new Set(modelIds).size !== modelIds.length || new Set(modelIds.map(model => model.split('/')[0])).size !== modelIds.length) {
    throw new Error('Hackathon fallback requires two distinct model families')
  }
  const policies = modelIds.map((modelId, index) => ({
    id: POLICY_IDS[index]!, revision: 'hackathon-v1', sdkProvider: orcaSdkProvider(modelId), modelId,
    roles: ['core', 'research'] as ('core' | 'research')[],
    dataClasses: ['minimized_case', 'public_research'] as ('minimized_case' | 'public_research')[],
    approvedAt, expiresAt, reviewReference: REVIEW_REFERENCE, trainingUse: false as const, retentionDays: 0,
    capabilities: { tools: true as const, structuredOutput: true as const, japanese: true as const },
    currency: 'USD', maxInputTokens: 16_000, maxOutputTokens: 4_000,
    // Conservative demo reservation bounds, not a billing quote.
    inputMicrosPerToken: 10, outputMicrosPerToken: 20,
  }))
  const scope = {
    id: 'burial-benefit-guidance', version: 'hackathon-v1', reviewedAt: approvedAt,
    procedure: '健康保険の埋葬料（費）支給申請', institution: '全国健康保険協会', jurisdiction: '日本', municipality: null,
    procedureIds: [CATALOG_ID], sourceCatalogIds: [CATALOG_ID], sourceCatalogVersions: { [CATALOG_ID]: HACKATHON_CATALOG_VERSION },
    // 案内の各区分（提出先・必要書類・手順・期限）に根拠の問いが対応するように分ける（#163）。
    questions: [
      { id: 'eligibility', text: '申請できる人と支給条件を確認してください。' },
      { id: 'benefit-kinds', text: '埋葬料・埋葬費・家族埋葬料の違いと、どれに当たるかの条件を確認してください。' },
      { id: 'amount', text: '支給額を給付の種類ごとに確認してください。' },
      { id: 'documents', text: '主な必要書類と条件による追加書類を確認してください。' },
      { id: 'deadline', text: '申請期限と起算日を給付の種類ごとに確認してください。' },
      { id: 'submission', text: '申請書の提出先と提出方法を確認してください。' },
    ],
    groundingRules: BURIAL_GROUNDING_RULES,
    // 協会けんぽの公式ページ（reviewReference）から作成した、案件への適用で確かめる事項。
    // Backendが投影した正式状態だけで確認済みを判定し、モデルの推測では消さない。
    applicabilityChecks: [
      { id: 'enrollment', question: '亡くなった方が協会けんぽに加入していたか、加入していた支部はどこかを確認してください。',
        confirmedBy: { group: 'case' as const, field: 'healthInsuranceBranch', present: true as const } },
      { id: 'deceased-status', question: '亡くなった方が被保険者本人か被扶養者かを確認してください（被扶養者の場合は家族埋葬料）。',
        confirmedBy: { group: 'case' as const, field: 'deceasedInsuranceStatus', oneOf: ['INSURED', 'DEPENDENT'] } },
      { id: 'applicant', question: '申請する方が亡くなった方に生計を維持されていたか（埋葬料）、実際に埋葬を行った方か（埋葬費）を確認してください。',
        confirmedBy: { group: 'case' as const, field: 'burialBenefitApplicantStatus', oneOf: ['LIVELIHOOD_MAINTAINER', 'BURIAL_EXPENSE_PAYER'] } },
    ],
  }
  const chatScope = {
    id: 'official-aftercare-chat', version: 'hackathon-v1', reviewedAt: approvedAt,
    procedure: '死亡後手続きに関する相談', institution: '関係する公的機関', jurisdiction: '日本', municipality: null,
    procedureIds: ['ai-chat'], sourceCatalogIds: CHAT_CATALOG_IDS,
    sourceCatalogVersions: Object.fromEntries(CHAT_CATALOG_IDS.map(id => [id, HACKATHON_CATALOG_VERSION])),
    questions: [{ id: 'answer', text: '取得した公式資料から、相談に関係する制度、期限、必要書類、提出先を確認してください。' }],
  }
  return {
    serviceToken: input.AI_SERVICE_TOKEN,
    audience: env.AI_SERVICE_AUDIENCE ?? 'ai-server',
    backend: {
      baseUrl: input.BACKEND_INTERNAL_URL,
      serviceToken: input.BACKEND_INTERNAL_SERVICE_TOKEN,
      audience: input.BACKEND_SERVICE_AUDIENCE,
      timeoutMs: 10_000,
      allowInsecureHttp: new URL(input.BACKEND_INTERNAL_URL).protocol === 'http:',
      insecureHttpAllowedHosts: [new URL(input.BACKEND_INTERNAL_URL).hostname],
    },
    runtimeEncryptionKey: input.AI_RUNTIME_ENCRYPTION_KEY,
    budget: { tools: 20, research: 2, searches: 6, reads: 12, inferenceAttempts: 12, replans: 2,
      tokens: 240_000, costMicros: 2_880_000, activeMs: 120_000 },
    sectionTimeoutMs: 120_000,
    policies,
    orca: { apiKey: input.ORCAROUTER_API_KEY, timeoutMs: 30_000 },
    // The Backend control endpoint is rechecked by session.guard before every transfer.
    // This local provider list is a hackathon assumption, never a production consent record.
    grant: async () => ({ revision: 'hackathon-v1', providerPolicyIds: [...POLICY_IDS],
      dataClasses: ['minimized_case', 'public_research'], expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), maxRetentionDays: 0 }),
    recordMetric: async (metric: ProviderMetric, identity) => writeMetric({ event: 'ai_provider_attempt', ...identity, ...metric }),
    catalogs: HACKATHON_OFFICIAL_CATALOGS,
    templates: [{ id: 'burial-benefit-task', version: 'hackathon-v1', reviewedAt: approvedAt, expiresAt,
      reviewReference: 'https://www.kyoukaikenpo.or.jp/application_form/benefit/012/', procedureId: CATALOG_ID, sourceCatalogIds: [CATALOG_ID],
      task: { title: '健康保険の埋葬料（費）を確認する', summary: '加入状況と申請者の関係に応じて、支給条件と必要書類を確認します。',
        stage: 'government', category: 'insurance-benefit', submitTo: '全国健康保険協会', evidenceRequired: true, assetDisposal: false },
      prerequisites: [], requiredDocuments: ['健康保険埋葬料（費）支給申請書', '死亡を確認できる書類', '申請者と亡くなった方の関係を確認できる書類'],
    }],
    researchScope: async context => {
      if (context.content.operation !== 'chat_reply') return scope
      const message = context.content.message
      const body = message && typeof message === 'object' && 'body' in message && typeof message.body === 'string' ? message.body : ''
      // Keep the reviewed, detailed benefit questions when the consultation is
      // about Kyoukaikenpo. Other supported topics use the wider catalog scope.
      return /協会けんぽ|全国健康保険協会|埋葬料|埋葬費|家族埋葬料/u.test(body) ? scope : chatScope
    },
    maxSourceAgeMs: 15 * 60_000,
    sourceTimeoutMs: 8_000,
    // 非本番のハッカソン限定。reviewStatus が draft の Definition でも案内を試せる。
    allowDraftDefinitions: true,
  }
}
