"""The native quote, open-times and booking adapters, on a Rivera Plumbing copy.

Decisions go through `/decide` as the API sends them. Executions call `adapter.execute` with an
`ExecCtx` in a kernel transaction (`run`), as `/execute` will once it exists; an exception there
rolls the whole transaction back, as it will there.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import ITEM_ID_PATTERN, SLOT_ID_PATTERN, Claim, Decision, Label, ResourceRef
from desk.db.models import (Action, ActorSession, Booking, CalendarSlot, DemoInboxEntry, Desk, Fact, LedgerEntry,
                             NotificationPref, Quote)
from desk.db.models import Decision as DecisionRow
from desk.kernel_service import adapters, auth, compiler, labels
from desk.kernel_service.adapters import book as book_adapter
from desk.kernel_service.adapters.base import AdapterFailure, AdapterResult, ExecCtx
from desk.kernel_service.repo import new_id
from desk.kernel_service.sessions import principal_for

from .helpers import kernel_ctx, rows_of
from .test_decide import PASS, Visitor, decided, open_visitor, verify_signature

NATIVE = ("native.quote", "native.find_slots", "native.book")
TZ = ZoneInfo("America/Los_Angeles")


@dataclass(frozen=True)
class Rivera:
    """A copy of Rivera Plumbing, as `POST /copies` seeds it."""

    copy_id: str
    desk_id: str
    slug: str
    owner_token: str

    @property
    def owner(self) -> dict[str, str]:
        return {auth.OWNER_HEADER: self.owner_token}


async def rivera(app: FastAPI, client: httpx.AsyncClient) -> Rivera:
    response = await client.post("/copies", json={})
    assert response.status_code == 200, response.text
    created = response.json()
    [desk] = await rows_of(app, created["copy_id"], select(Desk))
    return Rivera(copy_id=created["copy_id"], desk_id=desk.desk_id, slug=desk.slug, owner_token=created["owner_token"])


async def visitor_of(app: FastAPI, client: httpx.AsyncClient) -> tuple[Rivera, Visitor]:
    """A fresh Rivera copy and a stranger on its Desk."""
    copy = await rivera(app, client)
    return copy, await open_visitor(client, copy)


async def run(app: FastAPI, copy_id: str, decision: Decision, hook: str = "execute") -> AdapterResult | None:
    """Executes a decision's action with its adapter (or runs another `hook`, such as
    `reconcile`), as its own session, in one committed transaction (rolled back if it raises)."""
    async with kernel_ctx(app) as ctx:
        repo = ctx.bind(copy_id)
        action_row = (await ctx.db.scalars(repo.scoped(
            select(Action).where(Action.action_id == decision.action.action_id)))).one()
        session_row = (await ctx.db.scalars(repo.scoped(
            select(ActorSession).where(ActorSession.session_id == decision.session_id)))).one()
        desk_row = (await ctx.db.scalars(repo.scoped(select(Desk).where(Desk.desk_id == action_row.desk_id)))).one()
        adapter = adapters.ADAPTERS[action_row.tool]
        xctx = ExecCtx(ctx=ctx, desk_row=desk_row, session_row=session_row, principal=principal_for(session_row))
        if hook == "reconcile":
            return await adapter.reconcile(xctx, decision.action)
        return await adapter.execute(xctx, decision.action, adapter.Args.model_validate(action_row.args_json))


def quote_args(*items: tuple[str, int], discount_bp: int | None = None, **extra) -> dict:
    args: dict = {"items": [{"item_id": item_id, "qty": qty} for item_id, qty in items], **extra}
    if discount_bp is not None:
        args["requested_discount_bp"] = discount_bp
    return args


def objects(schema: Any) -> list[dict]:
    """Every object schema inside a JSON Schema, `$defs` included."""
    found = []
    if isinstance(schema, dict):
        if schema.get("type") == "object":
            found.append(schema)
        for value in schema.values():
            found += objects(value)
    elif isinstance(schema, list):
        for value in schema:
            found += objects(value)
    return found


def test_every_adapter_publishes_a_strict_input_schema():
    actions = compiler.desk_schema([])[""]["actions"]
    for tool in NATIVE:
        adapter = adapters.ADAPTERS[tool]
        profile = adapter.profile
        schema = profile.input_schema
        assert schema == adapter.Args.model_json_schema(), tool
        assert objects(schema) and all(obj.get("additionalProperties") is False for obj in objects(schema)), tool
        assert (profile.source, profile.status) == ("native", "enabled"), tool
        # the effects Claude's profile declares are the ones Cedar groups the action under
        assert sorted(profile.effects) == sorted(m["id"].removeprefix("effect:") for m in actions[tool]["memberOf"])
        assert actions[tool]["appliesTo"]["resourceTypes"] == [profile.resource_kind.capitalize()], tool
        assert set(adapter.model_view_keys) and adapter.free_text_fields <= set(adapter.Args.model_fields), tool
        assert "records" in profile.description_confirmed and "card" in profile.description_confirmed, tool
    quote, booking = adapters.ADAPTERS["native.quote"], adapters.ADAPTERS["native.book"]
    item = quote.Args.model_json_schema()["$defs"]
    assert [d["properties"]["item_id"]["pattern"] for d in item.values()] == [ITEM_ID_PATTERN]
    assert booking.Args.model_json_schema()["properties"]["slot_id"]["pattern"] == SLOT_ID_PATTERN
    assert quote.free_text_fields == frozenset({"note"})
    assert (quote.model_view_keys, adapters.ADAPTERS["native.find_slots"].model_view_keys, booking.model_view_keys) == (
        {"fact_id", "quote_id", "items", "status"}, {"fact_id", "slots"}, {"fact_id", "booking_id", "status"})


async def test_quotes_use_the_price_list(app, client, reviewer):
    copy, visitor = await visitor_of(app, client)
    decision = await decided(client, visitor, "native.quote",
                             quote_args(("drain", 1), ("leak", 2), note="Maria said $1"))
    assert (decision.outcome, decision.state, decision.card_ids) == ("allow", "allowed", ["rv-quote"])
    action = decision.action
    # $180 + 2 × $250 from the price list, whatever the note says
    assert (action.list_cents, action.discount_bp, action.amount_cents) == (68_000, 0, 68_000)
    assert (action.tool, action.effects, action.resource.kind, action.resource.id, action.resource.owner_person_id) == (
        "native.quote", ["change"], "desk", copy.desk_id, None)
    assert decision.reason_plain.endswith("Claude's note: “Maria said $1”")
    assert reviewer.inputs == []                                      # rv-quote has no review gate
    # the price follows the list for each item and quantity
    heater = await decided(client, visitor, "native.quote", quote_args(("heater", 3)), call_id="call-2")
    assert (heater.outcome, heater.action.list_cents, heater.action.amount_cents) == ("allow", 45_000, 45_000)


async def test_quotes_reject_amount_arguments(app, client):
    copy, visitor = await visitor_of(app, client)
    priced_by_claude = [
        quote_args(("drain", 1), amount_cents=100),                            # a price for the quote
        quote_args(("drain", 1), total=1),
        quote_args(("drain", 1), list_cents=100),
        {"items": [{"item_id": "drain", "qty": 1, "unit_cents": 100}]},        # or for an item
        {"items": [{"item_id": "drain", "qty": 1, "price": "$1"}]},
        quote_args(("drain", 1), discount_bp=10_001),                          # a discount past 100%
        quote_args(("drain", 1), discount_bp=-500),
        quote_args(("drain", 0)), quote_args(("drain", 11)),                   # quantities outside 1..10
        {"items": [{"item_id": "drain", "qty": "1"}]}, {"items": [{"item_id": "drain", "qty": 1.0}]},
        quote_args(),                                                          # no item, or more than five
        quote_args(*[("drain", 1)] * 6),
        quote_args(("drain", 1), note="x" * 201),
    ]
    for n, args in enumerate(priced_by_claude):
        decision = await decided(client, visitor, "native.quote", args, call_id=f"call-{n}")
        assert (decision.outcome, decision.action) == ("refuse", None), args
        assert "The request wasn't in a form the tool takes" in decision.reason_plain, args


async def test_quote_discounts_follow_the_cards(app, client, reviewer):
    copy, visitor = await visitor_of(app, client)
    outcomes = []
    for discount_bp in (0, 1500, 8000):
        decision = await decided(client, visitor, "native.quote", quote_args(("drain", 1), discount_bp=discount_bp),
                                 call_id=f"call-{discount_bp}")
        action = decision.action
        outcomes.append((decision.outcome, decision.card_ids, action.discount_bp, action.amount_cents))
    # rv-quote auto-allows list price only; any discount asks Maria through its hold twin
    assert outcomes == [("allow", ["rv-quote"], 0, 18_000), ("hold", ["rv-quote"], 1500, 15_300),
                        ("hold", ["rv-quote"], 8000, 3_600)]
    assert reviewer.inputs == []
    held = await decided(client, visitor, "native.quote", quote_args(("drain", 1), discount_bp=8000),
                         call_id="call-8000")
    # a limit hold: Maria isn't offered "deny always", which would refuse every quote
    assert (held.state, held.policy_ids, held.answers) == ("held", ["H.twin.rv-quote"], ["allow_once", "deny_once"])
    assert held.reason_plain == ("A stranger asked to get a quote for $36 with 80% off. It goes past your rule, "
                                 "so it waits for you: “Quotes from your price list, at list price.”")
    assert held.visitor_plain == "Waiting for Maria Rivera to approve"


async def test_quotes_outside_the_price_list_are_refused(app, client):
    copy, visitor = await visitor_of(app, client)
    outside = [
        quote_args(("gold-plated-tap", 1)),                                    # not on the list
        quote_args(("drain", 1), ("roof", 1)),                                 # one item of two
        quote_args(*[("leak", 10)] * 5),                                       # $12,500: past the $10,000 cap
    ]
    for n, args in enumerate(outside):
        decision = await decided(client, visitor, "native.quote", args, call_id=f"call-{n}")
        assert (decision.outcome, decision.state, decision.action) == ("refuse", "refused", None), args
        assert "It didn't match your records, so it was refused." in decision.reason_plain, args
    # an ID that isn't a price-list ID at all is malformed, not unknown
    malformed = await decided(client, visitor, "native.quote", quote_args(("Drain Clearing", 1)), call_id="call-x")
    assert (malformed.outcome, malformed.action) == ("refuse", None)
    assert "The request wasn't in a form the tool takes" in malformed.reason_plain
    # the most a quote may come to is fine
    at_cap = await decided(client, visitor, "native.quote", quote_args(*[("leak", 8)] * 5), call_id="call-cap")
    assert (at_cap.outcome, at_cap.action.list_cents) == ("allow", 1_000_000)


async def test_quote_execution_writes_a_labelled_fact(app, client, frozen_clock):
    copy, visitor = await visitor_of(app, client)
    decision = await decided(client, visitor, "native.quote",
                             quote_args(("drain", 1), ("leak", 2), note="for the sink"))
    result = await run(app, copy.copy_id, decision)
    now = frozen_clock.now()

    [quote] = await rows_of(app, copy.copy_id, select(Quote))
    assert (quote.desk_id, quote.session_id, quote.action_id, quote.status) == (
        copy.desk_id, visitor.session_id, decision.action.action_id, "available")
    assert (quote.list_cents, quote.discount_bp, quote.amount_cents) == (68_000, 0, 68_000)   # the action's prices
    assert quote.items == [
        {"item_id": "drain", "title": "Drain clearing", "qty": 1, "unit_cents": 18_000},
        {"item_id": "leak", "title": "Leak repair", "qty": 2, "unit_cents": 25_000}]
    assert (quote.created_at, quote.expires_at) == (now, now + timedelta(hours=72))

    [fact] = await rows_of(app, copy.copy_id, select(Fact).where(Fact.kind == "quote"))
    assert fact.fact_id == f"quote:{quote.quote_id}"
    assert (fact.desk_id, fact.status, fact.source, fact.expires_at) == (copy.desk_id, "available", "kernel",
                                                                         quote.expires_at)
    assert (fact.session_id, fact.action_id) == (visitor.session_id, decision.action.action_id)
    # only the business and this conversation can read it
    assert (fact.readers, fact.record_owner) == (["owner", f"session:{visitor.session_id}"], None)
    assert fact.claims == [
        Claim(key="items", kind="text", value="Drain clearing, Leak repair × 2"),
        Claim(key="list", kind="money", value=68_000),
        Claim(key="total", kind="money", value=68_000),
        Claim(key="discount", kind="percent_bp", value=0),
        Claim(key="expires", kind="datetime", value=quote.expires_at.astimezone(TZ).isoformat())]
    assert "for the sink" not in str(fact.claims)                        # no text copied from the call

    [returned] = result.facts
    assert (returned.fact_id, returned.claims, returned.label.readers) == (fact.fact_id, fact.claims, fact.readers)
    assert result.model_view == {
        "fact_id": fact.fact_id, "quote_id": quote.quote_id, "status": "available",
        "items": [{"item_id": "drain", "title": "Drain clearing", "qty": 1},
                  {"item_id": "leak", "title": "Leak repair", "qty": 2}]}
    assert set(result.model_view) == adapters.ADAPTERS["native.quote"].model_view_keys
    assert result.inbox == []
    # an action that ran reconciles to its result; one that never ran, to nothing
    assert await run(app, copy.copy_id, decision, "reconcile") == result
    unrun = await decided(client, visitor, "native.quote", quote_args(("heater", 1)), call_id="call-unrun")
    assert await run(app, copy.copy_id, unrun, "reconcile") is None

    # a held quote with a discount records the discount it was asked for
    held = await decided(client, visitor, "native.quote", quote_args(("drain", 1), discount_bp=1500), call_id="call-2")
    result = await run(app, copy.copy_id, held)
    claims = {claim.key: claim.value for claim in result.facts[0].claims}
    assert (claims["list"], claims["total"], claims["discount"]) == (18_000, 15_300, 1500)


def local(slot_id: str) -> datetime:
    """A slot ID's start: `S-<yyyymmdd>-<hhmm>` in Oakland time."""
    return datetime.strptime(slot_id, "S-%Y%m%d-%H%M").replace(tzinfo=TZ)


async def add_booking(app: FastAPI, copy: Rivera, slot_id: str, status: str = "confirmed") -> None:
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        ctx.db.add(Booking(booking_id=new_id("booking"), copy_id=copy.copy_id, desk_id=copy.desk_id, slot_id=slot_id,
                           starts_at=local(slot_id), status=status))


async def open_times(app: FastAPI, client: httpx.AsyncClient, copy: Rivera, visitor: Visitor, call_id: str,
                     **args) -> AdapterResult:
    decision = await decided(client, visitor, "native.find_slots", args, call_id=call_id)
    assert (decision.outcome, decision.card_ids) == ("allow", ["preset-find-slots"]), decision.reason_plain
    assert (decision.action.effects, decision.action.resource.kind) == (["read"], "desk")
    return await run(app, copy.copy_id, decision)


def slot_ids(result: AdapterResult) -> list[str]:
    return [slot["slot_id"] for slot in result.model_view["slots"]]


async def test_find_slots_lists_open_future_slots(app, client, frozen_clock):
    copy, visitor = await visitor_of(app, client)                 # Friday 10:04 in Oakland; slots from Saturday
    now = frozen_clock.now()
    first = await open_times(app, client, copy, visitor, "call-1")
    # the six earliest, the clocks going back between Saturday and Monday
    assert first.model_view["slots"] == [
        {"slot_id": "S-20261031-0900", "starts_at_local": "2026-10-31T09:00:00-07:00"},
        {"slot_id": "S-20261031-1100", "starts_at_local": "2026-10-31T11:00:00-07:00"},
        {"slot_id": "S-20261102-0800", "starts_at_local": "2026-11-02T08:00:00-08:00"},
        {"slot_id": "S-20261102-1000", "starts_at_local": "2026-11-02T10:00:00-08:00"},
        {"slot_id": "S-20261102-1200", "starts_at_local": "2026-11-02T12:00:00-08:00"},
        {"slot_id": "S-20261102-1400", "starts_at_local": "2026-11-02T14:00:00-08:00"}]
    [fact] = first.facts
    assert first.model_view["fact_id"] == fact.fact_id and fact.fact_id.startswith("slots:")
    assert set(first.model_view) == adapters.ADAPTERS["native.find_slots"].model_view_keys
    assert (fact.kind, fact.status, fact.source, fact.expires_at) == ("slots", "available", "kernel",
                                                                       now + timedelta(minutes=30))
    assert fact.claims[:4] == [
        Claim(key="slot", kind="ref", value="S-20261031-0900"),
        Claim(key="starts_at", kind="datetime", value="2026-10-31T09:00:00-07:00"),
        Claim(key="slot", kind="ref", value="S-20261031-1100"),
        Claim(key="starts_at", kind="datetime", value="2026-10-31T11:00:00-07:00")]
    assert len(fact.claims) == 12
    [row] = await rows_of(app, copy.copy_id, select(Fact).where(Fact.kind == "slots"))
    assert (row.fact_id, row.claims, row.readers, row.session_id) == (
        fact.fact_id, fact.claims, ["owner", f"session:{visitor.session_id}"], visitor.session_id)
    assert row.action_id is not None and row.expires_at == fact.expires_at
    assert await run(app, copy.copy_id, Decision.model_validate(
        (await client.get("/decisions/by_call", headers=visitor.headers, params={
            "session_id": visitor.session_id, "generation": 0, "call_id": "call-1"})).json()), "reconcile") == first

    # a confirmed booking takes its slot off the list; a cancelled one doesn't
    await add_booking(app, copy, "S-20261031-0900")
    await add_booking(app, copy, "S-20261031-1100", status="cancelled")
    assert slot_ids(await open_times(app, client, copy, visitor, "call-2")) == [
        "S-20261031-1100", "S-20261102-0800", "S-20261102-1000", "S-20261102-1200", "S-20261102-1400",
        "S-20261102-1600"]
    # from a given day, for the days asked
    assert slot_ids(await open_times(app, client, copy, visitor, "call-3", from_date="2026-11-03", days=1)) == [
        "S-20261103-0800", "S-20261103-1000", "S-20261103-1200", "S-20261103-1400", "S-20261103-1600"]
    assert slot_ids(await open_times(app, client, copy, visitor, "call-4", from_date="2026-11-07", days=2)) == [
        "S-20261107-0900", "S-20261107-1100"]                    # a Saturday and a Sunday
    # only slots that haven't started: on Saturday at 11:30, nothing is left that day
    frozen_clock.travel(local("S-20261031-1130"))
    later = await open_visitor(client, copy)
    assert slot_ids(await open_times(app, client, copy, later, "call-5")) == [
        "S-20261102-0800", "S-20261102-1000", "S-20261102-1200", "S-20261102-1400", "S-20261102-1600",
        "S-20261103-0800"]
    none_left = await open_times(app, client, copy, later, "call-6", days=1)
    assert (none_left.model_view, none_left.facts) == ({"slots": []}, [])     # nothing to cite
    # arguments outside the schema are refused before anything runs
    for args in ({"days": 15}, {"days": 0}, {"from_date": "11/03/2026"}, {"from_date": "2026-11-31"},
                 {"until": "2026-11-05"}):
        refused = await decided(client, later, "native.find_slots", args, call_id=f"bad-{args}")
        assert (refused.outcome, refused.action) == ("refuse", None), args


async def add_slot(app: FastAPI, copy: Rivera, slot_id: str, minutes: int = 120) -> None:
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        ctx.db.add(CalendarSlot(desk_id=copy.desk_id, slot_id=slot_id, copy_id=copy.copy_id, starts_at=local(slot_id),
                                minutes=minutes))


async def book(client: httpx.AsyncClient, visitor: Visitor, slot_id: str, call_id: str = "call-book") -> Decision:
    return await decided(client, visitor, "native.book", {"slot_id": slot_id}, call_id=call_id)


async def test_weekday_booking_is_auto_allowed_and_confirmed(app, client, reviewer):
    reviewer.answer = PASS
    copy, visitor = await visitor_of(app, client)
    decision = await book(client, visitor, "S-20261102-1000")                  # Monday at 10:00
    assert (decision.outcome, decision.card_ids, decision.policy_ids, decision.review) == (
        "allow", ["rv-book-wk"], ["A.auto.rv-book-wk"], PASS)
    action = decision.action
    assert (action.effects, action.resource) == (["change"], ResourceRef(kind="slot", id="S-20261102-1000",
                                                                          owner_person_id=None))
    assert action.starts_at == local("S-20261102-1000")                        # the hours check reads the slot
    [seen] = reviewer.inputs
    assert seen.action.starts_at == "2026-11-02T10:00:00-08:00"

    result = await run(app, copy.copy_id, decision)
    [booking] = await rows_of(app, copy.copy_id, select(Booking))
    assert (booking.desk_id, booking.slot_id, booking.starts_at, booking.status) == (
        copy.desk_id, "S-20261102-1000", local("S-20261102-1000"), "confirmed")
    assert (booking.session_id, booking.action_id, booking.person_id) == (visitor.session_id, action.action_id, None)
    [fact] = await rows_of(app, copy.copy_id, select(Fact).where(Fact.kind == "booking"))
    assert (fact.fact_id, fact.status, fact.source, fact.expires_at) == (
        f"booking:{booking.booking_id}", "committed", "kernel", None)
    assert fact.claims == [Claim(key="starts_at", kind="datetime", value="2026-11-02T10:00:00-08:00"),
                           Claim(key="minutes", kind="text", value="120"),
                           Claim(key="booking", kind="ref", value=booking.booking_id)]
    assert (fact.readers, fact.session_id, fact.action_id) == (
        ["owner", f"session:{visitor.session_id}"], visitor.session_id, action.action_id)
    assert result.model_view == {"fact_id": fact.fact_id, "booking_id": booking.booking_id, "status": "confirmed"}
    assert [f.fact_id for f in result.facts] == [fact.fact_id]
    assert result.inbox == []                                  # Rivera hears of bookings in the briefing
    assert await run(app, copy.copy_id, decision, "reconcile") == result
    # the slot is no longer open
    assert "S-20261102-1000" not in slot_ids(await open_times(app, client, copy, visitor, "call-times"))

    # an owner who wants bookings at once gets an alert, with no code in it, in the owner's Demo
    # inbox alone: the visitor's result carries no owner alert
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        prefs = (await ctx.db.scalars(ctx.repo.scoped(select(NotificationPref)))).one()
        prefs.now = [*prefs.now, "booking"]
    second = await book(client, visitor, "S-20261102-1200", call_id="call-2")
    assert (await run(app, copy.copy_id, second)).inbox == []
    [entry] = await rows_of(app, copy.copy_id, select(DemoInboxEntry).where(DemoInboxEntry.preview == "New booking"))
    assert (entry.to, entry.kind, entry.person_id) == ("owner", "alert", None)
    assert entry.body == "A stranger booked Monday, November 2, from 12:00 pm to 2:00 pm."
    assert entry.decision_id is None                           # only a held request's alert names its decision

    # a slot that isn't this Desk's, or has started, is refused before any action exists
    await add_slot(app, copy, "S-20261030-0800")                                # this morning
    for slot_id in ("S-20261101-1000", "S-20261030-0800"):                      # no slot that Sunday
        refused = await book(client, visitor, slot_id, call_id=f"call-{slot_id}")
        assert (refused.outcome, refused.action) == ("refuse", None), slot_id
        assert "It didn't match your records" in refused.reason_plain
    for bad in ("monday 10am", "S-2026112-1000", "S-20261102-1000 "):
        refused = await book(client, visitor, bad, call_id=f"call-{bad}")
        assert (refused.outcome, refused.action) == ("refuse", None), bad
        assert "The request wasn't in a form the tool takes" in refused.reason_plain


async def test_sunday_night_booking_holds(app, client, reviewer):
    reviewer.answer = PASS                                                      # the review passes either way
    copy, visitor = await visitor_of(app, client)
    await add_slot(app, copy, "S-20261101-2200")                     # Sunday at 22:00, outside the cards' hours
    held = await book(client, visitor, "S-20261101-2200")
    assert (held.outcome, held.state, held.action.starts_at) == ("hold", "held", local("S-20261101-2200"))
    # both booking cards' hold twins ask Maria; their auto permits need the slot inside their hours
    assert held.policy_ids == ["H.twin.rv-book-sat", "H.twin.rv-book-wk"]
    assert held.card_ids == ["rv-book-sat", "rv-book-wk"]
    assert held.visitor_plain == "Waiting for Maria Rivera to approve"
    assert [notice.preview for notice in held.inbox] == ["A request needs your answer"]
    # the same request for a Saturday morning slot is the reviewer's to pass
    allowed = await book(client, visitor, "S-20261031-0900", call_id="call-sat")
    assert (allowed.outcome, allowed.card_ids) == ("allow", ["rv-book-sat"])
    # a Saturday afternoon slot is past rv-book-sat's 09:00 to 13:00
    await add_slot(app, copy, "S-20261031-1300")
    late = await book(client, visitor, "S-20261031-1300", call_id="call-sat-late")
    assert late.outcome == "hold"


async def test_a_taken_slot_fails_without_a_second_booking(app, client, reviewer, monkeypatch):
    reviewer.answer = PASS
    copy, first = await visitor_of(app, client)
    second = await open_visitor(client, copy)
    # both asked while the slot was open, so both are allowed
    decisions = [await book(client, visitor, "S-20261102-1000") for visitor in (first, second)]
    assert [d.outcome for d in decisions] == ["allow", "allow"]
    commits = []
    original = book_adapter.commit_booking

    async def counted(*args, **kwargs):
        commits.append(args[1].action_id)
        return await original(*args, **kwargs)

    monkeypatch.setattr(book_adapter, "commit_booking", counted)                # the seam evals patch
    await run(app, copy.copy_id, decisions[0])
    with pytest.raises(AdapterFailure, match="slot_taken"):
        await run(app, copy.copy_id, decisions[1])
    assert commits == [d.action.action_id for d in decisions]                  # the second reached the commit
    [booking] = await rows_of(app, copy.copy_id, select(Booking))
    assert (booking.slot_id, booking.status, booking.session_id) == ("S-20261102-1000", "confirmed", first.session_id)
    facts = await rows_of(app, copy.copy_id, select(Fact).where(Fact.kind == "booking"))
    assert [fact.session_id for fact in facts] == [first.session_id]           # nothing written for the second
    assert await run(app, copy.copy_id, decisions[1], "reconcile") is None
    # once the booking is cancelled, the slot can be booked again
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        (await ctx.db.scalars(ctx.repo.scoped(select(Booking)))).one().status = "cancelled"
    again = await book(client, second, "S-20261102-1000", call_id="call-again")
    assert (await run(app, copy.copy_id, again)).model_view["status"] == "confirmed"


async def test_two_copies_can_book_the_same_slot_id(app, client, reviewer):
    reviewer.answer = PASS
    (a, a_visitor), (b, b_visitor) = await visitor_of(app, client), await visitor_of(app, client)
    for copy, visitor in ((a, a_visitor), (b, b_visitor)):                     # slot IDs repeat in every copy
        decision = await book(client, visitor, "S-20261102-1000")
        assert decision.outcome == "allow"
        assert (await run(app, copy.copy_id, decision)).model_view["status"] == "confirmed"
    for copy in (a, b):
        [booking] = await rows_of(app, copy.copy_id, select(Booking))
        assert (booking.desk_id, booking.slot_id, booking.status) == (copy.desk_id, "S-20261102-1000", "confirmed")
    # and each copy's slot is taken only in that copy
    c, c_visitor = await visitor_of(app, client)
    assert "S-20261102-1000" in slot_ids(await open_times(app, client, c, c_visitor, "call-times"))


def session(kind: str = "visitor", *, person_id: str | None = None, assurance: str = "none") -> ActorSession:
    return ActorSession(session_id=f"{kind}-1", copy_id="copy-1", desk_id=None if kind == "owner" else "desk-1",
                        kind=kind, person_id=person_id, assurance=assurance)


def test_labels_core():
    stranger = session()
    dana = session(person_id="person-dana", assurance="demo_code")
    unconfirmed = session(person_id="person-dana")                          # a person but no verification: not hers
    owner = session("owner", assurance="owner_session")

    assert labels.session_readers(stranger) == labels.session_readers(unconfirmed) == {"public", "session:visitor-1"}
    assert labels.session_readers(dana) == {"public", "session:visitor-1", "person:person-dana"}
    assert labels.session_readers(owner) == {"owner", "public"}

    assert labels.new_fact_label(stranger) == labels.new_fact_label(unconfirmed) == Label(
        readers=["owner", "session:visitor-1"], record_owner=None)
    assert labels.new_fact_label(dana) == Label(readers=["owner", "session:visitor-1", "person:person-dana"],
                                                record_owner="person-dana")
    assert labels.new_fact_label(owner) == Label(readers=["owner", "session:owner-1"], record_owner=None)

    stranger_reads, dana_reads, owner_reads = (labels.session_readers(s) for s in (stranger, dana, owner))
    other_session = labels.session_readers(ActorSession(session_id="visitor-2", kind="visitor", assurance="none"))
    own = labels.new_fact_label(stranger)
    assert labels.can_read(own, stranger_reads) and labels.can_read(own, owner_reads)
    assert not labels.can_read(own, other_session)                           # session B can't read session A's quote
    persons = Label(readers=["owner", "person:person-dana"], record_owner="person-dana")
    assert labels.can_read(persons, dana_reads) and not labels.can_read(persons, stranger_reads)
    public = Label(readers=["public"])
    assert all(labels.can_read(public, reads) for reads in (stranger_reads, dana_reads, owner_reads, other_session))
    # a missing or empty label is the owner's alone; plain reader lists work too
    for unlabelled in (None, [], Label(readers=[])):
        assert labels.can_read(unlabelled, owner_reads) and not labels.can_read(unlabelled, dana_reads)
    assert labels.can_read(["owner", "session:visitor-1"], stranger_reads)
    with pytest.raises(TypeError):
        labels.can_read("public", stranger_reads)                            # one string is not a reader list


async def test_copy_seeds_one_held_quote(app, client, reviewer, frozen_clock):
    copy = await rivera(app, client)
    now = frozen_clock.now()
    [row] = await rows_of(app, copy.copy_id, select(DecisionRow))
    [action] = await rows_of(app, copy.copy_id, select(Action))
    assert (row.tool, row.outcome, row.state, row.action_id, row.card_ids) == (
        "native.quote", "hold", "held", action.action_id, ["rv-quote"])
    assert (action.list_cents, action.discount_bp, action.amount_cents) == (18_000, 1500, 15_300)
    assert action.args_json == {"items": [{"item_id": "drain", "qty": 1}], "requested_discount_bp": 1500}
    # it was asked by a visitor of its own, whose token nobody holds
    [seeded] = await rows_of(app, copy.copy_id, select(ActorSession).where(ActorSession.kind == "visitor"))
    assert (row.session_id, seeded.desk_id, seeded.assurance, seeded.mode) == (
        seeded.session_id, copy.desk_id, "none", "ai")
    assert reviewer.inputs == []                                                # no review gate on rv-quote

    # Maria reads it on Today as any held request: signed, with its plain reasons and answers
    response = await client.get(f"/decisions/{row.decision_id}", headers=copy.owner)
    assert response.status_code == 200, response.text
    decision = Decision.model_validate(response.json())
    verify_signature((await client.get("/health")).json()["public_key_hex"], decision)
    assert decision.reason_plain == ("A stranger asked to get a quote for $153 with 15% off. It goes past your rule, "
                                     "so it waits for you: “Quotes from your price list, at list price.”")
    assert (decision.visitor_plain, decision.answers, decision.expires_at) == (
        "Waiting for Maria Rivera to approve", ["allow_once", "deny_once"], now + timedelta(hours=24))

    # ledgered after the Desk, its two knowledge items, pinned tools, urgent tool and rules (which
    # turn the urgent tool on); the owner was alerted
    entries = await rows_of(app, copy.copy_id, select(LedgerEntry).order_by(LedgerEntry.seq))
    assert [(e.seq, e.event.kind) for e in entries] == [
        (1, "desk_data"), (2, "desk_data"), (3, "desk_data"), (4, "tool_pin"), (5, "tool_pin"),
        (6, "business_tools"), (7, "policy"), (8, "tool_pin"), (9, "session"), (10, "decide")]
    assert entries[8].event.summary == {"session_id": seeded.session_id, "kind": "visitor"}
    assert (entries[9].seq, entries[9].event.session_id, entries[9].event.summary) == (decision.ledger_seq,
                                                                                       seeded.session_id, {
        "decision_id": row.decision_id, "action_id": action.action_id, "tool": "native.quote", "outcome": "hold",
        "card_ids": ["rv-quote"], "policy_version": 1, "auto_money_cap_cents": 50_000, "reviewed": False})
    [alert] = await rows_of(app, copy.copy_id, select(DemoInboxEntry))
    assert (alert.kind, alert.to, alert.preview, alert.body) == (
        "alert", "owner", "A request needs your answer", decision.reason_plain)
    # every copy gets its own
    other = await rivera(app, client)
    assert len(await rows_of(app, other.copy_id, select(DecisionRow))) == 1
