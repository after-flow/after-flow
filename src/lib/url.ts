/**
 * 外部リンクとして表示してよい URL かを判定する。
 *
 * 手順案内に含まれる様式・記入例のURLは、AIの提案を経由してサーバーから渡ってくる。
 * `javascript:` や `data:` のスキームがそのまま href に入ると、
 * リンクを押した利用者の画面で任意のスクリプトが動くおそれがあるため、
 * http / https だけを通す。
 */
export function safeExternalUrl(value?: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value, window.location.origin)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * リンク先のホスト名。
 * リンクの文言もAIが生成するため、文言だけでは実際の遷移先が分からない。
 * 利用者が「本当に役所のサイトか」を自分で判断できるよう、ホスト名を併記する。
 */
export function urlHostname(value?: string): string | null {
  const safe = safeExternalUrl(value)
  if (!safe) return null
  try {
    return new URL(safe).hostname
  } catch {
    return null
  }
}
