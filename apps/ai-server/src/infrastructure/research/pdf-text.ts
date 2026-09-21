import { Worker } from 'node:worker_threads'
import { z } from 'zod'

export const OFFICIAL_PDF_MAX_BYTES = 5 * 1024 * 1024
const extractedSchema = z.object({ text: z.string().min(1).max(60000), pages: z.number().int().min(1).max(40) }).strict()

// Static worker code only; PDF bytes are data. No viewer, scripting, attachments, links or OCR are executed.
const parser = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { getDocument } = await import(workerData.moduleUrl);
  const task = getDocument({ data: workerData.bytes, isEvalSupported: false, disableFontFace: true,
    useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true, verbosity: 0 });
  try {
    const document = await task.promise;
    if (document.numPages < 1 || document.numPages > 40) throw new Error('page limit');
    const parts = []; let size = 0; let hasText = false;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const body = content.items.filter(item => typeof item.str === 'string').map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
      if (body) hasText = true;
      const text = '[PDF page ' + number + ']\n' + (body || '[No extractable text on this page]');
      size += text.length + (parts.length ? 2 : 0);
      if (size > 60000) throw new Error('text limit');
      parts.push(text); page.cleanup();
    }
    if (!hasText) throw new Error('OCR required');
    parentPort.postMessage({ text: parts.join('\n\n'), pages: document.numPages });
  } finally { await task.destroy(); }
})().catch(() => { parentPort.postMessage({ error: 'PDF text extraction failed' }); });
`

/** Separate bounded parser lifetime; cancellation also interrupts CPU-bound PDF processing. */
export async function extractOfficialPdf(bytes: Uint8Array, signal: AbortSignal): Promise<z.infer<typeof extractedSchema>> {
  signal.throwIfAborted()
  if (bytes.byteLength > OFFICIAL_PDF_MAX_BYTES || !Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))) throw new Error('Official PDF bytes rejected')
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
      else reject(new Error('Official PDF is unreadable, interrupted or exceeds extraction limits'))
    }
    const aborted = () => finish()
    const timer = setTimeout(aborted, 5000)
    worker.once('message', (message: unknown) => { const result = extractedSchema.safeParse(message); finish(result.success ? result.data : undefined) })
    worker.once('error', aborted); worker.once('exit', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}
