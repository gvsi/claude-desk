"""The API target over the real kernel: Plan 02a's `make_api_target` (`api_impl.py`).

These cases run on `--target api` once the kernel core (01a) is in `landed.toml`; until then they
are pending 01a, and `evals/tests/test_api_impl.py` runs the target over a stand-in kernel. Every
model call is scripted on the kernel target's fake model server. API code is imported only inside
a case, so collecting tier 1 never needs it.
"""

import pytest

from desk.kernel_api import Health
from evals.client import DeskClient
from evals.fakes import FakeAnthropic
from evals.tier1.targets import ApiTarget, KernelTarget, load_api_target
from evals.tier1.test_api_payloads import GREETING, OPUS, chat_turn, send_reply

pytestmark = pytest.mark.requires("01a", "02a")


async def test_api_target_serves_health_and_a_copy(k: KernelTarget, api: ApiTarget, records):
    """`/api/health` answers with the kernel's own `Health`; the target's passcode, and no other,
    gives a fresh Rivera copy, whose Desks are the kernel's, and the owner cookie for it."""
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
