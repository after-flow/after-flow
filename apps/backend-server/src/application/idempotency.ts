import type { CommandContext } from './context.js'
import type { IdempotencyStore } from './ports.js'

export interface CommandResult<T> {
  statusCode: number
  body: T
}

/** 冪等性だけでなく業務変更・監査も同一 Transaction で保存する。 */
export function runIdempotent<T>(
  ctx: CommandContext,
  store: IdempotencyStore,
  operation: string,
  input: unknown,
  execute: () => Promise<CommandResult<T>>,
): Promise<CommandResult<T>> {
  return store.run(ctx, operation, input, execute)
}
