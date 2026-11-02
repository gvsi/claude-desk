"""Owner Desk management, people and reports (Plan 02b, Task 8): adding a Desk, its parts one route each, deleting it,
the people on record and the leads, the owner's preview as a customer, and the reports.

Every route acts only on the copy the owner cookie names (its `/whoami` answer), sends the owner's credential and
nothing else, and passes the kernel's refusals on as they are: a masked contact, another copy's business, a deleted
Desk. The app runs on FakeKernel.
"""

import itertools
import json
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta

import httpx

from desk.api.kernel_client import CredentialView
from desk.api.ratelimit import LIMITS, Limit
from desk.api.store import Ids, append_message
from desk.contracts import BRAND_PALETTE, CopyCreated, Decision, ExecResult, ToolCall
from desk.kernel_api import CreateCopyRequest, CreateSessionRequest, DecideRequest, ExecuteRequest
from tests.api.test_demo_agent import setup_row
from tests.kernel_contract.fake_kernel import NOTIFICATIONS, RIVERA_TZ
from tests.kernel_contract.ro_tables import mark_replayed
from tests.kernel_contract.test_contract import (
    checkout,
    decide,
    demo_agent,
    execute,
    issue_payment_link,
    open_agent_session,
    quote_args,
    refused as kernel_refusal,
    turn_view,
)

TIMEZONE = "America/Los_Angeles"


@dataclass
class Owner:
    """A copy made straight on the kernel and its owner's browser, holding the owner cookie."""

    browser: httpx.AsyncClient
    token: str
    copy_id: str
    desk_id: str
    slug: str
    copy: CopyCreated


async def new_owner(api, browser, fake, kernel_http) -> Owner:
    copy = await kernel_http.public().call("POST /copies", CreateCopyRequest())
    client = browser(api)
    client.cookies.set("desk_owner", copy.owner_token, domain="desk.test", path="/api/owner")
    desk_id = copy.desk_ids[0]
    return Owner(browser=client, token=copy.owner_token, copy_id=copy.copy_id, desk_id=desk_id,
                 slug=fake.desks[desk_id].slug, copy=copy)


def new_desk(desk_name: str = "Emergency line", **business) -> dict:
    """A `POST /api/owner/desks` body: the business (or an existing one of the copy) and a Desk with empty parts."""
    return {"business": {"name": "Turner Plumbing", "owner_display_name": "Mike Turner", "timezone": TIMEZONE,
                         **business},
            "desk": {"name": desk_name, "charter": [], "hours": [], "price_items": [], "calendar_slots": [],
                     "people": [], "documents": [], "notifications": NOTIFICATIONS}}


_CALL_IDS = itertools.count(1)


@dataclass
class Guest:
    """A visitor session on an owner's Desk, opened straight on the kernel, acting through its own kernel view."""

    session_id: str
    kernel: CredentialView

    async def run(self, tool: str, args: dict) -> tuple[Decision, ExecResult]:
        """A call the rules allow, decided and executed at generation 0."""
        call = ToolCall(call_id=f"call-{next(_CALL_IDS)}", tool=tool, args=args)
        decision = await self.kernel.call("POST /decide", DecideRequest(session_id=self.session_id, generation=0,
                                                                        call=call))
        assert decision.state == "allowed", decision
        result = await self.kernel.call("POST /execute", ExecuteRequest(
            decision_id=decision.decision_id, session_id=self.session_id, generation=0))
        return decision, result


async def guest(kernel_http, owner: Owner) -> Guest:
    created = await kernel_http.public().call("POST /sessions", CreateSessionRequest(desk_slug=owner.slug,
                                                                                     kind="visitor"))
    return Guest(session_id=created.state.session_id, kernel=kernel_http.session(created.session_token))


async def business_id(owner: Owner) -> str:
    (business,) = (await owner.browser.get("/api/owner/desks")).json()
    return business["business_id"]


async def test_each_desk_names_the_business_type_setup_stored_for_it(api, browser, fake, kernel_http, clock, engine):
    # Each of the owner's Desks names the fixed words its pages take, as the built-in agent's task set reads them: the
    # business type setup stored for the Desk, "rivera" for the copy's own Desk, and "other" for a Desk setup didn't
    # type. Both the Desk switcher and the copy's own answer say it.
    fake.now = clock.now
    owner = await new_owner(api, browser, fake, kernel_http)
    made = {}
    for kind in ("office", "untyped", "unset"):
        clock.advance(1)
        fake.now = clock.now
        created = await owner.browser.post("/api/owner/desks", json=new_desk(f"{kind} line", name=f"A {kind} business"))
        assert created.status_code == 201, created.text
        made[kind] = created.json()["desk_id"]
    await setup_row(engine, owner.copy_id, made["office"], "office")
    await setup_row(engine, owner.copy_id, made["office"], "landlord", created_at="2026-10-29 17:00:00+00")  # older
    await setup_row(engine, owner.copy_id, made["untyped"], None)
    listed = {desk["desk_id"]: desk["business_type"]
              for business in (await owner.browser.get("/api/owner/desks")).json() for desk in business["desks"]}
    assert listed == {owner.desk_id: "rivera", made["office"]: "office", made["untyped"]: "other",
                      made["unset"]: "other"}
    me = (await owner.browser.get("/api/owner/me")).json()
    assert {desk["desk_id"]: desk["business_type"] for desk in me["desks"]} == listed


async def test_new_desks_count_on_the_copys_limit(api, browser, fake, kernel_http, monkeypatch):
    # A copy makes at most 10 Desks an hour (here 2): past that it is refused before the kernel is asked, and the first
    # refusal is ledgered.
    assert LIMITS["new_desk"] == Limit(10, 3600, "copy")
    monkeypatch.setitem(LIMITS, "new_desk", Limit(2, 3600, "copy"))
    owner, other = await new_owner(api, browser, fake, kernel_http), await new_owner(api, browser, fake, kernel_http)
    for name in ("Emergency line", "Weekend line"):
        assert (await owner.browser.post("/api/owner/desks", json=new_desk(name))).status_code == 201
    made = len(fake.called("POST /desks"))
    limited = await owner.browser.post("/api/owner/desks", json=new_desk("Third line"))
    assert (limited.status_code, limited.json()["error"]) == (429, "rate_limited")
    assert len(fake.called("POST /desks")) == made
    events = [entry.event for entry in fake.desks[owner.desk_id].ledger if entry.event.kind == "rate_limit"]
    assert [event.summary for event in events] == [{"limit": "new_desk"}]
    assert (await other.browser.post("/api/owner/desks", json=new_desk())).status_code == 201   # each copy its own


async def test_add_desk_to_an_existing_business(api, browser, fake, kernel_http):
    owner, other = await new_owner(api, browser, fake, kernel_http), await new_owner(api, browser, fake, kernel_http)
    rivera = await business_id(owner)

    fake.now += timedelta(seconds=1)                    # the switcher lists a business's Desks in the order made
    created = await owner.browser.post("/api/owner/desks", json=new_desk(existing_business_id=rivera))
    assert created.status_code == 201
    desk = created.json()
    assert set(desk) == {"desk_id", "slug"} and desk["desk_id"] != owner.desk_id
    (call,) = fake.called("POST /desks")
    assert call.headers["x-owner-session"] == owner.token and "x-session-token" not in call.headers
    assert call.body["business"]["existing_business_id"] == rivera and call.body["desk"]["name"] == "Emergency line"
    (business,) = (await owner.browser.get("/api/owner/desks")).json()
    assert business["business_id"] == rivera
    assert [(each["desk_id"], each["name"]) for each in business["desks"]] == [
        (owner.desk_id, "Main line"), (desk["desk_id"], "Emergency line")]
    assert desk["desk_id"] in [each["desk_id"] for each in (await owner.browser.get("/api/owner/me")).json()["desks"]]

    # Another copy's business is the kernel's 404, and the other copy is untouched.
    elsewhere = await other.browser.post("/api/owner/desks", json=new_desk(existing_business_id=rivera))
    assert (elsewhere.status_code, elsewhere.json()) == (404, {"error": "kernel", "code": "not_found"})
    assert len((await other.browser.get("/api/owner/me")).json()["desks"]) == 1
    # A body that isn't a Desk never reaches the kernel; nor does a request without the owner cookie.
    unknown_field = {**new_desk(), "principal": {"kind": "owner"}}
    no_parts = {"business": new_desk()["business"], "desk": {"name": "Emergency line"}}
    for body in (unknown_field, no_parts):
        refused = await owner.browser.post("/api/owner/desks", json=body)
        assert (refused.status_code, refused.json()) == (422, {"error": "invalid"})
    stranger = browser(api)
    refused = await stranger.post("/api/owner/desks", json=new_desk())
    assert (refused.status_code, refused.json()) == (401, {"error": "no_owner_session"})
    assert len(fake.called("POST /desks")) == 2


async def test_people_update_passes_the_masked_contact_rejection_through(api, browser, fake, kernel_http, clock):
    owner, other = await new_owner(api, browser, fake, kernel_http), await new_owner(api, browser, fake, kernel_http)
    people_path = f"/api/owner/desks/{owner.desk_id}/people"
    before = (await owner.browser.get(people_path)).json()
    assert set(before) == {"people", "leads"} and before["leads"] == []
    names = {person["display_name"]: person for person in before["people"]}
    assert set(names) == {"Dana Whitfield", "Bob Okafor"}
    dana = names["Dana Whitfield"]
    assert set(dana) == {"person_id", "display_name", "masked_contact"}
    assert "dana@example.com" not in json.dumps(before)                  # only the masked contact leaves the kernel

    # The owner is shown the masked contact; sent back as a contact, it is the kernel's 422, passed on as it is.
    masked = {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield", "contact": dana["masked_contact"]}]}
    refused = await owner.browser.put(people_path, json=masked)
    assert (refused.status_code, refused.json()) == (422, {"error": "kernel", "code": "invalid"})
    (call,) = fake.called("PUT /desks/{id}/people")
    assert call.path == f"/desks/{owner.desk_id}" + "/people" and call.headers["x-owner-session"] == owner.token
    assert call.body == {"upsert": [{**masked["upsert"][0], "notes": ""}], "remove": []}
    assert (await owner.browser.get(people_path)).json() == before

    # `contact: null` keeps the contact on record; a new person is listed by the masked form of theirs.
    kept = {"upsert": [{"ref": "dana", "display_name": "Dana W.", "contact": None},
                       {"ref": "lee", "display_name": "Lee Park", "contact": "lee@example.com"}],
            "remove": ["bob"]}
    updated = await owner.browser.put(people_path, json=kept)
    assert updated.status_code == 200 and updated.json()["desk_id"] == owner.desk_id
    after = {person["display_name"]: person for person in (await owner.browser.get(people_path)).json()["people"]}
    assert set(after) == {"Dana W.", "Lee Park"}
    assert after["Dana W."] == {**dana, "display_name": "Dana W."}
    assert after["Lee Park"]["masked_contact"] not in ("", "lee@example.com")

    # Leads, newest first, with what the visitor typed as it is.
    visitor = await guest(kernel_http, owner)
    await visitor.run("native.capture_lead", {"name": "Sam Ortiz", "note": "Leaky tap <b>soon</b>"})
    fake.now += timedelta(minutes=1)
    await visitor.run("native.capture_lead", {"name": "Ana Ruiz"})
    leads = (await owner.browser.get(people_path)).json()["leads"]
    assert [(lead["display_name"], lead["note"]) for lead in leads] == [("Ana Ruiz", None),
                                                                        ("Sam Ortiz", "Leaky tap <b>soon</b>")]
    assert set(leads[0]) == {"lead_id", "display_name", "note", "created_at", "replayed"}
    assert [lead["replayed"] for lead in leads] == [False, False]           # left in a live conversation

    # Another copy's Desk is 404, and nothing is sent to the kernel for it.
    calls = len(fake.calls)
    for request in (other.browser.get(people_path), other.browser.put(people_path, json=kept)):
        refused = await request
        assert (refused.status_code, refused.json()) == (404, {"error": "not_found"})
    assert [call.route for call in fake.calls[calls:]] == ["GET /whoami", "GET /whoami"]


async def test_delete_desk(api, browser, fake, kernel_http):
    owner, other = await new_owner(api, browser, fake, kernel_http), await new_owner(api, browser, fake, kernel_http)
    fake.now += timedelta(seconds=1)
    made = (await owner.browser.post("/api/owner/desks", json=new_desk())).json()
    desk_path = f"/api/owner/desks/{made['desk_id']}"
    visitor = browser(api, ip="198.51.100.20")
    assert (await visitor.post(f"/api/public/desks/{made['slug']}/sessions")).status_code == 200

    # Another copy's owner gets 404, and nothing is sent to the kernel.
    refused = await other.browser.delete(desk_path)
    assert (refused.status_code, refused.json()) == (404, {"error": "not_found"})
    assert not fake.called("DELETE /desks/{id}")

    deleted = await owner.browser.delete(desk_path)
    assert (deleted.status_code, deleted.content) == (204, b"")
    (call,) = fake.called("DELETE /desks/{id}")
    assert call.path == f"/desks/{made['desk_id']}" and call.headers["x-owner-session"] == owner.token
    # The Desk leaves the copy: the switcher no longer lists it, its routes are 404, its visitor's chat is closed and
    # its public page is gone. The copy's other Desk is untouched.
    (business,) = (await owner.browser.get("/api/owner/desks")).json()
    assert [desk["desk_id"] for desk in business["desks"]] == [owner.desk_id]
    assert [desk["desk_id"] for desk in (await owner.browser.get("/api/owner/me")).json()["desks"]] == [owner.desk_id]
    for gone in (owner.browser.delete(desk_path), owner.browser.get(f"{desk_path}/today"),
                 owner.browser.put(f"{desk_path}/hours", json={"hours": []})):
        answer = await gone
        assert (answer.status_code, answer.json()) == (404, {"error": "not_found"})
    assert len(fake.called("DELETE /desks/{id}")) == 1
    ended = await visitor.get(f"/api/public/desks/{made['slug']}/session")
    assert (ended.status_code, ended.json()) == (401, {"error": "no_session"})
    page = await visitor.get(f"/api/public/{made['slug']}")
    assert (page.status_code, page.json()) == (404, {"error": "kernel", "code": "not_found"})
    assert (await owner.browser.get(f"/api/owner/desks/{owner.desk_id}/today")).status_code == 200


async def test_preview_session_is_owner_only_and_marked(api, browser, fake, kernel_http):
    owner, other = await new_owner(api, browser, fake, kernel_http), await new_owner(api, browser, fake, kernel_http)
    preview_path = f"/api/owner/desks/{owner.desk_id}/preview_session"
    # Before going live, Answering is off: the preview is how the owner tries the Desk as a customer.
    await owner.browser.put(f"/api/owner/desks/{owner.desk_id}/answering", json={"on": False})

    opened = await owner.browser.post(preview_path)
    assert opened.status_code == 200
    body = opened.json()
    session_id = body["state"]["session_id"]
    assert body["resumed"] is False and body["state"]["kind"] == "visitor"
    (call,) = fake.called("POST /sessions")
    assert call.headers["x-owner-session"] == owner.token and "x-session-token" not in call.headers
    assert call.body == {"desk_slug": owner.slug, "kind": "visitor", "mandate": None, "preview": True}
    # Its token goes only into the visitor cookie, for that Desk's public routes.
    (cookie,) = opened.headers.get_list("set-cookie")
    assert cookie.startswith("desk_visitor=") and cookie.endswith(
        f"; HttpOnly; Secure; SameSite=Strict; Path=/api/public/desks/{owner.slug}; Max-Age=86400")
    token = owner.browser.cookies.get("desk_visitor", domain="desk.test", path=f"/api/public/desks/{owner.slug}")
    assert token and token not in opened.text

    # The public chat opens as the preview, with the visitor tools although Answering is off, and the owner sees it
    # marked as their own preview.
    resumed = (await owner.browser.post(f"/api/public/desks/{owner.slug}/sessions")).json()
    assert (resumed["resumed"], resumed["state"]["session_id"]) == (True, session_id)
    seen = await kernel_http.session(token).call("GET /context/{session_id}?desk_id=", path={"session_id": session_id})
    assert "native.quote" in {tool.tool for tool in seen.tools}
    await Guest(session_id=session_id, kernel=kernel_http.session(token)).run("native.find_slots", {})
    (summary,) = [row for row in (await owner.browser.get(f"/api/owner/desks/{owner.desk_id}/conversations")).json()
                  if row["session_id"] == session_id]
    assert summary["owner_preview"] is True

    # Only the owner of the Desk's copy opens one; neither refusal reaches the kernel.
    stranger = browser(api)
    for client, status, error in ((stranger, 401, "no_owner_session"), (other.browser, 404, "not_found")):
        refused = await client.post(preview_path)
        assert (refused.status_code, refused.json()) == (status, {"error": error})
        assert "set-cookie" not in refused.headers
    assert len(fake.called("POST /sessions")) == 1


async def test_preview_limit_is_ledgered_on_the_desk_previewed(api, browser, fake, kernel_http):
    """A preview counts toward the address's `new_chat` limit like any new chat. The refusal past it is ledgered by the
    owner on the Desk being previewed, which needn't be the copy's first."""
    owner = await new_owner(api, browser, fake, kernel_http)
    fake.now += timedelta(seconds=1)
    second = (await owner.browser.post("/api/owner/desks", json=new_desk())).json()["desk_id"]
    for _ in range(LIMITS["new_chat"].limit):
        assert (await owner.browser.post(f"/api/owner/desks/{owner.desk_id}/preview_session")).status_code == 200
    limited = await owner.browser.post(f"/api/owner/desks/{second}/preview_session")
    assert (limited.status_code, limited.json()["error"]) == (429, "rate_limited")

    def refusals(desk_id: str) -> list[tuple]:
        return [(entry.event.origin, entry.event.session_id, entry.event.summary)
                for entry in fake.desks[desk_id].ledger if entry.event.kind == "rate_limit"]

    assert refusals(second) == [("api", fake.copies[owner.copy_id].owner_session_id, {"limit": "new_chat"})]
    assert refusals(owner.desk_id) == []


async def write(engine, admin, owner: Owner, session_id: str, kind: str, at: datetime, text: str) -> None:
    """A transcript row the API would write, committed and dated `at`."""
    async with engine.connect() as conn:
        n = await append_message(conn, Ids(copy_id=owner.copy_id, desk_id=owner.desk_id, session_id=session_id), kind,
                                 text=text)
        await conn.commit()
    admin.execute("UPDATE app.messages SET created_at = %s WHERE n = %s", (at, n))


async def test_reports_count_bookings_payments_and_who_handled(api, browser, fake, kernel_http, clock, engine, db):
    owner, other = await new_owner(api, browser, fake, kernel_http), await new_owner(api, browser, fake, kernel_http)
    now = fake.now
    clock.now = now + timedelta(minutes=5)
    rivera = fake.desks[owner.desk_id]

    async def visit(at: datetime, *, book: bool = False, pay: bool = False, owner_steps_in: bool = False) -> str:
        """A visitor's conversation at `at`: what they wrote, and what happened in it."""
        fake.now = at
        who = await guest(kernel_http, owner)
        await write(engine, db, owner, who.session_id, "visitor_text", at, "Hi, can you come this week?")
        if book:
            slot = max(slot.slot_id for slot in rivera.slots.values() if slot.slot_id not in rivera.booked)
            await who.run("native.book", {"slot_id": slot})
        if pay:
            token, _ = await issue_payment_link(who.kernel, who.session_id, "deposit", next(_CALL_IDS))
            assert (await checkout(kernel_http, "POST /payment_links/{token}/complete", token)).state == "paid"
            await issue_payment_link(who.kernel, who.session_id, "deposit", next(_CALL_IDS))   # issued, never paid
        if owner_steps_in:
            await write(engine, db, owner, who.session_id, "owner_say", at, "Mike here, I'll call you.")
        return who.session_id

    # Before the window (31 local dates back): a booked and paid conversation that doesn't count.
    await visit(now - timedelta(days=40), book=True, pay=True)
    # In it: a booked and paid conversation Claude handled, one the owner stepped into, and an agent that paid the
    # $20 deposit from its spending limit.
    await visit(now, book=True, pay=True)
    await visit(now, owner_steps_in=True)
    fake.now = now
    issued = await demo_agent(kernel_http, owner.copy)
    created, _ = await open_agent_session(kernel_http, issued, owner.slug)
    agent_id = created.state.session_id
    view = turn_view(kernel_http, issued, owner.slug, agent_id, "Pay the deposit, please.")
    quoted = await execute(view, await decide(view, agent_id, 0, "call-agent-quote", "native.quote",
                                              quote_args("deposit")), 0)
    charge = await decide(view, agent_id, 0, "call-agent-charge", "native.charge_mandate",
                          {"quote_id": quoted.model_view["quote_id"]})
    assert (await execute(view, charge, 0)).state == "succeeded"
    await write(engine, db, owner, agent_id, "agent_text", now, "Paying the deposit for Alex Kim.")

    reports_path = f"/api/owner/desks/{owner.desk_id}/reports"
    month = await owner.browser.get(reports_path, params={"days": 30})
    assert month.status_code == 200
    assert month.json() == {"bookings": 1, "paid_cents": 2000 + 2000, "handled_by_claude": 2, "needed_you": 1,
                            "recorded_history": False}
    assert (await owner.browser.get(reports_path)).json() == month.json()           # 30 days unless asked
    assert (await owner.browser.get(reports_path, params={"days": 60})).json() == {
        "bookings": 2, "paid_cents": 6000, "handled_by_claude": 3, "needed_you": 1, "recorded_history": False}

    for days in (0, 366):
        refused = await owner.browser.get(reports_path, params={"days": days})
        assert (refused.status_code, refused.json()) == (422, {"error": "invalid"})
    refused = await other.browser.get(reports_path)
    assert (refused.status_code, refused.json()) == (404, {"error": "not_found"})


async def test_reports_count_a_link_payment_when_it_was_paid(api, browser, fake, kernel_http, clock):
    """A payment link counts once, in the window its move to `paid` falls in. A link paid just before the window,
    whose checkout is retried just inside it (completed again, then cancelled, each refused and ledgered `payment`
    with the link's state, `paid`), adds nothing to that window."""
    owner = await new_owner(api, browser, fake, kernel_http)
    clock.now = fake.now + timedelta(minutes=5)
    first = clock.now.astimezone(RIVERA_TZ).date() - timedelta(days=29)
    start = datetime.combine(first, time(0), tzinfo=RIVERA_TZ).astimezone(UTC)     # the 30 local dates' start
    fake.now = start - timedelta(minutes=10)
    who = await guest(kernel_http, owner)
    token, _ = await issue_payment_link(who.kernel, who.session_id, "deposit", next(_CALL_IDS))
    complete, cancel = "POST /payment_links/{token}/complete", "POST /payment_links/{token}/cancel"
    assert (await checkout(kernel_http, complete, token)).state == "paid"
    fake.now = start + timedelta(minutes=10)
    for again in (complete, cancel):                                               # a double click, then a cancel
        assert await kernel_refusal(checkout(kernel_http, again, token)) == (409, "conflict")

    reports_path = f"/api/owner/desks/{owner.desk_id}/reports"
    assert (await owner.browser.get(reports_path)).json()["paid_cents"] == 0
    assert (await owner.browser.get(reports_path, params={"days": 31})).json()["paid_cents"] == 2000


async def test_reports_flag_a_payment_from_recorded_history(api, browser, fake, kernel_http, clock, db):
    """The money paid counts recorded history as the other figures do: a payment link whose move to `paid` the kernel
    marked replayed, or an agent's charge whose decision it marked, flags the report, while the same payments live
    don't. The seeded night replays no payment (Plan 01d), so each is marked here by hand, with no conversation
    around it, so the payment alone is what the flag can come from."""
    for kind in ("link", "charge"):
        owner = await new_owner(api, browser, fake, kernel_http)
        clock.now = fake.now + timedelta(minutes=5)
        if kind == "link":
            who = await guest(kernel_http, owner)
            token, _ = await issue_payment_link(who.kernel, who.session_id, "deposit", next(_CALL_IDS))
            assert (await checkout(kernel_http, "POST /payment_links/{token}/complete", token)).state == "paid"
            (paid,) = [entry.seq for entry in fake.desks[owner.desk_id].ledger if entry.event.kind == "payment"
                       and entry.event.summary.get("state") == "paid"]
        else:
            issued = await demo_agent(kernel_http, owner.copy)
            created, _ = await open_agent_session(kernel_http, issued, owner.slug)
            agent_id = created.state.session_id
            view = turn_view(kernel_http, issued, owner.slug, agent_id, "Pay the deposit, please.")
            quoted = await execute(view, await decide(view, agent_id, 0, "call-agent-quote", "native.quote",
                                                      quote_args("deposit")), 0)
            charge = await decide(view, agent_id, 0, "call-agent-charge", "native.charge_mandate",
                                  {"quote_id": quoted.model_view["quote_id"]})
            assert (await execute(view, charge, 0)).state == "succeeded"
            paid = fake.decisions[charge.decision_id].decision.ledger_seq
        reports_path = f"/api/owner/desks/{owner.desk_id}/reports"
        live = (await owner.browser.get(reports_path)).json()
        assert (live["paid_cents"], live["recorded_history"]) == (2000, False), kind
        mark_replayed(db, owner.desk_id, paid, fake.now)
        marked = (await owner.browser.get(reports_path)).json()
        assert marked == {"bookings": 0, "paid_cents": 2000, "handled_by_claude": 0, "needed_you": 0,
                          "recorded_history": True}, kind


async def test_a_brand_palette_pick_goes_to_the_kernel_and_back_on_the_owners_read(api, browser, fake, kernel_http):
    owner = await new_owner(api, browser, fake, kernel_http)
    names = {"name": "Turner Plumbing", "owner_display_name": "Mike Turner", "timezone": TIMEZONE}
    url = f"/api/owner/desks/{owner.desk_id}/business"

    async def brand_read() -> dict:
        (business,) = (await owner.browser.get("/api/owner/desks")).json()
        return business["brand"]

    teal = {"palette": "teal", **BRAND_PALETTE["teal"]}
    assert await brand_read() == teal                                    # the seed's pick
    updated = await owner.browser.put(url, json=names | {"brand_palette": "plum"})
    assert updated.status_code == 200, updated.text
    # passed on as it came: the kernel alone turns the key into colours
    (call,) = fake.called("PUT /desks/{id}/business")
    assert (call.body["brand_palette"], call.body["brand"]) == ("plum", {})
    assert await brand_read() == {"palette": "plum", **BRAND_PALETTE["plum"]}
    # "none", no colours, is a pick; a Desk that stored nothing reads as teal
    assert (await owner.browser.put(url, json=names | {"brand_palette": "none"})).status_code == 200
    assert await brand_read() == {"palette": "none"}
    assert (await owner.browser.put(url, json=names | {"brand_palette": None, "brand": {}})).status_code == 200
    assert await brand_read() == teal
    # a free-form brand from before the palette reads as stored
    legacy = {"primary": "#0F3D3A", "accent": "#C2410C"}
    assert (await owner.browser.put(url, json=names | {"brand": legacy})).status_code == 200
    assert await brand_read() == legacy

    # a key outside the palette, or a pick beside colours of its own, never reaches the kernel
    for bad in ({"brand_palette": "magenta"}, {"brand_palette": "navy", "brand": {"primary": "#000000"}},
                {"brand": {"palette": "magenta"}}):
        refused = await owner.browser.put(url, json=names | bad)
        assert (refused.status_code, refused.json()) == (422, {"error": "invalid"}), bad
    assert len(fake.called("PUT /desks/{id}/business")) == 4


async def test_each_desk_part_goes_to_the_kernel_as_the_owner(api, browser, fake, kernel_http):
    owner, other = await new_owner(api, browser, fake, kernel_http), await new_owner(api, browser, fake, kernel_http)
    fake.now += timedelta(seconds=1)
    made = (await owner.browser.post("/api/owner/desks", json=new_desk(
        "Main line", name="Okafor Electric", owner_display_name="Okafor Electric",
        timezone="America/New_York"))).json()["desk_id"]
    hours = [{"days": ["mon", "tue", "wed", "thu", "fri"], "start": "08:00:00", "end": "17:00:00"}]
    parts = {
        "business": {"name": "Okafor Electric", "owner_display_name": "Bob Okafor", "timezone": "America/New_York"},
        "charter": {"charter": [{"key": "contact", "kind": "text", "value": "(212) 555-0199"}]},
        "hours": {"hours": hours},
        "prices": {"price_items": [{"item_id": "outlet", "title": "Outlet repair", "unit_cents": 9000}]},
        "calendar": {"calendar_slots": [{"slot_id": "S-20261102-0900", "starts_at": "2026-11-02T09:00:00-05:00",
                                         "minutes": 60}]},
        "notifications": {"notifications": {"now": ["approval", "breaker"], "briefing": ["lead"]}},
    }
    for part, body in parts.items():
        updated = await owner.browser.put(f"/api/owner/desks/{made}/{part}", json=body)
        assert updated.status_code == 200 and updated.json()["desk_id"] == made, part
        (call,) = fake.called(f"PUT /desks/{{id}}/{part}")
        assert call.path == f"/desks/{made}/{part}" and call.headers["x-owner-session"] == owner.token, part
    businesses = {business["name"]: business for business in (await owner.browser.get("/api/owner/desks")).json()}
    okafor = businesses["Okafor Electric"]
    assert okafor["owner_display_name"] == "Bob Okafor" and okafor["desks"][0]["hours"] == hours
    assert list(fake.desks[made].prices) == ["outlet"] and list(fake.desks[made].slots) == ["S-20261102-0900"]

    # The kernel's refusals pass on as they are; a body that doesn't fit its part never reaches it.
    bad_name = {**parts["business"], "owner_display_name": "Bob <Okafor>"}
    refused = await owner.browser.put(f"/api/owner/desks/{made}/business", json=bad_name)
    assert (refused.status_code, refused.json()) == (422, {"error": "kernel", "code": "invalid"})
    calls = len(fake.calls)
    for part, body in (("prices", {"price_items": [{"item_id": "Outlet 1", "title": "Outlet", "unit_cents": 9000}]}),
                       ("hours", {"hours": hours, "money_cap_cents": 0})):
        refused = await owner.browser.put(f"/api/owner/desks/{made}/{part}", json=body)
        assert (refused.status_code, refused.json()) == (422, {"error": "invalid"}), part
    # Another copy's owner gets 404 for every part.
    for part, body in parts.items():
        refused = await other.browser.put(f"/api/owner/desks/{made}/{part}", json=body)
        assert (refused.status_code, refused.json()) == (404, {"error": "not_found"}), part
    assert {call.route for call in fake.calls[calls:]} == {"GET /whoami"}
