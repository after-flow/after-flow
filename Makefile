.DEFAULT_GOAL := help
COMPOSE ?= docker compose
PNPM ?= pnpm

.PHONY: help up up-data down build logs ps restart check install dev test test-firestore production-check

help: ## コマンド一覧
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

up: ## Dockerで3サービスをビルド・起動（モック画面）
	$(COMPOSE) up --build --detach --wait

up-data: ## Firestore Emulatorも含めて起動（初回はイメージ取得に時間がかかる）
	FIRESTORE_EMULATOR_HOST=firestore-emulator:8085 \
	$(COMPOSE) --profile data up --build --detach --wait

down: ## このプロジェクトのコンテナを停止・削除
	$(COMPOSE) --profile data down

build: ## Dockerイメージをビルド
	$(COMPOSE) build

logs: ## ログを表示（例: make logs SERVICE=web）
	$(COMPOSE) logs --follow $(SERVICE)

ps: ## コンテナの状態を確認
	$(COMPOSE) ps

restart: ## コンテナを再起動
	$(COMPOSE) restart

check: ## Docker内で型・Lint・テスト・依存境界・本番ビルドを検証
	$(COMPOSE) run --build --rm --no-deps -e VITE_USE_MOCK=false web sh -c 'pnpm typecheck && pnpm lint && pnpm test && pnpm openapi:check && pnpm build'

production-check: ## 本番3イメージを起動してHTTP疎通・分離を検証（Node必要）
	COMPOSE_FILE=compose.production.yaml $(COMPOSE) up --build --detach --wait
	COMPOSE_FILE=compose.production.yaml node scripts/smoke-production.mjs

test: ## Emulatorを必要としないテスト
	$(PNPM) test

test-firestore: ## Firestore Emulatorを起動して統合テストを実行
	$(PNPM) test:firestore

install: ## ローカル開発用の依存をインストール
	$(PNPM) install --frozen-lockfile

dev: ## ローカルで3サービスを起動
	$(PNPM) dev
