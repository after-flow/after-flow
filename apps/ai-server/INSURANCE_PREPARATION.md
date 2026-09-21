# P-04 保険準備の判定

`insurance-claim-preparation-v1` はレビュー済み機関・手続きの定義と、認可済みBackend viewからチェックリスト・事実整理のmanifestを作る。新しい受取人・資格・期限・申請書本文は生成しない。

不足書類は正式Taskの必要書類IDに拘束したDOCUMENT_REQUEST候補へ変換する。未確認/本人申告/抽出候補の必須項目、未解決事項、承認待ちがあれば準備完了にしない。

READYには現在のmanifest hashと、Backendから取得した生成物ID/版/hash、承認対象ID/版/hashの一致が必要。資料・案件・Task・契約の版変更はhashを変え、古い承認を失効させる。Workflowは判定前に最新viewを再取得する。READYも外部提出・受理・給付を示さない。

未接続: 対象保険手続きの業務レビュー、Backend生成Artifactの保存/承認API、加工版書類配信、書類待ち・生成物承認待ちの実データ接続。生成物APIを既存のContext Artifact APIとして扱わない。本PRは判断ロジックとWorkflowの実装であり、P-04全体の提供開始ではない。
