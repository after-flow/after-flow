import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { request } from 'node:https'
import type { RequestOptions } from 'node:https'
import type { IncomingHttpHeaders } from 'node:http'
import type { OfficialResponse } from './official-catalog.js'

const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4')

export function isPublicSourceAddress(address: string) { return isIP(address) === 4 && !blocked.check(address, 'ipv4') }
export function validateOfficialUrl(value: string, allowedHosts: readonly string[]): URL {
  const url = new URL(value)
  if (value.length > 2000 || url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || url.search ||
    isIP(url.hostname) || url.hostname.endsWith('.') || !url.hostname.includes('.') || !allowedHosts.includes(url.hostname)) throw new Error('Official source URL is not allowed')
  return url
}

/** Resolve once, reject every nonpublic answer, then bind this exact address at socket lookup. */
export async function pinnedSourceRequest(url: URL, signal: AbortSignal,
  resolve: (hostname: string) => Promise<readonly { address: string; family: number }[]> = hostname => lookup(hostname, { all: true, family: 4 }),
): Promise<RequestOptions> {
  signal.throwIfAborted()
  let aborted: (() => void) | undefined
  let addresses: readonly { address: string; family: number }[]
  try {
    addresses = await Promise.race([resolve(url.hostname), new Promise<never>((_, reject) => {
      aborted = () => reject(new Error('Official source resolution interrupted'))
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
    })])
  } finally { if (aborted) signal.removeEventListener('abort', aborted) }
  signal.throwIfAborted()
  if (!addresses.length || addresses.some(item => item.family !== 4 || !isPublicSourceAddress(item.address))) throw new Error('Official source DNS is not public IPv4')
  const address = addresses[0]!.address
  return { protocol: 'https:', hostname: url.hostname, port: 443, path: url.pathname, method: 'GET',
    servername: url.hostname, rejectUnauthorized: true, agent: false, family: 4, signal,
    // No second resolver call / proxy / shared socket. Certificate identity remains the original hostname.
    lookup: (_host, options, callback) => {
      if (options.all) callback(null, [{ address, family: 4 }])
      else callback(null, address, 4)
    },
    headers: { Accept: 'text/html, text/plain', 'Accept-Encoding': 'identity', 'User-Agent': 'after-flow-official-research/1' },
  }
}

export async function fetchOfficialText(value: string, allowedHosts: readonly string[], inputSignal: AbortSignal): Promise<OfficialResponse> {
  const url = validateOfficialUrl(value, allowedHosts)
  const signal = AbortSignal.any([inputSignal, AbortSignal.timeout(10000)])
  try {
    const options = await pinnedSourceRequest(url, signal)
    return await new Promise<OfficialResponse>((resolve, reject) => {
      const req = request(options, response => {
        void readOfficialResponse(response, signal).then(resolve, reject)
      })
      req.on('error', reject); req.end()
    })
  } catch { throw new Error('Official source retrieval failed') }
}

interface SourceResponse extends AsyncIterable<Uint8Array> {
  statusCode?: number
  headers: IncomingHttpHeaders
  destroy(): void
}
export async function readOfficialResponse(response: SourceResponse, signal: AbortSignal): Promise<OfficialResponse> {
  try {
    const contentType = response.headers['content-type'] ?? ''
    const mediaType = contentType.split(';')[0]?.trim().toLowerCase()
    if (response.statusCode !== 200 || !['text/html', 'text/plain'].includes(mediaType ?? '') ||
      (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') ||
      (/charset\s*=/i.test(contentType) && !/charset\s*=\s*"?utf-8"?(?:\s*;|\s*$)/i.test(contentType))) throw new Error('Official source response is not supported')
    let size = 0; const chunks: Uint8Array[] = []
    for await (const chunk of response) {
      signal.throwIfAborted(); size += chunk.byteLength
      if (size > 524288) throw new Error('Official source response exceeds limit')
      chunks.push(chunk)
    }
    signal.throwIfAborted()
    return { body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), contentType: mediaType as OfficialResponse['contentType'] }
  } catch {
    response.destroy()
    throw new Error('Official source response rejected')
  }
}
