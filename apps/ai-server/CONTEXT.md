# Contextの構築

関連: #51。`buildCoreContext`はBackendの認可済みContext Artifactだけを受け取る。
contentHash、期限、operation、公開された内部配信フィールドを検証し、案内用のModel入力とContext proofを分ける。
署名検証・同意・Case/Run所有権はBackend Clientの先にあるBackendが担当する。

- 確認済み財産・債務、本人確定のDecisionをconfirmedとして保持する。
- Caseの申告値やREPORTEDのDecisionをuser_reportedとして保持する。nullをゼロ・死亡日等で補完しない。
- 財産・債務の出自は現契約に含まれないため、UNCONFIRMEDを申告/抽出候補と推定しない。unknownと明示する。
- 処理予算を超える場合は拒否し、Decisionや制約を黙って要約・切捨てしない。
- 文書はcontentAvailable:falseの既存契約のみ。未検査・本文付きの未知の形を受け付けない。
- Action/resume等の制御情報はモデルへ渡さない。ハーネスが元Artifactを別途管理する。
- 調査依頼はレビュー済み設定から構築し、個人名やTaskの自由入力タイトルを転送しない。自治体が一致しない場合はneeds_inputを返す。
- 調査後は新しく取得したContextとのcaseVersion/hash一致を確認する。異なれば再評価する。

現Backend契約では訂正・却下履歴と明示的禁止事項が未配信。この不足を入力のlimitationsに残す。
履歴を前提とする計画・変更提案の本番有効化は、それらの契約拡張と接続試験が完了するまで行わない。
したがって本PRだけで #51 の全受入条件が完了したとは扱わない。
