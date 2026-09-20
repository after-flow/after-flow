import { z } from 'zod'
import { parse } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'
import type { ResearchProvider } from '../mastra/tools/research.js'
import { sourceCandidateSchema, sourceDocumentSchema } from '../../orchestration/research/sources.js'
import type { SourceCandidate } from '../../orchestration/research/sources.js'
import { fetchOfficialText, validateOfficialUrl } from './safe-https.js'

const entrySchema = sourceCandidateSchema.extend({ keywords: z.array(z.string().min(1).max(100)).min(1).max(30) }).strict()
export const officialCatalogSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/), version: z.string().min(1).max(100),
  reviewedAt: z.string().datetime(), expiresAt: z.string().datetime(), reviewReference: z.string().min(1).max(500),
  allowedHosts: z.array(z.string().min(1).max(253)).min(1).max(50),
  entries: z.array(entrySchema).min(1).max(500),
}).strict()
export type OfficialCatalog = z.infer<typeof officialCatalogSchema>
export interface OfficialResponse { body: string; contentType: 'text/html' | 'text/plain' }

/** Search is local to reviewed metadata; external search vendors are an independent adapter. */
export function createOfficialCatalogProvider(inputs: readonly OfficialCatalog[], options: {
  fetchText?: (url: string, allowedHosts: readonly string[], signal: AbortSignal) => Promise<OfficialResponse>
  now?: () => number
} = {}): ResearchProvider {
  if (!inputs.length || inputs.length > 20) throw new Error('Reviewed source catalogs are required')
  const now = options.now ?? Date.now
  const catalogs = new Map<string, OfficialCatalog>()
  const entries = new Map<string, z.infer<typeof entrySchema>>()
  for (const input of inputs) {
    const catalog = officialCatalogSchema.parse(input)
    if (catalogs.has(catalog.id) || new Set(catalog.allowedHosts).size !== catalog.allowedHosts.length || Date.parse(catalog.expiresAt) <= Date.parse(catalog.reviewedAt)) throw new Error('Invalid reviewed catalog')
    for (const entry of catalog.entries) {
      if (entries.has(entry.id) || entry.catalogId !== catalog.id) throw new Error('Source identity collision')
      validateOfficialUrl(entry.url, catalog.allowedHosts)
      entries.set(entry.id, entry)
    }
    catalogs.set(catalog.id, catalog)
  }
  const active = (id: string) => {
    const catalog = catalogs.get(id)
    if (!catalog || Date.parse(catalog.reviewedAt) > now() || Date.parse(catalog.expiresAt) <= now()) throw new Error('Official catalog is not current')
    return catalog
  }
  return {
    async search({ query, catalogIds, signal }) {
      signal.throwIfAborted()
      if (!query.trim() || query.length > 600 || !catalogIds.length || catalogIds.length > 10) throw new Error('Invalid catalog query')
      const terms = [...new Set(query.normalize('NFKC').toLocaleLowerCase('ja').split(/\s+/).filter(Boolean))]
      const candidates = [...new Set(catalogIds)].flatMap(id => active(id).entries).map(entry => {
        const text = [entry.title, entry.issuer, ...entry.keywords].join(' ').normalize('NFKC').toLocaleLowerCase('ja')
        return { entry, score: terms.filter(term => text.includes(term)).length }
      }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, 10)
      return candidates.map(({ entry }) => candidateOf(entry))
    },
    async read({ candidate, signal }) {
      signal.throwIfAborted()
      const parsed = sourceCandidateSchema.parse(candidate); const entry = entries.get(parsed.id)
      if (!entry || Object.entries(parsed).some(([key, value]) => entry[key as keyof SourceCandidate] !== value)) throw new Error('Source is not an exact catalog entry')
      const catalog = active(entry.catalogId)
      const result = await (options.fetchText ?? fetchOfficialText)(entry.url, catalog.allowedHosts, signal)
      signal.throwIfAborted(); active(entry.catalogId)
      const text = extractOfficialText(result)
      return sourceDocumentSchema.parse({ ...candidateOf(entry), text, location: result.contentType === 'text/html' ? 'HTML本文（ページ全体）' : 'テキスト本文（全体）',
        fetchedAt: new Date(now()).toISOString(), updatedAt: null })
    },
  }
}
const candidateOf = (entry: z.infer<typeof entrySchema>): SourceCandidate => ({ id: entry.id, catalogId: entry.catalogId, title: entry.title, issuer: entry.issuer, url: entry.url })

export function extractOfficialText(response: OfficialResponse): string {
  if (Buffer.byteLength(response.body) > 524288) throw new Error('Official source body is too large')
  let text: string
  if (response.contentType === 'text/plain') text = response.body
  else if (response.contentType === 'text/html') {
    const stack: DefaultTreeAdapterMap['node'][] = [parse(response.body)]
    const parts: string[] = []
    const ignored = new Set(['head', 'script', 'style', 'noscript', 'template', 'iframe', 'object', 'svg', 'form', 'canvas'])
    while (stack.length) {
      const node = stack.pop()!
      if ('tagName' in node && ignored.has(node.tagName)) continue
      if ('value' in node && node.nodeName === '#text') parts.push(node.value)
      if ('childNodes' in node) stack.push(...[...node.childNodes].reverse())
    }
    text = parts.join(' ')
  } else throw new Error('Unsupported official source type')
  text = text.replace(/\s+/g, ' ').trim()
  if (!text || text.length > 60000) throw new Error('Official source text is empty or too large')
  return text
}
