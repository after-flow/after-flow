import type { DocumentResource } from '@aftercare/public-contracts'

/**
 * 書類の原本（モック）。
 *
 * - 画面から追加したファイルは、そのまま覚えておいて返す（手元の画像・PDFで表示を試せる）。
 * - 最初から入っている見本の書類には実物が無いため、見本の紙面を SVG で作って返す。
 *
 * 本物の Backend は GET /cases/{caseId}/documents/{documentId}/content で、
 * 保存先から中継して application/octet-stream で返す。新契約に `sourceBox` は無いため
 * （読み取った場所の情報はない前提で表示する。設計 §3.1）、注釈は付けない。
 */
export const uploadedFiles = new Map<string, Blob>()

const W = 600
const H = 720

const TITLES: Partial<Record<DocumentResource['kind'], string>> = {
  DEATH_CERTIFICATE: '死亡診断書（死体検案書）',
  BANK_STATEMENT: '普通預金通帳',
}

function esc(text: string) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function sampleContent(doc: DocumentResource): Blob {
  const parts: string[] = [
    `<rect width="${W}" height="${H}" fill="#fffdf7"/>`,
    `<rect x="16" y="16" width="${W - 32}" height="${H - 32}" fill="none" stroke="#c9c2b0" stroke-width="2"/>`,
    `<text x="${W / 2}" y="70" text-anchor="middle" font-size="26" font-weight="bold" fill="#333">${esc(TITLES[doc.kind] ?? doc.fileName)}</text>`,
  ]

  // 紙面らしく罫線で埋める（読み取った項目の重ね書きはしない。sourceBox は契約に無い）
  for (let i = 0; i < 12; i++) {
    const y = 160 + i * 34
    parts.push(`<line x1="60" y1="${y}" x2="${W - 60}" y2="${y}" stroke="#e6e0d0"/>`)
  }

  parts.push(
    `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="64" font-weight="bold" fill="#d33" fill-opacity="0.08" transform="rotate(-24 ${W / 2} ${H / 2})">見本</text>`,
    `<text x="${W - 30}" y="${H - 30}" text-anchor="end" font-size="13" fill="#999">開発用の見本（モック）</text>`,
  )

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="sans-serif">${parts.join('')}</svg>`
  return new Blob([svg], { type: 'image/svg+xml' })
}
