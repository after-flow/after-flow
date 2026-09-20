import { z } from 'zod'
import { defineRoute, ok } from '../../../http/route.js'
import { successEnvelope } from '../../../schemas/common.js'

const healthSchema = z.object({
  service: z.literal('backend-server'),
  status: z.literal('ok'),
})

/**
 * プロセスの生存確認のみ。
 * Firestore・AI・Orch への疎通は含めないため、この 200 を業務機能の
 * 準備完了として扱わない。
 */
export const healthRoute = defineRoute(
  {
    operationId: 'getHealth',
    method: 'get',
    path: '/health',
    summary: 'プロセスの生存確認',
    description:
      '公開サーバーが要求を受け付けられることだけを示す。依存サービスの疎通や業務機能の準備完了は意味しない。',
    tags: ['system'],
    auth: 'public',
    success: { status: 200, description: '稼働中', schema: successEnvelope(healthSchema) },
    failures: ['INTERNAL'],
  },
  (c) => ok(c, { service: 'backend-server', status: 'ok' } as const),
)
