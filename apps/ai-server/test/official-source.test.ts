import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createOfficialCatalogProvider, extractOfficialText } from '../src/infrastructure/research/official-catalog.js'
import type { OfficialCatalog } from '../src/infrastructure/research/official-catalog.js'
import { isPublicSourceAddress, pinnedSourceRequest, validateOfficialUrl, readOfficialResponse } from '../src/infrastructure/research/safe-https.js'

const time = Date.parse('2026-09-20T00:00:00Z')
const catalog: OfficialCatalog = {
  id: 'synthetic', version: '1', reviewedAt: '2026-09-19T00:00:00Z', expiresAt: '2026-09-21T00:00:00Z', reviewReference: 'fixture-only',
  allowedHosts: ['official.example'], entries: [{ id: 'fixture-source', catalogId: 'synthetic', title: '合成手続きの資料', issuer: '合成窓口', url: 'https://official.example/procedure', keywords: ['必要書類'] }],
}
const signal = new AbortController().signal

test('source URL and DNS gates reject internal/special destinations and pin the validated address', async () => {
  for (const url of ['http://official.example/a', 'https://other.example/a', 'https://official.example.evil/a', 'https://official.example:8080/a',
    'https://user:pass@official.example/a', 'https://official.example/a?token=secret', 'https://official.example/a#fragment', 'https://127.0.0.1/a', 'https://2130706433/a']) {
    assert.throws(() => validateOfficialUrl(url, ['official.example']), /not allowed/)
  }
  for (const address of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1']) assert.equal(isPublicSourceAddress(address), false, address)
  const url = validateOfficialUrl('https://official.example/source', ['official.example'])
  await assert.rejects(pinnedSourceRequest(url, signal, async () => [{ address: '93.184.215.14', family: 4 }, { address: '127.0.0.1', family: 4 }]), /not public/)
  await assert.rejects(pinnedSourceRequest(url, signal, async () => []), /not public/)
  let resolutions = 0
  const options = await pinnedSourceRequest(url, signal, async () => { resolutions++; return [{ address: '93.184.215.14', family: 4 }] })
  assert.equal(options.rejectUnauthorized, true); assert.equal(options.servername, url.hostname); assert.equal(options.agent, false)
  assert.ok(options.lookup)
  const result = await new Promise<unknown>((resolve, reject) => options.lookup!('attacker.example', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)))
  assert.deepEqual(result, [{ address: '93.184.215.14', family: 4 }]); assert.equal(resolutions, 1)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(pinnedSourceRequest(url, abort.signal, async () => { throw new Error('must not resolve') }))
})

test('catalog search is scoped and retrieval revalidates identity and review expiry', async () => {
  let now = time; let reads = 0
  const provider = createOfficialCatalogProvider([catalog], { now: () => now, fetchText: async (url, hosts) => {
    reads++; assert.equal(url, catalog.entries[0]!.url); assert.deepEqual(hosts, catalog.allowedHosts)
    return { body: '<html><head><title>ignore</title></head><body><h1>必要書類</h1><p>合成資料を持参</p><script>sendSecrets()</script></body></html>', contentType: 'text/html' }
  } })
  const candidates = await provider.search({ query: '必要書類', catalogIds: ['synthetic'], signal })
  assert.equal(candidates.length, 1)
  assert.equal((await provider.search({ query: '無関係', catalogIds: ['synthetic'], signal })).length, 0)
  await assert.rejects(provider.search({ query: '必要書類', catalogIds: ['unapproved'], signal }), /not current/)
  await assert.rejects(provider.read({ candidate: { ...candidates[0]!, url: 'https://official.example/different' }, signal }), /exact catalog/)
  assert.equal(reads, 0)
  const document = await provider.read({ candidate: candidates[0]!, signal })
  assert.equal(document.text, '必要書類 合成資料を持参'); assert.equal(document.updatedAt, null)
  assert.equal(document.fetchedAt, new Date(time).toISOString())
  now += 86400000
  await assert.rejects(provider.read({ candidate: candidates[0]!, signal }), /not current/)
  assert.equal(reads, 1)
  assert.throws(() => createOfficialCatalogProvider([]), /required/)
  assert.throws(() => createOfficialCatalogProvider([catalog, catalog]), /Invalid/)
})

test('HTML parsing excludes executable/embedded content and rejects oversized or empty text', () => {
  assert.equal(extractOfficialText({ contentType: 'text/html', body: '<p>A &amp; B</p><template>hidden</template><iframe>hidden</iframe><style>hidden</style><form>private</form>' }), 'A & B')
  assert.throws(() => extractOfficialText({ contentType: 'text/plain', body: 'x'.repeat(60001) }), /too large/)
  assert.throws(() => extractOfficialText({ contentType: 'text/html', body: '<script>only-script</script>' }), /empty/)
})


test('HTTP body reader rejects redirects, binary/compressed bodies, oversized streams, bad UTF-8 and abort', async () => {
  const response = (statusCode: number, type: string, chunks: Uint8Array[], encoding?: string) => Object.assign(Readable.from(chunks), {
    statusCode, headers: { 'content-type': type, ...(encoding ? { 'content-encoding': encoding } : {}) },
  })
  for (const input of [
    response(302, 'text/html', []), response(200, 'application/pdf', []), response(200, 'text/html', [], 'gzip'),
    response(200, 'text/html; charset=Shift_JIS', []), response(200, 'text/plain', [Buffer.alloc(524289)]),
    response(200, 'text/plain', [Buffer.from([0xff, 0xfe])]),
  ]) {
    await assert.rejects(readOfficialResponse(input, signal), /rejected/)
    assert.equal(input.destroyed, true)
  }
  const abort = new AbortController(); abort.abort()
  await assert.rejects(readOfficialResponse(response(200, 'text/plain', [Buffer.from('data')]), abort.signal), /rejected/)
  assert.deepEqual(await readOfficialResponse(response(200, 'text/plain; charset=utf-8', [Buffer.from('合成')]), signal), { body: '合成', contentType: 'text/plain' })
})
