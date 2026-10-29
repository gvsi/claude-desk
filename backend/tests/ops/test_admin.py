"""The one-off admin command: migrations to head, then each process role's password as a SCRAM verifier.

The database tests need the local Postgres (`docker compose up -d db`) and the suite's `.env`. They
migrate empty databases of their own, named after the suite's and dropped afterwards, and make
temporary roles they drop too. The process roles are cluster-wide and other databases' tests log in
as them, so these tests only ever set their passwords to the `.env` values every *_DATABASE_URL
already uses.
"""

import base64
import hashlib
import hmac
import io
import logging
import os
import re
import subprocess
import sys
import uuid
from collections.abc import Iterator
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import psycopg
import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from psycopg import sql
from sqlalchemy.engine import URL, make_url

import desk
import desk.ops.admin
from desk.db.session import _dotenv, database_url, libpq_url
from desk.ops.admin import main, migrate_and_roles, scram_verifier
from desk.ops.entrypoint import compose_env

BACKEND = Path(desk.__file__).resolve().parents[1]

VERIFIER = re.compile(r"^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$")


def test_scram_verifier_shape():
    verifier = scram_verifier("change-me-api")
    assert VERIFIER.match(verifier)
    assert scram_verifier("change-me-api") != verifier          # a fresh random salt each time
    assert scram_verifier("x", salt=bytes(16)).startswith("SCRAM-SHA-256$4096:AAAAAAAAAAAAAAAAAAAAAA==$")
    assert scram_verifier("x", salt=bytes(16), iterations=8192).startswith("SCRAM-SHA-256$8192:")


def test_scram_verifier_completes_the_rfc_7677_exchange():
    """With RFC 7677's salt, the keys check its example proof and sign as its server does."""
    verifier = scram_verifier("pencil", salt=base64.b64decode("W22ZaJ0SNY7soEsUEjb6gQ=="))
    stored_key, server_key = (base64.b64decode(key) for key in verifier.split("$")[2].split(":"))
    nonce = "rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0"
    auth_message = f"n=user,r=rOprNGfwEbeRWgbNEkqO,r={nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r={nonce}"
    proof = base64.b64decode("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=")
    client_signature = hmac.digest(stored_key, auth_message.encode(), "sha256")
    client_key = bytes(a ^ b for a, b in zip(proof, client_signature))
    assert hashlib.sha256(client_key).digest() == stored_key        # the server's proof check
    server_signature = hmac.digest(server_key, auth_message.encode(), "sha256")
    assert base64.b64encode(server_signature).decode() == "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4="


def test_scram_verifier_takes_ascii_passwords_only():
    """Postgres SASLprep-normalizes a non-ASCII password before hashing; this side doesn't, so it refuses."""
    with pytest.raises(ValueError, match="ASCII") as error:
        scram_verifier("pässword")
    assert "pässword" not in str(error.value)
    with pytest.raises(ValueError):
        scram_verifier("")


# The process roles and the variables that carry their passwords, as the deploy seam names them.
ROLE_VARIABLES = {"desk_kernel": "KERNEL_ROLE_PASSWORD", "desk_api": "API_ROLE_PASSWORD",
                  "desk_mockpay": "MOCKPAY_ROLE_PASSWORD"}
URL_PREFIXES = {"desk_kernel": "KERNEL", "desk_api": "API", "desk_mockpay": "MOCKPAY"}


def setting(name: str) -> str:
    """A variable from the environment, else the repository's .env (as database_url reads URLs)."""
    value = os.environ.get(name) or _dotenv().get(name)
    if not value:
        pytest.fail(f"{name} is not set (copy .env.example to .env)")
    return value


@pytest.fixture(scope="module")
def role_passwords() -> dict[str, str]:
    """The suite's role passwords: the ones each process URL already logs in with."""
    passwords = {role: setting(variable) for role, variable in ROLE_VARIABLES.items()}
    for role, prefix in URL_PREFIXES.items():
        url = make_url(database_url(prefix))
        if (url.username, url.password) != (role, passwords[role]):
            pytest.fail(f"{prefix}_DATABASE_URL must log in as {role} with {ROLE_VARIABLES[role]}; "
                        "keep them the same, as .env.example says")
    return passwords


@pytest.fixture(scope="module")
def admin() -> Iterator[psycopg.Connection]:
    with psycopg.connect(libpq_url(database_url("ADMIN")), autocommit=True) as conn:
        yield conn


@dataclass
class Scratch:
    """Empty databases and temporary roles made for these tests; all dropped at the end."""

    admin: psycopg.Connection
    base: URL
    databases: list[str]
    roles: list[str]

    def database(self, owner: str | None = None) -> URL:
        """A new empty database next to the suite's, owned by `owner` if given; its admin URL."""
        name = f"{self.base.database}_admin_{uuid.uuid4().hex[:8]}"
        statement = sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name))
        if owner is not None:
            statement += sql.SQL(" OWNER {}").format(sql.Identifier(owner))
        self.admin.execute(statement)
        self.databases.append(name)
        return self.base.set(database=name)

    def role(self, kind: str, options: str = "NOLOGIN", password: str | None = None) -> str:
        name = f"desk_test_{kind}_{uuid.uuid4().hex[:8]}"
        statement = sql.SQL("CREATE ROLE {} WITH " + options).format(sql.Identifier(name))
        if password is not None:
            statement += sql.SQL(" PASSWORD {}").format(sql.Literal(password))
        self.admin.execute(statement)
        self.roles.append(name)
        return name


@pytest.fixture(scope="module")
def scratch(admin) -> Iterator[Scratch]:
    made = Scratch(admin, make_url(database_url("ADMIN")), [], [])
    yield made
    for name in made.databases:          # first: a temporary role may own a database's objects
        admin.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
    for name in made.roles:
        admin.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(name)))


def url_text(url: URL) -> str:
    return url.render_as_string(hide_password=False)


@dataclass
class Run:
    code: int
    stdout: str
    stderr: str
    logs: str           # every log record, at DEBUG: SQLAlchemy's statements included

    @property
    def output(self) -> str:
        return self.stdout + self.stderr + self.logs


def run_admin(url: URL | str, passwords: dict[str, str]) -> Run:
    """migrate_and_roles in this process, with its output and every log record captured.

    Every logger is lowered to DEBUG for the run (SQLAlchemy sets its own to WARN), so the
    capture holds each statement SQLAlchemy runs and its parameters.
    """
    stdout, stderr, logs = io.StringIO(), io.StringIO(), io.StringIO()
    handler = logging.StreamHandler(logs)
    root = logging.getLogger()
    loggers = [root, *(logger for logger in root.manager.loggerDict.values()
                       if isinstance(logger, logging.Logger))]
    saved = [(logger, logger.level, logger.disabled) for logger in loggers]
    for logger in loggers:
        logger.setLevel(logging.DEBUG)
        logger.disabled = False
    root.addHandler(handler)
    try:
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = migrate_and_roles(url if isinstance(url, str) else url_text(url), passwords)
    finally:
        root.removeHandler(handler)
        for logger, level, disabled in saved:
            logger.setLevel(level)
            logger.disabled = disabled
    return Run(code, stdout.getvalue(), stderr.getvalue(), logs.getvalue())


def head() -> str:
    heads = ScriptDirectory.from_config(Config(str(BACKEND / "alembic.ini"))).get_heads()
    assert len(heads) == 1, heads
    return heads[0]


def version(url: URL) -> str:
    with psycopg.connect(libpq_url(url_text(url))) as conn:
        return conn.execute("SELECT version_num FROM alembic_version").fetchone()[0]


@pytest.fixture(scope="module")
def first_run(scratch, role_passwords) -> tuple[URL, Run]:
    """One admin run on an empty database: every migration from the first."""
    url = scratch.database()
    return url, run_admin(url, role_passwords)


def test_scram_verifier_matches_postgres(scratch):
    """For the salt Postgres picked when it hashed a password itself, the verifier is identical."""
    password = f"pencil-{uuid.uuid4().hex[:6]}"
    role = scratch.role("hashed", password=password)
    stored = scratch.admin.execute("SELECT rolpassword FROM pg_authid WHERE rolname = %s", (role,)).fetchone()[0]
    salt = base64.b64decode(stored.split("$")[1].split(":")[1])
    assert scram_verifier(password, salt=salt) == stored


def test_migrations_reach_head(first_run):
    url, run = first_run
    assert run.code == 0, run.stderr
    assert "-> 0001_core" in run.logs                 # from an empty database, every revision ran
    assert version(url) == head()


PROBE_PASSWORD = "probe-p%,=^@x/'q'"      # ASCII punctuation, URL and SQL quoting characters included


def log_in(url: URL, user: str, password: str) -> str:
    """Connect over TCP (password auth) as `user`; the session's role."""
    with psycopg.connect(host=url.host, port=url.port, dbname=url.database, user=user, password=password,
                         connect_timeout=10) as conn:
        return conn.execute("SELECT current_user").fetchone()[0]


def test_roles_log_in_after_admin_run(first_run, scratch, role_passwords):
    url, _ = first_run
    probe = scratch.role("probe")                       # NOLOGIN, no password: the admin run lets it in
    run = run_admin(url, {**role_passwords, probe: PROBE_PASSWORD})
    assert run.code == 0, run.stderr
    assert log_in(url, probe, PROBE_PASSWORD) == probe
    for role, password in role_passwords.items():
        assert log_in(url, role, password) == role
    assert f"{probe} can log in" in run.stdout


def test_wrong_password_is_rejected(first_run, role_passwords):
    url, _ = first_run
    with pytest.raises(psycopg.OperationalError, match="password authentication failed"):
        log_in(url, "desk_api", "not-" + role_passwords["desk_api"])


def rolpassword(admin: psycopg.Connection, role: str) -> str | None:
    return admin.execute("SELECT rolpassword FROM pg_authid WHERE rolname = %s", (role,)).fetchone()[0]


def test_admin_run_is_idempotent(first_run, scratch, role_passwords):
    url, _ = first_run
    before = {role: rolpassword(scratch.admin, role) for role in role_passwords}
    for _ in range(2):
        run = run_admin(url, role_passwords)
        assert run.code == 0, run.stderr
        assert version(url) == head()
        for role, password in role_passwords.items():
            assert log_in(url, role, password) == role
    # Each run stores a fresh verifier (a new salt) for the same password.
    assert all(rolpassword(scratch.admin, role) != before[role] for role in role_passwords)


def test_missing_role_fails_with_a_plain_message(first_run, scratch, role_passwords):
    url, _ = first_run
    probe = scratch.role("probe")
    absent = f"desk_test_absent_{uuid.uuid4().hex[:8]}"
    run = run_admin(url, {**role_passwords, probe: PROBE_PASSWORD, absent: PROBE_PASSWORD})
    assert run.code == 1
    assert f"admin: role {absent} does not exist; the migration did not run" in run.stderr
    assert rolpassword(scratch.admin, probe) is None       # every role gets its password, or none does
    with pytest.raises(psycopg.OperationalError):
        log_in(url, probe, PROBE_PASSWORD)


@pytest.fixture(scope="module")
def cli_run(first_run, role_passwords, tmp_path_factory) -> subprocess.CompletedProcess[str]:
    """`python -m desk.ops.admin migrate-and-roles` as the admin task runs it, from another directory."""
    url, _ = first_run
    env = {"PATH": os.environ["PATH"], "PYTHONPATH": str(BACKEND), "ADMIN_DATABASE_URL": url_text(url),
           **{variable: role_passwords[role] for role, variable in ROLE_VARIABLES.items()}}
    return subprocess.run([sys.executable, "-m", "desk.ops.admin", "migrate-and-roles"], env=env,
                          cwd=tmp_path_factory.mktemp("elsewhere"), capture_output=True, text=True, timeout=300)


def test_cli_runs_from_any_directory(cli_run):
    assert cli_run.returncode == 0, cli_run.stderr
    for role in ROLE_VARIABLES:
        assert f"admin: {role} can log in" in cli_run.stdout
    assert "[alembic.runtime.migration] Context impl PostgresqlImpl." in cli_run.stderr   # alembic.ini's logging


def test_admin_output_never_contains_passwords(first_run, cli_run, role_passwords, monkeypatch):
    """stdout, stderr and every log record hold role names, never a password or a verifier."""
    url, first = first_run
    made: list[str] = []

    def recording(password: str, salt: bytes | None = None, iterations: int = 4096) -> str:
        made.append(scram_verifier(password, salt, iterations))
        return made[-1]

    monkeypatch.setattr(desk.ops.admin, "scram_verifier", recording)
    run = run_admin(url, role_passwords)
    assert run.code == 0 and len(made) == len(role_passwords)
    assert "alembic_version" in first.logs                # the capture holds SQLAlchemy's statements
    secrets = [*role_passwords.values(), make_url(database_url("ADMIN")).password]
    secrets += [part for verifier in made for part in [verifier, *re.split(r"[$:]", verifier)[2:]]]
    for output in (first.output, run.output, cli_run.stdout + cli_run.stderr):
        assert "admin: desk_api can log in" in output
        assert "SCRAM-SHA-256" not in output
        for secret in secrets:
            assert secret not in output


ENCODED_PASSWORD = "p%,=^@x"      # `%` breaks ConfigParser interpolation; the rest needs URL encoding


def test_encoded_password_reaches_alembic(scratch, role_passwords):
    """An admin URL composed by the entrypoint, password encoded, reaches Alembic and psycopg intact."""
    base = make_url(database_url("ADMIN"))
    admin_role = scratch.role("admin", options="LOGIN SUPERUSER", password=ENCODED_PASSWORD)
    url = scratch.database()
    env = compose_env({"DESK_DB_URLS": "ADMIN", "ADMIN_DB_USER": admin_role, "ADMIN_DB_PASSWORD": ENCODED_PASSWORD,
                       "DB_HOST": base.host, "DB_PORT": str(base.port), "DB_NAME": url.database,
                       "DB_SSLMODE": base.query.get("sslmode", "disable")})
    assert ":p%25%2C%3D%5E%40x@" in env["ADMIN_DATABASE_URL"]
    run = run_admin(env["ADMIN_DATABASE_URL"], role_passwords)
    assert run.code == 0, run.stderr
    assert version(url) == head()
    with psycopg.connect(libpq_url(url_text(url))) as conn:      # the temporary admin ran the migrations
        owner = conn.execute("SELECT tableowner FROM pg_tables WHERE tablename = 'alembic_version'").fetchone()[0]
    assert owner == admin_role
    assert log_in(url, "desk_api", role_passwords["desk_api"]) == "desk_api"


# The cluster-wide roles the migrations create: the process roles (roles.sql) and the NOLOGIN owners
# of the copy resolvers (0004_copy_resolvers) and of the kernel_ro views (0005_kernel_ro_owner).
CHAIN_ROLES = ("desk_kernel", "desk_api", "desk_mockpay", "desk_resolver", "desk_ro_owner")

# Each migration's schemas: every object in them, its owner and its grants are compared below.
SCHEMAS = ("kernel", "kernel_ro", "app", "mockpay", "procrastinate")

# The owner roles a migration lends the admin to change an owner, each with the schema the role is
# lent CREATE on (`_change_owner` in 0004_copy_resolvers, 0005_kernel_ro_owner and 0006_preview_and_pins).
LENT = (("desk_resolver", "kernel"), ("desk_ro_owner", "kernel_ro"))


@pytest.fixture(scope="module")
def rds_like_admin(scratch) -> tuple[str, URL]:
    """An admin like RDS's master user (LOGIN CREATEROLE CREATEDB, not SUPERUSER) and the fresh
    database it owns; its URL logs in as it.

    Where the admin creates a role, Postgres 16 gives it ADMIN OPTION on the role, but neither SET nor
    INHERIT. This cluster is shared, so a role the migrations create may already exist: the admin gets
    that same grant on each one that does, and creates the rest itself. Nothing may create a chain role
    between this fixture and the admin's run (the superuser run the test compares against comes after).
    """
    password = f"rds-like-{uuid.uuid4().hex}"
    admin_role = scratch.role("rdsadmin", options="LOGIN CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS",
                              password=password)
    for role in CHAIN_ROLES:
        if scratch.admin.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role,)).fetchone():
            scratch.admin.execute(sql.SQL("GRANT {} TO {} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE").format(
                sql.Identifier(role), sql.Identifier(admin_role)))
    url = scratch.database(owner=admin_role).set(username=admin_role, password=password)
    return admin_role, url


def privileges(url: URL) -> dict[str, list[tuple]]:
    """Who owns each object in the migrations' schemas and what each role may do with it, with the
    admin that ran the migrations named `<admin>`, so two databases migrated by different admins compare.

    Each access list is a set: Postgres orders one built from default privileges by role OID, so
    its order follows when the roles were created, not what they may do.
    """
    queries = {
        "schemas": "SELECT nspname, pg_get_userbyid(nspowner), nspacl::text[] FROM pg_namespace"
                   " WHERE nspname = ANY(%(schemas)s)",
        "relations": "SELECT c.oid::regclass::text, c.relkind::text, pg_get_userbyid(c.relowner), c.relacl::text[]"
                     " FROM pg_class c WHERE c.relnamespace::regnamespace::text = ANY(%(schemas)s)",
        "columns": "SELECT a.attrelid::regclass::text, a.attname, a.attacl::text[] FROM pg_attribute a"
                   " JOIN pg_class c ON c.oid = a.attrelid"
                   " WHERE c.relnamespace::regnamespace::text = ANY(%(schemas)s) AND a.attacl IS NOT NULL",
        "functions": "SELECT p.oid::regprocedure::text, pg_get_userbyid(p.proowner), p.proacl::text[] FROM pg_proc p"
                     " WHERE p.pronamespace::regnamespace::text = ANY(%(schemas)s)",
        "default_acls": "SELECT pg_get_userbyid(defaclrole), defaclnamespace::regnamespace::text,"
                        " defaclobjtype::text, defaclacl::text[] FROM pg_default_acl",
        # what the admin granted itself in the migrations' roles (Postgres's grants to it aren't the migrations')
        "self_grants": "SELECT r.rolname, a.admin_option, a.inherit_option, a.set_option FROM pg_auth_members a"
                       " JOIN pg_roles r ON r.oid = a.roleid WHERE a.member = a.grantor"
                       " AND a.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)"
                       " AND r.rolname = ANY(%(roles)s)",
    }
    with psycopg.connect(libpq_url(url_text(url))) as conn:
        admin_role = re.compile(rf"\b{re.escape(conn.execute('SELECT current_user').fetchone()[0])}\b")
        found = {name: conn.execute(query, {"schemas": list(SCHEMAS), "roles": list(CHAIN_ROLES)}).fetchall()
                 for name, query in queries.items()}

    def named(value: object) -> object:
        if isinstance(value, str):
            return admin_role.sub("<admin>", value)
        if isinstance(value, list):                     # an access list
            return tuple(sorted(named(item) for item in value))
        return value

    return {name: sorted((tuple(named(value) for value in row) for row in rows), key=repr)
            for name, rows in found.items()}


def test_migrations_reach_head_as_an_admin_without_superuser(rds_like_admin, role_passwords, request):
    """RDS's master user isn't a superuser: every migration still runs as it, and ends as a superuser's run does.

    Changing an object's owner then needs SET ROLE on the new owner, which needs CREATE on the
    object's schema; each migration that changes an owner lends both for the change and takes them
    back, so the admin is left only the grants Postgres gave it, and the owners only their own.

    The superuser run is set up only after the admin's, so on a fresh cluster the admin creates
    every role itself, as on RDS, whatever order the tests run in.
    """
    admin_role, url = rds_like_admin
    run = run_admin(url, role_passwords)
    assert run.code == 0, run.stderr
    assert "-> 0001_core" in run.logs
    assert version(url) == head()
    for role, password in role_passwords.items():
        assert log_in(url, role, password) == role
    with psycopg.connect(libpq_url(url_text(url))) as conn:
        assert conn.execute("SELECT current_user, rolsuper, rolbypassrls FROM pg_roles"
                            " WHERE rolname = current_user").fetchone() == (admin_role, False, False)
        # Nothing lent outlives the run, checked directly: a superuser's run lends the same way, so
        # the comparison below can't see a lend both runs keep.
        kept = conn.execute("SELECT r.rolname, a.inherit_option, a.set_option FROM pg_auth_members a"
                            " JOIN pg_roles r ON r.oid = a.roleid"
                            " WHERE a.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)"
                            " AND r.rolname = ANY(%s) AND (a.inherit_option OR a.set_option)",
                            (list(CHAIN_ROLES),)).fetchall()
        assert kept == [], f"the admin still holds SET or INHERIT on {kept}"
        for role, schema in LENT:
            assert not conn.execute("SELECT has_schema_privilege(%s, %s, 'CREATE')",
                                    (role, schema)).fetchone()[0], f"{role} still has CREATE on {schema}"
    superuser_url, _ = request.getfixturevalue("first_run")
    assert privileges(url) == privileges(superuser_url)


def test_migration_failure_exits_1_without_secrets(first_run, role_passwords, monkeypatch):
    url, _ = first_run
    wrong = url.set(password="wrong-" + url.password)
    run = run_admin(wrong, role_passwords)
    assert run.code == 1
    assert "admin: the migration failed" in run.stderr
    assert "password authentication failed" in run.stderr        # it says why
    assert "can log in" not in run.stdout
    for secret in (wrong.password, *role_passwords.values()):
        assert secret not in run.output
    assert quote(wrong.password, safe="") not in run.output

    def quotes_the_url(config: Config, revision: str) -> None:
        raise ValueError(f"can't use {url_text(url)}")             # as ConfigParser's interpolation error does

    monkeypatch.setattr(desk.ops.admin.command, "upgrade", quotes_the_url)
    run = run_admin(url, role_passwords)
    assert run.code == 1
    assert "admin: the migration failed: ValueError: can't use" in run.stderr
    assert url.password not in run.output and quote(url.password, safe="") not in run.output


def test_admin_stops_unless_the_migration_reaches_head(scratch, monkeypatch):
    url = scratch.database()
    probe = scratch.role("probe")
    monkeypatch.setattr(desk.ops.admin.command, "upgrade", lambda config, revision: None)
    run = run_admin(url, {probe: PROBE_PASSWORD})
    assert run.code == 1
    assert f"admin: the migration failed: the database is at no revision, not head {head()}" in run.stderr
    assert rolpassword(scratch.admin, probe) is None


LATER_REVISION = "9999_from_a_later_release"


def test_a_database_ahead_of_the_code_stops_the_admin_run(scratch):
    """An earlier release can't be redeployed once a later release's migration ran.

    deploy.sh runs the admin task on every deploy, before DeskApp. When the database is at a
    revision this code doesn't have, the run stops (1) and names it: nothing is restamped and no
    password is set, so the deploy stops with the running release untouched (docs/deploy.md,
    "Rollback and teardown", rolls forward instead).
    """
    url = scratch.database()
    assert run_admin(url, {scratch.role("probe"): PROBE_PASSWORD}).code == 0
    with psycopg.connect(libpq_url(url_text(url)), autocommit=True) as conn:
        conn.execute("UPDATE alembic_version SET version_num = %s", (LATER_REVISION,))
    probe = scratch.role("probe")
    run = run_admin(url, {probe: PROBE_PASSWORD})
    assert run.code == 1
    assert "admin: the migration failed" in run.stderr
    # It names the revision this code doesn't have, in the words docs/deploy.md quotes.
    assert f"Can't locate revision identified by '{LATER_REVISION}'" in run.stderr
    assert "can log in" not in run.stdout
    assert version(url) == LATER_REVISION                  # never restamped to this code's head
    assert rolpassword(scratch.admin, probe) is None


def test_cli_needs_every_variable(capsys):
    """A missing or unusable variable stops the command (2) before any database work, naming it, never a value."""
    env = {"ADMIN_DATABASE_URL": "postgresql+psycopg://desk_admin:adminPlaceholder@nowhere.invalid/desk",
           "KERNEL_ROLE_PASSWORD": "kernelPlaceholder", "API_ROLE_PASSWORD": "",
           "MOCKPAY_ROLE_PASSWORD": "mockpayPlaceholder"}
    assert main(["migrate-and-roles"], env) == 2
    assert capsys.readouterr().err == "admin: API_ROLE_PASSWORD is not set\n"
    assert main(["migrate-and-roles"], {"KERNEL_ROLE_PASSWORD": "kernelPlaceholder"}) == 2
    assert capsys.readouterr().err == (
        "admin: ADMIN_DATABASE_URL, API_ROLE_PASSWORD, MOCKPAY_ROLE_PASSWORD are not set\n")
    assert main(["migrate-and-roles"], {**env, "API_ROLE_PASSWORD": "contraseña"}) == 2
    assert capsys.readouterr().err == "admin: API_ROLE_PASSWORD must be ASCII\n"
    with pytest.raises(SystemExit) as usage:                  # no command
        main([], env)
    assert usage.value.code == 2
