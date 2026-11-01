"""The real kernel target: its health, a fresh Rivera copy, restarts and the travelling clock."""

import json
import re

import pytest

from desk.contracts import Decision, SessionCreated
from evals.fakes import FakeAnthropic, Json
from evals.tier1.args import quote_args
from evals.tier1.harness import Auth, Expect, KernelHarness
from evals.tier1.targets import SYMCC_REQUIRED, KernelTarget, TargetError

pytestmark = pytest.mark.requires("01a")

REVIEW_PASS = Json({"within_charter_bp": 10000, "manipulation_bp": 0, "recommendation": "allow"})
SEED_PRICES = {"deposit": 2000, "drain": 18000, "heater": 15000, "leak": 25000,   # "Rivera seed"
               "pipe": 10000, "short-notice": 5000}
SEED_CONTACTS = {"Dana": "dana@example.com", "Bob": "bob@example.com"}


async def hold_a_quote(k: KernelHarness, fake: FakeAnthropic, visitor: SessionCreated) -> Decision:
    """A drain quote at 80% off, which the seed's `rv-quote` card (no discount) leaves to Maria."""
    fake.default("claude-sonnet-5-5", REVIEW_PASS)   # the reviewer passes, if the kernel asks it
    call = {"call_id": "smoke-quote", "tool": "native.quote", "args": quote_args("drain", requested_discount_bp=8000)}
    return await k.call(
        "POST /decide",
        body={"session_id": visitor.state.session_id, "generation": visitor.state.generation, "call": call},
        auth=Auth.session(visitor),
        expect=Expect(fields={"outcome": "hold", "state": "held"}),
    )


async def test_health_reports_dev_key_and_symcc(k: KernelHarness):
    health = await k.call(
        "GET /health",
        auth=Auth.none(),
        expect=Expect(fields={"dev_signing_key": True, "proof_mode": "symcc", "public_key_hex": {"$len": 64}}),
    )
    if k.is_real:
        assert re.fullmatch(r"[0-9a-f]{64}", health.public_key_hex)
        assert health.unproved_seeds == []


async def test_new_copy_seeds_rivera(k: KernelHarness, records):
    copy = await k.new_copy()
    assert len(copy.desk_ids) == 1 and copy.owner_session.kind == "owner"
    if k.is_real:
        prices = {row["item_id"]: row["unit_cents"] for row in await records.price_items(copy.copy_id)}
        assert prices == SEED_PRICES
        people = {row["display_name"].split()[0]: row for row in await records.people(copy.copy_id)}
        assert sorted(people) == ["Bob", "Dana"]
        # The views show masked contacts only: no raw contact anywhere in the copy's records.
        snapshot = json.dumps(await records.snapshot(copy.copy_id), default=str)
        for name, contact in SEED_CONTACTS.items():
            assert people[name]["masked_contact"] and people[name]["masked_contact"] != contact
            assert contact not in snapshot
        held = [row for row in await records.decisions(copy.copy_id) if row["state"] == "held"]
        assert [(row["tool"], row["outcome"]) for row in held] == [("native.quote", "hold")]
        assert held[0]["ledger_seq"] is not None


async def test_restart_keeps_state(k: KernelHarness, fake: FakeAnthropic):
    copy = await k.new_copy()
    visitor = await k.visitor(copy)
    held = await hold_a_quote(k, fake, visitor)
    if k.is_real:
        await k.restart()
    await k.call(
        "GET /decisions/{id}",
        path={"id": held.decision_id},
        auth=Auth.session(visitor),
        expect=Expect(fields={"decision_id": held.decision_id, "state": "held"}),
    )
    same_session = Expect(fields={"session.session_id": visitor.state.session_id})
    await k.call("GET /whoami", auth=Auth.session(visitor), expect=same_session)


async def test_travel_moves_kernel_time(k: KernelHarness, fake: FakeAnthropic):
    copy = await k.new_copy()
    held = await hold_a_quote(k, fake, await k.visitor(copy))
    k.clock.advance(24 * 3600 + 1)   # a hold lasts 24 hours; the visitor's session has closed, the owner's hasn't
    await k.call(
        "GET /decisions/{id}",
        path={"id": held.decision_id},
        auth=Auth.owner(copy),
        expect=Expect(fields={"decision_id": held.decision_id, "state": "expired"}),
    )


@pytest.mark.white_box
async def test_bounded_mode_stops_the_target(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DESK_PROVE", "/nonexistent")   # the startup selftest can't run desk-prove
    with pytest.raises(TargetError, match=re.escape(SYMCC_REQUIRED)):
        await KernelTarget(models="fake").start()
    target = await KernelTarget(models="fake", allow_bounded=True).start()
    try:
        await target.call("GET /health", auth=Auth.none(), expect=Expect(fields={"proof_mode": "bounded"}))
    finally:
        await target.stop()
