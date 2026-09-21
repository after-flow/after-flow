# after-flow AIエージェント：テックブログ執筆資料

- 作成日: 2026-09-21
- 対象: after-flow ハッカソンMVP
- 位置付け: テックブログ本文を書くための技術資料。実装済み・実装中・将来構想を区別する。

## 1. 一文で説明する

after-flowのAIエージェントは、死亡後手続きについて、案件全体を判断するコアエージェントと、公式情報だけを調査する検索・調査エージェントを組み合わせ、AIの出力をBackendの正式な業務状態から分離して扱う構成である。

ハッカソンMVPでは、協会けんぽ「健康保険の埋葬料（費）」について、必要書類・手順・注意点・公式URL・未確認事項を案内する `task_guidance` の1経路に絞る。

## 2. 解こうとしている問題

死亡後手続きでは、制度ごとに提出先、期限、必要書類、適用条件が異なる。家族構成や加入制度によっても必要な対応が変わり、公式情報を見つけただけでは利用者が次に何をすべきか判断しにくい。

一方で、この領域ではAIの回答をそのまま正式な状態変更として扱えない。

- AIが本人の意思、受給資格、相続方法を確定してはいけない
- 古い資料や別地域の制度を根拠にしてはいけない
- 出典があることと、その出典が回答を裏付けることは別である
- 同じ処理が再配送されても、Taskや結果を二重反映してはいけない
- Caseをまたいで個人情報や会話Contextを混ぜてはいけない
- AIや外部Providerが停止しても、正式な業務データを失ってはいけない

このため、自由度の高いチャットボットを作るのではなく、責務、入力、Tool、出力、実行回数を制限した業務エージェントとして設計した。

## 3. なぜ多数のエージェントに分けなかったか

設計の出発点は、Cognitionの設計思想から参考にした「意思決定に必要なContextを分散させすぎない」という考え方である。多数の専門エージェントを並列に動かすと、次の問題が起きやすい。

- どのエージェントが最終判断を持つのか曖昧になる
- エージェント間でContextが欠落または変形する
- 同じ調査やTool呼び出しが重複し、費用と待ち時間が増える
- 障害時に、どこまで処理済みか追跡しにくい
- 個人情報を必要以上の処理へ渡す可能性が増える

そこで、判断を集約するコアエージェントを1つ置き、独立させる価値が高い検索・調査だけを補助エージェントにした。

```text
コアエージェント
  ├─ 案件の前提を整理する
  ├─ 調査が必要か判断する
  ├─ 調査結果を現在のContextと照合する
  └─ 利用者向け案内または確認質問を作る
          |
          | 許可済みのbriefIdだけを委任
          v
検索・調査エージェント
  ├─ 許可された公式情報源を探す
  ├─ 元ページやPDFを確認する
  ├─ 適用条件・更新日・矛盾を整理する
  └─ 根拠付きの構造化結果を返す
```

検索・調査エージェントは、利用者との別会話、案件計画、Proposal、承認、正式状態の変更、さらに別の子エージェントへの委任を行わない。

## 4. システム全体での位置付け

Frontend、Backend、AI Serverは明確に分離する。FrontendはAI Serverを直接呼ばず、すべてBackend公開APIを経由する。

```text
利用者
  |
  v
Frontend
  | Backend Public API
  v
Backend Server
  ├─ ユーザー認証・認可
  ├─ Consent
  ├─ Case / Task / AgentRun
  ├─ 正式な業務状態
  └─ Outbox
       |
       | 認証済み内部HTTP
       v
AI Server
  ├─ OrcaRouter Adapter
  ├─ Mastra Workflow / Agent
  ├─ コアエージェント
  ├─ 検索・調査エージェント
  └─ AI専用Runtime
       |
       | 結果・進捗を内部HTTPで返す
       v
Backend Server
  |
  | Public APIをFrontendがポーリング
  v
利用者へ結果表示
```

AI Serverには業務Firestoreと原本文書Storageの資格情報を渡さない。AIが必要とするContextは、BackendがRun scopeに合わせて最小化し、認証済み内部HTTPで提供する。AIが作った結果や提案もBackendが検証して保存する。

この境界により、AIの推論やProviderを変更しても、認可、同意、正式状態、監査、冪等性の責務はBackendに残る。

## 5. Skill、Playbook、Workflow、Harnessの違い

AIエージェントの構成を説明するときは、次の5つを分けると理解しやすい。

| 要素 | 役割 | after-flowでの例 |
| --- | --- | --- |
| Skill | 再利用できる作業方法 | 公式情報を調べる、根拠を照合する |
| Playbook | 特定業務の目的、手順、禁止事項、完了条件 | 手続き案内、書類レビュー |
| Tool | Agentが実行できる限定操作 | 公式情報検索、許可済み資料取得 |
| Workflow | 分岐、実行順序、待機、再開 | Context取得、調査、結果検証、Backend報告 |
| Harness | Agentを安全に動かす周辺機構の総称 | Context最小化、予算、Schema検証、認証、永続化、観測 |

Promptだけで安全性を担保せず、Toolの登録、委任フック、Schema、Backendの認可を組み合わせることが重要になる。

## 6. 実装したSkill

現在のSkill Catalogには6つのSkillがある。それぞれにID、version、利用できるAgent role、mode、必要なTool capability、指示、参照資料、内容hashを持たせている。

| Skill | Agent | 目的 |
| --- | --- | --- |
| `case-assessment` | コア | 確認済み、本人申告、抽出候補、不明を分けて整理する |
| `research-briefing` | コア | 調査目的と必要項目を限定し、許可済み調査へ委任する |
| `official-source-research` | 検索 | 公式情報源の元資料を確認して根拠を収集する |
| `evidence-reconciliation` | 検索 | 地域、適用条件、更新日、矛盾、未確認事項を照合する |
| `grounded-guidance` | コア | 調査結果をContextと照合して根拠付き案内を作る |
| `change-proposal` | コア | 許可されたモードだけで変更候補をProposalとして整理する |

Mastraの `createSkill` を利用し、独自のSkill実行基盤は作っていない。Skillを読み込んでもAgentのTool権限は増えず、role、mode、capabilityが一致しないSkillはアプリケーション側で拒否する。

MVPの案内モードでは `change-proposal` をコアエージェントに登録しない。自然言語で「変更して」と指示されても、Proposal Toolや正式状態変更Tool自体が存在しない構成にしている。

## 7. Playbookの設計

PlaybookはAgentを増やす代わりに、業務ごとの目的と制約を切り替える仕組みである。

現在は次の4定義がある。

| Playbook | 目的 | 状態 |
| --- | --- | --- |
| `procedure-guidance/v1` | 1つの手続きの必要書類・手順・根拠を案内する | MVP対象 |
| `document-review/v1` | 検査済み書類から候補・矛盾・不足を整理する | 基盤実装あり、MVPでは無効 |
| `case-planning/v1` | Task・順序・依存関係の変更案を作る | Workflow実装あり、MVPでは無効 |
| `insurance-claim-preparation/v1` | 保険手続きのチェックリストと確認資料を準備する | Workflow実装あり、MVPでは無効 |

各Playbookは、必須入力、処理手順、完了条件、禁止事項、利用するSkill、許可capability、Rule参照、承認方針、必要な根拠、エスカレーション条件を持つ。定義がRegistryに存在することと、実行経路として有効であることは区別している。

## 8. Mastraを使っている部分

現在の基盤では `@mastra/core@1.67.0` を利用している。

- `Agent`でコアと検索・調査の2つを定義
- `createSkill`で版付きSkillを登録
- Mastraのsubagent機能で、コアから検索Agentへの限定委任を構成
- delegation hookで委任前後を検証
- `structuredOutput`とZodで調査結果を構造化
- `createWorkflow`と再実行可能なStepで案内、計画、提案待ちを構成
- Workflowの`suspend / resume`とAI専用Firestore Adapterで待機状態を保存
- `maxSteps`で1回の推論ループを制限
- `AbortSignal`で取消を伝播
- Scripted modelを使い、外部APIなしで実際のMastra委任経路をテスト

Mastraを採用した利点は、Agent、Skill、subagent、Tool、構造化出力という共通の実行モデルを利用しながら、業務固有の制約だけをアプリケーション側に実装できる点にある。

独自の無制限な推論ループを作らず、Mastraの標準機能の前後に検証を置く構成にしている。

## 9. 限定委任の実装

コアエージェントから検索・調査エージェントへの委任では、生のPromptや親の会話をそのまま渡さない。

```text
Backendから得た認可済みContext
  |
  v
アプリケーションがResearchBriefを作る
  ├─ briefId
  ├─ 対象手続き
  ├─ 対象機関・地域
  ├─ 回答すべき質問
  └─ 許可されたSource Catalog ID
  |
  v
コアは { "briefId": "..." } だけを選択
  |
  v
delegation hookがIDを検証し、保存済みBriefへ置換
  |
  v
検索Agentへ最小化済みBriefだけを渡す
```

コード上では次の防御を重ねている。

1. 委任Promptは厳密な `{ briefId }` Schemaだけを許可する
2. アプリケーションが事前承認したBrief以外を拒否する
3. 親の会話履歴を `messageFilter` で転送しない
4. 子へ渡る `RequestContext` を消去する
5. `instructions`、`threadId`、`resourceId` の上書きを拒否する
6. 調査依頼は1実行区間で最大2回、同時実行は1回に制限する
7. 検索Agentは子Agentを持たない
8. 検索AgentのToolを公式検索と公式資料取得の2つに限定する

これにより、親Contextに含まれる資格情報や個人情報が、Mastraの標準的なsubagent委任を通じて意図せず検索側へ流れることを防ぐ。

## 10. 調査結果と根拠の検証

検索・調査エージェントは自由文だけを返さず、次の構造を返す。

- 状態: `complete / partial / needs_input / failed`
- 質問IDごとの回答
- 回答に対応するsource ID
- 適用条件
- 未確認事項
- 矛盾

Zodによる形の検証に加え、アプリケーション側で参照整合を検証する。

- ResearchBriefに存在しない質問への回答を拒否する
- 実際に取得できたsource ID以外の引用を拒否する
- `complete`なのに質問が欠けている結果を拒否する
- `complete`なのに未確認事項や矛盾が残る結果を拒否する
- 不完全な状態なのに理由がない結果を拒否する
- 同じ質問への重複回答を拒否する

この検証が保証するのは、取得履歴と出典参照の整合性である。資料の内容が正しいこと、最新であること、回答文が根拠を正しく解釈していることは、別の品質評価が必要になる。

## 11. Backendを正式状態の所有者にする理由

AI Serverは回答やProposalの候補を作るが、Case、Task、Consent、AgentRun、承認、正式な状態遷移を所有しない。

正式な状態変更をBackendへ集約することで、次を決定的なコードとして実装できる。

- ユーザー認証とCase権限
- 外部AI利用Consent
- 業務ルールと状態遷移
- Idempotency keyと重複排除
- Case versionと競合検出
- Outboxによる永続配送
- AI結果のRun、Job、attempt、scope照合
- 人の承認
- 監査記録

AIが停止しても、利用者は保存済みの業務状態を閲覧できる。モデルを交換しても、業務ルールや正式データの所有者は変わらない。

## 12. OrcaRouterの位置付け

このハッカソンではOrcaRouterの利用が必須である。以前の設計資料で使っていた`OrchRouter`は仮称で、実際に接続する製品名はOrcaRouterである。after-flowでは、OrcaRouterをMastraのAgentやPlaybookそのものとして扱わず、許可されたモデル実行経路へ接続する推論ゲートウェイとして位置付けている。

```text
Backendが許可したoperation
  -> AI Serverの実行経路
  -> OrcaRouter Adapter
  -> 許可されたProvider / Model
  -> Mastra Agent / Workflowの結果
```

現在はOpenAI互換APIを利用するAdapter、認可済みモデルPolicy、共有予算、Mastra標準fallback、利用量と`X-Orca-Request-Id`の記録まで実装している。2026-09-21には合成入力を使い、通常応答、日本語stream、Mastra Tool実行、構造化JSONの4項目を実OrcaRouterで確認した。

このsmokeは実ゲートウェイ疎通の証明であり、業務回答の品質やFrontendを含むE2Eの証明ではない。MVPでは、実OrcaRouterの応答が `task_guidance` の最終結果に利用され、その証跡をrunIdと関連付けて確認できることを完了条件にしている。

Mastraのモデル選択機能と、ハッカソン指定のOrcaRouterは別の責務として扱う。独自switchやFakeへの暗黙の切り替えでOrcaRouter利用を代替しない。

## 13. ハッカソンMVPの実行フロー

MVPは1つの手続きを最後まで通す垂直スライスに絞った。

```text
1. 開発用JWTでFrontendを利用
2. fixtureのCaseとTaskを表示
3. 「手順を調べる」を実行
4. BackendがAgentRunとOutboxを保存して202を返す
5. backend-workerがAI Serverへdispatch
6. AI ServerがMastraとOrcaRouterでtask_guidanceを実行
7. AI ServerがBackendへ結果を報告
8. BackendがGuidanceとAgentRunを保存
9. Frontendがポーリングして結果を表示
10. 再読込後も保存済み結果を表示
```

202は受付成功であり、AI処理完了ではない。FrontendはRunの状態と保存済みGuidanceをBackendから取得する。

関連Issue:

- [#89 MVP親Issue](https://github.com/after-flow/after-flow/issues/89)
- [#48 OrcaRouter接続](https://github.com/after-flow/after-flow/issues/48)
- [#65 AI Server受け入れ](https://github.com/after-flow/after-flow/issues/65)
- [#101 Frontend・Backend・AI Server E2E](https://github.com/after-flow/after-flow/issues/101)
- [#122 Backend Outbox Worker](https://github.com/after-flow/after-flow/issues/122)
- [#152 開発用JWTとfixture](https://github.com/after-flow/after-flow/issues/152)

## 14. テストと評価

AIエージェントでは、コードが動くことと、回答品質が十分であることを分けて評価する。

### Agent基盤で確認できるテスト

- Skillのversionとhashが安定している
- role、mode、capabilityが不正なSkillを読み込めない
- 案内モードでProposal Skillを利用できない
- コアと検索Agentが不要なToolを持たない
- 親の秘密情報、個人情報、会話が子Agentへ渡らない
- 未承認Brief、命令上書き、別thread/resource指定を拒否する
- 委任回数が上限を超えない
- 捏造したsource IDをコアへ返さない
- 質問欠落、重複回答、不完全なcomplete結果を拒否する

これらはScripted modelと実際のMastra Agent経路を使うため、外部APIキーなしで再現できる。

このほか、現在のAI Serverには次の自動テストがある。

- 認証済み内部HTTPのdispatch、resume、重複受付、未接続時のfail closed
- AI専用Firestoreへのreceipt、暗号化dispatch、snapshot保存
- プロセス終了後のWorkflow再開と、完了済みStepの非再実行
- Provider Policy、grant、共有token・費用予算、fallback条件
- 公式Source Catalog、HTML/PDF取得、URL・redirect・サイズ制限
- procedure guidance、planning、chat、document review、insurance preparation
- fixture datasetとscorerによる回答品質の回帰比較

### MVPで追加する評価

| 層 | 確認内容 |
| --- | --- |
| Unit / Contract | Schema、Skill権限、委任制約、出典ID、重複排除 |
| Integration | Backend WorkerからAI Serverへの実配送と、Backendへの結果保存 |
| Real provider | 実装・smoke済みのOrcaRouter経路をrunIdと結び付ける |
| Browser E2E | Frontendから実行し、進捗、結果、再読込、失敗を確認 |
| Answer quality | 必要書類、手順、適用条件、公式URL、未確認事項の正確性 |

回答品質では、単一の総合点だけを使わない。少なくとも次を別々に見る。

- 根拠の正しさ
- 回答項目と出典の対応
- 必要項目の網羅性
- 適用条件の明示
- 不明な点を断定しないこと
- 別Caseの情報混入がないこと
- latency、token、費用

## 15. 現在の実装状況

2026-09-21時点で、ソースコードから確認できる範囲を示す。

### 実装済み

- HonoによるAI Serverプロセス、liveness、readiness、dispatch、resume API
- Mastraのコアエージェントと検索・調査エージェントのFactory
- 6つのSkill CatalogとMastra Skill登録
- Playbook定義とprocedure guidance、planning、chat等のMastra Workflow
- ResearchBriefとResearchFindingsのZod Schema
- briefIdだけを使う限定委任
- 親会話とRequestContextを遮断するdelegation hook
- 調査回数、同時実行、max stepsの制限
- 取得済みsource IDとの参照整合検証
- Backend内部API Clientと認証済み実行Host
- AI専用Firestoreのreceipt、暗号化dispatch、Workflow snapshot
- Worker、重複排除、取消、待機・再開、再起動復旧
- 協会けんぽ向けのレビュー済みSource Catalog
- Catalog内検索と安全なHTML/PDF取得
- OrcaRouter Adapter、認可済みモデルPolicy、予算、メトリクス
- 実OrcaRouterによる4項目のsmoke確認
- Scripted model、Firestore Emulator、fixture評価を使ったテスト

### MVPで実装中

- Backend Outbox Workerを通常のDocker起動へ接続する
- Backendの開発用JWT、Consent、Case、Task fixtureを用意する
- OrcaRouter利用証跡をBackendのrunIdと結び付ける
- `task_guidance`のBackend保存結果をFrontendへ表示する
- Frontendを含むE2E

### MVP対象外

- OCRと書類内容抽出
- 申請書・成果物生成
- 複数手続きへの対応拡大
- 定期的な気づき生成
- 手続き計画・再計画
- 大規模な性能・費用評価
- 本番認証・本番デプロイ

`/internal/v1/health` はプロセスの生存確認だけである。実行compositionの状態は`/internal/v1/ready`で分けて確認し、最終的な利用可能性はBackend WorkerとFrontendを含むE2Eで判断する。

## 16. テックブログで扱いやすい技術的な見どころ

### 見どころ1: マルチエージェントを目的にしなかった

「何体のAgentを作ったか」ではなく、Contextを保持する判断主体を1つにし、独立性とTool差が明確な調査だけを分離した点を説明できる。

### 見どころ2: Promptではなく実行経路で権限を制限した

禁止事項をSystem Promptへ書くだけでなく、Skill解決、Tool登録、delegation hook、Zod Schema、Backend認可の各層で拒否する構成を紹介できる。

### 見どころ3: 子Agentへ親会話を渡さない

便利なsubagent委任は、親の会話やContextを必要以上に渡す危険がある。after-flowでは許可済みbriefIdだけを選ばせ、アプリケーションが最小化済みBriefへ置換する。

### 見どころ4: AIを業務データの所有者にしない

AI Serverから業務Firestoreを切り離し、認証、Consent、正式状態、重複排除をBackendへ残した。AI機能が停止しても業務データを閲覧できる構造になっている。

### 見どころ5: ハッカソンでも垂直スライスを選んだ

多数の機能を薄く作る代わりに、1つの手続きについてFrontendから実OrcaRouterまでを通す。Fakeデモと実接続を受け入れ記録で区別する。

## 17. 記事構成案

1. 死亡後手続きでAIを使う難しさ
2. 最初に考えた構成と、Agentを増やさなかった理由
3. コア＋検索・調査の2エージェント構成
4. Skill、Playbook、Workflow、Harnessの役割
5. Mastraの標準機能を使った限定委任
6. briefId方式によるContext最小化
7. Backend authorityとFrontendからのE2E
8. OrcaRouterを実行経路へ組み込む方法
9. テストで確認したことと、まだ確認できていないこと
10. ハッカソンMVPで得た知見と今後の課題

## 18. 記事公開前に取得する材料

- `task_guidance`を実行するFrontend画面
- AgentRunがQUEUEDからSUCCEEDEDへ変わる様子
- 必要書類、注意点、公式URL、未確認事項の結果画面
- runIdと`X-Orca-Request-Id`を関連付けた秘密情報を含まないtrace
- backend-worker停止・再起動後に処理が再開する記録
- Mastraのコアから検索Agentへ委任したtrace
- Fake model試験と実OrcaRouter試験を区別した実行結果
- 最終的なテスト件数、実行時間、代表的な失敗例
- 実際に採用したモデル、選定理由、token・費用。公開可能な範囲だけ記載する

個人情報、API key、service token、署名、Execution Authorization、完全なContext、モデルの非公開思考過程は記事やスクリーンショットへ載せない。

## 19. 記事で避ける表現

- healthが成功しただけで「AIエージェントが稼働した」と書かない
- Playbook定義があるだけで「4業務に対応済み」と書かない
- fixture modelの成功を「実LLMで精度を確認済み」と書かない
- source ID検証を「回答内容の正しさを保証する」と書かない
- OrcaRouterの環境変数設定や単体smokeだけで「業務E2E完了」と書かない
- 202受付を「AI処理完了」と書かない
- AIが申請、承認、Task完了を自動実行すると書かない
- CognitionまたはDevinの内部実装を再現したと書かない

## 20. 参照先

- [全体アーキテクチャ](architecture.md)
- [AIエージェント構成](agent-architecture.md)
- [AI Server要件](../apps/ai-server/REQUIREMENTS.md)
- [AI Server実装方針](../apps/ai-server/IMPLEMENTATION.md)
- [AI Server実装状況](../apps/ai-server/IMPLEMENTATION_STATUS.md)
- [AI Serviceの組み立て](../apps/ai-server/COMPOSITION.md)
- [OrcaRouter接続](../apps/ai-server/ORCAROUTER.md)
- [手続き案内Workflow](../apps/ai-server/PROCEDURE_GUIDANCE.md)
- [Backend内部実行API](api/internal-execution.md)
- [実行制御ADR](adr/0003-execution-control.md)
- [確定経路ADR](adr/0004-confirmation-path.md)
- [Outbox Worker Runbook](runbooks/outbox-worker.md)
- [コア・検索Agent実装](../apps/ai-server/src/infrastructure/mastra/agents/guidance-agents.ts)
- [Skill Catalog](../apps/ai-server/src/orchestration/skills/catalog.ts)
- [Playbook Registry](../apps/ai-server/src/orchestration/playbooks/registry.ts)
- [調査契約](../apps/ai-server/src/orchestration/research/contracts.ts)
- [Agent基盤テスト](../apps/ai-server/test/agent-foundation.test.ts)
