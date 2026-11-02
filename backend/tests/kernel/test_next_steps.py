"""Only fixed phrases for tools the session can actually call are offerable."""

from types import SimpleNamespace

import pytest
from sqlalchemy import select

from desk.next_steps import BUSINESS_BLOCK_STEPS, NEXT_STEPS, next_steps
from desk.kernel_service import adapters
from desk.db.models import Person, Tool

from .helpers import kernel_ctx, rows_of, verify_session
from .test_adapters import visitor_of
from .test_agent_auth import mint, open_agent, turn
from .test_business_tools import intake, put
from .test_context import context_of
from .test_reply_check import checked


def test_every_registered_tool_has_an_explicit_next_step_decision():
    assert set(adapters.ADAPTERS) == set(NEXT_STEPS) | {
        "native.fetch_website", "native.web_search", "native.read_memory", "native.charge_mandate"}
    assert len(NEXT_STEPS) == 10
    assert BUSINESS_BLOCK_STEPS == {
        "typed_booking": "booking a time a card shows",
        "intake": "taking a message", "urgent": "arranging a call back"}
    assert next_steps([SimpleNamespace(tool=name) for name in reversed(sorted(NEXT_STEPS))]) == [
        NEXT_STEPS[name] for name in sorted(NEXT_STEPS)]


def test_business_blocks_are_fixed_and_unknown_blocks_offer_nothing():
    def profile(block):
        return SimpleNamespace(tool="desk.request", business=SimpleNamespace(config=SimpleNamespace(block=block)))
    for block, phrase in BUSINESS_BLOCK_STEPS.items():
        assert next_steps([profile(block)]) == [phrase]
    assert next_steps([profile("purpose_payment"), profile("unknown")]) == []
    # an urgent tool beside the native call-back offers the same step once
    callback = SimpleNamespace(tool="native.request_callback")
    assert next_steps([profile("urgent"), callback]) == [NEXT_STEPS["native.request_callback"]]


@pytest.mark.parametrize("standing", ["visitor", "verified", "agent", "answering_off"])
async def test_soft_check_gets_exactly_the_resolved_session_steps(app, client, reviewer, frozen_clock, standing):
    copy, visitor = await visitor_of(app, client)
    if standing == "verified":
        [person] = await rows_of(app, copy.copy_id, select(Person).where(Person.ref == "dana"))
        await verify_session(app, copy.copy_id, visitor.session_id, person.person_id)
    elif standing == "agent":
        agent = await mint(client, copy.owner, copy.desk_id)
        created = await open_agent(client, copy.slug, agent, frozen_clock, mandate=False)
        visitor = turn(agent, copy.slug, created.state.session_id, frozen_clock)
    elif standing == "answering_off":
        response = await client.put(f"/desks/{copy.desk_id}/answering", headers=copy.owner, json={"on": False})
        assert response.status_code == 200
    seen = await context_of(client, visitor.session_id, visitor.headers)
    assert (await checked(client, visitor, "How can I help?")).ok
    [data] = reviewer.soft_inputs
    assert data.next_steps == next_steps(seen.tools)
    assert data.next_steps
    assert set(data.model_dump()) == {"language", "prose", "cards", "next_steps", "approved_names"}
    assert data.approved_names == []                      # the reply repeats no approved free name


@pytest.mark.parametrize("tool,state", [
    ("native.capture_lead", "intact"), ("native.capture_lead", "stale"),
    ("desk.new-enquiry", "intact"), ("desk.new-enquiry", "stale"),
    ("desk.new-enquiry", "unresolved"),
])
async def test_only_intact_resolved_rows_grant_the_message_step(
        app, client, reviewer, monkeypatch, tool, state):
    copy, visitor = await visitor_of(app, client)
    # Store a real configured intake so both readers exercise its row and adapter.
    assert (await put(client, copy, [intake()])).status_code == 200
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        rows = await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(
            Tool.desk_id == copy.desk_id, Tool.tool.in_(["native.capture_lead", "desk.new-enquiry"]))))
        for row in rows:
            row.status = "enabled" if row.tool == tool else "disabled"
            row.review_reason = None
            if row.tool == tool and state == "stale":
                row.profile_sha256 = "0" * 64
    if state == "unresolved":
        resolve = adapters.resolve

        async def unresolved(ctx, desk_id, name):
            return None if name == tool else await resolve(ctx, desk_id, name)

        monkeypatch.setattr(adapters, "resolve", unresolved)
    present = state == "intact"
    seen = await context_of(client, visitor.session_id, visitor.headers)
    assert (tool in {profile.tool for profile in seen.tools}) == present
    assert ("taking a message" in next_steps(seen.tools)) == present
    assert (await checked(client, visitor, "How can I help?")).ok
    assert ("taking a message" in reviewer.soft_inputs[-1].next_steps) == present
