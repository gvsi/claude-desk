.PHONY: kernel test db-roles web-test web-e2e image image-check infra-check image-smoke evals-unit evals-tier1 evals-tier1-stub evals-tier1-kernel evals-tier1-api kernel-serve proofs check-presets

# Rebuild the kernel's Python module into the backend environment, and the
# proof binary the kernel runs. desk-prove and its tests find cvc5 through
# CVC5 or PATH.
kernel:
	cd backend && uv sync --reinstall-package desk-kernel
	cd kernel && cargo build --release --locked -p desk-prove

# The kernel process on 127.0.0.1:8701 (`python -m desk.kernel_service`), with the settings in .env.
kernel-serve:
	cd backend && uv run --env-file ../.env python -m desk.kernel_service

test:
	cd kernel && cargo test --locked
	cd backend && uv run pytest

# Prove the Rivera seed's cards and the starter presets with desk-prove and write their reports to
# kernel/cedar/proofs/, which the kernel activates them from (run it in any commit that changes
# cards, adapter profiles, the schema, baseline, invariants, compiler output or thresholds).
# check-presets proves them again and fails unless every shipped report matches; CI runs it.
# Both need cvc5 (CVC5 or PATH) and desk-prove (DESK_PROVE, by default the release build).
DESK_PROVE ?= $(CURDIR)/kernel/target/release/desk-prove
proofs:
	cd backend && DESK_PROVE="$(DESK_PROVE)" uv run python -m scripts.prove_presets

check-presets:
	cd backend && DESK_PROVE="$(DESK_PROVE)" uv run python -m scripts.prove_presets --check

# Let the kernel, API and mock payments roles log in, with the passwords in .env (or the
# environment). Passwords reach psql as environment variables and are never echoed or put on
# a command line. Uses the host's psql when there is one, else the one in the compose db service.
DB_HOST ?= localhost
DB_PORT ?= 5433
db-roles: DB_NAME ?= desk
db-roles:
	@if [ -f .env ]; then set -a; . ./.env; set +a; fi; \
	for name in DESK_ADMIN_PASSWORD KERNEL_ROLE_PASSWORD API_ROLE_PASSWORD MOCKPAY_ROLE_PASSWORD; do \
		eval "value=\$${$$name:-}"; \
		if [ -z "$$value" ]; then echo "db-roles: $$name is not set (copy .env.example to .env)" >&2; exit 1; fi; \
	done; \
	if command -v psql >/dev/null 2>&1; then \
		PGPASSWORD="$$DESK_ADMIN_PASSWORD" psql -X -q -h "$(DB_HOST)" -p "$(DB_PORT)" -U desk_admin -d "$(DB_NAME)" \
			-f backend/desk/db/role_passwords.psql; \
	else \
		docker compose exec -T -e KERNEL_ROLE_PASSWORD -e API_ROLE_PASSWORD -e MOCKPAY_ROLE_PASSWORD \
			db psql -X -q -U desk_admin -d "$(DB_NAME)" < backend/desk/db/role_passwords.psql; \
	fi

# The web app's checks, as CI's `web tests` runs them: install, type-check and unit tests, then the
# production build, its check and the mocked end-to-end test (which uses web-test's install).
web-test:
	cd web && npm ci && npx playwright install --with-deps chromium && npm run typecheck && npm test

web-e2e:
	cd web && npm run build && npm run check:build && npm run e2e:mock

# The app image, linux/arm64: the kernel image (kernel/Dockerfile), then the backend layered on it
# (infra/app.Dockerfile). Needs a buildx builder on the `docker` driver (Docker's default), which
# sees the local desk-kernel:$(KERNEL_TAG). KERNEL_TAG tags both images; deploy.sh passes the commit,
# so a build in another checkout, which shares the Docker daemon, can't take its place.
KERNEL_TAG ?= dev
APP_IMAGE ?= desk-app:$(KERNEL_TAG)
image:
	docker buildx build --load --platform linux/arm64 -f kernel/Dockerfile -t desk-kernel:$(KERNEL_TAG) .
	docker buildx build --load --platform linux/arm64 -f infra/app.Dockerfile \
		--build-arg KERNEL_IMAGE=desk-kernel:$(KERNEL_TAG) -t $(APP_IMAGE) .

# What the app image must hold, and must not. Checks whose code hasn't landed yet (the API, the
# kernel service's compiler, the proof reports) say they are skipped; once it exists they run.
SHA256 := $(shell command -v sha256sum >/dev/null 2>&1 && echo sha256sum || echo "shasum -a 256")
image-check:
	@set -eu; \
	fail() { echo "image-check: $$*" >&2; exit 1; }; \
	run() { docker run --rm "$(APP_IMAGE)" "$$@"; }; \
	uid=$$(run id -u); \
	[ "$$uid" = 10001 ] || fail "runs as uid $$uid, not 10001 (desk)"; \
	echo "image-check: runs as uid 10001"; \
	leaked=$$(run find /app -name '.env*' -o -path /app/backend/tests -o -path /app/evals -o -path /app/web \
		-o -name .git -o -name node_modules -o -name .venv); \
	[ -z "$$leaked" ] || fail "the image holds files it must not: $$leaked"; \
	run sh -c '! command -v uv >/dev/null' || fail "uv was left in the image"; \
	echo "image-check: no .env, tests, evals, web or uv"; \
	run python -c "import desk, desk_kernel"; \
	echo "image-check: desk and desk_kernel import"; \
	if [ -f backend/desk/api/main.py ]; then run uvicorn --version; \
	else echo "image-check: skipped uvicorn, no backend/desk/api/main.py yet"; fi; \
	run desk-prove --selftest; \
	run --self-check; \
	if [ -f backend/desk/kernel_service/compiler.py ]; then \
		cedar=$$(run python -c "from desk.kernel_service.compiler import CEDAR_DIR; print(CEDAR_DIR)"); \
		[ "$$cedar" = /app/kernel/cedar ] || fail "CEDAR_DIR is $$cedar, not /app/kernel/cedar"; \
		echo "image-check: CEDAR_DIR is /app/kernel/cedar"; \
	else echo "image-check: skipped CEDAR_DIR, no backend/desk/kernel_service/compiler.py yet"; fi; \
	if [ -d kernel/cedar/proofs ]; then \
		ls kernel/cedar/proofs/*.json >/dev/null 2>&1 || fail "kernel/cedar/proofs holds no reports"; \
		want=$$(cd kernel/cedar/proofs && $(SHA256) -- *.json | LC_ALL=C sort -k2); \
		got=$$(run sh -c 'cd /app/kernel/cedar/proofs && sha256sum -- *.json' | LC_ALL=C sort -k2); \
		[ "$$want" = "$$got" ] || fail "the image's proof reports differ from kernel/cedar/proofs: rebuild with make image"; \
		echo "image-check: proof reports match kernel/cedar/proofs ($$(echo "$$want" | wc -l | tr -d ' ') files)"; \
	else echo "image-check: skipped the proof reports, no kernel/cedar/proofs yet"; fi; \
	echo "image-check: ok"

# The app image run as the deploy runs it, against the compose Postgres (`docker compose up -d db`
# first): the admin task, then the kernel and the API in production mode in one network namespace,
# each with only its own environment and secrets. Passes when api_health passes, mock payments
# answers inside the kernel's container (skipped, and said so, until backend/desk/mockpay/server.py
# exists), and from outside the namespace the API's 8700 connects (the positive control) while the
# kernel's 8701 refuses.
# The admin task migrates DB_NAME when given, else the database .env's ADMIN_DATABASE_URL names.
image-smoke:
	APP_IMAGE="$(APP_IMAGE)" DB_NAME="$(DB_NAME)" infra/scripts/image_smoke.sh

# The CDK stacks: the CloudFront function's tests (Node 24 expands the quoted glob itself and no
# longer searches a directory argument), the stacks' tests, then a synth of every stack (synth
# takes them all when none is named; it has no --all). Synth only stages the image's build context
# and the web build, and builds nothing; it needs no AWS credentials.
infra-check:
	cd infra && node --test 'functions/**/*.test.mjs' && uv run pytest -q && npm ci && npx cdk synth --quiet

# The docs check CI runs: relative links resolve across README.md, AGENTS.md and docs/, the shipped
# docs carry the required disclosures, and they and docs/images/*.svg carry no private reference.
# FINAL=1 also refuses placeholders ([measured: …], [owner: …]), for the docs as they ship.
.PHONY: docs-check
docs-check:
	uv run --project tools python -m desk_tools.check_docs $(if $(FINAL),--final)

.PHONY: cvc5 setup dev
# cvc5 1.4.2, the static build for this machine, checked against tools/cvc5.sha256 and unpacked to
# .tools/cvc5 (git-ignored). desk-prove finds it through CVC5 or PATH; make dev sets both.
CVC5_VERSION := 1.4.2
CVC5_DIR := $(CURDIR)/.tools/cvc5
cvc5:
	@set -eu; \
	case "$$(uname -s)-$$(uname -m)" in \
		Darwin-arm64) build=cvc5-macOS-arm64-static ;; \
		Darwin-x86_64) build=cvc5-macOS-x86_64-static ;; \
		Linux-x86_64) build=cvc5-Linux-x86_64-static ;; \
		Linux-aarch64 | Linux-arm64) build=cvc5-Linux-arm64-static ;; \
		*) echo "cvc5: no build is pinned for $$(uname -s) $$(uname -m)" >&2; exit 1 ;; \
	esac; \
	if [ -x "$(CVC5_DIR)/bin/cvc5" ] && "$(CVC5_DIR)/bin/cvc5" --version | head -n 1 | grep -q "^cvc5 $(CVC5_VERSION) "; then \
		echo "cvc5: $(CVC5_VERSION) is already in .tools/cvc5"; exit 0; \
	fi; \
	tmp=$$(mktemp -d); trap 'rm -rf "$$tmp"' EXIT; \
	grep " $$build.zip\$$" tools/cvc5.sha256 > "$$tmp/cvc5.sha256" \
		|| { echo "cvc5: tools/cvc5.sha256 has no line for $$build.zip" >&2; exit 1; }; \
	curl -sSfL -o "$$tmp/$$build.zip" "https://github.com/cvc5/cvc5/releases/download/cvc5-$(CVC5_VERSION)/$$build.zip"; \
	(cd "$$tmp" && $(SHA256) -c cvc5.sha256 >/dev/null) \
		|| { echo "cvc5: $$build.zip doesn't match its sha256 in tools/cvc5.sha256" >&2; exit 1; }; \
	unzip -q "$$tmp/$$build.zip" -d "$$tmp"; \
	rm -rf "$(CVC5_DIR)"; mkdir -p "$$(dirname "$(CVC5_DIR)")"; mv "$$tmp/$$build" "$(CVC5_DIR)"; \
	echo "cvc5: $$("$(CVC5_DIR)/bin/cvc5" --version | head -n 1), in .tools/cvc5"

# Everything a fresh clone needs to run Claude Desk (see the README's "Run it locally"): the Python
# projects, the web app's packages, the kernel's module and proof binary, cvc5, a .env copied from
# .env.example when there is none (Docker Compose reads it too), Postgres in Docker, the migrations
# and the roles' passwords.
setup:
	cd backend && uv sync
	cd tools && uv sync
	cd infra && uv sync
	cd web && npm ci
	$(MAKE) kernel cvc5
	@if [ -f .env ]; then echo "setup: keeping the .env there is"; \
	else cp .env.example .env && echo "setup: wrote .env from .env.example"; fi
	docker compose up -d --wait db
	cd backend && uv run alembic upgrade head
	$(MAKE) db-roles

# Claude Desk on this machine: the kernel (make kernel-serve, 127.0.0.1:8701), the API (make
# api-serve, 127.0.0.1:8700) and the web app (Vite, which sends /api to the API), with the release
# desk-prove and .tools/cvc5 on PATH and CVC5 set. It stops first if either is missing: without
# them the kernel would run in bounded mode, where no owner rule goes live. Ctrl-C, or any of the
# three exiting, stops all three. Until the kernel service, the API and the web app have landed, it
# names what is missing.
dev:
	@set -eu; \
	missing() { echo "dev: $$1 isn't in this checkout yet; it lands with $$2" >&2; exit 1; }; \
	$(MAKE) -n kernel-serve >/dev/null 2>&1 || missing "make kernel-serve" "the kernel service"; \
	$(MAKE) -n api-serve >/dev/null 2>&1 || missing "make api-serve" "the API"; \
	grep -q '"dev":' web/package.json || missing "the web app's dev script" "the web app"; \
	[ -x "$(CVC5_DIR)/bin/cvc5" ] || { echo "dev: no cvc5 in .tools/cvc5; run make setup first" >&2; exit 1; }; \
	[ -x "$(CURDIR)/kernel/target/release/desk-prove" ] || { echo "dev: no desk-prove in kernel/target/release; run make setup first" >&2; exit 1; }; \
	PATH="$(CURDIR)/kernel/target/release:$(CVC5_DIR)/bin:$$PATH"; CVC5="$(CVC5_DIR)/bin/cvc5"; export PATH CVC5; \
	killtree() { for child in $$(pgrep -P "$$1" 2>/dev/null); do killtree "$$child"; done; kill -TERM "$$1" 2>/dev/null || true; }; \
	pids=""; \
	stop() { trap - INT TERM EXIT; for pid in $$pids; do killtree "$$pid"; done; wait 2>/dev/null || true; }; \
	trap stop EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; \
	$(MAKE) --no-print-directory kernel-serve </dev/null & pids="$$pids $$!"; \
	$(MAKE) --no-print-directory api-serve </dev/null & pids="$$pids $$!"; \
	(cd web && exec npm run dev) </dev/null & pids="$$pids $$!"; \
	while :; do \
		for pid in $$pids; do \
			kill -0 "$$pid" 2>/dev/null || { echo "dev: one of the three stopped; stopping the others" >&2; exit 1; }; \
		done; \
		sleep 1; \
	done

# Tier 1 evals: the kernel's boundary cases, with no model calls, no network and no key.
# evals-tier1 is the one tier 1 target CI runs: the harness's own tests, every case against the
# contract stub, then the real kernel in-process (the API over it once landed.toml lists 02a or
# 02). The kernel and API runs need the database, `make kernel` and cvc5. The kernel they start
# proves with the desk-prove DESK_PROVE names, else the one on PATH, and desk-prove runs the cvc5
# CVC5 names, else the one on PATH. When either isn't set in the environment or on make's command
# line, they pass this checkout's own file for it if that file exists: the release build (`make
# kernel`) as DESK_PROVE, and .tools/cvc5 (`make setup` or `make cvc5`) as CVC5. So after `make
# setup` and `make kernel` a local run proves in symcc mode with neither on PATH. A DESK_PROVE or
# CVC5 that is set is left as it is; CI sets its own CVC5 and puts the same desk-prove build on
# PATH, so it proves with the same binaries.
EVALS = uv run --project backend --group evals
DESK_PROVE ?= $(CURDIR)/kernel/target/release/desk-prove
CVC5 ?= $(CVC5_DIR)/bin/cvc5
# $(call tier1_default,NAME): NAME="<its default above>" when nothing outside the Makefile set NAME
# and that file exists, else nothing.
tier1_default = $(if $(filter file,$(origin $(1))),$(if $(wildcard $($(1))),$(1)="$($(1))" ))
TIER1_PROVE = $(call tier1_default,DESK_PROVE)$(call tier1_default,CVC5)

evals-unit:
	$(EVALS) pytest evals/tests -q

evals-tier1-stub:
	$(EVALS) python -m evals.run tier1 --target stub

evals-tier1-kernel:
	$(TIER1_PROVE)$(EVALS) python -m evals.run tier1 --target kernel

evals-tier1-api:
	$(TIER1_PROVE)$(EVALS) python -m evals.run tier1 --target api

evals-tier1:
	$(MAKE) evals-unit
	$(MAKE) evals-tier1-stub
	@if $(EVALS) python -c 'import sys; from evals.tier1.harness import API_PLANS, load_landed; sys.exit(not set(API_PLANS) & set(load_landed()))'; then \
		$(MAKE) evals-tier1-api; \
	else \
		$(MAKE) evals-tier1-kernel; \
	fi
