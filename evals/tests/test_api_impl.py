"""Plan 02a's `make_api_target` (`evals/tier1/api_impl.py`), before the kernel core lands.

Tier 1's API cases (`evals/tier1/test_02_target.py` among them) need Plan 01a's kernel, so until
it lands these tests are what runs the target: the settings it gives the API, whatever the
environment says, and the app it serves over the harness's `KernelTarget` on a stand-in kernel.
Nothing here calls the network or a live model.
"""

import asyncio
import re
import secrets
import sys
import types
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import httpx
import psycopg
import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from desk.api.model import ANTHROPIC_API_URL, AnthropicModel, BedrockModel, make_model
from desk.api.passcode import check_passcode, hash_passcode
from desk.api.settings import Settings
from desk.db.session import database_url, libpq_url
from desk.kernel_api import Health
from evals.client import DeskClient
from evals.tier1 import api_impl, targets
from evals.tier1.harness import TravelClock
from evals.tier1.targets import DUMMY_KEY, ApiTarget, KernelTarget, TargetError

KERNEL = types.SimpleNamespace(url="http://127.0.0.1:8701", fake=types.SimpleNamespace(url="http://127.0.0.1:8799"),
                               clock=TravelClock())
BASE_URL = "http://127.0.0.1:8790"
DSN = "postgresql+psycopg://desk_api:unused@127.0.0.1:1/desk"
PASSCODE_HASH = hash_passcode("a passcode for these tests")
# What a developer's shell might export: none of it reaches a fake-model target.
SHELL = {
    "MODEL_PROVIDER": "bedrock", "BEDROCK_BEARER_TOKEN": "shell-bedrock-token", "AWS_REGION": "eu-west-1",
    "ANTHROPIC_API_KEY": "sk-ant-from-the-shell", "ANTHROPIC_BASE_URL": "http://127.0.0.1:9", "DESK_ENV": "production",
    "KERNEL_URL": "http://127.0.0.1:1", "PASSCODE_HASH": "scrypt$from$the$shell",
    "PUBLIC_ORIGIN": "https://desk.example", "TRUSTED_PROXY_HOPS": "2",
}


@pytest.fixture(autouse=True)
def _no_custom_headers(monkeypatch: pytest.MonkeyPatch) -> None:
    """`ANTHROPIC_CUSTOM_HEADERS`, which a shell may export, refuses every model client."""
    monkeypatch.delenv("ANTHROPIC_CUSTOM_HEADERS", raising=False)


@pytest.mark.parametrize("provider", ["anthropic", "bedrock"])
async def test_fake_settings_ignore_the_environment(monkeypatch: pytest.MonkeyPatch, provider: str):
    """With fake models the API runs on the Claude API client at the kernel target's fake model
    server, with the dummy key and `DESK_ENV=test`, whatever the shell or the `provider` argument
    says: a Bedrock provider and token, another model host and key, a production environment and
    the API's own variables are never read."""
    for name, value in SHELL.items():
        monkeypatch.setenv(name, value)
    settings = api_impl.target_settings(KERNEL, models="fake", provider=provider, passcode_hash=PASSCODE_HASH,
                                        base_url=BASE_URL, api_dsn=DSN)
    assert (settings.desk_env, settings.production) == ("test", False)
    assert (settings.model_provider, settings.bedrock_bearer_token) == ("anthropic", None)
    assert (settings.anthropic_base_url, settings.anthropic_api_key) == (KERNEL.fake.url, DUMMY_KEY)
    assert (settings.kernel_url, settings.passcode_hash, settings.a2a_loopback) == (KERNEL.url, PASSCODE_HASH, BASE_URL)
    assert settings.api_database_url == DSN
    assert (settings.public_origin, settings.trusted_proxy_hops, settings.kernel_ro_schema) == (
        "http://localhost:5173", 0, "kernel_ro")
    model = make_model(settings)   # what create_app builds from them
    try:
        assert type(model) is AnthropicModel
        assert str(model._client.base_url).rstrip("/") == KERNEL.fake.url
        assert model._client.api_key == DUMMY_KEY
    finally:
        await model.aclose()


def real_settings(provider: str, env_file) -> Settings:
    return api_impl.target_settings(KERNEL, models="real", provider=provider, passcode_hash=PASSCODE_HASH,
                                    base_url=BASE_URL, api_dsn=DSN, env_file=env_file)


async def test_real_settings_take_the_providers_credential_from_dotenv(monkeypatch: pytest.MonkeyPatch, tmp_path):
    """With real models the API runs in development on the provider it is given, with that
    provider's credential from `.env` before the environment, at the provider's own host: never the
    fake model server, and never the other provider's credential."""
    env_file = tmp_path / ".env"
    env_file.write_text("ANTHROPIC_API_KEY=sk-ant-from-dotenv\nBEDROCK_BEARER_TOKEN='bedrock-from-dotenv'\n"
                        "AWS_REGION=us-east-1\n")
    for name, value in SHELL.items():
        monkeypatch.setenv(name, value)
    claude = real_settings("anthropic", env_file)
    assert (claude.desk_env, claude.model_provider) == ("dev", "anthropic")
    assert (claude.anthropic_api_key, claude.anthropic_base_url, claude.bedrock_bearer_token) == (
        "sk-ant-from-dotenv", None, None)
    assert (claude.kernel_url, claude.passcode_hash, claude.a2a_loopback) == (KERNEL.url, PASSCODE_HASH, BASE_URL)
    bedrock = real_settings("bedrock", env_file)
    assert (bedrock.desk_env, bedrock.model_provider, bedrock.aws_region) == ("dev", "bedrock", "us-east-1")
    assert (bedrock.bedrock_bearer_token, bedrock.anthropic_api_key, bedrock.anthropic_base_url) == (
        "bedrock-from-dotenv", None, None)
    models = [make_model(claude), make_model(bedrock)]
    try:
        assert [type(model) for model in models] == [AnthropicModel, BedrockModel]
        assert str(models[0]._client.base_url).rstrip("/") == ANTHROPIC_API_URL
        assert str(models[1]._client.base_url).startswith("https://bedrock-mantle.us-east-1.api.aws/")
    finally:
        for model in models:
            await model.aclose()

    # With nothing in `.env`, the environment's credential; with no region anywhere, the default.
    empty = tmp_path / "empty.env"
    empty.write_text("")
    monkeypatch.delenv("AWS_REGION")
    assert real_settings("anthropic", empty).anthropic_api_key == "sk-ant-from-the-shell"
    from_shell = real_settings("bedrock", empty)
    assert (from_shell.bedrock_bearer_token, from_shell.aws_region) == ("shell-bedrock-token", "us-west-2")


def test_real_settings_refuse_without_the_providers_credential(monkeypatch: pytest.MonkeyPatch, tmp_path):
    """A real-model target with no credential for its provider (or only tier 1's dummy key) refuses
    to build, naming the variable and never a value; the other provider's credential doesn't count."""
    for name in ("ANTHROPIC_API_KEY", "BEDROCK_BEARER_TOKEN", "AWS_REGION"):
        monkeypatch.delenv(name, raising=False)
    only_bedrock, only_claude, dummy = tmp_path / "bedrock.env", tmp_path / "claude.env", tmp_path / "dummy.env"
    only_bedrock.write_text("BEDROCK_BEARER_TOKEN=bedrock-from-dotenv\n")
    only_claude.write_text("ANTHROPIC_API_KEY=sk-ant-from-dotenv\nBEDROCK_BEARER_TOKEN=\n")
    dummy.write_text(f"ANTHROPIC_API_KEY={DUMMY_KEY}\n")
    for provider, env_file, variable in (("anthropic", only_bedrock, "ANTHROPIC_API_KEY"),
                                         ("anthropic", dummy, "ANTHROPIC_API_KEY"),
                                         ("bedrock", only_claude, "BEDROCK_BEARER_TOKEN")):
        with pytest.raises(TargetError, match=variable) as refused:
            real_settings(provider, env_file)
        assert not any(value in str(refused.value) for value in ("from-dotenv", DUMMY_KEY)), provider


def test_target_refuses_what_it_cant_run(monkeypatch: pytest.MonkeyPatch):
    """Unknown models or providers raise; real models are refused in a tier 1 process, which makes no
    model calls; fake models need the kernel target's fake model server, and any target a started
    kernel."""
    with pytest.raises(ValueError, match="models is 'fake' or 'real'"):
        api_impl.make_api_target(KERNEL, models="live")
    with pytest.raises(ValueError, match="provider is 'anthropic' or 'bedrock'"):
        api_impl.make_api_target(KERNEL, models="real", provider="vertex")
    monkeypatch.setattr(targets, "_real_models_refused", True)
    with pytest.raises(TargetError, match="tier 1 makes no model calls"):
        api_impl.make_api_target(KERNEL, models="real")
    assert api_impl.make_api_target(KERNEL, models="fake").models == "fake"
    for kernel, refusal in ((types.SimpleNamespace(url=KERNEL.url, fake=None), "KernelTarget\\(models='fake'\\)"),
                            (types.SimpleNamespace(url="", fake=KERNEL.fake), "start\\(\\) the kernel target first")):
        with pytest.raises(TargetError, match=refusal):
            api_impl.target_settings(kernel, models="fake", provider="anthropic", passcode_hash=PASSCODE_HASH,
                                     base_url=BASE_URL, api_dsn=DSN)


# The API over the harness's own kernel target, on a stand-in kernel app

STAND_IN_COPY = "copy-stand-in"
OWNER_STATE = {"session_id": "session-owner", "kind": "owner", "verified": True, "assurance": "owner_session",
               "mode": "ai", "generation": 0}
WORKER_START_S = 10.0   # how long the job worker may take to register once the app is serving


class StandInKernel:
    """`create_app(settings, clock)` as Plan 01a gives it, serving only what the API's health check
    and copy route call: `GET /health`, `POST /copies` and the owner's `GET /whoami`."""

    def __init__(self) -> None:
        self.owner_token = secrets.token_urlsafe(32)   # fresh each run: no token-like text in the source
        self.lifespan: list[str] = []

    def create_app(self, settings: object = None, clock: object = None) -> Starlette:
        @asynccontextmanager
        async def lifespan(app: Starlette):
            self.lifespan.append("startup")
            yield
            self.lifespan.append("shutdown")

        async def health(request: Request) -> JSONResponse:
            return JSONResponse({"version": "stand-in", "proof_mode": "symcc", "dev_signing_key": True,
                                 "public_key_hex": "ab" * 32, "key_id": "ab" * 8, "unproved_seeds": []})

        async def copies(request: Request) -> JSONResponse:
            return JSONResponse({"copy_id": STAND_IN_COPY, "desk_ids": ["desk-stand-in"], "owner_session": OWNER_STATE,
                                 "owner_token": self.owner_token})

        async def whoami(request: Request) -> JSONResponse:
            if request.headers.get("x-owner-session") != self.owner_token:
                return JSONResponse({"code": "auth"}, status_code=401)
            return JSONResponse({"kind": "owner", "copy_id": STAND_IN_COPY, "desk_id": None,
                                 "desk_ids": ["desk-stand-in"], "session": OWNER_STATE})

        async def not_found(request: Request) -> JSONResponse:
            return JSONResponse({"code": "not_found"}, status_code=404)

        return Starlette(lifespan=lifespan, routes=[
            Route("/health", health), Route("/copies", copies, methods=["POST"]), Route("/whoami", whoami),
            Route("/{rest:path}", not_found, methods=["GET", "POST", "PUT", "DELETE"]),
        ])


@pytest.fixture
def stand_in(monkeypatch: pytest.MonkeyPatch) -> StandInKernel:
    """The stand-in, where `KernelTarget` imports Plan 01a's `create_app` from."""
    kernel = StandInKernel()
    package = types.ModuleType("desk.kernel_service")
    package.__path__ = []
    module = types.ModuleType("desk.kernel_service.app")
    module.create_app = kernel.create_app
    monkeypatch.setitem(sys.modules, "desk.kernel_service", package)
    monkeypatch.setitem(sys.modules, "desk.kernel_service.app", module)
    return kernel


async def job_workers(dsn: str) -> set[int]:
    """The job queue's registered workers, read as the API's role."""
    async with await psycopg.AsyncConnection.connect(libpq_url(dsn)) as conn:
        rows = await (await conn.execute("SELECT id FROM procrastinate.procrastinate_workers")).fetchall()
    return {row[0] for row in rows}


async def registered_worker(dsn: str, before: set[int]) -> set[int]:
    """The workers registered since `before`, once there is one."""
    deadline = asyncio.get_running_loop().time() + WORKER_START_S
    while not (new := await job_workers(dsn) - before) and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    return new


async def test_target_serves_health_and_a_copy_over_the_kernel_target(
    stand_in: StandInKernel, monkeypatch: pytest.MonkeyPatch
):
    """`make_api_target(k, models="fake")` over a started `KernelTarget`: the app serves on its own
    loopback port, on the kernel target's clock, with a model client at the kernel target's fake
    model server though the shell names Bedrock; `/api/health` carries the kernel's `Health`; only
    the target's passcode gives a copy and its owner cookie; it serves its own OpenAPI document; the
    job worker runs until `stop()`, and then nothing is left serving."""
    for name in ("MODEL_PROVIDER", "BEDROCK_BEARER_TOKEN", "AWS_REGION"):
        monkeypatch.setenv(name, SHELL[name])
    k = await KernelTarget(models="fake").start()
    try:
        api = api_impl.make_api_target(k, models="fake")
        assert isinstance(api, ApiTarget) and api.kernel is k
        assert api.api_dsn == database_url("API")
        before = await job_workers(api.api_dsn)
        await api.start()
        try:
            assert re.fullmatch(r"http://127\.0\.0\.1:\d+", api.base_url) and api.base_url != k.url
            runtime = api.app.state.runtime
            assert runtime.settings is api.settings and api.settings.a2a_loopback == api.base_url
            assert (api.settings.kernel_url, api.settings.model_provider) == (k.url, "anthropic")
            assert type(runtime.model) is AnthropicModel
            assert str(runtime.model._client.base_url).rstrip("/") == k.fake.url
            assert check_passcode(api.passcode, api.settings.passcode_hash)
            moved = datetime(2026, 11, 3, 18, 0, tzinfo=UTC)
            k.travel(moved)
            assert abs((runtime.clock() - moved).total_seconds()) < 5   # the API's clock is the kernel target's
            async with DeskClient(api.base_url, api.passcode) as client:
                health = await client.health()
                assert health["ok"] is True and Health.model_validate(health["kernel"]) == k.health
                served = await client.http.get("/openapi.json")   # the target's own route, never production's
                assert served.status_code == 200 and served.json() == api.app.openapi()
                assert "/openapi.json" not in served.json()["paths"]
                wrong = await client.request("enter", json={"passcode": "not the passcode"})
                assert (wrong.status_code, wrong.json()) == (401, {"error": "wrong_passcode"})
                assert client.cookies() == []
                # The stand-in's copy has no kernel_ro rows, so it lists no Desks.
                assert await client.enter() == {"copy_id": STAND_IN_COPY, "desks": []}
                assert client.cookies() == [("desk_owner", "/api/owner")]
            worker = await registered_worker(api.api_dsn, before)
            assert len(worker) == 1, f"the API's job worker didn't register within {WORKER_START_S} s"
        finally:
            await api.stop()
        assert not worker & await job_workers(api.api_dsn), "the job worker outlived stop()"
        with pytest.raises(httpx.ConnectError):
            async with httpx.AsyncClient(trust_env=False) as plain:
                await plain.get(api.base_url + "/api/health")
    finally:
        await k.stop()   # fails on any model call the fake didn't script: the API made none
    assert stand_in.lifespan == ["startup", "shutdown"]
