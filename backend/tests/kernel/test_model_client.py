"""The kernel's model client: the SDK client the reviewer and the soft-promise check share, built
with its key and host passed explicitly, so it never reads a credential or a host of its own.

Every case builds the client through `make_decisions`, the kernel's one way to build it. No test
reaches the network: the SDK's constructor is wrapped to hand it an `httpx2.MockTransport` (the
SDK's own HTTP library) that records each request, or the client calls a loopback server. Every
case points the SDK's config directory at an empty folder, so none can read the developer's own
profile, and a failure names the credential a request carried, never its value.
"""

import functools
import json
import threading
from collections.abc import Iterator, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import anthropic
import httpx2
import pytest

from desk.kernel_service.app import KernelSettings, create_app
from desk.kernel_service.clock import SystemClock
from desk.kernel_service.decisions import (NO_API_KEY, AnthropicDecisions, SoftPromiseInput, SoftPromiseVerdict,
                                           make_decisions)

from .test_decisions import review_input

# The variables the SDK reads for a credential, a host or extra headers, and the kernel's own,
# which a developer's shell may export.
VARIABLES = ("DESK_ENV", "DESK_DECISIONS", "DESK_PROVE", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
             "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_CONFIG_DIR", "ANTHROPIC_CUSTOM_HEADERS",
             "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE", "ANTHROPIC_FEDERATION_RULE_ID",
             "ANTHROPIC_ORGANIZATION_ID")
DATABASE_URL = "postgresql+psycopg://desk_kernel:pw-in-the-url@127.0.0.1:9/desk"   # never opened here
TEST_KEY = "key-for-tests"
PASSES = '{"promises_beyond_cards": false, "denies_being_ai": false}'
REPLY = SoftPromiseInput(language="en", prose="Here is your quote.", cards=["$180.00\nDrain clearing"])


@pytest.fixture
def config_dir(tmp_path) -> Path:
    """The SDK's config directory for a case: empty unless the case writes a profile into it."""
    folder = tmp_path / "anthropic-config"
    folder.mkdir()
    return folder


@pytest.fixture
def environ(monkeypatch, config_dir):
    """The variables above cleared and the SDK's config directory set to `config_dir`, then
    `set_all(...)` sets some."""
    for name in VARIABLES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ANTHROPIC_CONFIG_DIR", str(config_dir))

    def set_all(values: dict[str, str]) -> None:
        for name, value in values.items():
            monkeypatch.setenv(name, value)

    return set_all


def settings(env: str = "dev", decisions: str = "anthropic") -> KernelSettings:
    return KernelSettings(database_url=DATABASE_URL, env=env, decisions=decisions)


def answer() -> httpx2.Response:
    """A passing soft-promise verdict, as the Messages API sends it."""
    return httpx2.Response(200, json={
        "id": "msg_test", "type": "message", "role": "assistant", "model": "claude-sonnet-5-5",
        "content": [{"type": "text", "text": PASSES}], "stop_reason": "end_turn", "stop_sequence": None,
        "usage": {"input_tokens": 10, "output_tokens": 5}})


@pytest.fixture
def sent(monkeypatch) -> list[httpx2.Request]:
    """Every request the kernel's client sends, answered with a passing verdict: the SDK's client
    is built with a mock transport, whatever else the kernel passes it."""
    requests: list[httpx2.Request] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        requests.append(request)
        return answer()

    transport = httpx2.MockTransport(handle)
    monkeypatch.setattr(anthropic, "AsyncAnthropic", functools.partial(
        anthropic.AsyncAnthropic, http_client=httpx2.AsyncClient(transport=transport)))
    return requests


def credential(headers: Mapping[str, str]) -> str:
    """Which credential a request carried, by name, so a failure never prints one."""
    authorization = headers.get("authorization")
    if "x-api-key" in headers:
        return "an x-api-key header"
    if authorization == f"Bearer {NO_API_KEY}":
        return "the placeholder"
    if authorization == f"Bearer {TEST_KEY}":
        return "the test key"
    return "no credential" if authorization is None else "another credential"


def carries(request: httpx2.Request, text: str) -> bool:
    """Whether `text` is anywhere in what a request carries: its URL, headers and body."""
    return text in str(request.url) + json.dumps(dict(request.headers)) + request.content.decode()


async def test_ambient_credentials_never_reach_a_request(environ, sent):
    # A developer's shell may hold another account's token or name a profile (the config directory
    # is empty); with no key of its own, the kernel sends the placeholder key instead, so the
    # Claude API answers 401 and a fake answers.
    environ({"ANTHROPIC_AUTH_TOKEN": "ambient", "ANTHROPIC_PROFILE": "ambient"})
    backend = make_decisions(settings())
    assert isinstance(backend, AnthropicDecisions)
    client = backend._client
    assert (client.api_key, client.auth_token, client.credentials) == (NO_API_KEY, None, None)

    verdict, usage = await backend.soft_promise(REPLY)
    assert verdict == SoftPromiseVerdict(promises_beyond_cards=False, denies_being_ai=False)
    (request,) = sent
    assert str(request.url) == "https://api.anthropic.com/v1/messages"      # no test hook: the Claude API
    assert credential(request.headers) == "the placeholder"
    leaked = carries(request, "ambient")
    assert not leaked


async def test_a_development_key_is_sent_as_given(environ, sent):
    # A developer's own key, given as ANTHROPIC_API_KEY, is the key the kernel sends, and nothing
    # ambient joins it.
    environ({"ANTHROPIC_API_KEY": TEST_KEY, "ANTHROPIC_AUTH_TOKEN": "ambient"})
    backend = make_decisions(settings())
    assert (backend._client.api_key, backend._client.auth_token) == (TEST_KEY, None)
    await backend.soft_promise(REPLY)
    (request,) = sent
    assert str(request.url) == "https://api.anthropic.com/v1/messages"
    assert credential(request.headers) == "the test key"
    leaked = carries(request, "ambient")
    assert not leaked


async def test_an_on_disk_profile_is_never_read(environ, sent, config_dir):
    # The SDK's default profile, as an interactive login leaves it: with no key, the SDK sends its token.
    (config_dir / "configs").mkdir()
    (config_dir / "configs" / "default.json").write_text(json.dumps({"authentication": {"type": "user_oauth"}}))
    (config_dir / "credentials").mkdir()
    token = config_dir / "credentials" / "default.json"
    token.write_text(json.dumps({"type": "oauth_token", "access_token": "ambient-profile-token"}))
    token.chmod(0o600)

    backend = make_decisions(settings())
    assert (backend._client.auth_token, backend._client.credentials) == (None, None)
    await backend.soft_promise(REPLY)
    (request,) = sent
    assert credential(request.headers) == "the placeholder"
    leaked = carries(request, "ambient")
    assert not leaked


async def test_custom_headers_are_refused_before_any_client(environ, monkeypatch):
    # The SDK sends each ANTHROPIC_CUSTOM_HEADERS line with every request, where an Authorization or
    # X-Api-Key line replaces or joins the kernel's key and bills another account.
    built: list[dict] = []

    def spy(*args, **kwargs):
        built.append(kwargs)
        raise AssertionError("no SDK client is built")

    monkeypatch.setattr(anthropic, "AsyncAnthropic", spy)
    # an offline development kernel builds no client, and is refused all the same
    backends = ("anthropic", "offline")
    for headers in ("Authorization: Bearer ambient", "X-Api-Key: ambient"):
        for key in (None, TEST_KEY):
            environ({"ANTHROPIC_CUSTOM_HEADERS": headers})
            if key is None:
                monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
            else:
                monkeypatch.setenv("ANTHROPIC_API_KEY", key)
            for backend in backends:
                with pytest.raises(RuntimeError, match="ANTHROPIC_CUSTOM_HEADERS") as refused:
                    make_decisions(settings(decisions=backend))
                assert "ambient" not in str(refused.value)

    # and the kernel doesn't start
    for backend in backends:
        kernel = create_app(settings(decisions=backend), clock=SystemClock())
        with pytest.raises(RuntimeError, match="ANTHROPIC_CUSTOM_HEADERS") as refused:
            async with kernel.router.lifespan_context(kernel):
                pass
        assert "ambient" not in str(refused.value)
    assert built == []


async def test_custom_headers_set_after_the_start_never_reach_a_request(environ, sent):
    # The refusal runs when the kernel starts. Every later call uses the client built then, never a
    # copy that would read the environment again, so a variable set afterwards (by code in the
    # process) adds nothing to a request.
    backend = make_decisions(settings())
    await backend.soft_promise(REPLY)
    environ({"ANTHROPIC_CUSTOM_HEADERS": "Authorization: Bearer ambient\nX-Injected: ambient"})
    await backend.review(review_input())
    await backend.soft_promise(REPLY)
    assert len(sent) == 3
    for request in sent:
        assert credential(request.headers) == "the placeholder"
        assert "x-injected" not in request.headers
        leaked = carries(request, "ambient")
        assert not leaked


async def test_each_call_is_one_try_with_its_own_timeout(environ, monkeypatch):
    # The client makes no retries, so an overloaded answer is the call's failure, asked once, and
    # each check's timeout goes with its request (the reviewer's 4 s, the soft-promise check's 6 s).
    requests: list[httpx2.Request] = []

    def overloaded(request: httpx2.Request) -> httpx2.Response:
        requests.append(request)
        return httpx2.Response(529, json={"type": "error", "error": {"type": "overloaded_error",
                                                                     "message": "Overloaded"}})

    monkeypatch.setattr(anthropic, "AsyncAnthropic", functools.partial(
        anthropic.AsyncAnthropic, http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(overloaded))))
    backend = make_decisions(settings())
    assert backend._client.max_retries == 0
    reviewed = await backend.review(review_input())
    verdict, usage = await backend.soft_promise(REPLY)
    assert (reviewed.review, reviewed.usage.status, verdict, usage.status) == (None, "error", None, "error")
    assert [request.extensions["timeout"]["read"] for request in requests] == [4.0, 8.0]


@pytest.mark.parametrize("named_by", ["settings", "process"])
async def test_production_calls_the_claude_api_whatever_the_base_url(named_by, environ, sent):
    # ANTHROPIC_BASE_URL is a test hook: production refuses it at the start ("Test hooks"), and the
    # client never reads it there either, whether the settings or the process name production.
    environ({"ANTHROPIC_API_KEY": TEST_KEY, "ANTHROPIC_BASE_URL": "https://gateway.example"})
    if named_by == "process":
        environ({"DESK_ENV": "production"})
    backend = make_decisions(settings("production" if named_by == "settings" else "dev"))
    await backend.soft_promise(REPLY)
    (request,) = sent
    assert str(request.url) == "https://api.anthropic.com/v1/messages"
    assert credential(request.headers) == "the test key"
    assert not carries(request, "gateway")


async def test_the_key_is_one_run_of_printable_ascii_and_production_needs_one(environ, monkeypatch):
    real = anthropic.AsyncAnthropic
    built: list[dict] = []

    def spy(*args, **kwargs):
        built.append(kwargs)
        raise AssertionError("no SDK client is built")

    monkeypatch.setattr(anthropic, "AsyncAnthropic", spy)
    # A malformed key never reaches a header, an error message or a log: the refusal names the
    # variable, never the value.
    for env in ("dev", "production"):
        for key in ("sk-ambient\n", " sk-ambient", "sk ambient", "sk-ambi\u00e9nt"):
            environ({"ANTHROPIC_API_KEY": key})
            with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY") as refused:
                make_decisions(settings(env))
            assert "ambi" not in str(refused.value)

    # Production requires the real key, unset and empty alike, whether the settings or the process
    # name production, and the kernel doesn't start without it.
    for missing in (None, ""):
        if missing is None:
            monkeypatch.delenv("ANTHROPIC_API_KEY")
        else:
            environ({"ANTHROPIC_API_KEY": missing})
        with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
            make_decisions(settings("production"))
        environ({"DESK_ENV": "production"})
        with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
            make_decisions(settings("dev"))
        monkeypatch.delenv("DESK_ENV")
    kernel = create_app(settings("production"), clock=SystemClock())
    with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
        async with kernel.router.lifespan_context(kernel):
            pass
    assert built == []

    # Outside production an empty key is the placeholder, never "" (which would send "Bearer ").
    monkeypatch.setattr(anthropic, "AsyncAnthropic", real)
    assert make_decisions(settings())._client.api_key == NO_API_KEY


class MessagesHandler(BaseHTTPRequestHandler):
    """The Messages API on a real socket, answering every call with a passing verdict."""

    seen: list[dict] = []

    def log_message(self, *args) -> None:
        pass

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        headers = {name.lower(): value for name, value in self.headers.items()}
        MessagesHandler.seen.append({"path": self.path, "headers": headers, "body": json.loads(body)})
        response = answer()
        self.send_response(response.status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response.content)))
        self.end_headers()
        self.wfile.write(response.content)


@pytest.fixture
def messages_url() -> Iterator[str]:
    MessagesHandler.seen = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), MessagesHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()


async def test_no_key_in_development_reaches_the_hook_on_a_real_socket(environ, messages_url):
    environ({"ANTHROPIC_BASE_URL": messages_url})
    verdict, usage = await make_decisions(settings()).soft_promise(REPLY)
    assert verdict == SoftPromiseVerdict(promises_beyond_cards=False, denies_being_ai=False)
    assert usage.status == "ok"
    (seen,) = MessagesHandler.seen
    assert seen["path"] == "/v1/messages" and credential(seen["headers"]) == "the placeholder"
    assert seen["body"]["model"] == "claude-sonnet-5-5"


async def test_spanish_reaches_the_model_as_text(environ, sent):
    # Each check sends its input as one JSON object with its letters as themselves, so Spanish
    # reaches the model as Spanish, not as \u escapes of its accented letters.
    backend = make_decisions(settings())
    await backend.review(review_input(note="Señora Peña, ¿el martes por la tarde?"))
    await backend.soft_promise(SoftPromiseInput(language="es", prose="Mañana le confirmo la cita.", cards=[]))
    review, soft = (request.content.decode() for request in sent)
    assert "Señora Peña, ¿el martes por la tarde?" in review and "Mañana le confirmo la cita." in soft
    assert "\\u" not in review + soft
