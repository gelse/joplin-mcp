PNPM ?= pnpm

.PHONY: help install build dev start test test-watch test-integration lint format docker-build docker-up docker-down clean smoke-test measure-initial-sync

.DEFAULT_GOAL := help

help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies via pnpm
	$(PNPM) install

build: ## Build the TypeScript project
	$(PNPM) run build

dev: ## Run the development server with hot-reload
	$(PNPM) run dev

start: ## Start the production server
	$(PNPM) run start

test: ## Run all tests
	$(PNPM) run test

test-watch: ## Run tests in watch mode
	$(PNPM) run test:watch

lint: ## Lint source files with eslint
	$(PNPM) run lint

format: ## Format source files with prettier
	$(PNPM) run format

docker-build: ## Build Docker images
	docker compose build

docker-up: ## Start Docker Compose services
	docker compose up -d

docker-down: ## Stop Docker Compose services
	docker compose down

clean: ## Remove build artifacts (dist/)
	rm -rf dist/

smoke-test: ## Run smoke tests
	bash scripts/smoke-test.sh

test-integration: ## Run container-based integration tests
	bash scripts/run-integration-tests.sh

measure-initial-sync: ## Measure initial sync throughput (requires live Joplin Server)
	bash scripts/measure-initial-sync.sh
