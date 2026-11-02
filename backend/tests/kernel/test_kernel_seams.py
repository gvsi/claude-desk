"""The kernel-internals seam Plans 01b and 01c build on: adapters, the Cedar request, the writers."""

import ast
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import desk_kernel
import pytest
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from desk.contracts import AUTO_MONEY_HARD_CAP_CENTS, LedgerEvent, NormalizedAction, Principal, ResourceRef, Review
from desk.db.models import DemoInboxEntry, LedgerHead
from desk.kernel_service import adapters, compiler, decide, demo_inbox, desks, labels, ledger, repo
from desk.kernel_service.adapters.base import Adapter
from desk.kernel_service.repo import new_id

from .fakes import FakeAdapter
from .helpers import kernel_ctx, ledger_rows, make_copy_rows, rows_of


async def test_fake_adapter_satisfies_the_protocol(registry):
    registry.clear()                                                        # without the native adapters
    native, mcp = FakeAdapter("native.find_slots"), FakeAdapter("payments.list_charges", effects=["read"])
    for fake in (native, mcp):
        assert isinstance(fake, Adapter)
        adapters.register(fake)
    assert adapters.ADAPTERS["native.find_slots"] is native
    assert native.profile in adapters.registered_profiles()
    assert native.profile in adapters.registered_profiles(source="native")
    assert native.profile not in adapters.registered_profiles(source="mcp")
    assert adapters.registered_profiles(source="mcp") == [mcp.profile]
    assert native.profile.input_schema == native.Args.model_json_schema()
    assert native.profile.input_schema["additionalProperties"] is False
    row = native.tools_row("copy-1", "desk-1")
    assert (row.tool, row.source, row.status, row.profile) == ("native.find_slots", "native", "enabled", native.profile)
    assert row.profile_sha256 == adapters.profile_sha256(native.profile)
    # the profile's hash ignores its status and pending drift, and covers everything Claude and Cedar see
    same = native.profile.model_copy(update={"status": "disabled", "pending_sha256": "e" * 64})
    assert adapters.profile_sha256(same) == row.profile_sha256
    for change in ({"description_confirmed": "Book anything."}, {"effects": ["read"]}):
        assert adapters.profile_sha256(native.profile.model_copy(update=change)) != row.profile_sha256
    with pytest.raises(ValueError):
        adapters.register(FakeAdapter("native.find_slots"))                 # one adapter per tool
    adapters.register(replacement := FakeAdapter("native.find_slots"), replace=True)
    assert adapters.ADAPTERS["native.find_slots"] is replacement

    class LaxArgs(BaseModel):                                               # extra keys or coerced types slip through
        model_config = ConfigDict(extra="ignore")
        qty: int = 1

    class LooseArgs(BaseModel):
        model_config = ConfigDict(extra="forbid")
        qty: int = 1

    for args in (LaxArgs, LooseArgs):
        loose = FakeAdapter("native.quote")
        loose.Args = args
        loose.profile = loose.profile.model_copy(update={"input_schema": args.model_json_schema()})
        with pytest.raises(ValueError):
            adapters.register(loose)
    drifted = FakeAdapter("native.quote")
    drifted.profile = drifted.profile.model_copy(update={"input_schema": {"type": "object"}})
    with pytest.raises(ValueError):
        adapters.register(drifted)                                           # Claude sees exactly what the adapter accepts
    assert "native.quote" not in adapters.ADAPTERS


FIXTURES = Path(__file__).resolve().parents[3] / "kernel" / "cedar" / "fixtures"
TUESDAY_10AM = datetime(2026, 11, 3, 10, 0, tzinfo=ZoneInfo("America/Los_Angeles"))
NOW = datetime(2026, 10, 30, 17, 4, 5, tzinfo=UTC)   # Friday 10:04 in Oakland (daylight time)
CAP = 50_000                                         # the money cap of the version a request is evaluated against


def principal(kind: str, **fields) -> Principal:
    return Principal(kind=kind, session_id=f"session-{kind}", copy_id="copy-1", desk_id="desk-1", **fields)


def action(tool: str = "native.find_slots", kind: str = "desk", **fields) -> NormalizedAction:
    values = dict(action_id="act-1", copy_id="copy-1", desk_id="desk-1", session_id="session-visitor", generation=0,
                  tool=tool, effects=["read"], args_sha256="a" * 64, profile_sha256="p" * 64,
                  resource=ResourceRef(kind=kind, id="desk-1" if kind == "desk" else f"{kind}-1", owner_person_id=None),
                  list_cents=None, discount_bp=None, amount_cents=None, recipient=None, starts_at=None)
    return NormalizedAction(**(values | fields))


def entity(request: dict, type_: str) -> dict:
    [found] = [e for e in request["entities"] if e["uid"]["type"] == type_]
    return found


def test_cedar_request_shape():
    for kind, type_ in (("visitor", "Visitor"), ("agent", "Agent"), ("owner", "Owner")):
        extra = {"agent_key_id": "agent-1"} if kind == "agent" else {}
        request = decide.cedar_request(principal(kind, **extra), action(), tz="America/Los_Angeles", now=NOW, auto_money_cap_cents=CAP)
        assert request["principal"] == {"type": type_, "id": f"session-{kind}"}
        assert entity(request, type_)["uid"] == request["principal"]
    stranger = decide.cedar_request(principal("visitor"), action(), tz="America/Los_Angeles", now=NOW, auto_money_cap_cents=CAP)
    assert set(stranger) == {"principal", "action", "resource", "context", "entities"}
    assert stranger["action"] == "native.find_slots"
    assert stranger["resource"] == {"type": "Desk", "id": "desk-1"}
    assert entity(stranger, "Desk") == {"uid": {"type": "Desk", "id": "desk-1"}, "attrs": {"copy": "copy-1"},
                                        "parents": []}
    assert entity(stranger, "Visitor")["attrs"] == {"verified": False, "assurance": "none", "copy": "copy-1"}
    # every optional attribute is absent, and owner_approved is the engine's to set; the money cap is the
    # version's, never above the platform ceiling
    assert stranger["context"] == {"record_owner_match": False, "local_dow": 4, "local_minute": 604,
                                   "auto_money_cap_cents": CAP}
    for cap, sent in ((0, 0), (AUTO_MONEY_HARD_CAP_CENTS + 1, AUTO_MONEY_HARD_CAP_CENTS)):
        assert decide.cedar_request(principal("visitor"), action(), tz="America/Los_Angeles", now=NOW,
                                    auto_money_cap_cents=cap)["context"]["auto_money_cap_cents"] == sent
    for cap in (-1, True, 500.0):
        with pytest.raises(ValueError):
            decide.cedar_request(principal("visitor"), action(), tz="America/Los_Angeles", now=NOW,
                                 auto_money_cap_cents=cap)
    # a slot is judged by its own start, in the business's time zone
    booking = decide.cedar_request(principal("visitor"), action("native.book", "slot", starts_at=TUESDAY_10AM),
                                   tz="America/Los_Angeles", now=NOW, auto_money_cap_cents=CAP)
    assert (booking["context"]["local_dow"], booking["context"]["local_minute"]) == (1, 600)
    assert booking["resource"] == {"type": "Slot", "id": "slot-1"}
    # amounts, discounts and recipients only when the action has them; review only when given
    dana = principal("visitor", person_id="person-dana", assurance="demo_code")
    review = Review(within_charter_bp=9500, manipulation_bp=300, recommendation="allow")
    document = action("native.release_document", "document", recipient="verified_contact", list_cents=18_000,
                      discount_bp=0, amount_cents=18_000,
                      resource=ResourceRef(kind="document", id="doc-1", owner_person_id="person-dana"))
    released = decide.cedar_request(dana, document, tz="America/Los_Angeles", now=NOW, auto_money_cap_cents=CAP, review=review)
    assert released["context"] == {"record_owner_match": True, "local_dow": 4, "local_minute": 604,
                                   "auto_money_cap_cents": CAP,
                                   "list_cents": 18_000, "discount_bp": 0, "amount_cents": 18_000,
                                   "recipient": "verified_contact", "review": review.model_dump()}
    assert entity(released, "Visitor")["attrs"] == {"verified": True, "person_id": "person-dana",
                                                    "assurance": "demo_code", "copy": "copy-1"}
    assert entity(released, "Document")["attrs"] == {"copy": "copy-1", "owner_person_id": "person-dana"}
    bob = principal("visitor", person_id="person-bob", assurance="demo_code")
    assert decide.cedar_request(bob, document, tz="America/Los_Angeles", now=NOW, auto_money_cap_cents=CAP)["context"]["record_owner_match"] is False
    # a mandate's remaining room is an Agent attribute, and only when there is one
    agent = principal("agent", agent_key_id="agent-1")
    with_room = decide.cedar_request(agent, action(), tz="America/Los_Angeles", now=NOW, auto_money_cap_cents=CAP, mandate_remaining_cents=5_000)
    assert entity(with_room, "Agent")["attrs"] == {"verified": False, "assurance": "none", "copy": "copy-1",
                                                   "agent_key_id": "agent-1", "mandate_remaining_cents": 5_000}
    assert "mandate_remaining_cents" not in entity(
        decide.cedar_request(agent, action(), tz="America/Los_Angeles", now=NOW, auto_money_cap_cents=CAP), "Agent")["attrs"]
    assert "mandate_remaining_cents" not in entity(decide.cedar_request(
        principal("visitor"), action(), tz="America/Los_Angeles", now=NOW, auto_money_cap_cents=CAP, mandate_remaining_cents=5_000),
        "Visitor")["attrs"]
    assert entity(decide.cedar_request(principal("owner", assurance="owner_session"), action(),
                                       tz="America/Los_Angeles", now=NOW, auto_money_cap_cents=CAP), "Owner")["attrs"]["verified"] is True
    # the Rust engine takes the request as built: the real baseline and schema, which require the money
    # cap, with the spike's fixture policies as F, A and H
    engine = desk_kernel.PolicyEngine(compiler.BASELINE)
    sets = {"F": "", "A": (FIXTURES / "auto.cedar").read_text(), "H": (FIXTURES / "hold.cedar").read_text()}
    assert engine.load("desk-1:1", json.dumps(compiler.desk_schema([])), json.dumps(sets)) == []
    verdict = json.loads(engine.decide("desk-1:1", json.dumps(stranger), "final"))
    assert (verdict["outcome"], verdict["errors"]) == ("allow", [])
    for request in (booking, released, with_room):
        assert json.loads(engine.decide("desk-1:1", json.dumps(request), "final"))["errors"] == []
    # a request without the money cap doesn't fit the schema: refused with an error, never decided without it
    capless = {**stranger, "context": {k: v for k, v in stranger["context"].items() if k != "auto_money_cap_cents"}}
    verdict = json.loads(engine.decide("desk-1:1", json.dumps(capless), "final"))
    assert verdict["outcome"] == "refuse" and verdict["errors"], verdict


async def test_writers_share_the_callers_transaction(app):
    rows = await make_copy_rows(app)
    written = LedgerEvent(kind="approval", origin="kernel", summary={"decision_id": "dec-1", "answer": "allow_once"})

    async def nothing_committed() -> None:
        assert await ledger_rows(app, rows) == []
        assert await rows_of(app, rows.copy_id, select(DemoInboxEntry)) == []
        assert await rows_of(app, rows.copy_id, select(LedgerHead)) == []

    with pytest.raises(RuntimeError, match="after the writers"):
        async with kernel_ctx(app) as ctx:
            entry = await ledger.append(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, event=written)
            notice = await demo_inbox.deliver(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, to="owner",
                                              person_id=None, kind="alert", body="Dana asked for a discount.",
                                              preview="A request needs your answer")
            assert entry.seq == 1
            assert (notice.to, notice.preview) == ("owner", "A request needs your answer")
            assert re.fullmatch(r"inbox-[a-z2-7]{16}", notice.entry_id)   # new_id: 10 CSPRNG bytes, base32
            with pytest.raises(ValueError):
                await demo_inbox.deliver(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, to="owner",
                                         person_id=None, kind="sms", body="...", preview="...")
            await nothing_committed()                                     # neither writer committed
            raise RuntimeError("after the writers")
    await nothing_committed()                                             # and the caller's rollback took both
    # with the caller committing, both land together
    async with kernel_ctx(app) as ctx:
        await ledger.append(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, event=written)
        notice = await demo_inbox.deliver(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, to="d•••@example.com",
                                          person_id="person-dana", kind="verification_code",
                                          body="Your code is 482913", preview="Verification code sent",
                                          challenge_id="challenge-1")
    [entry] = await ledger_rows(app, rows)
    [inbox] = await rows_of(app, rows.copy_id, select(DemoInboxEntry))
    assert entry.event == written
    assert (inbox.entry_id, inbox.desk_id, inbox.to, inbox.person_id, inbox.kind, inbox.body, inbox.preview,
            inbox.challenge_id) == (notice.entry_id, rows.desk_id, "d•••@example.com", "person-dana",
                                    "verification_code", "Your code is 482913", "Verification code sent", "challenge-1")
    assert inbox.created_at == app.state.kernel.clock.now()
    assert "482913" not in notice.model_dump_json()                       # the notice is code-free
    with pytest.raises(ValueError):
        new_id("Inbox")                                                   # prefixes are lowercase, to fit card IDs


async def test_owner_alerts_follow_notification_defaults(app):
    rows = await make_copy_rows(app)                     # now: approval, emergency, breaker; briefing: lead, ...
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        held = await demo_inbox.alert_owner(ctx, rows.desk_id, "approval", "A request needs your answer",
                                            "Dana Whitfield asked for 15% off a drain clearing.")
        lead = await demo_inbox.alert_owner(ctx, rows.desk_id, "lead", "New lead", "Someone left a number.")
    assert (held.to, held.preview) == ("owner", "A request needs your answer")
    assert lead is None                                  # a briefing kind waits for the briefing
    [entry] = await rows_of(app, rows.copy_id, select(DemoInboxEntry))
    assert (entry.entry_id, entry.desk_id, entry.to, entry.person_id, entry.kind) == (
        held.entry_id, rows.desk_id, "owner", None, "alert")
    assert entry.body == "Dana Whitfield asked for 15% off a drain clearing."
    # a Desk with no notification row alerts nobody, and another copy's Desk is out of reach
    other = await make_copy_rows(app)
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        assert await demo_inbox.alert_owner(ctx, other.desk_id, "approval", "A request needs your answer", "...") is None


async def test_only_an_approval_alert_names_a_decision(app):
    rows = await make_copy_rows(app)                     # now: approval, emergency, breaker; briefing: booking, ...
    decision_id = new_id("dec")
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        # a breaker alert goes out at once and a booking one waits for the briefing: on either, a decision id is
        # refused before the Desk's preferences are read, so no setting decides whether the refusal happens
        for event_kind in ("breaker", "booking"):
            with pytest.raises(ValueError, match="approval"):
                await demo_inbox.alert_owner(ctx, rows.desk_id, event_kind, "...", "...", decision_id=decision_id)
        # the writer under it refuses one on anything but an owner alert itself, not only by the table's check, and
        # says which part was wrong, the kind or the recipient, without naming the contact
        for to, kind, recipient in (("d•••@example.com", "verification_code", "a contact"),
                                    ("d•••@example.com", "alert", "a contact"), ("owner", "head_checkpoint", "the owner")):
            with pytest.raises(ValueError) as refused:
                await demo_inbox.deliver(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, to=to, person_id=None,
                                         kind=kind, body="...", preview="...", decision_id=decision_id)
            assert str(refused.value) == (f"only an alert to the owner names a decision, not a {kind!r} entry"
                                          f" to {recipient}")
        held = await demo_inbox.alert_owner(ctx, rows.desk_id, "approval", "A request needs your answer", "...",
                                            decision_id=decision_id)
    [entry] = await rows_of(app, rows.copy_id, select(DemoInboxEntry))   # only the approval alert was written
    assert (entry.entry_id, entry.decision_id) == (held.entry_id, decision_id)


async def test_only_a_code_entry_names_its_challenge(app):
    # a session reads the codes of its own challenges, so the writer refuses a code without one, and an entry of
    # another kind with one, before the table's check would
    rows = await make_copy_rows(app)
    async with kernel_ctx(app) as ctx:
        for to, kind, challenge_id in (("d•••@example.com", "verification_code", None),
                                       ("owner", "alert", "challenge-1"), ("owner", "head_checkpoint", "challenge-1")):
            with pytest.raises(ValueError) as refused:
                await demo_inbox.deliver(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, to=to, person_id=None,
                                         kind=kind, body="...", preview="...", challenge_id=challenge_id)
            assert str(refused.value) == ("a code entry names its challenge and no other entry names one, not a"
                                          f" {kind!r} entry")
    assert await rows_of(app, rows.copy_id, select(DemoInboxEntry)) == []


def test_only_an_alert_to_the_owner_is_titled_and_only_for_the_owner():
    """The owner reads an alert to them under its preview line; every other entry, and every entry a session reads,
    has no title, whatever preview the row holds."""
    def row(to: str, kind: str, preview: str) -> DemoInboxEntry:
        return DemoInboxEntry(entry_id=new_id("inbox"), copy_id="copy-1", desk_id="desk-1", to=to, person_id=None,
                              kind=kind, body="Dana asked for 15% off a drain clearing.", preview=preview,
                              created_at=datetime(2026, 11, 1, 9, tzinfo=UTC))

    alert = row("owner", "alert", "Urgent callback requested")
    others = [row("d•••@example.com", "verification_code", "New verification code"),
              row("owner", "head_checkpoint", "Ledger checkpoint"),
              row("d•••@example.com", "alert", "Callback requested")]
    assert demo_inbox.owner_entry(alert).title == "Urgent callback requested"
    assert [demo_inbox.owner_entry(other).title for other in others] == [None] * 3
    assert [demo_inbox.session_entry(entry).title for entry in [alert, *others]] == [None] * 4


def test_one_check_says_what_text_the_database_holds():
    # valid UTF-8 without NUL; the same check wherever an ID, a contact or a body is taken in
    assert repo.storable("Dana Whitfield, café ☕") and repo.storable("")
    assert not repo.storable("nul\x00inside") and not repo.storable("lone \ud800 surrogate")
    assert desks.storable is repo.storable
    # one pattern for the refs `desk_data` entries carry, knowledge IDs included
    assert desks.REF is repo.REF and labels.KNOWLEDGE_ID is repo.REF
    assert repo.REF.fullmatch("kb-parking_2") and not repo.REF.fullmatch("kb parking")
    assert not repo.REF.fullmatch("k" * 65)


KERNEL_SERVICE = Path(decide.__file__).resolve().parent


def test_the_kernel_states_its_checks_without_assert():
    """`python -O` drops every `assert`, so a check written as one would pass whatever it holds:
    the kernel states each check it relies on as code that raises (and so fails closed), never as
    an `assert`, in every module of the kernel service."""
    found = []
    for path in sorted(KERNEL_SERVICE.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"), filename=str(path))):
            if isinstance(node, ast.Assert):
                found.append(f"{path.relative_to(KERNEL_SERVICE)}:{node.lineno}")
    assert found == []
