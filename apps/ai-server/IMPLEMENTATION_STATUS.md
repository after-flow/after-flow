# AI実装状況（2026-09-21）

今回の作業は機能本体を優先した。実装全体の完了ではなく、実製品の指定・業務資料・Backend契約に依存する接続が残っている。既定mainの実行受付は503であり、healthの200を利用可能の証明にはしない。

## 追加した実装

| PR | Issue | 機能 |
|---|---|---|
| [#135](https://github.com/after-flow/after-flow/pull/135) | #52 | 6 Skillの実出力Schema・参照ファイル・契約hash |
| [#136](https://github.com/after-flow/after-flow/pull/136) | #51 #57 #62 | 計画結果・質問・残作業の保存、回答API、利用者申告履歴、同じRunでの再計画 |
| [#137](https://github.com/after-flow/after-flow/pull/137) | #55 | 公式PDFの取得、制限付き本文抽出、ページ根拠、読取不能の拒否 |
| [#138](https://github.com/after-flow/after-flow/pull/138) | #49 #57 #62 | 予算超過・時間切れ・障害時の途中結果、永続化した結果だけの再送 |
| [#139](https://github.com/after-flow/after-flow/pull/139) | #49 #57 | 取消Outbox・内部HTTP・永続取消記録・遅延dispatchの復活防止 |
| [#140](https://github.com/after-flow/after-flow/pull/140) | #64 | Backend検出イベント、気づきの結果保存・公開一覧、重複防止、根拠鮮度 |
| [#141](https://github.com/after-flow/after-flow/pull/141) | #49 #54 #57 #65 | 実Adapterとレビュー済み設定から永続サービスを組み立てる起動関数 |
| [#142](https://github.com/after-flow/after-flow/pull/142) | #55 #56 #57 | Harnessによる調査中断の記録、未完了の調査をcancelledとして扱う |

前提は案件のAI計画停止を保存する[#132](https://github.com/after-flow/after-flow/pull/132)と、AIが停止・本人意思を検証する[#133](https://github.com/after-flow/after-flow/pull/133)。PRはこの順の依存関係を持つ。マージ状況は各PRを参照。Webの画面・ルート・MSW fixtureは変更していない。

## 残る接続と実装

| Issue | 残る内容 | 必要な前提 |
|---|---|---|
| #47 #48 | 指定OrchRouterの実Adapter・認証・利用証跡 | ハッカソン公式資料または製品URL、実I/O契約 |
| #53 #54 | 実SDKモデル・提供先grantとの接続、実価格/保持条件 | 最低2 Providerの選定、許可範囲、Backend grant契約、設定済み資格情報 |
| #55 | 外部検索サービスを使う場合のAdapter | サービス選定。現在はレビュー済みCatalog内検索と公式URLの直接取得を実装済み |
| #51 #62 | 未配信の抽出出自、個別手続きの制約、実業務資料との接続 | Backendの正式データ/制約契約とレビュー済みTemplate。未配信情報はunknownのまま扱う |
| #61 | 検査済み加工版のHTTP配送、OCR、抽出Fieldから正式Proposalへの接続 | Backend #25/#26/#27、採用OCR、レビュー済みField対応。原本や検査成功固定で代替しない |
| #63 | 生成Artifactの保存・人の承認・書類待ちの実接続 | 一つの対象保険手続きの確定とBackend Artifact/承認契約。manifest生成・版/hash照合のWorkflowは実装済み |
| #64 | 時間経過による定期検査イベントの専用Run起動 | Backendの検査イベント配送。現在は計画実行時の検出→結果→公開一覧を接続済み |
| #65 | 既定entrypointへの実設定適用と全体の実接続 | 上記の実Adapter/契約・AI専用クラウド設定 |

これらを未実装のままIssueを閉じない。#66〜#72の評価拡張は今回の主作業にしていない。実装の検証には型/Lint/通常テスト/OpenAPI/buildと必要なFirestore Emulator試験を実施した。実モデル・実Orch・実OCRの動作や品質を、合成データの試験結果で代替しない。
