import { z } from 'zod'
import { orcaSdkProvider } from '../orcarouter/models.js'
import type { AiServiceComposition } from './composition.js'
import type { ProviderMetric } from '../mastra/authorized-models.js'

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

const REVIEW_REFERENCE = 'hackathon-demo-2026-09-21; OrcaRouter gateway and public provider terms must be reviewed before production'
const CATALOG_ID = 'kyoukaikenpo-burial-benefit'
const POLICY_IDS = ['orca-core-primary', 'orca-core-fallback'] as const

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

  const now = Date.now()
  const approvedAt = new Date(now - 60_000).toISOString()
  const expiresAt = new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString()
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
    currency: 'USD', maxInputTokens: 16_000, maxOutputTokens: 1_000,
    // Conservative demo reservation bounds, not a billing quote.
    inputMicrosPerToken: 10, outputMicrosPerToken: 20,
  }))
  const scope = {
    id: 'burial-benefit-guidance', version: 'hackathon-v1', reviewedAt: approvedAt,
    procedure: '健康保険の埋葬料（費）支給申請', institution: '全国健康保険協会', jurisdiction: '日本', municipality: null,
    taskTitles: ['健康保険の埋葬料（費）を確認する'], taskCategories: ['insurance-benefit'], sourceCatalogIds: [CATALOG_ID],
    questions: [
      { id: 'eligibility', text: '申請できる人と支給条件を確認してください。' },
      { id: 'documents', text: '主な必要書類と条件による追加書類を確認してください。' },
      { id: 'deadline', text: '申請期限と起算日を確認してください。' },
    ],
    caseApplicabilityQuestions: [
      '亡くなった方が加入していた健康保険を確認してください。',
      '申請者と亡くなった方の関係、および実際に埋葬費用を負担した方を確認してください。',
    ],
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
    budget: { tools: 20, research: 2, searches: 6, reads: 12, inferenceAttempts: 8, replans: 2,
      tokens: 136_000, costMicros: 1_440_000, activeMs: 120_000 },
    sectionTimeoutMs: 120_000,
    policies,
    orca: { apiKey: input.ORCAROUTER_API_KEY, timeoutMs: 30_000 },
    // The Backend control endpoint is rechecked by session.guard before every transfer.
    // This local provider list is a hackathon assumption, never a production consent record.
    grant: async () => ({ revision: 'hackathon-v1', providerPolicyIds: [...POLICY_IDS],
      dataClasses: ['minimized_case', 'public_research'], expiresAt: new Date(Date.now() + 30_000).toISOString(), maxRetentionDays: 0 }),
    recordMetric: async (metric: ProviderMetric, identity) => writeMetric({ event: 'ai_provider_attempt', ...identity, ...metric }),
    catalogs: [{
      id: CATALOG_ID, version: '2026-09-21', reviewedAt: approvedAt, expiresAt,
      reviewReference: 'https://www.kyoukaikenpo.or.jp/application_form/benefit/012/',
      allowedHosts: ['www.kyoukaikenpo.or.jp'],
      entries: [
        { id: 'burial-application', catalogId: CATALOG_ID, title: '健康保険埋葬料（費）支給申請書', issuer: '全国健康保険協会',
          url: 'https://www.kyoukaikenpo.or.jp/application_form/benefit/012/', keywords: ['埋葬料', '埋葬費', '必要書類', '申請期限', '死亡'] },
        { id: 'burial-benefit', catalogId: CATALOG_ID, title: '埋葬料・埋葬費', issuer: '全国健康保険協会',
          url: 'https://www.kyoukaikenpo.or.jp/benefit/burial_charges/', keywords: ['埋葬料', '埋葬費', '支給条件', '死亡'] },
      ],
    }],
    templates: [{ id: 'burial-benefit-task', version: 'hackathon-v1', reviewedAt: approvedAt, expiresAt,
      reviewReference: 'https://www.kyoukaikenpo.or.jp/application_form/benefit/012/', sourceCatalogIds: [CATALOG_ID],
      task: { title: '健康保険の埋葬料（費）を確認する', summary: '加入状況と申請者の関係に応じて、支給条件と必要書類を確認します。',
        stage: 'government', category: 'insurance-benefit', submitTo: '全国健康保険協会', evidenceRequired: true, assetDisposal: false },
      prerequisites: [], requiredDocuments: ['健康保険埋葬料（費）支給申請書', '死亡を確認できる書類', '申請者と亡くなった方の関係を確認できる書類'],
    }],
    researchScope: async () => scope,
    maxSourceAgeMs: 15 * 60_000,
    sourceTimeoutMs: 8_000,
  }
}
