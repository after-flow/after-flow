import { Worker } from 'node:worker_threads'
import { z } from 'zod'

/** `document_analysis` へ渡す ProcessedDocument.pages の上限（#196）。 */
export const ANALYSIS_PDF_MAX_PAGES = 20
export const ANALYSIS_PDF_PAGE_MAX_CHARS = 12000

/** Workerが返す正規化前の文字数の上限。正規化で空白が減るため、ページ上限より大きく取る。 */
const RAW_PAGE_MAX_CHARS = ANALYSIS_PDF_PAGE_MAX_CHARS * 4
const pageSchema = z.object({ number: z.number().int().positive(), text: z.string().max(ANALYSIS_PDF_PAGE_MAX_CHARS) }).strict()
const extractedSchema = z.object({ pages: z.array(pageSchema).min(1).max(ANALYSIS_PDF_MAX_PAGES) }).strict()
const textItemSchema = z.object({ str: z.string().max(RAW_PAGE_MAX_CHARS), hasEOL: z.boolean() }).strict()
const rawSchema = z.object({ pages: z.array(z.object({ number: z.number().int().positive(), items: z.array(textItemSchema).max(RAW_PAGE_MAX_CHARS) }).strict())
  .min(1).max(ANALYSIS_PDF_MAX_PAGES) }).strict()
export type PdfTextItem = z.infer<typeof textItemSchema>

/**
 * pdf.jsの文字列断片を1ページの本文にする。
 *
 * pdf.jsはフォントが切り替わる位置で文字列を分割する（日本語PDFでは1語の途中でも起きる）。
 * 空白を挟んでつなぐと「架空信 用 金 庫」のように語の途中に空白が入るため、そのままつなぎ、
 * 行末（hasEOL）だけ改行にする。語の間の空白はpdf.jsが断片の中に含めて返す。
 */
export function pageText(items: readonly PdfTextItem[]): string {
  return normalizeExtractedText(items.map(item => item.str + (item.hasEOL ? '\n' : '')).join('')).slice(0, ANALYSIS_PDF_PAGE_MAX_CHARS)
}

/**
 * CJK部首補助（U+2E80〜U+2EFF）の文字を、同じ字形の統合漢字にする対応表。
 * NFKCは康熙部首（U+2F00台）だけを統合漢字にし、このブロックは変換しない。
 * 日本語フォントのPDFでは「⻑（長）」「⻄（西）」などがこのブロックの文字として抽出される。
 * Unicode の EquivalentUnifiedIdeograph.txt（UCD 18.0.0）から生成した。
 */
const RADICAL_SUPPLEMENT_FROM = Array.from('⺁⺂⺃⺄⺅⺆⺇⺈⺉⺊⺋⺌⺍⺎⺏⺐⺑⺒⺓⺔⺕⺖⺗⺘⺙⺛⺜⺝⺞⺟⺠⺡⺢⺣⺤⺥⺦⺧⺨⺩⺪⺫⺬⺭⺮⺯⺰⺱⺲⺳⺴⺵⺶⺷⺸⺹⺺⺻⺼⺽⺾⺿⻀⻁⻂⻃⻄⻅⻆⻇⻈⻉⻊⻋⻌⻍⻎⻏⻐⻑⻒⻓⻔⻕⻖⻗⻘⻙⻚⻛⻜⻝⻞⻟⻠⻡⻢⻣⻤⻥⻦⻧⻨⻩⻪⻫⻬⻭⻮⻯⻰⻱⻲⻳')
const RADICAL_SUPPLEMENT_TO = Array.from('厂乛乚乙亻冂𠘨刀刂卜㔾小小兀尣尢𡯂巳幺彑𫜹忄心扌攵旡日月歺母民氵氺灬爫爫丬牛犭王𤴔目示礻𥫗糹纟罓罒㓁冗𦉫羊𦍌𦍋耂肀聿肉𦥑艹艹艹虎衤覀西见角𧢲讠贝𧾷车辶辶辶邑钅長镸长门𨸏阝雨青韦页风飞食𩙿飠饣𩠐马骨鬼鱼鸟卤麦黄黾斉齐歯齿竜龙龜亀龟')
const RADICAL_SUPPLEMENT = new Map(RADICAL_SUPPLEMENT_FROM.map((from, index) => [from, RADICAL_SUPPLEMENT_TO[index]!]))

/**
 * 抽出した本文を、AIが引用・照合できる形に整える。
 *
 * - NFKC正規化: 日本語フォントのPDFでは「高」「金」「日」などが見た目の同じ康熙部首
 *   （U+2F00台）として抽出されることがあり、そのままでは金融機関名などが別の文字になる。
 *   全角英数字もここで半角にそろう。CJK部首補助の文字も対応表で統合漢字にする。
 * - 空白: 行内の連続する空白は1つにし、改行は1行ずつ残す。
 */
export function normalizeExtractedText(raw: string): string {
  return raw.normalize('NFKC').replace(/[\u2E80-\u2EFF]/g, char => RADICAL_SUPPLEMENT.get(char) ?? char).replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim()
}

/**
 * PDF からページごとのテキストを取り出す（読み取りに使う実装、#25/#26 未決定分の暫定）。
 *
 * 画像（スキャンのみの PDF・JPEG・PNG）は文字を持たないため空ページになる。
 * 実OCRは範囲外（issue #196 の対象外）。呼び出し側は空ページを
 * 「読み取れなかった」として扱う。
 *
 * サンドボックス化した Worker で実行し、モデル・スクリプト実行・外部フェッチは
 * 行わない。PDF の中身は信頼しないデータとして扱う。
 */
const parser = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { getDocument } = await import(workerData.moduleUrl);
  const task = getDocument({ data: workerData.bytes, isEvalSupported: false, disableFontFace: true,
    useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true, verbosity: 0 });
  try {
    const document = await task.promise;
    if (document.numPages < 1) throw new Error('page limit');
    // 上限を超える書類は、全体を読めないものとせず先頭のページだけを読む（通帳・残高証明書は先頭に要点がある）。
    const pages = [];
    for (let number = 1; number <= Math.min(document.numPages, ${ANALYSIS_PDF_MAX_PAGES}); number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      // 断片のつなぎ方と正規化はWorkerの外（pageText）で行う。ここでは上限内の断片だけを返す。
      const items = [];
      let length = 0;
      for (const item of content.items) {
        if (typeof item.str !== 'string' || length >= ${RAW_PAGE_MAX_CHARS}) continue;
        const str = item.str.slice(0, ${RAW_PAGE_MAX_CHARS} - length);
        length += str.length + 1;
        items.push({ str, hasEOL: item.hasEOL === true });
      }
      pages.push({ number, items });
      page.cleanup();
    }
    parentPort.postMessage({ pages });
  } finally { await task.destroy(); }
})().catch(() => { parentPort.postMessage({ error: 'PDF text extraction failed' }); });
`

export async function extractPdfPages(bytes: Uint8Array, signal: AbortSignal): Promise<z.infer<typeof extractedSchema>> {
  const raw = await extractRawPdfPages(bytes, signal)
  return extractedSchema.parse({ pages: raw.pages.map(page => ({ number: page.number, text: pageText(page.items) })) })
}

async function extractRawPdfPages(bytes: Uint8Array, signal: AbortSignal): Promise<z.infer<typeof rawSchema>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(parser, { eval: true, execArgv: [], env: {},
      workerData: { bytes, moduleUrl: import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs') },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } })
    let settled = false
    const finish = (result?: z.infer<typeof rawSchema>) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', aborted)
      void worker.terminate()
      if (result) resolve(result)
      else reject(new Error('PDF is unreadable, interrupted or exceeds extraction limits'))
    }
    const aborted = () => finish()
    const timer = setTimeout(aborted, 10000)
    worker.once('message', (message: unknown) => { const result = rawSchema.safeParse(message); finish(result.success ? result.data : undefined) })
    worker.once('error', aborted); worker.once('exit', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}
