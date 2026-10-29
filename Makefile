.PHONY: kernel test db-roles web-test web-e2e image image-check infra-check image-smoke

# Rebuild the kernel's Python module into the backend environment, and the
# proof binary the kernel runs. desk-prove and its tests find cvc5 through
# CVC5 or PATH.
kernel:
	cd backend && uv sync --reinstall-package desk-kernel
	cd kernel && cargo build --release --locked -p desk-prove

test:
	cd kernel && cargo test --locked
	cd backend && uv run pytest

# Let the kernel, API and mock payments roles log in, with the passwords in .env (or the
# environment). Passwords reach psql as environment variables and are never echoed or put on
# a command line. Uses the host's psql when there is one, else the one in the compose db service.
DB_HOST ?= localhost
DB_PORT ?= 5433
DB_NAME ?= desk
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
# sees the local desk-kernel:dev.
image:
	docker buildx build --load --platform linux/arm64 -f kernel/Dockerfile -t desk-kernel:dev .
	docker buildx build --load --platform linux/arm64 -f infra/app.Dockerfile \
		--build-arg KERNEL_IMAGE=desk-kernel:dev -t desk-app:dev .

# What the app image must hold, and must not. Checks whose code hasn't landed yet (the API, the
# kernel service's compiler, the proof reports) say they are skipped; once it exists they run.
APP_IMAGE ?= desk-app:dev
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
# answers inside the kernel's container and the kernel's 8701 refuses connections from outside it.
image-smoke:
	APP_IMAGE="$(APP_IMAGE)" DB_NAME="$(DB_NAME)" infra/scripts/image_smoke.sh

# The CDK stacks: the CloudFront function's tests (Node 24 expands the quoted glob itself and no
# longer searches a directory argument), the stacks' tests, then a synth of every stack (synth
# takes them all when none is named; it has no --all). Synth only stages the image's build context
# and the web build, and builds nothing; it needs no AWS credentials.
infra-check:
	cd infra && node --test 'functions/**/*.test.mjs' && uv run pytest -q && npm ci && npx cdk synth --quiet
