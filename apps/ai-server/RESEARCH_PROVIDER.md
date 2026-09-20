# 公式資料Catalog Provider

対象: #55。レビュー済みCatalog内の候補検索とHTTPSでの本文取得を実装する。
外部検索サービスの選定や全Web検索の代用とは扱わない。実業務のCatalogはまだ登録していない。

Catalogは版・reviewReference・確認日時・失効日時・許可ホスト・登録済みURL・機関名・検索keywordを持つ。
候補検索はこのmetadataだけを対象に最大10件返す。検索語や案件情報を外部検索サービスへ送らない。
取得はCatalog内のID/URL/機関等が完全一致する候補に限る。取得前後にレビュー期限を再検証する。
レビュー記録のSchema検証は資料内容の正しさの証明ではない。実登録には担当者の確認済み資料が必要。

HTTPSの443だけを許可し、ホストを完全一致で照合する。認証・query・fragment・IP直指定を拒否する。
DNSの全IPv4応答を検査し、private/link-local/shared/documentation/multicast等の特別用途範囲を拒否する。
検査済みIPをsocket lookupに固定し、元hostnameのTLS証明書検証を維持する。共有Agent/proxyとredirectは使わない。
IPv6のみの配信先、動的query URL、PDF、非UTF-8、圧縮配信は対応範囲外として拒否する。

DNSを含め最大10秒、受信512KiB、抽出後60000文字まで。HTMLはparse5で解析しscript/style/埋込/form等を除外する。
JavaScript実行・ブラウザ操作・Cookie・原本Storageアクセスはない。本文は非信頼データであり、命令として扱わない。
切り詰めた本文を全文として返さず、上限超過はエラーにする。取得日時と更新日時を混同せず、更新日時未検証はnull。
本文hash/保管期間/引用箇所精度と業務適用条件の評価は後続で拡張する。

検証: 合成Catalogでscope/同一性/失効、DNS混在応答・IP固定、redirect/binary/圧縮/巨大/不正UTF-8拒否、HTML抽出。
`https://example.com/`への実HTTPS取得も確認（本文559bytes）。これは業務資料のレビューや実検索製品の接続証明ではない。

参照: [Node HTTPS](https://nodejs.org/api/https.html)、[parse5](https://parse5.js.org/)、
[IANA IPv4特別用途アドレス](https://www.iana.org/assignments/iana-ipv4-special-registry)。採用実行環境はNode22。
