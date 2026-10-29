"""The API process's settings: Plan 06b's runtime variables, with production refusing what only tests use."""

import dataclasses

import pytest

from desk.api.settings import Settings

VARIABLES = ("DESK_ENV", "API_DATABASE_URL", "ANTHROPIC_API_KEY", "PASSCODE_HASH", "KERNEL_URL", "PUBLIC_ORIGIN",
             "TRUSTED_PROXY_HOPS", "ANTHROPIC_BASE_URL")
DATABASE_URL = "postgresql+psycopg://desk_api:pw-in-the-url@localhost:5433/desk"
PRODUCTION = {
    "DESK_ENV": "production",
    "API_DATABASE_URL": DATABASE_URL,
    "ANTHROPIC_API_KEY": "key-value-for-tests",
    "PASSCODE_HASH": "hash-value-for-tests",
    "PUBLIC_ORIGIN": "https://desk.example.com",
    "TRUSTED_PROXY_HOPS": "2",
}


@pytest.fixture
def environ(monkeypatch):
    for name in VARIABLES:
        monkeypatch.delenv(name, raising=False)

    def set_all(values: dict[str, str]) -> None:
        for name, value in values.items():
            monkeypatch.setenv(name, value)

    return set_all


def test_development_defaults(environ):
    environ({"API_DATABASE_URL": DATABASE_URL})
    settings = Settings.from_env()
    assert settings.production is False
    assert settings.api_database_url == DATABASE_URL
    assert settings.anthropic_api_key is None and settings.passcode_hash is None
    assert settings.kernel_url == "http://127.0.0.1:8701"
    assert settings.public_origin == "http://localhost:5173"
    assert settings.trusted_proxy_hops == 0
    assert settings.anthropic_base_url is None
    assert settings.a2a_loopback == "http://127.0.0.1:8700"
    assert settings.kernel_ro_schema == "kernel_ro"


def test_production_reads_plan_06bs_variables(environ):
    environ(PRODUCTION)
    settings = Settings.from_env()
    assert settings.production is True
    assert settings.anthropic_api_key == "key-value-for-tests"
    assert settings.passcode_hash == "hash-value-for-tests"
    assert settings.public_origin == "https://desk.example.com"
    assert settings.trusted_proxy_hops == 2
    environ({"PUBLIC_ORIGIN": "https://localhost.invalid/"})     # a trailing slash is not a path
    assert Settings.from_env().public_origin == "https://localhost.invalid"


@pytest.mark.parametrize("missing", ["API_DATABASE_URL", "ANTHROPIC_API_KEY", "PASSCODE_HASH", "PUBLIC_ORIGIN"])
def test_production_requires_its_variables(environ, monkeypatch, missing):
    environ(PRODUCTION)
    monkeypatch.delenv(missing)
    with pytest.raises(RuntimeError, match=missing):
        Settings.from_env()


@pytest.mark.parametrize("origin", ["http://desk.example.com", "https://desk.example.com/app", "https://",
                                    "https://desk.example.com?x=1", "https://user@desk.example.com", "desk.example.com"])
def test_production_needs_an_https_origin_with_no_path(environ, origin):
    environ(PRODUCTION | {"PUBLIC_ORIGIN": origin})
    with pytest.raises(RuntimeError, match="PUBLIC_ORIGIN"):
        Settings.from_env()


def test_production_refuses_a_model_test_hook(environ):
    environ(PRODUCTION | {"ANTHROPIC_BASE_URL": "http://127.0.0.1:9999"})
    with pytest.raises(RuntimeError, match="ANTHROPIC_BASE_URL"):
        Settings.from_env()
    environ({"DESK_ENV": "test"})
    assert Settings.from_env().anthropic_base_url == "http://127.0.0.1:9999"


@pytest.mark.parametrize("hops", ["-1", "two", "1.5", " "])
def test_trusted_proxy_hops_is_a_count(environ, hops):
    environ({"API_DATABASE_URL": DATABASE_URL, "TRUSTED_PROXY_HOPS": hops})
    with pytest.raises(RuntimeError, match="TRUSTED_PROXY_HOPS"):
        Settings.from_env()


def test_overrides_are_checked_too(environ):
    environ(PRODUCTION)
    settings = Settings.from_env()
    overridden = dataclasses.replace(settings, a2a_loopback="http://127.0.0.1:18700")
    assert overridden.a2a_loopback == "http://127.0.0.1:18700"
    with pytest.raises(RuntimeError, match="ANTHROPIC_BASE_URL"):
        dataclasses.replace(settings, anthropic_base_url="http://127.0.0.1:9999")


def test_secrets_stay_out_of_repr(environ):
    environ(PRODUCTION)
    text = repr(Settings.from_env())
    assert "Settings(" in text
    for secret in ("pw-in-the-url", "key-value-for-tests", "hash-value-for-tests"):
        assert secret not in text
