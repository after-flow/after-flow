import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { DispatchVault } from '../src/infrastructure/runtime-storage/credential-vault.js'

test('runtime credential encryption binds ciphertext to Job and rejects wrong keys/tampering', () => {
  const vault = new DispatchVault(randomBytes(32).toString('base64'))
  const dispatch = { jobId: 'job', runId: 'run', executionAttempt: 'attempt', operation: 'task_guidance' as const, issuedAt: 1, expiresAt: 60, executionAuthorization: 'secret-capability' }
  const ciphertext = vault.seal(dispatch)
  assert.equal(ciphertext.includes(dispatch.executionAuthorization), false)
  assert.deepEqual(vault.open(ciphertext, 'job'), dispatch)
  assert.throws(() => vault.open(ciphertext, 'other-job'), /cannot be decrypted/)
  const corrupt = Buffer.from(ciphertext, 'base64'); corrupt[30] = corrupt[30]! ^ 1
  assert.throws(() => vault.open(corrupt.toString('base64'), 'job'), /cannot be decrypted/)
  assert.throws(() => new DispatchVault(randomBytes(32).toString('base64')).open(ciphertext, 'job'), /cannot be decrypted/)
  assert.throws(() => new DispatchVault(''), /256-bit/)
})
