# 原本Storageと書類参照

Backendだけが原本を扱う。`DOCUMENT_STORAGE_ROOT`（開発/CI）か`DOCUMENT_STORAGE_BUCKET`（GCS）の一方を設定する。
両方の設定は起動エラー、両方未設定は書類APIを未接続として拒否する。AIにはどちらの設定も資格情報も与えない。

## ローカルEmulator

ルートで`make up`を実行すると、アプリ3サービスとともにFirestore Emulatorと[fake-gcs-server](https://github.com/fsouza/fake-gcs-server)をdata profileで起動する。`make up-data`は互換エイリアスとして同じ構成を起動する。
Cloud Storageには`after-flow-documents` bucketを起動時に作成し、Backendへ`DOCUMENT_STORAGE_EMULATOR_ENDPOINT=http://storage-emulator:4443`を渡す。`make data-check`はBackendの実Adapterで作成・取得・削除を行い、AIにデータ接続設定が無いことも検証する。

ホストからはFirestoreを`127.0.0.1:8085`、Cloud Storage JSON APIを`http://127.0.0.1:4443`で確認できる。ポートは`FIRESTORE_EMULATOR_PORT`と`STORAGE_EMULATOR_PORT`で変更できる。いずれもループバックだけに公開し、データは一時データとして扱う。

Node SDKが暗黙に解釈する実験的な`STORAGE_EMULATOR_HOST`は使用しない。開発時だけ明示endpointをSDKの`apiEndpoint`へ渡し、`NODE_ENV=production`では設定があれば起動を拒否する。Emulatorは本番GCSのIAM、保持、暗号化、リージョン、完全なAPI互換性を保証しない。

## Cloud Storage Adapter

SDK `@google-cloud/storage` 8.2.0とBackend専用ADCを使う。公開/署名URLを発行せず、認可済みBackend APIから原本を中継する。
bucketは非公開、Public Access PreventionとUniform bucket-level accessを配備側で設定し、Backendのサービスアカウントだけに必要なobject操作を許可する。
保持/削除/暗号化・リージョンの方針は業務・運用レビューが必要。この変更ではbucket作成や本番デプロイを行わない。

新規保存に`ifGenerationMatch:0`、CRC32C検証、SHA-256 metadata、private/no-storeを指定する。
応答喪失後の同内容再送は既存原本を検証して成功とし、異なる内容では上書きしない。
取得はmetadataの世代に固定し、10 MiB上限・長さ・SHA-256を再検証する。回収は取得した世代が現在も一致する場合だけ削除する。
404以外の権限/通信/競合エラーを未存在や成功に変換しない。
仕様の根拠: [Google Cloud Storageの世代条件](https://docs.cloud.google.com/storage/docs/request-preconditions)。

## DTOの関連参照

書類の一覧/詳細は以下を返す。旧MSW型とUIは変更しない。

- `extractionCandidates`: 当該書類を根拠に持つ、保存済みAI Proposalの現在版の候補内容。新たにOCRを実行した結果ではない。
- `proposalRefs` / `approvalRefs`: 現在のProposal版と関連承認の参照。承認と正式反映の状態を分けて表示できる。
- `evidenceRefs`: 当該書類に紐付く手続きの根拠。
- `analysis.run`: Document targetのRun状態、待機理由、失敗理由。存在しなければnull。

すべて認可済みCase内で取得する。Proposal/Approval/Evidenceは100件ずつ全ページを読み、一覧では文書ごとに再走査せず共有する。
大規模Caseの逆参照index/専用Queryへの最適化は未実施。候補は正式事実ではなく、適用時の現在版/権限検証を省略しない。
未検査PENDING、AI未接続、空の候補を「検査済み/解析成功」と表示してはいけない。

## 検証境界

ローカル保存＋Firestore Emulatorで登録・部分失敗・再送・原本のCase認可・改変・archive・参照表示を検証する。
GCS SDK境界のFakeで作成条件、同一再送、世代固定読取、世代違い削除拒否、改変、サイズ、404/403/429/500を検証する。
DockerのCloud Storage Emulatorで同じAdapterの作成・取得・削除を疎通する。ただし、実GCS bucket、IAM、保持/ライフサイクル、KMS、リージョン設定は未検証。本番を有効にする前に専用テストbucketと合成原本で確認する。
マイナンバーの実検知/マスキング（#25/#26）、AIへの書類本文配送（#27）は未接続のまま。
