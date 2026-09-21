import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { AgentRunResource, GuidanceResource } from '@aftercare/public-contracts'
import { ApiError } from './client'
import { restartTimedOutGuidance } from './guidance-restart'

function run(version: number): AgentRunResource {
  return {
    id: 'run-1', caseId: 'case-1', operation: 'task_guidance', status: 'RUNNING', targetType: 'TASK', targetId: 'task-1',
    attempt: 1, waiting: false, waitingFor: null, failureReason: null, outcome: null, caseVersionAtAccept: 1,
    startedAt: null, finishedAt: null, allowedActions: ['cancel'], version,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

const guidance = { taskId: 'task-1' } as GuidanceResource

it('cancelのversion conflict後に最新Runを取得して再試行する', async () => {
  const versions = [3, 4]
  const cancelled: number[] = []
  let requested = 0
  const result = await restartTimedOutGuidance('case-1', 'task-1', 'run-1', {
    getRun: async () => run(versions.shift()!),
    cancelRun: async (_caseId, _runId, version) => {
      cancelled.push(version)
      if (version === 3) throw new ApiError(409, null, null)
      return run(version + 1)
    },
    requestGuidance: async () => { requested += 1; return guidance },
  })
  assert.equal(result, guidance)
  assert.deepEqual(cancelled, [3, 4])
  assert.equal(requested, 1)
})

it('cancelが初回と2回の再試行すべてで競合したら案内を依頼しない', async () => {
  let reads = 0
  let requested = 0
  await assert.rejects(restartTimedOutGuidance('case-1', 'task-1', 'run-1', {
    getRun: async () => run(++reads),
    cancelRun: async () => { throw new ApiError(409, null, null) },
    requestGuidance: async () => { requested += 1; return guidance },
  }), error => error instanceof ApiError && error.status === 409)
  assert.equal(reads, 3)
  assert.equal(requested, 0)
})
