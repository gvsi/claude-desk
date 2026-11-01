"""Kernel credentials are optional where supported and never appear in settings reprs."""

import pytest

from desk.kernel_service.settings import KernelSettings


def test_typesafe_key_is_optional_and_one_printable_token(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    assert KernelSettings.from_env().typesafe_api_key == ""
    monkeypatch.setenv("TYPESAFE_API_KEY", "")
    assert KernelSettings.from_env().typesafe_api_key == ""
    monkeypatch.setenv("TYPESAFE_API_KEY", "fake-typesafe-key")
    settings = KernelSettings.from_env()
    assert settings.typesafe_api_key == "fake-typesafe-key"
    assert "fake-typesafe-key" not in repr(settings)
    for key in ("bad key", "bad\nkey", " bad", "bad\tkey", "bád", "bad\x7f"):
        monkeypatch.setenv("TYPESAFE_API_KEY", key)
        with pytest.raises(ValueError, match="TYPESAFE_API_KEY") as error:
            KernelSettings.from_env()
        assert key not in str(error.value)
        with pytest.raises(ValueError, match="TYPESAFE_API_KEY"):
            KernelSettings(database_url="unused", typesafe_api_key=key)


@pytest.mark.parametrize("placeholder", ["", "unset", "UNSET", " UnSeT ", " "])
def test_typesafe_unset_placeholder_is_off(monkeypatch, placeholder):
    monkeypatch.setenv("TYPESAFE_API_KEY", placeholder)
    assert KernelSettings.from_env().typesafe_api_key == ""


def test_typesafe_missing_key_is_off(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    assert KernelSettings.from_env().typesafe_api_key == ""
