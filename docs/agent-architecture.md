# AIエージェント構成

[設計仕様](architecture.md)に基づく現在の責務図。Primary Case Agentと読み取り専用の調査処理を分け、Backendだけが正式な業務状態を確定する。開発環境ではMastra、AI Runtime、OrcaRouter経由の推論を接続できるが、本番準備は別途必要である。

```mermaid
flowchart TB
    WEB["フロントエンド・利用者"]

    subgraph BACKEND["Backend Server / Hono"]
        API["公開API・認証・認可"]
        INTERNAL["認証済み内部API<br/>Context・原本配信・提案・結果受付"]
        COMMAND["Application / Domain<br/>Rule・版検証・必要な人の承認<br/>正式状態の確定・監査"]
        DELIVERY["AgentRun・Outbox / Inbox<br/>配送・再開・Case lease"]
    end

    BUSINESS[("業務Firestore・原本Storage<br/>Backendのみアクセス")]

    subgraph AI["AI Server / Hono：内部公開のみ"]
        ROUTER["Application Route Registry<br/>operationに対応するWorkflowを制限"]
        WORKFLOW["Mastra Workflow<br/>書類解析・計画・準備・案内<br/>監視・引継ぎ"]
        CONTEXT["Context Engine<br/>確認済み事実・候補・判断履歴・根拠"]
        PLAYBOOK["Playbook<br/>業務手順・制約・完了条件"]
        CORE["Primary Case Agent<br/>案件単位の計画・解釈・提案を集約<br/>案内モードには変更提案Toolを渡さない"]
        SUPPORT["読み取り専用の補助処理<br/>OCR・抽出・許可された情報源の検索・レビュー<br/>候補と助言のみ"]
        MODEL["Model Policy → OrcaRouter Adapter<br/>許可モデル・上限付き再試行・障害切替"]
        TOOLS["Backend Client / Tools<br/>scope・Schema検証"]
        VERIFY["結果検証・再計画・待機・再開<br/>回数・時間・費用の上限"]
        SNAPSHOT[("永続Workflow Snapshot<br/>AI専用runtime領域")]
    end

    WEB -->|"業務通信・人の承認"| API
    API --> COMMAND
    API --> DELIVERY
    COMMAND --> BUSINESS
    INTERNAL -->|"認可済み取得"| BUSINESS
    INTERNAL -->|"変更提案"| COMMAND
    INTERNAL -->|"進捗・回答・待機・結果"| DELIVERY
    COMMAND -->|"実行・再開イベント"| DELIVERY
    DELIVERY -->|"認証済み内部HTTP"| ROUTER

    ROUTER --> WORKFLOW
    WORKFLOW --> CONTEXT
    CONTEXT <-->|"認証済み内部HTTP"| INTERNAL
    CONTEXT --> CORE
    PLAYBOOK --> CORE
    WORKFLOW --> CORE
    CORE <-->|"調査・検証の依頼と結果"| SUPPORT
    CORE <--> MODEL
    SUPPORT -.->|"必要な推論"| MODEL
    CORE -->|"許可された操作のみ"| TOOLS
    TOOLS <-->|"認証済み内部HTTP"| INTERNAL
    WORKFLOW --> VERIFY
    TOOLS -->|"処理結果"| VERIFY
    VERIFY -->|"最新Contextで再計画"| CONTEXT
    VERIFY <-->|"Suspend / Resume"| SNAPSHOT
    VERIFY -->|"待機・結果報告"| TOOLS
```

同じCaseのAI変更提案は直列化し、正式な書き込みはBackendに集約する。補助処理は業務状態を変更しない。
