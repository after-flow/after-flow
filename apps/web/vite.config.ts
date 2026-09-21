import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import path from 'node:path'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * モックAPIの Service Worker を本番成果物から取り除く。
 * public/ に置いたファイルは無条件に dist へコピーされるため、
 * モックを使わないビルドでは明示的に削除する。
 */
function stripMockServiceWorker(enabled: boolean) {
  let outDir = 'dist'
  return {
    name: 'strip-mock-service-worker',
    apply: 'build' as const,
    configResolved(config: { build: { outDir: string } }) {
      outDir = config.build.outDir
    },
    closeBundle() {
      if (enabled) return
      rmSync(path.resolve(rootDir, outDir, 'mockServiceWorker.js'), { force: true })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Root .env is shared with Compose; process variables take precedence.
  const envDir = path.resolve(rootDir, '../..')
  const env = { ...loadEnv(mode, envDir, 'VITE_'), ...process.env }
  // 本番ビルドでは VITE_USE_MOCK=true を明示したときだけモックを含める
  const mockInBuild = mode !== 'production' || env.VITE_USE_MOCK === 'true'

  return {
    envDir,
    plugins: [react(), tailwindcss(), stripMockServiceWorker(mockInBuild)],
    resolve: {
      alias: { '@': path.resolve(rootDir, './src') },
    },
    server: {
      host: '127.0.0.1',
      strictPort: true,
      watch: env.VITE_WATCH_POLLING === 'true' ? { usePolling: true } : undefined,
      proxy: env.VITE_API_PROXY
        ? { '/api/v1': { target: env.VITE_API_PROXY, changeOrigin: true } }
        : undefined,
    },
  }
})
