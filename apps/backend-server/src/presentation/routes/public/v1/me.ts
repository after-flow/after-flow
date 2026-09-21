import type { RegistrationService } from '../../../../application/identity/registration-service.js'
import { errors } from '../../../../shared/app-error.js'
import { fingerprintOf } from '../../../../shared/fingerprint.js'
import { requireIdentity } from '../../../http/authentication.js'
import type { AppContext } from '../../../http/context.js'
import { ok } from '../../../http/envelope.js'
import type { RegisteredRoute, RouteSpec } from '../../../http/route.js'
import { defineRoute } from '../../../http/route.js'
import { successEnvelope } from '../../../schemas/common.js'
import { meResourceSchema } from '../../../schemas/me.js'

const meEnvelope = successEnvelope(meResourceSchema)

/**
 * 認証済み利用者自身の登録状態。
 *
 * `auth:'identity'` はトークン検証済みであれば足り、tenant membership の
 * 有無（未登録）でも到達できる唯一の公開 route 群。`POST /me` が唯一の
 * 登録経路（ADR 0001 §2「所属・権限の付与と変更は Backend が制御する」）。
 */
export const meSpecs = {
  getMe: {
    operationId: 'getMe',
    method: 'get',
    path: '/me',
    summary: '自分の登録状態を確認する',
    description: '未登録・停止済みでも 200 で状態を返す。書き込みは行わない。',
    tags: ['me'],
    auth: 'identity',
    consent: 'exempt',
    success: { status: 200, description: '登録状態', schema: meEnvelope },
    failures: ['UNAUTHENTICATED'],
  },
  registerMe: {
    operationId: 'registerMe',
    method: 'post',
    path: '/me',
    summary: '自分を利用者として登録する',
    description:
      '初回登録。既に membership があれば新規作成せず、その状態をそのまま返す（自身が冪等）。' +
      '停止済みの利用者は 403 MEMBERSHIP_INACTIVE。',
    tags: ['me'],
    auth: 'identity',
    consent: 'exempt',
    idempotency: 'optional',
    success: { status: 201, description: '新規登録した', schema: meEnvelope },
    alternateSuccess: [{ status: 200, description: '既に登録済みだった', schema: meEnvelope }],
    failures: ['UNAUTHENTICATED', 'FORBIDDEN', 'IDEMPOTENCY_KEY_REUSED'],
  },
} satisfies Record<string, RouteSpec>

function requestIdOfOrNull(c: AppContext): string | null {
  return c.get('requestId') ?? null
}

export function createMeRoutes(service: RegistrationService): RegisteredRoute[] {
  return [
    defineRoute(meSpecs.getMe, async (c) => ok(c, await service.get(requireIdentity(c)))),

    defineRoute(meSpecs.registerMe, async (c, input) => {
      const identity = requireIdentity(c)
      const idempotency = input.idempotencyKey
        ? { key: input.idempotencyKey, fingerprint: fingerprintOf({ method: 'POST', path: '/me' }) }
        : null
      const { view, created } = await service.register(identity, requestIdOfOrNull(c), idempotency)
      if (!view.active) {
        throw errors.forbidden({
          message: 'この利用者は停止されています。',
          details: { reason: 'MEMBERSHIP_INACTIVE' },
        })
      }
      return ok(c, view, { status: created ? 201 : 200 })
    }),
  ]
}
