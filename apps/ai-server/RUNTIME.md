# 永続実行Runtime

対象: #57の受付・Worker・共有予算。HTTP/mainの提供開始は後続の実接続で行う。

## 実行経路

```text
認証済みIngress
  -> Backend control + contextでcapability/operation/hash/期限を照合
  -> Firestore transactionでJob receiptとRunの現在attemptを保存
  -> ACCEPTED（同一JobはDUPLICATE）

監督プロセスがawaitするWorker loop
  -> QUEUEDを一つだけclaim
  -> Backend制御照会 + 所有権 + Run累積予算を検査
  -> 登録済みMastra Workflowを実行
  -> 永続snapshotの実状態を照合
  -> 完了、または待機記録とBackendへのWAITING通知
```

BackendのCase lease/Outbox/Inbox/正式状態は複製しない。AIの所有権は実行Workerだけに適用する。
期限切れのWorkerを同じattemptで再起動しない。Backend reconciliationが発行する新attemptで復旧する。
各attemptは異なるWorkflow run IDを持ち、古いWorkerが新attemptのsnapshotを上書きできない。
新attemptの受付は、Backend contextにあるpreviousAttemptId・snapshotId・waitRequestIdを保存済み状態と照合する。
WAITではreceipt更新前にプロセスが落ちても、永続suspended snapshotを正として再開を受付できる。

## 資格情報

`DispatchVault`に、Backend署名鍵とは別の256-bit key（正規base64）を渡す。
Job IDをAADとするAES-256-GCMでdispatch capabilityを暗号化する。keyはFirestore外で管理し、モデル・snapshot・ログへ渡さない。
資格情報は完了/待機/停止時に消去する。key変更には未処理receiptの移行が必要であり、誤ったkeyでメモリ実行に切り替えない。
heartbeatの更新済みcapabilityは実行中Clientだけが保持する。プロセス喪失後はBackendの再配送/新attemptが認可を更新する。

## 予算

`budgetSchema`でRun累積のTool/調査/検索/取得/推論attempt/再計画/token/費用/稼働時間を有限値にする。
再配送・再開では使用量と起点の上限を維持し、新設定で上限を引き上げない。
外部呼出し前に最大消費量をtransactionで予約する。失敗・不明な消費量を返却しない保守的な方式。
費用は単一の運用通貨の百万分の一単位。Provider policyで通貨・単価版を統一する。
稼働時間は区間のtimeout全体を予約する上限値で、実測時間とは別。人待ち時間を加算しない。

Mastra標準Processorで各推論の前に共有予約し、Tool実行前に親子合計20回の区間上限を適用する。
Skill Toolも計数対象。限定委任は2件・同時1件、検索/取得は既存の調査単位上限も適用する。
Provider policyはschema/System/tool定義も含む推論token/費用の**証明可能な上限**を渡す。
SDK retryは0に固定。複数Providerの実Fallbackは別PRで各attemptの課金を接続してから有効化する。
`budget`省略は既存のfixture構成用。実WorkerのHandlerには必ずSession.guardとProvider policyを接続する。

## 復旧範囲と未接続

- WAITING/COMPLETEDは実snapshotとscopeが一致するときだけ応答する。一般的な実行途中snapshotを再生可能とは扱わず、RUNNING_CHECKPOINTはまだ返さない。
- WorkerのSTOPは協調停止。各外部呼出しでguardとAbortSignalを使い、heartbeat周期でもBackend取消を照合する。
- 待機条件登録はBackend→Session.registerWait→Mastra suspend→snapshot保存→通知の順。通知を失ってもBackend照会で復旧する。
- 保存失敗で202/完了を偽装しない。所有権を失ったWorkerは終端状態を書き換えない。
- 実Orch/Provider/Source Catalog、業務別Handler、承認後の新Contextによる再検証、部分結果報告は後続PR。
- mainは開発ハッカソン設定が揃う場合だけRuntimeを注入し、未設定時は503を維持する。ローカル接続を本番対応とは表示しない。

検証: Firestore Emulatorで独立client間のclaim競合、Job衝突、旧所有権、累積上限、snapshot保存前後の再開、実Mastra Workflowの単一起動/完了、STOPを検証。Mastraの実ループでProvider/Tool実行前の予算停止を検証する。実Backendとの通し試験は後続。

## Workflow HandlerとHTTPホスト

`createGuidanceHandler` / `createChatHandler`はWorker SessionのBackend Clientとsignalを実Workflowへ接続し、
Jobごとの安定したresult IDとWorkflow run IDで保存・報告する。共有予算のchargeはSession.guardへ固定する。
複数Providerを使う場合は`createAuthorizedModels`が作った具象モデルだけを受け取り、
同じSession.guard・operation・core/research役割に束縛されていることを確認する。別Runのモデル/予算を再利用しない。

`startExecutionHost`はRuntimeとWorkerの両方を要求する。HTTP要求ごとに非管理Promiseを作らず、監督対象のloopを一つ持つ。
Workerの異常終了・予期しない正常終了ではHTTPも閉じる。終了時はsignalで停止し、有限の猶予後に接続を閉じる。
mainはこのhostを使い、非productionでAPIキーがある場合だけハッカソン用OrcaRouter/Policy/grant/Catalogをcompositionする。production用のProvider同意とAI Runtime設定は別途必要。

Backend Emulator試験に、独立AIプロセスへ実dispatchを送り、実Backend認証・Context・AI専用Firestore・
実MastraチャットWorkflow・結果反映まで通す試験を追加する。二重配送しても返信は一つ。
モデルとOrchは明示的な合成fixtureであり、実Provider品質やハッカソン接続の完了とは区別する。
