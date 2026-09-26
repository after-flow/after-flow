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
返却する `caseVersion/contextSnapshotId/artifactVersion/contentHash/fencingToken` を結果・提案提出時に指定します。`expiresAt` はArtifactのアクセス期限です。
contentHashはキー順を正規化したJSONのSHA-256（base64url、43文字）です。
ArtifactはBackendが保存したこのContext生成物で、別Run/attemptから取得できません。
期限切れや案件変更後には再利用できず、元のContextで結果を確定できません。
期限はアクセスの期限であり、物理削除完了を意味しません。

未検査・検査中・拒否・検査失敗の書類は配信しません。
`case_planning` / `task_guidance` / `chat_reply` のContextでは、検査済み書類もID/版/種別と
`contentAvailable:false` だけです。原本・masked原本・ファイル名・Storage keyは含めません。

`document_analysis` は対象書類1件のページ本文（テキスト）と読み取り対象フィールドをContextへ返す
唯一の操作です（#196）。配信するのは検査 `PASSED` の書類だけで、実PDFのテキスト抽出はOCRではなく
埋め込みテキストの取得のみ（画像・スキャンのみのPDFは空ページになる）。マイナンバー等の実検知・
マスキング方式は #25/#26 が未決定のため、`maskingPolicyVersion` は仮のプレースホルダーを返す。
本番相当の検査（`inspection.status: PASSED`）自体、素通し検査アダプタ
（`DOCUMENT_INSPECTION_MODE=passthrough-dev`、本番では起動不可）を明示設定しない限り発生しない。

Contextの最初の取得でCase leaseを取得します。同じCaseで並行して書き込みを伴うAI実行区間を始めると `CASE_BUSY` です。
heartbeatは生存時刻とlease期限を更新し、認可が現在も有効な実行に限ってcapabilityを更新します。
期限切れのleaseを同じattemptが勝手に再取得することはできません。取消・最終結果では同じTransactionで解放します。
Context Artifact自体の期限をheartbeatで無制限に延長はしません。
controlは権限/同意の撤回後でも業務本文を含めずSTOPを返します。
resultはContext・根拠の所属/版・Run/attempt・重複IDを同じTransactionで検証します。
結果報告から任意の業務Entityを作成しません。正式変更はProposalの経路です。

## AI Proposalと人の承認

`POST /runs/:runId/proposals` はcase_planning capabilityだけが利用できます。
Run・Job・attempt・Case版・Context hash・根拠・現在のlease期限とfencingTokenを保存と同じTransactionで検証し、
immutableなProposal版とPENDING Approvalを同時作成します。AIがsource/role/承認不要を指定する入力は禁止します。
各kindのpayloadは公開Proposalと同じApplierで検証します。現時点では全kindに人の承認が必要です。

人の承認はAIの古いcapabilityを流用しません。現在の利用者権限、Runの取消/失敗/attempt変更、
Proposalの内容・版・Case版・根拠を再検証し、現在のCase leaseをBackendの適用区間として取得・解放します。
別Runが有効なleaseを保持中なら競合として拒否します。適用のTransactionでfencing世代を進めるため、
古いAI実行は以後の書き込みができません。失効したAIからの新しい提案は拒否しますが、
既に検証して保存した同一内容の提案は、leaseの時間切れだけを理由に人が確認できなくなる設計にはしません。
業務Entity・Approval・Proposal・lease世代・監査・Outboxを原子的に確定します。
実行provenanceの無い旧形式AI提案は適用せず、再作成を要求します。

## 待機・再開

提案応答の`waitRequestId`はApprovalと原子的に作成した待機要求です。AIはsuspend Snapshot保存後、
`events`へ`{type:'WAITING',eventId,waitRequestId,snapshotId}`を送ります。明示的な待機は`wait-requests`へContext proofと条件を提出します。
承認が先に届いてleaseが変わっていても、登録済みの待機完了だけは照合して記録できます。未完の待機要求がある間、最終resultは拒否します。

workerは`GET /runs/:runId/snapshot-status?jobId=…&executionAttempt=…&waitRequestId=…`でAIの保存済み状態だけを照合します。
AI providerはサービス認証/audienceを検証し、Run/Job/attempt/Waitに一致するメタデータを返します。本文は返しません。
SnapshotとInboxの条件が揃うと、Backendが新attemptと一意なresume Jobを保存し、`POST /runs/:runId/resume`へ配送します。
配送本文はdispatchと同じ最小契約です。AIは重複排除後に新contextを取得し、`content.resume`のSnapshot参照/前attempt/条件結果を照合して再開します。
lease切れ復旧はCHECKPOINTとRETRYを区別し、3 attemptを超える自動復旧は要確認に止めます。

`content.actions`は当該RunのProposal状態/Action IDを返します。Action IDはattemptを跨いで保持してください。
同じ適用済みActionは再適用せずAPPLIEDを返します。未適用Actionの再試行は新しいProposal版とApprovalを作ります。
WaitRequestが消費したInbox IDとresume Job IDは永続化され、重複イベントやworkerの再起動では再作成しません。
同意撤回はBackendで取消し、controlからSTOPを返します。userIdを汎用イベントとしてAIへ転送しません。

## 未接続の範囲

- 開発Composeでは`passthrough-dev`検査を明示した場合に限り、`document_analysis`へ埋め込みテキストを配送できます。実OCR、マイナンバー等の検知・マスキング、本番相当の文書検査は未接続です。
- DOCUMENTS条件による自動再開は、本番相当の検査接続まで無効です。
- AIは各Step前にcontrolを照会する必要があります。Backend側の取消は実AIプロセスの強制停止の証明ではありません。
- 開発用のMastra/OrcaRouter compositionと本番サービスアカウント、IAM、監視を含む接続検証は別です。livenessはreadinessの証明ではありません。

Fake AI HTTPとのconsumer契約、実HTTPでのBackend provider、Emulator保存経路をテストします。
