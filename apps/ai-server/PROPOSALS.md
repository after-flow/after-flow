# Proposal提出・承認待ち・反映確認

対象: #60のWorkflow。Proposalを生成する判断と、HTTP Workerへの業務Handler接続は後続。

```text
ハーネスが固定したAction ID + 検証済み候補
  -> 最新Context/認可/根拠版/許可kindを再検査
  -> Backend propose（request IDも固定）
  -> payload hashを照合
  -> WaitRequestをAI receiptへ登録
  -> Mastra suspend + Firestore snapshot
  -> WorkerのWAITING通知 / BackendのSnapshot照会

Backendが新attemptを認可
  -> 旧suspended snapshotを新しいWorkflow run IDへコピー
  -> 新しいBackend Clientを持つ同版WorkflowでMastra resume
  -> 最新Context内の正式状態・Proposal版・payload hashを照合
  -> APPLIED / REJECTED / CHANGED / NOT_APPLIED
```

Action IDはRun・Playbook版・ハーネスの論理slotから作る。attemptやモデルの自己申告IDを使わない。
1区間のProposalは一つ。BackendがProposalとApprovalとPENDING_SNAPSHOTを同一transactionで作るため、重ねてwait APIを呼ばない。
AIは承認API・正式更新API・業務DBを持たない。`allowedKinds`はPlaybook側で固定し、汎用Proposal Toolをモデルへ公開しない。

Backend Contextの既存actions metadataにpayloadHashを追加し、本文を追加配信せずに承認対象の版を照合する。
承認通知やresume.outcomeだけでAPPLIEDとせず、最新のaction.statusも確認する。
人が内容を訂正した場合はCHANGED、承認待ちが残る場合はNOT_APPLIEDであり、古い内容の完了を報告しない。
拒否されたActionを同じ内容で自動再提案しない。再計画・訂正判断は上位Workflowが扱う。

`forkSuspendedSnapshot`はBackend認可とRuntime receiptのpreviousAttempt/snapshot/wait照合後にのみ使用する。
新attemptのsnapshotは旧snapshotと別IDにし、古いWorkerによる上書きから分離する。コピー先が存在すると拒否する。
保存完了済みのsubmit StepはMastraが再実行しない。Workerが応答前に落ちる副作用の冪等性はBackend request/Action receiptが担う。
このWorkflowの成功はAction状態の照合完了であり、Case全体の計画完了ではない。

検証: 実Mastra + Firestoreでsuspend→新IDへのコピー→別Workflow instanceでresumeを行い、
提出1回のままAPPLIED/REJECTED/CHANGED/NOT_APPLIEDを判別。許可外kindと応答hash不一致では待機へ進まない。
Backend Emulator試験でactionsのhash配信を確認する。実Backend HTTPとAI Workerを同時起動した通し試験は後続。
