import { errors } from '../../shared/app-error.js'

export const notFound = (what: string, id: string) => errors.notFound({ details: { resource: what, id } })
export const forbidden = (message = 'この操作を行う権限がありません') => errors.forbidden({ message })
export const versionConflict = (expected: number, actual: number) => errors.conflict({
  details: { expectedVersion: expected, actualVersion: actual },
})
export const invalidTransition = (from: string, to: string, reason?: string) => errors.preconditionFailed({
  message: reason ?? `${from} から ${to} へは遷移できません`, details: { from, to },
})
export const validation = (message: string, details?: Record<string, unknown>) => errors.validationFailed({ message, details })
export const duplicate = (message: string, details?: Record<string, unknown>) => errors.conflict({ message, details })
export const referenced = (message: string, details?: Record<string, unknown>) => errors.preconditionFailed({ message, details })
export function assertVersion(actual: number, expected: number): void {
  if (actual !== expected) throw versionConflict(expected, actual)
}
