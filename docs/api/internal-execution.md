# Backend内部実行API v1

契約正本は `packages/internal-contracts/src/index.ts`、生成物は
[internal-openapi.yaml](internal-openapi.yaml)。公開OpenAPIとは別です。
`pnpm openapi:generate` / `pnpm openapi:check` は両契約を生成・検証します。

## 接続設定と信頼境界

- Backend/worker: `BACKEND_EXECUTION_SIGNING_KEY`（32 bytes以上、AIには渡さない）。
- Backend ingress: `BACKEND_INTERNAL_SERVICE_TOKEN`（AI→Backendサービス資格情報）。
- AI ingress: `AI_SERVICE_TOKEN`（Backend→AI）。双方向で同じ値を使わない。
- `BACKEND_SERVICE_AUDIENCE` の既定値は `backend-internal`、`AI_SERVICE_AUDIENCE` は `ai-server`。
- `AI_CONNECTED_OPERATIONS` は実AI側と接続を検証した操作だけを設定する。必要な設定が不足すると受付を有効にしない。
- 旧 `/internal/v1/tenants/:tenantId/cases/:caseId/results` は本番compositionから除外。
- private ingressとサービスアカウントの権限制限は配備側でも必要。開発用Composeは認可設定を自動注入しない。

AIには共通署名鍵ではなく、Backendが発行した5分以内のRun capabilityを渡します。
各呼出しは `Authorization: Bearer <AI→Backendサービス資格情報>` と
`X-Execution-Authorization: <capability>` の両方が必要です。
capabilityのtenant/Case/Run/Job/attemptは署名検証に加え、保存済みRunと照合します。
actorとroleはRunの受付者と現在のmembershipから導出し、同意は保存と同じTransactionで再検証します。
旧形式のRun（受付者やJob IDがないもの）は内部APIで拒否します。

## 要求と再送

全要求に `X-Request-Id / X-Job-Id / X-Execution-Attempt / X-Issued-At / X-Expires-At` が必要です。
時刻はepoch秒。要求の有効期間は60秒以内、未来のissuedAtや期限切れは拒否します。
最大本文は128 KiB、配送クライアントtimeoutは10秒以内です。
署名鍵・service credential・capability・Context本文をログや監査へ記録しません。

同じrequestIdの異なるmethod/path/bodyは拒否します。eventsはeventId、resultはresultIdでも本文hashを照合し、
一致する再送だけ保存済み結果を返します。進捗のsequenceが戻ってもRunを巻き戻しません。
再送のHTTP認可metadataは更新できますが、業務本文を変更したら別の要求です。
dispatchのjob冪等性は `jobId/runId/executionAttempt/operation` の同一性で判定し、短寿命の時刻/capabilityは再送時に更新します。
AI providerは毎回資格情報を検証し、同一jobの異なる業務scopeを拒否する必要があります。
単なる409を配送成功とせず、jobId/runIdと`DUPLICATE` ACKまで照合します。

## ContextとArtifact

ContextはDBの同一読取時点から作り、返却直前のTransactionでRunとCase版を再検証します。
case_planningは案件の業務事実、task_guidanceは対象Task、chat_replyは対象Messageと案件基本情報に制限します。
各一覧100件・合計128 KiBを超えたら `CONTEXT_LIMIT_EXCEEDED` とし、黙って切り捨てません。
返却する `caseVersion/contextSnapshotId/artifactVersion/contentHash/expiresAt` を結果提出時に指定します。
contentHashはキー順を正規化したJSONのSHA-256（base64url、43文字）です。
ArtifactはBackendが保存したこのContext生成物で、別Run/attemptから取得できません。
期限切れや案件変更後には再利用できず、元のContextで結果を確定できません。
期限はアクセスの期限であり、物理削除完了を意味しません。

未検査・検査中・拒否・検査失敗の書類は配信しません。
検査済み書類も、この段階ではID/版/種別と `contentAvailable:false` だけです。
原本・masked原本・ファイル名・Storage keyはContextに含めません。
書類本文の配送とdocument_analysisは #25/#26/#27 の接続まで明示的に無効です。

heartbeatは生存時刻を記録し、認可が現在も有効な実行に限ってcapabilityを更新します。
controlは権限/同意の撤回後でも業務本文を含めずSTOPを返します。
resultはContext・根拠の所属/版・Run/attempt・重複IDを同じTransactionで検証します。
結果報告から任意の業務Entityを作成しません。正式変更はProposalの経路です。

## 未接続の範囲

- Proposalのlease/fencing連携は #41、WaitRequest/resume/reconcilerは #37。
- Case leaseをheartbeatで更新する接続は #41。現段階のheartbeatは生存報告のみ。
- controlイベントの外部配送は未接続でOutboxに保持。AIは各Step前にcontrolを照会する必要があります。
- 実AI/Mastra/Orchと本番サービスアカウントの接続検証は未実施です。livenessはreadinessの証明ではありません。

Fake AI HTTPとのconsumer契約、実HTTPでのBackend provider、Emulator保存経路をテストします。
