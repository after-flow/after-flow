import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './app/App'

/**
 * モックAPIを使うかどうか。
 *
 * 本番ビルドでは既定で無効にする。モックが本番に混入すると、期限や財産の内容が
 * すべて架空の値で表示されてしまい、利用者が誤った判断をするおそれがあるため。
 * 開発時は既定で有効、VITE_USE_MOCK=false で無効にできる。
 * デモ用に本番ビルドでモックを使う場合だけ、明示的に VITE_USE_MOCK=true を指定する。
 */
const useMock = import.meta.env.DEV
  ? import.meta.env.VITE_USE_MOCK !== 'false'
  : import.meta.env.VITE_USE_MOCK === 'true'

/** 以前のモック利用時に登録された Service Worker が残っていると、実APIを覆い隠してしまう */
async function unregisterStaleMockWorker() {
  if (!('serviceWorker' in navigator)) return
  try {
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(
      registrations
        .filter((r) => r.active?.scriptURL.includes('mockServiceWorker'))
        .map((r) => r.unregister()),
    )
  } catch {
    /* 解除できなくても起動は続行する */
  }
}

/**
 * 実認証に必要な設定が無いまま起動しない（fail-closed）。
 *
 * VITE_USE_MOCK=false なのに VITE_FIREBASE_API_KEY が無い環境は、
 * 誰でもログインできたように見えて実は何もできない（あるいは401地獄になる）よりも、
 * 起動を止めて理由を画面に出す方が安全（README「空配列や仮データで未接続を成功に見せない」と同じ考え方）。
 * 本番ビルド（mode production）で VITE_FIREBASE_AUTH_EMULATOR_URL が設定されている場合も、
 * 誤って Emulator へ向いたまま公開してしまう事故を防ぐため同様に止める。
 *
 * ここで画面に出すのは静的な文言だけで、HTTP応答自体は index.html の 200 のまま
 * （`scripts/smoke-production.mjs` は web の HTTP 200 を見るだけなので壊さない）。
 */
function authConfigError(): string | null {
  if (useMock) return null
  if (!import.meta.env.VITE_FIREBASE_API_KEY) {
    return 'この環境ではログインに必要な設定（VITE_FIREBASE_API_KEY）が見つかりませんでした。管理者にご連絡ください。'
  }
  if (import.meta.env.MODE === 'production' && import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_URL) {
    return 'この環境の設定に誤りがあります（本番ビルドで検証用の認証サーバーが指定されています）。管理者にご連絡ください。'
  }
  return null
}

function renderFailClosed(reason: string) {
  createRoot(document.getElementById('root')!).render(
    <div style={{ display: 'flex', minHeight: '100dvh', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <p style={{ fontWeight: 700, fontSize: '1.05rem' }}>いまはご利用いただけません</p>
        <p style={{ marginTop: 8, color: '#555', lineHeight: 1.6 }}>{reason}</p>
      </div>
    </div>,
  )
}

async function bootstrap() {
  const reason = authConfigError()
  if (reason) {
    renderFailClosed(reason)
    return
  }

  if (useMock) {
    const { startMockWorker } = await import('./mocks/browser')
    await startMockWorker()
  } else {
    await unregisterStaleMockWorker()
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap()
