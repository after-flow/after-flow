import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parse } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'
import type { ResearchProvider } from '../mastra/tools/research.js'
import { sourceCandidateSchema, sourceDocumentSchema } from '../../orchestration/research/sources.js'
import type { SourceCandidate, SourceForm, SourceSection } from '../../orchestration/research/sources.js'
import { fetchOfficialText, validateOfficialUrl } from './safe-https.js'
import { extractOfficialPdf } from './pdf-text.js'

const entrySchema = sourceCandidateSchema.extend({ keywords: z.array(z.string().min(1).max(100)).min(1).max(30) }).strict()
export const officialCatalogSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/), version: z.string().min(1).max(100),
  reviewedAt: z.string().datetime(), expiresAt: z.string().datetime(), reviewReference: z.string().min(1).max(500),
  allowedHosts: z.array(z.string().min(1).max(253)).min(1).max(50),
  entries: z.array(entrySchema).min(1).max(500),
}).strict()
export type OfficialCatalog = z.infer<typeof officialCatalogSchema>
type TextResponse = { body: string; contentType: 'text/html' | 'text/plain' }
export type OfficialResponse = TextResponse | { body: Uint8Array; contentType: 'application/pdf' }

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
        const metadataTerms = [entry.title, entry.issuer, ...entry.keywords]
          .map(term => term.normalize('NFKC').toLocaleLowerCase('ja'))
        // Harness queries contain full procedure/question sentences. Match reviewed metadata in
        // either direction so a keyword such as「相続登記」also matches「不動産の相続登記をする」.
        const score = metadataTerms.filter(metadata =>
          terms.some(term => metadata.includes(term) || term.includes(metadata))).length
        return { entry, score }
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
      const pdf = result.contentType === 'application/pdf' ? await extractOfficialPdf(result.body, signal) : null
      const extracted = pdf ? pdfDocument(pdf.text) : extractOfficialDocument(result as TextResponse, { pageUrl: entry.url, allowedHosts: catalog.allowedHosts })
      signal.throwIfAborted(); active(entry.catalogId)
      const location = pdf ? `PDF本文（1〜${pdf.pages}ページ・ページ単位、画像文字は未抽出）`
        : result.contentType === 'text/html' ? `HTML本文（${extracted.scope === 'main' ? '主要コンテンツ' : 'ページ本文'}・見出し単位）` : 'テキスト本文（全体）'
      return sourceDocumentSchema.parse({ ...candidateOf(entry), text: extracted.text, location,
        fetchedAt: new Date(now()).toISOString(), updatedAt: null, contentHash: textHash(extracted.text),
        sections: extracted.sections, forms: extracted.forms })
    },
  }
}
const candidateOf = (entry: z.infer<typeof entrySchema>): SourceCandidate => ({ id: entry.id, catalogId: entry.catalogId, title: entry.title, issuer: entry.issuer, url: entry.url })

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

/** 本文ではない領域。スクリプト等に加え、ナビゲーション・ヘッダー・フッターを除く。 */
const IGNORED = new Set(['head', 'script', 'style', 'noscript', 'template', 'iframe', 'object', 'svg', 'form', 'canvas',
  'nav', 'header', 'footer', 'aside'])
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4'])
const MAX_SOURCE_TEXT = 60000

export interface ExtractedDocument {
  text: string
  sections: SourceSection[]
  forms: SourceForm[]
  /** mainは主要コンテンツ領域だけを抽出した。bodyは領域が無くページ本文から除外規則で抽出した。 */
  scope: 'main' | 'body' | 'plain'
}

/** 正規化した本文のハッシュ。空白の揺れで変化しないよう、抽出後の本文から作る。 */
export function textHash(text: string): string {
  return createHash('sha256').update(text.normalize('NFKC')).digest('base64url')
}

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
const attr = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value ?? null
const isElement = (node: Node): node is Element => 'tagName' in node

function textOf(node: Node): string {
  const parts: string[] = []
  const stack: Node[] = [node]
  while (stack.length) {
    const current = stack.pop()!
    if (isElement(current) && IGNORED.has(current.tagName)) continue
    if ('value' in current && current.nodeName === '#text') parts.push(current.value)
    if ('childNodes' in current) stack.push(...[...current.childNodes].reverse())
  }
  return normalize(parts.join(' '))
}

/** 主要コンテンツ領域。HTML標準のmain要素、次にrole="main"、次に慣用のid="main-content"。 */
function findMain(root: Node): Element | null {
  const stack: Node[] = [root]
  const candidates: { element: Element; rank: number }[] = []
  while (stack.length) {
    const current = stack.pop()!
    if (isElement(current)) {
      if (current.tagName === 'main') candidates.push({ element: current, rank: 0 })
      else if (attr(current, 'role') === 'main') candidates.push({ element: current, rank: 1 })
      else if (attr(current, 'id') === 'main-content') candidates.push({ element: current, rank: 2 })
    }
    if ('childNodes' in current) stack.push(...current.childNodes)
  }
  // 複数あれば曖昧なので本文を取り違えないよう主要領域とみなさない。
  const best = candidates.filter(item => item.rank === Math.min(...candidates.map(c => c.rank)))
  return best.length === 1 ? best[0]!.element : null
}

const FORM_LINK = /申請書|記入例|様式|手書き用|入力用/
/** 申請書そのものではない案内文書。「申請書」の語を含んでも様式として扱わない。 */
const NOT_A_FORM = /お願い|案内|注意|説明|について/

/**
 * 申請書・記入例へのリンク。許可済みホストのPDFだけを採用する。
 * 許可外のリンクは通常の外部リンクとして無視し、URLはハーネスが解決する。
 * 「手書き用」のような短い文言は単独では意味が通じないため、ページ見出しを添える。
 */
function formOf(element: Element, text: string, pageTitle: string | null,
  options: { pageUrl: string; allowedHosts: readonly string[] }): SourceForm | null {
  const href = attr(element, 'href')
  if (!href || !FORM_LINK.test(text) || NOT_A_FORM.test(text)) return null
  let url: URL
  try { url = new URL(href, options.pageUrl) } catch { return null }
  if (url.protocol !== 'https:' || !options.allowedHosts.includes(url.hostname) || url.username || url.password ||
      (url.port && url.port !== '443') || url.search || url.hash || !url.pathname.toLowerCase().endsWith('.pdf')) return null
  const label = (/申請書|様式/.test(text) || !pageTitle ? text : `${pageTitle}（${text}）`).slice(0, 120)
  return { label, url: url.toString(), kind: /記入例/.test(text) ? 'EXAMPLE' : 'FORM' }
}

export function extractOfficialDocument(response: TextResponse,
  options: { pageUrl: string; allowedHosts: readonly string[] } = { pageUrl: 'https://invalid.example/', allowedHosts: [] }): ExtractedDocument {
  if (Buffer.byteLength(response.body) > 524288) throw new Error('Official source body is too large')
  if (response.contentType === 'text/plain') {
    const text = normalize(response.body)
    if (!text || text.length > MAX_SOURCE_TEXT) throw new Error('Official source text is empty or too large')
    return { text, sections: [{ id: 's1', heading: null, anchor: null, text: text.slice(0, 20000) }], forms: [], scope: 'plain' }
  }
  if (response.contentType !== 'text/html') throw new Error('Unsupported official source type')

  const root = parse(response.body)
  const main = findMain(root)
  const container: Node = main ?? root
  const sections: { heading: string | null; anchor: string | null; parts: string[] }[] = [{ heading: null, anchor: null, parts: [] }]
  const forms: SourceForm[] = []
  const seenForms = new Set<string>()
  const stack: Node[] = [container]
  while (stack.length) {
    const node = stack.pop()!
    if (isElement(node)) {
      if (IGNORED.has(node.tagName)) continue
      if (HEADINGS.has(node.tagName)) {
        const heading = textOf(node)
        if (heading) {
          const anchor = attr(node, 'id')
          sections.push({ heading: heading.slice(0, 200), anchor: anchor && /^[A-Za-z0-9_-]{1,100}$/.test(anchor) ? anchor : null, parts: [] })
        }
        continue
      }
      if (node.tagName === 'a') {
        const pageTitle = sections.find(section => section.heading)?.heading ?? null
        const form = formOf(node, textOf(node), pageTitle, options)
        if (form && !seenForms.has(form.url) && forms.length < 10) { seenForms.add(form.url); forms.push(form) }
      }
    }
    if ('value' in node && node.nodeName === '#text') sections[sections.length - 1]!.parts.push(node.value)
    if ('childNodes' in node) stack.push(...[...node.childNodes].reverse())
  }

  const kept = sections.map(section => ({ ...section, text: normalize(section.parts.join(' ')) }))
    .filter(section => section.text || section.heading)
  if (!kept.length) throw new Error('Official source text is empty or too large')
  const numbered: SourceSection[] = kept.slice(0, 60).map((section, index) => ({
    id: `s${index + 1}`, heading: section.heading, anchor: section.anchor,
    // 見出しだけの区分（直後に下位見出しが続く）も位置の手がかりとして残す。
    text: (section.text || section.heading || '').slice(0, 20000),
  }))
  const text = numbered.map(section => section.heading ? `【${section.heading}】 ${section.text === section.heading ? '' : section.text}`.trim() : section.text).join('\n')
  if (!text || text.length > MAX_SOURCE_TEXT) throw new Error('Official source text is empty or too large')
  return { text, sections: numbered, forms, scope: main ? 'main' : 'body' }
}

/** 後方互換。本文だけが必要な呼び出し側向け。 */
export function extractOfficialText(response: TextResponse): string {
  return extractOfficialDocument(response).text
}

/** PDFはページを区分にする。抽出器が付けたページ番号の区切りを使う。 */
function pdfDocument(text: string): ExtractedDocument {
  const sections: SourceSection[] = []
  for (const match of text.matchAll(/\[PDF page (\d+)\]\n([\s\S]*?)(?=\n\n\[PDF page \d+\]|$)/g)) {
    const body = normalize(match[2] ?? '')
    if (body && sections.length < 60) sections.push({ id: `s${sections.length + 1}`, heading: `${match[1]}ページ`, anchor: null, text: body.slice(0, 20000) })
  }
  if (!sections.length) throw new Error('Official PDF has no extractable text')
  return { text, sections, forms: [], scope: 'plain' }
}
