# Entity別Proposalの入力

#40 / #42 のBackend適用契約。すべて人の承認を必須とし、public APIはsource/agentRunIdを受け付けない。
内部AI提出とlease/fencingの接続は #36 / #41。ここでAI実行の接続完了を宣言しない。

## 財産・債務・契約・関係者

`payload` は以下のどちらか。UPDATEも全入力値を明示する。承認後の補正、推測、追加生成はしない。
対象の版が変わっていれば409 `TARGET_VERSION_CHANGED` とし、提案をSTALEにする。

```json
{"operation":"CREATE","fields":{"name":"架空銀行口座","kind":"BANK","institution":"架空銀行","amount":null,"taxAttention":false,"note":null}}
```

```json
{"operation":"UPDATE","targetId":"asset-id","expectedVersion":1,"fields":{"name":"訂正した名称","kind":"BANK","institution":"架空銀行","amount":1234,"taxAttention":false,"note":null}}
```

| kind | fields（すべて必須。任意の不明値はnull） |
|---|---|
| ASSET_PROPOSAL | name, kind, institution, amount, taxAttention, note |
| LIABILITY_PROPOSAL | name, kind, creditor, amount, note |
| CONTRACT_PROPOSAL | name, kind, provider, note |
| PERSON_PROPOSAL | name, nameKana, relationshipLabel, role, isHeir, dateOfBirth, specialCircumstance, contact, note |

種別は各Entityと同じ列挙値。金額は円の整数で、不明のnullと0を区別する。
財産・債務は適用後もUNCONFIRMED。承認は入力候補を登録する許可で、法的・税務判断や別の確認Commandを代替しない。
契約作成は方針UNDECIDED／進捗NOT_STARTED。訂正でも既存の方針・進捗を勝手に変えない。
関係者のisHeirは申告であり法定相続人の判定ではない。適用元の提案・版・hashは監査に残る。

## Taskに対する提案

各payloadには `taskId` と `expectedTaskVersion` が必須。別Caseの対象を参照できない。

| kind | 追加フィールド | 承認後の作用 |
|---|---|---|
| DOCUMENT_REQUEST | documents: [{id, label}]（1〜50件） | 必要書類を追加しWAITING_DOCUMENTSへ。TaskはCOLLECTING_INFORMATIONまたはWAITING_DOCUMENTSが必要 |
| EVIDENCE_PROPOSAL | label, kind, note（nullable）, document（{id,version}またはnull） | 根拠だけを保存。Task完了は別Command |
| ESCALATION_PROPOSAL | reason, documents: [{id,version}]（最大20件） | 許可された遷移からESCALATEDへ。理由・資料参照を保存しcontacted:falseを返す |

書類参照は所属・版・STORED・非archiveを同じTransactionで検証する。
引継ぎは状態と資料の記録だけであり、外部連絡・送付・依頼は行わない。
根拠の記録と書類の外部AI配信許可は別。未検査の書類でも人の手動管理は可能だがAI配信してよいことにはならない。
