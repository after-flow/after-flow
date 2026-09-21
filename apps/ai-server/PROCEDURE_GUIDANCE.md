# P-01 手続き案内

関連: #55 / #56 / #59。機能をMastra Workflowとして実装し、合成モデル・資料で検証する段階。
本番HTTPからの有効化はまだ行わない。

```text
永続Worker（後続）
  -> Backend control
  -> 許可済みPolicy選択とOrcaRouter利用証跡
  -> 最新Contextを取得・検証
  -> 対応する手続き/機関/地域を確認
  -> コア -> 検索Agent -> 検索候補 -> 元資料取得
  -> 各記述とsourceIdを持つ構造化案内
  -> control / 最新Context / 出典鮮度を再確認
  -> Backend result API
```

## 実装した機能

- 対応するTaskタイトル・カテゴリ・提出先と自治体をレビュー済み設定で限定する。対応外ではモデル/検索を呼ばず、確認事項をPARTIALで返す。
- 検索・読取Toolは親の会話を受け取らず、アプリが付与したresearchBriefIdからscopeを解決する。
- Catalog外のURL/Host、未知の資料ID、取得時のID差替え、古い取得結果を拒否する。候補検索だけでは出典として利用できない。
- 検索6回、読取12回を区間内で制限し、各I/O前にBackend controlと外側の共有予算フックを呼ぶ。
- ProviderのI/Oには有限timeoutと中断Signalを渡し、Providerの元エラーをモデルへ返さない。
- 案内の提出先・必要書類・手順には取得済みsourceIdを必須化する。未確認項目が残る場合はPARTIALとする。
- 正式なContext proofはアプリ側で付与し、Backendの公開案内DTOへ変換して報告する。モデルにProposalや承認Toolを渡さない。
- Context版/hashが変わった場合、権限が撤回された場合、元資料が失効した場合は結果送信を止める。

## Portと有効化条件

`ProcedureGuidanceDependencies`へBackend Client、モデル、レビュー済みScope/Catalog、ResearchProvider、共有予算・認可フック、Orch結果ゲートを注入する。
`authorizeRoute`は実Orchの選択結果を検証し、利用証跡IDを返す責務。productionの成功固定Adapterは用意しない。
合成テストの`fixture-routing-receipt`を実Orch利用の証跡として扱わない。

`ResearchProvider`は取得処理を隔離するPort。開発Composeは協会けんぽのレビュー済みCatalog内検索と安全なHTML/PDF取得を接続する。任意Web検索は提供しない。
検索結果の取得前にDNS・redirect先・サイズ・形式を検証し、内部ネットワークへ接続させないことが実Adapterの必須条件。
今回のTool層のURL検査だけでSSRF対策が完了したと扱わない。

Workflow定義だけで再起動復旧とはしない。開発Composeでは永続保存・receipt・再開・累積予算をAI専用Emulatorへ接続した。本番では専用project/databaseとIAMを設定して同じ契約を検証する。
1 Step内のProvider/Agentは再実行され得るため、課金/再試行の上限を再開でリセットしない。結果生成後のStep出力を保存し、同一Actionの再送で本文を作り直さない。
Toolフック以外のSkill/委任/推論を含む全Run予算、PIIを除いたTracing、保持削除、ライブ評価は後続。

## 後続機能

- P-02 書類整理: Backendの実検査・加工版配信/OCR選定後。
- P-03 計画・変更提案: 訂正/却下履歴、本人意思、禁止事項の配信と永続実行接続後。
- P-04 保険請求準備: 対象機関の確認済み資料、P-02/P-03、承認・再開の接続後。

これらを未接続のまま有効にしたり、P-01だけでAI全体の完了と扱ったりしない。
