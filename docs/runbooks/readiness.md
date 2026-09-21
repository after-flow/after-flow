# Backend readiness（本番稼働可能性）

対象: [#123](https://github.com/after-flow/after-flow/issues/123)。`GET /internal/v1/health/ready`。

`/api/v1/health`（liveness、公開・無認証）とは別契約。livenessはプロセスが要求を受け付けられることだけを示し、
Firestore・原本Storage・認証設定・同意カタログ・期限ルール・AI接続の有無を意味しない。
readinessはこれらの必須依存を実際に検査し、本番稼働可能性を判定する。

## OpenAPI公開範囲とアクセス制御

- **公開OpenAPI（`docs/api/public-openapi.yaml`）には載らない。** `publicV1Specs`（route-spec駆動）に含めていない。ブラウザー/エンドユーザー向け契約ではないため。
- **内部AI実行API（`docs/api/internal-execution.md` / `docs/api/internal-openapi.yaml`）にも載らない。** AI↔Backendの内部契約（`packages/internal-contracts`由来）とは別物で、AIには一切公開しない。
- パスは`internal-contracts`のAI向けroute（`/runs/:runId/...`）と衝突しないよう`/internal/v1/health/ready`を使う。同じ`/internal/v1`配下だが、AI実行API（`createExecutionApp`）とは別のHono appとして`app.ts`が個別にmountする（`readinessApp`）。
- アクセス制御は`READINESS_ACCESS_TOKEN`（Bearer token、固定長digestでの比較）。**AI向け資格情報（`AI_SERVICE_TOKEN` / `BACKEND_INTERNAL_SERVICE_TOKEN`）とは必ず別の値**で、起動時に一致していれば拒否する（`composition.ts`）。AIにもブラウザーにもこのtokenを配布しない。
- `backend-server`のCloud RunはAI Serverと異なり公開許可（unauthenticated invoker）が前提のため、Cloud RunのIAM検査だけでは守れない。このBearer tokenがアプリ層の唯一の壁になる。
- `READINESS_ACCESS_TOKEN`が未設定なら、この endpoint 自体を mount しない（`404`）。他の任意機能（内部AI実行API等）と同じ「未設定なら公開しない」方針。

想定する呼び出し元は運用/デプロイツール（Cloud Runのrevision smoke test、監視）だけで、AIやブラウザーではない。

## 検査する依存

| 検査名 | 内容 | `NOT_CONFIGURED`以外の主な失敗理由 |
|---|---|---|
| `firestore` | `Firestore#listCollections()`で疎通のみ確認（業務データは読まない） | `CHECK_FAILED` / `CHECK_TIMEOUT` |
| `storage` | 原本Storageの`exists(存在しないkey)`で疎通のみ確認（読み書きしない） | `CHECK_FAILED` / `CHECK_TIMEOUT` |
| `auth` | 認証設定が揃っているか。`static-jwks`・`firebase-emulator`は試験・ローカル専用のため、設定できていても本番相当とは扱わない | `STATIC_JWKS_NOT_PRODUCTION_GRADE` / `EMULATOR_NOT_PRODUCTION_GRADE` |
| `session_revocation` | 失効・停止確認（ADR 0001 §5。Admin SDKでのrevoke確認等）が実装済みか | `SESSION_REVOCATION_NOT_ENFORCED`（認証が設定されている限り常にfail。本番公開前に対応が必要な既知の欠落） |
| `consent_catalog` | 同意カタログが`placeholder:true`（仮文面）でないか | `PLACEHOLDER_CATALOG` |
| `deadline_rules` | 期限ルールが`placeholder:true`（業務レビュー未了）でないか | `PLACEHOLDER_CATALOG` |
| `ai_internal_auth` | AI操作が有効化されている場合だけ。Backend/AI間の内部認証設定が揃っているか | `NOT_CONFIGURED` / `INVALID_SIGNING_KEY` |
| `ai_connectivity` | AI操作が有効化されている場合だけ。AI Serverの`/internal/v1/health`へ認証付きで疎通できるか | `UNREACHABLE` / `STATUS_*` / `INVALID_RESPONSE` |

`ai_internal_auth` / `ai_connectivity` は「AI操作が有効化されている場合だけ」検査に加える（`connectedOperations`が非空のとき）。
無効なら検査自体を含めない。AI未接続の開発環境を「AI検査で落ちるreadiness」にしない。

**`ai_connectivity`が確認できるのはAI ServerプロセスがHTTPへ応答することだけ。** Mastra/Orchの機能的な準備完了は保証しない（#123対象外）。
architecture.md 6.3に記載の`GET /internal/v1/health/ready`はAI Server側の将来実装であり、現時点のAI Serverには無い。
実装され次第、`ai_connectivity`が呼ぶ先をそちらへ切り替えることを検討する。

## readyの判定と応答

- 起動直後の値ではなく、要求ごとに毎回すべての検査を並行実行する。既定タイムアウトは検査ごと3秒。超えたら`CHECK_TIMEOUT`としてfail扱いにする（依存先の遅延でreadiness自体が長時間ブロックされないようにするため）。
- 1つでもfailすれば`not_ready`、全てokなら`ready`。
- 200 (`ready`) / 503 (`UNAVAILABLE`、`not_ready`。`retryable:true`)。応答bodyに検査名・status・固定の理由コードだけを含める。
- 例外の`message`/`cause`はそのまま外へ出さない・ログにも残さない（接続文字列や内部状態を含みうるため）。理由コードは`CHECK_FAILED`のような固定文字列に丸める。

## 「未接続」と「本番の設定不備」の区別

開発環境（`make up`等）は既定でFirestore/原本Storageだけを設定し、認証・同意カタログ・期限ルール・AI接続は未設定のまま動く。
これは意図的な「未接続」であり、livenessはそれを気にしない。readinessは同じ状態を`auth: NOT_CONFIGURED`のように明示的に`not_ready`として報告する。
`NODE_ENV`に関わらず同じ基準（本番相当かどうか）で検査するため、`AUTH_MODE=static-jwks`のように**起動はできるが本番相当ではない設定**もreadinessでは`fail`になる。

## Cloud Runのrevision smoke testへの接続（設計。本セッションでは未接続）

現在`.github/workflows/deploy.yml`は候補revisionに対して`scripts/smoke-cloud-run.mjs`でliveness（`/api/v1/health`等）だけを検証し、
成功後にtrafficを切り替える。readinessをこの経路へ接続する設計は以下のとおり。実際のworkflow編集は本Issueのスコープ外（#123セッション注記）。

1. `staging`/`production`のGitHub Environmentに`READINESS_ACCESS_TOKEN`をSecretとして追加する（Secret Managerからの注入、またはEnvironment secret）。デプロイ用のGCP Service Accountの権限とは別軸。
2. `smoke-cloud-run.mjs`の`verifyDeployment`に、`backend-server`のときだけ`GET {url}/internal/v1/health/ready`への呼び出しを追加し、`Authorization: Bearer ${READINESS_ACCESS_TOKEN}`を付ける（既存の`X-Serverless-Authorization`はCloud Run自体のIAM認証で、これとは別レイヤー）。
3. 応答が`200`かつ`data.status === 'ready'`であることを候補revisionへのtraffic切替前提条件に加える。`not_ready`（503）ならその理由（`checks[]`）をActions summaryへ記録し、切替を止める。
4. 既存の「切替後liveness失敗で自動復元」と同じパターンで、切替後にもreadinessを再検証してよい。ただし、切替直後は新revisionのcold startと重なるため、liveness成功後にreadinessを見る順序を保つ。
5. 秘密値はGitHub Secretsに保存し、ログへ出さない（`smoke-cloud-run.mjs`は現状もtoken自体をログしていない）。

この接続を今回実施しない理由: `READINESS_ACCESS_TOKEN`をどのSecret経路（Secret Manager直接参照 or GitHub Environment secret）で渡すかは運用/インフラ管理者の決定が必要で、
`docs/ci-cd.md`が明記する「管理者がGitHub Settingsで設定する」対象と同じ性質の変更のため。ロジック自体（何を検査しどう判定するか）は実装済みで、接続はコードの一行差分に収まる。

## 既知の制約

- 実Firestore/Storageへの「到達不能」を伴う障害検知は、SDK自体のretry/backoffに影響され、`withTimeout`で応答時間は打ち切れても、SDK内部の再試行が応答後もしばらく裏で続くことがある（readinessは起動時に作った同一clientを使い回すため、要求ごとに新規clientを作るよりは影響が小さい）。
- `storage`検査はStorageポート（`ObjectStorage#exists`）越しの疎通確認であり、ローカル保存（`LocalObjectStorage`、開発専用）は権限・ディスク障害を`exists`が握りつぶす実装のため、本番のCloud Storage Adapterほど検査として厳密ではない。
- `auth`検査は設定の型・モードだけを見る。JWKS URIへの実疎通は行わない（[ADR 0001](../adr/0001-authentication-provider.md)は採用Providerを決定済みだが、実Firebase projectでの実接続検証は別途）。
- `session_revocation`は「未実装であること」を常時報告する固定fail。ADR 0001 §4の7日上限（`auth_time`検証）は`JwtTokenVerifier`/`FirebaseEmulatorTokenVerifier`で実装済みだが、§5の失効・停止確認（Admin SDKでの明示的なrevoke確認）は未実装のため区別している。
- `consent_catalog` / `deadline_rules`は`placeholder`フラグの検出に加えて、`NODE_ENV=production`では読込自体が失敗する（`readConsentCatalog` / `readRuleCatalog`が`CONSENT_CATALOG_PATH` / `DEADLINE_RULES_PATH`未設定または`placeholder:true`を例外で拒否する）。readinessはこの例外も同じ`NOT_CONFIGURED`に丸め込む。正式カタログ・正式ルールの内容そのものの正しさは[#128](https://github.com/after-flow/after-flow/issues/128)・[#129](https://github.com/after-flow/after-flow/issues/129)の決定事項で、この検査の対象外。
- **運用上の帰結**: `readRuleCatalog`は`composition.ts`（`createServer`）と`worker-main.ts`の両方が起動時に呼ぶ。`NODE_ENV=production`かつ正式カタログ（`placeholder:false`）が無ければ、readinessが`not_ready`を返すだけでなく、**Backend/Workerプロセス自体が起動しない**（起動時に例外で落ちる）。[#129](https://github.com/after-flow/after-flow/issues/129)の業務レビューが完了して正式カタログを`DEADLINE_RULES_PATH`に設定するまで、本番デプロイはこのガードで止まる。これは意図した挙動（未承認の法定期限を本番で表示しない）であり、暫定回避としてカタログを丸ごと`reviewed:false`にする、`placeholder:false`だけ偽装する等は行わないこと。
- 期限ルールのカタログ（`DEADLINE_RULES_PATH`の指すファイル）を差し替えても、既に保存済みの`DeadlineEntity`は自動で再計算されない。反映するには対象Caseごとに`POST /cases/:caseId/deadlines/reevaluate`を呼ぶ必要がある（`ruleVersion`の差分で更新対象を検出する。カタログ変更をトリガーに全Caseを自動再評価する経路は無い）。
- Mastra/Orchの機能的な準備完了はこのreadinessでは確認しない（#123対象外、architecture.mdの将来API一覧とは区別する）。

## 試験範囲

SDK境界のFake（Firestore/AI Server）とReadinessServiceの単体試験で、正常・各依存の未設定・placeholder検出・タイムアウト・例外時の理由コード丸め込みを確認する。
Firestore Emulatorで実Adapterの疎通成功と、Firestore/Storage/認証設定/同意カタログ/期限ルールが揃った場合に`ready`になることを確認する。
実Cloud Run、実AI Server、実認証Provider、正式カタログ内容は未検証。
