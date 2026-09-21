# AI内部HTTP

関連: #49。Backend契約正本は `@aftercare/internal-contracts`。

## 実装した経路

- `BackendClient`: Context/Artifact/control/heartbeat/events/result/proposals/wait-requests。Run/Job/attemptをconstructorで固定し、操作ごとのSchemaと認可metadataを適用する。
- heartbeat成功時にcapabilityを更新する。capabilityはBackendが検証する。AIはBackend署名鍵を持たず、JWTのdecodeだけを認証として使わない。
- 内部通信は10秒以下、本文サイズ上限、redirect禁止、応答Schema検証。自動再試行はせず、ハーネスが予算と冪等性を管理する。
- `/internal/v1/runs/:runId/dispatch` と `resume`: service token/audience、時刻、Run/Job/冪等性キー、本文を検証する。
- `/internal/v1/runs/:runId/snapshot-status`: service認証と要求scope・保存済み応答の同一性を検証する。

## 接続条件

`AI_SERVICE_TOKEN`（Backend→AI）と`AI_SERVICE_AUDIENCE`（既定`ai-server`）をAI ingressに使用する。
Backend Clientは別のAI→Backend service tokenとBackend originをcomposition rootから受け取る。
秘密値をモデル入力、エラー本文、通常ログに渡さない。private ingress/IAMは配備時に別途設定する。

`ExecutionRuntime`は永続WorkerのPort。**production実装はまだ注入しない**。
未設定の場合、livenessは200、実行受付・Snapshot照会は503になる。404や503を配送成功に変換しない。

[Runtime](RUNTIME.md)で、Backend control/contextによるcapability検証・operation一致確認、
永続receipt、Job衝突拒否、旧attempt拒否を実装した。実Provider/業務Handler接続後にcomposition rootから注入する。
単なるメモリMapやHTTP完了後のPromiseを永続Workerの代わりに使わない。
取消は現行Backendのcontrol=STOPで協調停止する。直接cancel配送は共有契約・Backend送信側とも未接続であり、完了に含めない。

## 検証範囲

Clientは独立NodeプロセスのHTTP fixtureで、全経路、capability更新、redirect/timeout/巨大・不正応答、エラー本文の非露出を検証する。
AI ingressはHonoの実ルーティングで、認証・audience・時刻・Run/Job差替え・未接続時の拒否を検証する。
fixtureはBackendの署名・同意・DB認可の証明ではない。実Backend＋永続Workerの通し試験は後続の受入条件として残す。
