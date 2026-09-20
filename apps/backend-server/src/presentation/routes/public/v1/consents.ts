import type { ConsentService } from '../../../../application/consent/consent-service.js'
import { fingerprintOf } from '../../../../shared/fingerprint.js'
import { requireUser } from '../../../http/authentication.js'
import type { AppContext } from '../../../http/context.js'
import { ok } from '../../../http/envelope.js'
import type { RegisteredRoute, RouteSpec } from '../../../http/route.js'
import { defineRoute } from '../../../http/route.js'
import { successEnvelope } from '../../../schemas/common.js'
import {
  agreeConsentsBodySchema,
  consentStatusResourceSchema,
  revokeConsentBodySchema,
} from '../../../schemas/consent.js'

const statusEnvelope = successEnvelope(consentStatusResourceSchema)

/**
 * 同意の取得・記録・撤回。
 *
 * これらの route 自体は同意チェックの対象外にする。未同意のときに
 * 同意を取るための API まで塞ぐと、利用者は復旧できない。
 */
export const consentSpecs = {
  getConsents: {
    operationId: 'getConsents',
    method: 'get',
    path: '/consents',
    summary: '同意状態と利用できる範囲を取得する',
    description:
      '必須同意の不足と、任意の外部AI同意の不足を区別して返す。フロントは同意の有無から機能可否を推測しない。',
    tags: ['consents'],
    auth: 'user',
    consent: 'exempt',
    success: { status: 200, description: '同意状態', schema: statusEnvelope },
    failures: ['UNAUTHENTICATED', 'FORBIDDEN'],
  },
  agreeConsents: {
    operationId: 'agreeConsents',
    method: 'post',
    path: '/consents',
    summary: '同意を記録する',
    description: '表示した版を指定する。版が更新されていれば 409 になる。',
    tags: ['consents'],
    auth: 'user',
    consent: 'exempt',
    request: { body: agreeConsentsBodySchema },
    success: { status: 200, description: '記録後の同意状態', schema: statusEnvelope },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'CONFLICT', 'PRECONDITION_REQUIRED'],
    idempotency: 'required',
  },
  revokeConsent: {
    operationId: 'revokeConsent',
    method: 'post',
    path: '/consents/revocations',
    summary: '同意を撤回する',
    description:
      '以後の提供を止める操作。すでに送信済みのデータを回収できたことは意味しない。必須同意を撤回すると業務APIは利用できなくなる。',
    tags: ['consents'],
    auth: 'user',
    consent: 'exempt',
    request: { body: revokeConsentBodySchema },
    success: { status: 200, description: '撤回後の同意状態', schema: statusEnvelope },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'PRECONDITION_REQUIRED'],
    idempotency: 'required',
  },
} satisfies Record<string, RouteSpec>

function commandMeta(c: AppContext, idempotencyKey: string | null, body: unknown) {
  return {
    requestId: c.get('requestId') ?? null,
    idempotency: idempotencyKey ? { key: idempotencyKey, fingerprint: fingerprintOf({ method: c.req.method, path: c.req.path, body }) } : null,
  }
}

export function createConsentRoutes(service: ConsentService): RegisteredRoute[] {
  return [
    defineRoute(consentSpecs.getConsents, async (c) => {
      const user = requireUser(c)
      const [status, policy] = await Promise.all([service.status(user), service.policy(user)])
      return ok(c, { ...status, availability: policy })
    }),

    defineRoute(consentSpecs.agreeConsents, async (c, input) => {
      const user = requireUser(c)
      const status = await service.agree(
        user,
        input.body.agreements,
        commandMeta(c, input.idempotencyKey, input.body),
      )
      return ok(c, { ...status, availability: await service.policy(user) })
    }),

    defineRoute(consentSpecs.revokeConsent, async (c, input) => {
      const user = requireUser(c)
      const status = await service.revoke(
        user,
        input.body.kind,
        commandMeta(c, input.idempotencyKey, input.body),
      )
      return ok(c, { ...status, availability: await service.policy(user) })
    }),
  ]
}
