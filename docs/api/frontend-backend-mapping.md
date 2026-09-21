# 既存フロントエンド機能と公開APIの対応表（Issue #3）

実装済みHTTP契約の正本は [public-openapi.yaml](public-openapi.yaml) と、それを生成する Backend の route spec です。本書は移行対応表であり、APIが未接続の機能を提供済みとは扱いません。人物・財産・契約・Insight は PR #30–#33 の Firestore 統合版を前提にしています。

本書は `apps/web` が現在 MSW（`apps/web/src/mocks/handlers.ts`）に対して行っている HTTP 呼び出しと画面操作を棚卸しし、Backend 公開API（`docs/architecture.md` 6章）への対応、担当Issue、移行方針、受入シナリオを確定する。**フロントエンドのコードはこのIssueでは変更しない。** ここに書かれた契約に合わせる作業は各担当Issue、およびフロント側の接続切替Issueで行う。

凡例:

- `C` = `/api/v1/cases/:caseId`
- 「現行」= MSW handler と `apps/web/src/lib/api/queries.ts` の現在の呼び出し
- 「移行」= `同一` そのまま / `Case配下へ` パスをCaseスコープに変更 / `Commandへ` PATCHによる状態変更を明示Commandへ分離 / `新設` 現行に対応がない
- 権限は Case membership の role（OWNER / EDITOR / VIEWER）。VIEWER は共有業務情報の変更不可。ただし本人の Insight 閲覧状態、紐付いた本人の意思確定は可能。人物の `PROFESSIONAL` は続柄・属性であって権限ではない。
- 共通仕様（封筒、`Idempotency-Key`、`expectedVersion`、カーソル、エラーコード）は 6.1 節に従い、本書では差分だけ書く。

## 1. 共通規約の確定事項

| 項目 | 決定 | 現行フロントとの差 |
|---|---|---|
| 成功封筒 | `{ data, meta: { requestId, nextCursor? } }` | MSWは `{ data, meta }` を返しており一致。`Paginated<T>` は `data: T[]` + `meta.nextCursor` |
| 失敗封筒 | `{ error: { code, message, retryable, details? }, meta: { requestId } }` | MSWは `{ error: { code, message } }` のみ。`retryable` を追加 |
| 一覧 | `?cursor=&limit=`（既定50、上限100） | 現行は全件返却。ページングはフロントが後で対応 |
| 書き込み | `Idempotency-Key` 必須（無い場合 428 `PRECONDITION_REQUIRED`）。同キー同payloadは前回結果、同キー別payloadは 409 `IDEMPOTENCY_KEY_REUSED` | 現行は未送信。フロント接続時に `api` クライアントで自動付与する |
| 版 | 版付き更新は body に `expectedVersion` 必須（欠落は428）。新規登録・同意・Insight閲覧状態などの例外は各route spec参照。不一致は 409 `CONFLICT` | 版付きのAPIリソースDTOを使用する。`Partial<T>` を丸ごと送る現行 PATCH は、Command化後は許可フィールドだけになる |
| 出所 | `source` / `agentRunId` / `confirmation` / `status` 等のサーバー決定値は公開APIの body で受け付けない（strict schema、400 `VALIDATION_FAILED`） | 現行MSWは何でも上書き可能 |
| identity | tenant / actor は認証から導出。body の `caseId`, `tenantId`, `userId` は拒否 | — |
| HTTPコード | 400 入力不正 / 401 未認証 / 403 role不足・同意不足 / 404 membershipなし・Case外の参照 / 409 版・遷移・重複 / 428 必須条件欠落 / 501 `FEATURE_NOT_CONNECTED` / 503 `UNAVAILABLE`。認証未設定は401 | — |

## 2. 認証・同意

認証はFirebase Authentication（[ADR 0001](../adr/0001-authentication-provider.md)）。Firebase Client SDKが取得した
ID tokenを `Authorization: Bearer` で送る。ローカルは Firebase Auth Emulator（`docker/firebase-auth-emulator/`、
[docs/runbooks/local-swagger.md](../runbooks/local-swagger.md)）。tenantはFirebaseのcustom claimではなく配備単位の
設定値（`AUTH_TENANT_ID`）で固定し、Backendが`tenants/{AUTH_TENANT_ID}/members/{uid}`のmembershipで裏取りする。

利用者登録（初回のtenant membership付与）はFEの自動登録ではなく、明示的な `POST /me` を経路にする
（ADR 0001 §2「所属・権限の付与と変更はBackendが制御する」）。

| 現行 | 画面操作 | 公開API | 移行 | 担当 |
|---|---|---|---|---|
| `POST /auth/login` | ログイン | 公開APIでは提供しない。Firebase Client SDKでサインインし、取得したID tokenを `Authorization: Bearer` で送る | 廃止 | #6 / U1a |
| （新設） | サインイン直後の登録確認 | `GET /api/v1/me` → `{ data: MeResource }`（`registered`/`active`/`emailVerified`を返す。書き込みなし） | 新設 | U1a |
| （新設） | 利用者登録 | `POST /api/v1/me` → 201（新規）/200（登録済み）`{ data: MeResource }`。`active:false` は 403 `FORBIDDEN`（`details.reason:'MEMBERSHIP_INACTIVE'`）。tenant membershipが無い状態で他のAPIを呼ぶと 403 `FORBIDDEN`（`details.reason:'NOT_REGISTERED'`, `details.availableOperations:['getMe','registerMe']`） | 新設 | U1a |
| `GET /consents` | 同意状態表示 | `GET /api/v1/consents` → `{ data: ConsentStatus }` | 同一 | #12 |
| `POST /consents` | 同意 | `POST /api/v1/consents` body `{ agreements: { kind, version }[] }`。古い版の同意は 409 `CONFLICT` | 同一 | #12 |

外部AI利用可否は同意版からサーバーが判定し、フロントは `ConsentStatusResource.availability.externalAi`を表示にのみ使う。

メール確認（ADR 0001 §1）はBackendが唯一の判定者。FEは自前で`emailVerified`を見て遮断せず、Backendの
403 `FORBIDDEN`（`details.reason:'EMAIL_NOT_VERIFIED'`）を受けて `/verify-email` へ送る。ローカルの既定
（`AUTH_REQUIRE_EMAIL_VERIFIED=false`）ではこの確認を必須にしない。

ログイン維持は最長7日間（ADR 0001 §4）。Backendは`auth_time`から上限を検証し、超過は 401
（`details.reason:'SESSION_EXPIRED'`）。失効・停止確認（ADR 0001 §5）は未対応で、readinessに
`session_revocation: SESSION_REVOCATION_NOT_ENFORCED`として現れる（[docs/runbooks/readiness.md](../runbooks/readiness.md)）。

## 3. Case・ダッシュボード

| 現行 | 画面操作 | 公開API | 移行 | 担当 |
|---|---|---|---|---|
| `GET /cases` | Case一覧 | `GET /api/v1/cases`（membership を持つ Case のみ） | 同一 | #7 |
| `POST /cases` | Case作成 | `POST /api/v1/cases` body `{ deceasedName, dateOfDeath, ownerName, relationshipToDeceased, knownAt?, municipality?, ownerPerson? }` → 201。作成者は OWNER。`ownerPerson: { isHeir }` を指定すると作成者本人を Person として同時登録し `ownerPersonId`/`selfPersonId` に紐付ける（指定時は `POST /cases/:caseId/persons` への本人の2回目の登録は不要・二重登録になるので行わないこと）。未来の死亡日、死亡日より前または未来の「知った日」は 400 | 同一（フィールド追加） | #7 |
| `GET /cases/:caseId` | ヘッダー表示 | `GET C` | 同一 | #7 |
| `PATCH /cases/:caseId` | 市区町村等の訂正 | `PATCH C` body `{ municipality?, ..., expectedVersion }`。`status` / `progress` は含めない | 同一（strict化） | #7 |
| `GET /cases/:caseId/overview` | ダッシュボード、10段階フロー | `GET C/overview` → Task/期限/待機/承認/段階の集約。`inheritanceDecision.deliberationDeadline`（`DeadlineSummary`相当、`DeadlineResource \| null`）に熟慮期間（民法915条）の残日数を返す。永続 Deadline ではなく Case の日付からその場で算定するため、Task 側の期限（相続方法の選択）と再評価前は一時的に不一致になりうる | 同一 | #17 |

権限: 一覧・詳細・overview は全 role。作成は認証済みユーザー、更新は OWNER / EDITOR。

## 4. タスク・期限・証拠・手順案内

| 現行 | 画面操作 | 公開API | 移行 | 担当 |
|---|---|---|---|---|
| `GET /cases/:caseId/tasks` | タスク一覧 | `GET C/tasks?cursor=&limit=` | 同一 | #9 |
| `POST /cases/:caseId/tasks` | 手動追加 | `POST C/tasks` body `{ title, summary, stage, category, submitTo?, evidenceRequired?, assetDisposal? }` | 同一 | #9 |
| `GET /tasks/:taskId` | タスク詳細 | `GET C/tasks/:taskId` | Case配下へ | #9 |
| `PATCH /tasks/:taskId` body `{ status }`（`useUpdateTaskStatus`） | ステータス変更 | `POST C/tasks/:taskId/commands` body `{ command, expectedVersion, note? }` | **Commandへ** | #9 |
| `PATCH /tasks/:taskId`（説明等） | 説明・期日の訂正 | `PATCH C/tasks/:taskId` body は `title/summary/submitTo` + `expectedVersion` のみ。`status` は 400 | Case配下へ・strict化 | #9 |
| `POST /tasks/:taskId/complete` body `{ confirmedBySelf: true }` | 「自分で完了した」 | `POST C/tasks/:taskId/commands` body `{ command: 'complete', expectedVersion, note? }`。証拠が必須な Task は 409 `PRECONDITION_FAILED`（details.reason=`EVIDENCE_REQUIRED`） | Case配下へ | #9 / #11 |
| `POST /tasks/:taskId/reopen` | 再開 | `POST C/tasks/:taskId/commands` body `{ command: 'reopen', expectedVersion, note? }` | Case配下へ | #9 |
| `POST /tasks/:taskId/evidences` | 証拠登録 | `POST C/tasks/:taskId/evidences` body `{ label, kind, note?, documentId? }` | Case配下へ・複数形 | #9 / #11 |
| `GET /cases/:caseId/deadlines` | 期限一覧 | `GET C/deadlines` → 根拠・確認状態（`CONFIRMED / UNCONFIRMED`、算定不能理由）付き | 同一 | #9 |
| `POST /tasks/:taskId/guidance/research` | 「手順を調べる」 | `POST C/tasks/:taskId/guidance/requests` → **202** の案内リソース（`agentRunId`, `status: 'RESEARCHING'`）。結果は `GET C/tasks/:taskId/guidance` と `GET C/agent-runs/:runId`。未接続なら501 | **非同期化** | #15 / #10 |

権限: 一覧・詳細は全 role。作成・Command・証拠登録は OWNER / EDITOR。

## 5. 書類

| 現行 | 画面操作 | 公開API | 移行 | 担当 |
|---|---|---|---|---|
| `GET /cases/:caseId/documents` | 書類一覧 | `GET C/documents` | 同一 | #8 |
| `POST /cases/:caseId/documents`（multipart） | アップロード | `POST C/documents` multipart（`file`, `kind`）→ 201 の書類リソース（`storageState: 'STORED'`）。外部AI同意（`CROSS_BORDER_AI`未同意/版ずれ）は保存前に403（`details.requiredConsent`）。検査状態は `inspection.status`、解析状態は `analysis.state`。未接続の検査は `PENDING`、解析未受付は `NOT_REQUESTED`、`analysis.canRequest:false`と理由を表示 | 同一 | #8 / #19 |
| `GET /documents/:documentId` | 詳細 | `GET C/documents/:documentId`（メタデータ）、`GET C/documents/:documentId/content`（認可済み配信） | Case配下へ | #8 |
| `DELETE /documents/:documentId` | 削除 | `POST C/documents/:documentId/archive` body `{ expectedVersion }`。物理削除はしない。参照元で現在の利用可否を表示し、archive書類を新しい完了根拠にしない | **Commandへ（archive）** | #8 |

書類一覧/詳細は`extractionCandidates`（保存済みAI Proposalの候補）、`proposalRefs` / `approvalRefs` / `evidenceRefs`と`analysis.run`を返す。
候補があることをOCR/検査/正式適用の成功と同一視しない。Runの待機理由・失敗と承認の`applicationStatus`を分けて表示する。
原本はBackend専用のLocal/GCS Adapterで保持し、WebへStorage設定/URLを返さない。[保存・検証境界](../runbooks/document-storage.md)。

## 6. 家族（関係者・関係性）

| 現行 | 画面操作 | 公開API | 移行 | 担当 |
|---|---|---|---|---|
| `GET /cases/:caseId/persons` | 家族一覧 | `GET C/persons?includeExcluded=` | 同一 | #13 |
| `POST /cases/:caseId/persons` | 追加 | `POST C/persons` body `{ name, relationship, role?, isHeir?, specialCircumstance?, contact?, note? }` | 同一 | #13 |
| `PATCH /persons/:id` | 訂正 | `PATCH C/persons/:personId` body 同上 + `expectedVersion` | Case配下へ | #13 |
| `DELETE /persons/:id` | 削除 | `POST C/persons/:personId/exclude` body `{ expectedVersion, reason? }`。Decision がある場合は 409 `PRECONDITION_FAILED`。Evidence / Audit の履歴は物理削除しない | **Commandへ（exclude）** | #13 |
| （なし） | — | `GET / POST C/relationships`、`PATCH C/relationships/:relationshipId` | 新設 | #13 |

`isHeir` はユーザーが記録した情報であり、法定相続人の判定ではない。画面表示でもその旨を保つ。

## 7. 財産・債務

| 現行 | 画面操作 | 公開API | 移行 | 担当 |
|---|---|---|---|---|
| `GET / POST /cases/:caseId/assets` | 財産一覧・追加 | `GET / POST C/assets` body `{ name, kind, institution?, amount?, taxAttention?, note? }`。`amount` は JPY 整数、未入力は保存時 `null`、応答では `amount` を省略（0 とは区別） | 同一 | #14 |
| `PATCH /assets/:id`（`Partial<Asset>`） | 訂正 | `PATCH C/assets/:assetId` body は上記フィールド + `expectedVersion`。`source` / `agentRunId` / `confirmation` は 400 | Case配下へ・strict化 | #14 |
| `PATCH /assets/:id` body `{ confirmation: 'CONFIRMED' }` | 「確認済みにする」 | `POST C/assets/:assetId/confirm` body `{ expectedVersion, note? }`。確認者・時刻・確認時の版を `confirmationRecord` に保持。名称・種別・機関・金額を変更すると UNCONFIRMED に戻る | **Commandへ** | #14 |
| `GET / POST /cases/:caseId/liabilities`, `PATCH /liabilities/:id` | 債務 | assets と同型（`creditor`）。`POST C/liabilities/:liabilityId/confirm` | 同上 | #14 |

公開登録は常に `MANUAL`。AI候補の正式反映は型別Proposal Applierと人の承認・再検証を通す（#40/#41）。書類OCR・実AI抽出の接続は別で、候補を確認済み事実にしない。評価・税計算・分割案は対象外。

## 8. 契約・給付（保険金・年金）

| 現行 | 画面操作 | 公開API | 移行 | 担当 |
|---|---|---|---|---|
| `GET / POST /cases/:caseId/contracts` | 契約一覧・追加 | `GET / POST C/contracts` body `{ name, kind, provider?, note? }` | 同一 | #16 |
| `PATCH /contracts/:id` body `{ policy }` | 方針（継続/名義変更/解約） | `POST C/contracts/:contractId/policy` body `{ expectedVersion, policy: 'UNDECIDED'|'CONTINUE'|'TRANSFER'|'CANCEL', note? }`。`CANCEL` は方針の記録であり解約実行ではない | **Commandへ** | #16 |
| `PATCH /contracts/:id` body `{ progress }` | 進捗 | `POST C/contracts/:contractId/progress` body `{ expectedVersion, progress: 'NOT_STARTED'|'CONTACTED'|'COMPLETED', note? }`。`COMPLETED` は利用者申告（`source: 'USER_REPORTED'`）。方針 `UNDECIDED` のまま完了は 409 | **Commandへ** | #16 |
| `PATCH /contracts/:id`（その他） | 説明訂正 | `PATCH C/contracts/:contractId` 記述フィールド + `expectedVersion` | Case配下へ・strict化 | #16 |
| `GET /cases/:caseId/benefits` | 給付一覧 | `GET C/benefits`、`POST C/benefits` | 同一 | #16 |
| `PATCH /benefits/:id` body `{ progress }` | 請求進捗 | `POST C/benefits/:benefitId/progress`（契約と同型） | **Commandへ** | #16 |

受給可否・金額・期限の自動判定はしない。案内文・期限の給付向け連携は未接続で、公開APIの登録 body では受け付けない。

## 9. 承認・本人意思

| 現行 | 画面操作 | 公開API | 移行 | 担当 |
|---|---|---|---|---|
| `GET /cases/:caseId/approvals` | 承認待ち一覧 | `GET C/approvals?cursor=&limit=` | 同一 | #11 |
| `GET /approvals/:id` | 詳細（Proposal と根拠） | `GET C/approvals/:approvalId`、`GET C/proposals/:proposalId` | Case配下へ | #11 |
| `POST /approvals/:id/approve` / `reject` | 承認・却下 | `POST C/approvals/:approvalId/approve` / `reject` bodyは approve が `{ expectedVersion, proposalVersion, payloadHash, note? }`、reject が `{ expectedVersion, note? }`。hash 不一致・失効・却下済みは 409 | Case配下へ（対象版指定） | #11 |
| `POST /cases/:caseId/inheritance-decisions` | 相続方針の選択 | `POST C/inheritance-decisions/:personId` body `{ method, state: 'DRAFT'|'REPORTED', note? }`、`POST C/inheritance-decisions/:personId/confirm` body `{ method, expectedVersion, note? }` で紐付いた本人が確定 | **二段階化** | #11 |

承認要否はサーバーの Approval Policy が決める。フロントは `approvalRequired` を送らない。

## 10. チャット・手順案内

| 現行 | 画面操作 | 公開API | 移行 | 担当 |
|---|---|---|---|---|
| `GET /cases/:caseId/messages` | 履歴 | `GET C/messages?cursor=` | 同一 | #15 |
| `POST /cases/:caseId/messages`（同期で回答返却） | 送信 | `POST C/messages` body `{ body }` → **202** `{ message, runId, runAccepted, reason }`。回答は `GET C/messages` に `role: 'assistant'` として後から現れる。基本同意不足・外部AI同意不足（`CROSS_BORDER_AI`未同意/版ずれ）は保存前に403（`details.requiredConsent`）。AI未接続など同意はあるが実行を受け付けられない場合のみ発言を保存し `runAccepted: false` と理由を返す | **非同期化** | #15 / #10 / #12 |

## 11. 気づき（Insights）

| 現行 | 画面操作 | 公開API | 移行 | 担当 |
|---|---|---|---|---|
| `GET /cases/:caseId/insights` | 一覧 | `GET C/insights` → 本文・区分・検出時刻・根拠（`freshness: CURRENT|STALE|UNAVAILABLE`）・関連Task/Document・`agentRunId`・閲覧者本人の `status` | 同一 | #18 |
| `PATCH /insights/:id` body `{ status: 'ACKNOWLEDGED' }` | 既読 | `POST C/insights/:insightId/acknowledge` body `{ note? }` | **Commandへ** | #18 |
| `PATCH /insights/:id` body `{ status: 'DISMISSED' }` | 非表示 | `POST C/insights/:insightId/dismiss` body `{ reason? }` | **Commandへ** | #18 |
| （なし） | — | 公開APIでの Insight 作成・編集は提供しない。InsightのApplication受領処理は保存済み Run・attempt・根拠を検証して保存する。内部HTTPのInsight結果配線は未接続（#36）。チャット／案内の結果契約をInsight接続済みとは扱わない | — | #18 / #10 |

既読・非表示は閲覧者ごとの状態で、本文は共有。根拠のない気づきは表示しない。

## 12. 移行方針

1. **状態変更 PATCH の Command 化**（Task status / Asset・Liability confirmation / Contract policy・progress / Benefit progress / Insight status / Person delete / Document delete）。理由: 遷移条件・出所・実行者・版を記録し、AI や画面の任意上書きを防ぐ。旧 PATCH で当該フィールドを送った場合は 400 `VALIDATION_FAILED` を返し、黙って無視しない。
2. **非Caseスコープパスの Case 配下化**（`/tasks/:id`, `/documents/:id`, `/persons/:id`, `/assets/:id`, `/liabilities/:id`, `/contracts/:id`, `/benefits/:id`, `/approvals/:id`, `/insights/:id`）。ID だけでのアクセスは提供しない。移行期間の互換ルートも置かない（フロント切替は別の接続切替PRでまとめて行う）。
3. **同期 AI 応答の 202 化**（messages / guidance research）。受付を処理完了として表示しない。
4. **Idempotency-Key と expectedVersion の必須化**。フロント側は `api` クライアントで書き込み時にキーを自動生成し、DTO の `version` を `expectedVersion` として送る。
5. **MSW の維持**。`apps/web` の MSW fixture は既存 UI の開発用として残し、契約が確定した機能から順に Backend への接続に切り替える。DTO 変更は `packages/public-contracts` を先に更新し、MSW とサーバーが同じ型を満たすことを typecheck で保証する。

## 13. 未確定・このIssueで決めないこと

- IdPの実環境設定・セッション更新・招待UI。認証境界は [ADR-0001](../adr/0001-authentication-provider.md) に従う
- Firestore のコレクション設計詳細・Emulator テスト → #5
- AI 内部契約（Run 結果の schema、認証、Outbox）→ #10
- Entity別Proposalのpayloadは [proposal-payloads.md](proposal-payloads.md)。AI提出・lease連携は #11 / #41
- 書類検査・マイナンバー検知の提供条件 → #19
- 期限計算の根拠（法令・自治体差）→ #9。本書は期限の値を定めない。

## 14. 受入シナリオ

各シナリオは Backend の HTTP テスト（node:test）と、接続後のフロント E2E で確認する。`Idempotency-Key`・`expectedVersion` 欠落、別Case参照、role不足は全シナリオで共通に 428/404/403 を確認する。

| 領域 | シナリオ |
|---|---|
| Case | OWNER が Case を作成し一覧・詳細・overview を取得できる。membership のないユーザーは 404。`PATCH C` で `status` を送ると 400。古い `expectedVersion` は 409 |
| タスク | `start → complete → reopen` が Command でのみ遷移し、`PATCH` で `status` を送ると 400。証拠必須 Task の完了は証拠なしで 409。完了は「利用者申告」として表示され、外部受付完了とは区別される |
| 家族 | 追加・訂正・除外ができ、除外済みは一覧から既定で消えるが監査に残る。Decision から参照される Person の除外は 409。関係性の両端が別 Case なら 404。`isHeir` は法的判定と表示されない |
| 財産・債務 | `amount` 未設定と 0 が区別される。`confirm` Command で確認者・時刻・版が記録され、金額変更で UNCONFIRMED に戻る。`source: 'AI'` を body で送ると 400。VIEWER の書き込みは 403 |
| 契約・給付 | 方針・進捗は Command でのみ変わる。`UNDECIDED` のまま `COMPLETED` は 409。`CANCEL` は方針表示のみで解約 Action は生成されない。`COMPLETED` は `USER_REPORTED` として表示される |
| 書類 | 保存完了後は `storageState: STORED` で、解析完了を待たずに一覧に出る。archive 後は content 取得が 404 になり、参照する Insight 根拠が `UNAVAILABLE` になる |
| 承認 | 承認対象の hash が変わると旧承認は無効。却下済み Proposal を再承認できない。承認しても対象版が古ければ 409 |
| 進捗・ダッシュボード | overview の段階・件数が各 Command 後に一致する。AI 処理中は「受付済み」と表示され完了扱いにならない |
| チャット | 送信は 202 で受け付けられ、回答が後から履歴に現れる。外部AI不可なら発言は残り `runAccepted: false` と理由が返る |
| 気づき | 根拠のない結果は保存されず一覧に出ない。既読は本人にだけ反映され他メンバーは `NEW` のまま。`ACKNOWLEDGED → NEW` は 409。別 Case の Run に紐づく結果は拒否される |

## 15. Backend補完契約（#9 / #15 / #17 / #38 / #40 / #42）

- Task作成／PATCHに `assigneeId`（同一Caseの非除外Person）、`dependencyTaskIds`、`requiredDocuments` を追加。
  公開入力からsourceを指定させない。循環は拒否し、先行Taskが未完了なら着手・準備完了・提出・外部待ち・完了を止める。
  既存Taskの依存関係省略は空配列。完了済みTaskの必要書類／依存関係訂正は先にreopenが必要。
  担当者の設定は権限付与ではない。書類要求の訂正は手動由来として記録する。
- `overview.consistency` は `SNAPSHOT`。`aggregatedAt` は全クエリ・全ページで共有するDB読取時点。
  `caseVersion` はCaseの業務版であり、集約全体の更新版やETagには使わない。
  集約はライブクエリで、別の非同期read modelはない。操作後／再表示時は再取得する。
  取得後に別要求が更新することはあるため、この表示をCommand認可や完了可否の代わりにしない。
- 手順案内のRun・案内所有権・配送イベントは一括保存。再依頼は以前の出典や結果をRESEARCHINGの結果として使い回さない。
  結果受領は保存Transaction内で取消・attemptを再検証し、古いRunは新しい案内を上書きできない。
- 初期Taskと期限再評価の継続実行は [Outbox worker](../runbooks/outbox-worker.md)。AI非接続でも手動管理用の処理を継続する。
- 提案の承認／適用は [Entity別payload](proposal-payloads.md) に従う。
  専門家引継ぎはTaskの `escalation` に理由・資料の版・`contacted:false` を返し、連絡済みと表示させない。

これらはBackend契約であり、MSW画面は変更していない。実フロント接続／実AI接続は未検証。
