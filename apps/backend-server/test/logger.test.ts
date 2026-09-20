import assert from 'node:assert/strict'
import { it } from 'node:test'
import { logger } from '../src/presentation/http/logger.js'

it('例外の自由文と秘密キーをログへ残さない', (t) => {
  const lines: string[] = []
  t.mock.method(console, 'error', (line: string) => lines.push(line))
  const cause = new Error('postgres://user:pw@host')
  cause.name = 'sensitive-name'
  logger.error('request failed', { cause, nested: { token: 'secret-value' } })
  assert.equal(lines.length, 1)
  assert.ok(!lines[0]?.includes('postgres'))
  assert.ok(!lines[0]?.includes('sensitive-name'))
  assert.ok(!lines[0]?.includes('secret-value'))
})
