"""The API target over the real kernel: Plan 02a's `make_api_target` (`api_impl.py`).

These cases run on `--target api` once the kernel core (01a) is in `landed.toml`; until then they
are pending 01a, and `evals/tests/test_api_impl.py` runs the target over a stand-in kernel. Every
model call is scripted on the kernel target's fake model server. API code is imported only inside
a case, so collecting tier 1 never needs it.
"""

import json

import httpx
import pytest

from desk.kernel_api import Health
from evals.client import DeskClient
from evals.fakes import FakeAnthropic
from evals.tier1.targets import DUMMY_KEY, ApiTarget, KernelTarget, load_api_target
from evals.tier1.test_api_payloads import GREETING, OPENAPI, OPUS, chat_turn, send_reply

pytestmark = pytest.mark.requires("01a", "02a")


async def test_api_target_serves_health_and_a_copy(k: KernelTarget, api: ApiTarget, records):
    """`/api/health` answers with the kernel's own `Health`; the target's passcode, and no other,
    gives a fresh Turner copy, whose Desks are the kernel's, and the owner cookie for it."""
    async with DeskClient(api.base_url, api.passcode) as client:
        health = await client.health()
        assert health["ok"] is True and Health.model_validate(health["kernel"]) == k.health
        wrong = await client.request("enter", json={"passcode": "not the passcode"})
        assert (wrong.status_code, wrong.json()) == (401, {"error": "wrong_passcode"})
        copy = await client.enter()
        assert ("desk_owner", "/api/owner") in client.cookies()
    desks = await records.desks(copy["copy_id"])
    assert len(copy["desks"]) == 1, copy["desks"]
    assert {(desk["desk_id"], desk["slug"]) for desk in copy["desks"]} == {
        (row["desk_id"], row["slug"]) for row in desks}


async def test_fake_target_ignores_model_provider(
    k: KernelTarget, fake: FakeAnthropic, monkeypatch: pytest.MonkeyPatch
):
    """With `MODEL_PROVIDER=bedrock` and a Bedrock token in the environment, the fake target's app
    still uses the Claude API client at the kernel target's fake model server, and a visitor's turn
    reaches the fake."""
    from desk.api.model import AnthropicModel

    monkeypatch.setenv("MODEL_PROVIDER", "bedrock")
    monkeypatch.setenv("BEDROCK_BEARER_TOKEN", "a-bedrock-token-from-the-shell")
    api = load_api_target()(k, models="fake")
    await api.start()
    try:
        model = api.app.state.runtime.model
        assert type(model) is AnthropicModel and str(model._client.base_url).rstrip("/") == k.fake.url
        fake.script(OPUS, send_reply(GREETING))
        async with DeskClient(api.base_url, api.passcode) as client:
            copy = await client.enter()
            await client.open_chat(copy["desks"][0]["slug"])
            turn = await chat_turn(client, "Hello", (await client.transcript())["last_seq"] or None)
    finally:
        await api.stop()
    assert [event.type for event in turn].count("message") == 1, [event.type for event in turn]
    assert len(fake.calls(OPUS)) == 1, "the visitor's message made no model call on the kernel target's fake"


async def openapi_status(app) -> int:
    """What `app` answers to `GET /openapi.json`, asked in process with no lifespan (so nothing connects)."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://desk.test") as client:
        return (await client.get("/openapi.json")).status_code


async def test_only_the_evals_target_serves_an_openapi_document(api: ApiTarget, monkeypatch: pytest.MonkeyPatch):
    """The target's app serves its own OpenAPI document at `/openapi.json`, the committed export,
    for Plan 05a's conformance case; an app built as production builds it, by `create_app` or by
    uvicorn's `app_factory()`, answers 404 there, so the evals-only route can't reach production."""
    from desk.api.main import app_factory, create_app

    async with httpx.AsyncClient(base_url=api.base_url, trust_env=False) as client:
        served = await client.get("/openapi.json")
    assert served.status_code == 200, served.status_code
    assert served.json() == json.loads(OPENAPI.read_text())

    built = create_app(api.settings)
    try:
        assert await openapi_status(built) == 404
    finally:
        await built.state.runtime.model.aclose()
    for name in ("ANTHROPIC_BASE_URL", "MODEL_PROVIDER", "BEDROCK_BEARER_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
                 "ANTHROPIC_AWS_API_KEY", "ANTHROPIC_CUSTOM_HEADERS", "TRUSTED_PROXY_HOPS", "KERNEL_URL"):
        monkeypatch.delenv(name, raising=False)
    for name, value in (("DESK_ENV", "production"), ("API_DATABASE_URL", api.api_dsn),
                        ("ANTHROPIC_API_KEY", DUMMY_KEY), ("PASSCODE_HASH", api.settings.passcode_hash),
                        ("PUBLIC_ORIGIN", "https://desk.example")):
        monkeypatch.setenv(name, value)
    production = app_factory()
    try:
        assert production.state.runtime.settings.production
        assert await openapi_status(production) == 404
    finally:
        await production.state.runtime.model.aclose()
