# Provider policyとOrch接続境界

対象: #53/#54の認可・予算・Fallback・計測。実Providerとハッカソン指定OrchRouterは未登録。

`createAuthorizedModels`は、認可済みpolicy IDの候補をOrchRouter Portへ送り、返された最大2候補を検証する。
request ID・有効期限・候補範囲・重複を検査し、実登録済みSDKのprovider/model IDを照合する。
Orchへ渡すのはoperation/role/データ区分/policy ID等のmetadataだけで、案件本文や認証情報は含めない。
Portに既定実装や独自switchによる代用品はない。指定製品の資料・SDK・利用条件を確認して実Adapterを登録する必要がある。

policyは版・レビュー記録/期限・役割・データ区分・学習利用禁止・保持期間・必要能力・通貨・単価・モデル上限を持つ。
Backend認可に基づく最新grantを実際のSDK呼出し前に取得し、提供先・期限・保持条件を再検証する。
researchはpublic_researchに限定する。Schemaはgrantの真正性を証明しない。grant取得Portの実Backend接続は未実装。

FallbackのループはMastra標準のモデル配列を使用する。各SDK呼出しを薄いAdapterで包み、共有予算を先に予約する。
SDK retryは0、候補は別Provider最大2件なので、同一推論での実通信は最大2attempt（要件上限3以内）。
429/5xxのみ一時障害として扱い、認可エラー・設定不備・予算停止・同意撤回・未知エラーは後続の通信も停止する。
一部の回答/Tool callを受信した後は別Providerへ切り替えない。SDK v2の具象モデルのみ対応し、v3/v4等は適合試験後に追加する。

tokenと費用はProviderの確認済み入力上限・出力上限・単価から予約する保守的な値。実消費量不明でも差額を自動返却しない。
入力上限が実モデルの硬い上限であること、reasoning等の追加料金も含むことをレビューで確認する。単価未設定では有効化しない。
Provider Adapterが各attemptを課金する構成ではAgentBudgetの`inferenceChargedByProviderAdapter`を指定し、Processorの二重予約を避ける。
Tool上限・Backend制御照会は引き続き標準Processorが実行する。

計測はpolicy/版/Orch evidence ID/役割/成否/時間/token/分類だけ。本文・資格情報・生のSDKエラーを記録しない。
モデル使用量が返らない場合はnullとし、0や推定値を実測として扱わない。永続Trace/Scorer連携は評価PRで行う。

検証は実MastraのモデルFallbackと合成SDKで、503からの切替・各attemptの予算予約・403/撤回時の送信停止・途中Stream停止を確認する。
FakeのOrch decisionはtest内だけに置き、実Orch利用完了の証拠にはしない。
