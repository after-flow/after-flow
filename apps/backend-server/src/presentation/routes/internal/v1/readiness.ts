import { Hono } from 'hono'
import type { ReadinessService } from '../../../../application/operations/readiness-service.js'
import { matchesServiceCredential } from '../../../../infrastructure/identity/execution-authorization.js'
import { errors } from '../../../../shared/app-error.js'
import type { AppContext, AppEnv } from '../../../http/context.js'
import { ok } from '../../../http/envelope.js'

/**
 * 内部readiness endpoint（本番稼働可能性）。
 *
 * `/api/v1/health`（公開・無認証・liveness専用）とは別契約。この endpoint は
 * どちらのOpenAPI（公開/内部AI実行API）にも載せない。ブラウザーとAIには渡さない
 * 専用のアクセス制御（`READINESS_ACCESS_TOKEN`）を持つデプロイ/運用ツール専用の契約であり、
 * `docs/runbooks/readiness.md` がこの endpoint の正本ドキュメント。
 *
 * `backend-server` のCloud RunはAI Serverと異なり公開許可（unauthenticated invoker）が
 * 前提のため、Cloud RunのIAM検査だけでは守れない。ここのBearer tokenがアプリ層の唯一の壁。
 */
export interface ReadinessRouteOptions {
  service: ReadinessService
  /** 運用/デプロイツール専用の資格情報。AI・ブラウザーには絶対に配布しない。 */
  accessToken: string
}

export function createReadinessApp(options: ReadinessRouteOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // '*' ではなく自分の担当path（'/health/ready'）に絞る。他のinternal app
  // （AI実行API。別のアクセス制御を持つ）と同じ '/internal/v1' prefixに
  // mountされても、このmiddlewareがそちらのpath（/internal/v1/runs/...）まで
  // 奪って readiness token を要求しないため。
  app.use('/health/ready', async (c, next) => {
    const authorization = c.req.header('Authorization') ?? ''
    if (!matchesServiceCredential(authorization, `Bearer ${options.accessToken}`)) {
      throw errors.unauthenticated({ internal: { reason: 'invalid readiness access token' } })
    }
    await next()
  })

  app.get('/health/ready', async (c: AppContext) => {
    const report = await options.service.evaluate()
    if (report.status === 'ready') return ok(c, report)
    // 503 (UNAVAILABLE) は再試行可能。本文に各検査の固定理由コードだけを含める。
    throw errors.unavailable({
      message: 'readiness checks failed',
      details: { status: report.status, checkedAt: report.checkedAt, checks: report.checks },
    })
  })

  return app
}
