DB_PORT     ?= 5433
TEST_DB_URL ?= postgres://pos:pos@localhost:$(DB_PORT)/postgres?sslmode=disable
DEV_DB_URL  ?= postgres://pos:pos@localhost:$(DB_PORT)/pos?sslmode=disable

.PHONY: help db test test-go test-web check dev-server dev-web build up down e2e

help: ## List targets
	@grep -E '^[a-z0-9-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

db: ## Start Postgres in Docker and wait until it's healthy
	docker compose up -d --wait db

test: test-go test-web ## Run every Go and web test

test-go: db ## Go unit and integration tests (against the compose Postgres)
	POS_TEST_DATABASE_URL='$(TEST_DB_URL)' go test ./...

test-web: ## Web unit and component tests
	cd web && npm test

check: ## Static checks: go vet and the TypeScript compiler
	go vet ./...
	cd web && npm run typecheck

dev-server: db ## Run the Go server on :8080 with demo data
	DATABASE_URL='$(DEV_DB_URL)' POS_DEMO=1 POS_DEMO_ENROLL_CODE=DEMO go run ./cmd/posd

dev-web: ## Run the Vite dev server on :5173 (proxies /api to :8080)
	cd web && npm run dev

build: ## Build the web app and the server binary into bin/
	cd web && npm run build
	CGO_ENABLED=0 go build -o bin/posd ./cmd/posd

up: ## Build and run the whole stack in Docker on :8080
	docker compose up --build -d --wait

down: ## Stop the stack
	docker compose down

e2e: up ## Playwright end-to-end tests against the Docker stack
	cd web && npx playwright test
