import { Worker } from 'node:worker_threads'
import { z } from 'zod'

/** `document_analysis` へ渡す ProcessedDocument.pages の上限（#196）。 */
export const ANALYSIS_PDF_MAX_PAGES = 20
export const ANALYSIS_PDF_PAGE_MAX_CHARS = 12000

const pageSchema = z.object({ number: z.number().int().positive(), text: z.string().max(ANALYSIS_PDF_PAGE_MAX_CHARS) }).strict()
const extractedSchema = z.object({ pages: z.array(pageSchema).min(1).max(ANALYSIS_PDF_MAX_PAGES) }).strict()

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
    if (document.numPages < 1 || document.numPages > ${ANALYSIS_PDF_MAX_PAGES}) throw new Error('page limit');
    const pages = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const body = content.items.filter(item => typeof item.str === 'string').map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
      pages.push({ number, text: body.slice(0, ${ANALYSIS_PDF_PAGE_MAX_CHARS}) });
      page.cleanup();
    }
    parentPort.postMessage({ pages });
  } finally { await task.destroy(); }
})().catch(() => { parentPort.postMessage({ error: 'PDF text extraction failed' }); });
`

export async function extractPdfPages(bytes: Uint8Array, signal: AbortSignal): Promise<z.infer<typeof extractedSchema>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(parser, { eval: true, execArgv: [], env: {},
      workerData: { bytes, moduleUrl: import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs') },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } })
    let settled = false
    const finish = (result?: z.infer<typeof extractedSchema>) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', aborted)
      void worker.terminate()
      if (result) resolve(result)
      else reject(new Error('PDF is unreadable, interrupted or exceeds extraction limits'))
    }
    const aborted = () => finish()
    const timer = setTimeout(aborted, 10000)
    worker.once('message', (message: unknown) => { const result = extractedSchema.safeParse(message); finish(result.success ? result.data : undefined) })
    worker.once('error', aborted); worker.once('exit', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}
