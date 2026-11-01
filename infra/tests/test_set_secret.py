"""set_secret.py: the owner sets the Anthropic key or the passcode hash, never echoed or printed,
and tags the secret with the version it wrote, so the deploy preflight knows the current value is
the owner's and not a generated placeholder."""

import io

import pytest
from botocore.stub import Stubber
from conftest import load_script, unsigned_client

KEY_ID = "desk/anthropic-api-key"
HASH_ID = "desk/passcode-hash"
# A made-up value: what the owner would type, never a real key.
TYPED = "typed-value-7c1e4b90"
VERSION = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"


class _Pipe(io.StringIO):
    """Standard input that a hash is piped into."""

    def isatty(self) -> bool:
        return False


class _Terminal(io.StringIO):
    def isatty(self) -> bool:
        return True


@pytest.fixture
def secrets():
    client = unsigned_client("secretsmanager")
    with Stubber(client) as stub:
        yield client, stub
        stub.assert_no_pending_responses()


def _expect_write(stub: Stubber, secret_id: str, value: str) -> None:
    stub.add_response(
        "put_secret_value",
        {"ARN": f"arn:aws:secretsmanager:us-west-2:123456789012:secret:{secret_id}-AbCdEf", "Name": secret_id,
         "VersionId": VERSION},
        {"SecretId": secret_id, "SecretString": value},
    )
    stub.add_response(
        "tag_resource", {}, {"SecretId": secret_id, "Tags": [{"Key": "owner-set", "Value": VERSION}]}
    )


def _no_typing(prompt: str = "") -> str:
    raise AssertionError("getpass was called")


@pytest.mark.parametrize("secret_id", ["desk/signing-seed", "desk/db/admin", "desk/mockpay-key", "other"])
def test_writes_only_allowed_secret_ids(secrets, monkeypatch, capsys, secret_id):
    client, _ = secrets  # no response queued: any AWS call fails the test
    module = load_script("set_secret")
    monkeypatch.setattr(module.getpass, "getpass", _no_typing)

    assert module.main([secret_id], client=client, stdin=_Terminal()) == 2
    assert KEY_ID in capsys.readouterr().err


@pytest.mark.parametrize("secret_id", [KEY_ID, "desk/typesafe-api-key"])
def test_reads_without_echo_and_never_prints(secrets, monkeypatch, capsys, secret_id):
    client, stub = secrets
    module = load_script("set_secret")
    prompts = []

    def getpass(prompt: str = "") -> str:
        prompts.append(prompt)
        return TYPED

    monkeypatch.setattr(module.getpass, "getpass", getpass)
    _expect_write(stub, secret_id, TYPED)

    assert module.main([secret_id], client=client, stdin=_Terminal()) == 0
    out, err = capsys.readouterr()
    assert prompts and secret_id in prompts[0] and TYPED not in prompts[0]
    assert TYPED not in out + err
    assert secret_id in out and VERSION in out


def test_reads_a_piped_hash_from_stdin(secrets, monkeypatch, capsys):
    client, stub = secrets
    module = load_script("set_secret")
    monkeypatch.setattr(module.getpass, "getpass", _no_typing)
    _expect_write(stub, HASH_ID, TYPED)

    assert module.main([HASH_ID, "--stdin"], client=client, stdin=_Pipe(TYPED + "\n")) == 0
    out, err = capsys.readouterr()
    assert TYPED not in out + err


def test_stdin_from_a_terminal_is_refused(secrets, monkeypatch, capsys):
    """Typing into --stdin would echo the value; the owner drops --stdin to type it hidden."""
    client, _ = secrets
    module = load_script("set_secret")
    monkeypatch.setattr(module.getpass, "getpass", _no_typing)

    assert module.main([HASH_ID, "--stdin"], client=client, stdin=_Terminal(TYPED)) == 2
    assert "--stdin" in capsys.readouterr().err


@pytest.mark.parametrize("value", ["", "   ", "\n"])
def test_rejects_empty_value(secrets, monkeypatch, capsys, value):
    client, _ = secrets
    module = load_script("set_secret")
    monkeypatch.setattr(module.getpass, "getpass", lambda prompt="": value)

    assert module.main([KEY_ID], client=client, stdin=_Terminal()) == 1
    assert module.main([HASH_ID, "--stdin"], client=client, stdin=_Pipe(value)) == 1
    assert "empty" in capsys.readouterr().err


def test_tags_the_secret_with_the_version_it_wrote(secrets, monkeypatch, capsys):
    """put_secret_value, then `owner-set=<the version it wrote>`, which the preflight compares with
    the current version; Stubber checks both calls, in order."""
    client, stub = secrets
    module = load_script("set_secret")
    monkeypatch.setattr(module.getpass, "getpass", lambda prompt="": f"  {TYPED}  ")
    _expect_write(stub, KEY_ID, TYPED)

    assert module.main([KEY_ID], client=client, stdin=_Terminal()) == 0
    assert f"tagged owner-set={VERSION}" in capsys.readouterr().out


def test_aws_failure_fails_without_the_value(secrets, monkeypatch, capsys):
    client, stub = secrets
    module = load_script("set_secret")
    monkeypatch.setattr(module.getpass, "getpass", lambda prompt="": TYPED)
    stub.add_client_error("put_secret_value", "ResourceNotFoundException", "Secrets Manager can't find it.")

    assert module.main([KEY_ID], client=client, stdin=_Terminal()) == 1
    out, err = capsys.readouterr()
    assert "ResourceNotFoundException" in err and "DeskData" in err
    assert TYPED not in out + err
