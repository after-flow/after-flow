import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractPdfPages, normalizeExtractedText, pageText } from '../src/application/document/pdf-text.js'

/**
 * 1行の途中でフォントが切り替わる最小のPDF。標準フォント（Helvetica / Times-Roman）だけを使い、
 * フォントを埋め込まない。pdf.jsはフォントの切り替わりで文字列を別の断片にする。
 */
function mixedFontPdf(pageCount = 1): Uint8Array {
  const stream = (page: number) => `BT /F1 18 Tf 72 720 Td (Balance Certi) Tj /F2 18 Tf (ficate) Tj ET\nBT /F1 12 Tf 72 690 Td (Sample Bank, Balance JPY 1,234,567 page ${page}) Tj ET`
  // 1: Catalog, 2: Pages, 3: F1, 4: F2, 5以降: ページとその内容を交互に置く。
  const pages = Array.from({ length: pageCount }, (_, index) => [
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${6 + index * 2} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`,
    `<< /Length ${stream(index + 1).length} >>\nstream\n${stream(index + 1)}\nendstream`,
  ]).flat()
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${5 + index * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
    ...pages,
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(body, 'latin1'))
}

test('#196 フォントが切り替わる断片を空白なしでつなぎ、行ごとに改行する', async () => {
  const { pages } = await extractPdfPages(mixedFontPdf(), new AbortController().signal)
  assert.equal(pages.length, 1)
  const lines = pages[0]!.text.split('\n')
  // 以前は断片を空白でつないでいたため "Balance Certi ficate" になっていた。
  assert.equal(lines[0], 'Balance Certificate')
  assert.equal(lines[1], 'Sample Bank, Balance JPY 1,234,567 page 1')
})

test('#196 上限を超えるページ数の書類も、全体を捨てずに先頭のページを読む', async () => {
  const { pages } = await extractPdfPages(mixedFontPdf(21), new AbortController().signal)
  assert.equal(pages.length, 20)
  assert.match(pages[19]!.text, /page 20$/)
})

test('#196 日本語PDFの康熙部首と語の途中の分割を、引用できる本文に直す', () => {
  // 実際のPDF（ヒラギノ角ゴで作成した合成の残高証明書）からpdf.jsが返した断片の形。
  // 「用」「金」「高」が康熙部首（U+2F64 ⽤ / U+2FA6 ⾦ / U+2FBC ⾼）で、フォントが切り替わるたびに断片が分かれる。
  const items = [
    { str: '残', hasEOL: false }, { str: '\u2FBC', hasEOL: false }, { str: '証明書', hasEOL: true },
    { str: '架空信', hasEOL: false }, { str: '\u2F64', hasEOL: false }, { str: '\u2FA6', hasEOL: false }, { str: '庫 本店営業部', hasEOL: true },
    { str: '残', hasEOL: false }, { str: '\u2FBC', hasEOL: false }, { str: ' 1,234,567円', hasEOL: true },
  ]
  assert.equal(pageText(items), '残高証明書\n架空信用金庫 本店営業部\n残高 1,234,567円')
})

test('#196 CJK部首補助の文字（NFKCで変わらない）も統合漢字にする', () => {
  // 「⻑い書類」: 長 が U+2ED1 として抽出された実例。ほかに ⻄（西）・⻘（青）・⻝（食）。
  assert.equal(normalizeExtractedText('\u2ED1い書類 \u2EC4口 \u2ED8山 \u2EDD品'), '長い書類 西口 青山 食品')
})

test('#196 本文の正規化は全角英数字と空白の揺れをそろえ、行は残す', () => {
  assert.equal(normalizeExtractedText('  口座番号　１２３４  \n\n\n 残高　１，０００円 \n'), '口座番号 1234\n残高 1,000円')
})
