#!/usr/bin/env bash
# Run the app image as the deploy runs it, against the local compose Postgres, in production mode:
# the admin task (migrations and role passwords), then the kernel and the API in one network
# namespace, as the two containers of the Fargate task share one, each with an init process as
# PID 1 as on ECS (initProcessEnabled). Then:
#   - smoke.py's api_health through the API's published port (the kernel proves with SymCC, signs
#     with the production key, every seed proved);
#   - mock payments answers {ok: true} on 127.0.0.1:8702 inside the kernel's container, once
#     backend/desk/mockpay/server.py is in this checkout (until then it says the check is skipped,
#     as `make image-check` does for code that hasn't landed);
#   - from outside the namespace, the API's 8700 takes a connection (the positive control: the
#     address and path work) and the kernel's 8701 refuses one.
#
#   docker compose up -d db && make image image-smoke
#
# Each container gets only its own column of the deploy seam (Plan 06b), from env files written
# here (mode 600 in infra/out/, or IMAGE_SMOKE_OUT when set; deleted on exit), never from the
# command line. Database passwords come from .env (DESK_ENV_FILE overrides the path), as
# `make db-roles` reads them; the signing seed and the mock payments key are random, the Anthropic
# key is a dummy (no model call is made), and the passcode hash is of a random passcode. Nothing
# here prints a value. The admin task migrates the database it runs on: DB_NAME picks it, else the
# one .env's ADMIN_DATABASE_URL names (this checkout's own), never a shared default. Docker
# Desktop's host.docker.internal reaches the compose port 5433.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
IMAGE=${APP_IMAGE:-desk-app:dev}
ENV_FILE=${DESK_ENV_FILE:-$ROOT/.env}
OUT=${IMAGE_SMOKE_OUT:-$ROOT/infra/out}
DB_NAME=${DB_NAME:-}
POLL_SECONDS=${IMAGE_SMOKE_POLL_SECONDS:-2}
POLLS=60
RUN=desk-image-smoke-$$
ADMIN=$RUN-admin
KERNEL=$RUN-kernel
API=$RUN-api

# The deploy seam's commands (infra/stacks/task.py and data_stack.py).
ADMIN_COMMAND=(python -m desk.ops.admin migrate-and-roles)
KERNEL_COMMAND=(python -m desk.kernel_service)
API_COMMAND=(uvicorn --factory desk.api.main:app_factory --host 0.0.0.0 --port 8700 --timeout-keep-alive 310 --no-access-log)
# Exits 0 only on a 200 from the given URL inside a container: the kernel's own health check.
HEALTH_CHECK='import sys, urllib.request; sys.exit(0 if urllib.request.urlopen(sys.argv[1], timeout=2).status == 200 else 1)'
MOCKPAY_CHECK='import json, os, sys, urllib.request
request = urllib.request.Request("http://127.0.0.1:8702/provider/health", headers={"X-Mockpay-Key": os.environ["MOCKPAY_KEY"]})
sys.exit(0 if json.load(urllib.request.urlopen(request, timeout=5)).get("ok") is True else 1)'
# Exits 0 when a connection to the given address and port opens within 3 s.
CONNECTS_CHECK='import socket, sys
probe = socket.socket()
probe.settimeout(3)
sys.exit(0 if probe.connect_ex((sys.argv[1], int(sys.argv[2]))) == 0 else 1)'
# Exits 0 when nothing accepts a connection on the given address and port within 3 s.
REFUSED_CHECK='import socket, sys
probe = socket.socket()
probe.settimeout(3)
sys.exit(1 if probe.connect_ex((sys.argv[1], int(sys.argv[2]))) == 0 else 0)'

say() { echo "image-smoke: $*"; }
die() { echo "image-smoke: $*" >&2; exit 1; }

env_files=()
cleanup() {
  docker rm -f "$API" "$KERNEL" >/dev/null 2>&1 || true
  if ((${#env_files[@]})); then rm -f "${env_files[@]}"; fi
}
trap cleanup EXIT

show_logs() {  # show_logs <container>: its last lines, when a step fails
  echo "image-smoke: the last lines of $1:" >&2
  docker logs --tail 30 "$1" >&2 2>&1 || true
}

wait_healthy() {  # wait_healthy <container> <url> <what>: poll the URL from inside the kernel's namespace
  local container=$1 url=$2 what=$3 attempt
  for ((attempt = 0; attempt < POLLS; attempt++)); do
    if [[ $(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null) != true ]]; then
      show_logs "$container"
      die "$what stopped before it was healthy"
    fi
    if docker exec "$KERNEL" python -c "$HEALTH_CHECK" "$url" >/dev/null 2>&1; then
      say "$what is healthy"
      return 0
    fi
    sleep "$POLL_SECONDS"
  done
  show_logs "$container"
  die "$what wasn't healthy after $((POLLS * POLL_SECONDS)) s"
}

# The local database passwords, as `make db-roles` reads them; none is ever echoed.
if [[ -f $ENV_FILE ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi
for name in DESK_ADMIN_PASSWORD KERNEL_ROLE_PASSWORD API_ROLE_PASSWORD MOCKPAY_ROLE_PASSWORD; do
  [[ -n ${!name:-} ]] || die "$name is not set (copy .env.example to .env)"
done
if [[ -z $DB_NAME && ${ADMIN_DATABASE_URL:-} =~ ^[^:/]+://[^/]+/([^/?]+)(\?.*)?$ ]]; then
  DB_NAME=${BASH_REMATCH[1]}
fi
[[ -n $DB_NAME ]] || die "DB_NAME isn't set and ADMIN_DATABASE_URL names no database: set one (copy .env.example to .env)"

docker image inspect "$IMAGE" >/dev/null 2>&1 || die "there is no $IMAGE image: build it with make image"

seed=$(openssl rand -hex 32)
mockpay_key=$(openssl rand -hex 32)
passcode_hash=$(openssl rand -hex 16 | docker run --rm -i "$IMAGE" python scripts/hash_passcode.py | tail -n 1)
[[ $passcode_hash == scrypt\$* ]] || die "scripts/hash_passcode.py in $IMAGE didn't print a passcode hash"

umask 077
mkdir -p "$OUT"
# Each env file is new, mode 600 in $OUT, and listed for the exit trap in this shell (never in
# a $(...) subshell, whose list the trap wouldn't see).
admin_env=$(mktemp "$OUT/image-smoke-admin.XXXXXX") && env_files+=("$admin_env")
kernel_env=$(mktemp "$OUT/image-smoke-kernel.XXXXXX") && env_files+=("$kernel_env")
api_env=$(mktemp "$OUT/image-smoke-api.XXXXXX") && env_files+=("$api_env")
database() {
  printf '%s\n' "DB_HOST=host.docker.internal" "DB_PORT=5433" "DB_SSLMODE=disable" "DB_NAME=$DB_NAME"
}

{
  printf '%s\n' "DESK_DB_URLS=ADMIN" "ADMIN_DB_USER=desk_admin"
  database
  printf '%s\n' "ADMIN_DB_PASSWORD=$DESK_ADMIN_PASSWORD" "KERNEL_ROLE_PASSWORD=$KERNEL_ROLE_PASSWORD" \
    "API_ROLE_PASSWORD=$API_ROLE_PASSWORD" "MOCKPAY_ROLE_PASSWORD=$MOCKPAY_ROLE_PASSWORD"
} >"$admin_env"

{
  printf '%s\n' "DESK_ENV=production" "DESK_DB_URLS=KERNEL,MOCKPAY" "KERNEL_DB_USER=desk_kernel" \
    "MOCKPAY_DB_USER=desk_mockpay" "SAMPLE_WEEK=1"
  database
  printf '%s\n' "KERNEL_DB_PASSWORD=$KERNEL_ROLE_PASSWORD" "MOCKPAY_DB_PASSWORD=$MOCKPAY_ROLE_PASSWORD" \
    "DESK_SIGNING_SEED=$seed" "ANTHROPIC_API_KEY=not-a-key" "MOCKPAY_KEY=$mockpay_key" "TYPESAFE_API_KEY="
} >"$kernel_env"

{
  printf '%s\n' "DESK_ENV=production" "DESK_DB_URLS=API" "API_DB_USER=desk_api"
  database
  printf '%s\n' "KERNEL_URL=http://127.0.0.1:8701" "PUBLIC_ORIGIN=https://localhost.invalid" "TRUSTED_PROXY_HOPS=0" \
    "API_DB_PASSWORD=$API_ROLE_PASSWORD" "ANTHROPIC_API_KEY=not-a-key" "PASSCODE_HASH=$passcode_hash"
} >"$api_env"

say "admin task: migrations and role passwords on $DB_NAME"
docker run --rm --name "$ADMIN" --env-file "$admin_env" "$IMAGE" "${ADMIN_COMMAND[@]}" ||
  die "the admin task failed; the kernel and the API weren't started"

say "kernel, in production mode"
docker run -d --init --name "$KERNEL" --env-file "$kernel_env" -p 127.0.0.1:8700:8700 "$IMAGE" "${KERNEL_COMMAND[@]}" >/dev/null
wait_healthy "$KERNEL" http://127.0.0.1:8701/health "the kernel"

say "API, in production mode, in the kernel's network namespace"
docker run -d --init --name "$API" --network "container:$KERNEL" --env-file "$api_env" "$IMAGE" "${API_COMMAND[@]}" >/dev/null
wait_healthy "$API" http://127.0.0.1:8700/api/health "the API"

uv run --project "$ROOT/infra" python "$ROOT/infra/scripts/smoke.py" --base-url http://localhost:8700 --only api_health ||
  { show_logs "$API"; show_logs "$KERNEL"; die "api_health failed"; }

if [[ -f $ROOT/backend/desk/mockpay/server.py ]]; then
  docker exec "$KERNEL" python -c "$MOCKPAY_CHECK" >/dev/null ||
    { show_logs "$KERNEL"; die "mock payments didn't answer {ok: true} on 127.0.0.1:8702"; }
  say "mock payments answers {ok: true} inside the kernel's container"
else
  say "skipped mock payments, no backend/desk/mockpay/server.py yet"
fi

kernel_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$KERNEL")
[[ -n $kernel_ip ]] || die "the kernel's container has no address to probe"
# The positive control: the API listens on every interface of the shared namespace, so 8700 must
# connect from outside it. If it doesn't, a refused 8701 would prove nothing.
docker run --rm "$IMAGE" python -c "$CONNECTS_CHECK" "$kernel_ip" 8700 ||
  die "$kernel_ip:8700 took no connection from outside the namespace, so a refused 8701 would prove nothing"
say "$kernel_ip:8700 takes connections from outside the namespace"
docker run --rm "$IMAGE" python -c "$REFUSED_CHECK" "$kernel_ip" 8701 ||
  die "the kernel took a connection on $kernel_ip:8701 from outside its network namespace"
say "8701 refuses connections from outside the kernel's namespace"

say "ok"
