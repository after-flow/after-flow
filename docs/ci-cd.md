# CI/CD運用

## 実行経路

```text
全PR / merge queue / main push
  └─ CI: Quality × 5 + Workflow lint + Dependency audit
         + Firestore integration + Docker smoke + Production containers
       └─ CI Gate（すべて成功）
main pushの成功のみ
  ├─ production-images artifact（テストしたイメージ、30日）
  └─ Publish verified images → GHCR（再ビルドなし）
手動: main + Environment + service + 成功したmain pushのCI run ID
  └─ Deploy Cloud Run
       ├─ CI runの出所・SHA・結果検証
       ├─ Environment承認 → OIDC → 同じartifactをArtifact Registryへ
       ├─ digest指定 / trafficなしの候補revision → 認証付きHTTP検証
       └─ revision指定で100%切替 → HTTP検証 / 失敗時は元のtrafficへ復元
```

PR・手動CI・fork・別workflowの成果物はRelease/Deployに渡せません。
CI runの`event=push`、`head_branch=main`、workflow path、repositoryとhead_repository、成功状態、40桁SHAをGitHub APIで検証します。
上流workflowの終了後にmainが進んでも、CI runが示すSHAの保存済みイメージを使います。
`pull_request_target`でPRコードを実行するworkflowはありません。

## CIチェックとローカル再現

| チェック | 内容 | ローカル |
| --- | --- | --- |
| Quality (typecheck) | 全workspaceの型。テストも型検査対象 | `pnpm typecheck` |
| Quality (lint) | Oxlint、workspace/import境界 | `pnpm lint` |
| Quality (test) | CIリリース条件・traffic復元先・日付/金額・Backend/AI HTTP境界 | `pnpm test` |
| Quality (openapi) | 生成済みOpenAPIと実装routeの一致 | `pnpm openapi:check` |
| Quality (build) | 全workspace本番ビルド、mockServiceWorker除外 | `VITE_USE_MOCK=false pnpm build` |
| Firestore integration | Emulator上の永続化・業務API・認可・版競合 | `pnpm test:firestore` |
| Workflow lint | actionlintとrunner内ShellCheckでActions/shell検証 | `go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.7`、`"$(go env GOPATH)/bin/actionlint"` |
| Dependency audit | lockfile全依存のhigh/critical脆弱性 | `pnpm audit --audit-level high` |
| Docker smoke | 開発3サービス・MSW配信・公開/内部HTTP・Firestore/Storage Emulator・AI分離 | `make up && node scripts/smoke-compose.mjs && make data-check` |
| Production containers | 本番3イメージ・SPA deep link・static assets・API proxy・AI分離 | `make production-check` |

`pnpm install --frozen-lockfile`で準備します。Docker内で型・Lint・テスト・buildをまとめて実行する場合は`make check`です。
終了時は開発用`make down`、本番用`COMPOSE_FILE=compose.production.yaml docker compose down`。
両方のComposeでAIポートは公開しません。本番ComposeはWebの4173だけをloopbackへ公開します。

rootの`pnpm test`はCI補助コードのテスト後に、`test`スクリプトを持つ全workspaceを実行します。
Web/AIのtest runnerは`src`以下の`.test.ts/.test.tsx/.test.mjs`を再帰的に探し、0件の場合は失敗します。
AIは加えて`test/**/*.test.ts`の基盤テストも実行します。Backendは既存の`test/**/*.test.ts`を実行します。Emulator依存のテストはこのジョブではskipし、別の必須Firestore integrationジョブで実行します。
`public-contracts`は現在型のみで、型検査・ビルドを実行します。`internal-contracts`もBackendより先にbuildします。
本番buildではBackendは`src`のみ、AIはテスト・test-supportを除外し、型検査ではテストも含めます。

QualityログとComposeログを14日、main pushの本番イメージartifactを30日保存します。
失敗時もログ収集・コンテナ停止を試みます。依存監査が通信障害で実行できない場合も成功扱いにはしません。
週次監査はコード変更がない期間の新規advisoryを検出します。通知はGitHub Actionsの失敗通知を利用します。
Dependabotはnpm、Actions、Dockerを週次更新します。自動マージは設定していません。

## リポジトリ設定

管理者がGitHub Settingsで以下を設定してください。workflowファイルだけではこれらの設定は反映されません。

1. mainのruleset/branch protectionで**`CI Gate`**を必須にする。旧`Quality`/`Docker smoke`だけを要求する設定は置き換える。
2. 必須チェックのsourceをGitHub Actionsに指定。force pushや直接pushを制限し、必要なレビュー数を設定する。
3. merge queueを使う場合も同じ`CI Gate`を要求する（`merge_group`対応済み）。
4. Actions実行とGitHub Packagesへの`GITHUB_TOKEN`のwriteを許可する。既存GHCR packageがある場合はこのリポへActions accessを付与する。
5. Environments **staging** / **production** を作成し、deployment branchをmainだけに制限する。productionにはrequired reviewersと自己承認禁止を設定する。

Environmentが事前に存在しない場合、GitHubは保護なしのEnvironmentを作成し得ます。デプロイ前に上記設定を完了してください。
CIのtokenはread-only、Releaseだけ`packages:write`、Deployだけ`id-token:write`です。
Actionsはcommit SHA、ベースイメージはdigest、SDKはバージョンを固定しています。

## 本番イメージ

| サービス | Docker target | runtime |
| --- | --- | --- |
| web | `web-production` | 非root nginx、静的SPA、`/api/*`をBackendへ転送 |
| backend-server | `backend-production` | 非root Node、production依存と`dist` |
| ai-server | `ai-production` | 非root Node、production依存と`dist` |

例: `docker build --target backend-production -t after-flow-backend-server:production-local .`。
各targetは該当workspaceと依存workspaceだけをbuildし、他サービスのruntimeを含めません。
`pnpm deploy --legacy --prod`は、このrepoの非inject workspace設定でproduction依存を配置するためのpnpm公式方式です。
実行イメージにtsxや開発ソースは含めません。

全イメージは`PORT=8080`が既定。Nodeは`HOST=0.0.0.0`、Webは環境変数PORTをnginxへ展開します。
Webの`BACKEND_ORIGIN`には管理者が設定したBackendのorigin（例:`https://backend-….run.app`、末尾スラッシュなし）を渡します。
Webのビルドは`VITE_USE_MOCK=false`、`VITE_API_BASE_URL=/api/v1`で固定し、同じ成果物を環境間で使います。
WebはAPIの404をSPAへ置き換えず、内部APIや隠しファイル、mockServiceWorkerを配信しません。
ブラウザーのAuthorizationはBackendへ転送します。WebへのCloud Run用`X-Serverless-Authorization`は転送しません。

GHCRの配布先は`ghcr.io/<owner>/<repository>/<service>:sha-<40桁SHA>`（小文字）です。
Release summaryにdigestを記録します。運用で参照する場合はdigestを使用してください。同じSHAでCIを再実行するとタグが更新され得ます。
Cloud Runへの配布はCI runのartifactを直接使用し、Artifact Registryへのpush後に解決したdigestでdeployします。
GHCR公開はGCP credentialsがなくても動きます。GHCR packageのvisibilityはGitHub側で管理してください。

## Cloud Run初期設定

デプロイ先は設計書3.2の既定候補Cloud Runです。以下のインフラはworkflowでは作成しません。

- Cloud Run、Artifact Registry、IAM Credentials、STS APIを有効化したGCP project。
- 指定regionのDocker Artifact Registry repository。
- staging/productionの各サービス、別々のruntime service account、既存の正常なrevisionと100%のtraffic。
- GitHub OIDC用Workload Identity Pool/Provider、deploy用service account。
- 必要な環境変数・Secret Manager参照・ingress/IAM・監視設定。

初回作成はインフラ管理者が行います。今回のDeployは既存serviceの更新用で、復元先のない初回作成を拒否します。
Cloud Runの[初回デプロイ手順](https://cloud.google.com/run/docs/deploying)に従い、既知のイメージ・runtime service accountを指定して作成してください。
キーJSONをGitHub Secretsやrepoへ保存せず、[Workload Identity Federation設定](https://github.com/google-github-actions/auth#setting-up-workload-identity-federation)を使用してください。
Providerのattribute conditionでrepository owner ID / repository ID / main ref / Environmentのsubjectを限定します。repository名だけの広い信頼設定は避けます。
Environment別に異なるdeploy用service account/Providerを指定できます。

Deploy SAに必要な権限:

| 対象 | 権限 |
| --- | --- |
| 対象Artifact Registry repository | Artifact Registry Writer |
| 対象Cloud Run services | Cloud Run Developer（既存service更新、revision/traffic操作、参照） |
| AI service IAM policy | `run.services.getIamPolicy`を含む閲覧権限 |
| 対象3 runtime service account | Service Account User（actAs） |
| 対象Cloud Run services | Cloud Run Invoker（候補/本番HTTP検証） |
| Deploy SAに対する許可済みGitHub principal | Workload Identity User（OIDCとID token発行） |

必要に応じて最小権限のcustom roleを使います。Deploy SAはruntime accountとして使わず、CI/CDにFirestore・資料Storageのアクセス権を付けません。
Web/Backend/AIのruntime accountは別々にし、業務Firestore・原本Storage権限はBackendだけに付与します。
AIには`allUsers`/`allAuthenticatedUsers`のInvoker bindingやIAM check無効化を設定しません。
workflowはAIのservice policyとIAM check設定に加え、認証なしのHTTPが401/403になることも検査します。projectからの継承IAMは管理者が別途確認してください。

Cloud RunのIAM認証はingress制限とは別です。GitHub-hosted runnerから候補revisionのURLに到達できる必要があります。
内部ingress限定のAIを利用する場合、許可されたネットワーク上のrunnerへ切り替えてください。疎通のためにAIを公開する変更はworkflowでは行いません。

### Environment variables

GitHubの各Environmentに設定します。以下は識別子であり、サービスアカウントの秘密鍵ではありません。

| Variable | 例 |
| --- | --- |
| `GCP_PROJECT_ID` | `after-flow-staging` |
| `GCP_REGION` | `asia-northeast1` |
| `GCP_ARTIFACT_REPOSITORY` | `after-flow` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | `github-deploy@<project>.iam.gserviceaccount.com` |
| `CLOUD_RUN_SERVICE_PREFIX` | `after-flow-staging` |
| `WEB_RUNTIME_SERVICE_ACCOUNT` | `web@<project>.iam.gserviceaccount.com` |
| `BACKEND_RUNTIME_SERVICE_ACCOUNT` | `backend@<project>.iam.gserviceaccount.com` |
| `AI_RUNTIME_SERVICE_ACCOUNT` | `ai@<project>.iam.gserviceaccount.com` |

サービス名は`<CLOUD_RUN_SERVICE_PREFIX>-web`、`-backend-server`、`-ai-server`です。
workflowは現在のruntime accountがこの設定と一致することを確認します。環境変数・Secrets・IAM・ingressをdeploy引数で上書きしません。
Webの`BACKEND_ORIGIN`は**Cloud Runサービス自身**の環境変数として設定します。
現在のnginxはBackend向けのIAM tokenを発行しません。Web→Backendはアプリ認証付き公開APIを前提とし、IAM privateなBackendへの接続には別途認証proxyが必要です。

## デプロイ・切り戻し

1. mainのCI成功runを開き、URLの`/actions/runs/<id>`からIDを確認する。
2. `Deploy Cloud Run`を**main**で実行し、Environment・service・CI run IDを指定する。
3. production Environmentの承認者が対象commit/runを確認して承認する。
4. 候補revisionのliveness（WebではBackend proxyも）が成功すると、そのrevisionへ100%切替。切替後失敗時は以前のrevision割合へ自動復元を試み、workflowは失敗する。
5. Actions summaryでcommit、image digest、revision、以前のtrafficを確認する。

同一環境・サービスのdeployは直列化し、実行中のdeployを新しい実行でキャンセルしません。
異なるサービスの更新は独立しているため、互換性のある順番で手動実行してください。複数サービスの一括トランザクションではありません。
自動復元もクラウド障害・権限不足・強制キャンセル時には失敗し得ます。手動の復旧は以下です。

```sh
gcloud run services update-traffic "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --to-revisions "previous-revision=100"
```

以前にtraffic分割していた場合は、記録された`rev-a=90,rev-b=10`等を指定します。
古い正常なCI runのartifactが残っていれば、そのrun IDを指定して通常のDeploy検証経路で再配置することもできます。
artifact期限切れ時は復元可能なCloud Run revisionを使用します。PRのartifactや未検証の手動buildへ置き換えません。

## 検証範囲と残る前提

- 本変更のローカル検証対象は型・Lint・テスト・OpenAPI・Emulator統合テスト・build・actionlint/ShellCheck・開発/本番DockerのHTTP/分離チェックです。
- GHCRへの実push、GitHub-hosted runner実行、OIDC/IAM、実Cloud Runへのdeploy/traffic切替は、接続後にstagingで検証が必要です。
- ブラウザー操作のE2E、実環境での業務シナリオ、DB migration、バックアップ復元、LLM呼出し、負荷試験はこのliveness検証に含みません。
- Outbox workerの常駐実行・Cloud Run Jobs/Schedulerへの配備はこの3サービスのDeployに含みません。
- Backendの業務APIとFirestore Adapterは実装されていますが、認証Provider・本番データ接続・同意文書・ルールカタログなどの設定は別途必要です。Mastra/Orchは未接続です。liveness成功だけを根拠に実データ運用を開始しないでください。
- Backendは`GET /internal/v1/health/ready`で本番稼働可能性（readiness）を別途検査できます（[docs/runbooks/readiness.md](runbooks/readiness.md)）。現在のcandidate revision smoke test（本ファイル記載）はlivenessだけを見ています。readinessをsmoke testへ接続する設計は上記runbookに記載していますが、`READINESS_ACCESS_TOKEN`のSecret経路の決定が必要なため、このworkflowへの実接続は別途対応します。
