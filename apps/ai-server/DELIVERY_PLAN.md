# AI実装とPR一覧

> **履歴資料:** これは初期実装をstacked PRで進めた時点の記録です。現在の状態は [AI Server README](README.md) と [実装方針](IMPLEMENTATION.md) を参照してください。

起点: main `9385b67`。すべて前のブランチをbaseにしたstack。既存UIと業務のBackend所有、2 Agent、必須Orch利用を維持。

| PR | 実装 |
|---|---|
| [#102](https://github.com/mimish0778/after-flow/pull/102) | AI専用FirestoreのMastra保存・強制終了/再開・ADR |
| [#103](https://github.com/mimish0778/after-flow/pull/103) | 暗号化永続受付・Worker所有権・共有予算 |
| [#104](https://github.com/mimish0778/after-flow/pull/104) | Source Catalog・公式HTML取得・SSRF境界 |
| [#105](https://github.com/mimish0778/after-flow/pull/105) | Provider Policy・grant・Orch Port・SDK単位のFallback/計測 |
| [#106](https://github.com/mimish0778/after-flow/pull/106) | Proposal・正式版/hash・承認待ち/再開 |
| [#107](https://github.com/mimish0778/after-flow/pull/107) | Backendの完全な計画/訂正/却下/承認履歴Context |
| [#108](https://github.com/mimish0778/after-flow/pull/108) | 根拠付きChat・確認質問 |
| [#109](https://github.com/mimish0778/after-flow/pull/109) | Guidance/Chat Handler・実Backend↔AI HTTP試験 |
| [#110](https://github.com/mimish0778/after-flow/pull/110) | P-03差分計画、Backend承認時のTask依存/必要書類検証 |
| [#111](https://github.com/mimish0778/after-flow/pull/111) | P-03 Worker接続・承認待ち・再開・結果報告 |
| [#112](https://github.com/mimish0778/after-flow/pull/112) | P-02の候補/根拠位置/訂正/不足Workflow |
| [#113](https://github.com/mimish0778/after-flow/pull/113) | P-04の事実整理/不足書類/生成物と承認版の判定Workflow |
| [#114](https://github.com/mimish0778/after-flow/pull/114) | Backendイベント起点のInsight/引継ぎ候補 |
| [#116](https://github.com/mimish0778/after-flow/pull/116) | Mastra Dataset/Scorer/Experiment・32合成ケース・比較・CI |

#102〜#114は各CI全11件成功を確認。#116もAI fixture評価を含む全12件成功。後続も全12件が必要。

承認待ち中のTemplate改定/期限切れと生成物manifestの改変を最終確認で追加検証。#102〜#113はマージ済みだが、#103以降はそれぞれの親ブランチへのマージだったため、mainに未反映の変更を統合PRで届ける。実Provider/Orch/業務資料、Backendの加工版配信・生成物保存・Insight配信契約は未接続。現状と有効化に必要な情報は[IMPLEMENTATION.md](IMPLEMENTATION.md)。
