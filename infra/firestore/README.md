# 業務 Firestore の設定

Backend Server だけが接続する業務用 Firestore の設定です。AI Server へはこの接続設定を渡しません。

## Security Rules

`firestore.rules` はクライアント SDK からの直接アクセスをすべて拒否します。Web の業務通信は Backend の公開 API のみを経由します。

Server SDK は Security Rules を迂回します。このファイルがあることをもって認可が実装済みとは扱いません。Case membership と操作ごとの権限は Application 層で検証します（#6）。

## Index

`firestore.indexes.json` には、実際に発行する Query に対応する複合 index だけを登録します。現時点の一覧取得は単一コレクションの `orderBy` と文書 ID による同値解決だけで、Firestore の自動 index で足ります。

`where` を伴う一覧を追加する Issue が、その Query に必要な index をここへ追加します。

## Emulator

テストは Emulator に対して実行します。実 Firestore の資格情報は不要です。

```sh
pnpm test:firestore
```

Emulator は Docker コンテナで起動します。ホストへの Java の導入は不要です。詳細は `scripts/with-firestore-emulator.mjs` を参照してください。
