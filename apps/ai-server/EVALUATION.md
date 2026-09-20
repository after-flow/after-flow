# AIの評価

実モデルの品質評価と、決定的なハーネス検証を分ける。現在実行できるのは合成fixture評価と既存の実Mastra/HTTP/Firestore試験。実Orch・Provider・業務レビュー済み資料の評価は未実行で、fixture成功から本番品質やMVP完成を推定しない。

## 再実行

- `pnpm eval:ai`: development 24ケース×3回。通常PRのCIに含める。
- `pnpm eval:ai holdout`: 最終確認用8ケース×3回。手動CI `AI holdout evaluation` でも実行できる。結果を見てPrompt/Skillを反復調整しない。
- `pnpm --filter @aftercare/ai-server eval:compare /absolute/baseline.json /absolute/candidate.json`: 全試行のケース別差分。Dataset/Scorer/分割/反復数が違う場合、欠落/重複/未完了の試行がある場合は拒否する。

Mastra標準Datasets/Experiments/createScorerを使う。SDK標準のInMemory保存はこの合成評価だけで使用し、各試行後に`reports/ai-eval-{split}.json`へ保存する。製品RuntimeのFirestoreとは別。レポートにはcommit、未commit変更の有無、Dataset hash、Scorer版、Playbook版/hash、試行ID、期待/実結果、失敗区分、全試行の時間を残す。ファイルは通常Git管理せず、CIでは14日保持。入力はリポジトリの固定Datasetで再現できる。原本や実人物の情報・秘密情報を混ぜない。

## 判定

32ケースはP-02の引用位置/候補/訂正/欠落、P-04の資料/生成物/承認版、不足書類/候補情報、イベントInsightの対象版を扱う。架空資料だけを使い、法律や保険資格の正解を作らない。別Case・出典値捏造・旧検査版・訂正無視・無承認の準備完了は重大違反として扱う。

期待する状態と根拠のfield=value組を判定する。正常系も必須なので常時拒否は合格できない。不明な例外を期待された安全拒否と扱わない。Scorer自体へ捏造・欠落・無条件拒否・外部提出完了の変異を与えて失敗することを試験する。抽出precision/recallは合成の指定項目に限った値であり、OCRの意味的精度ではない。

全試行の契約一致が必要。重大違反を平均点で隠さず、Scorer失敗・未実行・中断・保存失敗も合格にしない。性能値はSDK処理を含むfixture試行のwall-clock p50/p95で、実LLM応答時間ではない。モデル・token・製品費用・評価LLM費用は未測定(null)。実運用の性能/費用の合格閾値は、選定Providerで同じ対象ケースを複数回測り、用途ごとのSLOと予算をレビューして別途固定する。測定後に不都合な試行を除外しない。

## 他の必須試験との対応

| 範囲 | 検証 |
|---|---|
| A-01〜A-04: 2 Agent、権限、案内、外部指示 | AI testのMastra Agent/Skill/Research/Guidance/Chat/Provider fixture |
| A-05〜A-06: Context・同意・版 | Context/HTTP/Policy/書類Workflowの否定試験、Backend Firestore試験 |
| A-07〜A-09: P-02〜P-04 | 本Dataset + Planning/Document/Insurance Workflow試験。実加工版/OCR/生成物保存は未接続 |
| A-10〜A-11: 復旧・共有予算 | Firestore永続Worker、プロセス強制終了/再開、Proposal・計画の承認待ち試験 |
| A-12: Orch/2 Provider | 2 ProviderのSDK fixtureは実施。実Orch/実Providerは未実行 |
| A-13: Backend/Web | 独立Backend/AIプロセスの実HTTPによるChat結果保存と重複配送、既存UIビルド/CI smoke |

実LLMの根拠の意味・適用条件・自然な確認質問・Prompt injection耐性、人と評価LLMの一致は未評価。Scorerへの入力だけで意味の正しさを保証しない。実モデル評価では固定資料と実Web、検索単体/コア単体/2 Agentを分け、同じケースを原則3回、認可・費用・時間上限内で実行する。実資格情報を外部PRへ渡さない。現在の手動CIも合成評価であり、実接続評価という名前で成功させない。
