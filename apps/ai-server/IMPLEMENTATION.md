# AI Server 実装と引継ぎ

確定済みの2 Agent構成を維持し、Node.js 22.23.2 / pnpm / strict TypeScript / `@mastra/core@1.67.0`で実装する。正式状態・承認・期限RuleはBackendが所有し、Webの業務通信経路は変更しない。

## 実装した範囲

| 機能 | 内容 | 詳細 |
|---|---|---|
| 永続Runtime | AI専用FirestoreのMastra Snapshot、プロセス終了/再開、暗号化受付、Worker所有権、共有予算、終了制御 | [Runtime](RUNTIME.md)、[保存ADR](docs/adr/0001-runtime-storage.md) |
| 2 Agent / Skill | Core + Research、6つのMastra標準Skill、限定brief ID委任、親会話を検索へ流さない、再委任なし | [要件](REQUIREMENTS.md) |
| HTTP / Context | scope付きBackend Client、認証Ingress、最新Context・版/hash、完全な訂正/却下/承認履歴 | [HTTP](INTERNAL_HTTP.md)、[Context](CONTEXT.md) |
| Provider / 検索 | 提供先Policyとgrant検証、Orch Port、SDKごとの共有予算、2 Provider fallback、計測、review済みCatalogとSSRF対策付き公式HTML取得 | [Policy](PROVIDER_POLICY.md)、[検索](RESEARCH_PROVIDER.md) |
| P-01 / Chat | 公式資料の調査、根拠付き案内/確認質問、鮮度検証、Backend結果受付、Worker Handler | [案内](PROCEDURE_GUIDANCE.md)、[Chat](CHAT.md) |
| Proposal / P-03 | 計画差分、手動Task/訂正履歴の尊重、依存/必要書類のBackend検証、承認待ち・別attempt再開・正式版/hash照合 | [Proposal](PROPOSALS.md)、[計画](PLANNING.md) |
| P-02 | 加工版のscope/検査版/hash/根拠位置、候補・訂正矛盾・不足、配信の再検証Workflow | [書類](DOCUMENT_REVIEW.md) |
| P-04 | 確認済み機関定義からチェックリスト/事実整理manifest、不足書類候補、生成物と承認の版/hash照合Workflow | [保険準備](INSURANCE_PREPARATION.md) |
| Insight | Backend検出イベントの根拠/対象版照合、安定result ID、別の書類要求/引継ぎProposal候補 | [気づき](EVENT_INSIGHTS.md) |
| 評価 | 標準Datasets/Experiments/Scorer、32合成ケース、各3回、全試行保存、比較CLI、PR/手動CI | [評価](EVALUATION.md) |

P-03は1 Runで1件の正式提案を処理する。承認で案件が変わるため、残りは要確認として新Runで再計画する。承認待ち中にTemplate/根拠の有効性が変わった場合も成功にせず要確認を返す。実行途中の任意位置からのCHECKPOINT再開は提供しない。

## 現在の起動状態と残る依存

既定の`main.ts`はHonoを起動するが、実Orch/Provider等を組み込んだRuntimeは設定していない。healthは生存確認だけで、実行受付は503。実モデルによるサービス提供やMVP全体の完成を示さない。成功固定やFakeへ切り替える本番経路は用意していない。

| 残る依存 | 必要な作業/情報 |
|---|---|
| 必須OrchRouter | ハッカソン指定製品のURL/公式資料、SDK・認証・返答契約、実利用証跡。質問は未回答 |
| 実Provider・grant | 採用LLM/OCR/検索、提供条件・価格・保持条件、実資格情報、Backendの提供先grant API、予算値 |
| 対応業務 | P-01/P-03/P-04の対象機関・手続きの公式資料レビュー、Source Catalog/Templateの確定 |
| P-02の接続 | Backendの検査済み加工版配信と同意制御、実PDF/画像OCR、抽出Fieldから正式Proposalへのレビュー済み対応 |
| P-04の接続 | Backend生成Artifact保存/承認契約、書類待ち・生成物承認待ちの実データ接続 |
| Insightの接続 | Backend検出イベントの配信契約、内部resultのInsight variant、Case/eventごとの永続重複抑止 |
| 運用/実評価 | 専用クラウドIAM・秘密鍵・保持/削除条件、実モデル/実Orchの品質・費用・性能、実資料での人による評価校正 |

これらの未確定契約や資格情報を推測で埋めない。接続用Portと実処理はあるが、未提供Backend APIを架空のパスへ送信しない。Workflowへの入力は信頼済みcomposition rootが認証付き内部HTTPから取得し、モデルの自己申告を認可証拠にしない。

## 検証とレビュー

通常検証は`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm openapi:check` / `pnpm build`。永続化・承認再開は`pnpm test:firestore`、固定評価は`pnpm eval:ai`と`pnpm eval:ai holdout`。

独立したBackend/AIプロセスで実HTTPによるChat受付→Worker→結果保存→重複配送を検証した。Mastra本体で2 Agent、Proposal/計画のsuspend/fork/resume、Firestore Snapshotのプロセス強制終了/復旧を検証した。モデル応答・Router・業務資料は合成fixtureであり、実LLMの品質試験とは区別する。

PRは機能ごとのstack。起点はmain `9385b67`、順序と各PRは[継続計画](DELIVERY_PLAN.md)。個別PRには親ブランチへマージ済みのものがある。mainへの反映は別の統合PRでまとめて検証する。元の作業ディレクトリにあった未commit変更は触らず、隔離worktreeで作業した。

Devinは着手許可を意味するラベルではない。共有PRの契約・依存が揃った周辺実装から担当可能。今回実装済みのIssueを重複着手しないよう、PRの範囲と残る実接続条件を先に確認する。Provider/Orch/業務判断の未確定部分は、任意の製品やFakeを選ばせて埋めない。

### 公式資料PDFの読み取り

レビュー済みCatalogの公式URLはHTML・UTF-8テキスト・PDFを取得できる。PDFはPDF.js 6.3.289で本文を抽出し、ページ番号を根拠に残す。5 MiB・40ページ・本文60,000文字・処理5秒を超える資料や暗号化/破損/文字のない資料は拒否する。画像文字はOCRしない。独立したWorkerを中断時に終了し、PDF内スクリプト・添付ファイル・外部リンクは実行/取得しない。URL/DNS/HTTPSの既存検証は共通。

実装参照: [PDF.js Node example](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs)、[v6.3.289](https://github.com/mozilla/pdf.js/releases/tag/v6.3.289)。

### 中断結果と再送

共有予算超過・実行時間切れ・実行エラーは、検証済みの途中経過と残作業を`execution_interrupted`としてBackendへ返す。Backendは現在のoperation・Context・leaseを検証してNEEDS_ATTENTIONにし、公開Run.outcomeへ保存する。途中でCase版が変わった場合は古い途中経過を返さない。

結果をAI側のREPORTING receiptへ先に保存し、通信失敗時は10秒後に同じ結果ID/本文だけを再送する。所有権期限後の再取得でもAgent/Toolを再実行しない。取消・古い認可・Context不一致は停止し、Backend Reconcilerに委ねる。承認待ちを中断結果で上書きしない。結果作成前のContext取得失敗や認可期限切れを、結果配送成功とは扱わない。

### 取消の直接配送

公開取消APIはBackendのRunをCANCELLEDにし、旧job/attemptと取消Outboxを同じトランザクションで保存する。`POST /internal/v1/runs/:runId/cancel`へサービス認証付きで配送し、同意撤回後も停止通知は配送する。AIは取消を永続化して未到着のdispatchも拒否し、同一プロセスの実行をAbortする。別Workerでも次の共有所有権検査で停止する。既に完了した正式変更は戻さない。

取消記録を削除すると遅延dispatchの復活防止を失うため、execution_cancellationsに自動TTLは設定しない。取消payloadは業務本文・ユーザー認証・モデル設定を含まない。
