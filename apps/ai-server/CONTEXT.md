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

## 計画の訂正・却下履歴

case_planningのContextに、Case内のProposal・不変版・Approvalの最小metadataを追加する。
現在のRunだけでなく過去のRun/利用者由来の提案も含め、同じ却下案や訂正前の案の繰り返しを避ける。
渡すのは提案種別・題名/説明・Task題名/ID・状態・版/hash・訂正元版・判断メモ等であり、payload全文・原本参照・承認者IDは含めない。

各集合100件を上限とし、続きがある場合は切り捨てずContextを拒否する。版の欠落/重複とApprovalの版/hash不整合も拒否する。
`buildPlanningContext`は履歴未配信を「履歴なし」とせず、明示的に計画を止める。
履歴の本文は非信頼データとしてコアだけに渡す。案内用Contextと検索Agentには転送しない。
正式なTask・本人Decision・期限は従来どおりBackendの記録を参照する。法定期限やRuleの判断権限をAIへ移さない。
