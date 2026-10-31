"""The owner's reads (Plan 02a, Task 9): the Desk switcher, Today with its briefing and last 7 days, what needs the
owner, conversations and their transcripts, Safety's attempts, the verified ledger and the Answering switch.

The app runs on FakeKernel. Activity is made the way the kernel makes it, through a visitor's own kernel calls at a
time the test sets on the fake's clock; the transcript rows the API writes are appended through the store and then
dated, as desk_admin, to the moment they stand for. Times are the business's: Rivera Plumbing is in
America/Los_Angeles.
"""

import asyncio
import itertools
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text as sql

from desk.api.kernel_client import CredentialView, KernelFailed
from desk.api.main import create_app
from desk.api.owner_reads import BOOKING_CLAIM, REPLY_WHY_BY_RULE
from desk.api.ro import KernelRO
from desk.api.deliver import Reply, Status, deliver
from desk.api.prompts import Triage
from desk.api.store import (
    Ids,
    append_assistant,
    append_message,
    append_tool_change,
    prepare_model_input,
    start_fresh_context,
)
from desk.contracts import Decision, ExecResult, RenderedBlock, ReplyDraft, ToolCall
from desk.kernel_api import (
    AnswerRequest,
    CancelRequest,
    CheckReplyRequest,
    CreateCopyRequest,
    CreateSessionRequest,
    DecideRequest,
    ExecuteRequest,
)
from desk.kernel_service import reply_check
from tests.api.fakes import ScriptedModel
from tests.kernel_contract.fake_kernel import fake_kernel_app, signed_time

OWNER = "x-owner-session"


@pytest.fixture
def model() -> ScriptedModel:
    return ScriptedModel()


@pytest.fixture
async def app(db, fake, api_settings, clock, model) -> AsyncIterator[FastAPI]:
    """The API on FakeKernel, the scripted model and the in-memory job queue, its lifespan running."""
    app = create_app(api_settings, kernel_transport=httpx.ASGITransport(app=fake_kernel_app(fake)), model=model,
                     clock=clock, jobs_connector=InMemoryConnector())
    async with app.router.lifespan_context(app):
        yield app


@dataclass
class Owner:
    """A copy made straight on the kernel and its owner's browser, holding the owner cookie."""

    browser: httpx.AsyncClient
    token: str
    copy_id: str
    desk_id: str
    slug: str

    async def get(self, path: str, **params) -> httpx.Response:
        return await self.browser.get(f"/api/owner/{path}", params=params)


async def new_owner(app, browser, fake, kernel_http) -> Owner:
    copy = await kernel_http.public().call("POST /copies", CreateCopyRequest())
    client = browser(app)
    client.cookies.set("desk_owner", copy.owner_token, domain="desk.test", path="/api/owner")
    desk_id = copy.desk_ids[0]
    return Owner(browser=client, token=copy.owner_token, copy_id=copy.copy_id, desk_id=desk_id,
                 slug=fake.desks[desk_id].slug)


# Activity, made as the kernel and the API make it ------------------------------------------------------------

_CALL_IDS = itertools.count(1)


@dataclass
class Guest:
    """A visitor session on an owner's Desk, opened straight on the kernel: its IDs and its own kernel view."""

    ids: Ids
    kernel: CredentialView
    fake: object

    @property
    def session_id(self) -> str:
        return self.ids.session_id

    @property
    def generation(self) -> int:
        return self.fake.sessions[self.session_id].generation

    async def decide(self, tool: str, args: dict) -> Decision:
        call = ToolCall(call_id=f"call-{next(_CALL_IDS)}", tool=tool, args=args)
        return await self.kernel.call("POST /decide", DecideRequest(session_id=self.session_id,
                                                                    generation=self.generation, call=call))

    async def run(self, tool: str, args: dict) -> tuple[Decision, ExecResult]:
        """A call the rules allow, decided and executed."""
        decision = await self.decide(tool, args)
        assert decision.state == "allowed", decision
        result = await self.kernel.call("POST /execute", ExecuteRequest(
            decision_id=decision.decision_id, session_id=self.session_id, generation=self.generation))
        return decision, result


async def guest(kernel_http, fake, owner: Owner, *, preview: bool = False) -> Guest:
    """A visitor session opened now (the fake's clock), or the owner's preview session."""
    opener = kernel_http.owner(owner.token) if preview else kernel_http.public()
    created = await opener.call("POST /sessions", CreateSessionRequest(desk_slug=owner.slug, kind="visitor",
                                                                       preview=preview))
    ids = Ids(copy_id=owner.copy_id, desk_id=owner.desk_id, session_id=created.state.session_id)
    return Guest(ids=ids, kernel=kernel_http.session(created.session_token), fake=fake)


async def write(engine, admin, ids: Ids, kind: str, at: datetime | None = None, **columns) -> int:
    """A transcript row the API would write, committed, and dated `at` when given; returns its `n`."""
    async with engine.connect() as conn:
        n = await append_message(conn, ids, kind, **columns)
        await conn.commit()
    if at is not None:
        admin.execute("UPDATE app.messages SET created_at = %s WHERE n = %s", (at, n))
    return n


RIVERA = ZoneInfo("America/Los_Angeles")


def local(year: int, month: int, day: int, hour: int, minute: int = 0, second: int = 0, *, fold: int = 0) -> datetime:
    """A wall-clock time at Rivera Plumbing, as a UTC instant (`fold=1`: the second of a repeated hour)."""
    return datetime(year, month, day, hour, minute, second, tzinfo=RIVERA, fold=fold).astimezone(UTC)


def stamp(moment: datetime) -> str:
    """A time as the API's JSON gives it."""
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


@dataclass
class Scene:
    """An owner's Desk and what happens on it, each thing at the time it is given (the fake's clock for the kernel's
    rows, the row's own date for the API's)."""

    owner: Owner
    fake: object
    kernel_http: object
    engine: object
    admin: object

    async def visitor(self, when: datetime, *, preview: bool = False) -> Guest:
        self.fake.now = when
        return await guest(self.kernel_http, self.fake, self.owner, preview=preview)

    async def text(self, who: Guest, when: datetime, text: str = "Hi, do you fix leaks?") -> int:
        return await write(self.engine, self.admin, who.ids, "visitor_text", when, text=text)

    async def reply(self, who: Guest, when: datetime, *, handoff: bool = False) -> int:
        block = (RenderedBlock(kind="card", template="handoff", text="Let me check with Maria Rivera.")
                 if handoff else RenderedBlock(kind="prose", text="Yes, we do. When suits you?"))
        return await write(self.engine, self.admin, who.ids, "delivered", when, author="claude", blocks=[block])

    async def refusal(self, who: Guest, when: datetime) -> Decision:
        self.fake.now = when
        refused = await who.decide("native.release_document", {"document_id": "doc-someone-elses"})
        assert refused.outcome == "refuse"
        return refused

    async def blocked_reply(self, who: Guest, when: datetime) -> int:
        """A reply of Claude's the checkpoint blocks (a number in its prose); returns its ledger entry's seq."""
        self.fake.now = when
        draft = ReplyDraft(session_id=who.session_id, generation=who.generation, prose="That's 180 dollars.")
        verdict = await who.kernel.call("POST /check_reply", CheckReplyRequest(draft=draft))
        assert not verdict.ok
        return verdict.ledger_seq

    async def booking(self, who: Guest, when: datetime) -> Decision:
        self.fake.now = when
        desk = self.fake.desks[self.owner.desk_id]
        slot = max(slot.slot_id for slot in desk.slots.values() if slot.slot_id not in desk.booked)
        decision, result = await who.run("native.book", {"slot_id": slot})
        assert result.state == "succeeded"
        return decision

    async def quote(self, who: Guest, when: datetime, item: str = "Drain clearing", qty: int = 1) -> int:
        """A quote at list price, made and executed (the kernel's quotes row, made at `when`); returns its amount."""
        self.fake.now = when
        decision, result = await who.run("native.quote", {"items": [{"item_id": item_ids(self.fake, self.owner, item),
                                                                     "qty": qty}]})
        assert result.state == "succeeded"
        return decision.action.amount_cents

    async def lead(self, who: Guest, when: datetime, name: str = "Sam Ortiz", note: str | None = None) -> str:
        self.fake.now = when
        _, result = await who.run("native.capture_lead", {"name": name, "contact": "(510) 555-0199", "note": note})
        return result.model_view["lead_id"]

    async def hold(self, who: Guest, when: datetime) -> Decision:
        self.fake.now = when
        held = await who.decide("native.quote", discounted_quote(self.fake, self.owner))
        assert held.state == "held"
        return held

    async def answer(self, decision_id: str, when: datetime, choice: str = "allow_once") -> None:
        """The owner's answer, straight on the kernel (a refused answer is ledgered too)."""
        self.fake.now = when
        try:
            await self.kernel_http.owner(self.owner.token).call(
                "POST /approvals/{decision_id}/answer", AnswerRequest(answer=choice), path={"decision_id": decision_id})
        except KernelFailed as failure:
            assert failure.status == 409

    def mode(self, who: Guest, when: datetime, mode: str) -> None:
        """A take-over (`owner`), a hand-back or a resume (`ai`), or the breaker's pause (`paused`)."""
        self.fake.now = when
        self.fake.set_mode(who.session_id, mode)

    def blocked_owner_say(self, who: Guest, when: datetime) -> int:
        """An owner's say the checkpoint stopped (it quoted a private document): ledgered `reply`, author owner."""
        self.fake.now = when
        entry = self.fake.append(self.fake.desks[self.owner.desk_id], "reply", {
            "message_id": "msg-owner-say", "author": "owner", "ok": False, "language": "en", "violations": ["canary"],
            "rule_ids": ["canary"], "fact_ids": []}, session_id=who.session_id)
        self.fake.flush()
        return entry.seq

    def blocked_reply_with(self, who: Guest, when: datetime, violations: list[str], rule_ids: list[str] | None) -> int:
        """A reply of Claude's the checkpoint blocked, ledgered as the kernel ledgers one: its violation kinds and their
        rule IDs, side by side (`rule_ids=None` leaves them out of the entry). The fake's own scan makes no booking
        claim, so the entry is written straight; returns its seq."""
        self.fake.now = when
        summary = {"message_id": f"msg-{next(_CALL_IDS)}", "author": "claude", "ok": False, "language": "en",
                   "violations": violations, "fact_ids": []}
        if rule_ids is not None:
            summary["rule_ids"] = rule_ids
        entry = self.fake.append(self.fake.desks[self.owner.desk_id], "reply", summary, session_id=who.session_id)
        self.fake.flush()
        return entry.seq

    def replayed_blocked_reply(self, who: Guest, recorded_at: datetime, written_at: datetime) -> int:
        """A blocked reply of Claude's replayed into the copy: its entry is written at `written_at` and carries the
        time it was recorded at in `summary.replayed.at`, as replayed history does."""
        self.fake.now = written_at
        entry = self.fake.append(self.fake.desks[self.owner.desk_id], "reply", {
            "message_id": "msg-replayed", "author": "claude", "ok": False, "language": "en",
            "violations": ["number_in_prose"], "rule_ids": ["digit"], "fact_ids": [],
            "replayed": {"at": signed_time(recorded_at), "recording": "a recorded night"}}, session_id=who.session_id)
        self.fake.flush()
        return entry.seq


async def new_scene(app, browser, fake, kernel_http, engine, db, made: datetime) -> Scene:
    """A Rivera Plumbing copy made at `made` (its calendar runs two weeks on from there)."""
    fake.now = made
    return Scene(owner=await new_owner(app, browser, fake, kernel_http), fake=fake, kernel_http=kernel_http,
                 engine=engine, admin=db)


@pytest.fixture
async def scene(app, browser, fake, kernel_http, engine, db) -> Scene:
    """Rivera Plumbing's copy, made on 2026-10-28 at noon, Rivera time."""
    return await new_scene(app, browser, fake, kernel_http, engine, db, local(2026, 10, 28, 12))


def item_ids(fake, owner: Owner, tool: str = "Drain clearing") -> str:
    return next(item.item_id for item in fake.desks[owner.desk_id].prices.values() if item.title == tool)


def discounted_quote(fake, owner: Owner, discount_bp: int = 1000) -> dict:
    return {"items": [{"item_id": item_ids(fake, owner), "qty": 1}], "requested_discount_bp": discount_bp}


async def test_switcher_lists_only_this_copys_businesses(app, browser, fake, kernel_http):
    owner = await new_owner(app, browser, fake, kernel_http)
    other = await new_owner(app, browser, fake, kernel_http)

    listed = await owner.get("desks")

    assert listed.status_code == 200, listed.text
    desk = fake.desks[owner.desk_id]
    assert listed.json() == [{
        "business_id": desk.business_id, "name": "Rivera Plumbing", "owner_display_name": "Maria Rivera",
        "timezone": "America/Los_Angeles",
        "desks": [{"desk_id": owner.desk_id, "slug": owner.slug, "name": "Main line",
                   "business_name": "Rivera Plumbing",
                   "hours": [window.model_dump(mode="json") for window in desk.hours], "answering": True}]}]
    assert other.desk_id not in listed.text and fake.desks[other.desk_id].business_id not in listed.text
    assert (await browser(app).get("/api/owner/desks")).status_code == 401          # no owner cookie


async def test_answering_switch_updates_the_desk(app, browser, fake, kernel_http):
    owner = await new_owner(app, browser, fake, kernel_http)
    other = await new_owner(app, browser, fake, kernel_http)
    fake.calls.clear()

    switched = await owner.browser.put(f"/api/owner/desks/{owner.desk_id}/answering", json={"on": False})

    assert switched.status_code == 200, switched.text
    assert switched.json()["desk_id"] == owner.desk_id and switched.json()["updated_at"]
    (sent,) = fake.called("PUT /desks/{id}/answering")
    assert sent.path == f"/desks/{owner.desk_id}/answering" and sent.body == {"on": False}
    assert sent.headers[OWNER] == owner.token
    assert fake.desks[owner.desk_id].answering is False
    assert [desk["answering"] for desk in (await owner.get("me")).json()["desks"]] == [False]
    back_on = await owner.browser.put(f"/api/owner/desks/{owner.desk_id}/answering", json={"on": True})
    assert back_on.status_code == 200
    assert [desk["answering"] for business in (await owner.get("desks")).json() for desk in business["desks"]] == [True]

    # another copy's Desk is not found, and never reaches the kernel; a body that isn't {on} is refused
    fake.calls.clear()
    elsewhere = await owner.browser.put(f"/api/owner/desks/{other.desk_id}/answering", json={"on": False})
    assert (elsewhere.status_code, elsewhere.json()) == (404, {"error": "not_found"})
    extra = await owner.browser.put(f"/api/owner/desks/{owner.desk_id}/answering", json={"on": False, "all": True})
    assert (extra.status_code, extra.json()) == (422, {"error": "invalid"})
    assert fake.called("PUT /desks/{id}/answering") == [] and fake.desks[other.desk_id].answering is True


def seeded_hold(fake, owner: Owner) -> str:
    """The seed's held quote in the owner's copy."""
    (decision_id,) = [decision_id for decision_id, record in fake.decisions.items()
                      if record.copy_id == owner.copy_id and record.decision.call_id == "seed-held-quote"]
    return decision_id


async def test_owner_decision_read_is_copy_scoped(app, browser, fake, kernel_http):
    owner = await new_owner(app, browser, fake, kernel_http)
    other = await new_owner(app, browser, fake, kernel_http)
    mine, theirs = seeded_hold(fake, owner), seeded_hold(fake, other)
    fake.calls.clear()

    read = await owner.get(f"decisions/{mine}")

    assert read.status_code == 200, read.text
    assert read.json() == fake.decisions[mine].decision.model_dump(mode="json")      # the signed record, unchanged
    (sent,) = fake.called("GET /decisions/{id}")
    assert sent.headers[OWNER] == owner.token and "x-session-token" not in sent.headers
    for decision_id in (theirs, "dec-never-made"):
        refused = await owner.get(f"decisions/{decision_id}")
        assert (refused.status_code, refused.json()) == (404, {"error": "kernel", "code": "not_found"})


async def test_ledger_passes_verification_through(app, browser, fake, kernel_http):
    owner = await new_owner(app, browser, fake, kernel_http)
    other = await new_owner(app, browser, fake, kernel_http)
    kernel_owner = kernel_http.owner(owner.token)

    def kernel_page():
        return kernel_owner.call("GET /ledger/{desk_id}?verify=true", path={"desk_id": owner.desk_id})

    read = await owner.get(f"desks/{owner.desk_id}/ledger", verify="true")

    assert read.status_code == 200, read.text
    assert read.json() == (await kernel_page()).model_dump(mode="json")
    assert read.json()["chain_ok"] is True and read.json()["first_bad_seq"] is None
    # an entry changed after it was chained: the kernel's verdict reaches the owner as the kernel gave it
    ledger = fake.desks[owner.desk_id].ledger
    ledger[1] = ledger[1].model_copy(update={"event": ledger[1].event.model_copy(update={"summary": {"forged": True}})})
    broken = await owner.get(f"desks/{owner.desk_id}/ledger", verify="true")
    assert broken.json() == (await kernel_page()).model_dump(mode="json")
    assert (broken.json()["chain_ok"], broken.json()["first_bad_seq"]) == (False, ledger[1].seq)

    fake.calls.clear()
    elsewhere = await owner.get(f"desks/{other.desk_id}/ledger", verify="true")
    assert (elsewhere.status_code, elsewhere.json()) == (404, {"error": "not_found"})
    assert fake.called("GET /ledger/{desk_id}?verify=true") == []


async def test_needs_you_lists_held_requests_and_open_handoffs(app, browser, fake, kernel_http, engine, db):
    owner = await new_owner(app, browser, fake, kernel_http)
    seeded = seeded_hold(fake, owner)
    fake.now += timedelta(minutes=5)
    dana = await guest(kernel_http, fake, owner)
    fake.verify(dana.session_id, "dana")
    await write(engine, db, dana.ids, "visitor_text", text="Could you do 10% off the drain clearing?")
    dana_hold = await dana.decide("native.quote", discounted_quote(fake, owner))
    fake.now += timedelta(minutes=5)
    caller = await guest(kernel_http, fake, owner)
    await write(engine, db, caller.ids, "visitor_text", text="Water everywhere, please call me")
    await write(engine, db, caller.ids, "visitor_text", text="It's the heater in the garage")
    await caller.run("native.capture_lead", {"name": "Sam Ortiz", "contact": "(510) 555-0199"})
    await caller.run("native.request_callback", {"name": "Sam Ortiz", "contact": "(510) 555-0199",
                                                 "reason": "Leaking water heater"})
    (handoff,) = fake.handoffs.values()
    fake.calls.clear()

    listed = await owner.get(f"desks/{owner.desk_id}/needs_you")

    assert listed.status_code == 200, listed.text
    first, second, third = listed.json()
    assert first == {
        "decision": fake.decisions[seeded].decision.model_dump(mode="json"),
        "held_by": "Quotes from your price list, at list price.",
        "held_at": fake.decisions[seeded].created_at.isoformat().replace("+00:00", "Z"),
        "handoff": None,
        "session": {"session_id": fake.decisions[seeded].decision.session_id, "kind": "visitor",
                    "display_name": None, "verified": False, "assurance": "none"},
        "from_the_visitor": None}
    assert first["decision"]["answers"] == ["allow_once", "deny_once"]        # a limit hold: no "Deny always"
    assert second["decision"]["decision_id"] == dana_hold.decision_id and second["handoff"] is None
    assert second["decision"]["answers"] == ["allow_once", "allow_person", "deny_once"]
    assert second["session"] == {"session_id": dana.session_id, "kind": "visitor", "display_name": "Dana Whitfield",
                                 "verified": True, "assurance": "demo_code"}
    assert second["from_the_visitor"] == "Could you do 10% off the drain clearing?"
    assert third == {
        "decision": None, "held_by": None, "held_at": None,
        "handoff": {"handoff_id": handoff["handoff_id"], "session_id": caller.session_id,
                    "reason": "Sam Ortiz · (510) 555-0199 · Leaking water heater", "callback_window": None,
                    "status": "open"},
        "session": {"session_id": caller.session_id, "kind": "visitor", "display_name": "Sam Ortiz",
                    "verified": False, "assurance": "none"},
        "from_the_visitor": "It's the heater in the garage"}
    # each held request was read from the kernel, with the owner's credential, which applies expiry
    reads = fake.called("GET /decisions/{id}")
    assert sorted(call.path for call in reads) == sorted(f"/decisions/{decision_id}"
                                                         for decision_id in (seeded, dana_hold.decision_id))
    assert all(call.headers[OWNER] == owner.token for call in reads)



async def test_handoff_done_leaves_needs_you(app, browser, fake, kernel_http):
    owner = await new_owner(app, browser, fake, kernel_http)
    other = await new_owner(app, browser, fake, kernel_http)
    caller = await guest(kernel_http, fake, owner)
    await caller.run("native.request_callback", {"name": "Sam Ortiz", "contact": "(510) 555-0199",
                                                 "reason": "Leaking water heater"})
    (handoff_id,) = fake.handoffs

    def waiting(response: httpx.Response) -> list[str]:
        return [item["handoff"]["handoff_id"] for item in response.json() if item["handoff"]]

    assert waiting(await owner.get(f"desks/{owner.desk_id}/needs_you")) == [handoff_id]
    # another copy's owner can't close it: not found, and never sent to the kernel
    fake.calls.clear()
    elsewhere = await other.browser.post(f"/api/owner/handoffs/{handoff_id}/done")
    assert (elsewhere.status_code, elsewhere.json()) == (404, {"error": "not_found"})
    assert fake.called("POST /handoffs/{id}/done") == [] and fake.handoffs[handoff_id]["status"] == "open"

    done = await owner.browser.post(f"/api/owner/handoffs/{handoff_id}/done")

    assert done.status_code == 200, done.text
    assert done.json()["desk_id"] == owner.desk_id
    (sent,) = fake.called("POST /handoffs/{id}/done")
    assert sent.path == f"/handoffs/{handoff_id}/done" and sent.headers[OWNER] == owner.token
    assert waiting(await owner.get(f"desks/{owner.desk_id}/needs_you")) == []
    again = await owner.browser.post(f"/api/owner/handoffs/{handoff_id}/done")
    assert (again.status_code, again.json()) == (409, {"error": "kernel", "code": "conflict"})
    unknown = await owner.browser.post("/api/owner/handoffs/handoff-never-made/done")
    assert (unknown.status_code, unknown.json()) == (404, {"error": "not_found"})


async def test_expired_hold_refreshes_on_read(app, browser, fake, kernel_http, ro_schema, api_conn):
    owner = await new_owner(app, browser, fake, kernel_http)
    seeded = seeded_hold(fake, owner)
    assert [item["decision"]["decision_id"] for item in (await owner.get(f"desks/{owner.desk_id}/needs_you")).json()
            ] == [seeded]
    fake.now += timedelta(hours=25)                    # a hold waits 24 hours for the owner

    listed = await owner.get(f"desks/{owner.desk_id}/needs_you")

    assert (listed.status_code, listed.json()) == (200, [])
    # the kernel's read applied the expiry, so its rows say so too, and the owner's read of it agrees
    ro = KernelRO(api_conn, owner.copy_id, ro_schema)
    assert (await ro.one("decisions", decision_id=seeded))["state"] == "expired"
    assert (await owner.get(f"decisions/{seeded}")).json()["state"] == "expired"
    today = await owner.get(f"desks/{owner.desk_id}/today")
    assert today.status_code == 200 and today.json()["needs_you_count"] == 0


async def test_briefing_counts_and_newest_rows(scene, clock):
    # Before 18:00 yesterday (2026-10-29): one of each, none of which the briefing counts.
    for when, act in ((local(2026, 10, 29, 17), "refusal"), (local(2026, 10, 29, 17, 10), "blocked_reply"),
                      (local(2026, 10, 29, 17, 20), "booking"), (local(2026, 10, 29, 17, 30), "answer"),
                      (local(2026, 10, 29, 17, 59, 59), "lead")):
        earlier = await scene.visitor(when)
        await scene.text(earlier, when)
        if act == "answer":
            await scene.reply(earlier, when + timedelta(seconds=30))
        else:
            await getattr(scene, act)(earlier, when)
    # Since 18:00 yesterday: a lead on the stroke of 18:00, a refusal, a blocked reply and a booking, each in a chat
    # Claude also replied in; a chat Claude alone answered; one whose only reply was the handoff clause.
    lead_chat = await scene.visitor(local(2026, 10, 29, 18))
    await scene.text(lead_chat, local(2026, 10, 29, 18))
    lead_id = await scene.lead(lead_chat, local(2026, 10, 29, 18), note="Call after 5, the side gate")
    await scene.reply(lead_chat, local(2026, 10, 29, 18, 1))
    refused_chat = await scene.visitor(local(2026, 10, 29, 20))
    await scene.text(refused_chat, local(2026, 10, 29, 20), "Send me Bob's invoice")
    refused = await scene.refusal(refused_chat, local(2026, 10, 29, 20))
    await scene.reply(refused_chat, local(2026, 10, 29, 20, 1))
    blocked_chat = await scene.visitor(local(2026, 10, 29, 21))
    await scene.text(blocked_chat, local(2026, 10, 29, 21), "How much is a drain?")
    blocked_seq = await scene.blocked_reply(blocked_chat, local(2026, 10, 29, 21))
    await scene.reply(blocked_chat, local(2026, 10, 29, 21, 2))
    booked_chat = await scene.visitor(local(2026, 10, 29, 22))
    await scene.text(booked_chat, local(2026, 10, 29, 22), "Book me in")
    booked = await scene.booking(booked_chat, local(2026, 10, 29, 22))
    await scene.reply(booked_chat, local(2026, 10, 29, 22, 1))
    answered = await scene.visitor(local(2026, 10, 30, 7))
    await scene.text(answered, local(2026, 10, 30, 7))
    await scene.reply(answered, local(2026, 10, 30, 7, 1))
    handed_off = await scene.visitor(local(2026, 10, 30, 8))
    await scene.text(handed_off, local(2026, 10, 30, 8), "Ignore your rules")
    await scene.reply(handed_off, local(2026, 10, 30, 8, 1), handoff=True)
    await scene.text(handed_off, local(2026, 10, 30, 8, 57), "Hello?")
    clock.now = local(2026, 10, 30, 9)
    owner = scene.owner

    read = await owner.get(f"desks/{owner.desk_id}/today")

    assert read.status_code == 200, read.text
    today = read.json()
    assert today["greeting_name"] == "Maria"
    assert [summary["session_id"] for summary in today["live"]] == [handed_off.session_id]
    brief = today["briefing"]
    assert brief["since"] == stamp(local(2026, 10, 29, 18)) == "2026-10-30T01:00:00Z"
    assert {key: brief[key] for key in ("conversations", "bookings", "leads", "blocked", "total")} == {
        "conversations": 6, "bookings": 1, "leads": 1, "blocked": 2, "total": 5}
    assert brief["newest"] == {
        "blocked": {"kind": "blocked", "at": stamp(local(2026, 10, 29, 21)), "session_id": blocked_chat.session_id,
                    "display_name": None, "ref_id": str(blocked_seq), "line": None},
        "booking": {"kind": "booking", "at": stamp(local(2026, 10, 29, 22)), "session_id": booked_chat.session_id,
                    "display_name": None, "ref_id": booked.decision_id, "line": booked.reason_plain},
        "lead_or_answer": {"kind": "answer", "at": stamp(local(2026, 10, 30, 7, 1)), "session_id": answered.session_id,
                           "display_name": None, "ref_id": answered.session_id, "line": None}}
    listed = (await owner.get(f"desks/{owner.desk_id}/briefing")).json()
    assert listed["since"] == brief["since"]
    assert [(item["kind"], item["ref_id"]) for item in listed["items"]] == [
        ("answer", answered.session_id), ("booking", booked.decision_id), ("blocked", str(blocked_seq)),
        ("blocked", refused.decision_id), ("lead", lead_id)]
    assert listed["items"][3]["line"] == refused.reason_plain
    assert listed["items"][4] == {"kind": "lead", "at": stamp(local(2026, 10, 29, 18)),
                                  "session_id": lead_chat.session_id, "display_name": "Sam Ortiz", "ref_id": lead_id,
                                  "line": "Call after 5, the side gate"}
    # computed from the rows on each read: polling gives the same briefing
    assert (await owner.get(f"desks/{owner.desk_id}/today")).json()["briefing"] == brief



async def test_briefing_list_is_the_window_newest_first(scene, clock):
    early = await scene.visitor(local(2026, 10, 29, 17))
    await scene.lead(early, local(2026, 10, 29, 17), name="Before the window")       # before 18:00: not listed
    pushy_at = local(2026, 10, 29, 18, 30)
    pushy = await scene.visitor(pushy_at)
    first, second = await scene.refusal(pushy, pushy_at), await scene.refusal(pushy, pushy_at)
    mixed = await scene.visitor(local(2026, 10, 29, 19))
    refused = await scene.refusal(mixed, local(2026, 10, 29, 19))
    booked = await scene.booking(mixed, local(2026, 10, 29, 19))
    leaving = await scene.visitor(local(2026, 10, 30, 5, 59))
    lead_id = await scene.lead(leaving, local(2026, 10, 30, 6))
    answered = await scene.visitor(local(2026, 10, 30, 5, 59))
    await scene.text(answered, local(2026, 10, 30, 5, 59))
    await scene.reply(answered, local(2026, 10, 30, 6))
    clock.now = local(2026, 10, 30, 9)
    owner = scene.owner

    listed = await owner.get(f"desks/{owner.desk_id}/briefing")

    assert listed.status_code == 200, listed.text
    assert listed.json()["since"] == stamp(local(2026, 10, 29, 18))
    same_time = sorted((first.decision_id, second.decision_id), reverse=True)
    assert [(item["kind"], item["ref_id"], item["at"]) for item in listed.json()["items"]] == [
        ("lead", lead_id, stamp(local(2026, 10, 30, 6))),
        ("answer", answered.session_id, stamp(local(2026, 10, 30, 6))),
        ("blocked", refused.decision_id, stamp(local(2026, 10, 29, 19))),
        ("booking", booked.decision_id, stamp(local(2026, 10, 29, 19))),
        ("blocked", same_time[0], stamp(pushy_at)), ("blocked", same_time[1], stamp(pushy_at))]
    brief = (await owner.get(f"desks/{owner.desk_id}/today")).json()["briefing"]
    assert brief["total"] == 6 and brief["newest"]["lead_or_answer"]["kind"] == "lead"
    assert (brief["newest"]["blocked"]["ref_id"], brief["newest"]["booking"]["ref_id"]) == (
        refused.decision_id, booked.decision_id)


def by_day(week: dict, key: str) -> dict[str, int]:
    return {day["date"]: day[key] for day in week["days"]}


async def test_this_week_counts_in_the_business_time_zone(app, browser, fake, kernel_http, engine, db, clock):
    # Now is 2026-10-30 09:00 PDT: the seven dates run from Saturday 2026-10-24 to today.
    week = await new_scene(app, browser, fake, kernel_http, engine, db, local(2026, 10, 22, 12))
    for when in (local(2026, 10, 23, 23, 59),           # Friday night: out, though UTC has it on the 24th
                 local(2026, 10, 24, 0),                 # Saturday 00:00: in
                 local(2026, 10, 29, 20)):               # Thursday evening: the 29th, though UTC has it on the 30th
        await week.booking(await week.visitor(when), when)
    late = await week.visitor(local(2026, 10, 29, 23, 30))
    await week.text(late, local(2026, 10, 29, 23, 30))
    clock.now = local(2026, 10, 30, 9)

    read = await week.owner.get(f"desks/{week.owner.desk_id}/today")

    assert read.status_code == 200, read.text
    this_week = read.json()["this_week"]
    assert {key: this_week[key] for key in ("timezone", "start", "end", "bookings", "conversations")} == {
        "timezone": "America/Los_Angeles", "start": "2026-10-24", "end": "2026-10-30", "bookings": 2,
        "conversations": 1}
    assert [day["date"] for day in this_week["days"]] == [f"2026-10-{day}" for day in range(24, 31)]
    assert by_day(this_week, "bookings") == {**{f"2026-10-{day}": 0 for day in range(24, 31)},
                                             "2026-10-24": 1, "2026-10-29": 1}
    assert by_day(this_week, "conversations")["2026-10-29"] == 1 and by_day(this_week, "conversations")[
        "2026-10-30"] == 0

    # Across the fall-back day: now is Sunday 2026-11-01 23:45 PST, so the dates run from Monday 2026-10-26, from
    # 00:00 PDT, and the 01:00 hour of 2026-11-01 comes twice.
    fall = await new_scene(app, browser, fake, kernel_http, engine, db, local(2026, 10, 25, 12))
    for when in (local(2026, 10, 25, 23, 30),           # out
                 local(2026, 10, 26, 0, 30),             # in: after 00:00 PDT, though before 00:00 PST
                 local(2026, 11, 1, 1, 30),              # the first 01:30 (PDT)
                 local(2026, 11, 1, 1, 30, fold=1),      # the second 01:30 (PST)
                 local(2026, 11, 1, 23, 30)):            # 23:30 PST, the 1st, though UTC has it on the 2nd
        await fall.booking(await fall.visitor(when), when)
    clock.now = local(2026, 11, 1, 23, 45)

    today = (await fall.owner.get(f"desks/{fall.owner.desk_id}/today")).json()

    this_week = today["this_week"]
    assert (this_week["start"], this_week["end"], this_week["bookings"]) == ("2026-10-26", "2026-11-01", 4)
    assert [day["date"] for day in this_week["days"]] == [
        "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]
    assert [day["bookings"] for day in this_week["days"]] == [1, 0, 0, 0, 0, 0, 3]
    assert today["briefing"]["since"] == stamp(local(2026, 10, 31, 18)) == "2026-11-01T01:00:00Z"


async def test_this_week_handled_versus_stepped_in(app, browser, fake, kernel_http, engine, db, clock, scene):
    chats: dict[str, Guest] = {}
    for hour, name in enumerate(("approved", "taken_over", "whispered", "said", "held", "claude_alone", "preview",
                                 "resumed", "paused", "cancelled"), start=8):
        when = local(2026, 10, 29, hour)
        chats[name] = await scene.visitor(when, preview=name == "preview")
        await scene.text(chats[name], when)
    later = timedelta(minutes=5)
    approved = await scene.hold(chats["approved"], local(2026, 10, 29, 8))
    await scene.answer(approved.decision_id, local(2026, 10, 29, 8) + later)                  # the owner's answer
    scene.mode(chats["taken_over"], local(2026, 10, 29, 9) + later, "owner")                 # a take-over
    await write(engine, db, chats["whispered"].ids, "whisper", local(2026, 10, 29, 10) + later, text="Offer Tuesday")
    await write(engine, db, chats["said"].ids, "owner_say", local(2026, 10, 29, 11) + later, text="I'm on my way")
    await scene.hold(chats["held"], local(2026, 10, 29, 12))                                   # unanswered: handled
    await scene.reply(chats["claude_alone"], local(2026, 10, 29, 13) + later)
    await scene.reply(chats["preview"], local(2026, 10, 29, 14) + later)                      # the owner's own preview
    scene.mode(chats["resumed"], local(2026, 10, 29, 15, 1), "paused")
    scene.mode(chats["resumed"], local(2026, 10, 29, 15) + later, "ai")                        # the owner resumes it
    scene.mode(chats["paused"], local(2026, 10, 29, 16, 1), "paused")                          # paused, not resumed
    cancelled = await scene.hold(chats["cancelled"], local(2026, 10, 29, 17))
    scene.fake.now = local(2026, 10, 29, 17, 1)
    await chats["cancelled"].kernel.call("POST /decisions/{decision_id}/cancel",
                                         CancelRequest(session_id=chats["cancelled"].session_id),
                                         path={"decision_id": cancelled.decision_id})
    await scene.answer(cancelled.decision_id, local(2026, 10, 29, 17) + later)                # too late: 409, ledgered
    # replayed history: a chat three days back, whose blocked reply was written into the copy this morning
    replayed = await scene.visitor(local(2026, 10, 27, 10))
    await scene.text(replayed, local(2026, 10, 27, 10))
    scene.replayed_blocked_reply(replayed, local(2026, 10, 27, 10), local(2026, 10, 30, 8))
    clock.now = local(2026, 10, 30, 9)
    owner = scene.owner

    this_week = (await owner.get(f"desks/{owner.desk_id}/today")).json()["this_week"]

    assert {key: this_week[key] for key in ("conversations", "stepped_in", "handled", "stopped")} == {
        "conversations": 11, "stepped_in": 5, "handled": 6, "stopped": 1}
    assert by_day(this_week, "stopped") == {**{f"2026-10-{day}": 0 for day in range(24, 31)}, "2026-10-27": 1}
    assert by_day(this_week, "conversations")["2026-10-29"] == 10
    # the conversations list: the latest activity first, each with who has it and how its requests stand
    summaries = (await owner.get(f"desks/{owner.desk_id}/conversations")).json()
    listed = {summary["session_id"]: summary for summary in summaries}
    assert len(summaries) == 12                                   # the eleven chats and the seeded hold's session
    assert [summary["session_id"] for summary in summaries[:2]] == [chats["cancelled"].session_id,
                                                                   chats["paused"].session_id]
    assert summaries[-1]["session_id"] == replayed.session_id
    assert (listed[chats["approved"].session_id]["outcome_counts"], listed[chats["held"].session_id]["outcome_counts"],
            listed[chats["cancelled"].session_id]["outcome_counts"]) == ({"executed": 1}, {"held": 1},
                                                                          {"cancelled": 1})
    assert [listed[chats[name].session_id]["mode"] for name in ("taken_over", "paused", "resumed")] == [
        "owner", "paused", "ai"]
    assert [name for name, chat in chats.items() if listed[chat.session_id]["owner_preview"]] == ["preview"]
    assert listed[chats["said"].session_id]["last_activity"] == stamp(local(2026, 10, 29, 11, 5))

    # A copy whose only activity is the seeded hold, answered: its session has no visitor text, so no conversation.
    quiet = await new_scene(app, browser, fake, kernel_http, engine, db, local(2026, 10, 30, 8))
    await quiet.answer(seeded_hold(fake, quiet.owner), local(2026, 10, 30, 8, 30))
    quiet_week = (await quiet.owner.get(f"desks/{quiet.owner.desk_id}/today")).json()["this_week"]
    assert {key: quiet_week[key] for key in ("conversations", "stepped_in", "handled")} == {
        "conversations": 0, "stepped_in": 0, "handled": 0}


async def test_booked_amount_is_the_conversations_newest_quote(scene, clock):
    # Two quotes a second apart, then a booking: the second quote backs it.
    two_quotes = await scene.visitor(local(2026, 10, 29, 10))
    await scene.quote(two_quotes, local(2026, 10, 29, 10), qty=1)
    newer = await scene.quote(two_quotes, local(2026, 10, 29, 10, 0, 1), qty=2)
    await scene.booking(two_quotes, local(2026, 10, 29, 10, 5))
    # One quote, then two bookings: the quote backs the first only.
    one_quote = await scene.visitor(local(2026, 10, 29, 11))
    once = await scene.quote(one_quote, local(2026, 10, 29, 11), item="Water heater flush")
    await scene.booking(one_quote, local(2026, 10, 29, 11, 5))
    await scene.booking(one_quote, local(2026, 10, 29, 11, 10))
    # A booking with no quote before it adds nothing, nor does a quote made after it.
    no_quote = await scene.visitor(local(2026, 10, 29, 12))
    await scene.booking(no_quote, local(2026, 10, 29, 12))
    await scene.quote(no_quote, local(2026, 10, 29, 12, 30), item="Leak repair")
    # A booking held at 17:00 yesterday and approved at 19:00 is booked at 19:00, backed by its earlier quote.
    held_chat = await scene.visitor(local(2026, 10, 29, 16, 50))
    held_quote = await scene.quote(held_chat, local(2026, 10, 29, 16, 50), item="Leak repair")
    scene.fake.script("native.book", "hold")
    scene.fake.now = local(2026, 10, 29, 17)
    desk = scene.fake.desks[scene.owner.desk_id]
    held = await held_chat.decide("native.book", {
        "slot_id": max(slot.slot_id for slot in desk.slots.values() if slot.slot_id not in desk.booked)})
    scene.fake.script("native.book")                         # back to the seed's rule
    assert held.state == "held"
    await scene.answer(held.decision_id, local(2026, 10, 29, 19))
    assert scene.fake.decisions[held.decision_id].decision.state == "executed"
    clock.now = local(2026, 10, 30, 9)
    owner = scene.owner

    today = (await owner.get(f"desks/{owner.desk_id}/today")).json()

    assert (newer, once, held_quote) == (36000, 15000, 25000)
    this_week = today["this_week"]
    assert (this_week["bookings"], this_week["booked_cents"]) == (5, newer + once + held_quote)
    assert by_day(this_week, "bookings")["2026-10-29"] == 5
    booking = today["briefing"]["newest"]["booking"]
    assert (today["briefing"]["bookings"], booking["ref_id"], booking["at"]) == (
        1, held.decision_id, stamp(local(2026, 10, 29, 19)))
    listed = (await owner.get(f"desks/{owner.desk_id}/briefing")).json()["items"]
    assert [(item["kind"], item["ref_id"]) for item in listed] == [("booking", held.decision_id)]


async def test_stopped_counts_only_attempts(scene, clock):
    stopped = await scene.visitor(local(2026, 10, 29, 19))
    refused = await scene.refusal(stopped, local(2026, 10, 29, 19))
    blocked_seq = await scene.blocked_reply(stopped, local(2026, 10, 29, 20))
    # not attempts: the owner's say the checkpoint stopped, a paused chat's handoff, a refusal at execution
    scene.blocked_owner_say(stopped, local(2026, 10, 29, 21))
    paused = await scene.visitor(local(2026, 10, 29, 22))
    scene.mode(paused, local(2026, 10, 29, 22), "paused")
    draft = ReplyDraft(session_id=paused.session_id, generation=paused.generation, prose="Happy to help.")
    handoff = await paused.kernel.call("POST /check_reply", CheckReplyRequest(draft=draft))
    assert [violation.kind for violation in handoff.violations] == ["session_paused"]
    rules_changed = await scene.visitor(local(2026, 10, 29, 23))
    held = await scene.hold(rules_changed, local(2026, 10, 29, 23))
    scene.fake.never(scene.owner.desk_id, "native.quote")
    await scene.answer(held.decision_id, local(2026, 10, 29, 23, 5))
    assert scene.fake.decisions[held.decision_id].decision.state == "refused_at_execution"
    # nor is a call of the owner's own session that the kernel refused: only visitor and agent sessions count
    owner_session = scene.fake.copies[scene.owner.copy_id].owner_session_id
    scene.fake.now = local(2026, 10, 29, 23, 30)
    own = await scene.kernel_http.owner(scene.owner.token).call("POST /decide", DecideRequest(
        session_id=owner_session, generation=0, desk_id=scene.owner.desk_id,
        call=ToolCall(call_id="owner-call", tool="native.find_slots", args={})))
    assert own.outcome == "refuse"
    clock.now = local(2026, 10, 30, 9)
    owner = scene.owner

    today = (await owner.get(f"desks/{owner.desk_id}/today")).json()
    safety = await owner.get(f"desks/{owner.desk_id}/safety")

    assert (today["this_week"]["stopped"], today["briefing"]["blocked"]) == (2, 2)
    assert safety.status_code == 200, safety.text
    assert [(attempt["kind"], attempt["ref_id"]) for attempt in safety.json()] == [
        ("reply_blocked", str(blocked_seq)), ("refused", refused.decision_id)]



async def test_safety_lists_refusals_with_origin(scene, clock):
    scene.fake.never(scene.owner.desk_id, "native.find_slots")             # the owner said never for showing times
    asking = await scene.visitor(local(2026, 10, 29, 19))
    scene.fake.now = local(2026, 10, 29, 19)
    refused = await asking.decide("native.find_slots", {})
    assert refused.outcome == "refuse" and refused.card_ids == ["never-native.find_slots"]
    replayed = await scene.visitor(local(2026, 10, 29, 20))
    replayed_seq = scene.replayed_blocked_reply(replayed, local(2026, 10, 29, 20), local(2026, 10, 30, 8))
    clock.now = local(2026, 10, 30, 9)
    owner = scene.owner

    listed = await owner.get(f"desks/{owner.desk_id}/safety")

    assert listed.status_code == 200, listed.text
    assert listed.json() == [
        {"ref_id": str(replayed_seq), "kind": "reply_blocked",
         "reason_plain": "A reply was stopped before it was shown, because it wrote a number outside a checked card.",
         "card_ids": [], "origin": "kernel", "created_at": stamp(local(2026, 10, 29, 20)), "triage": None,
         "ledger_seq": replayed_seq},
        {"ref_id": refused.decision_id, "kind": "refused", "reason_plain": refused.reason_plain,
         "card_ids": ["never-native.find_slots"], "origin": "kernel", "created_at": stamp(local(2026, 10, 29, 19)),
         "triage": None, "ledger_seq": refused.ledger_seq}]
    # the replayed entry is listed at the time it was recorded, in the briefing too, not when it was written
    newest = (await owner.get(f"desks/{owner.desk_id}/today")).json()["briefing"]["newest"]["blocked"]
    assert (newest["ref_id"], newest["at"], newest["line"]) == (str(replayed_seq), stamp(local(2026, 10, 29, 20)), None)


STOPPED = "A reply was stopped before it was shown, because "
BOOKING_WHY = "it said a booking was made instead of showing the card"
PROMISE_WHY = "it made a promise the rules don't back"
NUMBER_WHY = "it wrote a number outside a checked card"


async def stopped_reason(scene: Scene, violations: list[str], rule_ids: list[str] | None) -> str:
    """The reason Safety gives the owner for one blocked reply of Claude's, ledgered with these kinds and rule IDs."""
    who = await scene.visitor(local(2026, 10, 29, 19))
    seq = scene.blocked_reply_with(who, local(2026, 10, 29, 19), violations, rule_ids)
    listed = await scene.owner.get(f"desks/{scene.owner.desk_id}/safety")
    assert listed.status_code == 200, listed.text
    (attempt,) = listed.json()
    assert (attempt["kind"], attempt["ref_id"]) == ("reply_blocked", str(seq))
    return attempt["reason_plain"]


def test_the_booking_line_goes_by_the_kernels_booking_rules():
    # the owner's booking line is keyed by the rule IDs the kernel's reply check gives a booking claim, one per language
    # it checks: a language added to the check, or a rule renamed there, can't leave a booking claim read as a promise
    assert {rule_id for rule_id, _ in reply_check.BOOKING_LINES} == {
        rule_id for rule_id, line in REPLY_WHY_BY_RULE.items() if line == BOOKING_CLAIM}


@pytest.mark.parametrize("rule_id", ["lex.en.booking", "lex.es.booking"])
async def test_a_stopped_booking_claim_says_so(scene, clock, rule_id):
    clock.now = local(2026, 10, 30, 9)

    assert await stopped_reason(scene, ["promise_word"], [rule_id]) == f"{STOPPED}{BOOKING_WHY}."


@pytest.mark.parametrize(("violations", "rule_ids", "why"), [
    (["promise_word"], ["lex.en.promise"], PROMISE_WHY),
    (["promise_word"], ["link"], PROMISE_WHY),
    (["promise_word"], ["policy_echo"], PROMISE_WHY),
    (["promise_word"], None, PROMISE_WHY),                          # an entry that names no rule IDs
    # rule IDs that don't stand beside the kinds one for one name none of them
    (["number_in_prose", "promise_word"], ["lex.en.booking"], f"{NUMBER_WHY} and {PROMISE_WHY}"),
], ids=["other-rule", "link", "policy-echo", "no-rule-ids", "rule-ids-out-of-step"])
async def test_a_rule_without_a_line_of_its_own_reads_as_its_kind(scene, clock, violations, rule_ids, why):
    clock.now = local(2026, 10, 30, 9)

    assert await stopped_reason(scene, violations, rule_ids) == f"{STOPPED}{why}."


@pytest.mark.parametrize(("violations", "rule_ids", "why"), [
    (["number_in_prose", "promise_word"], ["digit", "lex.en.booking"], f"{NUMBER_WHY} and {BOOKING_WHY}"),
    (["promise_word", "promise_word"], ["lex.en.booking", "lex.en.promise"], f"{BOOKING_WHY} and {PROMISE_WHY}"),
    (["promise_word", "promise_word"], ["lex.en.booking", "lex.es.booking"], BOOKING_WHY),     # one line, once
], ids=["number-and-booking", "booking-and-promise", "two-booking-claims"])
async def test_a_booking_claims_reason_joins_the_others(scene, clock, violations, rule_ids, why):
    clock.now = local(2026, 10, 30, 9)

    assert await stopped_reason(scene, violations, rule_ids) == f"{STOPPED}{why}."


async def test_owner_transcript_adds_whispers_and_translations(app, browser, fake, kernel_http, engine, ro_schema):
    owner = await new_owner(app, browser, fake, kernel_http)
    other = await new_owner(app, browser, fake, kernel_http)
    visitor = await guest(kernel_http, fake, owner)
    ids = visitor.ids
    checked = ReplyDraft(session_id=ids.session_id, generation=0, prose="Happy to help with your drain.")
    verdict = await visitor.kernel.call("POST /check_reply", CheckReplyRequest(draft=checked))
    said = await visitor.kernel.call("POST /check_reply", CheckReplyRequest(draft=checked.model_copy(
        update={"prose": "I can come by at noon."})))
    held = await visitor.decide("native.quote", discounted_quote(fake, owner))
    async with engine.connect() as conn:
        await start_fresh_context(conn, ids, [])
        asked = await append_message(conn, ids, "visitor_text", text="Hola, ¿cuánto cuesta?", language="es",
                                     owner_translation="Hi, how much is it?")
        await prepare_model_input(conn, ids.session_id)
        await append_assistant(conn, ids, [{"type": "text", "text": "It's $89."}], generation=0)
        await conn.commit()
        await deliver(conn, ids, Reply(verdict, "claude", "api"), ro_schema=ro_schema)
        await deliver(conn, ids, Status(held, "held"), ro_schema=ro_schema)
        pushed = Triage(summary="Pushed for a discount.", category="discount_push")
        await append_message(conn, ids, "triage", ref_id=held.decision_id, text=pushed.model_dump_json())
        await append_message(conn, ids, "whisper", text="Offer a callback instead.")
        await append_message(conn, ids, "note", text="The visitor verified.")
        await append_message(conn, ids, "desk_context", text="{}")
        await append_tool_change(conn, ids, "tool_removal", "native__start_verification")
        await deliver(conn, ids, Reply(said, "owner", "owner"), ro_schema=ro_schema)
        await conn.commit()

    read = await owner.get(f"conversations/{ids.session_id}")

    assert read.status_code == 200, read.text
    body = read.json()
    assert body["state"] == fake.sessions[ids.session_id].state().model_dump(mode="json")
    assert [(item["kind"], item["text"], item["owner_translation"], item["triage"]) for item in body["items"]] == [
        ("visitor_text", "Hola, ¿cuánto cuesta?", "Hi, how much is it?", None), ("delivered", None, None, None),
        ("status", None, None, pushed.model_dump(mode="json")), ("whisper", "Offer a callback instead.", None, None),
        ("delivered", None, None, None)]
    assert [item["event"]["type"] if item["event"] else None for item in body["items"]] == [
        None, "message", "held", None, "message"]
    assert body["items"][4]["event"]["author"] == "owner"                     # the owner's say, as delivered
    assert "$89" not in read.text and "The visitor verified." not in read.text      # model and note rows never show
    # the cursor: only what came after it
    after = await owner.get(f"conversations/{ids.session_id}", after=asked)
    assert [item["n"] for item in after.json()["items"]] == [item["n"] for item in body["items"][1:]]
    # another copy's owner, or a session that isn't one, finds nothing
    for reader, session_id in ((other, ids.session_id), (owner, "no-such-session")):
        missing = await reader.get(f"conversations/{session_id}")
        assert (missing.status_code, missing.json()) == (404, {"error": "not_found"})


async def until(ready: Callable[[], bool], timeout: float = 5.0) -> None:
    async def wait() -> None:
        while not ready():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(wait(), timeout)


async def test_owner_transcript_cursor_never_skips_a_row(app, browser, fake, kernel_http, engine, db):
    owner = await new_owner(app, browser, fake, kernel_http)
    ids = (await guest(kernel_http, fake, owner)).ids
    seen: list[int] = []

    async def poll() -> None:
        after = max(seen, default=0)
        read = await owner.get(f"conversations/{ids.session_id}", after=after)
        seen.extend(item["n"] for item in read.json()["items"])

    async with engine.connect() as first, engine.connect() as second:
        second_pid = (await second.execute(sql("SELECT pg_backend_pid()"))).scalar_one()
        await second.commit()
        numbered_first = await append_message(first, ids, "visitor_text", text="Is anyone there?")
        appending = asyncio.create_task(append_message(second, ids, "visitor_text", text="Hello?"))

        def blocked() -> bool:
            return bool(db.execute("SELECT count(*) FROM pg_locks WHERE pid = %s AND NOT granted",
                                   (second_pid,)).fetchone()[0])

        # The second row either has its number already (nothing orders the two) or waits for the first to commit.
        await until(lambda: appending.done() or blocked())
        if appending.done():
            await second.commit()                         # the second-numbered row commits first
        await poll()
        await first.commit()
        numbered_second = await appending
        await poll()
        await second.commit()
        await poll()

    assert numbered_first < numbered_second
    assert seen == [numbered_first, numbered_second]       # each row seen once, in order



async def test_owner_reads_are_copy_scoped(app, browser, fake, kernel_http, engine, db, clock):
    mine = await new_scene(app, browser, fake, kernel_http, engine, db, local(2026, 10, 29, 12))
    theirs = await new_scene(app, browser, fake, kernel_http, engine, db, local(2026, 10, 29, 12))
    chat = await mine.visitor(local(2026, 10, 29, 19))
    await mine.text(chat, local(2026, 10, 29, 19))
    await mine.reply(chat, local(2026, 10, 29, 19, 1))
    busy = await theirs.visitor(local(2026, 10, 29, 20))
    await theirs.text(busy, local(2026, 10, 29, 20))
    await theirs.refusal(busy, local(2026, 10, 29, 20))
    await theirs.booking(busy, local(2026, 10, 29, 20))
    await theirs.lead(busy, local(2026, 10, 29, 20))
    # a row of the other copy's that names this copy's Desk is still the other copy's
    await write(engine, db, Ids(copy_id=theirs.owner.copy_id, desk_id=mine.owner.desk_id, session_id=busy.session_id),
                "visitor_text", local(2026, 10, 29, 20), text="Not this copy's")
    clock.now = local(2026, 10, 30, 9)
    owner = mine.owner

    today = (await owner.get(f"desks/{owner.desk_id}/today")).json()

    assert {key: today["briefing"][key] for key in ("conversations", "bookings", "leads", "blocked", "total")} == {
        "conversations": 1, "bookings": 0, "leads": 0, "blocked": 0, "total": 1}
    assert (today["this_week"]["conversations"], today["this_week"]["stopped"]) == (1, 0)
    listed = (await owner.get(f"desks/{owner.desk_id}/briefing")).json()["items"]
    assert [(item["kind"], item["session_id"]) for item in listed] == [("answer", chat.session_id)]
    conversations = (await owner.get(f"desks/{owner.desk_id}/conversations")).json()
    assert busy.session_id not in {summary["session_id"] for summary in conversations}
    assert (await owner.get(f"desks/{owner.desk_id}/safety")).json() == []
    # the other copy's Desk is not found on any read, and the kernel is asked nothing but who the owner is
    fake.calls.clear()
    for read in ("today", "briefing", "needs_you", "conversations", "safety", "ledger"):
        elsewhere = await owner.get(f"desks/{theirs.owner.desk_id}/{read}")
        assert (elsewhere.status_code, elsewhere.json()) == (404, {"error": "not_found"}), read
    assert {call.route for call in fake.calls} == {"GET /whoami"}
    # the Demo inbox is the copy's, read with the owner's credential, and never stored
    inbox = await owner.get("demo_inbox")
    assert inbox.status_code == 200 and inbox.headers["cache-control"] == "no-store"
    expected = [entry.model_dump(mode="json") for copy_id, entry in fake.inbox if copy_id == owner.copy_id]
    assert inbox.json() == expected and len(expected) == 1
    assert [entry["decision_id"] for entry in inbox.json()] == [seeded_hold(fake, owner)]   # the held request's alert
    (sent,) = fake.called("GET /demo_inbox")
    assert sent.headers[OWNER] == owner.token
