"""Container entrypoint: compose each process's database URLs from their parts, then exec.

ECS hands a container its database password as its own secret and the host, port and name as
plain variables. For each prefix `P` in `DESK_DB_URLS` (comma-separated), this sets
`P_DATABASE_URL` to `postgresql+psycopg://<user>:<password>@<host>:<port>/<db>?sslmode=<mode>`
from `P_DB_USER`, `P_DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_NAME` and `DB_SSLMODE` (default
`require`), user and password URL-encoded, removes every `P_DB_PASSWORD`, and execs the command
with that environment. A missing or malformed part stops the container (exit 2) before the
command starts, naming the variable and never a value. Without `DESK_DB_URLS` the environment
passes through unchanged (local runs set their URLs).

    python -m desk.ops.entrypoint <command> [args...]
    python -m desk.ops.entrypoint --self-check
"""

import os
import re
import sys
from collections.abc import Mapping, Sequence
from typing import NoReturn
from urllib.parse import quote

USAGE = "usage: python -m desk.ops.entrypoint <command> [args...] | --self-check"

_PREFIX = re.compile(r"[A-Z][A-Z0-9_]*")
_HOST = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?")    # a host name or IPv4 address
_DB_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_SSLMODES = ("allow", "disable", "prefer", "require", "verify-ca", "verify-full")


class EntrypointError(Exception):
    """The environment can't be composed; the message names variables, never their values."""


def _prefixes(value: str) -> list[str]:
    prefixes = [prefix.strip() for prefix in value.split(",")]
    if prefixes == [""]:
        raise EntrypointError("DESK_DB_URLS lists no prefixes")
    if not all(_PREFIX.fullmatch(prefix) for prefix in prefixes):
        raise EntrypointError("DESK_DB_URLS: each prefix must be upper-case letters, digits or underscores")
    for prefix in prefixes:
        if prefixes.count(prefix) > 1:
            raise EntrypointError(f"DESK_DB_URLS lists {prefix} more than once")
    return prefixes


def _check_server(host: str, port: str, name: str, sslmode: str) -> None:
    if not _HOST.fullmatch(host):
        raise EntrypointError("DB_HOST must be a host name or IPv4 address")
    if not (port.isascii() and port.isdigit() and 1 <= int(port) <= 65535):
        raise EntrypointError("DB_PORT must be a port number from 1 to 65535")
    if not _DB_NAME.fullmatch(name):
        raise EntrypointError("DB_NAME must be letters, digits or underscores")
    if sslmode not in _SSLMODES:
        raise EntrypointError(f"DB_SSLMODE must be one of {', '.join(_SSLMODES)}")


def compose_env(env: Mapping[str, str]) -> dict[str, str]:
    """The command's environment: `env` with each listed prefix's URL set and its password removed."""
    out = dict(env)
    if "DESK_DB_URLS" not in env:
        return out
    prefixes = _prefixes(env["DESK_DB_URLS"])
    for prefix in prefixes:
        if f"{prefix}_DATABASE_URL" in env:
            raise EntrypointError(f"{prefix}_DATABASE_URL is already set; DESK_DB_URLS composes it")
    required = ["DB_HOST", "DB_PORT", "DB_NAME"]
    required += [f"{prefix}_DB_{part}" for prefix in prefixes for part in ("USER", "PASSWORD")]
    missing = [name for name in required if not env.get(name)]
    if missing:
        raise EntrypointError(f"{', '.join(missing)} {'is' if len(missing) == 1 else 'are'} not set")
    host, port, name = env["DB_HOST"], env["DB_PORT"], env["DB_NAME"]
    sslmode = env.get("DB_SSLMODE") or "require"
    _check_server(host, port, name, sslmode)
    for prefix in prefixes:
        user = quote(env[f"{prefix}_DB_USER"], safe="")
        password = quote(out.pop(f"{prefix}_DB_PASSWORD"), safe="")
        out[f"{prefix}_DATABASE_URL"] = (
            f"postgresql+psycopg://{user}:{password}@{host}:{port}/{name}?sslmode={sslmode}"
        )
    return out


def _self_check() -> NoReturn:
    """Compose a dummy environment and compare it with the exact expected result."""
    dummy = {"DESK_DB_URLS": "SELF", "SELF_DB_USER": "desk_self", "SELF_DB_PASSWORD": "p@ss/w:rd%",
             "DB_HOST": "localhost", "DB_PORT": "5432", "DB_NAME": "desk"}
    expected = {"DESK_DB_URLS": "SELF", "SELF_DB_USER": "desk_self", "DB_HOST": "localhost", "DB_PORT": "5432",
                "DB_NAME": "desk",
                "SELF_DATABASE_URL": "postgresql+psycopg://desk_self:p%40ss%2Fw%3Ard%25@localhost:5432/desk?sslmode=require"}
    try:
        ok = compose_env(dummy) == expected
    except EntrypointError:
        ok = False
    if not ok:
        print("entrypoint: self-check failed", file=sys.stderr)
        sys.exit(1)
    print("entrypoint ok")
    sys.exit(0)


def main(argv: Sequence[str] | None = None, environ: Mapping[str, str] | None = None) -> NoReturn:
    """Compose the environment and exec `argv` (default: this process's arguments and environment).

    Exits 2 without exec when the environment can't be composed or there is no command, and 127
    (126) when the command isn't found (can't be run), as a shell would.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    if args == ["--self-check"]:
        _self_check()
    if not args:
        print(USAGE, file=sys.stderr)
        sys.exit(2)
    try:
        env = compose_env(os.environ if environ is None else environ)
    except EntrypointError as error:
        print(f"entrypoint: {error}", file=sys.stderr)
        sys.exit(2)
    try:
        os.execvpe(args[0], args, env)
    except OSError as error:
        print(f"entrypoint: can't run {args[0]}: {error.strerror}", file=sys.stderr)
        sys.exit(127 if isinstance(error, FileNotFoundError) else 126)


if __name__ == "__main__":
    main()
