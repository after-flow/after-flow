# AI Server 要件定義

> OrcaRouter接続の更新（2026-09-21）: 実製品は推論ゲートウェイ。本文の旧Orch業務Route APIの仮定に代わり、明示モデルへの実推論を接続する。詳細・検証範囲は [OrcaRouter接続](ORCAROUTER.md) を参照。業務経路は引き続きWorkflow/Playbookで制限する。

- 版: 1.2
- 決定日: 2026-09-20
- 状態: 機能・責務・初期提供範囲を確定。実装・実接続の完了を示す文書ではない。
- 対象: `apps/ai-server`。コアと検索・調査の2エージェントを同一AIサービス内で実装する。

## 1. 文書の位置付け

サービス境界・正式状態・認可・永続実行の正本は [アーキテクチャ仕様](../../docs/architecture.md)。本書は会話で決定した2エージェント構成とSkill・Playbook・ハーネス、初期提供範囲を具体化する。旧図の「読み取り専用の補助処理」のうち検索・調査を独立したAgentとして実装する。

Backend提供範囲の拡張は [Issue #3](https://github.com/mimish0778/after-flow/issues/3)、接続条件は [実行制御ADR](../../docs/adr/0003-execution-control.md)、[確定経路ADR](../../docs/adr/0004-confirmation-path.md)、[書類検査ADR](../../docs/adr/0002-document-inspection.md) を参照する。本書はこれらの必須境界を緩めない。

技術製品・対象機関の資料・運用値の選定が必要な項目は第14章の提供開始条件として管理する。未接続をFakeや成功固定で補って本番提供可能としない。Mastra 1.67.0、Skill/Playbook定義、案内用2 Agent、内部HTTP、Context、P-01 Workflowを実装し合成fixtureで検証している。実モデル・検索・Orch・永続Runtimeは未接続のためHTTPの実行受付は503。採用判断・実装範囲・Devinへの引継ぎは [実装方針](IMPLEMENTATION.md) を参照する。

## 2. 目的と提供範囲

遺族が案件の事実・書類・手続き・不足情報を整理し、根拠を確認しながら次の行動を決められるよう支援する。

### 必須の機能

| ID | 機能 | AIの成果物 |
|---|---|---|
| F-01 | 案件に関するチャット | 登録情報と出典に基づく回答、不足する前提の確認質問 |
| F-02 | 手続きの検索・調査 | 提出先、必要書類、手順、公式様式リンク、適用条件、未確認事項 |
| F-03 | 書類からの情報整理 | 項目ごとの抽出候補、出典箇所、既存情報との矛盾、不足情報 |
| F-04 | 手続き計画・再計画 | Task・順序・依存関係・必要書類の変更提案 |
| F-05 | 申請準備の支援 | 必要書類チェックリスト、根拠付き情報整理資料、未解決事項 |
| F-06 | 気づき・人への引継ぎ | 根拠付きの不足・矛盾の指摘、確認が必要な理由と資料の整理 |

- 財産・債務・家族・契約・保険金/年金など、既存画面で管理する情報を認可された範囲で参照する。手動管理できる全業務について、AIが専門的判断や自動計画を網羅すると約束しない。
- 初期対応は有効化されたPlaybook・対象機関・地域・資料に限定する。対応外は明示し、手動管理を継続できるようにする。
- 準備資料は確認用のチェックリスト・事実整理・質問事項とする。外部提出用の申請書本文の作成・自動記入・完成保証は初期範囲に含めない。画面の「書類を作成しない」との表現は接続時にこの区分へ合わせる。
- 抽出候補、本人の申告、確認済み事実を区別する。AIの確信度だけで正式確認としない。
- 期限・待機状態の定期検査はBackend/Schedulerが起点となり、必要な場合だけAIへ再計画を依頼する。LLMを常時巡回させない。

### 初期範囲に含めないもの

外部機関への申請・送信・解約・送金、専門家への自動連絡、相続方法や受給資格の確定、税額計算・複雑な財産評価、全手続きの網羅、任意のWeb操作/シェル実行、Agentによる本番Skillの自己更新、独立したReviewerや業務別Agentの追加。

## 3. 決定した構成

```text
利用者・フロントエンド
        |
        v
Backend：公開API・認可・正式状態・人の承認
        |
        | Outbox経由の認証済み実行依頼
        v
AI Server / Hono（内部公開のみ）
|
+-- Orch Router：許可された業務経路の選択
|
+-- ハーネス：Mastra Agent / Workflow + アプリ固有の実行管理
    |
    +-- Context Engine：最新の案件情報・判断履歴・根拠を整理
    |
    +-- コアエージェント <--- Skill / Playbook
    |     状況理解・計画・利用者への確認・回答・変更提案
    |         |
    |         | 範囲を定めた調査依頼
    |         v
    +-- 検索・調査エージェント <--- 調査用Skill
    |     検索語作成・資料確認・情報照合・追加調査
    |         |
    |         v
    |     許可された検索・Web/PDF取得ツール
    |
    +-- 共通基盤
          Model Router・Backend Client・Schema検証
          実行上限・進捗記録・永続Snapshot・待機/再開

検索結果・出典・適用条件・未確認事項
        -> コアが最新Contextと照合
        -> 回答、利用者への確認、または変更提案
        -> Backendが検証・必要な承認・正式反映
```

- Agent定義は2つ。案件ごとにContextと実行を分離し、全案件で一つの会話や可変状態を共有しない。
- 同じCaseのAIによる計画・変更提案は直列化する。検索や読取処理は正式状態を書き換えない。別Caseの実行は並行可能。
- 検索Agentはコア配下の処理として動き、独自の案件計画、利用者との別会話、子Agentを持たない。初期の同一親Run内の調査は一度に1件とする。
- Workflow、Context Engine、Router、OCR/抽出器、検証器は追加のAgentではない。抽出でLLMを利用しても独立した意思決定主体は増やさない。

## 4. Agentの責務と権限

| 項目 | コアエージェント | 検索・調査エージェント |
|---|---|---|
| 目的 | 案件全体の前提を保ち、次の行動を判断する | 依頼された問いについて根拠を収集する |
| 入力 | 確認済み事実、申告、候補、本人意思、訂正/却下履歴、根拠、目的 | 調査目的、地域/機関、適用条件、必要な背景、求める項目 |
| 判断 | 調査要否、結果の採用、確認質問、計画・提案 | 検索語、確認資料、追加調査、矛盾・不足の報告 |
| 出力 | 根拠付き案内、確認質問、型付きProposal | 型付きResearchResult |
| Tool | 認可済み読取、調査依頼、許可モードでの提案提出 | 許可された検索・取得・資料読取のみ |
| 禁止 | 正式DBへの直接操作、承認、本人意思の確定 | Proposal提出、承認、正式状態変更、コアの権限継承 |

コアは少なくとも `guidance` と `planning/preparation` の権限モードを持つ。同じAgent定義でも、案内モードではProposal Toolを登録しない。モードはBackendが認可したoperationからアプリが決め、モデルが自己昇格しない。

検索Agentが前提不足に気づいたらコアへ返す。コアが必要に応じて利用者へ質問する。検索側で氏名・契約内容等を推測して穴埋めしない。

## 5. 用語と実装上の分担

| 要素 | 本プロジェクトでの定義 | 実装形態 |
|---|---|---|
| Skill | 複数業務で再利用する作業方法 | 指示文・参照資料・例・型付きメタデータ |
| Playbook | 特定業務の目的、前提、手順、禁止事項、完了条件 | 版付き業務定義。Skill/Rule/Policyを参照 |
| Tool | 実行可能な限定操作 | 入出力Schemaと権限を持つTypeScript関数/Adapter |
| Workflow | 分岐・実行順序・待機・再開 | Mastra上のコードと永続実行状態 |
| Harness | Agentを動かす周辺の仕組み全体 | Context、Skill読み込み、Tool実行、上限、検証、復旧等 |
| Domain Rule | 必ず守る業務条件 | Backendの決定的な検証・状態遷移 |

Skill/Playbookの文章に書いた禁止事項だけで権限を守らせない。Tool登録と実行時検証、Backendの認可・Rule・版検証を併用する。

## 6. Skill要件

### 初期Skill一覧

| ID | 担当 | 必須の振る舞い |
|---|---|---|
| S-01 `case-assessment` | コア | 確認済み/本人申告/抽出候補/不明を分け、訂正と本人意思を尊重する |
| S-02 `research-briefing` | コア | 調査項目、対象、必要な前提、完了条件をResearchRequestへまとめる |
| S-03 `official-source-research` | 検索 | 許可された情報源から検索・取得し、ページ/PDFの該当箇所を残す |
| S-04 `evidence-reconciliation` | 検索 | 対象地域・適用条件・資料更新日・矛盾・未確認項目を比較する |
| S-05 `grounded-guidance` | コア | 出典に結び付けて回答し、未確認点と次に確認することを示す |
| S-06 `change-proposal` | コアの提案モード | 変更理由、根拠、対象版をそろえ、許可されたkindだけを提案する |

- Skillは `id/version/description/適用場面/入力/出力/手順/失敗時の扱い/例/参照資料` を持つ。出力Schemaと利用可能なAgent/Toolは型付きメタデータで管理する。
- 指示文・参照資料を版付きで管理し、Mastra標準の `createSkill` とAgentの `skills` に登録する。独自のファイル探索・Skill読み込み機構は作らない。アプリのRegistryは利用可能なAgent/モード/能力の検証と版/hashの管理を担当する。
- 常時渡すのは概要と必須制約。選ばれたSkillの本文と必要な参照資料を追加する。Playbookに必須と定義されたSkillはアプリ側で本文の適用を保証する。初期の案内構成では必要なSkill本文をSystem指示にも含め、モデルによるSkill Toolの呼び忘れに依存しない。
- Skill選択でTool権限を増やさない。要求ToolとRun/Agentの許可Toolの範囲を検証する。
- 指示文・参照資料の版/hashをRunに記録する。本番Skillはレビューと評価を経て更新し、Agentが実行中に恒久変更しない。
- 法定期限の数値、受給条件等をモデル向け文章だけの正本にしない。Backend Ruleと確認済み資料を参照する。

## 7. Playbook要件

### 初期Playbookと実装順序

| ID | Playbook | 完了範囲 |
|---|---|---|
| P-01 | `procedure-guidance/v1` | 一つの対象手続きについて、提出先・必要書類・手順・出典・未確認事項を案内 |
| P-02 | `document-review/v1` | 配信許可済み書類から候補・矛盾・不足を整理し、必要な確認提案を提出 |
| P-03 | `case-planning/v1` | 対応業務のTask・依存関係案を作り、Backendの検証/承認後に結果を確認 |
| P-04 | `insurance-claim-preparation/v1` | 一つの確認済み保険手続きで、チェックリスト・情報整理資料を作り、人の確認と根拠を検証 |

P-01を最初の一連の動作として実装し、P-02〜P-04へ広げる。P-01だけの完成をAI全体のMVP完成としない。保険を含む対応業務は確認済み機関資料とSource Catalogで限定する。

- 各Playbookは `id/version/jurisdiction/goal/requiredInputs/procedure/postconditions/forbiddenActions/skillRefs/allowedToolIds/ruleRefs/approvalPolicyRefs/evidenceRequirements/escalationConditions` を持つ。
- 自治体・機関ごとの差は適用条件と参照資料で表現する。名称だけ変えたAgentやSkillを量産しない。
- 前提不足なら質問・書類待ちへ移る。根拠不足、資料間の矛盾、本人判断が必要な場合は未解決として返す。
- 「検索できた」だけで完了にしない。回答項目と根拠の対応、適用条件、未確認項目、生成物/承認対象の版を検証する。
- 初期の正式変更は人の承認を要する。Backend ADRで自動適用許可がない状態を維持し、AI側のPlaybookから例外を作らない。
- 開始時に版を固定する。再開時に失効・改定を確認し、影響があれば再検証/新Runで再計画する。古い承認を新しい資料へ流用しない。

## 8. 検索依頼・結果の契約

### ResearchRequest

| 区分 | 必須情報 |
|---|---|
| アプリ付与 | schemaVersion、researchId、parentRunId、attempt、Context版/hash、許可scope、適用Policy、実行上限 |
| コアが提案する内容 | 調査目的、回答すべき項目、対象手続き/機関/地域、必要な前提、完了条件 |

アプリはコアの出力を検証して依頼を構築する。tenant/actor、権限、情報提供先、上限をモデルの自己申告から採用しない。検索語への氏名・住所・番号等の不要な個人情報の混入を防ぐ。

### ResearchResult

- researchId、parentRunId、attempt、入力Context版/hash、開始/終了時刻、使用したSkill/モデルの版。
- 状態: `complete / partial / needs_input / failed / cancelled`。これは調査処理の状態であり、Backend AgentRunやTaskの状態と同一視しない。
- 項目ごとの回答、適用条件、出典IDとの対応。出典はURL、発行機関、ページ名、取得日時、資料更新日（不明ならnull）、該当ページ/箇所、許可された短い抜粋または内容hashを持つ。
- 矛盾する情報、調べても分からなかった項目、追加で必要な入力、失敗分類、消費予算。

出典URLを並べるだけの回答を合格にしない。取得日時と資料の更新日を混同せず、推定更新日や未取得のページを根拠として捏造しない。Schema検証だけで内容の正しさが保証されるとも扱わない。

### 取得・利用条件

- Source Catalogで対象機関・地域・公式ドメイン・資料種別・許可範囲を管理する。検索結果の候補と、回答の根拠として採用できる資料を区別する。
- 検索snippetだけで断定せず、取得可能な元資料を確認する。取得できない場合はその制約を返す。
- 取得ツールはURL・リダイレクト先・サイズ・形式・タイムアウトを検証し、内部ネットワークや認可外の情報源へ到達させない。ログイン代行・ブラウザーによる申請操作は行わない。
- Web/PDF本文は非信頼の資料データとして扱う。本文中の指示をSystem Prompt、Skill、Tool権限へ昇格させない。
- 公開資料の再利用は出典・取得時刻・版とともに行う。個人にひも付く調査結果はCaseを跨いで共有しない。

## 9. ハーネス・Workflow要件

### H-01 Context管理

Backend内部APIからRun scope付き情報を取得し、confirmed/user_reported/extracted_candidate/unknownを区別する。本人意思、禁止事項、訂正・却下履歴、根拠の所属/版、未解決事項を保持する。検索Agentには調査に必要な最小限の背景を渡す。圧縮時には重要事項と参照を残し、省略の範囲を記録する。

### H-02 呼び出しと実行所有権

コアの `requestResearch` をWorkflow管理下で実行する。調査は親AgentRunに属する処理としてresearchIdを持ち、入力・出力・attemptを永続化する。自由なAgent名や任意Promptを公開APIから指定させない。初期構成では検索Agentからの再委任を禁止する。

同じCaseの変更提案区間ではBackendのlease/fencingTokenを使う。待機中はleaseを保持し続けない。調査後・再開後に最新Contextと権限を取り直し、必要な所有権を得てから提案する。

### H-03 Toolと検証

Toolは入力/出力Schema、許可Agent/モード/scope、timeout、最大出力量、監査分類、冪等性、再試行条件を持つ。案件取得、許可資料取得、調査依頼、Proposal提出、進捗/待機/結果報告に限定する。`updateFirestore`、`approve`、`completeTaskDirectly`、任意HTTP/シェル実行はAgentへ渡さない。

親Run取消後・旧attempt・古い入力版の調査結果を無条件採用しない。結果のID/版/権限を検査し、変更の影響がある場合は再調査・再計画する。ProposalがstaleならBackendの検証を回避せず最新Contextからやり直す。

### H-04 予算と失敗

初期上限は設定として管理し、評価に基づく変更を版管理する。

| 対象 | 初期方針 |
|---|---|
| 1実行区間の再計画 | 最大2回 |
| 1実行区間のAgent Tool呼出し | 親子合計20回。再試行も消費に含める |
| 1実行区間の調査依頼 | 最大2件。同時実行は1件 |
| 1調査の検索/資料取得 | 検索6回、取得12回以内。親の残予算を超えない |
| 1推論要求 | 合計3 attempt以内、初期Fallback候補は最大2 Provider |
| 構造化出力の修正要求 | 1回まで。推論attemptの内数 |
| 稼働時間・token・費用 | 有限の値を起動設定に必須化。未設定では当該機能を有効にしない |

親子Agent・Provider SDK・Workflow・Queueで上限を共有し、再試行の掛け算を防ぐ。区間の上限に加え、Run全体の累積token/費用/再試行上限を保持し、再配送・再開で無限に予算をリセットしない。人の回答を待つ時間と実際の稼働時間を分ける。

上限到達時は確認済みの途中結果と残作業を保存して要確認/部分完了を報告する。根拠不足・Rule違反をモデル障害扱いしてFallbackで解決しない。

### H-05 永続化・待機・再開

- Mastraの保存契約を検証したAdapterにより、再開に必要な状態をAI専用runtime領域へ保存する。AIへ業務Firestoreや原本Storageの資格情報を渡さない。
- 会話、正式な回答、Proposal、Approval、AgentRun、業務監査はBackendが所有する。SnapshotやAgent Memoryを業務の正本にしない。
- 書類/利用者の追加情報/承認待ちはBackendのWaitRequest・Outbox/Inboxと対応付ける。先行イベントを捨てず、Snapshotとの照合で一度だけ再開する。
- suspend後の再開と、実行途中のクラッシュからの再試行を区別する。任意の命令位置から復旧できると仮定せず、適用済みActionを照会して安全に再試行する。
- 取消は協調的中断であり確定済み変更を巻き戻さない。同意撤回・権限変更をTool/Step境界と情報配信時に再確認する。

### H-06 出力・観測

受付、調査中、書類待ち、承認待ち、再試行、失敗、要確認、完了を意味の違う状態として報告する。調査の部分完了、承認済み、正式反映済み、申請準備完了、外部申請完了を混同しない。

Run/research/Action ID、Context・Skill・Playbook・Workflow・Rule・モデルの版、Tool結果参照、採用根拠、短い判断理由、時間・token・費用・失敗分類を記録する。秘密情報・原本全文を通常ログへ残さず、非公開の内部思考過程の保存を要求しない。

## 10. Router・モデル接続

- Orch Routerは新規Runの許可経路を選択し、Mastraが実行する。検索の子処理は親の許可経路内で実行し、別の自律ルーターAgentを追加しない。
- Orchは必須Adapter。製品の特定・実呼出し・返答検証・利用証跡をもって接続完了とする。自作switchやFakeへの黙った切替で代替しない。
- 再開では保存済みRouteだけを候補にし、別のWorkflowが必要なら新Runとして再計画する。
- Model Routerは能力、構造化出力、Tool利用、Context量、情報提供Policy等からモデルを選ぶ。コアと検索で別モデルを選択可能だが、モデル数とAgent数は別に扱う。
- 最低2 Providerで障害切替を検証する。Fallback後も同じSchema・Tool権限・同意/データ取扱条件を守る。安全拒否や業務検証拒否の回避には使わない。
- MastraのTool loopと重複する汎用推論ループを外側に実装しない。SDKの具体的な型・保存APIは採用版の公式契約で確認する。

## 11. Backend・フロントとの契約

- 双方向の認証済み内部HTTPを使用し、service identity/audience/有効期限/Run/Case/scope/attemptを検証する。相手サービスのsrc/Repositoryをimportしない。
- `dispatch/resume/cancel`、`context/artifacts/proposals/events/wait-requests/control/heartbeat/result` の役割をアーキテクチャ仕様と内部OpenAPIに合わせる。未実装の型やパスを本書で実装済みと扱わない。
- 調査結果の保存・案内表示・気づきの記録はBackendの検証付き結果受付を通す。検索Agentへ案件全体のBackend Client権限を渡さず、ハーネスが許可された技術的記録を行う。
- 必須同意/外部AI同意とProvider別のデータ提供条件を守る。未検査・拒否・検査失敗の書類は内容もメタデータもAIへ配信しない。許可された加工版を利用する。
- Webの業務通信はBackend公開APIだけ。依頼は202受付とRun参照、回答・進捗は後から取得する。既存画面の機能と導線を維持し、必要な状態表現/DTO変更は公開契約とともに接続する。
- 実行不能・対象外は明示する。AI未接続でもBackendの手動管理は使え、架空回答・気づき・成功履歴を返さない。

## 12. 検証・受入条件

| ID | シナリオ | 合格条件 |
|---|---|---|
| A-01 | AgentとToolの境界 | Agent定義は2つ。検索側や案内モードからProposal/承認/直接書込を実行できない |
| A-02 | P-01の通常調査 | 元資料を取得し、各回答と該当箇所・適用条件を対応付けて案内できる |
| A-03 | 不明・矛盾・資料取得失敗 | 捏造せずpartial/needs_input等で未確認事項と次の確認を返す |
| A-04 | 外部資料の命令 | ページ/PDFの命令でTool権限、Skill、送信先、承認状態が変更されない |
| A-05 | 権限・同意・書類検査 | 別Case/Runの参照、撤回後の情報配信、未検査書類の入力を拒否する |
| A-06 | 調査中の案件訂正・取消 | 古い結果を無条件採用せず、最新Contextで再評価する。旧attemptの結果は拒否する |
| A-07 | P-02の書類整理 | 合成書類の項目・根拠位置・矛盾を抽出し、候補が自動で確認済みにならない |
| A-08 | P-03の提案・反映 | 現行Rule/対象版/根拠を検証し、人の承認を経た結果を確認する。stale・旧fencingTokenを拒否する |
| A-09 | P-04の準備完了 | 指定資料版、必要項目、未解決事項、承認とEvidenceを確認し、外部申請完了と表示しない |
| A-10 | 待機・再起動・先行イベント | プロセス終了後に再開でき、承認が先に届いてもイベントを失わず二重反映しない |
| A-11 | 再送・取消・予算超過 | 重複Actionを適用せず、親子共有上限で停止し、途中結果と残作業を報告する |
| A-12 | 実Router・Provider障害 | Orchの結果が経路に使われ、無効経路を拒否する。2 Provider間の切替で成功済みToolを再実行しない |
| A-13 | Backend/Webとの接続 | 独立プロセス・実HTTPで受付から結果取得まで通り、待機・部分完了・失敗を表示用DTOで区別できる |

### 評価方法

- Schema/Policy/上限は決定的なテスト、サービス間はconsumer/provider契約試験、永続化・再開は統合試験で検証する。
- Skill/Playbookは正常、情報不足、矛盾、古い資料、訂正、越権誘導を含む固定の架空/合成ケースで評価する。同じケースを複数回実行し、成功率と時間・費用を記録する。
- 根拠一致、引用の正確性、重大項目の欠落、確認済み/候補の区別、不要な調査を評価する。LLMの自己採点だけで合格にしない。
- 固定ケースの期待動作をすべて確認し、権限越境・根拠捏造・無承認適用・訂正の無視が1件でもあれば提供を止める。試験合格を現実の全ケースへの無誤り保証としない。
- Fakeによる基盤試験と実Adapter/モデル/Routerの評価を分けて報告する。P-01の段階完了とP-01〜P-04・A-01〜A-13を満たすMVP完了を区別する。

## 13. 実装順序

1. 内部契約・実行scopeを合わせ、Orchの製品確認とMastra Snapshot保存/プロセス終了/再開を技術検証する。
2. Context、Skill Registry、2つのAgent定義、Tool権限、ResearchRequest/Result、共有予算を実装する。
3. P-01を独立Backendと実HTTPで接続し、調査→出典付き回答までを評価する。初期UI受入はチャット/手順案内と進捗取得を対象にする。
4. 書類検査・配信条件を満たした後にP-02、正式確定経路の接続後にP-03を実装する。
5. 対象機関の確認済み資料でP-04を実装し、書類待ち/承認待ち/再起動を跨ぐ一連の動作を検証する。
6. 既存画面への結果接続、障害復旧、Evals、運用設定を確認してMVP完了とする。

配置先は既存アーキテクチャのAI Server内部に従う。agents、skills、playbooks、workflow、tools等は責務を実装するときに作り、空ディレクトリ一式を先に生成しない。

## 14. 提供開始までに必要な選定・検証

| 項目 | 維持する要件 | 有効化に必要な証拠 |
|---|---|---|
| Orch製品 | 必須Adapterと経路制約 | 製品/SDK/版の特定、実呼出しと経路選択の証跡 |
| Mastra/runtime保存 | 永続Snapshot・復旧 | 採用版の保存契約、業務DBと分離された設定、再起動試験 |
| LLM/OCR/検索/取得Adapter | 許可された提供先、入出力契約 | 採用製品・版・利用権限・情報提供条件・実Adapter評価 |
| Source Catalogと対象業務 | 確認済みの機関・地域・適用条件 | P-01の対象手続きとP-04の保険手続きについて資料と業務レビュー |
| 書類検査とマスキング | PASSEDかつ配信可能な版だけ入力 | Backendの検査/同意Policyと配信制御の接続試験 |
| 実行時間・token・費用 | 親子共有の有限上限 | 実行基盤に合わせた設定値、評価結果、上限停止試験 |
| 保持・削除 | 個人情報と実行記録の追跡可能性 | データ種別ごとの保持/削除条件、Snapshot・抽出・ログへの反映 |

未選定の製品名、業務ルール、法的判断を推測で埋めない。該当Adapterを必要としない設計・契約・合成fixtureによる実装は進められるが、該当機能の本番有効化と完成判定は上記の証拠が揃ってから行う。

## 15. 設計思想の参照

CognitionからはContextと意思決定の一貫性、補助的な知的処理を利用しても変更判断を集約する考え方を採る。2エージェント、Proposal、Case lease等の具体構成はafter-flowの設計であり、Devin内部実装の再現ではない。

- [Cognition: Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)
- [Cognition: Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working)
- [Anthropic: Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Anthropic: Agent harnessと評価の定義](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Anthropic: 長期実行のハーネス](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
