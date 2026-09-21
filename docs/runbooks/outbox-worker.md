# Backend Outbox worker

対象: #38 / #37 / #122（ローカル接続部分）。HTTPサーバーとは別の常駐プロセスとして起動する。
Cloud Run本番配備方式（常駐 vs Job+Scheduler）の決定と本番IAM/tenant割当/監視接続は#122の対象外のまま未決定。

## ローカルDocker（`make up`）

`compose.yaml`の`outbox-worker`サービスがBackend HTTPコンテナ(`backend-server`)とは独立したコンテナとして
`pnpm --filter @aftercare/backend-server worker`を実行する。`make up`の`--profile data`起動に含まれ、
`firestore-emulator`のhealthy後に自動起動し、異常終了時は`restart: unless-stopped`で再起動する。

```sh
make up                                                 # backend-server / outbox-worker を含め起動
make worker-logs                                        # tickログ(配送/retrying/backlog件数)を表示
docker compose --profile data ps outbox-worker           # 起動状態を確認
docker compose --profile data restart outbox-worker      # 手動再起動して回復を確認
make worker-once                                        # Job形式で使い捨てコンテナが1バッチだけ実行
```

既定の対象tenantは`OUTBOX_TENANT_IDS=after-flow-local`（`make up`が設定）。実データのtenantで確認する場合は
`OUTBOX_TENANT_IDS=<tenant1>,<tenant2> make up`のように上書きする。AI配送設定(`AI_SERVER_URL`等)を渡さない間は
Backend本体と同じ既定どおり配送は行われず、イベントはPENDINGのまま残る。`outbox-worker`は`ai-server`と同じ
`services`ネットワークに参加するがAI Server自体へは環境変数を渡さず、`ai-server`はdata networkへ参加しない
（`scripts/verify-boundaries.mjs`が検証）。

`outbox-worker`にだけ`AI_SERVER_URL`/`AI_SERVICE_TOKEN`等と`BACKEND_EXECUTION_SIGNING_KEY`を設定しても、
ローカルcomposeでは実際のAI配送は成立しない。`compose.yaml`の`backend-server`と`ai-server`には対応する
env（`BACKEND_EXECUTION_SIGNING_KEY` / `BACKEND_INTERNAL_SERVICE_TOKEN` / `AI_SERVICE_TOKEN`等）を渡しておらず、
AIからBackendへのcallback（内部execution app）は`composition.ts`がmountせず404になる。さらに`ai-server`自体の
execution runtimeは未実装で（`apps/ai-server/src/main.ts`が`runtime`/`worker`を組み立てずに起動する）、
たとえ認証情報を揃えても`internal/v1/runs/:runId/dispatch`は常に`503 AI_EXECUTION_NOT_CONNECTED`を返す。
つまり本Issue(#122)のローカル接続範囲で確認できるのは「`outbox-worker`が独立コンテナとしてOutboxを配送しようと
試みる（HTTP呼び出しがRETRYABLEで終わりPENDINGのまま残る）」ことと、AI接続なしで成立するローカルhandler
（`case.created`→初期Task、`case.reference_dates_changed`→期限再評価）の配送までであり、AIへのRun配送そのもの
の実接続確認は対象外（AI側runtime実装後の別Issue）。

## Node直接実行

Docker無しで動作を確認する場合、または`--once`をジョブとして個別実行する場合に使う。
Backendと同じ業務Firestore、同意カタログ、期限ルールを設定する。
`OUTBOX_TENANT_IDS` に担当するtenant IDをカンマ区切りで指定する。暗黙の全tenant走査はしない。
この環境設定・Firestore権限をAIサービスに渡してはいけない。

```sh
pnpm --filter @aftercare/backend-server worker
# Scheduler/ジョブ形式では1バッチを実行し、成否を終了コードで確認する
pnpm --filter @aftercare/backend-server worker:once
# build済み環境
node apps/backend-server/dist/worker-main.js
```

プロセス監視基盤により異常終了時に再起動する。Cloud RunならCPUの常時割当を持つ独立worker、
またはSchedulerから `--once` ジョブを定期起動する構成が必要（本番配備方式の決定は#122の対象外）。
ローカルDockerでは`restart: unless-stopped`が同じ役割を果たす。HTTP応答後の実行継続には依存しない。

## 配送・回復

- 既定間隔5秒、可視性タイムアウト120秒、1tenantあたり1回20件。HTTP timeoutは可視性タイムアウト未満にする。
- `SIGTERM` / `SIGINT` は新規バッチを止め、実行中のバッチを待って接続を閉じる。
- 強制停止後もPENDINGと期限切れIN_FLIGHTを保存済みOutboxから再取得する。
- claim時にTransaction内で期限を再検証する。claim IDが変わったイベントを旧workerの応答では更新しない。
- 配送保証はat-least-once。同じevent IDを受信側が永続的に重複排除する。配送タイムアウトを成功として扱わない。
- `nextAttemptAt` の旧ISO文字列とTimestampを読み、新規更新はTimestampに統一する。イベントを削除・再作成して再送しない。
- `case.created` は初期Task生成、`case.reference_dates_changed` は期限再評価をBackend内で実行する。
  最新Caseを読み、古いイベントの起算日で上書きしない。AI接続・任意AI同意なしでも手動管理用の処理を続ける。
- 外部配送では毎回同意を再判定する。未接続ならPENDINGで再試行する。
- `proposal.applied` / `approval.rejected` / `document.registered` はBackend Inboxへ冪等保存する。`approval.requested`はローカル通知として扱い、個人データをAIへ汎用転送しない。
- 各tickで担当tenantのRunを安定した100件ページで照合する。先行Inbox、Snapshot保存後に通知できなかった待機、期限切れlease/RUNNINGを回復する。
- SnapshotメタデータはAI内部HTTP経由だけで確認。1件の照会失敗はfailedとして数え、後続Runを続ける。同意/権限失効RunはHTTP照会前に取消す。
- `agent.resume` / `agent.recover` はSYSTEM生成。Scoped clientが保存済みRunの開始者を再認可してから配送する。
- 実検査が未完了のため、`agent.document_analysis` と文書本文配送、DOCUMENTS条件の自動再開は無効。この実装を#27や実AI/Mastra/Orch接続完了とは扱わない。

## 監視

各tickは `outbox worker tick` にtenant ID、配送／再試行／ブロック／拒否件数、pending、failed、oldestAgeMsを出す。
Reconcilerのchecked/failed件数も出す。failedが継続する場合はAI snapshot-status契約と接続設定を確認する。
本文や資格情報は出さない。15分超の滞留、またはFAILEDが1件以上なら `outbox backlog alert` を警告として出す。
運用ではこの警告、`outbox worker tick failed`、通常ログが2周期以上来ない状態を監視する。
失敗通知のアラート先設定と本番IAM/index適用は運用環境側で行う。

再送時は理由（同意、未接続、外部障害、失効したmembership）を確認する。FAILEDを無条件にPENDINGへ戻さない。
滞留中の業務データをログへコピーしない。

## 試験範囲

Firestore Emulator + 独立Fake AI HTTPサーバーで、並行claim、旧応答、受理後SIGKILL、
新workerプロセスでの再配送と受信側の一度だけの処理、滞留の検知を検証する。
本番Scheduler、実AI、Mastra Snapshotの永続重複排除はこの試験には含まれない。

### ローカルsmoke test（#122）

`pnpm --filter @aftercare/backend-server test:firestore`が上記の再起動・重複配送・滞留シナリオを自動検証する。
他の作業や稼働中の`make up`スタック(ポート8085)と衝突しないよう、専用ポート・コンテナ名を指定して実行する。

```sh
FIRESTORE_EMULATOR_PORT=18122 FIRESTORE_EMULATOR_CONTAINER=after-flow-firestore-emulator-issue122 \
  pnpm --filter @aftercare/backend-server test:firestore
```

確認したシナリオと対応するテスト:

- worker再起動後のPENDING/期限切れIN_FLIGHT再開: `test/firestore/agent-execution.test.ts`
  (`--once`子プロセスをSIGKILLし、新しい`--once`子プロセスが同じRunを再配送すること)、
  `test/firestore/internal-execution.test.ts`（別workerプロセスでの待機復旧）。
- 重複配送・受信側の冪等性: `test/firestore/internal-execution.test.ts`
  （同じJob/Event IDの再送を受信側が重複排除し、旧応答で新しいclaimを上書きしないこと）。
- 同意撤回: `test/firestore/agent-execution.test.ts`（`/consents/revocations`後、次回配送直前の
  Policy再評価で送信を止め、撤回イベント自体はローカル制御通知として届くこと）。
- 滞留(backlog)検知: `test/firestore/agent-execution.test.ts`の「滞留と失敗の件数・最古の経過時間を取得できる」が
  `backlog`が返すpending/failed/oldestAgeMsを検証する。`test/outbox-worker.test.ts`は`runOutboxWorker`の
  tick失敗時のループ継続/停止を検証するunit testで、backlog集計そのものは対象外。
  `outbox worker tick`ログへの出力経路は`src/application/agent/outbox-worker.ts`で固定
  （本ファイルの「監視」節）。

`--once`の起動導線そのものは、コンテナを介さないNode直接実行でも確認する。

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:18122 FIRESTORE_PROJECT_ID=after-flow-issue122-manual \
  OUTBOX_TENANT_IDS=after-flow-local \
  pnpm --filter @aftercare/backend-server exec tsx src/worker-main.ts --once
```

対象外（本番配備方式が未決定のため）: 本番Scheduler、実AI/Mastra接続、本番IAM/tenant割当、本番監視接続。
