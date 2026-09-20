# チャットWorkflow

`chat-reply-v1`は認可済みのuser messageを取得し、コア＋検索の2 Agentで根拠付き説明または確認質問を作る。
事実説明は段落ごとに取得済みsourceIdを要求する。説明を含む場合は許可済み調査の完了記録も必要とする。
調査が不要な確認質問だけなら外部検索を実行しない。コアの会話や利用者の本文は検索Agentへ転送しない。

報告前にBackendの取消、Context版/hash、有効期限、資料の鮮度を再検証する。
paragraphs/questions/出典からハーネスが本文を組み立て、既存の`chat_reply`契約のbody/professionalNoticeへ送る。
フロントのルート・表示・MSW fixtureは変更しない。引用先との参照整合は検査するが、文章の意味が根拠に支えられているかは品質評価も必要。

Orch route、Provider policy、Source Catalog、共有予算を持つ実Handlerへの接続は別段階。
このWorkflowにはProposal/承認/正式変更Toolを登録しない。専門家の判断を代行せず、noticeの表示を引継ぎ実行済みとは扱わない。

実Mastraの確認質問・調査/引用・非転送と、古いContext/未取得根拠での報告拒否を合成fixtureで検証する。
