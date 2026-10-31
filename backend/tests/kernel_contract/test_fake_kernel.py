"""FakeKernel's own knobs, which the real kernel doesn't have: failures, dropped answers, scripted outcomes,
forced violations, mode changes, verification, a lowered payment-link limit, the call log, its clock and its read-only
mirror."""

from collections.abc import AsyncIterator
from datetime import timedelta

import httpx
import psycopg
import pytest
from pydantic import ValidationError

from desk.api.kernel_client import KernelFailed, KernelHttp, KernelUnavailable
from desk.contracts import CopyCreated, NormalizedAction, ResourceRef, SessionCreated
from desk.kernel_api import CreateCopyRequest, CreateSessionRequest, DemoAgentRequest, Health
from tests.kernel_contract.fake_kernel import FakeKernelState, fake_kernel_app
from tests.kernel_contract.ro_tables import FAKE_RO_SCHEMA, FakeRO
from tests.kernel_contract.test_contract import (
    LINK_ROUTES,
    answer,
    check_reply,
    checkout,
    context,
    decide,
    execute,
    issue_payment_link,
    quote_args,
    read_decision,
    refused,
)

BY_CALL = "GET /decisions/by_call?session_id=&generation=&call_id="


@pytest.fixture
async def fake(fake_ro: FakeRO) -> AsyncIterator[tuple[KernelHttp, FakeKernelState]]:
    state = FakeKernelState(ro=fake_ro)
    async with KernelHttp("http://fake-kernel", transport=httpx.ASGITransport(app=fake_kernel_app(state))) as http:
        yield http, state


async def copy_and_visitor(http: KernelHttp, state: FakeKernelState) -> tuple[CopyCreated, SessionCreated]:
    copy = await http.public().call("POST /copies", CreateCopyRequest())
    slug = state.desks[copy.desk_ids[0]].slug
    return copy, await http.public().call("POST /sessions", CreateSessionRequest(desk_slug=slug, kind="visitor"))


async def test_failures_answer_before_anything_changes(fake):
    http, state = fake
    _, visitor = await copy_and_visitor(http, state)
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    by_call = {"session_id": session_id, "generation": 0, "call_id": "call-1"}

    state.fail("/decide", "timeout", times=1)
    with pytest.raises(KernelUnavailable) as unavailable:
        await decide(view, session_id, 0, "call-1", "native.quote", quote_args("drain"))
    assert (unavailable.value.route, unavailable.value.status) == ("POST /decide", None)
    assert await refused(view.call(BY_CALL, query=by_call)) == (404, "not_found")    # nothing was decided

    state.fail("POST /decide", "connect")                                         # every call until healed
    for _ in range(2):
        with pytest.raises(KernelUnavailable):
            await decide(view, session_id, 0, "call-1", "native.quote", quote_args("drain"))
    state.fail("/decide", "500", times=1)                                         # replaces the connect failure
    with pytest.raises(KernelUnavailable) as unavailable:
        await decide(view, session_id, 0, "call-1", "native.quote", quote_args("drain"))
    assert (unavailable.value.status, unavailable.value.code) == (500, "internal")
    state.fail("/decide", "422", times=1)
    assert await refused(decide(view, session_id, 0, "call-1", "native.quote", quote_args("drain"))) == (
        422, "invalid")
    state.fail("/decide", "409", times=1)
    assert await refused(decide(view, session_id, 0, "call-1", "native.quote", quote_args("drain"))) == (
        409, "conflict")
    assert (await decide(view, session_id, 0, "call-1", "native.quote", quote_args("drain"))).state == "allowed"

    with pytest.raises(ValueError):
        state.fail("/decisions/everything", "timeout")
    with pytest.raises(ValueError):
        state.fail("/decide", "slow")


async def test_a_dropped_answer_commits_then_times_out(fake):
    http, state = fake
    _, visitor = await copy_and_visitor(http, state)
    view, session_id = http.session(visitor.session_token), visitor.state.session_id

    state.drop_response("/decide")
    with pytest.raises(KernelUnavailable):
        await decide(view, session_id, 0, "call-1", "native.quote", quote_args("drain"))
    found = await view.call(BY_CALL, query={"session_id": session_id, "generation": 0, "call_id": "call-1"})
    assert found.state == "allowed"
    assert (await decide(view, session_id, 0, "call-1", "native.quote", quote_args("drain"))) == found
    assert [len(state.called(route)) for route in ("/decide", "GET /decisions/by_call")] == [2, 1]


async def test_scripts_override_outcomes_and_results(fake):
    http, state = fake
    _, visitor = await copy_and_visitor(http, state)
    view, session_id = http.session(visitor.session_token), visitor.state.session_id

    state.script("native.quote", outcome="allow", exec_state="unknown", model_view={"note": "scripted"})
    allowed = await decide(view, session_id, 0, "call-1", "native.quote", quote_args("drain", 5000))
    assert allowed.state == "allowed" and allowed.action.discount_bp == 5000
    result = await execute(view, allowed, 0)
    assert (result.state, result.facts, result.model_view) == ("unknown", [], {"note": "scripted"})
    assert (await read_decision(view, allowed.decision_id)).state == "unknown"

    state.script("native.find_slots", outcome="refuse")
    refused_call = await decide(view, session_id, 0, "call-2", "native.find_slots", {})
    assert refused_call.state == "refused" and refused_call.action is not None
    state.script("native.book", exec_state="failed")
    slot = min(state.desks[allowed.action.desk_id].slots)
    booked = await decide(view, session_id, 0, "call-3", "native.book", {"slot_id": slot})
    assert (await execute(view, booked, 0)).state == "failed"
    assert (await read_decision(view, booked.decision_id)).state == "failed"


async def test_an_execution_in_flight_is_a_conflict_until_it_finishes(fake):
    """`in_flight(tool)`: the tool's next execution is already running when `/execute` arrives (another request began
    it; the kernel holds its intent row). Like the kernel, `/execute` answers 409 `conflict` while it runs, since
    there is no stored result yet, and the decision reads `allowed`, never expiring, until `finish` ends it."""
    http, state = fake
    _, visitor = await copy_and_visitor(http, state)
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    state.in_flight("native.quote")
    running = await decide(view, session_id, 0, "call-1", "native.quote", quote_args("drain"))
    ran_before = len(state.desks[running.action.desk_id].ledger)

    for _ in range(2):
        assert await refused(execute(view, running, 0)) == (409, "conflict")
    state.now += timedelta(seconds=61)                           # running: an allow past its minute doesn't expire
    assert await read_decision(view, running.decision_id) == running
    assert len(state.desks[running.action.desk_id].ledger) == ran_before

    other = await decide(view, session_id, 0, "call-2", "native.quote", quote_args("drain"))
    assert (await execute(view, other, 0)).state == "succeeded"   # once: the next execution runs as usual

    finished = state.finish(running.decision_id)
    assert finished.state == "executed" and finished == await read_decision(view, running.decision_id)
    repeat = await execute(view, running, 0)                     # finished: a repeat returns the stored result
    assert repeat == state.decisions[running.decision_id].result and repeat.state == "succeeded"
    with pytest.raises(ValueError):
        state.finish(running.decision_id)                         # only a running execution finishes

    state.in_flight("native.quote")
    doubtful = await decide(view, session_id, 0, "call-3", "native.quote", quote_args("drain"))
    assert await refused(execute(view, doubtful, 0)) == (409, "conflict")
    assert state.finish(doubtful.decision_id, "unknown").state == "unknown"
    assert await refused(execute(view, doubtful, 0)) == (409, "conflict")    # its outcome still isn't known


async def test_a_forced_violation_blocks_the_next_check_only(fake):
    http, state = fake
    _, visitor = await copy_and_visitor(http, state)
    view, session_id = http.session(visitor.session_token), visitor.state.session_id

    state.violation("canary")
    state.violation("soft_promise", times=2)
    kinds = [[v.kind for v in (await check_reply(view, session_id, 0, "Happy to help.")).violations] for _ in range(4)]
    assert kinds == [["canary"], ["soft_promise"], ["soft_promise"], []]
    with pytest.raises(ValueError):
        state.violation("rudeness")


async def test_mode_changes_bump_the_generation_except_a_pause(fake, api_conn):
    http, state = fake
    copy, visitor = await copy_and_visitor(http, state)
    session_id = visitor.state.session_id

    def stored() -> tuple:
        with api_conn.transaction():
            api_conn.execute("SELECT set_config('desk.copy_id', %s, true)", (copy.copy_id,))
            row = api_conn.execute(f"SELECT mode, generation, strikes FROM {FAKE_RO_SCHEMA}.sessions"
                                   " WHERE session_id = %s", (session_id,)).fetchone()
        return row["mode"], row["generation"], row["strikes"]

    steps = [("owner", ("owner", 1, 0)), ("ai", ("ai", 2, 0)), ("paused", ("paused", 2, 3)), ("ai", ("ai", 3, 0)),
             ("ai", ("ai", 3, 0))]
    for mode, expected in steps:
        assert state.set_mode(session_id, mode).generation == expected[1]
        assert stored() == expected


async def test_verify_gives_the_verified_tools_and_labels(fake):
    http, state = fake
    copy, visitor = await copy_and_visitor(http, state)
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    quoted = await decide(view, session_id, 0, "call-1", "native.quote", quote_args("drain"))
    [quote] = (await execute(view, quoted, 0)).facts
    before = await context(view, session_id)

    verified = state.verify(session_id, "dana")
    assert (verified.verified, verified.assurance, verified.generation) == (True, "demo_code", 0)
    after = await context(view, session_id)
    tools = {profile.tool for profile in after.tools}
    assert "native.release_document" in tools and "native.start_verification" not in tools
    assert after.tools_declared == before.tools_declared
    dana = state.desks[copy.desk_ids[0]].person("dana").person_id
    assert f"person:{dana}" in next(f for f in after.facts if f.fact_id == quote.fact_id).label.readers
    invoice = next(f for f in after.facts if f.kind == "document")       # her invoice, now hers to read
    assert invoice.label.record_owner == dana


async def test_a_lowered_link_limit_cancels_the_open_links_above_it(fake):
    http, state = fake
    copy, visitor = await copy_and_visitor(http, state)
    view, session_id, desk_id = http.session(visitor.session_token), visitor.state.session_id, copy.desk_ids[0]
    token, _ = await issue_payment_link(view, session_id, "deposit", 1)
    (link_id,) = state.payment_links
    get, complete, _ = LINK_ROUTES

    assert state.lower_link_limit(desk_id, 1000) == [link_id]
    shown = await checkout(http, get, token)
    assert (shown.state, shown.cancel_reason) == ("cancelled", "rules_changed")
    assert state.payment_links[link_id].cancel_reason == "rules_changed"
    assert await refused(checkout(http, complete, token)) == (409, "conflict")
    *_, policy, cancelled, refusal = [entry.event for entry in state.desks[desk_id].ledger]
    assert (policy.kind, policy.summary) == ("policy", {"version": 2, "activated": True})
    assert (cancelled.kind, cancelled.summary) == (
        "payment", {"link_id": link_id, "state": "cancelled", "reason": "rules_changed", "version": 2})
    assert refusal.summary["refused"] is True
    # The new limit decides new links: the deposit now asks the owner.
    quoted = await execute(view, await decide(view, session_id, 0, "call-quote-2", "native.quote",
                                              quote_args("deposit")), 0)
    held = await decide(view, session_id, 0, "call-link-2", "native.payment_link",
                        {"quote_id": quoted.model_view["quote_id"]})
    assert (held.state, held.card_ids) == ("held", ["rv-link"])


async def test_calls_are_logged_with_their_credentials(fake):
    http, state = fake
    copy, visitor = await copy_and_visitor(http, state)
    await http.session(visitor.session_token).whoami()
    await http.owner(copy.owner_token).whoami()

    visitor_call, owner_call = state.called("/whoami")
    assert visitor_call.route == "GET /whoami" and visitor_call.headers["x-session-token"] == visitor.session_token
    assert "x-owner-session" not in visitor_call.headers
    assert owner_call.headers["x-owner-session"] == copy.owner_token and "x-session-token" not in owner_call.headers
    [created] = state.called("POST /sessions")
    assert created.body == {"desk_slug": state.desks[copy.desk_ids[0]].slug, "kind": "visitor", "mandate": None,
                            "preview": False}


async def test_expiry_follows_the_fakes_clock(fake):
    http, state = fake
    copy, visitor = await copy_and_visitor(http, state)
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    allow = await decide(view, session_id, 0, "call-1", "native.quote", quote_args("drain"))
    held = await decide(view, session_id, 0, "call-2", "native.quote", quote_args("drain", 1500))

    state.now += timedelta(seconds=61)
    assert (await read_decision(view, allow.decision_id)).state == "expired"
    assert await refused(execute(view, allow, 0)) == (409, "conflict")

    state.now += timedelta(hours=24, seconds=1)                # the visitor is idle too long: closed
    assert await refused(read_decision(view, held.decision_id)) == (409, "closed")
    assert await refused(answer(http.owner(copy.owner_token), held.decision_id, "allow_once")) == (409, "conflict")
    assert state.decisions[held.decision_id].decision.state == "expired"


async def test_the_mirror_is_copy_scoped_and_read_only(fake, api_conn):
    http, state = fake
    first, _ = await copy_and_visitor(http, state)
    second, _ = await copy_and_visitor(http, state)

    def desks(copy_id: str | None) -> list[str]:
        with api_conn.transaction():
            if copy_id is not None:
                api_conn.execute("SELECT set_config('desk.copy_id', %s, true)", (copy_id,))
            rows = api_conn.execute(f"SELECT desk_id FROM {FAKE_RO_SCHEMA}.desks"
                                    " WHERE desk_id = ANY(%s)", ([*first.desk_ids, *second.desk_ids],)).fetchall()
        return [row["desk_id"] for row in rows]

    assert desks(first.copy_id) == first.desk_ids and desks(second.copy_id) == second.desk_ids
    assert desks(None) == []                                  # no copy set, no rows, as kernel_ro does
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api_conn.transaction():
        api_conn.execute(f"DELETE FROM {FAKE_RO_SCHEMA}.desks")


async def test_the_mirror_holds_each_rules_versions_money_cap(fake, api_conn):
    """The Rivera seed's rules carry its $500 money cap, as the kernel's seed does (`DeskSeed`), and a
    version the owner confirms keeps the Desk's cap."""
    http, state = fake
    copy, _ = await copy_and_visitor(http, state)
    desk_id = copy.desk_ids[0]
    state.never(desk_id, "native.quote")

    with api_conn.transaction():
        api_conn.execute("SELECT set_config('desk.copy_id', %s, true)", (copy.copy_id,))
        rows = api_conn.execute(f"SELECT version, status, auto_money_cap_cents FROM {FAKE_RO_SCHEMA}.policy_versions"
                                " WHERE desk_id = %s ORDER BY version", (desk_id,)).fetchall()
    assert [(row["version"], row["status"], row["auto_money_cap_cents"]) for row in rows] == [
        (1, "superseded", 50_000), (2, "active", 50_000)]


async def test_a_money_hold_offers_allow_person_only_within_the_desks_cap(fake, monkeypatch):
    """A held money request offers "Allow for this person" only when its amount is within the Desk's
    money cap (the Rivera seed's $500), never up to the $10,000 ceiling, as the kernel's `answers_for`
    does; a money call with no amount, or an amount of 0, is refused outright, as the kernel's baseline
    (`money_has_amount`) refuses it: the fake is never looser than the kernel. Payment links normalize
    only once Plan 01c brings quotes to pay, so here one is normalized at the amount under test."""
    http, state = fake
    _, visitor = await copy_and_visitor(http, state)
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    state.verify(session_id, "dana")                         # a verified person, whom allow_person could name
    amount: dict[str, int | None] = {}

    def payment_link(session, desk, call) -> NormalizedAction:
        return NormalizedAction(
            action_id=f"act-{call.call_id}", copy_id=desk.copy_id, desk_id=desk.desk_id, session_id=session.session_id,
            generation=session.generation, tool=call.tool, effects=desk.tools[call.tool].effects, args_sha256="args",
            profile_sha256="profile", resource=ResourceRef(kind="quote", id=call.args["quote_id"], owner_person_id=None),
            list_cents=amount["cents"], discount_bp=0, amount_cents=amount["cents"], recipient=None, starts_at=None)

    monkeypatch.setattr(state, "_normalize", payment_link)
    for call_id, cents, offered in (("call-1", 60_000, False), ("call-2", 50_000, True)):
        amount["cents"] = cents
        held = await decide(view, session_id, 0, call_id, "native.payment_link", {"quote_id": f"quote-{call_id}"})
        assert held.outcome == "hold", held.reason_plain
        assert ("allow_person" in held.answers) is offered, (cents, held.answers)
    for call_id, cents in (("call-3", None), ("call-4", 0)):
        amount["cents"] = cents
        out = await decide(view, session_id, 0, call_id, "native.payment_link", {"quote_id": f"quote-{call_id}"})
        assert (out.outcome, out.answers) == ("refuse", []), (cents, out.reason_plain)


async def test_an_owner_recovers_only_its_own_decisions(fake):
    http, state = fake
    copy, visitor = await copy_and_visitor(http, state)
    owner = http.owner(copy.owner_token)
    for session_id in (visitor.state.session_id, copy.owner_session.session_id):
        query = {"session_id": session_id, "generation": 0, "call_id": "call-1"}
        assert await refused(owner.call(BY_CALL, query=query)) == (404, "not_found")
    assert [call.query["session_id"] for call in state.called(BY_CALL)] == [
        visitor.state.session_id, copy.owner_session.session_id]


async def test_an_answer_that_breaks_its_response_model_never_leaves(fake_ro: FakeRO, monkeypatch):
    state = FakeKernelState(ro=fake_ro)
    bogus = Health.model_construct(version="fake", proof_mode="unproved", dev_signing_key=True, public_key_hex="00",
                                   key_id="key", unproved_seeds=[])
    monkeypatch.setattr(state, "health", lambda request, body: bogus)
    async with KernelHttp("http://fake-kernel", transport=httpx.ASGITransport(app=fake_kernel_app(state))) as http:
        with pytest.raises(ValidationError, match="proof_mode"):     # raised by the fake, before the client
            await http.public().call("GET /health")


async def test_demo_agents_are_minted_for_the_desk_and_limited_per_copy(fake):
    """The owner or a visitor session on the Desk mints a demo agent (a session for another Desk can't), ten per copy
    an hour; the eleventh is 429 `rate_limited`, ledgered `rate_limit`, and an hour later minting works again."""
    http, state = fake
    copy, visitor = await copy_and_visitor(http, state)
    _, elsewhere = await copy_and_visitor(http, state)
    desk_id = copy.desk_ids[0]
    owner, session = http.owner(copy.owner_token), http.session(visitor.session_token)
    issued = await session.call("POST /agents/demo", DemoAgentRequest(desk_id=desk_id))
    assert state.agent_keys[issued.agent_key_id].minted_by == visitor.state.session_id
    assert issued.agent_private_key_hex not in repr(state.agent_keys)
    assert await refused(http.session(elsewhere.session_token).call(
        "POST /agents/demo", DemoAgentRequest(desk_id=desk_id))) == (404, "not_found")
    for _ in range(9):
        await owner.call("POST /agents/demo", DemoAgentRequest(desk_id=desk_id))
    assert await refused(owner.call("POST /agents/demo", DemoAgentRequest(desk_id=desk_id))) == (429, "rate_limited")
    assert state.desks[desk_id].ledger[-1].event.kind == "rate_limit"
    state.now += timedelta(hours=1)
    assert (await owner.call("POST /agents/demo", DemoAgentRequest(desk_id=desk_id))).mandate.desk_id == desk_id
