# P-02 書類候補の確認

`document-review-v1` は加工済みテキストの配信→抽出Tool→最新配信の再確認→候補/矛盾/不足の整理を行う。抽出Toolは業務Agentを追加しない。候補は常に `extracted_candidate` / `NEEDS_REVIEW` で、人の訂正を上書きしない。

配信Portはcase/run/document版に拘束され、検査対象版・マスキングPolicy版・加工Artifact版/hash・期限・サイズを検証する。抽出位置はUTF-16 offsetの[start,end)で、ページ内の完全一致引用と値の包含を検証する。意味的な項目対応やOCRの正確さは別途評価が必要。

抽出後にもBackendへ配信を要求し、同意撤回・版変更・案件訂正があれば破棄する。元の値・訂正フラグ・不足・不鮮明を保持する。正式登録は行わない。

現行Backendは加工済み書類を配信せず、`document_analysis` のContextも未提供。そのため、このPortを既存Artifact APIに偽装して接続しない。実OCR、PDF/画像処理、配信認可、Field→Proposalの業務レビュー済み対応、正式登録への接続が揃うまでHTTP有効化はしない。合成テキスト試験は実PDF/画像OCRの精度を示さない。
