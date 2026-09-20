import { errors } from '../../shared/app-error.js'

/**
 * 実体による形式の判定（仕様書 15.4）。
 *
 * Content-Type は送信側の申告にすぎない。拡張子や申告だけを信じると、
 * 実行可能ファイルを PDF として受け取る。先頭バイトで実体を確かめる。
 */
export type SupportedContentType = 'application/pdf' | 'image/jpeg' | 'image/png'

export const SUPPORTED_CONTENT_TYPES: SupportedContentType[] = [
  'application/pdf',
  'image/jpeg',
  'image/png',
]

/** 1 ファイルの上限（仕様書 15.4 の初期値）。 */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024

const SIGNATURES: { type: SupportedContentType; bytes: number[] }[] = [
  // %PDF-
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // JPEG SOI + marker
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  // PNG signature
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
]

function matches(content: Uint8Array, bytes: number[]): boolean {
  if (content.length < bytes.length) return false
  return bytes.every((byte, index) => content[index] === byte)
}

/** 先頭バイトから実体の形式を判定する。判定できなければ null。 */
export function sniffContentType(content: Uint8Array): SupportedContentType | null {
  return SIGNATURES.find((signature) => matches(content, signature.bytes))?.type ?? null
}

/**
 * 申告と実体の両方を検査する。
 *
 * 申告が対応外なら拒否し、実体が判定できない、または申告と食い違う場合も
 * 拒否する。「実体を優先して受け入れる」と、利用者が意図しない形式の
 * ファイルが保存される。
 */
export function assertSupportedDocument(
  declaredContentType: string,
  content: Uint8Array,
): SupportedContentType {
  const declared = declaredContentType.split(';')[0]?.trim().toLowerCase() ?? ''

  if (!SUPPORTED_CONTENT_TYPES.includes(declared as SupportedContentType)) {
    throw errors.unsupportedMediaType({
      message: 'PDF、JPEG、PNG のみ登録できます。',
      details: { declared, supported: SUPPORTED_CONTENT_TYPES },
    })
  }
  if (content.byteLength === 0) {
    throw errors.validationFailed({ message: 'ファイルが空です。', details: { field: 'file' } })
  }
  if (content.byteLength > MAX_DOCUMENT_BYTES) {
    throw errors.payloadTooLarge({ details: { maxBytes: MAX_DOCUMENT_BYTES } })
  }

  const actual = sniffContentType(content)
  if (actual === null || actual !== declared) {
    throw errors.unsupportedMediaType({
      message: 'ファイルの内容が指定された形式と一致しません。',
      details: { declared, detected: actual },
    })
  }
  return actual
}
