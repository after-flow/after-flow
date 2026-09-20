# after-flow

死亡後手続きの整理を支援するアプリケーションのTypeScriptモノレポです。
設計の正本は [アーキテクチャ仕様](docs/architecture.md) です。

## 現在の実装範囲

既存のReact + Viteフロントエンドを機能別に移し、画面、URL、モックAPI、ログイン状態の保存方式を維持しています。
BackendとAIは独立したHonoプロセスとして起動します。現時点では生存確認APIのみで、業務API、認証、Firestore、Mastra、Orch Routerは未実装です。
通常の開発起動では、これまでどおりMSWの架空データで全画面を操作できます。

## Dockerで起動

Docker EngineとCompose v2、makeがあれば起動できます。ホストへのNode.js／pnpmのインストールは不要です。

```sh
make up
```

- Web: **http://127.0.0.1:5173**（モックのログインは任意のメールアドレス・パスワード）
- Backend生存確認: http://127.0.0.1:8080/api/v1/health
- AI生存確認: コンテナ内 `http://ai-server:8081/internal/v1/health`。ホストへのポート公開はありません。

`localhost` がIPv6上の別プロセスを指す場合もあるため、上記の `127.0.0.1` を使用してください。
WebとBackendはループバックアドレスにのみ公開します。WebとAIはDockerネットワークも分けています。

```sh
make ps                 # 3サービスの状態
make logs               # ログ（Ctrl+Cで表示だけ終了）
make logs SERVICE=web   # Webのみ
make check              # Docker内で型・Lint・依存境界・本番ビルドを検証
make down               # このプロジェクトを停止
```

既存プロセスとポートが重複する場合は、次のように変更できます。

```sh
WEB_PORT=5174 BACKEND_PORT=8082 make up
```

`.env` の作成は任意です。必要ならルートの `.env.example` を `.env` にコピーして編集してください。
環境変数の変更後は `make up` を実行してください。Web、Backend、AIのソースはマウントされ、編集時に自動再読込されます。
依存パッケージ、TypeScript設定、その他のイメージ内ファイルを変更した場合も `make up` で再ビルドします。
Dockerfile／Composeはローカル開発用です。本番配信・デプロイ設定は今後追加します。

## ローカルで起動

Node.js **22.23.2**（`.node-version`）とpnpm **10.28.1**を使用します。
依存は `pnpm-lock.yaml` で固定し、npmのlockfileは使用しません。

```sh
pnpm install --frozen-lockfile
pnpm dev                # 3プロセスを並列起動
pnpm dev:web            # フロントエンドのみ
```

サービス単位でも操作できます。

```sh
pnpm --filter @aftercare/backend-server build
pnpm --filter @aftercare/backend-server start
pnpm --filter @aftercare/ai-server build
pnpm --filter @aftercare/ai-server start
```

## 配置

```text
apps/
  web/
    src/
      app/                   既存ルーティング・QueryClient
      features/              auth, cases, documents, tasks, approvals,
                             estate, family, chat, insights
      components/            共通UI・レイアウト・表示部品
      lib/api/               公開APIクライアント・Query
      mocks/                 既存MSWデータ・ハンドラー
    public/                  favicon・開発用Service Worker
  backend-server/
    src/main.ts              公開サーバーの起動
    src/app.ts               Hono設定
    src/presentation/routes/public/v1/health.ts
  ai-server/
    src/main.ts              内部サーバーの起動
    src/app.ts               Hono設定（公開ルートなし）
    src/presentation/routes/internal/v1/health.ts
packages/
  public-contracts/src/dto/  既存フロントの公開リソース型
scripts/
  verify-boundaries.mjs     workspace依存・import境界の検証
docs/
  architecture.md           提供された仕様書を内容変更せず移動
Dockerfile                  固定Node/pnpmと依存インストール
compose.yaml                Web / Backend / AIの独立コンテナ
Makefile                    起動・停止・検証
```

仕様書にあるDomain／Application、internal-contracts、Playbook、Rule、各Infrastructureなどは、機能実装時に追加します。
将来対象の空フォルダーや成功を返すダミー実装は生成していません。

## API・モックの扱い

Webからの業務通信は `/api/v1` の公開APIのみです。公開リソース型は `@aftercare/public-contracts` から型として参照し、既存の形を維持しています。
仕様書の新しいレスポンス形式や認証への切替は、Backendの実装と合わせて行います。
内部APIの契約ができた時点で `packages/internal-contracts` を追加し、Webから参照させません。

| 変数 | 開発時 | 本番ビルド時 |
| --- | --- | --- |
| `VITE_USE_MOCK` | 既定で有効、`false` で無効 | `true` を明示した場合だけ有効 |
| `VITE_API_BASE_URL` | 既定 `/api/v1` | 既定 `/api/v1` |
| `VITE_API_PROXY` | ローカルでのBackend転送先 | 使用しない |
| `VITE_WATCH_POLLING` | Dockerでは有効 | 使用しない |

ルートの `.env` はViteも読み込みます。Composeでは転送先を `http://backend-server:8080` に固定しています。
実APIの開発時は次のように切り替えますが、現時点で使えるのは生存確認APIのみです。

```sh
VITE_USE_MOCK=false VITE_API_PROXY=http://127.0.0.1:8080 pnpm dev:web
```

本番ビルドは `apps/web/dist` に出力され、既定ではMSW本体と `mockServiceWorker.js` を含みません。
デモ用ビルドだけ `VITE_USE_MOCK=true pnpm --filter @aftercare/web build` とします。

## 検証

```sh
pnpm typecheck
pnpm lint                # Lintと依存境界の検証
pnpm build
```

依存境界の検証は、WebからBackend／AI／内部契約への参照、サービス間の直接importを拒否します。
既存UIの説明とBackendへの要件は [Web README](apps/web/README.md) を参照してください。

導入時の公式資料: [Hono Node.js](https://hono.dev/docs/getting-started/nodejs)、[pnpm workspaces](https://pnpm.io/workspaces)、[Node.js releases](https://nodejs.org/en/about/previous-releases)。
