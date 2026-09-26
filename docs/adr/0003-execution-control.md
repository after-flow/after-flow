# ADR 0003: AgentRun・Outbox・Case leaseの実行制御

- 状態: Backend内部契約とAI Runtimeを開発環境で接続済み。本番配備・運用検証は未完了
- 日付: 2026-09-20（2026-09-26 実装状況更新）
- 関連Issue: #10（親）、#12（同意Policy）、#15（チャット）、#8（書類）

## 背景

AIの実行を受け付けてから結果が返るまでの間に、プロセスの再起動、配送の重複、同意の撤回、利用者による取消が起こります。
これらを「実行中」「成功」の二択で表すと、利用者は何を待っているのか分からず、失敗と待機の区別もつきません。

## 決定

### 1. 待機と失敗を圧縮しない

実行状態に `WAITING_DOCUMENT`、`WAITING_APPROVAL`、`RETRY_SCHEDULED`、`NEEDS_ATTENTION` を持たせます。利用者が取るべき行動がそれぞれ違うためです。公開DTOは `waiting` を別に返し、待機を失敗として表示させません。

### 2. 受付は202で、完了ではない

受け付けた時点でCaseの版を記録します。受付後にCaseが変われば、結果の鮮度を判定できます。結果は取得APIで別途確認します。

### 3. 配送はOutboxから行い、HTTP応答にぶら下げない

要求の後処理として配送すると、プロセスが落ちたときに未配送のまま消えます。保存済みのイベントから独立して配送します。

配送は少なくとも1回を前提にします。送信後・記録前にクラッシュしても同じJob IDで再配送し、受信側が重複を排除します。409は本文のJob/RunとDUPLICATE ACKが一致する場合だけ成立と扱い、任意の競合応答を成功としません。

### 4. 配送のたびに同意を確かめる

受付時に同意があっても、待機中に撤回されていることがあります。配送の直前にPolicyを評価し、許可されていなければ送りません。失敗ではないので、イベントはPENDINGのまま残します。

例外は処理を止めるための通知です。同意の撤回そのものを同意不足で止めると、AI側は撤回を知れません。個人データを含まない制御イベントだけがこの例外に当たります。

### 5. 書き込みの直列化は期限と世代の両方で行う

同じCaseへ複数の実行が同時に書き込むと、互いの前提を壊します。書き込みを伴う実行はleaseを取ります。

期限だけで判定すると、時計のずれで二重の書き込みを許します。取り直すたびに増える世代番号（fencingToken）を併用し、古い世代の要求は期限内に見えても拒否します。期限切れ後に戻ってきた所有者が、新しい所有者のleaseを解放することもありません。

### 6. 取消は実行の中止であり、確定済みの変更の取消ではない

取り消すのは実行です。既に確定した業務変更は戻しません。確定済みの変更を戻す操作は別に用意します。取消時と再試行時に試行の世代を変え、古い試行の遅れて届いた結果を受け付けないようにします。

### 7. 接続済みの操作だけを受け付ける

対応する業務操作は設定と公開契約で管理します。未接続の操作は理由を添えて拒否します。UIにボタンがあるだけですべての操作を有効にしません。

## 実装済みの範囲

- AgentRunの受付・取得・一覧・取消・再試行と、保存済みRunからのscope導出
- 公開可能なAgentRun進捗イベント（受付/progress/wait/resume/result/取消/再試行）を対象Runの状態変化と同一transactionで記録し、`GET C/agent-runs/:runId/events`でカーソル付きに取得（#125）。prompt・非公開の思考・資格情報・原本文は含めない
- Case leaseの取得・更新・解放、fencingToken、期限切れ所有者の拒否
- 永続Outboxの配送・再配送・可視性タイムアウト、配送時の同意検査
- AI Server向けHTTP Clientのポートと実装

Backendの契約試験は独立したFake AI HTTPサーバーで再現性を保ちます。後続実装により、開発ComposeではBackend Outbox Worker、AI Server、Mastra Workflow、AI Runtimeを実HTTPで接続できます。これは本番のIAM、監視、障害復旧まで検証済みという意味ではありません。

## 子Issueへ分割した範囲

1. Backend内部APIの契約と認可（#36）を実装。短寿命のRun/Job/attempt認可、Context/Artifact、control、heartbeat、events、result、proposals、wait-requestsと独立した内部OpenAPI。[接続・制限](../api/internal-execution.md)。lease連携は#41。文書本文配送は#25-27に残します。
2. WaitRequestとresume intent、定期Reconciler（#37）を実装。AI提案・Approval・WaitRequestを同じtransactionで登録し、Snapshotより先行する承認/却下をInboxに保持。Snapshot保存状態を内部HTTPで照合し、一意なresume Jobと新attemptをtransactionで作成します。書類待ちの登録は可能ですが、実検査/配信が未接続のためDOCUMENTS条件での再開は無効です。
3. Outbox配送の定期実行と再起動後の継続（#38）は独立workerとして実装。
   claim世代検証、SIGKILL後の別プロセスからの回復、滞留検知を含む。[運用手順](../runbooks/outbox-worker.md)。

## 待機・復旧の契約

- `PENDING_SNAPSHOT → WAITING → RESUME_QUEUED → RESUMED`。公開Runの待機とAI所有Snapshotを同一視しません。
- InboxはOutbox ID/hashで冪等保存。消費イベントはWaitRequestの`inboxId`に記録し、再開Job ID/attemptを同一transactionで固定します。
- 再開前に現在のCase権限・同意、Proposal版/hashと適用/却下結果を再確認。新context取得でCase版・lease世代・根拠を検証し、Snapshot内の古い事実は使いません。
- Run内Action IDはattemptを跨いで不変。適用済みActionはfresh contextで照会でき、再提出でも再適用しません。未適用Actionの再提案はimmutableな新Proposal版と新Approvalになります。
- lease切れRUNNINGはcheckpointがあればCHECKPOINT、無ければRETRY。任意命令位置からの復旧は保証しません。自動復旧は3 attemptまでで要確認に止めます。
- 配送ACKより先に保存されたRun callbackは受領証明。旧Jobや完了済みRunを再配送で実行しません。
- 同意・権限撤回はSnapshot HTTPの障害に依存せず取消し。AIは各Step前のcontrol照会でSTOPを確認する契約です。
- Emulatorと独立Fake AI HTTPで先行承認、重複Job、遅着結果、lease失効、同意撤回、別workerプロセスでの待機復旧を検証。実Mastra Snapshot永続化の証明ではありません。

## 当初の対象外と後続実装

このADRが決定した範囲には、AI Server内部のAgent・Workflow・OrcaRouter・Model Policy・Mastra Snapshotの実装と本番デプロイを含みません。AI側の実装は後続で追加されていますが、サービス間を直接importせず内部HTTPで接続する境界は維持します。
