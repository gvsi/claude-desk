"""Jev can only add a block after the prose scan and alongside Sonnet."""

import asyncio
import functools
import logging
from dataclasses import replace

import httpx2
import pytest

from desk.kernel_service import jev, ledger
from desk.kernel_service.decisions import SoftPromiseVerdict
from desk.kernel_service.settings import KernelSettings

from .fakes import FakeJev
from .helpers import kernel_ctx
from .test_adapters import visitor_of
from .test_reply_check import VISITOR_NEXT_STEPS, checked, clause, own_quote, reply_entries


async def test_jev_adds_block_and_both_verdicts_are_ledgered(app, client, reviewer, monkeypatch):
    app.state.kernel = replace(app.state.kernel, settings=replace(app.state.kernel.settings, typesafe_api_key="fake-key"))
    fake = FakeJev(top=0.95)
    monkeypatch.setattr(jev, "evaluate", fake.evaluate)
    copy, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, "Here is the information.")
    assert not verdict.ok
    assert [(v.kind, v.rule_id, v.span) for v in verdict.violations] == [
        ("soft_promise", "soft.jev", "Here is the information.")]
    assert fake.inputs == [("Here is the information.", [], VISITOR_NEXT_STEPS)]
    entry, = await reply_entries(app, copy)
    scores = dict.fromkeys(jev.STATEMENTS, "0.0")
    scores["claims_done"] = "0.95"
    assert entry.event.summary["soft_checks"] == {
        "sonnet": {"flags": {"promises_beyond_cards": False, "denies_being_ai": False}, "blocked": False},
        "jev": {"status": "ok", "scores": scores, "blocked": True, "latency_ms": 10,
                "top_statement": "claims_done"}}
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        assert (await ledger.page(ctx, copy.desk_id)).chain_ok


@pytest.mark.parametrize(("sonnet_blocks", "top", "status", "rules"), [
    (False, 0.94, "ok", []),
    (True, 0.0, "ok", ["soft.promise"]),
    (True, 0.95, "ok", ["soft.promise", "soft.jev"]),
    (False, 0.0, "timeout", []),
    (False, 0.0, "error", []),
    (True, 0.0, "error", ["soft.promise"]),
])
async def test_jev_only_adds_blocks(app, client, reviewer, monkeypatch, sonnet_blocks, top, status, rules):
    app.state.kernel = replace(app.state.kernel, settings=replace(app.state.kernel.settings, typesafe_api_key="fake-key"))
    fake = FakeJev(top=top, status=status)
    monkeypatch.setattr(jev, "evaluate", fake.evaluate)
    reviewer.soft_answer = SoftPromiseVerdict(promises_beyond_cards=sonnet_blocks, denies_being_ai=False)
    copy, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, "Here is the information.")
    assert verdict.ok == (not rules)
    assert [v.rule_id for v in verdict.violations] == rules
    entry, = await reply_entries(app, copy)
    jev_record = entry.event.summary["soft_checks"]["jev"]
    assert jev_record["status"] == status
    assert jev_record["blocked"] == ("soft.jev" in rules)
    if status == "ok":
        assert set(jev_record["scores"]) == set(jev.STATEMENTS)
        assert float(jev_record["scores"]["claims_done"]) == top
    else:
        assert jev_record["scores"] is None
    assert entry.event.summary["soft_checks"]["sonnet"]["blocked"] == sonnet_blocks


@pytest.mark.parametrize("placeholder", [None, "", "unset"])
async def test_no_key_never_calls_jev_or_logs_a_warning(app, client, monkeypatch, caplog, placeholder):
    # ECS injects the literal DeskData SecretString until the owner sets a real key; a local run may have none.
    if placeholder is None:
        monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    else:
        monkeypatch.setenv("TYPESAFE_API_KEY", placeholder)
    settings = replace(app.state.kernel.settings, typesafe_api_key=KernelSettings.from_env().typesafe_api_key)
    app.state.kernel = replace(app.state.kernel, settings=settings)
    caplog.set_level(logging.DEBUG)
    assert not app.state.kernel.settings.typesafe_api_key

    async def forbidden(*args, **kwargs):
        raise AssertionError("Jev must not be called without a key")

    monkeypatch.setattr(jev, "evaluate", forbidden)
    copy, visitor = await visitor_of(app, client)
    for _ in range(2):
        assert (await checked(client, visitor, "Here is the information.")).ok
    assert not [record for record in caplog.records if record.name == jev.__name__]
    entries = await reply_entries(app, copy)
    assert all(entry.event.summary["soft_checks"]["jev"] == jev.Result(status="off").ledger_summary()
               for entry in entries)


async def test_scan_failure_skips_both_checkers(app, client, reviewer, monkeypatch):
    app.state.kernel = replace(app.state.kernel, settings=replace(app.state.kernel.settings, typesafe_api_key="fake-key"))
    fake = FakeJev(top=1.0)
    monkeypatch.setattr(jev, "evaluate", fake.evaluate)
    copy, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, "That costs $10.")
    assert not verdict.ok
    assert not fake.inputs and not reviewer.soft_inputs
    entry, = await reply_entries(app, copy)
    assert entry.event.summary["soft_checks"] is None


async def test_checkers_start_together(app, client, reviewer, monkeypatch):
    app.state.kernel = replace(app.state.kernel, settings=replace(app.state.kernel.settings, typesafe_api_key="fake-key"))
    sonnet_started, jev_started = asyncio.Event(), asyncio.Event()
    sonnet = reviewer.soft_promise
    fake = FakeJev(top=0.1)

    async def wait_for_jev(data):
        sonnet_started.set()
        await asyncio.wait_for(jev_started.wait(), 0.5)
        return await sonnet(data)

    async def wait_for_sonnet(*args, **kwargs):
        jev_started.set()
        await asyncio.wait_for(sonnet_started.wait(), 0.5)
        return await fake.evaluate(*args, **kwargs)

    reviewer.soft_promise = wait_for_jev
    monkeypatch.setattr(jev, "evaluate", wait_for_sonnet)
    _, visitor = await visitor_of(app, client)
    assert (await checked(client, visitor, "Here is the information.")).ok


@pytest.mark.parametrize("failure", ["http", "timeout", "malformed", "missing"])
async def test_provider_failures_leave_sonnet_standing(app, client, monkeypatch, failure):
    app.state.kernel = replace(app.state.kernel, settings=replace(app.state.kernel.settings, typesafe_api_key="fake-key"))
    copy, visitor = await visitor_of(app, client)

    def handle(request):
        if failure == "timeout":
            raise httpx2.ReadTimeout("fake", request=request)
        if failure == "malformed":
            return httpx2.Response(200, text="not JSON")
        answers = {name: {"noul": 0.99} for name in jev.STATEMENTS if name != "timing"}
        return httpx2.Response(503 if failure == "http" else 200, json={"answers": answers})

    monkeypatch.setattr(jev.httpx2, "AsyncClient", functools.partial(
        httpx2.AsyncClient, transport=httpx2.MockTransport(handle)))
    assert (await checked(client, visitor, "Here is the information.")).ok
    entry, = await reply_entries(app, copy)
    assert entry.event.summary["soft_checks"]["jev"]["status"] == ("timeout" if failure == "timeout" else "error")
    assert entry.event.summary["soft_checks"]["jev"]["scores"] is None


async def test_jev_reads_the_same_shown_prose_and_cards_as_sonnet(app, client, reviewer, monkeypatch):
    app.state.kernel = replace(app.state.kernel, settings=replace(app.state.kernel.settings, typesafe_api_key="fake-key"))
    fake = FakeJev()
    monkeypatch.setattr(jev, "evaluate", fake.evaluate)
    _, visitor = await visitor_of(app, client)
    quote = await own_quote(client, visitor)
    verdict = await checked(client, visitor, "Ｈere is your quote.\u200b", [clause("quote", quote.fact_id)])
    assert verdict.ok
    sonnet = reviewer.soft_inputs[-1]
    assert fake.inputs == [("Here is your quote.", [f"Quote card: {verdict.blocks[1].text}"], sonnet.next_steps)]
    assert fake.inputs[0] == (sonnet.prose, sonnet.cards, sonnet.next_steps)
