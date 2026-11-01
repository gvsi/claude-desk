"""The API process's settings: Plan 06b's runtime variables, with production refusing what only tests use, and the
model provider (`MODEL_PROVIDER`: the Claude API, or Amazon Bedrock for local evals), whose credential rules
`make_model` closes in code.

No test reaches the network: model calls go through `FakeMessagesApi` (an `httpx2.MockTransport`), or to a
loopback server.
"""

import dataclasses
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import anthropic
import httpx2
import pytest
from pydantic import BaseModel

from desk.api.model import NO_API_KEY, AnthropicModel, ModelRequest, ModelUnavailable, make_model
from desk.api.settings import Settings
from tests.api.fakes import FakeMessagesApi

VARIABLES = ("DESK_ENV", "API_DATABASE_URL", "ANTHROPIC_API_KEY", "PASSCODE_HASH", "KERNEL_URL", "PUBLIC_ORIGIN",
             "TRUSTED_PROXY_HOPS", "ANTHROPIC_BASE_URL", "BUSINESS_TOOLS_ENABLED", "SETUP_POLICY_CLAIMS_ENABLED",
             # the provider's variables, and the SDK's own, which a developer's shell may export
             "MODEL_PROVIDER", "AWS_REGION", "BEDROCK_BEARER_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
             "ANTHROPIC_AWS_API_KEY", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE",
             "ANTHROPIC_CONFIG_DIR", "AWS_DEFAULT_REGION", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL")
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


def test_business_tools_require_the_deployment_switch(environ):
    environ({"API_DATABASE_URL": DATABASE_URL})
    assert Settings.from_env().business_tools_enabled is False
    environ({"BUSINESS_TOOLS_ENABLED": "1"})
    assert Settings.from_env().business_tools_enabled is True
    environ({"BUSINESS_TOOLS_ENABLED": "0"})
    assert Settings.from_env().business_tools_enabled is False


@pytest.mark.parametrize("value,enabled", [(None, True), ("0", False), ("1", True), ("", True), ("false", True)])
def test_setup_policy_claims_are_enabled_unless_switched_off(environ, value, enabled):
    environ({"API_DATABASE_URL": DATABASE_URL})
    assert Settings(api_database_url=DATABASE_URL).setup_policy_claims_enabled is True
    if value is not None:
        environ({"SETUP_POLICY_CLAIMS_ENABLED": value})
    assert Settings.from_env().setup_policy_claims_enabled is enabled


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


@pytest.mark.parametrize("values", [{"API_DATABASE_URL": DATABASE_URL}, PRODUCTION])
def test_replay_night_is_on_and_never_read_from_the_environment(environ, values):
    """Each demo copy asks the kernel for the recorded night (Plan 01d); the setting is code, so no variable turns it
    off (the kernel's own `REPLAY_NIGHT_OFF=1` is the off switch) and only the evals target sets it false."""
    environ(values | {"REPLAY_NIGHT": "0", "REPLAY_NIGHT_OFF": "1", "DESK_REPLAY_NIGHT": "false"})
    assert Settings.from_env().replay_night is True
    assert dataclasses.replace(Settings.from_env(), replay_night=False).replay_night is False


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
    environ({"DESK_ENV": "dev", "MODEL_PROVIDER": "bedrock", "BEDROCK_BEARER_TOKEN": "bedrock-key-for-tests"})
    development = Settings.from_env()
    assert development.bedrock_bearer_token == "bedrock-key-for-tests"
    assert "bedrock-key-for-tests" not in repr(development)


# The model provider ("The credentials"): the Claude API by default, Amazon Bedrock for local evals only.

MESSAGES = [{"role": "user", "content": [{"type": "text", "text": "<visitor_message>Hi</visitor_message>"}]}]


class Verdict(BaseModel):
    urgent: bool


def structured() -> ModelRequest:
    return ModelRequest(route="triage", system=[{"type": "text", "text": "Triage."}], messages=MESSAGES,
                        output_schema=Verdict, effort="low", max_tokens=200)


def shown(request: httpx2.Request) -> str:
    return str(request.url) + json.dumps(dict(request.headers)) + request.content.decode()


UNAUTHORIZED = httpx2.Response(401, json={"type": "error", "error": {"type": "authentication_error",
                                                                     "message": "invalid x-api-key"}})


async def test_provider_defaults_to_anthropic(environ, monkeypatch, tmp_path):
    environ({"API_DATABASE_URL": DATABASE_URL})
    settings = Settings.from_env()
    assert settings.model_provider == "anthropic" and settings.aws_region == "us-west-2"
    assert settings.bedrock_bearer_token is None
    default = make_model(settings)
    assert isinstance(default, AnthropicModel)
    await default.aclose()
    for other in ("vertex", "Bedrock"):
        environ({"MODEL_PROVIDER": other})
        with pytest.raises(ValueError, match="MODEL_PROVIDER"):
            Settings.from_env()
        with pytest.raises(ValueError, match="MODEL_PROVIDER"):
            dataclasses.replace(settings, model_provider=other)
    monkeypatch.delenv("MODEL_PROVIDER")

    # With no key of its own, the client never falls back to the SDK's ambient credentials: an explicit
    # placeholder key is sent instead, so the Claude API answers 401 and a fake at ANTHROPIC_BASE_URL answers.
    environ({"ANTHROPIC_AUTH_TOKEN": "ambient", "ANTHROPIC_PROFILE": "ambient", "ANTHROPIC_CONFIG_DIR": str(tmp_path)})
    server = FakeMessagesApi(UNAUTHORIZED)
    model = make_model(Settings.from_env(), http_client=server.client())
    assert isinstance(model, AnthropicModel)
    sdk = model._client
    assert (sdk.api_key, sdk.auth_token, sdk.credentials) == (NO_API_KEY, None, None)
    with pytest.raises(ModelUnavailable):
        await model.call(structured())
    (sent,) = server.requests
    assert sent.headers["authorization"] == f"Bearer {NO_API_KEY}" and "ambient" not in shown(sent)
    await model.aclose()

    # Nor does it read ANTHROPIC_BASE_URL itself: the host comes from Settings, the Claude API by default.
    environ({"ANTHROPIC_BASE_URL": "https://gateway.example"})
    server = FakeMessagesApi(UNAUTHORIZED)
    model = make_model(dataclasses.replace(Settings.from_env(), anthropic_base_url=None), http_client=server.client())
    with pytest.raises(ModelUnavailable):
        await model.call(structured())
    assert str(server.requests[0].url) == "https://api.anthropic.com/v1/messages"
    await model.aclose()
    monkeypatch.delenv("ANTHROPIC_BASE_URL")

    # ANTHROPIC_CUSTOM_HEADERS would add or replace the key on every request, so it is refused before any client.
    built: list[object] = []

    def spy(*args, **kwargs):
        built.append(kwargs)
        raise AssertionError("no SDK client is built")

    monkeypatch.setattr(anthropic, "AsyncAnthropic", spy)
    for headers in ("Authorization: Bearer ambient", "X-Api-Key: ambient"):
        for key in (None, "key-value-for-tests"):
            environ({"ANTHROPIC_CUSTOM_HEADERS": headers})
            if key is None:
                monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
            else:
                monkeypatch.setenv("ANTHROPIC_API_KEY", key)
            with pytest.raises(RuntimeError, match="ANTHROPIC_CUSTOM_HEADERS") as refused:
                make_model(Settings.from_env())
            assert "ambient" not in str(refused.value)
    monkeypatch.delenv("ANTHROPIC_CUSTOM_HEADERS")

    # A set key is one run of printable ASCII, like the Bedrock key, and the refusal never quotes it.
    for key in ("sk-ambient\n", " sk-ambient", "sk ambient"):
        environ({"ANTHROPIC_API_KEY": key})
        with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY") as refused:
            make_model(Settings.from_env())
        assert "ambient" not in str(refused.value)
    assert built == []


class MessagesHandler(BaseHTTPRequestHandler):
    """The Messages API on a real socket, answering every call with one structured verdict."""

    seen: list[dict] = []

    def log_message(self, *args) -> None:
        pass

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        headers = {name.lower(): value for name, value in self.headers.items()}
        MessagesHandler.seen.append({"path": self.path, "headers": headers, "body": json.loads(body)})
        answer = json.dumps({
            "id": "msg_local", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
            "content": [{"type": "text", "text": json.dumps({"urgent": True})}], "stop_reason": "end_turn",
            "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 5}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(answer)))
        self.end_headers()
        self.wfile.write(answer)


@pytest.fixture
def fake_messages_url() -> Iterator[str]:
    MessagesHandler.seen = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), MessagesHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()


async def test_no_key_reaches_a_fake_on_a_real_socket(environ, fake_messages_url):
    environ({"API_DATABASE_URL": DATABASE_URL, "ANTHROPIC_BASE_URL": fake_messages_url})
    settings = Settings.from_env()
    assert settings.anthropic_api_key is None
    model = make_model(settings)
    try:
        response = await model.call(structured())
    finally:
        await model.aclose()
    assert response.parsed == Verdict(urgent=True) and response.model == "claude-opus-5-5"
    (seen,) = MessagesHandler.seen
    assert seen["path"] == "/v1/messages" and seen["headers"]["authorization"] == f"Bearer {NO_API_KEY}"
    assert seen["body"]["model"] == "claude-opus-5-5"


def test_production_refuses_bedrock(environ):
    environ(PRODUCTION | {"MODEL_PROVIDER": "bedrock"})
    with pytest.raises(RuntimeError, match="MODEL_PROVIDER"):
        Settings.from_env()
    environ({"MODEL_PROVIDER": "anthropic"})
    settings = Settings.from_env()
    with pytest.raises(RuntimeError, match="MODEL_PROVIDER"):
        dataclasses.replace(settings, model_provider="bedrock")
    with pytest.raises(RuntimeError, match="BEDROCK_BEARER_TOKEN"):
        dataclasses.replace(settings, bedrock_bearer_token="bedrock-key-for-tests")

    keys = ("BEDROCK_BEARER_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_AWS_API_KEY")
    for name in keys:
        environ(PRODUCTION | {other: "" for other in keys} | {name: "bedrock-key-for-tests"})
        with pytest.raises(RuntimeError, match=name) as refused:
            Settings.from_env()
        assert "bedrock-key-for-tests" not in str(refused.value)
    environ(PRODUCTION | {"BEDROCK_BEARER_TOKEN": "", "AWS_BEARER_TOKEN_BEDROCK": "", "ANTHROPIC_AWS_API_KEY": "",
                          "AWS_REGION": "us-west-2"})                 # ECS sets AWS_REGION in every task
    assert Settings.from_env().production is True

    environ({"DESK_ENV": "dev", "MODEL_PROVIDER": "bedrock", "BEDROCK_BEARER_TOKEN": "bedrock-key-for-tests",
             "AWS_REGION": "us-east-1"})
    development = Settings.from_env()
    assert (development.model_provider, development.aws_region) == ("bedrock", "us-east-1")
    assert development.bedrock_bearer_token == "bedrock-key-for-tests"
