# ADR 0001: AI専用FirestoreでMastra Workflowを保存する

状態: 採用。対象はWorkflow snapshotのみ。HTTP実行Workerへの接続は別PR。

Mastra 1.67.0の`WorkflowsStorage`を実装し、`MastraCompositeStore`へ登録する。
FirestoreのtransactionとMastra公開のmerge/CAS helperを使い、並行Step更新と状態遷移の前提条件を守る。
Memory、業務状態、原本、提供先の認証情報は保存しない。保存失敗は呼出元へ伝播し、メモリ保存に切り替えない。

## 分離と設定

- `AI_RUNTIME_PROJECT_ID`: AI runtime専用プロジェクト。
- `AI_RUNTIME_DATABASE_ID`: `ai-runtime`または`ai-runtime-*`の名前付きDB。既定DBは禁止。
- 開発試験のみ`AI_RUNTIME_EMULATOR_HOST=127.0.0.1:PORT`。本番は実行サービスの専用ADC identityを使う。
- Backendの`FIRESTORE_*`、`STORAGE_*`、原本Storage、共通資格情報ファイルを渡すと起動設定を拒否する。
- 本番IAMは専用DBのみを対象に設定する。名前チェックはIAMの代わりにならない。本PRではクラウド作成・IAM設定を行わない。

collectionは`workflow_snapshots`。document IDはworkflow名とrun IDの組のSHA-256。
Workflow名を省略した検索が複数件に該当した場合は拒否する。全削除APIは無効。
終端状態success/failed/canceledだけを指定日時・最大400件で削除できる。待機中と実行中は削除しない。
保持日数は運用で決定し、定期実行の設定時に明示する。

## 形式・上限・更新

Node 22のV8 serializationを`node22-v8-v1`として保存し、Date/undefinedなどの型を維持する。
最大512KiB、最大64階層。認証情報の既知キーを拒否するが、本文のPII検出機能ではない。
Run入力/Step出力には最小化したContextだけを入れる。executionAuthorizationとClientはsnapshotに含めない。
Node/codecの変更時は既存snapshotの復元試験と移行手順を先に追加する。未知codecは拒否する。

単一Stepのtransaction更新は同時更新を保持する。snapshot全体の置換はWorker所有権による単一実行が前提。
このAdapterだけで複数Workerによる実行や外部への二重送信を防げるとは扱わない。
保存できたsuspendからの別プロセス再開を試験する。未保存Stepの途中で落ちた場合の副作用には、WorkerとBackendの冪等性契約が必要。

## 索引・検証

`firestore.indexes.json`に公開list APIの任意filter組合せとretention索引を定義する。
本番DBに適用してから利用する。Emulatorは複合索引の必要性を検証しない。
一覧は最大1000件、追加取得はpage/perPageで指定する。

`pnpm test:firestore`はBackend試験の後、別のAI専用設定を持つ子プロセスで試験する。
実Mastra Workflowのsuspend→SIGKILL→新プロセスresume、完了Step非再実行、
独立Firestore client間の並行更新/CAS、名前空間・削除・保持を確認する。
実クラウド・実Provider・HTTP Workerの準備完了を意味しない。

参照: [Mastra Storage](https://mastra.ai/reference/storage/overview)、
[Workflowの再開](https://mastra.ai/docs/workflows/suspend-and-resume)、
[Firestore transaction](https://cloud.google.com/firestore/docs/manage-data/transactions)、
[名前付きDB](https://cloud.google.com/firestore/docs/manage-databases)。
