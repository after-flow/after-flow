.DEFAULT_GOAL := help
COMPOSE ?= docker compose
PNPM ?= pnpm

.PHONY: help up up-data data-check down build logs ps restart check install dev test test-firestore production-check

help: ## コマンド一覧
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

up: ## Dockerで3サービスをビルド・起動（モック画面）
	$(COMPOSE) up --build --detach --wait

up-data: ## Firestore・Cloud Storage Emulatorも含めて起動
	FIRESTORE_EMULATOR_HOST=firestore-emulator:8085 \
	DOCUMENT_STORAGE_ROOT= \
	DOCUMENT_STORAGE_BUCKET=$${DOCUMENT_STORAGE_BUCKET:-after-flow-documents} \
	DOCUMENT_STORAGE_EMULATOR_ENDPOINT=http://storage-emulator:4443 \
	STORAGE_PROJECT_ID=$${STORAGE_PROJECT_ID:-after-flow-local} \
	$(COMPOSE) --profile data up --build --detach --wait

data-check: ## 起動中のFirestore・Storage疎通とBackend/AI分離を検証
	$(COMPOSE) --profile data exec -T backend-server pnpm --filter @aftercare/backend-server exec tsx /workspace/scripts/smoke-data-emulators.mjs
	$(COMPOSE) --profile data exec -T ai-server node -e 'const bad=Object.keys(process.env).filter((key)=>/^(FIRESTORE_|GOOGLE_APPLICATION_CREDENTIALS|STORAGE_|DOCUMENT_STORAGE_)/.test(key));if(bad.length)throw new Error(`AI received forbidden data settings: $${bad.join(", ")}`)'

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
