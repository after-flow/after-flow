import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guidanceWorkflowAction } from '../src/infrastructure/execution/handlers.js'
import { ClassifiedExecutionError, classifyWorkflowFailure } from '../src/application/execution/contracts.js'

test('a newly persisted pending guidance run starts while an interrupted running run restarts', () => {
  assert.equal(guidanceWorkflowAction(null), 'start')
  assert.equal(guidanceWorkflowAction('pending'), 'start')
  assert.equal(guidanceWorkflowAction('running'), 'restart')
  assert.equal(guidanceWorkflowAction('success'), 'complete')
  assert.equal(guidanceWorkflowAction('failed'), 'fail')
})

test('#183 failures use bounded public classifications and keep validation separate from provider failure', () => {
  const cases = [
    [new Error('Structured output validation failed: private model output omitted'), 'OUTPUT_CONTRACT_REJECTED'],
    [new Error('Unresolved research cannot produce complete guidance'), 'EVIDENCE_INSUFFICIENT'],
    [new Error('Research Agent did not return validated findings'), 'RESEARCH_UNAVAILABLE'],
    [new Error('CONTEXT_CHANGED'), 'CONTEXT_CHANGED'],
    [new Error('Provider request failed: TRANSIENT'), 'PROVIDER_UNAVAILABLE'],
    [new Error('BUDGET_EXCEEDED'), 'BUDGET_EXCEEDED'],
    [new Error('unclassified detail'), 'EXECUTION_FAILED'],
  ] as const
  for (const [error, expected] of cases) assert.equal(classifyWorkflowFailure(error), expected)
  for (const code of ['CANCELLED', 'TIME_LIMIT', 'OUTPUT_CONTRACT_REJECTED'] as const) {
    assert.equal(classifyWorkflowFailure(new ClassifiedExecutionError(code)), code)
  }
})
