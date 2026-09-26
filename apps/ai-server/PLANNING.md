# P-03 計画差分

`case-planning-v1` は既存のCore/Research 2 Agentを使い、レビュー済みTemplateから対応手続きを選択する。モデルはTask ID・期限・必要書類の独自定義を作らない。確定済み業務資料がないため、本番Templateは同梱していない。

- 最新の完全な提案/訂正/承認履歴を取得し、手動Task・過去に提案された同名の手続きを重ねて提案しない。前提は同一Entityの指定状態・値が揃った場合だけ満たす。
- Templateの期限・機関・取得済み根拠とContextの鮮度を検証する。本人の判断が必要な点は質問に残す。
- 依存先は既存Taskだけ。所属・循環・欠落を検証する。新規Task間の依存は正式IDが返るまで作らない。
- 必要書類と依存はProposalのpayloadに含める。Backendが承認時に再検証し、正式Taskへ反映する。Taskの直接作成・承認・完了はAIの権限にない。

`planning-execution-v1` と `createPlanningHandler` が候補生成→1件の正式提案→永続承認待ち→別attemptでの再開→正式版/hashの確認→Backendへの結果報告を接続する。最初に承認されたTaskが案件状態を変えるため、残りの候補を古いContextで連続適用しない。残り・質問・却下・変更がある場合はNEEDS_ATTENTION。回答または再試行で同じRunの新attemptを開始し、最新状態から再計画する。

WAIT再開は保存済み計画を使用し、Agent/提案送信を繰り返さない。新しいattemptへSnapshotをforkするのはRuntimeの認可と所有権確認後だけ。RETRYは共有予算内で最新Contextから再計画し、CHECKPOINTによる任意位置の再適用は拒否する。開発Composeはハッカソン用Provider/Templateを接続し、設定が無いプロセスでは503を維持する。

検証: 実Mastraの2 Agent fixture、既存/過去案の重複抑止、前提不足、別Case依存、独自期限拒否。Firestore統合試験で承認時の必要書類/依存反映と不明/循環依存の拒否を検証。

承認待ちを跨ぐ際は、保存したTemplate設定hashと根拠/Templateの有効期限を再照合する。改定・期限切れがある場合は正式な適用結果がAPPLIEDでもNEEDS_ATTENTIONとする。確定済みBackend変更を巻き戻したり、古い根拠を使って自動的に別の提案を送ったりしない。


## 停止・本人意思の再検証

案件の `planningRestriction` が非nullなら、Workflow・モデル・検索・Proposal・承認待ちを開始せず、
管理者への確認をWorkflowのquestionsに残し、BackendへNEEDS_ATTENTIONを報告する。
停止情報が欠落しているBackendや古いSnapshotから、新しい提案を送らない。
停止解除後は新Runで最新Contextから計画する。承認待ちからの再開でも最新の停止状態を確認し、
すでに反映済みの結果があっても停止中なら自動的にSUCCEEDEDとしない。

レビュー済みTemplateの前提を満たさない候補は、モデルが質問を出し忘れていても確認質問へ戻す。
本人が確定していない相続方法や別人の意思を、指定された本人の確認済み意思として扱わない。
これはTemplateに指定された前提の照合であり、AIが相続方法の正否を判断する機能ではない。

質問はWorkflow出力・Snapshot・Backendの実行結果に保持する。
質問の画面操作導線、個別手続きの禁止、OrcaRouter経由の実モデル・業務資料を使う受入は継続課題。

配置順はBackendの保存・提出防止PRを先行し、本変更でContext配信とAI側の検証を同時に更新する。
旧AIは追加Contextを拒否し、新AIは停止情報のない旧Backendを拒否するため、両サービスの版を揃える。


## 確認質問の結果保存と回答

計画のsummary/completed/questions/remainingを内部結果APIへ送信し、BackendのAgentRun.outcomeに保存する。
既存の実行取得APIで読める。`POST /cases/:caseId/agent-runs/:runId/answers` はexpectedVersion・resultId・questionIndex付きで回答を受ける。
回答はCase内の利用者Messageと申告履歴に保存し、同じRunの新attemptへOutbox配送する。質問の重複回答、古い結果、別案件、停止中の計画は拒否する。
一部の質問だけに答えた場合、未回答を次のContextへ残す。上限に達した履歴は切り捨てず拒否する。

再計画は古いSnapshotの途中位置へ戻らず、新しいContext・Task・訂正履歴から開始する。Runの共有予算は継続し、replansを消費する。
回答本文からCaseや本人Decisionを自動変更しない。確認済み事実が必要な前提は、既存の正式編集・本人確認APIで満たす必要がある。
フロントの画面操作導線は別作業だが、質問の取得と回答・再受付に必要なBackend APIは接続済み。
