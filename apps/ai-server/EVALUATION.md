# AIの評価

評価は、再現可能なfixture評価と、明示的に実行するOrcaRouter実モデル評価に分ける。`/health` と `/ready` の成功は、回答品質や実モデル疎通の合格を意味しない。

## fixture評価

```sh
pnpm eval:ai
pnpm eval:ai holdout
```

- development: 28ケースを3回ずつ実行する。
- holdout: 9ケースを3回ずつ実行する。結果を見ながらPromptやSkillを調整しない。
- `document`、`insurance`、`insight`、`task_guidance` を対象にする。
- `task_guidance` は根拠付き正常系、適用条件未確認、根拠にない提出方法、任意URL、文字数境界を決定的に採点する。
- APIキーは不要で、通常CIでも外部通信しない。閾値未達、未実行、保存失敗は非ゼロ終了する。

Docker内で確認する場合は、現在のソースを含むimageを作ってから実行する。

```sh
docker compose build ai-server
docker compose run --rm --no-deps ai-server pnpm --filter @aftercare/ai-server eval:fixture
```

レポートは `reports/ai-eval-{split}.json` へ保存する。Dataset、Scorer、Playbook、各試行、失敗区分、p50/p95を含み、Gitには追加しない。入力は合成fixtureだけで、実人物の情報、原本文、秘密情報を含めない。

## OrcaRouter実モデル評価

APIキーをルート `.env` に設定し、費用上限を明示して実行する。

```sh
pnpm --filter @aftercare/ai-server eval:live-guidance --max-usd 5 --repetitions 2 --cases 8
```

- `--max-usd` は必須で、0より大きく20以下。
- 反復回数は2〜5回。通常案内、実費負担、加入支部・申請者関係・埋葬日が不明、Prompt injection、根拠にない提出先、未対応手続きの8ケースを持つ。
- 実際のMastra Workflow、Core/Research Agent、OrcaRouter、レビュー済み公式カタログを通す。
- 完了率、必須事実の再現率、禁止主張、claim単位の引用被覆率、p50/p95、token、暫定費用、モデル、Orca request IDを記録する。
- 本文、Prompt、APIキー、個人情報はレポートへ保存しない。未対応procedureはProvider呼び出しゼロを要求する。
- 完了率100%、平均必須事実再現率33%以上、引用被覆率100%、禁止主張0%、全試行safeを合格条件とする。

2026-09-22の受け入れ実行（8ケース×2回）は合格した。完了率100%、平均必須事実再現率47.6%、引用被覆率100%、禁止主張0%、p50 29.4秒、p95 39.3秒、入力363,993 token、出力37,016 token、OrcaRouter応答上の暫定費用は0.765106 USDだった。未対応procedureは2回ともProvider呼び出しゼロだった。この値は確定請求額ではない。

実行結果は同じ入力でも変動する。小規模なハッカソン受け入れであり、法的な正確性、全手続き、本番SLO、大規模費用予測を保証しない。現在の検索は外部Web検索ではなく、レビュー済みの協会けんぽ公式URLカタログ内のローカル検索と直接取得である。

## 費用と障害の確認

各Provider attemptはAI Runtime Firestoreの `provider_metrics` に本文なしで保存する。確定費用はOrcaRouterの請求画面またはレビュー済みexportからrequest IDと金額だけを取り出し、次の形式で照合する。

```sh
pnpm --filter @aftercare/ai-server reconcile:orca-cost --metrics safe-metrics.json --confirmed confirmed-costs.json
```

`confirmed-costs.json` は `[{ "requestId": "...", "confirmedCostUsd": 0.001 }]`。不足・未知のrequest IDがあれば非ゼロ終了する。公開仕様を確認できないGeneration APIを仮定しない。

関連: [#164](https://github.com/after-flow/after-flow/issues/164)、[#167](https://github.com/after-flow/after-flow/issues/167)、[#182](https://github.com/after-flow/after-flow/issues/182)、[#183](https://github.com/after-flow/after-flow/issues/183)
