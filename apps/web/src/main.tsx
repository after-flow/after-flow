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

async function bootstrap() {
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
