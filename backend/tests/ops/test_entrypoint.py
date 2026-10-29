"""The container entrypoint: database URLs composed from parts, then the command exec'd."""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy.engine import make_url

from desk.ops.entrypoint import EntrypointError, compose_env, main

HOST = "desk.cluster-test.us-west-2.rds.amazonaws.com"

# The kernel container's environment as the deploy seam sets it (placeholder values, not secrets).
KERNEL_ENV = {
    "DESK_ENV": "production",
    "DESK_DB_URLS": "KERNEL,MOCKPAY",
    "KERNEL_DB_USER": "desk_kernel",
    "MOCKPAY_DB_USER": "desk_mockpay",
    "KERNEL_DB_PASSWORD": "kernelPlaceholder1",
    "MOCKPAY_DB_PASSWORD": "mockpayPlaceholder2",
    "DB_HOST": HOST,
    "DB_PORT": "5432",
    "DB_NAME": "desk",
    "DESK_SIGNING_SEED": "signing-seed-placeholder",
    "ANTHROPIC_API_KEY": "anthropic-key-placeholder",
    "MOCKPAY_KEY": "mockpay-key-placeholder",
}


def test_composes_url_per_prefix():
    env = compose_env(KERNEL_ENV)
    assert env["KERNEL_DATABASE_URL"] == (
        f"postgresql+psycopg://desk_kernel:kernelPlaceholder1@{HOST}:5432/desk?sslmode=require"
    )
    assert env["MOCKPAY_DATABASE_URL"] == (
        f"postgresql+psycopg://desk_mockpay:mockpayPlaceholder2@{HOST}:5432/desk?sslmode=require"
    )
    assert "API_DATABASE_URL" not in env
    # DB_SSLMODE overrides the default, for a local database without TLS.
    local = compose_env({**KERNEL_ENV, "DB_SSLMODE": "disable"})
    assert local["KERNEL_DATABASE_URL"].endswith("@" + HOST + ":5432/desk?sslmode=disable")


def test_password_is_url_encoded():
    env = compose_env({**KERNEL_ENV, "DESK_DB_URLS": "KERNEL", "KERNEL_DB_PASSWORD": "p@ss/w:rd"})
    url = env["KERNEL_DATABASE_URL"]
    assert url == f"postgresql+psycopg://desk_kernel:p%40ss%2Fw%3Ard@{HOST}:5432/desk?sslmode=require"
    parsed = make_url(url)                      # SQLAlchemy reads back the exact parts
    assert (parsed.username, parsed.password, parsed.host, parsed.port, parsed.database) == (
        "desk_kernel", "p@ss/w:rd", HOST, 5432, "desk")
    assert parsed.query == {"sslmode": "require"}


def test_password_variables_are_removed():
    env = compose_env(KERNEL_ENV)
    assert "KERNEL_DB_PASSWORD" not in env
    assert "MOCKPAY_DB_PASSWORD" not in env
    assert not [name for name in env if name.endswith("_DB_PASSWORD")]
    # Everything else the container was given passes through unchanged.
    kept = {name: value for name, value in KERNEL_ENV.items() if not name.endswith("_DB_PASSWORD")}
    assert {name: env[name] for name in kept} == kept


@pytest.fixture
def no_exec(monkeypatch):
    """Record any exec instead of replacing the test process."""
    calls = []
    monkeypatch.setattr(os, "execvpe", lambda *args: calls.append(args))
    return calls


def test_missing_part_fails_closed(no_exec, capsys):
    env = {name: value for name, value in KERNEL_ENV.items() if name != "KERNEL_DB_PASSWORD"}
    with pytest.raises(EntrypointError, match="KERNEL_DB_PASSWORD"):
        compose_env(env)
    with pytest.raises(SystemExit) as exit_info:
        main(["python", "-m", "desk.kernel_service"], env)
    assert exit_info.value.code == 2
    assert no_exec == []
    assert "KERNEL_DB_PASSWORD" in capsys.readouterr().err
    # Every part is required, for every listed prefix; an empty value counts as missing.
    for name in ("KERNEL_DB_USER", "KERNEL_DB_PASSWORD", "MOCKPAY_DB_USER", "MOCKPAY_DB_PASSWORD",
                 "DB_HOST", "DB_PORT", "DB_NAME"):
        absent = {key: value for key, value in KERNEL_ENV.items() if key != name}
        for broken in (absent, {**KERNEL_ENV, name: ""}):
            with pytest.raises(EntrypointError, match=name):
                compose_env(broken)


def test_existing_url_conflict_fails_closed(no_exec, capsys):
    preset = "postgresql+psycopg://desk_admin:preset-pw@elsewhere:5432/desk"
    env = {**KERNEL_ENV, "KERNEL_DATABASE_URL": preset}
    with pytest.raises(EntrypointError, match="KERNEL_DATABASE_URL") as error:
        compose_env(env)
    assert "preset-pw" not in str(error.value)
    with pytest.raises(SystemExit) as exit_info:
        main(["python", "-m", "desk.kernel_service"], env)
    assert exit_info.value.code == 2
    assert no_exec == []
    # Listing a prefix twice is a conflict too, not a second composition.
    with pytest.raises(EntrypointError, match="KERNEL"):
        compose_env({**KERNEL_ENV, "DESK_DB_URLS": "KERNEL,MOCKPAY,KERNEL"})


def test_no_prefixes_passes_env_through(no_exec):
    local = {"DESK_ENV": "dev", "KERNEL_DATABASE_URL": "postgresql+psycopg://desk_kernel:x@localhost:5433/desk",
             "KERNEL_DB_PASSWORD": "untouchedPlaceholder"}
    assert compose_env(local) == local
    main(["python", "-m", "desk.kernel_service"], local)
    assert no_exec == [("python", ["python", "-m", "desk.kernel_service"], local)]


SECRETS = ("kernelPlaceholder1", "mockpayPlaceholder2", "signing-seed-placeholder", "anthropic-key-placeholder",
           "mockpay-key-placeholder", "preset-pw")


def test_errors_never_print_secret_values(no_exec, capsys):
    broken = [
        {k: v for k, v in KERNEL_ENV.items() if k != "MOCKPAY_DB_PASSWORD"},
        {k: v for k, v in KERNEL_ENV.items() if k != "DB_HOST"},
        {**KERNEL_ENV, "KERNEL_DATABASE_URL": "postgresql+psycopg://desk_kernel:preset-pw@h:5432/desk"},
        {**KERNEL_ENV, "DESK_DB_URLS": "KERNEL,KERNEL"},
    ]
    for env in broken:
        with pytest.raises(SystemExit):
            main(["python", "-m", "desk.kernel_service"], env)
        out, err = capsys.readouterr()
        assert err.startswith("entrypoint: ")
        assert not [secret for secret in SECRETS if secret in out + err]
    assert no_exec == []
    # The module as the container runs it: exit 2, the variable named, no value printed.
    env = {k: v for k, v in KERNEL_ENV.items() if k != "MOCKPAY_DB_PASSWORD"}
    result = subprocess.run([sys.executable, "-m", "desk.ops.entrypoint", "python", "-c", "print('ran')"],
                            env=env, cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True)
    assert result.returncode == 2
    assert "MOCKPAY_DB_PASSWORD" in result.stderr
    assert "ran" not in result.stdout
    assert not [secret for secret in SECRETS if secret in result.stdout + result.stderr]


API_ENV = {
    "DESK_ENV": "production",
    "DESK_DB_URLS": "API",
    "API_DB_USER": "desk_api",
    "API_DB_PASSWORD": "api-pw",
    "DB_HOST": HOST,
    "DB_PORT": "5432",
    "DB_NAME": "desk",
    "KERNEL_URL": "http://127.0.0.1:8701",
    "PUBLIC_ORIGIN": "https://d111111abcdef8.cloudfront.net",
    "TRUSTED_PROXY_HOPS": "2",
    "ANTHROPIC_API_KEY": "anthropic-key-placeholder",
    "PASSCODE_HASH": "passcode-hash-placeholder",
}

SEAM = {
    "kernel": (
        ["python", "-m", "desk.kernel_service"],
        KERNEL_ENV,
        {
            **{k: v for k, v in KERNEL_ENV.items() if k not in ("KERNEL_DB_PASSWORD", "MOCKPAY_DB_PASSWORD")},
            "KERNEL_DATABASE_URL": f"postgresql+psycopg://desk_kernel:kernelPlaceholder1@{HOST}:5432/desk?sslmode=require",
            "MOCKPAY_DATABASE_URL": (
                f"postgresql+psycopg://desk_mockpay:mockpayPlaceholder2@{HOST}:5432/desk?sslmode=require"
            ),
        },
    ),
    "api": (
        ["uvicorn", "--factory", "desk.api.main:app_factory", "--host", "0.0.0.0", "--port", "8700",
         "--timeout-keep-alive", "310"],
        API_ENV,
        {
            **{k: v for k, v in API_ENV.items() if k != "API_DB_PASSWORD"},
            "API_DATABASE_URL": f"postgresql+psycopg://desk_api:api-pw@{HOST}:5432/desk?sslmode=require",
        },
    ),
}


@pytest.mark.parametrize("container", sorted(SEAM))
def test_main_execs_the_seam_commands(container, no_exec):
    command, given, expected = SEAM[container]
    main(command, given)
    assert no_exec == [(command[0], command, expected)]


MALFORMED = [("DESK_DB_URLS", ""), ("DESK_DB_URLS", "KERNEL,"), ("DESK_DB_URLS", "kernel"),
             ("DESK_DB_URLS", "KERNEL;MOCKPAY"), ("DB_PORT", "54x2"), ("DB_PORT", "70000"), ("DB_HOST", "evil@host"),
             ("DB_HOST", "host/desk"), ("DB_NAME", "desk?sslmode=disable"), ("DB_SSLMODE", "off")]


def test_malformed_parts_fail_closed(no_exec, capsys):
    for name, value in MALFORMED:
        with pytest.raises(EntrypointError, match=name):
            compose_env({**KERNEL_ENV, name: value})
        with pytest.raises(SystemExit) as exit_info:
            main(["python", "-m", "desk.kernel_service"], {**KERNEL_ENV, name: value})
        assert exit_info.value.code == 2, (name, value)
        err = capsys.readouterr().err
        assert name in err and (value == "" or value not in err), (name, value, err)
    assert no_exec == []


def test_self_check_and_usage(no_exec, capsys, monkeypatch):
    with pytest.raises(SystemExit) as exit_info:
        main(["--self-check"], {})
    assert exit_info.value.code == 0
    assert capsys.readouterr().out == "entrypoint ok\n"
    with pytest.raises(SystemExit) as exit_info:      # no command: nothing to run
        main([], KERNEL_ENV)
    assert exit_info.value.code == 2
    assert "usage" in capsys.readouterr().err

    def missing(*args):
        raise FileNotFoundError(2, "No such file or directory")
    monkeypatch.setattr(os, "execvpe", missing)
    with pytest.raises(SystemExit) as exit_info:      # a command that isn't there exits like a shell's
        main(["no-such-command"], KERNEL_ENV)
    assert exit_info.value.code == 127
    assert "no-such-command" in capsys.readouterr().err
