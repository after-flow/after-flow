# ローカルでSwagger UIから業務APIを試す

対象: 開発環境（`make up`）。本番の認証Provider（Firebase Authentication、[ADR 0001](../adr/0001-authentication-provider.md)）と
同じ経路（Firebase ID token）を、ローカルは Firebase Auth Emulator で再現する。`AUTH_MODE=firebase-emulator` は
`NODE_ENV=production` では起動を拒否し、readinessも本番相当とは扱わない。

## `make up` だけで認証は動く

`make up` は3アプリと Firebase Auth Emulator（`firebase-auth-emulator`、data profile）を一緒に起動する。
追加の鍵生成や `.env` 編集は不要。

```sh
make up
```

Auth Emulator は署名なし（`alg:"none"`）の ID token を発行し、Backend はそれだけを受理する
（`AUTH_MODE=firebase-emulator` は本番拒否モード）。ブラウザーは公開ポート `127.0.0.1:9099` へ
直接アクセスする（前提: **127.0.0.1 バインド**。リモート Docker ホストで使う場合は
`VITE_FIREBASE_AUTH_EMULATOR_URL` の差し替えが必要で、その場合ローカル限定の
fail-closed 前提が崩れる点に注意する）。署名を検証しないため、Emulator に到達できる者は
任意の uid を名乗れる。

## 2. 起動して利用者を登録する

Backend は認証済みでも tenant membership（Firestore の `tenants/{AUTH_TENANT_ID}/members/{uid}`）が
無ければ、`GET/POST /me` 以外は 403 `NOT_REGISTERED` になる。

`make up` は最後に `dev-seed-demo` を自動実行し、固定のログイン情報
`demo@example.com` / `after-flow-dev-password`（`DEV_EMAIL` / `DEV_PASSWORD` で変更可）を
Auth Emulator に作成（emailVerified済み）した上で、そのuidを tenant `after-flow-demo`
（`DEV_TENANT`）へ member登録する。Frontend（`VITE_USE_MOCK=false`）はこのメール・パスワードで
そのままログインできる。Auth Emulator はコンテナ再作成で消えるため、`make up` のたびに作り直す
（冪等）。

別のメール・パスワードで用意したい場合や、tenantだけ登録し直したい場合は個別に呼べる。

```sh
make dev-seed-demo DEV_EMAIL=another@example.com DEV_PASSWORD=another-password
make dev-seed                          # tenant after-flow-demo に demo-user を登録（uidを直接指定する場合）
make dev-seed DEV_USER=<uid>           # make dev-token で取得したuidを登録する場合
```

Swagger UI だけで使う場合や、Frontend を介さず個別のトークンを取得したい場合は、取得したトークンで
`POST /me` を呼ぶ（Frontend の登録フローと同じ経路）。

## 3. トークンを取得して Swagger UI で Authorize する

```sh
make dev-token                                          # 既定 demo@example.com
make dev-token DEV_EMAIL=another@example.com DEV_PASSWORD=another-password
```

Auth Emulator にアカウントが無ければ作成し（あれば同じパスワードでサインイン）、`emailVerified` を
true にしてから ID token を返す（有効約1時間）。ローカルの既定は `AUTH_REQUIRE_EMAIL_VERIFIED=false`
なのでメール確認は必須ではないが、`AUTH_REQUIRE_EMAIL_VERIFIED=true` にして試す場合は
`make dev-verify-email DEV_EMAIL=...` で個別に確認済みにできる。

1. http://127.0.0.1:8080/api-docs を開く。
2. 右上の **Authorize** に、表示されたJWTを貼る（`Bearer ` は付けない）。
3. 書き込み系のAPIには `Idempotency-Key` ヘッダーが必須。Swagger UIの各操作にパラメーターとして表示されるので、任意の一意な文字列（例: UUID）を入れる。

`make dev-token` / `make dev-verify-email` は `make up` 済み（`firebase-auth-emulator` が起動している）
ことが前提。`docker compose run --no-deps` ではこのサービスへ到達できないため、`exec` を使う。

## 4. task_guidance を1本通す手順

前提: `.env` に `AI_CONNECTED_OPERATIONS=task_guidance` と `ORCAROUTER_API_KEY` を設定して `make up` している。
`AI_CONNECTED_OPERATIONS` が空なら案内依頼は `501 FEATURE_NOT_CONNECTED`、`ORCAROUTER_API_KEY` が無ければ
Backend は 202 で受け付けるが AI Server が 503 を返し、Outbox は RETRYABLE のまま残る（成功扱いにはならない）。

| 順 | 操作 | 内容 |
| --- | --- | --- |
| 1 | `POST /consents` | `TERMS` / `PRIVACY` / `CROSS_BORDER_AI` を `GET /consents` が返す `version` で同意する。`CROSS_BORDER_AI` が無いと AI 操作は 403 |
| 2 | `POST /cases` | `deceasedName` / `dateOfDeath` / `ownerName` / `relationshipToDeceased` を入れる。応答の `data.id` が caseId |
| 3 | `GET /cases/{caseId}/tasks` | 数秒後に backend-worker が `case.created` を処理し、初期Taskが並ぶ |
| 4 | `POST /cases/{caseId}/tasks` | ハッカソン用 Research Scope と一致させる: `title` = `健康保険の埋葬料（費）を確認する`、`category` = `insurance-benefit`、`submitTo` = `全国健康保険協会`、`stage` = `government` |
| 5 | `POST /cases/{caseId}/tasks/{taskId}/guidance/requests` | 202。応答の `agentRunId` を控える |
| 6 | `GET /cases/{caseId}/agent-runs/{runId}` | `QUEUED` → `RUNNING` → `SUCCEEDED`。202は完了ではない |
| 7 | `GET /cases/{caseId}/tasks/{taskId}/guidance` | AIが返した必要書類・手順・出典。未依頼のときは `404` ではなく `200 {status:'NOT_REQUESTED'}` |

Task の title / category / submitTo が Scope と一致しないと、AI は根拠不足として `needs_input` の結果を返す。

裏側の確認:

```sh
make logs SERVICE=backend-worker   # delivered / retrying / pending
make logs SERVICE=ai-server        # dispatch 受付、OrcaRouter 呼出しのメトリクス
```

## 制約

- 開発用トークンと seed は本番の登録・招待・失効の代替ではない。
- `.env` は commit しない。鍵を配布しない。
- `after-flow-demo` 以外の tenant を使う場合は `.env` の `OUTBOX_TENANT_IDS` と `AUTH_TENANT_ID` の両方を変える。片方だけ変えると Worker が対象tenantのOutboxを処理しない、または認証が通らない。
