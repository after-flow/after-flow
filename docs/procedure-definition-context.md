# ProcedureDefinition と案内 Context の投影

`task_guidance` の AI へ Case 全体や Task 全体を渡す構造を、手続きごとに必要な Context だけを投影する構造へ変更した設計と実装の記録。

## 1. 位置づけ

Backend の手続きカタログ（`apps/backend-server/src/domain/task/rule-catalog.ts`、27 手続き、条件 DSL による出し分け、variants、期限ルール、必要書類）は「どの Task をどの Case に作るか」を決める。ここへ新たに **ProcedureDefinition**（`packages/internal-contracts/src/procedure-definitions.ts`）を置き、「その手続きの案内を作るために、Case のどの Fact を AI へ渡してよいか、何を公式情報源で調べるか」だけを持たせる。

| 責務 | 置き場所 | 内容 |
| --- | --- | --- |
| 手続きの候補化・出し分け・期限・必要書類・variants | Backend `InitialProcedure`（条件 DSL 付きカタログ） | 専門職レビューの対象物。今回は `dependencyProcedureIds` を追加しただけ |
| 案内 Context の allowlist・調査範囲・レビュー状態 | 共有 `ProcedureDefinition` | `guidance.requiredContext / optionalContext / researchScope / questions`、`version`、`reviewStatus` |
| Case 固有の進捗・担当・状態・証跡 | `TaskEntity` | `procedureId` で両者を参照する |

`Task.procedureId` が両者を結ぶ安定 ID。Definition の `id` は Backend カタログの手続き ID と同じ名前空間（27 件すべてに Definition がある）で、加えて AI 計画テンプレート用の `kyoukaikenpo-burial-benefit`、カタログ外の `cremation-permit` / `inheritance-renunciation` を持つ。

## 2. Context 生成フロー

```text
Task.procedureId
  → findProcedureDefinition
  → guidance.requiredContext / optionalContext を allowlist（group.field）にする
  → Backend: projectGuidanceContext で Case / profile / 関係者・財産等を投影し、procedure {id, version, reviewStatus} と共に配信
  → AI: 受信内容へ同じ projectGuidanceContext を再適用（Default deny）し、fact を作る
  → 必須 Context 不足 → 確認質問（needs_input）。推測しない
  → Research Brief は Definition の researchScope + questions、または procedureId が一致する審査済み scope からだけ作る
```

Context group は `case / profile / persons / relationships / assets / liabilities / contracts / benefits / decisions / deadlines`。`profile` は Backend の `Case.profile`（健康保険・年金・職業・不動産・自動車・住宅ローンの区分）で、カタログの出し分け条件と同じ情報源。氏名・自由文（`name` / `note` / `summary` / `deceasedName` / `body`）はどの group でも allowlist に載せられない（`contextRequirementSchema` が `CONTEXT_FIELDS` 外の field を拒否する）。

投影のとき、`confirmation`（財産・債務・期限）、`state` / `personId`（Decision）、`fromPersonId` / `toPersonId`（関係）は `STRUCTURAL_FIELDS` として常に同伴させ、未確認情報の出自を失わない。

## 3. Excel 案からの変更点

| 項目 | Excel 案 | 採用 | 理由 |
| --- | --- | --- | --- |
| Definition の範囲 | 手続きの設計図全体（applicability・依存・必要書類・期限・運用属性を含む） | 案内 Context の投影層に限定 | Backend に条件 DSL 付きの手続きカタログ（27 件、専門職レビュー対象）が既にあり、二重管理を避ける。候補化・variants・期限・必要書類はカタログが持つ |
| `dependencyProcedureIds` | Definition | Backend `InitialProcedure` の任意項目。洗い出し時に `resolveDependencyTaskIds`（共有）で Case 内 Task ID へ解決 | 依存は Task 生成の責務。常に生成される（always）手続きだけを指せるようカタログ検証で制限 |
| `ContextGroup` | case / persons / … / documents / income | 既存 9 group + `profile` | Backend Fact に存在する項目だけを扱う。`lastAddress` / `registeredDomicile` / `registrationLocation` / `assessedValue` / `allocation` / `income.*` / `documents.willType` は Entity に無いので除外し、管轄は `case.municipality`、取得合意は `decisions.method` で代替 |
| 手続き ID | Excel 独自 | Backend カタログの ID（例: `estate-division`、`bank-accounts`、`final-income-tax-return`、`life-insurance-check`） | Task.procedureId と一致させる |
| `reviewStatus` | 例は reviewed | `kyoukaikenpo-burial-benefit` のみ reviewed、他は draft | レビュー済みの根拠があるのは既存ハッカソン設定と一致する 1 件だけ。非本番は `allowDraftDefinitions` で案内可、本番は fail-closed |
| 必須 Context の粒度 | 相続方法検討・相続税申告で財産・債務・Decision を required | 手続き開始時点で必ず存在する項目だけ required、決める前に欠けうる項目は optional | required は entity 0 件でも欠落扱いになり、案内が永久に `needs_input` になるのを避ける |
| 算出済み期限 | 必要時に渡す | `deadlines.dueDate` を期限のある手続きの optional に置き、対象 Task の期限だけ投影 | `deadlineRuleId`（カタログ）と算出値（`DeadlineEntity`）の分離を保つ |
| 審査済み調査 scope | Definition の researchScope のみ | `procedureId` が一致する審査済み scope（詳細な問い・grounding 規則・適用条件）を優先し、無ければ Definition の researchScope | 既存の根拠照合（#162 / #163 相当）を維持する |

## 4. Backend

- `application/agent/internal-execution-service.ts`：`task_guidance` の Context を `Task.procedureId → Definition → projectGuidanceContext` で作る。未マッピング Task は `procedure: null` と Case / Task の識別子だけ。`rejectDraftDefinitions`（本番で true）なら `reviewStatus !== 'reviewed'` を `PROCEDURE_NOT_REVIEWED` で拒否。`case_planning` / `chat_reply` の Case からも `deceasedName` を外し、Task の `summary` を外し `procedureId` を加える。Artifact 作成と同じ Transaction で監査 `agent_run.context_projected`（procedureId / version / contextKeys / missingRequiredKeys / droppedKeys。値は含めない）を残す。planningHistory に `targetProcedureId` を載せる。
- `domain/task/rule-engine.ts` / `procedure-sync.ts` / `infrastructure/rules/rule-config.ts`：`InitialProcedure.dependencyProcedureIds`（任意）。洗い出しで Task ID に解決し、カタログ検証で存在・自己参照・always 以外への依存を拒否。カタログでは `estate-division → collect-family-register, inheritance-choice`、`bank-accounts → inheritance-choice`。
- `application/task/task-service.ts` / `presentation/schemas/task.ts` / `packages/public-contracts`：手動作成・更新に任意 `procedureId`（Definition に無い ID は 400、更新は null で解除）。DTO に `procedureId`。OpenAPI を再生成。
- `application/proposal/task-applier.ts`：提案 payload の任意 `procedureId` を検証して Task に設定。承認済み payload の他の内容は作り替えない。
- `application/agent/insight-events.ts`：Task の `summary` を要求しない。

## 5. AI サーバー

- `orchestration/context/builder.ts`：`procedure` を受け取り、`task_guidance` の fact を Definition 投影の出力だけから作る（`CoreContext.procedure` に定義・使用 key・不足・落とした key）。`PROCEDURE_MISMATCH`（未知 ID・版不一致）、`PROCEDURE_NOT_REVIEWED`。`minimizedModelInput` は投影結果そのもの。`reviewedResearchScopeSchema` の `taskTitles` / `taskCategories` を廃止し `procedureId` を追加、`buildResearchBrief` は chat / planning 用（municipality 照合のみ）。`buildProcedureResearchBrief` が task_guidance 用。planning / chat の allowlist からも `deceasedName` を外す。
- `workflows/procedure-guidance.ts`：`buildProcedureResearchBrief` を使い、`target` は Definition の title。適用条件・grounding 規則は procedureId が一致する scope のものだけ。`allowDraftDefinitions`、`recordContextAudit`（key のみ）。
- `playbooks/planning-output.ts`：テンプレートに `procedureId`（Definition に存在すること）。既存 Task の重複判定は `procedureId` 一致、`procedureId` を持たない Task にだけ表示名・提出先の一致を暫定 fallback。過去提案は `targetProcedureId`（null なら表示名）。payload に `procedureId`。
- `execution/composition.ts` / `hackathon-config.ts`：`allowDraftDefinitions`（本番で true なら起動拒否）、テンプレートの `procedureId` と `submitTo` を Definition と照合、監査を構造化ログ `ai_guidance_context` へ。

## 6. Context の変化（`task_guidance`）

| 区分 | 変更前 | 変更後 |
| --- | --- | --- |
| case | deceasedName, dateOfDeath, knownAt, municipality, status | Definition の allowlist のみ（死亡届: municipality, knownAt。協会けんぽ: なし） |
| profile | なし | Definition が要求する区分のみ（例: 健康保険の資格喪失は healthInsurance だけ） |
| task | title, summary, status, stage, category, submitTo, source, dependencyTaskIds, requiredDocuments, evidenceRequired, assetDisposal, conditional | id, version, procedureId（AI 側では fact にしない） |
| 関係者・財産等 | なし | Definition が要求する group のみ。name / note は常に除外 |
| documents | requiredDocuments に紐付く書類 | なし |
| Research Brief | 審査済み scope + Task の title / category / submitTo 照合 | procedureId が一致する審査済み scope、または Definition の researchScope + questions |
| 監査 | なし | Backend `agent_run.context_projected`、AI `ai_guidance_context`（key のみ） |

`chat_reply` / `case_planning` は `deceasedName` と Task の `summary` を渡さなくなった。他は従来どおり。

## 7. 後方互換

- 既存 Task の `procedureId` は変更しない。null は未マッピングとして扱い、AI は「案内定義に未対応」の `needs_input` を返す。推測で紐付けない。
- カタログ由来の Task は元から `procedureId` を持つため、27 手続きの案内は Definition 経由になる。AI 提案由来・手動 Task は `procedureId` を付けたときだけ Definition 経由になる。
- `EXISTING_TASK` 判定は `procedureId` 一致を主とし、`procedureId: null` の Task に限り表示名一致を暫定 fallback として残す。識別（投影・Brief 生成）には使わない。
- 一括移行ツールは作っていない。手動 Task は API から `procedureId` を付け直せる。

## 8. 残課題

- 11 手続き以上の `reviewStatus` が `draft`。業務レビュー後に `reviewed` へ昇格するまで、本番ではカタログ由来 Task の AI 案内が `PROCEDURE_NOT_REVIEWED` で止まる（意図した fail-closed）。
- ハッカソン構成では協会けんぽに加え、年金4手続き、相続方法・相続放棄、準確定申告、相続税、相続登記を審査済み公式カタログへ接続した。その他は `sourceCatalogIds` が空で、「公式情報源が未設定」の `needs_input` になる。
- `case.lastAddress` 等の Entity 項目追加後に requiredContext へ戻す。
- `case_planning` の Context は `deceasedName` / `summary` を外した以外は従来の範囲。Definition 単位の絞り込みは未着手。
- `dependencyProcedureIds` は 2 手続きにだけ設定した。他の順序関係は専門職レビューで追加する。
