import type { CaseDocument } from '@aftercare/public-contracts'
import { db } from './db'

/**
 * 書類の原本（モック）。
 *
 * - 画面から追加したファイルは、そのまま覚えておいて返す（手元の画像・PDFで表示を試せる）。
 * - 最初から入っている見本の書類には実物が無いため、見本の紙面を SVG で作って返す。
 *   読み取った内容を sourceBox の位置に書き込むので、確認画面の枠が合っているかを目で確かめられる。
 *
 * 本物の Backend は GET /cases/{caseId}/documents/{documentId}/content で、
 * 保存先から中継して application/octet-stream で返す。
 */
export const uploadedFiles = new Map<string, Blob>()

const W = 600
const H = 720

const TITLES: Partial<Record<CaseDocument['kind'], string>> = {
  DEATH_CERTIFICATE: '死亡診断書（死体検案書）',
  BANK_STATEMENT: '普通預金通帳',
}

function esc(text: string) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function sampleContent(doc: CaseDocument): Blob {
  const rows = db.approvals
    .filter((a) => a.sourceDocumentId === doc.id)
    .flatMap((a) => a.diff)
    .filter((r) => r.sourceBox && r.after)

  const parts: string[] = [
    `<rect width="${W}" height="${H}" fill="#fffdf7"/>`,
    `<rect x="16" y="16" width="${W - 32}" height="${H - 32}" fill="none" stroke="#c9c2b0" stroke-width="2"/>`,
    `<text x="${W / 2}" y="70" text-anchor="middle" font-size="26" font-weight="bold" fill="#333">${esc(TITLES[doc.kind] ?? doc.fileName)}</text>`,
  ]

  // 読み取った項目：sourceBox の位置に「項目名と値」を書く
  for (const r of rows) {
    const b = r.sourceBox!
    const x = b.x * W
    const y = b.y * H
    const h = b.h * H
    const size = Math.max(12, Math.round(h * 0.62))
    parts.push(
      `<text x="${x - 8}" y="${y + h * 0.72}" text-anchor="end" font-size="${Math.round(size * 0.8)}" fill="#777">${esc(r.field)}</text>`,
      `<text x="${x + 6}" y="${y + h * 0.72}" font-size="${size}" fill="#222">${esc(String(r.after))}</text>`,
      `<line x1="${x}" y1="${y + h}" x2="${x + b.w * W}" y2="${y + h}" stroke="#d8d2c2"/>`,
    )
  }

  // 読み取りに使っていない部分は、紙面らしく罫線で埋める
  for (let i = 0; i < 6; i++) {
    const y = 520 + i * 28
    parts.push(`<line x1="60" y1="${y}" x2="${W - 60}" y2="${y}" stroke="#e6e0d0"/>`)
  }

  parts.push(
    `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="64" font-weight="bold" fill="#d33" fill-opacity="0.08" transform="rotate(-24 ${W / 2} ${H / 2})">見本</text>`,
    `<text x="${W - 30}" y="${H - 30}" text-anchor="end" font-size="13" fill="#999">開発用の見本（モック）</text>`,
  )

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="sans-serif">${parts.join('')}</svg>`
  return new Blob([svg], { type: 'image/svg+xml' })
}
