.PHONY: kernel test db-roles db-throwaway web-deps web-test web-e2e image image-check infra-check image-smoke evals-unit evals-tier1 evals-tier1-stub evals-tier1-kernel evals-tier1-api kernel-contract api-serve kernel-serve proofs check-presets

# Run this worktree's tests/builds on the isolated SSM test machine (docs/testbox.md).
.PHONY: remote
remote:
	$(if $(strip $(value CMD)),,$(error remote: give CMD="make kernel"))
	tools/testbox/run sh -c '$(subst ','"'"',$(value CMD))'

# Rebuild the kernel's Python module into the backend environment, and the
# proof binary the kernel runs. desk-prove and its tests find cvc5 through
# CVC5 or PATH.
kernel:
	cd backend && uv sync --reinstall-package desk-kernel
	cd kernel && cargo build --release --locked -p desk-prove

# The kernel process on 127.0.0.1:8701 (`python -m desk.kernel_service`), with the settings in .env.
kernel-serve:
	cd backend && uv run --env-file ../.env python -m desk.kernel_service

# The kernel's and the backend's tests, with .tools/cvc5 as CVC5 unless CVC5 is set (as tier 1 does below).
test:
	cd kernel && $(call tier1_default,CVC5)cargo test --locked
	cd backend && $(call tier1_default,CVC5)uv run pytest

# The API's kernel contract tests against the real kernel, not only FakeKernel, for the kernel plans
# listed in evals/tier1/landed.toml: starts `make kernel-serve` with the kernel's development test hooks
# (its offline reviewer, and the release desk-prove when built), waits up to 30 s for its health check,
# prints its proof mode, runs the real_kernel variants and stops it. With no kernel plan landed it says
# so and exits 0.
kernel-contract:
	cd backend && uv run python -m tests.kernel_contract.real_kernel

# The API process on 127.0.0.1:8700, with the settings in .env, as the deploy runs it but bound to loopback.
# It reaches the kernel at KERNEL_URL (default http://127.0.0.1:8701): run `make kernel-serve` beside it.
# No access log, as in the deploy: a request path can carry a single-use token (/api/d/..., /api/pay/...).
api-serve:
	cd backend && uv run --env-file ../.env env -u TYPESAFE_API_KEY -u MOCKPAY_KEY uvicorn --factory desk.api.main:app_factory \
		--host 127.0.0.1 --port 8700 --timeout-keep-alive 310 --no-access-log

# Prove the Turner seed's cards and the starter presets with desk-prove and write their reports to
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

# For a database thrown away after the run, as each CI job's is: skip durable commits (no WAL flush
# at commit, no fsync, no full-page writes), since the tests spend much of their time committing. ALTER SYSTEM changes the
# whole Postgres instance, and a crash with fsync off can corrupt it, so the target refuses to run
# unless CI is true, as GitHub Actions sets it: never on a database whose data matters, such as docker-compose's. Discard the
# instance afterwards rather than turning the settings back on.
db-throwaway: DB_NAME ?= desk
db-throwaway:
	@if [ "$$CI" != true ]; then echo "db-throwaway: only for CI's throwaway database (CI isn't true): it turns off durable commits for the whole Postgres instance" >&2; exit 1; fi; \
	if [ -f .env ]; then set -a; . ./.env; set +a; fi; \
	PGPASSWORD="$$DESK_ADMIN_PASSWORD" psql -X -q -o /dev/null -v ON_ERROR_STOP=1 -h "$(DB_HOST)" -p "$(DB_PORT)" -U desk_admin \
		-d "$(DB_NAME)" -c 'ALTER SYSTEM SET fsync = off' -c 'ALTER SYSTEM SET synchronous_commit = off' \
		-c 'ALTER SYSTEM SET full_page_writes = off' -c 'SELECT pg_reload_conf()'

# The web app's checks, as CI's `web tests` runs them: install (web-deps), type-check and unit tests, then
# the production build, its check and the mocked end-to-end test (which needs the install too). WebKit
# runs the skeleton's sweep checks (the `ds-webkit` project), as iPhones draw it. CI runs the tests in
# four shards, passing each its shard and worker count in WEB_TEST_ARGS; locally it's empty.
web-deps:
	cd web && npm ci && npx playwright install --with-deps chromium webkit

web-test: web-deps
	cd web && npm run typecheck && npm test -- $(WEB_TEST_ARGS)

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
# Then no tracked file brings back the old demo owner's name (tools/rename_demo_owner.py).
.PHONY: docs-check
docs-check:
	uv run --project tools python -m desk_tools.check_docs $(if $(FINAL),--final)
	python3 tools/rename_demo_owner.py --check

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

# Tier 2 evals: a simulated visitor drives the API and kernel in this process, built from this tree.
# evals-tier2 runs every scenario RUNS times for at most MAX_USD dollars and writes the results file
# evals/results/<inputs>.json, which is committed with the change; scenarios whose plans aren't in
# landed.toml are pending, and with none left to run it writes no file: nothing was evaluated.
# evals-key prints <inputs>, the hash of the gated inputs. evals-results-check is the one tier 2 check
# CI and the deploy preflight run, with no database, network or key: exit 0 when no gated path, recorded
# rate or results file changed since BASE (renames count both paths), else when the committed file for
# the head's inputs is complete and its gate passes, or every head scenario is pending (no recorded rate).
# HISTORY_SINCE preserves rate, waiver and landed-plan histories from every first-parent commit since it.
# evals-merge-ready refuses a merge when both HEAD and origin/main changed results inputs since
# their merge base and a scenario can run under their combined landed plans or in their merge.
# Recorded rates also prevent the unarmed shortcut. Fetch origin first; rebase and regenerate when refused.
# It also requires exactly one Alembic head in the actual merge tree, regardless of results input changes.
.PHONY: evals-tier2 evals-key evals-results-check evals-merge-ready
RUNS ?= 1
MAX_USD ?= 40
BASE ?= origin/main
HISTORY_SINCE ?=
HEAD ?= HEAD

evals-tier2:
	$(EVALS) python -m evals.run tier2 --suite all --split all --runs $(RUNS) --max-usd $(MAX_USD) --results

evals-key:
	@$(EVALS) python -m evals.run key

evals-results-check:
	@$(EVALS) python -m evals.run results-check --base $(BASE) $(if $(HISTORY_SINCE),--history-since "$(HISTORY_SINCE)")

evals-merge-ready:
	@$(EVALS) python -m evals.run merge-ready --head "$(HEAD)"

# The soft-promise check measured on the real model. It spends money: every case in
# evals/calibration/soft_promise.yaml is sent SAMPLES times to the kernel's check, one Sonnet 5.5 call
# on the Claude API each (estimated at $0.0026), for at most MAX_USD dollars, which it needs on the
# command line or in the environment (the tier 2 default doesn't count). The prompt is this tree's,
# decisions.py's at PROMPT_REF or PROMPT_FILE's text; LABEL names the run. ANTHROPIC_API_KEY comes from
# the environment. It writes evals/out/soft-promise/<label>-<time>.json and a row in the shared spend file.
.PHONY: evals-soft-promise
SAMPLES ?= 5
evals-soft-promise:
	$(if $(filter file undefined,$(origin MAX_USD)),$(error evals-soft-promise spends money: give MAX_USD=<dollars>, the most it may spend))
	$(EVALS) python -m evals.calibration.soft_promise --samples $(SAMPLES) --max-usd $(MAX_USD)$(if $(PROMPT_REF), --prompt-ref $(PROMPT_REF))$(if $(PROMPT_FILE), --prompt-file $(PROMPT_FILE))$(if $(LABEL), --label $(LABEL))

# Select candidate arms new and sonnet, or diagnostic steps_only; unchanged old evidence is reused.
# SAMPLES accepts a common count or per-arm counts, e.g. new:5,steps_only:5,sonnet:2.
# All measured arms share MAX_USD and the durable $3.20 cap in evals/out/soft-promise/experiment.json.
.PHONY: evals-soft-promise-experiment
CASES ?= evals/calibration/soft_promise.yaml
ARMS ?= new,steps_only
RESULTS ?= evals/out/soft-promise/next-steps-experiment.json
evals-soft-promise-experiment:
	$(if $(filter file undefined,$(origin MAX_USD)),$(error evals-soft-promise-experiment spends money: give the remaining MAX_USD=<dollars>))
	$(if $(BASELINE_SHA),,$(error evals-soft-promise-experiment needs a frozen BASELINE_SHA))
	$(EVALS) python -m evals.calibration.soft_promise_experiment --cases "$(CASES)" --arms "$(ARMS)" --baseline-sha "$(BASELINE_SHA)" --samples "$(SAMPLES)" --max-usd $(MAX_USD) --output "$(RESULTS)"

# Compare frozen reviewer cases with prompts read from two refs. DRY_RUN=1 builds
# inputs and estimates Sonnet 5.5 list-price cost without credentials or model calls.
# Paid runs require an explicit MAX_USD; the tier 2 default does not count.
.PHONY: evals-reviewer
evals-reviewer:
	$(if $(filter 1,$(DRY_RUN)),,$(if $(filter file undefined,$(origin MAX_USD)),$(error evals-reviewer spends money: give MAX_USD=<dollars>, or DRY_RUN=1)))
	$(EVALS) python -m evals.calibration.reviewer --samples $(SAMPLES)$(if $(filter 1,$(DRY_RUN)), --dry-run, --max-usd $(MAX_USD))$(if $(PROMPT_REF), --prompt-ref $(PROMPT_REF))$(if $(OLD_PROMPT_REF), --old-prompt-ref $(OLD_PROMPT_REF))

# A finished pass, by its id under evals/out/passes (PASS=<id>). evals-gate judges it with no model call
# (FINAL=1 for the final gate: no pending scenario, no skipped check, three runs and a recorded rate).
# evals-latency makes TURNS turns of each kind for at most LATENCY_MAX_USD on the stack built from this
# tree (DRY_RUN=1 scripts every model for $0), for the pass PASS names. A deployment isn't measured: a
# hosted run reads no usage it can trust between turns, so it couldn't stop at LATENCY_MAX_USD. BASE_URL
# is still passed on, so the command refuses `make evals-latency BASE_URL=<url>` and says why.
# evals-report writes the pass's report, latest.json and this month's spend.csv under evals/reports and
# the latest results in docs/evals.md, with a null-baseline pass of the same held-out legitimate tasks
# when NULL_BASELINE names one. A pass of part of the suite gets its report alone, under evals/out/reports.
.PHONY: evals-gate evals-latency evals-report evals-waiver-review

evals-waiver-review:
	@test -n "$(PASS)" || { echo "evals-waiver-review: name the pass: make evals-waiver-review PASS=<id>" >&2; exit 2; }
	$(EVALS) python -m evals.run waiver-review --pass $(PASS)
TURNS ?= 20
LATENCY_MAX_USD ?= 3
LATENCY_FLAGS = $(if $(BASE_URL), --base-url $(BASE_URL))$(if $(PASS), --pass $(PASS))$(if $(DRY_RUN), --dry-run)

evals-gate:
	@test -n "$(PASS)" || { echo "evals-gate: name the pass: make evals-gate PASS=<id>" >&2; exit 2; }
	$(EVALS) python -m evals.run gate --pass $(PASS)$(if $(FINAL), --final)

evals-latency:
	$(EVALS) python -m evals.run latency --turns $(TURNS) --max-usd $(LATENCY_MAX_USD)$(LATENCY_FLAGS)

evals-report:
	@test -n "$(PASS)" || { echo "evals-report: name the pass: make evals-report PASS=<id>" >&2; exit 2; }
	$(EVALS) python -m evals.run report --pass $(PASS)$(if $(NULL_BASELINE), --null-baseline $(NULL_BASELINE))
