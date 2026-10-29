.PHONY: kernel test db-roles

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
