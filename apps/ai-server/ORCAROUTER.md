# OrcaRouter接続

指定製品は [OrcaRouter](https://www.orcarouter.ai/ja)。`OrchRouter` は以前の仮称・仮想インターフェース名。実製品は推論ゲートウェイであり、独立した業務Route選択APIを仮定しない。

## 手元で確認する

ルートの `.env` に `ORCAROUTER_API_KEY=...` を設定し、Node 22 / pnpm 10で実行する。

```sh
pnpm install --frozen-lockfile
pnpm smoke:orca
# 別worktreeから既存のキーを使う場合
pnpm smoke:orca --env-file /absolute/path/to/.env
```

キーは既存の環境変数を優先し、未設定時だけ指定ファイルから読む。他の環境変数は読み込まない。`.env` をAIへ丸ごと注入したり、`VITE_*` にキーを設定しない。

このコマンドは `openai/gpt-4o-mini` への少量の有料リクエストを行う。合成入力だけで通常応答、日本語ストリーム、Mastra Tool実行、構造化JSONを検査する。最大4要求、出力上限は最初8・以後128 token、各要求30秒、Mastraの再試行は0。キー・入力・出力・SDK例外は表示せず、結果と利用量を表示する。CIの通常テストは実APIを呼ばない。

2026-09-21にこの4項目を実APIで確認済み。複数モデルの実切り替え、業務判断の品質、Backendと画面を含むE2Eの合格を意味しない。

## 実行サービスへ組み込む

`startConfiguredAiService` に `orca: { apiKey, timeoutMs? }` を渡すと、Policyごとに実SDKモデルを作り、Core/Research双方に認可済みのモデル群を渡す。旧 `orch` / `models` を同時に指定しない。`readOrcaApiKey` はデプロイコードからも利用できる。

- `modelId` はレビュー済みの明示的な `vendor/model`。例: `openai/gpt-4o-mini`。
- `sdkProvider` は `orcaSdkProvider(modelId)`。例: `orcarouter-openai.chat`。これはゲートウェイ経由のモデル系列を表し、物理的な上流提供先の証明ではない。
- 各RoleのPolicyは順序付き1〜2件。サービス全体では既存要件どおり異なる系列を2件以上、同一の予算通貨で設定する。価格上限・有効期限・保持条件・Backend grantを合成値で埋めない。
- 推論の直前ごとに最新grant・取消・共有予算を確認する。各試行に最大token/費用を予約し、出力tokenを制限する。
- Mastra標準fallbackを使用。429/5xxの場合だけ次の許可済みモデルへ進む。401/402/403、認可取消、部分出力後の障害は停止する。ネットワークエラー・timeoutも現在は停止し、無条件再送しない。
- 接続先は `https://api.orcarouter.ai/v1/chat/completions` に固定。リダイレクトや任意のルーター/追加リクエスト設定を拒否する。ゲートウェイ側の追加fallbackや名前付きrouterは未対応。

開発Composeでは、APIキーがある場合に限り、ハッカソン用Policy、本文を含まないメトリクス、協会けんぽの公式資料Catalog、Task Template、Research Scope、AI専用Runtimeを既定の `main.ts` へ接続する。`/internal/v1/ready` で接続状態を確認できる。Backendのcontrolを各送信前に再確認するが、Provider Policyとgrantはハッカソン用のローカル仮定であり、本番同意の代替ではない。

APIキーが無い場合や `AI_RUNTIME_MODE=disabled` の場合はlivenessだけで起動し、実行受付は503を維持する。Backend Outbox workerと `AI_CONNECTED_OPERATIONS` は既定で有効化しないため、APIキーだけで画面から業務Runが始まることはない。

## 利用証跡と費用

ローカルで選んだPolicyの識別子は `selectionId` (`orca-policy-...`)。Workflowの既存 `evidenceId` にもこの識別子を渡すが、OrcaRouterの返答を表す証跡ではない。Orcaモードの `routeEvidenceId` は `null` とする。

成功した物理呼出しごとに `ProviderMetric.gateway` に `X-Orca-Request-Id`、要求モデル、公開されていれば解決/fallbackモデル、暫定 `costUsd` を記録する。使用token・時間・失敗分類は既存メトリクスに記録する。応答ヘッダーのモデルが設定と異なる場合やrequest ID欠落は成功と扱わない。本文のモデル名は上流の版付き名になり得るため一致判定に使わない。

`usage.cost_usd` は暫定値。欠落は `null` であり無料ではない。確定費用の `GET /v1/generation` 照合、失敗要求のgateway receipt保存、Backendへの専用証跡契約は後続。OrcaRouterは物理的な上流routing詳細を公開しないため、2系列の設定だけで独立した2 Providerを検証済みとはしない。

ハッカソンの必須利用判定条件は主催要項との照合が残る。実推論をOrcaRouter経由にする実装であり、ゲートウェイ固有の自動モデル選択機能の採用を主張しない。

## 公式仕様

- [Chat Completions](https://docs.orcarouter.ai/api-reference/chat/create-a-chat-completion)
- [Framework互換](https://docs.orcarouter.ai/compatibility/frameworks)
- [応答ヘッダー](https://docs.orcarouter.ai/routing/response-headers)
- [リクエスト単位の費用](https://docs.orcarouter.ai/operations/per-request-cost)
- [Fallback](https://docs.orcarouter.ai/routing/model-fallbacks)
- [データ取扱い](https://docs.orcarouter.ai/operations/data-handling) — ゲートウェイと上流モデルの条件を別々にレビューする。
