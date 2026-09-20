export type DomainErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'AUTH_NOT_CONFIGURED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_TRANSITION'
  | 'REFERENCED'
  | 'DUPLICATE'
  | 'PRECONDITION_FAILED'

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export const notFound = (what: string, id: string) =>
  new DomainError('NOT_FOUND', `${what} ${id} が見つかりません`, { resource: what, id })

export const forbidden = (message = 'この操作を行う権限がありません') =>
  new DomainError('FORBIDDEN', message)

export const versionConflict = (expected: number, actual: number) =>
  new DomainError('VERSION_CONFLICT', '他の更新と競合しました。最新の内容を読み込み直してください', {
    expectedVersion: expected,
    actualVersion: actual,
  })

export const invalidTransition = (from: string, to: string, reason?: string) =>
  new DomainError('INVALID_TRANSITION', reason ?? `${from} から ${to} へは遷移できません`, {
    from,
    to,
  })

export const validation = (message: string, details?: unknown) =>
  new DomainError('VALIDATION_ERROR', message, details)

export const duplicate = (message: string, details?: unknown) =>
  new DomainError('DUPLICATE', message, details)

export const referenced = (message: string, details?: unknown) =>
  new DomainError('REFERENCED', message, details)

export function assertVersion(actual: number, expected: number): void {
  if (actual !== expected) throw versionConflict(expected, actual)
}
