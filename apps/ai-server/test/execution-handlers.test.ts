import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guidanceWorkflowAction } from '../src/infrastructure/execution/handlers.js'

test('a newly persisted pending guidance run starts while an interrupted running run restarts', () => {
  assert.equal(guidanceWorkflowAction(null), 'start')
  assert.equal(guidanceWorkflowAction('pending'), 'start')
  assert.equal(guidanceWorkflowAction('running'), 'restart')
  assert.equal(guidanceWorkflowAction('success'), 'complete')
  assert.equal(guidanceWorkflowAction('failed'), 'fail')
})
