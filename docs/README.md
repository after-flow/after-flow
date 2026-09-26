# ドキュメント案内

実装判断では、まずこのページから目的に合う文書を選んでください。日付入りの資料やADRは当時の判断を残すため、現在の実装状況とは分けて扱います。

## 設計と契約の正本

| 文書 | 用途 |
| --- | --- |
| [全体アーキテクチャ](architecture.md) | サービス境界、責務、データ所有、AI実行方針 |
| [Public OpenAPI](api/public-openapi.yaml) | FrontendからBackendへ送る公開HTTP契約。Backendのroute specから生成 |
| [Frontend / Backend対応表](api/frontend-backend-mapping.md) | 画面操作とPublic APIの対応、受入シナリオ |
| [Backend / AI内部実行API](api/internal-execution.md) | Run、Context、Proposal、結果通知の内部HTTP契約 |
| [Proposal payload](api/proposal-payloads.md) | AIがBackendへ提出できる変更案の型 |

Public APIを変更した場合は `pnpm openapi:generate` で生成物を更新し、`pnpm openapi:check` で差分がないことを確認します。

## サービス別ガイド

- [Frontend](../apps/web/README.md)
- [Backend](../apps/backend-server/README.md)
- [AI Server](../apps/ai-server/README.md)
- [AIエージェント構成](agent-architecture.md)
- [OrcaRouter接続](../apps/ai-server/ORCAROUTER.md)
- [AI評価](../apps/ai-server/EVALUATION.md)

## 運用

- [CI/CD](ci-cd.md)
- [Runbook一覧](runbooks/)
- [ローカルSwaggerとFirebase Auth Emulator](runbooks/local-swagger.md)
- [Backend Outbox Worker](runbooks/outbox-worker.md)
- [Readiness](runbooks/readiness.md)
- [Document Storage](runbooks/document-storage.md)

## 判断記録と履歴資料

- [ADR一覧](adr/)は、判断した時点の背景と未決事項を保存します。後続実装で状況が変わっても、判断履歴を消さず追記で更新します。
- [Frontend刷新時のBackend申し送り（2026-09-21）](backend-handoff-2026-09-21.md)は当時の差分記録です。現在の契約確認にはOpenAPIと対応表を使用します。
- [AI実装状況（2026-09-21）](../apps/ai-server/IMPLEMENTATION_STATUS.md)は当時のスナップショットです。現在の状態はAI Server READMEを使用します。
- [AIエージェント技術ブログ素材](ai-agent-tech-blog-notes.md)は説明・執筆用の資料であり、実装契約の正本ではありません。

## 状態の読み方

- `/health` はプロセスの生存確認です。外部AI、Runtime、Worker、業務操作の利用可否は保証しません。
- AI Serverの実行compositionは `/internal/v1/ready`、Backendの本番依存は `/internal/v1/health/ready` で別々に確認します。
- ローカルで画面からAIを使うには、OrcaRouterとAI Runtimeに加えて `AI_CONNECTED_OPERATIONS` の明示設定が必要です。
- 本番のFirebase、AI Provider、IAM、監視、業務カタログは、ローカル接続済みという理由だけで準備完了とは扱いません。
