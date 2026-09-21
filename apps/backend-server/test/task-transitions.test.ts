import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TaskStatus } from '../src/domain/task/task.js'
import { ALL_TASK_COMMANDS, isAllowedTransition, isTerminal, targetStatus } from '../src/domain/task/transitions.js'

const ALL_STATUSES: TaskStatus[] = [
  'NOT_STARTED',
  'COLLECTING_INFORMATION',
  'WAITING_DOCUMENTS',
  'READY',
  'SUBMITTED',
  'WAITING_EXTERNAL',
  'ACTION_REQUIRED',
  'COMPLETED',
  'ESCALATED',
]

describe('Task の状態遷移', () => {
  it('既存の全状態が遷移表に現れる', () => {
    const covered = new Set<TaskStatus>()
    for (const command of ALL_TASK_COMMANDS) {
      covered.add(targetStatus(command))
      for (const status of ALL_STATUSES) {
        if (isAllowedTransition(command, status)) covered.add(status)
      }
    }
    for (const status of ALL_STATUSES) {
      assert.ok(covered.has(status), `${status} が遷移表に無い`)
    }
  })

  it('準備完了・提出報告・完了を別の状態にする', () => {
    assert.equal(targetStatus('markReady'), 'READY')
    assert.equal(targetStatus('reportSubmission'), 'SUBMITTED')
    assert.equal(targetStatus('awaitExternal'), 'WAITING_EXTERNAL')
    assert.equal(targetStatus('complete'), 'COMPLETED')
  })

  it('提出の報告は準備完了の後だけ行える', () => {
    assert.equal(isAllowedTransition('reportSubmission', 'READY'), true)
    assert.equal(isAllowedTransition('reportSubmission', 'NOT_STARTED'), false)
    assert.equal(isAllowedTransition('reportSubmission', 'COLLECTING_INFORMATION'), false)
  })

  it('完了済みから再度完了できない', () => {
    assert.equal(isAllowedTransition('complete', 'COMPLETED'), false)
    assert.equal(isAllowedTransition('reopen', 'COMPLETED'), true)
  })

  it('引き継ぎ済みからは再開しない', () => {
    for (const command of ALL_TASK_COMMANDS) {
      assert.equal(isAllowedTransition(command, 'ESCALATED'), false, `${command} が ESCALATED から通る`)
    }
  })

  it('終了状態を区別する', () => {
    assert.equal(isTerminal('COMPLETED'), true)
    assert.equal(isTerminal('ESCALATED'), true)
    assert.equal(isTerminal('READY'), false)
  })
})
