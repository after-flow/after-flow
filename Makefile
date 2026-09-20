.DEFAULT_GOAL := help
COMPOSE ?= docker compose
PNPM ?= pnpm

.PHONY: help up down build logs ps restart check install dev

help: ## コマンド一覧
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

up: ## Dockerで3サービスをビルド・起動（モック画面）
	$(COMPOSE) up --build --detach --wait

down: ## このプロジェクトのコンテナを停止・削除
	$(COMPOSE) down

build: ## Dockerイメージをビルド
	$(COMPOSE) build

logs: ## ログを表示（例: make logs SERVICE=web）
	$(COMPOSE) logs --follow $(SERVICE)

ps: ## コンテナの状態を確認
	$(COMPOSE) ps

restart: ## コンテナを再起動
	$(COMPOSE) restart

check: ## Docker内で型・Lint・依存境界・本番ビルドを検証
	$(COMPOSE) run --build --rm --no-deps -e VITE_USE_MOCK=false web sh -c 'pnpm typecheck && pnpm lint && pnpm build'

install: ## ローカル開発用の依存をインストール
	$(PNPM) install --frozen-lockfile

dev: ## ローカルで3サービスを起動
	$(PNPM) dev
