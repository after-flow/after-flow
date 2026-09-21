# ローカルでSwagger UIから業務APIを試す

対象: 開発環境（`make up`）。本番の認証Provider（Firebase Authentication、[ADR 0001](../adr/0001-authentication-provider.md)）が
未接続でも、固定鍵の `AUTH_MODE=static-jwks` と開発用JWTで公開APIを呼べるようにする。
`static-jwks` は `NODE_ENV=production` では起動を拒否し、readinessも本番相当とは扱わない。

## 1. 認証鍵と設定を用意する（初回のみ）

```sh
make dev-auth
```

ES256の鍵対を生成し、秘密鍵を `.dev-auth/private.jwk.json`（gitignore済み）へ保存する。
`.env` には Backend 向けの `AUTH_MODE` / `AUTH_ISSUER` / `AUTH_AUDIENCE` / `AUTH_TENANT_CLAIM` / `AUTH_STATIC_JWKS`（公開鍵のみ）を追記する。
Backend コンテナへ秘密鍵は渡さない。作り直す場合は `.env` の認証行を消して再実行する。

## 2. 起動して利用者を登録する

```sh
make up
make dev-seed                          # tenant after-flow-demo に demo-user を登録
make dev-seed DEV_USER=another-user    # 別の利用者を足す場合
```

認証済みでも tenant membership が無ければ 403 になる（tokenの自己申告を membership で裏取りする設計）。
seed は Firestore Emulator に対してだけ動く。

## 3. トークンを取得して Swagger UI で Authorize する

```sh
make dev-token                                   # 既定 demo-user / after-flow-demo / 8時間
make dev-token DEV_USER=another-user DEV_TOKEN_TTL=3600
```

1. http://127.0.0.1:8080/api-docs を開く。
2. 右上の **Authorize** に、表示されたJWTを貼る（`Bearer ` は付けない）。
3. 書き込み系のAPIには `Idempotency-Key` ヘッダーが必須。Swagger UIの各操作にパラメーターとして表示されるので、任意の一意な文字列（例: UUID）を入れる。

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
| 7 | `GET /cases/{caseId}/tasks/{taskId}/guidance` | AIが返した必要書類・手順・出典 |

Task の title / category / submitTo が Scope と一致しないと、AI は根拠不足として `needs_input` の結果を返す。

裏側の確認:

```sh
make logs SERVICE=backend-worker   # delivered / retrying / pending
make logs SERVICE=ai-server        # dispatch 受付、OrcaRouter 呼出しのメトリクス
```

## 制約

- 開発用JWTと seed は本番の登録・招待・失効の代替ではない。Frontend の実ログインは別途 Firebase で接続する。
- `.env` と `.dev-auth/` は commit しない。鍵を配布しない。
- `after-flow-demo` 以外の tenant を使う場合は `.env` の `OUTBOX_TENANT_IDS` にも追加する。追加しないと Worker がそのtenantのOutboxを処理しない。
