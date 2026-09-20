# 死亡後手続きAIエージェント：TypeScriptアーキテクチャ仕様

文書バージョン: 1.1  
作成日: 2026-09-20 / Asia/Tokyo  
対象: Codexによる新規実装・既存Go/Echo設計からの置き換え  
状態: アーキテクチャの提案仕様。実装・接続検証は未実施。Orch Router製品の同定は未確定。

## 0. Codex向けの最重要事項

本書は参照会話「YC参考の業務AI案」の設計を、現在の依頼に合わせて再構成したもの。過去のGo/Echo構成、業務別Agent構成、旧エンドポイント一覧と矛盾する場合は本書の設計を採用する。実装対象リポジトリの現状は未調査であり、既存実装や移行済みデータの存在を仮定しない。

- バックエンドサーバーとAIサーバーを独立したTypeScript + Honoサービスとして実装する。Go/Echoは新規構成に含めない。
- MastraはAIサーバーの内部実行基盤。Frontendはバックエンドサーバーの公開APIだけを呼ぶ。
- Firestoreを業務状態のSource of Truthとする。業務状態を確定する権限はTypeScript Application/Domain層に置く。
- Orch Routerは必須。実製品のSDK/APIは専用Adapterに隔離する。単なる自作switchを実製品の導入完了と扱わない。
- Workflow-first / Agent-inside。判断が必要な箇所で同じPrimary Case Agentを利用する。
- AIの変更案はProposal。検証・認可・必要な承認・競合確認を通ったものだけをCommand Handlerが確定する。
- Single Writerは「Case単位のAI意思決定経路と、正式状態の確定経路の一本化」。AgentへのFirestore直接書き込み権限付与を意味しない。
- 長期待機はMastraのSuspend/Resumeと永続Snapshotで実現する。メモリ内実行やHTTP終了後の未管理Promiseに依存しない。
- Context、Playbook、Workflow、Model、Ruleのバージョンと根拠を記録する。
- 相続方法など本人が決めるDecisionをAIが確定しない。MVPは書類整理・手続き計画・申請準備まで。

本書の「必須」は実装要件、「推奨」は既定案、「将来」はMVP対象外を表す。コード例は自アプリの契約例であり、MastraやOrch Routerの実SDK構文を保証するものではない。

## 1. 目的とプロダクト範囲

遺族が死亡後手続きを進めるために、Case情報、関係者、書類、手続き、期限、意思決定、承認、証拠を一つの案件として管理する。AIは情報整理と計画を支援し、必要書類を特定し、申請準備を進め、結果を確認して計画を更新する。

TypeScript化の目的は、HTTP・業務ロジック・Agent間の型と開発環境を揃えながら、業務上の権限境界を保つこと。AIの出力がそのままTask完了、期限確定、財産登録、外部申請に変換される設計にはしない。

代表的なMVP体験は「Case作成 → 書類登録 → 情報抽出候補 → ユーザー確認 → 手続き計画 → 不足書類待ち → 準備資料生成 → 承認 → 準備完了の検証」。申請準備完了と、外部機関への申請完了・給付受領完了を区別する。

## 2. 設計原則

| 原則 | 本プロダクトでの実装方針 |
|---|---|
| Single Writer | 同じCaseのAIによる計画・提案は直列化。正式な変更は共通Command Handlerのみ |
| Context Engineering | 正式状態、重要なDecision、根拠、未解決事項、過去の操作結果から目的別Contextを構築 |
| Workflow-first | 分岐、待機、再開、検証、リトライはWorkflow/アプリコード。曖昧な解釈をCase Agentへ渡す |
| Playbook | 業務の切替は業務別Agent追加ではなく、バージョン付き手順・制約・完了条件の切替 |
| Verification Loop | Plan → Execute → Verify → Re-plan。Tool成功だけで業務完了にしない |
| Read-only intelligence | OCR、検索、抽出、レビューは助言・候補を返す。正式状態や承認を変更しない |
| Model Router/Fallback | 能力・データ取扱条件でモデルを選び、障害時に互換候補へ切替 |
| Durable execution | 再起動、重複配送、ユーザー操作との競合を前提とする |
| Backend authority | 認可、業務ルール、期限算定、承認、監査、永続化はバックエンドの責務 |

Cognitionの一次資料から採るのは、Contextと意思決定の一貫性、複数の知的支援を使っても書き込み判断を集約する考え方である。「Cognitionは複数Agentを全面禁止している」とは解釈しない。[Cognition: Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working)

以降のProposal、Case lease、Command Handler、Firestore構成は、この考え方を本業務へ適用した独自の設計判断であり、Devin内部実装の再現ではない。

## 3. 全体構成

### 3.1 採用する構成

モノレポ内にWeb、バックエンドサーバー、AIサーバーを置く。バックエンドとAIは別プロセス・別デプロイ単位とし、どちらもHonoをHTTPフレームワークとして利用する。バックエンドは公開API、業務ルール、正式状態を所有する。AIサーバーは内部API、Orch Router、Mastra、Context Engine、Model Routerを所有する。

```text
Frontend (apps/web)
    │ HTTPS /api/v1/* のみ
    ▼
Backend Server (apps/backend-server, Hono)
    │ 認証・入力検証・DTO変換
    ▼
Backend Application ── Domain / Rule Engine
    │                       │
    │ Command / Query       │ 承認・状態遷移・期限・根拠条件
    ▼                       ▼
Firestore: 業務状態 / Proposal / Approval / AgentRun / Audit / Outbox
    │ Outbox → Queue / signed internal request
    ▼
AI Server (apps/ai-server, Hono; internal only)
    │ Run検証・実行所有権取得
    ▼
Orch Router [必須Adapter]
    │ 許可済みRouteの選択
    ▼
Mastra Workflow
    ├── Context Engine ── internal HTTP ──→ Backend Query API
    ├── Primary Case Agent
    ├── Read-only intelligence
    ├── Model Router → Provider Adapter → LLM
    ├── Tools ───────── internal HTTP ──→ Backend Proposal API
    └── Verify / suspend / resume
                                      │
                         Backend Command Handler → Firestore

Cloud Storage: 原本・OCR全文・生成資料
Firestore runtime専用領域: Mastra Snapshot（専用Storage Adapter）
Scheduler: Outbox再配送・期限確認・待機Run照合
```

FrontendからAIサーバー、Firestore、Cloud Storage、Mastra、LLM、Orch Routerへ直接業務通信しない。MVPのアップロード/ダウンロードもバックエンド公開APIで仲介する。認証基盤とのログイン通信は業務データAPIと別の認証チャネルとして扱う。

### 3.2 デプロイ案

- Node.jsのサポート中LTSを採用し、Hono/Mastraの採用版に対応するバージョンを固定する。
- `apps/backend-server`: 公開APIとAI向け内部APIを持つHonoサーバー。Cloud Runを既定のデプロイ候補とする。
- `apps/ai-server`: IAM認証された内部Honoサーバー。Orch Router、Mastra、Model Routerを実行し、Cloud Tasks等の配送基盤またはバックエンドから呼ぶ。
- Firestore + Cloud Storage + Secret Managerを利用。Queue/SchedulerはInfrastructureのAdapter経由。
- 両サービスは別のService Account、環境変数、デプロイ設定、スケール設定を持つ。AIサーバーには個人のBearer Tokenを配送しない。
- 業務用FirestoreとCloud Storageへの読み書き権限はバックエンドに限定する。AIサーバーにはMastra runtime領域だけの資格情報を与える。
- 1配送は時間上限内で終わる実行区間に分ける。長時間の書類・承認待ちはSnapshot保存後に応答を終了し、イベント到着で新しい配送を発行する。
- ローカルでもバックエンドとAIサーバーを別ポート・別プロセスで起動する。AIサーバーが業務用Firestore Emulatorへ直接接続しない構成を維持する。

Queueや実行環境の製品選定は変更可能だが、永続Outbox、重複配送対策、再開可能性はMVPでも省略しない。

### 3.3 サービス境界

バックエンドサーバーとAIサーバーの分離はMVPから必須とする。両サービス間の通信はバージョン付き内部HTTP契約を使い、モノレポ内のTypeScript関数呼出しや業務Repository共有で境界を迂回しない。

AIサーバーは業務用Firestoreの資格情報を持たず、Case、Task、Decision、Proposal、Approval、AgentRun、Auditを直接読み書きしない。Context取得、Proposal提出、進捗記録、待機要求、結果報告はすべてバックエンド内部APIを経由する。Mastra SnapshotはAIサーバーが所有するruntime専用領域へ保存し、必要に応じて別Firestore databaseまたは別Google Cloud projectへ分離する。

バックエンド障害時、AIサーバーはContextの推測や古いキャッシュによる書き込みを行わない。再試行可能な状態で停止する。AIサーバー障害時も公開CRUDと保存済み業務状態の閲覧は継続できる設計にする。

## 4. ディレクトリ構成

以下は目標配置。将来対象のフォルダーを空実装で大量生成しない。名前空間は例として`@aftercare/*`を使用する。

```text
aftercare/
├── AGENTS.md                         # 本書の不変条件・検証方法への参照
├── README.md
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json
├── .env.example                      # 値を含まない環境変数一覧
├── apps/
│   ├── web/
│   │   └── src/
│   │       ├── features/             # cases, documents, tasks, approvals
│   │       └── lib/api/              # 公開APIクライアントだけ
│   ├── backend-server/               # Hono: 公開API + AI向け内部API
│   │   ├── package.json              # Backendだけの依存・build/start
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── main.ts
│   │       ├── app.ts                # Hono設定
│   │       ├── composition.ts        # 依存関係の組立て
│   │       ├── presentation/
│   │       │   ├── middleware/       # user/service auth, request-id, Zod
│   │       │   └── routes/
│   │       │       ├── public/v1/    # Frontend向け
│   │       │       └── internal/v1/  # AI Server向けQuery/Proposal/Event API
│   │       ├── domain/
│   │       │   ├── case/             # Case, Person, Relationship
│   │       │   ├── task/             # Task, Deadline
│   │       │   ├── document/         # Document, Evidence
│   │       │   ├── estate/           # Asset, Liability, Contract, Benefit
│   │       │   ├── decision/         # 本人意思と確定条件
│   │       │   ├── proposal/         # Proposal, Approval, Action
│   │       │   ├── rules/            # 業務ルール・期限計算
│   │       │   └── shared/           # ID, version, domain errors
│   │       ├── application/
│   │       │   ├── commands/         # 正式状態の全変更を集約
│   │       │   ├── queries/          # 公開画面/AI用の認可済み読取
│   │       │   ├── proposals/        # submit, validate, apply
│   │       │   ├── approvals/        # request, approve, reject
│   │       │   ├── runs/             # enqueue, cancel, retry, resume intent
│   │       │   ├── authorization/
│   │       │   └── ports/
│   │       └── infrastructure/
│   │           ├── firestore/        # 業務Repository, UnitOfWork
│   │           ├── storage/          # 原本用Cloud Storage
│   │           ├── identity/         # User/Service Token検証
│   │           ├── queue/            # Outbox配送 / Cloud Tasks
│   │           ├── ai-client/        # AI Server内部API Client
│   │           ├── actions/          # 外部Action Adapter（将来）
│   │           └── telemetry/
│   └── ai-server/                    # Hono: 内部専用AIサービス
│       ├── package.json              # AIだけの依存・build/start
│       ├── tsconfig.json
│       └── src/
│           ├── main.ts
│           ├── app.ts                # Hono設定。Public routeは持たない
│           ├── composition.ts
│           ├── presentation/
│           │   ├── middleware/       # service auth, request-id, Zod
│           │   └── routes/internal/v1/ # dispatch, resume, cancel, health
│           ├── application/          # route-and-run, resume, verify
│           ├── orchestration/
│           │   ├── routing/          # 許可Route、Router出力検証
│           │   ├── context/          # builder, budget, compaction, provenance
│           │   ├── playbooks/        # schema, registry, loader
│           │   ├── models/           # capability, policy, failure分類
│           │   └── ports/
│           └── infrastructure/
│               ├── mastra/
│               │   ├── index.ts
│               │   ├── agents/case-agent.ts
│               │   ├── workflows/    # ingestion, planning, preparation等
│               │   ├── steps/        # 小さい再実行可能なStep
│               │   ├── tools/
│               │   │   ├── read/
│               │   │   └── propose/
│               │   ├── intelligence/ # extraction, review等のread-only処理
│               │   ├── memory/       # 将来。正式状態と分離
│               │   ├── storage/      # runtime専用Firestore Adapter
│               │   └── scorers/
│               ├── orch/             # 指定製品のSDK/API Adapter
│               ├── models/           # model-router, providers, timeout等
│               ├── backend-client/   # Backend内部API Client
│               ├── runtime-store/    # Snapshot実行所有権
│               └── telemetry/
├── packages/
│   ├── public-contracts/            # ブラウザー利用可能な公開契約
│   │   └── src/
│   │       ├── schemas/             # Zod Request/Response
│   │       ├── dto/
│   │       └── errors.ts
│   ├── internal-contracts/          # Backend ↔ AI。ブラウザーへbundleしない
│   │   └── src/
│   │       ├── backend-api/         # context, proposal, event, control
│   │       ├── ai-api/              # dispatch, resume, cancel
│   │       ├── schemas/
│   │       └── errors.ts
│   ├── observability/               # PIIを除外する共通trace規約
│   └── test-support/                # Fake client・架空fixture。production非依存
├── playbooks/
│   └── insurance-claim-preparation/
│       └── v1/                     # playbook.yaml, instructions.md
├── rules/                          # バージョン付き業務ルール定義
├── tests/
│   ├── architecture/               # import制約
│   ├── contract/                   # Backend ↔ AIのconsumer/provider検証
│   ├── integration/                # Firestore・Queue・内部HTTP・Snapshot
│   ├── e2e/                        # Case→書類→承認→準備完了
│   └── fixtures/                   # 架空人物・合成書類
├── evals/                          # datasets, runners, reports
├── infra/
│   ├── firestore/                  # rules, indexes, emulator設定
│   └── deployment/                 # Backend/AI/Queue/Scheduler/IAM
├── scripts/                        # seed, migration, verify-boundaries
└── docs/
    ├── architecture.md             # 本書
    ├── api/public-openapi.yaml     # 公開契約から生成
    ├── api/internal-openapi.yaml   # 内部契約から生成。外部公開しない
    ├── adr/                        # 技術選定・未確定事項の解決記録
    └── runbooks/                   # 再配送・再開・モデル障害対応
```

## 5. 各レイヤーの責務と依存方向

| レイヤー | 責務 | 持たせないもの |
|---|---|---|
| Backend Hono Presentation | 公開/内部HTTP、User/Service認証、入力検証、DTO、エラー変換 | 期限計算、LLM呼出し、Route選択 |
| Backend Domain | Entity、不変条件、状態遷移、Rule Engine | Hono/Mastra/Firestore/Provider SDK |
| Backend Application | 認可、Command/Query、Proposal適用、承認、監査、Transaction境界 | SDK固有型、自然言語Prompt |
| Backend Infrastructure | 業務Firestore、原本Storage、Queue、AI Server Client | AI判断、Mastra Snapshot |
| AI Hono Presentation | Service認証、dispatch/resume/cancelの入力検証、実行受付 | User認証、公開画面DTO、業務DB操作 |
| AI Application/Orchestration | 実行経路、Context、Playbook、能力要求、検証方針 | 業務状態の確定、業務Firestore Repository |
| AI Infrastructure | Mastra、Orch接続、モデル接続、Backend Client、runtime Snapshot | 業務状態の直接読書き |
| Composition root | 各サービス内でPortへ実装を注入しHonoを起動 | サービスを跨ぐ関数注入、業務ルール |
| Public Contracts | Frontend ↔ BackendのSchema/DTO | Entity、秘密情報、内部API型 |
| Internal Contracts | Backend ↔ AIのSchema/DTOとエラー分類 | Domain Entity、SDK型、資格情報 |

各サービス内の依存方向は`Presentation → Application → Domain/Orchestration`、`Infrastructure → ApplicationのPort`。サービス間は内部HTTP契約だけで接続する。BackendからAIのMastra/Orch実装をimportせず、AIからBackendのApplication/Domain/Firestore実装をimportしない。

`web → public-contracts`だけを許可し、webからbackend-server、ai-server、internal-contractsへのimportをCIで拒否する。`backend-server ↔ ai-server`の直接importも拒否し、両方が`internal-contracts`に依存する。Mastra SDKは`ai-server/infrastructure/mastra`、Provider SDKは`ai-server/infrastructure/models`、Orch SDKは`ai-server/infrastructure/orch`に閉じ込める。

型を共有できるモノレポでも、サービス間の呼出しは必ず内部HTTP Clientを通す。これにより、別デプロイ時とローカル時の認証・タイムアウト・再試行・契約検証を同じ経路で確認する。

## 6. API / Agent境界

### 6.1 公開APIの共通仕様

- Prefixは`/api/v1`。Case配下のリソースは原則として`/cases/:caseId/...`に統一。
- 認証後、Application層でもCase membershipと操作権限を検証。`caseId`を知っているだけではアクセスできない。
- `tenantId`とactorはサーバー側で導出。リクエスト本文やLLM引数から信用して取り込まない。
- JSON、query、path、multipartの実行時検証にZodを利用する。TypeScript型のみで外部入力を信用しない。Honoは検証ミドルウェアを組み込むHTTP境界として利用する。[Hono Validation](https://hono.dev/docs/guides/validation)
- 更新系は`Idempotency-Key`必須。既存Entityの変更には`expectedVersion`、Case全体の計画適用には`baseCaseVersion`を要求。
- 同一キー・同一payloadは既存結果を返し、同一キー・異なるpayloadは409。キーのscopeはtenant/actor/operationを含む。
- 日時はAPI上でISO 8601。日付だけの期限は`YYYY-MM-DD`と管轄タイムゾーンを別管理する。
- 成功は`{ data, meta: { requestId, nextCursor? } }`。失敗は`{ error: { code, message, retryable }, meta: { requestId } }`。
- 400: 入力不正、401: 未認証、403: role不足/同意不足、404: membershipなし/参照なし、409: 競合/業務条件不成立、413: サイズ超過、428: 必須条件欠落、429: 制限、501: 機能未接続、503: 一時利用不可。実装のコードとHTTP対応は `shared/app-error.ts` に集約する。
- AI処理開始は202を返す。AgentRunは `id` と `status: QUEUED`、チャットは `{ message, runId, runAccepted, reason }`、案内は `agentRunId` を含むリソースを返す。受付を処理完了と表示しない。
- サーバーが決める値（`status`, `confirmation`, `policy`, `progress`, `source`, `agentRunId`, `tenantId`, `caseId` 等）を更新bodyで受け取らない。schemaはstrictで、未知フィールドは400。
- 既存フロントの呼び出しと公開APIの対応、移行方針、受入シナリオは [対応表](api/frontend-backend-mapping.md) を参照する。実装済みHTTP契約の正本は route spec とそこから生成する [OpenAPI](api/public-openapi.yaml)。将来API一覧とは区別する。

### 6.2 公開API一覧

以下で`C = /api/v1/cases/:caseId`。MVP列の「後」は将来拡張。

| Method | Path | 役割 | MVP |
|---|---|---|---|
| POST / GET | `/api/v1/cases` | Case作成/一覧 | 必須 |
| GET / PATCH | `C` | 詳細/基本情報更新。状態変更は含めない | 必須 |
| GET | `C/overview` | Task・期限・待機・承認の集約 | 必須 |
| GET / POST | `C/persons`, `C/relationships` | 関係者・関係登録 | 必須 |
| PATCH | `C/persons/:personId`, `C/relationships/:relationshipId` | 関係者情報訂正 | 必須 |
| POST | `C/persons/:personId/exclude` | 除外（削除ではない）。参照ありは409 | 必須 |
| POST / GET | `C/documents` | multipart登録/一覧 | 必須 |
| GET | `C/documents/:documentId`, `C/documents/:documentId/content` | メタデータ/認可済み配信 | 必須 |
| POST | `C/documents/:documentId/archive` | 利用停止、根拠への影響記録 | 必須 |
| GET / POST | `C/tasks` | 一覧/手動作成 | 必須 |
| GET / PATCH | `C/tasks/:taskId` | 詳細/説明等の更新。statusは直接変更不可 | 必須 |
| POST | `C/tasks/:taskId/start`, `C/tasks/:taskId/complete`, `C/tasks/:taskId/reopen` | 条件付き状態遷移 | 必須 |
| POST / GET | `C/tasks/:taskId/evidence` | 証拠登録/取得 | 必須 |
| GET | `C/deadlines` | 根拠と確認状態を含む期限一覧 | 必須 |
| POST | `C/deadlines/:deadlineId/extensions` | 延長の根拠と履歴登録 | 後 |
| GET / POST | `C/decisions` | 本人意思の一覧/下書き作成 | 必須 |
| POST | `C/decisions/:decisionId/confirm` | 権限を持つ本人による意思確定 | 必須 |
| GET | `C/proposals`, `C/proposals/:proposalId` | AI変更案と根拠 | 必須 |
| GET | `C/approvals` | 承認待ち一覧 | 必須 |
| POST | `C/approvals/:approvalId/approve`, `C/approvals/:approvalId/reject` | 対象版を指定した承認/却下 | 必須 |
| POST | `C/agent-runs` | 許可された業務operationの開始 | 必須 |
| GET | `C/agent-runs`, `C/agent-runs/:runId` | 実行状況 | 必須 |
| GET | `C/agent-runs/:runId/events` | カーソル付き進捗イベント | 必須 |
| POST | `C/agent-runs/:runId/cancel`, `C/agent-runs/:runId/retry` | 中断/再試行依頼 | 必須 |
| POST / GET | `C/messages` | 案内質問の送信/回答取得 | 必須 |
| GET | `C/audit-logs` | 許可された監査情報 | 必須 |
| GET / POST | `C/contracts`, `C/benefits` | 保険契約・請求候補の最小情報 | 必須 |
| PATCH | `C/contracts/:contractId`, `C/benefits/:benefitId` | 記述情報の訂正。policy/progressは含めない | 必須 |
| POST | `C/contracts/:contractId/policy`, `C/contracts/:contractId/progress`, `C/benefits/:benefitId/progress` | 方針・進捗Command（利用者申告） | 必須 |
| GET / POST | `C/assets`, `C/liabilities` | 財産・債務の手動管理 | 必須 |
| PATCH | `C/assets/:assetId`, `C/liabilities/:liabilityId` | 訂正。確認状態は含めない | 必須 |
| POST | `C/assets/:assetId/confirm`, `C/liabilities/:liabilityId/confirm` | 確認Command（確認者・時刻・版を記録） | 必須 |
| GET | `C/insights` | 根拠付き気づき一覧。statusは閲覧者ごと | 必須 |
| POST | `C/insights/:insightId/acknowledge`, `C/insights/:insightId/dismiss` | 既読・非表示（閲覧者本人の状態） | 必須 |
| GET / POST | `/api/v1/consents` | 同意状態と同意 | 必須 |
| POST | `C/close`, `C/reopen` | Case終了/再開 | 後 |
| GET | `C/agent-runs/:runId/events/stream` | 公開API経由SSE | 後 |

`POST C/messages`も202でmessageIdとrunIdを返し、案内回答を非同期生成する。任意のAgent名、Tool名、モデル名、System Prompt、Workflow stepId、resume payloadをFrontendから指定させない。

`POST C/agent-runs`の入力例は`{ operation: "case.plan" }`や`{ operation: "task.prepare", taskId }`。許可operationはルートポリシーで検証し、SDK内部識別子へそのまま流さない。書類登録後の解析と承認後の再開はサーバーが自動起票する。

### 6.3 内部契約

BackendとAI Serverの内部APIはMVPから実装する。内部パスは各サービスのprivate ingressにだけ公開し、同名のURLでも接続先サービスを明確に分ける。

#### Backend → AI Server

| Method | AI Server Path | 役割 |
|---|---|---|
| POST | `/internal/v1/runs/:runId/dispatch` | 保存済みRunの新規実行を開始 |
| POST | `/internal/v1/runs/:runId/resume` | 保存済み待機条件に対応するRunを再開 |
| POST | `/internal/v1/runs/:runId/cancel` | 協調的な中断を通知。正式なcancel状態はBackendが管理 |
| GET | `/internal/v1/health/ready` | AI Serverと必須依存のreadiness。Frontendには公開しない |

dispatch/resume本文は`jobId / runId / executionAttempt / operation / issuedAt / expiresAt`と、短寿命の実行認可情報だけを含める。個人のBearer Token、Case本文、文書本文、自由なPrompt、任意Route/Tool/model名は送らない。AI Serverは受信したoperationを許可リストで再検証する。

#### AI Server → Backend

| Method | Backend Path | 役割 |
|---|---|---|
| GET | `/internal/v1/runs/:runId/context` | Run scopeで認可・整形されたContextBundleを取得 |
| GET | `/internal/v1/runs/:runId/artifacts/:artifactId` | 許可済み原本断片・生成物を取得 |
| POST | `/internal/v1/runs/:runId/proposals` | 型付きProposalを提出。Backendが検証・適用 |
| POST | `/internal/v1/runs/:runId/wait-requests` | 書類待ち・承認待ち等の作成を依頼 |
| POST | `/internal/v1/runs/:runId/events` | 検証済み進捗イベントを追記 |
| POST | `/internal/v1/runs/:runId/heartbeat` | lease/実行所有権の更新を依頼 |
| POST | `/internal/v1/runs/:runId/result` | 成功・失敗・要確認の最終結果を報告 |
| GET | `/internal/v1/runs/:runId/control` | cancel、現在version、実行可否をStep/Tool前に確認 |

ContextとArtifactの応答には`caseVersion / contextSnapshotId / artifactVersion / contentHash / expiresAt`を含める。AI ServerはBackendから受け取ったContextをruntime処理に使えるが、正式状態として保存・更新しない。内部Artifact URLは短寿命・Run scope付きとし、別Runや別Caseで再利用できないようにする。

#### 認証・信頼境界

- Backend → AIとAI → Backendで別audience・別service identityを用いる。各サービスのService Accountには相手の必要な内部routeだけを呼べる権限を付ける。
- すべての内部要求で`requestId / jobId / runId / issuedAt / expiresAt`を検証し、本文hashを冪等性記録へ含める。
- tenantId、caseId、actor、role、allowedToolIdsはBackendが保存済みRunから導出する。AI Serverの自己申告値を権限判定に使わない。
- QueueからAI Serverを直接呼ぶ場合も、Backendが作成したjobIdと保存済みRunをBackend内部APIで照合する。Queue認証だけで業務権限を与えない。
- タイムアウト、retry、最大body size、error codeを`internal-contracts`と内部OpenAPIに固定し、consumer/provider contract testをCIで実行する。
- URLに`internal`があることやprivate networkだけに依存せず、アプリケーション層でもRun/Case/scopeを検証する。

## 7. DomainとSingle Writer

### 7.1 中核Entity

| Entity | 役割 |
|---|---|
| Case | 案件、状況、基準日、管轄、caseVersion |
| Person / Relationship | 関係者と確認済みの家族関係。未確認は未確認として保持。`isHeir`は利用者記録であり法定判定ではない。除外は削除ではなく状態 |
| Document | 原本参照、版、hash、解析状態。抽出結果は別の候補情報 |
| Task / Deadline | 実行すべき作業と根拠付き期限。依存関係を表現 |
| Contract / Benefit | 契約情報と給付・請求対象。Assetと混同しない。方針（CONTINUE/TRANSFER/CANCEL）と進捗は利用者申告の記録で、外部での確認・実行とは区別する |
| Asset / Liability | 財産・債務。金額はJPY最小単位整数、未設定はnull。確認記録（誰が・いつ・どの版を）を持ち、事実変更で無効化。MVPでは詳細な相続計算をしない |
| Insight | AI結果から保存する根拠付き気づき。本文は共有、既読/非表示は閲覧者ごと。根拠の版と現在版の差をfreshnessとして表示 |
| Decision | 本人意思。誰が、何を、いつ確定したか |
| Proposal | AIが提出する変更案、根拠、対象version |
| Approval | 特定のProposal/Action内容に対する承認 |
| Evidence | 完了条件・情報確認を裏付ける証跡 |
| Action | 実行する操作の台帳。結果不明と失敗を区別 |
| AgentRun | 実行要求、経路、バージョン、待機理由、結果の公開用管理記録 |
| AuditEvent | 誰が何を提案・承認・確定したかの追記記録 |

### 7.2 三つの責務を混同しない

1. **Primary Case Agent**はCase単位のAI判断とProposal作成を担当する。すべてのCaseで同じAgent定義を使うが、Contextと状態はCaseごとに分離する。
2. **Command Handler**はUser/System/AI Proposalからの全業務変更を検証して確定する唯一の論理経路。
3. **Firestore Transaction**は実際の並行更新を制御する。Backend ServerやAI Serverが複数インスタンスになっても、正式変更はBackendの同じ不変条件を通る。

状態変更は`start/complete/confirm/policy/progress/acknowledge/exclude/archive`のような明示Commandで受け、PATCHは記述フィールドの訂正だけに限定する。版付きCommandは`expectedVersion`を要求し（新規作成・同意・本人の閲覧状態等はroute specに従う）、実行者、時刻、出所（`MANUAL` / `USER_REPORTED` / `AI`）を記録する。

ユーザーの入力や承認をAgentの会話へ迂回させる必要はない。ユーザーの変更はCommand Handlerが直接受け付け、AIの古いContextからの提案をversion検証で拒否する。

### 7.3 排他とversion

- AIが正式状態を変えるProposalを作る実行区間ではCase単位のleaseを取得する。
- leaseは`ownerRunId / expiresAt / fencingToken`を持ち、取得・更新・引継ぎはTransactionで行う。
- 古いAI Serverインスタンスが再び動いても、現在のfencingTokenと一致しないProposal提出・適用をBackendが拒否する。
- suspend中はleaseを解放する。数日待ちのWorkflowが他の案件内作業を停止させない。
- resume時はleaseを取り直しContextを再構築する。古いSnapshotの業務事実を正式状態へ戻さない。
- Contextの事実を変える変更（Case基本情報、関係者、書類の利用可能性、Task、Deadline、確定Decision等）は対象Entity.versionとCase.caseVersionを増やす。Proposal提出、Approval応答、runtime進捗だけではcaseVersionを増やさず、それぞれのversionで管理する。承認操作そのものが承認対象のbaseCaseVersionを無効にする循環を避ける。
- AI ProposalはbaseCaseVersionと対象Entity版を保持。競合は自動上書きせず再計画へ戻す。
- read-only処理は並列化可能。戻り値には読み取り時点のversionを付け、Primaryが採用前に有効性を確認する。

## 8. Proposal・Approval・確定処理

Proposalの自アプリ契約例:

```ts
type ProposalEnvelope = {
  schemaVersion: 1;
  proposalId: string;
  caseId: string;
  runId: string;
  kind: 'task.create' | 'fact.record' | 'document.request'
      | 'evidence.record' | 'task.complete' | 'escalation.request';
  baseCaseVersion: number;
  targetVersions: Record<string, number>;
  contextSnapshotId: string;
  playbookVersion: string;
  evidenceRefs: string[];
  rationaleSummary: string;
  payload: unknown; // 実装時はkindごとのdiscriminated unionで検証
};
```

tenant、actor、現在のlease token、idempotency scopeは信頼済み実行環境から付与する。Agentに指定させない。`rationaleSummary`は説明用の短い判断根拠であり、内部思考過程の保存を要求しない。

処理順:

1. Schema、Case権限、Runとの対応、許可されたProposal kindを検証。
2. 根拠の存在・版・所属Case、対象Entityの版、状態遷移、Ruleを検証。
3. サーバーのApproval Policyが承認要否を決める。Agentが`approvalRequired: false`としても採用しない。
4. 承認が必要ならimmutableなProposal版とpayload hashに紐づくApprovalを作成し、待機イベントを発行。
5. 承認後も権限、対象版、根拠、Rule、承認期限を再検証。
6. Transaction内で正式Entity、Proposal状態、監査、Outbox、冪等性結果を原子的に更新。

Proposal状態は`submitted → validated → awaiting_approval → applied`。不要承認の場合は`validated → applied`。分岐として`rejected / stale / expired`を持つ。

Approvalは対象Proposal版/Action hash、approver権限、作成/失効時刻、決定時刻を持つ。承認後に送信先や資料が変わった場合は旧承認を流用せず再承認とする。却下した同一Proposalをそのまま再承認させない。

AIの抽出候補（財産・契約・気づき）は正式な資産・債務・契約・給付・事実・法的判断へ自動昇格しない。候補の正式化は承認済みProposalの適用に限る。Task、財産、債務、契約、関係者、書類要求、根拠、専門家引継ぎの適用Adapterを実装済み（[入力契約](api/proposal-payloads.md)）。AI由来Proposalの内部提出・lease連携は #41。公開APIの手動登録・Applier実装と、実AIへの接続完了を混同しない。

MVPでは説明付きTask候補の作成など限定した低影響の変更だけ自動適用可。本人意思確定、重要な抽出事実の正式登録、準備資料の確定には人の確認を入れる。外部送信・解約・送金はMVP対象外。

## 9. Context Engine

Context Engineは単なるRAGではなく、Case Agentが今回の判断に必要とする情報を選別・整合・圧縮するモジュール。

入力はBackend内部APIが返すRun scope付きContext、operation、対象Task、Playbook、許可されたArtifact参照、token budget。出力は型付き`ContextBundle`。AI Serverはtenant/Case/actorの権限を独自に組み立てず、Backendが発行したRun scopeだけを利用する。

| Bundle要素 | 内容 |
|---|---|
| identity | Case ID、Run ID、caseVersion、生成日時、管轄/タイムゾーン |
| goal | 今回の目的、Task、完了条件、許可Action |
| facts | 確認済み事実と未確認候補を分離 |
| tasks/dependencies | 関連Task、前提条件、阻害要因 |
| deadlines | 算定結果、基準日、ruleVersion、未確認点 |
| documents/evidence | 必要箇所だけの抜粋、原本ID/版/hash/ページ |
| decisions/approvals | 本人の意思、保留理由、承認scope、禁止事項 |
| trajectory | 重要なTool結果、失敗、変更、過去の採用/却下理由 |
| openQuestions | 不足情報、矛盾、確認が必要な事実 |
| provenance | 各事実の出典・更新時刻・信頼区分 |

構築手順:

1. AI ServerのBackend ClientがRun scope付き内部APIからCaseデータを取得する。
2. 関連性を絞り、契約・受取人・書類版などの矛盾を検知する。
3. confirmed / user_reported / extracted_candidate / unknownを明示する。
4. 重要なDecision、禁止事項、未解決事項は削らず、古い作業履歴を根拠参照付きで圧縮する。
5. token上限を超える場合は関連文書を分割取得。省略情報を記録する。
6. Bundleのmanifest、hash、参照版、builderVersionをContextSnapshotとして保存する。

一貫性は取得前後のcaseVersionを比較し、途中で変化したら再構築する。関連する業務変更が必ずcaseVersionを増やすことを前提とする。複数Queryを並べただけで一貫したSnapshotと呼ばない。

原本中の命令文や検索結果はデータとして扱い、System Prompt・Tool権限・ルーティング規則に昇格させない。書類の「承認済み」という文字列はApprovalの代わりにならない。

Mastra Memoryを将来使う場合も補助的な会話/Working Memoryに限定する。MVPは会話をFirestoreのmessagesに保存し、必要履歴をContext Engineが選んで渡す。自動Memory保存は無効にしてStorage実装範囲を抑える。正式状態はMemoryから復元しない。

## 10. Playbook

Playbookは業務を切り替えるバージョン付き定義。実行順序と待機はWorkflow、業務制約はDomain Rule、Agentへの作業指針はPlaybookに置く。

必須項目は`id / version / jurisdiction / goal / requiredInputs / procedure / postconditions / forbiddenActions / approvalPolicyRefs / ruleRefs / allowedToolIds / evidenceRequirements / escalationConditions`。

MVPの`insurance-claim-preparation/v1`例:

- Goal: 指定された保険契約について、請求準備資料と不足情報を整理する。
- Inputs: 確認済みCase情報、契約書類、受取人の根拠、保険会社の案内資料。
- Procedure: 契約確認 → 受取人情報確認 → 必要書類確認 → 不足書類要求 → 準備資料生成 → 人の確認 → 検証。
- Postconditions: 資料版、必要項目、根拠、不足情報の解消、確認者を記録。完了範囲は申請準備まで。
- Forbidden: 受取人の推測確定、契約変更、承認の自己発行、外部送信。
- Escalation: 受取人不一致、契約解釈の対立、情報欠落、本人意思が必要な判断。

具体的な必要書類や期限を本書だけで確定しない。機関・管轄ごとの確認済みRule/資料に基づいて実装する。法的期限や資格条件の数値は本仕様にハードコードしない。

Workflowは開始時にPlaybookとRuleの版を固定する。ただしresume時に更新・失効を確認し、適用条件が変わっていれば再検証/再計画する。

## 11. Mastra WorkflowとVerification Loop

MastraのSuspend/Resumeは保存された実行状態を使う。永続Storageを明示的に設定し、再起動を跨ぐ再開を確認する。[Mastra Suspend and Resume](https://mastra.ai/docs/workflows/suspend-and-resume)

### 11.1 Workflow一覧

| Workflow | 主なStep | Case Agentの役割 |
|---|---|---|
| document-ingestion | 原本検査 → OCR/抽出 → 候補保存 → Context更新 → Proposal → 検証 | 抽出候補をCaseに照らして評価・提案 |
| case-planning | Context → Task/依存関係案 → Rule検証 → Proposal適用 → 結果確認 | 計画案を作る |
| task-preparation | 前提条件 → 不足書類待ち → 資料生成 → 承認待ち → 適用 → Evidence検証 | 手順解釈と資料作成 |
| case-guidance | Context → 根拠付き回答 → 出力検証 → 回答保存 | 案内。業務Proposal Toolは渡さない |
| task-monitoring | 期限/待機条件の決定的検査 → 必要時だけ再計画 | 変化がある場合だけ計画調整 |
| professional-escalation | 理由整理 → 引継ぎ資料 → 人の確認 → 待機 | 判断を引き継ぐ要約。外部自動送信は将来 |

read-only intelligenceはWorkflowの内部処理として並列に実行可能。抽出候補の技術的保存は許可するが、Person、Contract、Deadlineなどの正式値へは書き込めない。

### 11.2 標準Loop

```text
Observe / Build Context
  → Plan（Case Agent）
  → Validate Plan（Domain + Policy）
  → Execute（許可Tool・決定的Step）
  → Verify（Evidence + 完了条件）
  → 成功: 結果をCommandで確定
  → 不足: suspend / clarification / Re-plan
  → 上限到達: needs_attention
```

Verifyでは「APIが200を返した」だけでなく、想定した資料版が存在する、必要項目が揃う、承認対象hashが一致する、対応する証拠があることを確認する。外部申請を将来追加する場合は受付証などを別途必要とする。

Loop、Tool回数、時間、token、費用の上限を設定する。初期案は1実行区間の再計画2回・Tool呼出し20回までとし、評価結果で調整する。無制限の自己修正を認めない。

### 11.3 待機・再開の整合性

1. Workflowが不足条件を判定し、Backend内部APIへ冪等なWaitRequest/Approval作成を依頼する。
2. MastraをsuspendしSnapshotを永続化する。
3. AI ServerがBackend内部APIへ待機イベントを送り、BackendがAgentRunへ待機理由とSnapshot対応を記録してCase leaseを解放する。
4. 書類登録・承認などはCommand Handlerが保存し、同一Transactionでresume intentをOutboxへ追記する。
5. Backendがresume jobを発行し、AI ServerはBackend内部APIを通じて未消費イベント、待機条件、Snapshot保存完了、Run/Case対応を照合する。
6. Backendが権限、caseVersion、根拠、承認の有効性を再確認する。AI Serverは新しい実行所有権を得てから、対象の保存済みStepをresumeする。

業務TransactionとMastra Snapshot保存は一つの原子操作にはならない。承認イベントがSnapshotより先に届いても捨てず、Inboxに残して後で照合する。Snapshot保存後のクラッシュでRun表示が遅れた場合もReconcilerが修復する。待機状態の真偽はSnapshotとWaitRequestの両方から判定する。

実行中のクラッシュとsuspend済みRunの再開は区別する。利用できる永続checkpointがあればそこから復旧し、なければBackendに保存済みの入力から同じRun/Action識別子で実行区間を再試行する。すべてのStepを冪等にし、書き込み前にBackend内部APIから適用済みProposal/Actionを照会する。通常のrunning中も任意の命令位置から復旧できると仮定しない。

Run状態は`queued / routing / running / waiting_document / waiting_approval / waiting_external / retry_scheduled / succeeded / failed / cancelled / needs_attention`。Mastra内部statusと一対一に同一視せず、明示的な変換関数を持つ。

cancelは協調的中断。次のStep/Tool前に確認し、既に確定した業務変更を自動で巻き戻さない。retryは同じ業務Action IDを保ち、attemptだけ増やす。成功済み変更を再適用しない。

## 12. Toolsとread-only intelligence

| 区分 | Tool例 | 権限 |
|---|---|---|
| Read | getCaseContext, getTasks, getDocuments, getEvidence, lookupRule | 認可されたCaseの限定読取 |
| Intelligence | extractDocument, searchApprovedSources, reviewProposal | 候補・助言を返すのみ |
| Propose | submitProposal | Primary Case Agentの許可モードだけ |

`requestDocument / requestApproval / proposeEscalation`はAI Server内で型付きProposalへ変換し、Backend内部APIへ提出する。承認要否はBackend側Policyが決める。AgentがApprovalを承認したり、任意の人へ通知を送ったりする直接Toolにはしない。

AIへ`updateFirestore / completeTaskDirectly / approve / executeArbitraryHttp / runShell`のような汎用権限Toolを渡さない。正式変更や将来の外部Action実行はWorkflowの決定的StepがBackendの許可済みCommandを呼ぶ。

すべてのToolに入力/出力Schema、timeout、最大出力量、許可scope、監査分類、再試行方針を定義。Tool境界でも入力を検証する。書類IDのすり替えを防ぐため、BackendがRunとの所属を毎回確認する。

Reviewerは必要なProposal、根拠、Ruleだけを受け取って独立に検証する。Primaryの長大な会話や結論に無条件に追従させない。Reviewerの結果は助言であり承認や正式変更ではない。

## 13. Orch Router【必須】

### 13.1 責務

Orch Routerは「どの業務実行経路を使うか」を選択する。Mastraは選択された経路を実行し、Model Routerは必要なLLMを選ぶ。この三つを分離する。

参照会話と今回の依頼には、必須製品の公式URL、SDK名、版がない。名称から特定の論文・OSS・製品と断定しない。本書ではOrchestration Routerとしての論理契約を定義し、指定製品への対応をAdapterの実装課題とする。

```ts
interface OrchRouterPort {
  route(input: RouteRequest): Promise<RouteDecision>;
}
type RouteRequest = {
  operation: string;
  resourceKinds: string[];
  allowedRouteIds: string[];
  hasSuspendedRun: boolean;
  policyVersion: string;
};
type RouteDecision = {
  routeId: string;
  playbookId?: string;
  reasonCode: string;
  routerVersion: string;
  externalDecisionId?: string;
};
```

入力は最小限の業務分類・リソース種別とする。外部Routerへ個人情報や原本を送ることを既定にしない。SDKが別の入力を要求する場合は送信データを明記したADRを作る。

### 13.2 Route Registry

| operation | 許可するrouteId | 実行先 |
|---|---|---|
| document.analyze | document-ingestion-v1 | Mastra Workflow |
| case.plan | case-planning-v1 | Mastra Workflow内のCase Agent |
| task.prepare | task-preparation-v1 | Playbook指定Workflow |
| case.ask | case-guidance-v1 | read-onlyモードのCase Agent |
| task.monitor | task-monitoring-v1 | 決定的検査中心のWorkflow |
| case.escalate | professional-escalation-v1 | 引継ぎ資料Workflow |

通常のCRUDはAI起動ではないのでRouterを通さない。新しいAI Runは必ずOrch Adapterを通る。未知Route、許可外Tool、操作と矛盾するRoute、未知PlaybookはRouter返答後に拒否する。

Route結果はAI ServerからBackend内部APIへ報告し、BackendがAgentRunへ保存する。処理途中の再試行では無断で変更しない。resumeもOrch Adapterを入口にするが、保存済みRouteだけを候補として渡す。別Workflowへの変更が必要なら新Runとして再計画する。

### 13.3 障害と実製品確認

- Router障害時はbounded retry後に`retry_scheduled`または`needs_attention`。本番・ハッカソン実演でmockへ黙って切り替えない。
- ローカルテスト用Fake Adapterは可。ただし実Orch利用の要件を満たしたとは扱わない。
- 接続完了条件は、指定SDK/APIを実際に呼び、返った結果がRoute選択へ使われ、無効Routeが拒否され、利用証跡をRunに保存できること。
- 指定製品がモデル選択専用だった場合、論理Orch Routerはアプリ側で保ち、その製品をModel RouterのAdapterとして組み込む案にADRを更新する。製品の能力を確認せずAgent/Workflow選択を行えると仮定しない。

この未確定事項は文書作成を妨げないが、「指定Orch Router統合済み」という実装完了判定は保留となる。

## 14. Model Router / Fallback

モデル選択は`capability requirements → policy → provider adapter`とする。Agent定義やPlaybookにProvider SDK呼出しを埋め込まない。

能力は単一文字列だけでなく、`reasoning / structured-output / vision / tool-calling / context-window / latency / data-policy`の組合せで表現。モデル名と優先順位は設定として管理し、実装開始時に利用可能性を確認して固定する。

Mastra AgentのモデルにはModel Routerに対応するAdapterを注入する。MastraのTool loopを維持し、Agentの外側で別の汎用LLM loopを二重実装しない。具体的な接続方式と型は採用Mastra版に対して検証する。

| エラー種別 | 方針 |
|---|---|
| timeout / 429 / 5xx / 接続障害 | 上限付き再試行、その後に互換性のある別ProviderへFallback |
| 401 / 403 / 設定不正 | 無限再試行しない。運用エラー記録、許可済み候補があれば切替 |
| Structured output不正 | 1回まで修正要求。失敗ならStep失敗/要確認。モデル切替で業務検証を回避しない |
| 根拠不足 / Rule違反 | 情報追加・再計画・人への確認。障害としてProviderを替えない |
| Providerの安全拒否 | 拒否を記録して確認へ。拒否回避を目的にFallbackしない |

初期案は1推論要求あたり合計3 attempt以内、最大2 Provider、全体時間上限を持つ。Provider SDK、Mastra、Workflow、Queueの各retryが掛け算にならないよう、attempt budgetを共有する。

Fallback後も同じ出力Schema、許可Tool、データ取扱条件を守る。対応していない候補へ無理に切り替えない。全候補が利用不能ならRunを失敗/再試行待ちにし、業務状態を変更しない。

モデル切替は失敗した推論区間から行う。Workflow全体や成功済みToolを巻き戻して再実行しない。Tool結果をProvider間で渡す際は自アプリの正規化形式を使う。

`provider / model / policyVersion / attempt / latency / tokenUsage / fallbackReason`を記録する。Circuit Breakerは将来強化可だが、timeout、失敗分類、試行上限、最低2 ProviderでのFallback検証はMVP必須。

## 15. Firestore方針

### 15.1 保存領域

```text
Backend business Firestore（Backend Serverだけが接続）
tenants/{tenantId}
  members/{userId}
  cases/{caseId}                    # caseVersion, 基本情報
    members/{userId}                # Caseごとのrole/scope
    persons/{personId}
    relationships/{relationshipId}
    documents/{documentId}
      analyses/{analysisId}         # 未確認候補、原本版を参照
    tasks/{taskId}
    deadlines/{deadlineId}
    contracts/{contractId}
    benefits/{benefitId}
    assets/{assetId}                # 確認記録を含む
    liabilities/{liabilityId}
    insights/{insightId}
    insightViews/{viewId}           # Insight×閲覧者のハッシュID
    insightResults/{resultKey}      # Run×resultIdの重複受領防止
    decisions/{decisionId}
    proposals/{proposalId}
    approvals/{approvalId}
    evidence/{evidenceId}
    actions/{actionId}
    agentRuns/{runId}
      events/{eventId}
    contextSnapshots/{snapshotId}
    waitRequests/{waitId}
    messages/{messageId}
    auditEvents/{auditEventId}
    coordination/writer            # lease + fencingToken
  outbox/{eventId}
  inbox/{eventId}
  idempotency/{scopedKeyHash}

AI runtime Firestore database（AI Serverだけが接続）
runtimeTenants/{tenantId}
  workflowRuns/{runtimeRunId}       # Case/Run対応、Snapshot参照
    snapshots/{snapshotVersion}    # 実装方式はAdapterで管理
```

業務Repositoryとruntime Storageは別のサービス・資格情報・Repositoryとして扱う。Mastra Storage Adapterだけがruntime領域へ書き込み、Case/Task等の業務領域へはアクセスしない。Backend ServerもSnapshotの中身を直接解釈せず、AI Serverから報告されたruntimeRunIdとstatusの対応だけを保持する。runtimeの保存はSingle Writerの「正式業務状態の確定」と区別する。

主要Entityに`id / tenantId / caseId / version / schemaVersion / createdAt / updatedAt`を持つ。所属IDを重複保持する場合はパスとの一致を検証する。サーバー時刻を使い、金額は通貨と最小単位整数で保存する。

### 15.2 Transaction / Outbox / 冪等性

- Domain変更、AuditEvent、Outbox、冪等性結果は同一Transactionで保存する。
- Transaction関数内でLLM、外部HTTP、Queue送信、Cloud Storage操作を実行しない。Firestoreは競合時にTransaction関数を再実行し得る。[Firestore Transactions](https://firebase.google.com/docs/firestore/manage-data/transactions)
- 配送は少なくとも1回を前提とする。BackendのOutbox送信後・送信済み記録前のクラッシュでも同じeventId/jobIdをAI Serverへ再配送し、AI Serverが重複排除する。
- lease失効、未配送Outbox、未消費Inbox、古いrunning Runを定期照合する。OutboxはAPIリクエスト終了後の一度きりの処理に依存させない。
- Action IDは業務上の一操作を表し、retry attemptを含めない。再試行ごとに新しいIDを作って二重操作を許さない。
- 将来の外部Actionは送信先の冪等性キー/状態照会を使う。タイムアウトで成否不明なら`unknown`として照合し、無条件再送しない。

### 15.3 Mastra Snapshotの永続化

MastraはWorkflow Snapshotを設定されたStorageへ保存する。2026-09-20に確認した公式Storage一覧ではFirestoreの公式Adapterを確認できなかったため、「Firestoreを指定すれば自動的に動く」とは扱わない。[Mastra Storage](https://mastra.ai/docs/storage) / [Mastra Storage Reference](https://mastra.ai/reference/storage/overview)

本設計の既定案は、採用バージョンのMastra Storage契約に合わせて**Workflow domain用Firestore Adapterを実装する**こと。初期スパイクで公開拡張点・必要メソッドを確認し、対応表と採用版をADRへ記録する。SDKのprivateフィールドの書き換えで実現しない。

MVPの実装対象はSnapshotの保存/取得/更新、Run検索、必要な削除/保持期間操作。Memory、Mastra組込みScheduler、永続Evalsなど未実装domainを有効にしない。利用されないdomainに成功を返す空実装を入れない。

同じruntimeRunIdに対する実行所有権もAI runtime側で排他管理する。Snapshot更新は所有epochと版をTransactionで確認し、古いAI Serverインスタンスが新しいSnapshotを上書きできないようにする。これはBackend側のCase lease検査とは別に必要であり、採用SDKのStorage呼出しにどう伝播させるかをスパイクの検証項目とする。

Snapshotは書類本文や巨大なTool出力を含めず、artifact参照と小さい結果だけをStep間で受け渡す。初期上限はserialized 512 KiB。超過時は保存前に検出し、`needs_attention`として再現可能なエラーを残す。必要に応じてArtifactをCloud Storageへ分離し、Firestoreにhash/参照を保存する。Firestore文書の上限は1 MiBである。[Firestore Usage and Limits](https://firebase.google.com/docs/firestore/quotas)

業務AgentRunは受付・権限・結果表示の正式記録、Mastra Snapshotは再開位置の正式記録。片方をもう片方の全面コピーとして扱わない。Task完了やApproval成立はSnapshotだけから確定しない。

Workflow定義、Playbook、SDKの版をRunに記録する。既存の待機Runを再開できる旧定義を保持するか、明示的な移行を行う。単に最新版Workflowへ古いSnapshotを投入しない。

Firestore Adapterの互換性が確保できない場合は、ADRでMastra runtime専用の公式対応DB追加案を比較する。業務Source of TruthはFirestoreに維持できるが、本書の既定構成を黙って別DBへ変更しない。

### 15.4 原本、検索、認可、保持

- 原本・OCR全文・生成資料はCloud Storage。Firestoreにはメタデータ、hash、版、アクセス制御、参照を保存。
- API経由アップロードはMVPでPDF/JPEG/PNG、1ファイル10 MiBまでを初期値とする。Content-Typeだけでなく実体を検査し、未検査ファイルは解析対象にしない。
- Storage書込とFirestoreは非原子的。`uploading → stored → queued`を管理し、孤立オブジェクトの回収処理を用意する。
- フロントからのFirestoreアクセスはSecurity Rulesで拒否。Server SDKはRulesを迂回するため、IAMとApplication認可を両方実装する。[Firestore Security Rules](https://firebase.google.com/docs/firestore/security/rules-conditions)
- 一覧はカーソルページング。tasks(status, updatedAt)、deadlines(status, dueAt)、runs(status, createdAt)、outbox(status, nextAttemptAt)等、利用Queryに対応した複合indexを管理する。
- 長文、Snapshot payload、抽出全文は不要なindexを付けない。Caseの一文書に全Task/履歴を配列で詰め込まない。
- archiveは通常の利用停止。必要な個人データ削除は別の明示的な削除手続きとし、原本・抽出・Context・Snapshot・ログまで追跡する。
- Auditは通常操作で更新/削除できない追記設計。ただし無期限保存や完全な改ざん防止をFirestoreだけで保証したと表現しない。
- 再現可能な派生データと、再開に必要なSnapshotを区別する。未完了RunのSnapshotをTTLで消さない。

## 16. 実装ルール

1. TypeScript strict mode、pnpm workspace、依存lockfileを使う。SDK/APIは導入版の公式ドキュメントで検証する。
2. 公開APIと内部APIの契約から別々のOpenAPIを生成する。EntityやSDK型をそのまま返さず、内部OpenAPIを外部配布しない。
3. Command Handlerに認可・Rule・version・監査を集約する。手動操作とAgent操作で別の状態遷移ロジックを作らない。
4. 未確認事実をconfirmedに変える条件を明示する。AI confidenceだけを正式確認の根拠にしない。
5. 期限はRule Engineが基準日、管轄、timezone、ruleVersion、根拠とともに算定する。延長は元期限を消さず履歴化する。
6. Decision確定・Approval承認は人の権限による。Agentは判断が必要なTaskを提案できるが本人意思を代入しない。
7. 状態変更Toolを別AgentやReviewerに渡さない。案内モードのCase AgentにもProposal Toolを渡さない。
8. 正式状態変更はTransaction、外部副作用はOutbox/Action台帳。HTTP request内で長期Workflowを完走させない。
9. RequestContextのtenant/Case/actor/RunをSDKのグローバル可変状態に置かない。Case間のContext混入を防ぐ。
10. APIキー、資格情報、原本全文をPrompt、監査、進捗イベントへ不用意に残さない。モデルへ渡すデータを必要箇所に絞る。
11. Mastraの内部APIやStudioを公開APIへ丸ごとmountしない。開発用UIはローカルまたは認証された内部環境のみ。
12. Runのversion、Route、モデル切替、根拠参照、Rule判定結果は追跡可能にする。観測対象は入出力・操作・短い理由であり、非公開の思考過程ではない。
13. エラー時のretryable、nextAttemptAt、操作結果不明を区別する。再実行は最新の権限と状態を確認する。
14. 外部Actionを追加するときは、Action hashに対する承認、送信先、添付版、冪等性、結果検証を実装してから有効にする。
15. Backend ServerとAI Serverは個別にbuild/test/deployできる状態を保つ。相手サービスの`src`を直接importしない。
16. AI Serverには業務Firestore/原本Storageの資格情報を設定しない。必要な情報はRun scope付きBackend内部APIから取得する。
17. 内部HTTPの失敗を業務上の空データへ変換しない。timeout、認証失敗、stale、not foundを区別してWorkflowを停止・再試行する。

## 17. MVP範囲と実装順序

### 17.1 MVPに含める

- 認証、Case membership、Case/関係者/最小契約情報の登録。
- 既存フロント機能の範囲: 家族、財産・債務（手動）、契約・給付の方針/進捗、気づきの一覧と既読/非表示、承認、チャット、ダッシュボード（[対応表](api/frontend-backend-mapping.md)）。
- 独立したHono Backend ServerとHono AI Server、双方向の認証済み内部API。
- 原本アップロード、抽出候補、ユーザー確認、根拠参照。
- 一つの保険請求準備PlaybookとPrimary Case Agent。
- document-ingestion / case-planning / task-preparation / case-guidanceの縦通し。
- Monitoringは期限・待機状態の決定的検査と再計画要求まで。
- Task、確認状態付きDeadline、本人Decision記録、Proposal、Approval、Evidence、Audit。
- 必須Orch Routerの実接続、Route制約、利用証跡。
- Model Routerと最低2 Providerの障害切替。
- Firestore Workflow Storage Adapter、Suspend/Resume、再起動復旧。
- Case lease、version検証、Idempotency、Outbox、重複配送処理。
- 進捗ポーリング、承認待ち/書類待ち表示、取消・再試行。

### 17.2 MVPに含めない

- 保険会社、行政、金融機関への自動提出・契約解約・送金。
- 相続・税務の最終判断、複雑な財産評価、全手続きの網羅。
- 業務ごとの独立Agent群や、複数Agentの並列書き込み。
- 自由なWeb操作、ブラウザー自動申請、任意URL/任意コマンド実行。
- 専門家への自動連絡。MVPでは引継ぎが必要な状態と資料を保存する。
- 高度な意味検索、Mastra Memory全面採用、SSE、外部通知、汎用Workflow編集画面。

### 17.3 実装順序

| 段階 | 実装 | 完了条件 |
|---|---|---|
| 0 | Orch実製品確認、SDK版固定、Firestore Snapshot Adapterスパイク | Orch実呼出し、保存→プロセス終了→再開が動く |
| 1 | workspace、依存制約、Backend Hono、認証、公開契約、Domain | 非AIのCase/Task CRUDが認可付きで通る |
| 2 | AI Hono、Service認証、内部契約、Backend/AI Client、Outbox | 2サービス間のcontract testと重複配送試験が通る |
| 3 | Command、version、監査、Context Engine、Playbook、Orch、Model Router、Case Agent | AIが内部API経由で提出した根拠付きProposalだけが検証を経て反映される |
| 4 | 文書解析、書類待ち、承認待ち、準備資料、Verify | 再起動を跨いだ縦通しシナリオが成立 |
| 5 | 画面接続、Evals、復旧手順、運用設定 | 受入条件を満たしてMVP完成 |

### 17.4 受入条件

- Frontendの通信先が公開APIに限定され、Mastra/Firestore直接アクセスが存在しない。
- Backend ServerとAI Serverを別プロセス・別資格情報で起動でき、片方のソースを直接importしていない。
- AI Serverに業務Firestore/原本StorageのIAM権限がなくても全MVP Workflowが内部API経由で動く。
- Agent/Toolから業務Firestore Repositoryへの直接依存を静的検査とIAMの両方で拒否できる。
- Backend ↔ AIの相互認証で、誤ったaudience、期限切れ要求、別RunのArtifact参照を拒否できる。
- 別Case/別tenantのdocumentIdやrunIdに置換しても情報を取得・変更できない。
- 同じリクエストやJobを複数回送っても、Task・Proposal・承認結果・Actionが重複しない。
- ユーザー更新後に古いAI Proposalを適用すると409/staleとなり、最新Contextで再計画される。
- lease期限切れ後に古いAI Serverインスタンスが返ってきても、その提案/確定がBackendで拒否される。
- 承認前、却下後、承認対象hash変更後には対象操作が確定しない。
- 承認イベントがSnapshot保存前に届いても、後で一度だけ再開できる。
- suspend後にAI Serverを終了・再デプロイしても、同じ待機Runと資料版から再開できる。
- Snapshot保存失敗や容量超過を成功扱いせず、UIへ要確認状態を返す。
- モデル障害時に同じSchema/権限でFallbackし、成功済みToolを重複実行しない。
- 根拠のない完了報告や書類内の命令でTask完了・承認済みにできない。
- 準備資料の完了が、保険金請求受付や受領完了として表示されない。
- 状態変更（Task status、確認、方針、進捗、既読、除外、利用停止）がPATCHでは変更できず、Commandでのみ遷移し実行者・時刻・出所が残る。
- 公開APIのbodyで`source`/`agentRunId`/`confirmation`等を送っても拒否され、AI候補が正式状態に自動昇格しない。
- 指定Orch Routerを実利用した証跡と、その結果に対応する実行Routeが確認できる。

テストはDomainの状態遷移/期限/承認、Backend ↔ AIのconsumer/provider contract、Firestore Emulatorの並行処理、Storage Adapterの契約、AI Server再起動/重複配送の統合、一本のE2Eを中心とする。E2Eでは両サービスを実HTTPで接続し、in-process adapterへ差し替えない。LLM Evalsは抽出の根拠一致、Task妥当性、重大項目欠落、引用の正確性、越権Tool要求の拒否を評価する。実人物の書類をテストfixtureに含めない。

## 18. Go/Echo旧設計からの置換対応

| 旧責務 | 新しい配置 |
|---|---|
| Go/Echo Public API | `apps/backend-server`のHono public routes |
| Go UseCase | `apps/backend-server/src/application` |
| Go Domain / Rule Engine | `apps/backend-server/src/domain` |
| Go Firestore Repository | `apps/backend-server/src/infrastructure/firestore` |
| Go → Hono Agent API | Backend Hono → AI Honoの認証済み内部API |
| Mastra → Go Tool API | AI Hono → Backend HonoのRun scope付き内部API |
| 独立したDocument/Planning/Guidance Agent | 共通Case Agent + Workflow + Playbook/権限モード |
| Go側のAgentRun/Event/Audit | Backend Application/Firestoreで維持 |
| Model Gateway | AI Server内のModel Router/Provider Adapter |

既存Go実装がある場合は、先に公開契約・データ形・状態遷移を一覧化して互換性テストを作る。機能単位で切替え、同じCaseを旧Go Writerと新TypeScript Writerが無調整で同時更新する状態を作らない。既存データにはschemaVersionを付け、必要な移行はdry-run可能にする。実装が未着手ならGo用ディレクトリは作らない。

## 19. 未確定事項と一次資料

### 未確定事項

| 項目 | 現時点の方針 | 実装前に必要な確認 |
|---|---|---|
| Orch Routerの製品 | 必須Adapterとして確保 | 公式URL、SDK/API名、必須利用の判定条件、対応機能 |
| Mastra Storage互換 | Firestore Workflow Adapterを第一案 | 導入版の公開Storage契約と再起動試験 |
| SDK/Node版 | サポート中の互換セットを固定 | package metadataと実接続で検証 |
| LLM | 能力・送信データ条件を満たす2 Provider | 利用権限、モデル名、データ保持条件 |
| 認証/デプロイ | Google Cloud系を既定案 | 既存環境・組織設定との適合 |
| フロント技術 | 既存を維持。未着手なら別途選定 | 本書ではAPI境界以外を固定しない |
| 保険手続きRule | 一つの確認済みPlaybookから開始 | 対象機関の最新案内と業務レビュー |
| 保存期間/削除 | データ種別ごとに定義 | 業務要件と運用方針 |

設計仕様書の作成は完了しても、上記の接続・互換性が検証されたことにはならない。特にOrchの製品特定とFirestore Snapshot実装は最初の技術検証として扱う。

### 参照資料（2026-09-20確認）

- [Cognition — Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working): Contextと書き込み判断の一貫性。
- [Cognition — Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents): Context共有と並列判断の問題。
- [Mastra — Suspend and Resume](https://mastra.ai/docs/workflows/suspend-and-resume): 待機と再開。
- [Mastra — Snapshots](https://mastra.ai/docs/workflows/snapshots): Workflow実行状態の保存。
- [Mastra — Storage](https://mastra.ai/docs/storage): runtime保存と対応Provider。
- [Mastra — Storage Reference](https://mastra.ai/reference/storage/overview): 保存domainと構造。
- [Hono — Node.js](https://hono.dev/docs/getting-started/nodejs): Node.js上のHTTP実行。
- [Hono — Validation](https://hono.dev/docs/guides/validation): 入力Schema検証。
- [Firebase — Transactions](https://firebase.google.com/docs/firestore/manage-data/transactions): 原子的更新と再試行。
- [Firebase — Security Rules Conditions](https://firebase.google.com/docs/firestore/security/rules-conditions): Server SDKと認可境界。
- [Firebase — Usage and Limits](https://firebase.google.com/docs/firestore/quotas): 文書サイズ等の制約。

この文書のAPI名、フォルダー名、業務状態、上限値、MVP範囲は本プロダクトへの設計提案である。一次資料に記載された製品機能と、自アプリで実装する責務を区別して扱う。
