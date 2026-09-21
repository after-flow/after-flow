import { logger } from '../../presentation/http/logger.js'
import { withTimeout } from '../../shared/timeout.js'
import type { ObjectStorage } from '../ports/object-storage.js'

/**
 * readiness（本番稼働可能性）の検査。
 *
 * liveness（プロセスの生存確認、`/api/v1/health`）とは別の契約。
 * ここでの成功は「必須依存が実際に疎通できる／業務レビュー済みの設定である」ことだけを意味し、
 * Mastra/Orch の機能的な準備完了や、認証Provider・同意カタログ・期限ルールの内容そのものの
 * 正しさは保証しない（それらは #127-#129 の決定事項）。
 *
 * 秘密値・個人情報を含む可能性がある例外の message や cause は、この層より外へ
 * そのまま出さない。呼び出し側が受け取れるのは固定の理由コードだけにする。
 */
export interface ReadinessCheckResult {
  ok: boolean
  /** 秘密値・個人情報を含まない固定の理由コード。応答へそのまま出す前提。 */
  reason?: string
}

export interface ReadinessCheck {
  /** 応答・ログに出す検査名。安定した識別子として扱う。 */
  name: string
  run(): Promise<ReadinessCheckResult>
}

export type DependencyStatus = 'ok' | 'fail'

export interface DependencyReport {
  name: string
  status: DependencyStatus
  reason?: string
}

export interface ReadinessReport {
  status: 'ready' | 'not_ready'
  checkedAt: string
  checks: DependencyReport[]
}

const DEFAULT_CHECK_TIMEOUT_MS = 3_000
const TIMEOUT_REASON = 'CHECK_TIMEOUT'

export class ReadinessService {
  constructor(
    private readonly checks: ReadinessCheck[],
    private readonly timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS,
  ) {}

  async evaluate(): Promise<ReadinessReport> {
    const checks = await Promise.all(this.checks.map((check) => this.runOne(check)))
    const status = checks.every((check) => check.status === 'ok') ? 'ready' : 'not_ready'
    return { status, checkedAt: new Date().toISOString(), checks }
  }

  private async runOne(check: ReadinessCheck): Promise<DependencyReport> {
    try {
      const result = await withTimeout(check.run(), this.timeoutMs, TIMEOUT_REASON)
      if (result.ok) return { name: check.name, status: 'ok' }
      return { name: check.name, status: 'fail', ...(result.reason ? { reason: result.reason } : {}) }
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.message === TIMEOUT_REASON
      // 例外の message/cause は接続先や内部状態を含みうるため、名前だけログへ残す。
      logger.warn('readiness check failed', { check: check.name, timedOut })
      return { name: check.name, status: 'fail', reason: timedOut ? TIMEOUT_REASON : 'CHECK_FAILED' }
    }
  }
}

/** 設定は存在するが未接続・未実施であることを表す固定理由。 */
export function notConfiguredCheck(name: string, reason = 'NOT_CONFIGURED'): ReadinessCheck {
  return { name, run: async () => ({ ok: false, reason }) }
}

/** すでに読み込み済みの設定値から同期的に判定する検査。 */
export function syncCheck(name: string, evaluate: () => ReadinessCheckResult): ReadinessCheck {
  return { name, run: async () => evaluate() }
}

/**
 * 原本Storageの疎通。
 *
 * 存在しないキーの `exists` を使う。書き込み・削除を伴わず、原本を
 * 増やさずに実際の資格情報・ネットワーク到達性だけを確かめられる。
 */
export function objectStorageReadinessCheck(name: string, storage: ObjectStorage): ReadinessCheck {
  return {
    name,
    async run() {
      await storage.exists('__readiness-probe__')
      return { ok: true }
    },
  }
}
