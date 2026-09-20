# after-flow

死亡後手続きの整理を支援するアプリケーションのTypeScriptモノレポです。
設計の正本は [アーキテクチャ仕様](docs/architecture.md) です。

## 現在の実装範囲

既存のReact + Viteフロントエンドを機能別に移し、画面、URL、モックAPI、ログイン状態の保存方式を維持しています。
BackendとAIは独立したHonoプロセスとして起動します。Backendには業務API、認証・認可の境界、Firestore Adapterを実装しています。
本番の認証Provider・クラウド接続は環境設定が必要で、Mastra・Orch Routerは未接続です。
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
make check              # Docker内で型・Lint・テスト・OpenAPI・本番ビルドを検証
make down               # このプロジェクトを停止
```

既存プロセスとポートが重複する場合は、次のように変更できます。

```sh
WEB_PORT=5174 BACKEND_PORT=8082 make up
```

`.env` の作成は任意です。必要ならルートの `.env.example` を `.env` にコピーして編集してください。
環境変数の変更後は `make up` を実行してください。Web、Backend、AIのソースはマウントされ、編集時に自動再読込されます。
依存パッケージ、TypeScript設定、その他のイメージ内ファイルを変更した場合も `make up` で再ビルドします。
`compose.yaml` はローカル開発用です。本番用の独立イメージ・Compose検証・Cloud Runへの配布手順は [CI/CD運用](docs/ci-cd.md) を参照してください。

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
pnpm --filter @aftercare/backend-server... build
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
    src/app.ts               Hono設定・共通middleware
    src/shared/              AppErrorとコード／status対応表
    src/domain/shared/       Entity共通形・監査・Outbox・コレクション定義
    src/application/ports/   永続化・認証のポート
    src/application/authorization/ tenant・Case membershipの認可
    src/infrastructure/identity/ トークン検証Adapterと設定
    src/infrastructure/firestore/ Firestore実装・パス検証・カーソル
    src/presentation/http/   requestId・検証・共通エラー処理・route定義
    src/presentation/schemas/ 共通入力スキーマと公開契約との一致検証
    src/presentation/openapi/ route定義からのOpenAPI生成
    src/domain/case/           Case Entityと版の規則
    src/domain/consent/        同意文書の定義と判定
    src/domain/document/       書類Entity・実体による形式判定・検査状態
    src/domain/task/           Task・状態遷移表・期限のRule Engine
    src/domain/agent/          AgentRunの状態とCase lease
    src/domain/message/        チャットの発言
    src/domain/proposal/       提案・承認の版とhash
    src/domain/decision/       相続方法についての本人の意思
    src/application/consent/   同意の記録・撤回・利用可否Policy
    src/application/document/  書類の登録・取得・除外・回収
    src/application/task/      手続きのCommandと期限の算定
    src/application/agent/     AI実行の受付・Outbox配送・書き込み権
    src/application/chat/      発言の受付・案内の保存・結果の受領
    src/application/proposal/  提案から確定までの共通経路
    src/application/decision/  本人の意思の記録と確定
    src/infrastructure/storage/ 原本の保存（開発・CI用のローカル実装）
    src/application/case/      Case のCommand・Query
    src/presentation/routes/public/v1/   公開API
    src/presentation/routes/internal/v1/ AIからの結果受領
    test/                    契約テスト（node:test）
    test/firestore/          Emulatorに対する統合テスト
  ai-server/
    src/main.ts              内部サーバーの起動
    src/app.ts               Hono設定（公開ルートなし）
    src/presentation/routes/internal/v1/health.ts
packages/
  public-contracts/src/dto/  既存フロントの公開リソース型
scripts/
  verify-boundaries.mjs     workspace依存・import境界・AIへのデータ設定分離の検証
  with-firestore-emulator.mjs Firestore Emulatorを起動してコマンドを実行
docs/
  architecture.md           提供された仕様書を内容変更せず移動
  adr/                      未確定事項と決定の記録
  api/public-openapi.yaml   route定義から生成する公開API仕様
infra/
  firestore/                Security Rules・index・Emulatorの説明
  consent/                  同意文書カタログの雛形
  rules/                    期限ルールと初期手続きの定義の雛形
Dockerfile                  固定Node/pnpmと依存インストール
compose.yaml                Web / Backend / AIの独立コンテナ
Makefile                    起動・停止・検証
```

仕様書にあるDomain／Application、internal-contracts、Playbook、Rule、各Infrastructureなどは、機能実装時に追加します。
将来対象の空フォルダーや成功を返すダミー実装は生成していません。

## API・モックの扱い

Webからの業務通信は `/api/v1` の公開APIのみです。公開リソース型は `@aftercare/public-contracts` から型として参照し、既存の形を維持しています。

現在の公開APIは生存確認、同意、案件（作成・一覧・詳細・訂正）、書類（登録・一覧・詳細・原本取得・除外）、手続きと期限、AI実行の受付と参照、提案・承認・本人の意思、チャットと手順案内です。案件の一覧は自分が参加しているものだけを返します。
業務データベースが未設定の状態では、業務APIは `FEATURE_NOT_CONNECTED` を理由付きで返します。空配列や固定の成功では返しません。

チャットの発言は202で受け付けます。回答は後から履歴の取得で確認します。回答の実行を受け付けられない場合も発言は残し、理由を返します。
手順案内には出典と確認日、調べきれなかった項目を必ず添えます。案内や回答は説明であり、それだけで手続きを完了したり正式な事実を登録したりしません。

承認は、その人が見た提案の版と内容のhashに結び付きます。内容を訂正すると新しい版になり、対象を失った承認は期限切れになります。承認の受付と業務状態への反映は別に返します。受け付けただけで反映済みとは表示させません。
相続方法は、下書き・本人以外による報告・本人による確定を区別します。確定できるのは本人と紐付いた利用者だけです。放棄前ロックは確定だけを根拠に外します。

AI実行は202で受け付けます。受け付けただけで完了ではなく、結果は別途取得します。待機・失敗・取消を区別して返し、待機を失敗として表示させません。
接続されていない業務操作と、外部AI同意が無い要求は理由を添えて拒否します。配送はOutboxから行い、配送の直前にも同意を確認します。AI Serverが未設定の間、イベントは未配送のまま残ります。

手続きの状態はコマンドで変更します。statusの直接指定は受け付けません。準備完了、本人による提出報告、完了は別の状態です。
期限は業務レビュー済みのルールからだけ算定します。未レビューのルールでは日付を返さず、要確認として返します。仕様書や旧モックの日数をそのまま本番の法定期限として扱いません。

書類はPDF・JPEG・PNG、1ファイル10 MiBまでです。Content-Typeの申告だけでなく先頭バイトで実体を検査します。
検知・マスキングの方式は未確定です（[ADR 0002](docs/adr/0002-document-inspection.md)）。検査器が未接続の間、検査状態は「未検査」のままで、合格としては扱いません。未検査・拒否・失敗の書類はAIへ配信しません。
書類の除外は通常の一覧から外す操作で、個人データの完全消去とは別です。監査や根拠からの参照は壊しません。

必須同意（利用規約・個人情報の取扱い）が揃うまで業務APIは `CONSENT_REQUIRED` を返します。同意を取得するためのAPIは塞ぎません。
任意の外部AI同意が無くても、手動での案件・書類・手続きの管理は利用できます。同意文書の文面と提供先は業務側の承認後に確定するため、未設定時は仮文面と分かるカタログを使い、本番では拒否します。

公開APIは認証済みユーザーとCase membershipに限定します。採用する認証Providerは未確定で、実接続の着手条件は [ADR 0001](docs/adr/0001-authentication-provider.md) に記録しています。
認証の設定が無いまま起動した場合、認証が必要なAPIはすべて401を返します。検証を省略して通す既定値はありません。

Backendの公開APIは共通の封筒で応答します。成功は `{ data, meta }`、失敗は `{ error, meta }` で、どちらも `meta.requestId` を含みます。
`error.code` は入力不正・未認証・権限不足・not found・競合・同意不足・機能未接続・一時障害を区別し、`error.retryable` が同じ要求の再送可否を示します。
一覧の続きは `meta.nextCursor` で表します。件数だけを見て1ページ目を全件として扱わないでください。
既存MSWの旧形式との対応付けと、Web側クライアントの変換は #3 の対応表で扱います。現時点でWebは変更していません。
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
pnpm test                # CIポリシー・Frontend・Backend・AIのテスト
pnpm test:firestore      # Firestore Emulatorを起動して統合テスト
pnpm openapi:check       # 生成済みOpenAPIと実装routeの一致を検証
pnpm build
```

`pnpm test:firestore` はFirestore EmulatorをDockerコンテナで起動します。ホストへのJavaの導入は不要です。
Emulatorが起動していない状態で `pnpm test` を実行すると、Firestoreの統合テストは理由を表示してskipします。成功扱いにはしません。

公開APIのOpenAPIは `docs/api/public-openapi.yaml` に生成します。route定義を変更したら次を実行して差分をcommitしてください。

```sh
pnpm openapi:generate
```

依存境界の検証は、WebからBackend／AI／内部契約への参照、サービス間の直接importを拒否します。
既存UIの説明とBackendへの要件は [Web README](apps/web/README.md) を参照してください。

## CI/CD

[CI](.github/workflows/ci.yml) は全PR（依存ブランチ向けも含む）、`main` push、merge queue、手動実行が対象です。

- **Quality**: 固定lockfile、型、Lint・依存境界、全workspaceのテスト、生成済みOpenAPI、本番ビルドとモック除外を検証。
- **Firestore integration**: Firestore Emulatorに対してTransaction・冪等性・版競合・カーソルページング・業務APIを検証。
- **Workflow lint / Dependency audit**: Actions・埋込みshellの検証、high以上の依存脆弱性を検出。週次監査とDependabot更新も実行。
- **Docker smoke / Production containers**: 開発・本番の3サービス、SPA、API転送、非root起動、AIのポート非公開・ネットワーク分離をHTTPとコンテナ検査で確認。
- **CI Gate**: 全ジョブ成功を要求する固定名の必須チェック。失敗・キャンセル・skipは通過させません。

`main` のCI成功後、[Release](.github/workflows/release.yml) がテスト済みイメージを再ビルドせずGHCRへ配布します。
[Deploy Cloud Run](.github/workflows/deploy.yml) は環境・サービス・成功したCI runを指定して手動実行します。OIDC認証、環境承認、候補revisionの疎通確認、traffic切替と失敗時の復元を行います。

**GitHub Environment・GCP/IAMの初期設定が必要です。** 生存確認の成功だけでは、認証・永続化・Mastra/Orchの本番稼働を保証しません。
設定値、必須チェック、リリース、切り戻し、未検証範囲は [CI/CD運用](docs/ci-cd.md) にまとめています。
Nodeとpnpmは `.node-version` と `package.json` を参照します。CIには外部クラウドやLLMの資格情報は不要です。既存のLint警告は警告のままです。
Firestore integrationジョブは、Emulatorに対して永続化の統合テストを実行します。実Firestoreの資格情報は使いません。
ブラウザーE2Eは各機能の実装時に追加します。

Docker起動後、同じ疎通チェックをローカルでも実行できます。

```sh
make up
node scripts/smoke-compose.mjs
make down
```

ポートや `COMPOSE_PROJECT_NAME` を変更した場合は、起動とチェックで同じ環境変数を指定してください。

本番イメージの検証（開発用とは別プロジェクト・別イメージタグ）:

```sh
make production-check
COMPOSE_FILE=compose.production.yaml docker compose down
```

導入時の公式資料: [Hono Node.js](https://hono.dev/docs/getting-started/nodejs)、[pnpm workspaces](https://pnpm.io/workspaces)、[Node.js releases](https://nodejs.org/en/about/previous-releases)。
