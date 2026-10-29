"""One-off admin command: migrate the database to head, then let each process role log in.

    python -m desk.ops.admin migrate-and-roles

Runs as the deploy's admin task, before a new app task starts (and locally with exported
variables; `make db-roles` remains the local shortcut). It reads `ADMIN_DATABASE_URL` and the
three role passwords (`KERNEL_ROLE_PASSWORD`, `API_ROLE_PASSWORD`, `MOCKPAY_ROLE_PASSWORD`).

1. Alembic upgrades to head on a connection opened here, with `alembic.ini` found from the package,
   never the working directory, and never through `set_main_option`, whose `%` interpolation
   breaks URL-encoded passwords. The database must then be at the script's single head.
2. In one transaction, every role must exist, then each gets `LOGIN` and a SCRAM-SHA-256 verifier
   computed here (RFC 5802), so no plaintext password reaches the server or its logs. psycopg runs
   these statements directly, so no SQL logging ever sees a verifier.

Output names roles only, never a password, a verifier or a URL, and errors are redacted. Running it
again changes nothing but the verifiers' salts. Exit status: 0 success, 1 a role or migration
failure (no password is set then), 2 a missing or unusable variable.
"""

import argparse
import base64
import hashlib
import hmac
import logging.config
import os
import sys
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from urllib.parse import quote, quote_plus

import psycopg
from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from psycopg import sql
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.pool import NullPool

import desk
from desk.db.session import libpq_url

ALEMBIC_INI = Path(desk.__file__).resolve().parents[1] / "alembic.ini"

# Each process role and the variable that carries its password (the deploy seam's admin secrets).
ROLE_PASSWORD_VARIABLES = {
    "desk_kernel": "KERNEL_ROLE_PASSWORD",
    "desk_api": "API_ROLE_PASSWORD",
    "desk_mockpay": "MOCKPAY_ROLE_PASSWORD",
}


class AdminError(Exception):
    """A step failed; the message names no secret."""


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def scram_verifier(password: str, salt: bytes | None = None, iterations: int = 4096) -> str:
    """A SCRAM-SHA-256 verifier for `password` in Postgres's stored form (RFC 5802, RFC 7677).

    `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`, base64, with a fresh 16-byte salt
    unless one is given. The password must be non-empty ASCII: Postgres hashes an ASCII password
    as it is, but SASLprep-normalizes any other, which this function doesn't, so a verifier for a
    non-ASCII password could fail to match at login. Generated passwords are alphanumeric.
    """
    if not password or not password.isascii():
        raise ValueError("a role password must be non-empty ASCII")
    salt = os.urandom(16) if salt is None else salt
    salted = hashlib.pbkdf2_hmac("sha256", password.encode("ascii"), salt, iterations)
    client_key = hmac.digest(salted, b"Client Key", "sha256")
    server_key = hmac.digest(salted, b"Server Key", "sha256")
    stored_key = hashlib.sha256(client_key).digest()
    return f"SCRAM-SHA-256${iterations}:{_b64(salt)}${_b64(stored_key)}:{_b64(server_key)}"


def _say(message: str) -> None:
    print(f"admin: {message}", flush=True)


def _complain(message: str) -> None:
    print(f"admin: {message}", file=sys.stderr, flush=True)


def _secrets(admin_url: str, passwords: Mapping[str, str], verifiers: Iterable[str]) -> list[str]:
    """Every value an error message must not show: the admin URL and password, the role passwords
    and their verifiers."""
    secrets = [admin_url, *passwords.values(), *verifiers]
    try:
        admin_password = make_url(admin_url).password
    except Exception:           # an unparsable URL is redacted whole
        admin_password = None
    if admin_password:
        secrets.append(admin_password)
    return secrets


def _describe(error: BaseException, secrets: Iterable[str]) -> str:
    """One line about `error`, with each secret blanked out, as written and URL-encoded.

    For a SQLAlchemy error it describes the driver's error, without the statement SQLAlchemy adds.
    """
    original = getattr(error, "orig", None) or error
    text = " ".join(line.strip() for line in str(original).splitlines() if line.strip())
    # Longest first, so a secret that contains another is blanked out whole.
    forms = {form for secret in secrets if secret for form in (secret, quote(secret, safe=""), quote_plus(secret))}
    for form in sorted(forms, key=len, reverse=True):
        text = text.replace(form, "[redacted]")
    return f"{type(original).__name__}: {text}" if text else type(original).__name__


def _migrate(admin_url: str) -> str:
    """Alembic to head on a connection opened here, committed at the end; the revision reached."""
    config = Config(str(ALEMBIC_INI))
    heads = ScriptDirectory.from_config(config).get_heads()
    if len(heads) != 1:
        raise AdminError(f"the migrations have {len(heads)} heads, not one")
    engine = create_engine(admin_url, poolclass=NullPool)
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection      # env.py migrates on this connection
            command.upgrade(config, "head")
            revision = MigrationContext.configure(connection).get_current_revision()
    finally:
        engine.dispose()
    if revision != heads[0]:
        raise AdminError(f"the database is at {revision or 'no revision'}, not head {heads[0]}")
    return revision


def _set_passwords(admin_url: str, verifiers: Mapping[str, str]) -> list[str]:
    """In one transaction, give each role LOGIN and its verifier; the roles that don't exist, if any,
    in which case nothing changes."""
    with psycopg.connect(libpq_url(admin_url)) as conn:
        found = {name for (name,) in conn.execute(
            "SELECT rolname FROM pg_roles WHERE rolname = ANY(%s)", (list(verifiers),))}
        missing = [role for role in verifiers if role not in found]
        if missing:
            conn.rollback()
            return missing
        for role, verifier in verifiers.items():
            conn.execute(sql.SQL("ALTER ROLE {} WITH LOGIN PASSWORD {}").format(
                sql.Identifier(role), sql.Literal(verifier)))
    return []


def migrate_and_roles(admin_url: str, passwords: Mapping[str, str]) -> int:
    """Migrate to head as the admin role, then let each role in `passwords` log in with its password.

    Returns 0 on success and 1 when the migration fails or a role is missing, in which case no
    password is set. Each password must be non-empty ASCII (`scram_verifier`).
    """
    verifiers = {role: scram_verifier(password) for role, password in passwords.items()}
    secrets = _secrets(admin_url, passwords, verifiers.values())
    try:
        revision = _migrate(admin_url)
    except AdminError as error:
        _complain(f"the migration failed: {error}")
        return 1
    except Exception as error:
        _complain(f"the migration failed: {_describe(error, secrets)}")
        return 1
    _say(f"migrations at head ({revision})")
    try:
        missing = _set_passwords(admin_url, verifiers)
    except Exception as error:
        _complain(f"no role password was set: {_describe(error, secrets)}")
        return 1
    for role in missing:
        _complain(f"role {role} does not exist; the migration did not run")
    if missing:
        return 1
    for role in verifiers:
        _say(f"{role} can log in")
    return 0


def main(argv: Sequence[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    """The CLI; exits 0 on success, 1 on a role or migration failure, 2 on a missing variable."""
    parser = argparse.ArgumentParser(prog="python -m desk.ops.admin", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("migrate-and-roles", help="migrate to head, then let the process roles log in, "
                        "reading ADMIN_DATABASE_URL and " + ", ".join(ROLE_PASSWORD_VARIABLES.values()))
    parser.parse_args(argv)
    env = os.environ if environ is None else environ
    names = ["ADMIN_DATABASE_URL", *ROLE_PASSWORD_VARIABLES.values()]
    missing = [name for name in names if not env.get(name)]
    if missing:
        _complain(f"{', '.join(missing)} {'is' if len(missing) == 1 else 'are'} not set")
        return 2
    unusable = [name for name in ROLE_PASSWORD_VARIABLES.values() if not env[name].isascii()]
    if unusable:
        _complain(f"{', '.join(unusable)} must be ASCII")
        return 2
    logging.config.fileConfig(ALEMBIC_INI)        # alembic's progress lines, as `alembic upgrade` logs them
    passwords = {role: env[variable] for role, variable in ROLE_PASSWORD_VARIABLES.items()}
    return migrate_and_roles(env["ADMIN_DATABASE_URL"], passwords)


if __name__ == "__main__":
    sys.exit(main())
