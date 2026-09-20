# P-03 計画差分

`case-planning-v1` は既存のCore/Research 2 Agentを使い、レビュー済みTemplateから対応手続きを選択する。モデルはTask ID・期限・必要書類の独自定義を作らない。確定済み業務資料がないため、本番Templateは同梱していない。

- 最新の完全な提案/訂正/承認履歴を取得し、手動Task・過去に提案された同名の手続きを重ねて提案しない。前提は同一Entityの指定状態・値が揃った場合だけ満たす。
- Templateの期限・機関・取得済み根拠とContextの鮮度を検証する。本人の判断が必要な点は質問に残す。
- 依存先は既存Taskだけ。所属・循環・欠落を検証する。新規Task間の依存は正式IDが返るまで作らない。
- 必要書類と依存はProposalのpayloadに含める。Backendが承認時に再検証し、正式Taskへ反映する。Taskの直接作成・承認・完了はAIの権限にない。

`planning-execution-v1` と `createPlanningHandler` が候補生成→1件の正式提案→永続承認待ち→別attemptでの再開→正式版/hashの確認→Backendへの結果報告を接続する。最初に承認されたTaskが案件状態を変えるため、残りの候補を古いContextで連続適用しない。残り・質問・却下・変更がある場合はNEEDS_ATTENTION。次の新Runで最新状態から再計画する。

WAIT再開は保存済み計画を使用し、Orch/Agent/提案送信を繰り返さない。新しいattemptへSnapshotをforkするのはRuntimeの認可と所有権確認後だけ。実行途中のRETRY/CHECKPOINTは未定義の再適用を避けるため拒否する。Provider/Orch/Templateが未提供の既定プロセスでは503を維持する。

検証: 実Mastraの2 Agent fixture、既存/過去案の重複抑止、前提不足、別Case依存、独自期限拒否。Firestore統合試験で承認時の必要書類/依存反映と不明/循環依存の拒否を検証。

承認待ちを跨ぐ際は、保存したTemplate設定hashと根拠/Templateの有効期限を再照合する。改定・期限切れがある場合は正式な適用結果がAPPLIEDでもNEEDS_ATTENTIONとする。確定済みBackend変更を巻き戻したり、古い根拠を使って自動的に別の提案を送ったりしない。
