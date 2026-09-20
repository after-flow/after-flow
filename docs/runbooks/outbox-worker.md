# Backend Outbox worker

対象: #38。HTTPサーバーとは別の常駐プロセスとして起動する。本番デプロイ自体はこの実装の対象外。

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
- 実検査／内部API連携が未完了のため、独立workerでは `agent.document_analysis` と `document.*` を外部配送しない。
  この実装を #27 / #36 や実AI / Mastra / Orch接続の完了とは扱わない。

## 監視

各tickは `outbox worker tick` にtenant ID、配送／再試行／ブロック／拒否件数、pending、failed、oldestAgeMsを出す。
本文や資格情報は出さない。15分超の滞留、またはFAILEDが1件以上なら `outbox backlog alert` を警告として出す。
運用ではこの警告、`outbox worker tick failed`、通常ログが2周期以上来ない状態を監視する。
失敗通知のアラート先設定と本番IAM/index適用は運用環境側で行う。

再送時は理由（同意、未接続、外部障害、失効したmembership）を確認する。FAILEDを無条件にPENDINGへ戻さない。
滞留中の業務データをログへコピーしない。

## 試験範囲

Firestore Emulator + 独立Fake AI HTTPサーバーで、並行claim、旧応答、受理後SIGKILL、
新workerプロセスでの再配送と受信側の一度だけの処理、滞留の検知を検証する。
本番Scheduler、実AI、Mastra Snapshotの永続重複排除はこの試験には含まれない。
