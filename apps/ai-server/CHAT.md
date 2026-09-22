# チャットWorkflow

`chat-reply-v1`は認可済みのuser messageを取得し、ハーネスが毎回、承認済みSource Catalogを検索する。
上位3件の公式資料を取得し、検索Agentが逐語引用を検証可能な調査結果にする。利用者の本文は検索Agentへ転送しない。
コアAgentは検証済みの調査結果だけから、質問への直接回答を作る。一部の調査項目が未解決でも、根拠を確認できた範囲は回答し、内部の調査IDは表示しない。

報告前にBackendの取消、Context版/hash、有効期限、資料の鮮度を再検証する。
paragraphs/questions/出典からハーネスが本文を組み立て、既存の`chat_reply`契約のbody/professionalNoticeへ送る。
フロントのルート・表示・MSW fixtureは変更しない。引用先との参照整合は検査するが、文章の意味が根拠に支えられているかは品質評価も必要。

接続モードではOrch route、Provider policy、Source Catalog、共有予算を実Handlerが適用する。
このWorkflowにはProposal/承認/正式変更Toolを登録しない。専門家の判断を代行せず、noticeの表示を引継ぎ実行済みとは扱わない。

実Mastraの確認質問・調査/引用・非転送と、古いContext/未取得根拠での報告拒否を合成fixtureで検証する。
