# nas-llm — developer and agent entry points.
#
# `make check` is the verification loop. It is what CI runs and what an agent
# should run before claiming a change works. See AGENTS.md.

BACKEND := backend
TAURI   := desktop/src-tauri

.DEFAULT_GOAL := help

.PHONY: help check check-backend check-desktop fmt fmt-check vet test run-backend

help: ## Show the available targets
	@echo "nas-llm targets:"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Note: 'make check' does not cover www/ (no build step) and runs no"
	@echo "end-to-end tests. UI and streaming changes need a human on the NAS."

check: check-backend check-desktop ## Run every automated check (Go + Rust)

check-backend: fmt-check vet test ## Go: gofmt, vet, and tests

fmt-check: ## Fail if any Go file needs gofmt
	@out="$$(cd $(BACKEND) && gofmt -l .)"; \
	if [ -n "$$out" ]; then \
		echo "gofmt needed on:"; echo "$$out"; \
		echo "run 'make fmt' to fix"; \
		exit 1; \
	fi; \
	echo "gofmt: clean"

fmt: ## Rewrite Go files with gofmt
	cd $(BACKEND) && gofmt -w .

vet: ## Run go vet
	cd $(BACKEND) && go vet ./...

test: ## Run the Go test suite
	cd $(BACKEND) && go test ./...

check-desktop: ## Type-check + test the Tauri sidecar (Rust)
	@command -v cargo >/dev/null 2>&1 || { \
		echo "cargo not found — install Rust via https://rustup.rs"; \
		echo "(see desktop/README.md); skipping the desktop check"; \
		exit 1; \
	}
	cd $(TAURI) && cargo check && cargo test

run-backend: ## Run the backend locally on :8081 against a local Ollama
	cd $(BACKEND) && \
		SESSION_SECRET=$${SESSION_SECRET:-dev-secret} \
		DB_PATH=$${DB_PATH:-./dev.db} \
		OLLAMA_URL=$${OLLAMA_URL:-http://127.0.0.1:11434} \
		BACKEND_PORT=$${BACKEND_PORT:-8081} \
		go run .
