.DEFAULT_GOAL := help
COMPOSE ?= docker compose
PNPM ?= pnpm

.PHONY: help up up-data data-check health down build logs ps restart check install dev test test-firestore production-check dev-token dev-verify-email dev-seed dev-seed-demo

# ローカル開発用の認証・seed。USER は shell の変数と衝突するので DEV_ を付ける。
DEV_USER ?= demo-user
DEV_TENANT ?= after-flow-demo
# make dev-token / dev-verify-email / dev-seed-demo（Firebase Auth Emulator）用。
DEV_EMAIL ?= demo@example.com
DEV_PASSWORD ?= after-flow-dev-password

help: ## コマンド一覧
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

up: ## Dockerでアプリ3サービス・Backend Outbox worker・業務/AI Runtime/Storage Emulatorを起動
	FIRESTORE_EMULATOR_HOST=firestore-emulator:8085 \
	DOCUMENT_STORAGE_ROOT= \
	DOCUMENT_STORAGE_BUCKET=$${DOCUMENT_STORAGE_BUCKET:-after-flow-documents} \
	DOCUMENT_STORAGE_EMULATOR_ENDPOINT=http://storage-emulator:4443 \
	STORAGE_PROJECT_ID=$${STORAGE_PROJECT_ID:-after-flow-local} \
	$(COMPOSE) --profile data up --build --detach --wait --wait-timeout 120
	$(MAKE) dev-seed-demo

up-data: up ## 互換エイリアス（make upと同じ）

data-check: ## 業務/AI Runtime/Storage疎通とBackend/Worker/AI分離を検証
	$(COMPOSE) --profile data exec -T backend-server pnpm --filter @aftercare/backend-server exec tsx /workspace/scripts/smoke-data-emulators.mjs
	$(COMPOSE) --profile data exec -T ai-server node -e 'const bad=Object.keys(process.env).filter((key)=>/^(FIRESTORE_|GOOGLE_APPLICATION_CREDENTIALS|STORAGE_|DOCUMENT_STORAGE_)/.test(key));if(bad.length)throw new Error(`AI received forbidden data settings: $${bad.join(", ")}`)'
	$(COMPOSE) --profile data exec -T ai-server node -e 'const h=process.env.AI_RUNTIME_EMULATOR_HOST;if(h!=="ai-runtime-emulator:8085")throw new Error("AI runtime endpoint mismatch");fetch(`http://$${h}/v1/projects/after-flow-ai-runtime/databases/ai-runtime-local/documents/__health`,{signal:AbortSignal.timeout(5000)}).then(r=>{if(!r.ok)throw new Error("AI runtime unavailable")})'
	$(COMPOSE) --profile data exec -T backend-worker node -e 'const bad=Object.keys(process.env).filter((key)=>/^(DOCUMENT_STORAGE_|STORAGE_|GOOGLE_APPLICATION_CREDENTIALS|BACKEND_INTERNAL_SERVICE_TOKEN|READINESS_ACCESS_TOKEN|ORCAROUTER_|AI_RUNTIME_)/.test(key));if(bad.length)throw new Error(`Worker received settings outside its role: $${bad.join(", ")}`);for(const key of ["OUTBOX_TENANT_IDS","FIRESTORE_PROJECT_ID","AI_SERVER_URL","AI_SERVICE_TOKEN","BACKEND_EXECUTION_SIGNING_KEY"])if(!process.env[key])throw new Error(`Worker is missing $${key}`)'

health: ## Frontend/Backend/AI Serverの既存health endpointをコンテナ内部から確認（AIはhost portを公開しないため）
	$(COMPOSE) --profile data exec -T web node -e 'fetch("http://127.0.0.1:5173",{signal:AbortSignal.timeout(5000)}).then(r=>{if(!r.ok)throw new Error(`web unhealthy: $${r.status}`)})'
	$(COMPOSE) --profile data exec -T backend-server node -e 'fetch("http://127.0.0.1:8080/api/v1/health",{signal:AbortSignal.timeout(5000)}).then(r=>{if(!r.ok)throw new Error(`backend-server unhealthy: $${r.status}`)})'
	$(COMPOSE) --profile data exec -T ai-server node -e 'fetch("http://127.0.0.1:8081/internal/v1/health",{signal:AbortSignal.timeout(5000)}).then(r=>{if(!r.ok)throw new Error(`ai-server unhealthy: $${r.status}`)})'
	@echo "web / backend-server / ai-server: health OK"

down: ## このプロジェクトのコンテナを停止・削除
	$(COMPOSE) --profile data down

build: ## Dockerイメージをビルド
	$(COMPOSE) --profile data build

logs: ## ログを表示（例: make logs SERVICE=web）
	$(COMPOSE) --profile data logs --follow $(SERVICE)

ps: ## コンテナの状態を確認
	$(COMPOSE) --profile data ps

restart: ## コンテナを再起動
	$(COMPOSE) --profile data restart

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

# make up 済み（data profileでfirebase-auth-emulatorが起動済み）が前提。
# --no-depsではfirebase-auth-emulatorへ到達できないため、execを使う。
dev-token: ## 開発用IDトークンを表示（要make up。例: make dev-token DEV_EMAIL=demo@example.com DEV_PASSWORD=...）
	@$(COMPOSE) --profile data exec -T backend-server node apps/backend-server/scripts/dev-firebase.mjs token \
	  --email "$(DEV_EMAIL)" --password "$(DEV_PASSWORD)"

dev-verify-email: ## Auth Emulator上のアカウントのメール確認を済ませる（要make up。例: make dev-verify-email DEV_EMAIL=demo@example.com）
	@$(COMPOSE) --profile data exec -T backend-server node apps/backend-server/scripts/dev-firebase.mjs verify-email \
	  --email "$(DEV_EMAIL)"

dev-seed: ## 開発用tenant memberをFirestore Emulatorへ作成（例: make dev-seed DEV_USER=demo-user）
	$(COMPOSE) --profile data exec -T backend-server pnpm --filter @aftercare/backend-server exec tsx \
	  /workspace/apps/backend-server/scripts/dev-seed.ts --user "$(DEV_USER)" --tenant "$(DEV_TENANT)"

# make up から自動実行される。固定のログイン情報（DEV_EMAIL/DEV_PASSWORD）を
# Auth EmulatorとFirestore Emulatorの両方に用意し、Web UIですぐログインできる状態にする。
# Auth Emulatorはコンテナ再作成で消えるため、make up 済みで毎回作り直す前提（冪等）。
dev-seed-demo: ## 固定デモアカウント（既定demo@example.com）をAuth Emulatorへ作成しtenant memberとして登録
	@DEMO_UID=$$($(COMPOSE) --profile data exec -T backend-server node apps/backend-server/scripts/dev-firebase.mjs uid \
	  --email "$(DEV_EMAIL)" --password "$(DEV_PASSWORD)") && \
	$(COMPOSE) --profile data exec -T backend-server node apps/backend-server/scripts/dev-firebase.mjs verify-email \
	  --email "$(DEV_EMAIL)" && \
	$(COMPOSE) --profile data exec -T backend-server pnpm --filter @aftercare/backend-server exec tsx \
	  /workspace/apps/backend-server/scripts/dev-seed.ts --user "$$DEMO_UID" --tenant "$(DEV_TENANT)"
