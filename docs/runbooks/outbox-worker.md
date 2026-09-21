# Backend Outbox worker

対象: #38 / #37。HTTPサーバーとは別の常駐プロセスとして起動する。本番デプロイ自体はこの実装の対象外。

## 起動

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
またはSchedulerから `--once` ジョブを定期起動する構成が必要。HTTP応答後の実行継続には依存しない。

## Docker開発環境

`make up` は `backend-worker` containerを業務Firestore Emulatorと同じ `data` profileで起動する。
HTTP用 `backend-server` と同じimageだが別container・別processで、hostへportを公開しない。
`restart: unless-stopped` を設定しているため、異常終了やDocker再起動後も自動で再開する。

渡す設定は役割に必要な最小限に限る。`OUTBOX_TENANT_IDS`（既定 `after-flow-demo`）、
`OUTBOX_INTERVAL_MS`、`OUTBOX_VISIBILITY_MS`、業務Firestore、Backend→AIの `AI_SERVER_URL` /
`AI_SERVICE_TOKEN` / `AI_SERVICE_AUDIENCE` / `AI_SERVICE_TIMEOUT_MS`、Run capability用の
`BACKEND_EXECUTION_SIGNING_KEY` / `BACKEND_SERVICE_AUDIENCE`。原本Storage、AI→Backendの
`BACKEND_INTERNAL_SERVICE_TOKEN`、`READINESS_ACCESS_TOKEN`、OrcaRouterキー、AI Runtime設定は渡さない。
参加するnetworkは `data`（業務Firestore）と `services`（AI Server）だけで、`frontend`・`ai-runtime`・
`ai-egress`・`emulator-host` には参加しない。`scripts/smoke-compose.mjs` と `make data-check` がこれを検査する。

```sh
make up                                              # workerも起動する
make logs SERVICE=backend-worker                     # tickログを追う
docker compose --profile data restart backend-worker # 再起動。PENDINGと期限切れIN_FLIGHTから再開する
docker compose --profile data stop backend-worker    # 停止。Outboxは保存済みのまま残る
docker compose --profile data start backend-worker
make down                                            # 全停止
```

`.env` の `OUTBOX_TENANT_IDS` で担当tenantを変えられる。複数tenantはカンマ区切り。

### 配送が有効になる条件

workerが起動していても、Backend HTTPが `AI_CONNECTED_OPERATIONS` を受け付けなければAI向けOutboxは作られない。
ローカルE2Eで有効にするのは `task_guidance` だけで、`.env` に `AI_CONNECTED_OPERATIONS=task_guidance` と
`ORCAROUTER_API_KEY` を設定して `make up` し直す。既定は空のままにし、APIキーやworkerが無い環境で接続済みと表示しない。
`case_planning`・`chat_reply`・`document_analysis` はこの段階では有効にしない。

AI Serverが未起動、readiness 503、timeout、5xxの場合、workerはイベントを成功扱いせずRETRYABLEとして残す。
`OUTBOX_DELIVERY_TIMEOUT_MS` を超えると打ち切り、Runと案内を失敗として確定する。
外部AI同意が無いイベントはBLOCKEDとして残し、消さない。Job本文・Context・service token・署名鍵はログへ出さない。

### 滞留の確認

`make logs SERVICE=backend-worker` の `outbox worker tick` 行で `pending`、`failed`、`oldestAgeMs`、
`retrying`、`blocked` を見る。15分超の滞留またはFAILEDがあれば `outbox backlog alert` が出る。
tickが2周期以上出ない場合はcontainerの状態（`make ps`）とFirestore Emulatorの疎通（`make data-check`）を確認する。

## 配送・回復

- 既定間隔5秒、可視性タイムアウト120秒、1tenantあたり1回20件。HTTP timeoutは可視性タイムアウト未満にする。
- `SIGTERM` / `SIGINT` は新規バッチを止め、実行中のバッチを待って接続を閉じる。
- 強制停止後もPENDINGと期限切れIN_FLIGHTを保存済みOutboxから再取得する。
- claim時にTransaction内で期限を再検証する。claim IDが変わったイベントを旧workerの応答では更新しない。
- 配送保証はat-least-once。同じevent IDを受信側が永続的に重複排除する。配送タイムアウトを成功として扱わない。
- `nextAttemptAt` の旧ISO文字列とTimestampを読み、新規更新はTimestampに統一する。イベントを削除・再作成して再送しない。
- `case.created` / `case.reference_dates_changed` / `case.profile_changed` はいずれも洗い出し（手続き・期限の同期）をBackend内で1回実行する。
  初期Task・期限の生成はCase作成・PATCHのTransaction内で既に同期実行されているため、ここは通常no-opの補正経路（カタログ更新後の再同期・生成漏れの補正）。
  最新Caseを読み、古いイベントの起算日・profileで上書きしない。AI接続・任意AI同意なしでも手動管理用の処理を続ける。
- 外部配送では毎回同意を再判定する。未接続ならPENDINGで再試行する。
- 一時障害の再試行は `OUTBOX_DELIVERY_TIMEOUT_MS`（既定15分）で打ち切る。打ち切ったAI向けイベントは、
  先にRunを `FAILED`（`failureReason: DELIVERY_TIMEOUT:<直近の理由>`）、`task_guidance` の案内を `FAILED` に確定し、
  その後Outboxを `FAILED` にする。AI Serverの一時停止・timeout・5xxは期限内なら従来どおり再試行する。
- 受付時のCase版と現在の版がずれた未開始（QUEUED）のRunは、配送前に現在の版へ載せ替え、試行IDを取り直してから配送する。
  Case作成直後の初期Task生成で版が進んでも、その直後の依頼が `STALE_CONTEXT` で無期限に再送されることはない。
  実行中に版が進んだ場合は従来どおりcontrolがSTOPを返し、Reconcilerが新しい試行として再配送する。
- 受け手の無い通知イベント（`task.completed`、`decision.confirmed`）はworkerがローカルで配送済みにする。
  `agent.*` 以外の未知の種別はREJECTEDで終端し、無期限に再試行しない。
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
