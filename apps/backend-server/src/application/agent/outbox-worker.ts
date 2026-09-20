import { setTimeout } from 'node:timers/promises'
import type { OutboxDispatcher, LocalOutboxHandler } from './outbox-dispatcher.js'
import type { TaskService } from '../task/task-service.js'
import type { AgentDeliveryOutcome } from '../ports/agent-client.js'
import { logger } from '../../presentation/http/logger.js'

/** 初期Taskと期限再評価はBackend内のCommand。外部AI同意を必要としない。 */
export function caseTaskHandler(tasks: TaskService): LocalOutboxHandler {
  return {
    types: new Set(['case.created', 'case.reference_dates_changed']),
    async deliverLocal(event): Promise<AgentDeliveryOutcome> {
      if (!event.caseId || !event.initiatedByUserId) return { status: 'REJECTED', reason: 'MISSING_CASE_ACTOR' }
      const user = { tenantId: event.tenantId, userId: event.initiatedByUserId }
      const meta = { requestId: event.id, idempotency: null }
      // payloadの起算日は使わない。遅着・再配送時にも最新のCaseを読み直す。
      if (event.type === 'case.created') await tasks.generateInitialTasks(user, event.caseId, meta)
      await tasks.reevaluateDeadlines(user, event.caseId, meta)
      return { status: 'ACCEPTED' }
    },
  }
}

export function combineLocalHandlers(...handlers: LocalOutboxHandler[]): LocalOutboxHandler {
  return { types: new Set(handlers.flatMap(h => [...h.types])),
    deliverLocal: event => handlers.find(h => h.types.has(event.type))!.deliverLocal(event) }
}

/** HTTP要求から独立した管理対象ループ。終了時は実行中のバッチを待って閉じる。 */
export async function runOutboxWorker(
  dispatcher: Pick<OutboxDispatcher, 'dispatchBatch' | 'backlog'>,
  options: { tenantIds: string[]; intervalMs: number; signal: AbortSignal; once?: boolean;
    reconciler?: { tick(tenantId: string): Promise<{ checked: number; failed: number }> } },
): Promise<void> {
  do {
    for (const tenantId of options.tenantIds) {
      if (options.signal.aborted) return
      try {
        const result = await dispatcher.dispatchBatch(tenantId)
        const reconciliation = await options.reconciler?.tick(tenantId)
        const backlog = await dispatcher.backlog(tenantId)
        logger.info('outbox worker tick', { tenantId, delivered: result.delivered.length,
          retrying: result.retrying.length, blocked: result.blocked.length, rejected: result.rejected.length, ...backlog, reconciliation })
      } catch {
        logger.error('outbox worker tick failed', { tenantId })
        if (options.once) throw new Error('outbox worker tick failed')
      }
    }
    if (options.once) return
    try { await setTimeout(options.intervalMs, undefined, { signal: options.signal }) }
    catch { if (!options.signal.aborted) throw new Error('worker timer failed') }
  } while (!options.signal.aborted)
}
