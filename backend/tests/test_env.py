"""DESK_ENV: one list of development environments for the kernel's signer and the database URLs."""

import desk_kernel
import pytest

import desk.db.session
from desk.db.session import database_url
from desk.env import DEVELOPMENT_ENVS, is_development

# Development names, as the plans run them, with the whitespace and case variants both sides forgive,
# and names that aren't development, including near misses that only Unicode rules would match.
DEVELOPMENT = (*DEVELOPMENT_ENVS, " Development ", "DEV", "CI\n", "\tdev")
NOT_DEVELOPMENT = ("production", "Production", "prod", "producton", "staging", "deployed", " dev", "dev\x0b",
                   "\x1fdev", "Cİ")


def test_development_envs_are_the_kernels():
    assert DEVELOPMENT_ENVS == {"", "dev", "development", "test", "ci", "local"}
    assert set(desk_kernel.DEVELOPMENT_ENVS) == DEVELOPMENT_ENVS


def test_the_signer_and_database_urls_agree_on_development(monkeypatch):
    monkeypatch.delenv("DESK_SIGNING_SEED", raising=False)
    monkeypatch.delenv("KERNEL_DATABASE_URL", raising=False)
    monkeypatch.setattr(desk.db.session, "_dotenv", lambda: {"KERNEL_DATABASE_URL": "postgresql+psycopg://from-dotenv"})
    monkeypatch.delenv("DESK_ENV", raising=False)
    assert is_development()                                           # unset is development
    assert desk_kernel.Signer.from_env().dev_key is True
    assert database_url("KERNEL") == "postgresql+psycopg://from-dotenv"
    for env in DEVELOPMENT:
        monkeypatch.setenv("DESK_ENV", env)
        assert is_development(), repr(env)
        assert desk_kernel.Signer.from_env().dev_key is True, repr(env)
        assert database_url("KERNEL") == "postgresql+psycopg://from-dotenv", repr(env)
    for env in NOT_DEVELOPMENT:
        monkeypatch.setenv("DESK_ENV", env)
        assert not is_development(), repr(env)
        with pytest.raises(ValueError):
            desk_kernel.Signer.from_env()                             # the kernel refuses to start
        with pytest.raises(RuntimeError):
            database_url("KERNEL")                                    # no repository .env outside development
    monkeypatch.setenv("KERNEL_DATABASE_URL", "postgresql+psycopg://from-environment")
    assert database_url("KERNEL") == "postgresql+psycopg://from-environment"
