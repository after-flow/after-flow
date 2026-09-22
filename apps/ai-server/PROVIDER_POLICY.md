# Provider PolicyとOrcaRouter接続境界

開発用ハッカソン構成は、OrcaRouterの固定モデルをCore/Research Agentへ渡す。モデル選択、転送可能なデータ区分、予算、期限はアプリケーションのProvider Policyで制限する。OrcaRouterへ独立した業務Route選択APIがあるとは仮定しない。

## 現在のPolicy

- `orca-core-primary` と `orca-core-fallback` の順序付き2候補。
- `minimized_case` はCoreだけ、`public_research` はResearchだけに渡す。
- Policyの確認日は `2026-09-21T00:00:00Z`、期限は `2027-09-21T00:00:00Z` に固定し、再起動で延長しない。
- review referenceは [OrcaRouter data handling](https://docs.orcarouter.ai/operations/data-handling)。ハッカソン用の確認記録であり、上流Providerの本番利用条件は別にレビューする。
- `trainingUse: false`、`retentionDays: 0` はローカルの許可条件である。OrcaRouterや上流Providerが実際に同じ条件を保証する証拠として扱わない。
- Backend grantを各物理呼び出しの直前に再検査し、期限、データ区分、保持上限、共有予算に違反した通信を開始しない。

## Fallback

Mastraへ認可済みモデル配列を渡し、SDK retryは0にする。429、5xx、timeout、送信前または未完了のtransport障害だけを一時障害として次候補へ進める。401/402/403、Policy違反、予算停止、不正Schema、部分出力後の障害では切り替えない。

各候補の前に、そのPolicyの最大tokenと概算費用を予約する。候補は異なるモデル系列かつ同じ予算通貨でなければならない。決定的テストでtimeout、429、500からのfallback成功、全候補失敗、不正構造化出力ではProvider fallbackを行わないことを確認する。

## Provider attemptの記録

AI専用Runtime Firestoreの `provider_metrics` に、各物理呼び出しをrun単位で保存する。

- run/job/execution attempt、Provider attempt ID
- role、Policy ID/revision、要求model、fallback元Policy
- OrcaRouter request ID、公開されたresolved/fallback model
- success/failure、分類済み失敗理由、latency、input/output token
- Policy単価による概算費用、OrcaRouter応答に含まれる暫定費用

SchemaにはPrompt、回答本文、Case情報、原本文、API key、生のSDK errorを持たせない。request IDを使い、請求画面またはレビュー済みexportの確定費用と `reconcile:orca-cost` で照合する。概算値、gateway応答値、確定値は別fieldとして扱い、欠落を0円と見なさない。

## 運用上の限界

`/health` はprocessの生存、`/ready` は開発RuntimeとWorkerの接続を示すだけである。Policyの法務レビュー、上流Providerの保持条件、回答品質、確定請求額を保証しない。productionでは正式なProvider Policy、Backend consent grant、AI Runtime IAM/保持設定を別途用意する。

関連: [#167](https://github.com/after-flow/after-flow/issues/167)、[#183](https://github.com/after-flow/after-flow/issues/183)
