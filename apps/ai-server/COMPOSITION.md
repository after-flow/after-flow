# AI Serviceの組み立て

`startConfiguredAiService(config, listen)` がAI専用Firestore、暗号化受付、共有予算、Backend HTTP Client、Core/Researchの認可済みモデル、公式資料Provider、P-01/Chat/P-03 Handler、HTTP/Workerを組み立てる。終了時はWorkerとHTTPを止め、Firestore接続も閉じる。

`config` はデプロイ側の信頼済みコードで作る。実OrchRouter Adapter、最低2 ProviderのSDKモデルとレビュー済みPolicy、Runごとの最新Backend grant取得、本文を含まないメトリクス保存、公式Catalog、Task Template、対象に合うレビュー済みResearch Scope、有限予算・タイムアウト、専用暗号鍵・サービス認証が必須。任意のモデル名・URL・実行関数を公開リクエストやLLM出力から設定しない。

モデル呼出しはOrchの返答を検証し、各SDK試行の直前に提供許可と共有予算を再確認する。Coreの案件ContextとResearchの公開調査依頼を分離する。既存のModel Routerだけを指定OrchRouterの代わりにする実装や、本番用の合成Providerは同梱しない。

起動時は設定の整合とAI専用ストアへの接続を確認する。Provider/Orchへの実要求はRunの認可後に行うため、起動成功は実モデル品質やハッカソン必須利用の証明ではない。既定の`main.ts`は実Adapter/業務設定が未提供のため未接続のまま起動する。実設定を用意したデプロイentrypointからこの関数を呼ぶ。

`document_analysis` とP-04はまだWorkerへ登録しない。検査済み加工版のBackend配信・OCR/Field対応、生成Artifactの保存/承認・業務レビューが必要であり、Scope検証や判定Workflowだけで提供開始にしない。
