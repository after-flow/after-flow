# AI Server 実装と引継ぎ

対象: #46 / #52 の基盤、#49 のHTTP、#51 のContext、#55 / #56 / #59 の案内機能。機能全体の完成や本番提供開始を示さない。

PR順序: [基盤 #78](https://github.com/mimish0778/after-flow/pull/78) → [内部HTTP #80](https://github.com/mimish0778/after-flow/pull/80) → [Context #81](https://github.com/mimish0778/after-flow/pull/81) → P-01案内Workflow。
詳細は [内部HTTP](INTERNAL_HTTP.md)、[Context](CONTEXT.md)、[P-01](PROCEDURE_GUIDANCE.md)。後続PRは直前のブランチを比較先にする。

## 採用する基盤

`@mastra/core@1.67.0`、Node.js 22.23.2、strict TypeScriptを固定する。
通常のMastra Agent + Workflowを採用する。ベータのDurable Agentsは現時点では採用しない。
通常Agentの呼出し自体に再起動耐性はない。WorkflowのFirestore保存・待機後の別プロセス再開を実装した。設計・制約は [ADR 0001](docs/adr/0001-runtime-storage.md)。HTTP Workerへの接続は #57 で実装する。
Firestore runtime専用領域の要件を無断で別DBへ変更しない。利用可能な公式Storage Adapterと適合しない場合はADRで判断する。

| 機能 | Mastra標準 | after-flow固有の責務 |
|---|---|---|
| Agent実行 | Agent / generate / stream | コアと検索の2役、権限モード |
| Skill | createSkill / skills / getSkill / Skill Tools | 6 Skillの内容、role・mode・必要能力の検証、版/hash |
| 委任 | agents / delegation hooks | 許可済みbriefId、会話遮断、Context削除、結果の出典参照検証 |
| 型付き結果 | structuredOutput + Zod | ResearchFindingsの必須項目と未解決状態 |
| 業務手順 | Workflow（今後） | 4 Playbookの目的・前提・禁止事項・完了条件 |
| モデル選択 | モデル接続・Fallback（今後） | 同意、提供先、予算、失敗分類 |
| 保存・待機 | Workflow snapshot / suspend / resume（今後） | Backend WaitRequestとの照合、再配送・所有権 |
| 計測・評価 | Tracing / Scorers / Datasets / Experiments（今後） | PII除去、正解根拠、基準、人による評価校正 |
| 正式業務状態 | 対象外 | Backendが認可・Proposal検証・承認・正式反映を所有 |
| OrchRouter | Mastraのモデルルーターとは別 | ハッカソン指定製品の確認・実接続が必須 |

公式参照: [Skills](https://mastra.ai/docs/skills)、[Subagents](https://mastra.ai/docs/subagents)、[Durable Agents](https://mastra.ai/docs/harness/durable-agents)、[Workflowの待機・再開](https://mastra.ai/docs/workflows/suspend-and-resume)。採用版の型定義と実行テストを併せて確認する。

## 今回の構成

```text
Hono /internal/v1/health       生存確認のみ（接続済みの意味ではない）

createGuidanceAgents           実行区間ごとに生成。HTTPには未接続
  +-- coreAgent               案内専用。変更・承認Toolを持たない
  |     +-- 必須の3 Skill
  |     +-- Mastra標準の限定委任
  |           prompt = { briefId }
  |           アプリの許可済み調査依頼に置換
  |           親の会話を転送しない / RequestContextを消去
  +-- researchAgent           子Agentを持たない
        +-- 必須の2 Skill
        +-- searchOfficialSources / readOfficialSource（実Adapterは未接続）
        +-- 構造化結果 -> 問い・取得済み出典IDを照合 -> コアへ返却

orchestration/skills           6 Skillの許可条件・内容・版/hash
orchestration/playbooks        4 Playbookの業務定義（実行Workflowではない）
orchestration/research         最小化された依頼・調査結果のSchema
```

- `createGuidanceAgents` は構成用Factory。外部からAgentやToolを指定するAPIではない。信頼済みcomposition rootだけで使用する。
- `briefs` はContext層が認可・個人情報の最小化を済ませた入力。Zodの文字列検証をPII検出とみなさない。コアは許可済みIDを選ぶだけで、生の案件情報を子へ書き込めない。
- コア・検索ともMemory、Workspace、任意HTTP、Shell、Approval、Proposal Toolは未登録。Skillの読込で権限は増えない。
- フック例外は `hookErrorStrategy: 'throw'` で拒否する。Mastraの既定動作に依存して親の全会話を子へ流さない。
- 必須Skillは標準Skill定義の本文をSystem指示に適用する。参照資料や明示的な読込には標準Skill Toolsを使用する。独自推論ループは作らない。
- 調査依頼は区間内2回・同時1回まで。これはRun全体の永続予算ではない。Tool回数・時間・token・費用の親子共有、再起動後の引継ぎは #57 で実装する。
- 出典ID検証は取得履歴との参照整合だけを確認する。引用内容の正しさや情報の鮮度は #68 の評価とContextの再検証が必要。
- 型付き結果のID/attempt/Context proof/時刻はハーネス側で付与する。モデルの自己申告を正式な実行情報として採用しない。

## Devinへの着手順

`Devin`は担当適性のラベルであり、着手可能のラベルではない。全体完成を待つ必要はないが、前提の変更を共有したブランチ/PRが必要。ローカルだけの変更をDevinが取得できるとは扱わない。

| Issue | 着手条件と担当範囲 |
|---|---|
| #49 内部HTTP | 最初の候補。#46 の基盤を共有後、完了済み #36 の契約からClient/認証/受付を実装。Context/判断/Skillは変更しない |
| #48 Orch Adapter | #47 で製品URL・SDK・認証・利用条件を特定した後。類似製品やFakeで代用しない |
| #54 モデル接続 | #53 のProvider・能力・データ取扱条件を決定した後。Agent判断を変更しない |
| #57 永続実行 | #50 の保存検証、#49、#56、Backend #37/#38 が揃った後。早期の丸投げは避ける |
| #60 Proposal連携 | #49/#51/#56/#57 とBackend #41 が揃った後。生成判断・承認Ruleを変更しない |
| #67 評価基盤 | #66 のデータ形式・正解根拠・合格基準と #49 が揃った後 |
| #69〜#72 試験・計測・CI | 各Issueの対象実装・評価基準が揃ったものから順番に着手 |
| #65 最終統合 | 機能・評価・Backend接続が揃った後 |

#49 の受付は、まだ永続Workerを接続できない状態で202成功を返したり、HTTP終了後に未管理PromiseでAgentを起動したりしない。明示的な未提供応答と、認証/Schema/Clientのテストを先行できる。#37 によるresume/cancel契約の変更は共有契約と照合する。

## 検証と残作業

`pnpm --filter @aftercare/ai-server test` は外部通信・APIキー不要の合成fixture試験。
Mastra本体を使ってSkillの読込、限定委任、構造化結果、不正Prompt/権限指定の拒否、出典ID検証を確認する。
fixtureモデルの成功は実LLMの回答品質・本番接続の成功を意味しない。

実装済み: Backend Clientと認証付きIngress、Context構築、P-01の調査・案内・鮮度検証・結果報告Workflow。合成fixtureで検証する。
未接続: 実Orch/Provider/検索取得Adapter、レビュー済みSource Catalog、永続Runtime、累積予算、実Backendとの通し試験、P-02〜P-04、品質/性能評価。
HTTPの実行受付はRuntime未設定のため503。UI・Dockerは変更しない。Issue #55/#56/#59 やMVP全体は未完了のままとする。

## レビュー対応: 内部通信と単体検証

BackendClientはHTTPSを既定とします。ローカルDockerのHTTPには、信頼済みcomposition rootから`allowInsecureHttp: true`と`insecureHttpAllowedHosts: ['backend-server']`の両方を明示します。ホストは完全一致で照合し、モデル入力から変更させません。クラウド接続ではHTTPSを使用します。
AI単体の`build`/`typecheck`も内部共有契約を先にbuildするため、clean checkoutで実行できます。テストは`src`のHTTP生存確認と`test`の基盤・内部HTTPの両方を実行します。

Contextの確認区分はフィールド単位で決めます。Case/Taskの状態や段階、Decisionの状態、確認状態そのものなどBackend管理の記録は`confirmed`、Caseの申告項目は`user_reported`、出自のない説明や未確認の金額は`unknown`です。Decisionの`state`が正式な記録でも、その`method`を本人確定扱いにはしません。正式なTask状態は外部機関の受理確認とは区別します。


P-01の調査結果はモデル会話とは別にハーネスが記録し、Workflowの型付きStep出力に保持します。完了報告時には、全ての許可済み調査依頼について検証済みcomplete結果があり、全必須questionを回答し、missing/conflictsがないことを再検証します。調査未実行・中断・failed・partial・needs_input、無効な調査結果はコアがcompleteを返しても完了報告を拒否します。モデルの出典IDが取得済みであることだけでは完了条件を満たしません。
