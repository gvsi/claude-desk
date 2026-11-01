"""Sessions, forged requests and cross-copy access: what a stranger or a buggy API can't get past.

Each case calls the kernel the way the API would, but with credentials that don't fit the call:
identity fields a request may not carry, a missing or another session's token, another copy's
owner token, a stale generation, a session the owner took over, ledger entries only the kernel may
write, and a Desk that was deleted. The kernel builds identity from its own tables, so none of these
may grant anything. On the real kernel a refused session call also leaves an `auth` entry on the
ledger of the session it named ("Session state responses"); no entry holds a token, a token's hash
or another copy's ids; and nothing changes in the copy a refused call reached.

`assert_ledgered` is the check later tasks use for "an attempt is ledgered".
"""

import hashlib
import json
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, get_args

import pytest

from desk.contracts import CopyCreated, LedgerEntry, LedgerEvent, RuleCard
from evals.fakes import FakeAnthropic, Json
from evals.records import NoRecords
from evals.tier1.args import book_args, find_slots_args, quote_args, release_document_args
from evals.tier1.golden_desk import (
    REVIEW_PASS,
    REVIEWER_MODEL,
    Caller,
    GoldenDesk,
    active_version,
    decide,
    desk_of,
    golden_desk,
    open_caller,
    session_row,
)
from evals.tier1.harness import Auth, Expect, KernelHarness
from evals.tier1.test_reply_golden import CLEAN_EN, check_reply, set_mode

LEDGER_KINDS = get_args(LedgerEvent.model_fields["kind"].annotation)
# A forged request is refused as invalid, or decided as what the session really is: a refusal.
INVALID_OR_REFUSED = Expect(any_of=[
    Expect(status=422, fields={"code": "invalid"}),
    Expect(fields={"outcome": "refuse", "state": "refused"}),
])


# Ledger checks

def _copy_id(copy: CopyCreated | str) -> str:
    return copy.copy_id if isinstance(copy, CopyCreated) else copy


@asynccontextmanager
async def ledgered_during(records: Any, copy: CopyCreated | str, desk_id: str) -> AsyncIterator[list[LedgerEntry]]:
    """The Desk's new ledger entries from the calls inside the block, in order, filled in when the
    block ends. The contract stub keeps no ledger, so there the list stays empty."""
    new: list[LedgerEntry] = []
    if isinstance(records, NoRecords):
        yield new
        return
    copy_id = _copy_id(copy)
    before = await records.ledger_entries(copy_id, desk_id)
    head = before[-1].seq if before else -1
    yield new
    new.extend(entry for entry in await records.ledger_entries(copy_id, desk_id) if entry.seq > head)


@asynccontextmanager
async def assert_ledgered(
    records: Any, copy: CopyCreated | str, desk_id: str, kind: str, session_id: str | None = None
) -> AsyncIterator[list[LedgerEntry]]:
    """The calls inside the block write at least one new `kind` entry on the Desk's ledger, and
    with `session_id` every new `kind` entry names that session or none. Yields the Desk's new
    entries of every kind, filled in when the block ends. On the contract stub, which keeps no
    ledger, it checks nothing: its calls are contract-checked only."""
    if kind not in LEDGER_KINDS:
        raise ValueError(f"{kind!r} is not a ledger event kind; the kinds are {list(LEDGER_KINDS)}")
    async with ledgered_during(records, copy, desk_id) as new:
        yield new
    if isinstance(records, NoRecords):
        return
    found = [entry for entry in new if entry.event.kind == kind]
    assert found, f"no new {kind} entry on Desk {desk_id}'s ledger; new entries: {[e.event.kind for e in new]}"
    if session_id is not None:
        others = [entry.seq for entry in found if entry.event.session_id not in (None, session_id)]
        assert not others, f"{kind} entries {others} name another session than {session_id}"


def copy_secrets(copy: CopyCreated, whose: str) -> dict[str, str]:
    """What no other copy's ledger may hold of this copy, by label: its owner token and the
    token's hash, its copy, owner session and Desk ids."""
    values = {
        f"{whose} owner token": copy.owner_token,
        f"{whose} owner token hash": hashlib.sha256(copy.owner_token.encode()).hexdigest(),
        f"{whose} copy id": copy.copy_id,
        f"{whose} owner session id": copy.owner_session.session_id,
    }
    values.update({f"{whose} Desk id {desk_id}": desk_id for desk_id in copy.desk_ids})
    return values


def token_secrets(token: str | None, whose: str) -> dict[str, str]:
    """A session token and its hash, by label (none for an agent session, which has no token)."""
    if token is None:
        return {}
    return {f"{whose} token": token, f"{whose} token hash": hashlib.sha256(token.encode()).hexdigest()}


def assert_only_auth(entries: list[LedgerEntry], forbidden: dict[str, str]) -> None:
    """Each entry is a refusal the kernel wrote (`auth`, origin `kernel`) naming the route and the
    reason, and holds none of `forbidden`'s values. A failure names what leaked by its label,
    never its value, so no token reaches a test report."""
    for entry in entries:
        event = entry.event
        assert (event.kind, event.origin) == ("auth", "kernel"), (
            f"entry {entry.seq} is not an auth refusal the kernel wrote: {event.kind} from {event.origin}")
        named = event.summary.keys() & {"route", "reason"}   # the summary's other keys are its own: never shown
        assert named == {"route", "reason"}, (
            f"auth entry {entry.seq} names its route and reason: it has {sorted(named)} and "
            f"{len(event.summary) - len(named)} other keys")
        dumped = json.dumps(entry.model_dump(mode="json"))
        leaked = [label for label, value in forbidden.items() if value and value in dumped]
        assert not leaked, f"auth entry {entry.seq} holds {leaked}"


# Steps the cases take

def new_call_id() -> str:
    return f"sessions-{secrets.token_hex(6)}"


def find_slots() -> dict[str, Any]:
    """A `native.find_slots` call, which the seed's cards allow anyone."""
    return {"call_id": new_call_id(), "tool": "native.find_slots", "args": find_slots_args()}


def decide_body(caller: Caller, call: dict[str, Any]) -> dict[str, Any]:
    """A `/decide` body for the caller's session at the generation its state holds."""
    return {"session_id": caller.state.session_id, "generation": caller.state.generation, "call": call}


async def copy_rows(records: Any, desk: GoldenDesk, *views: str) -> dict[str, list[dict[str, Any]]]:
    """The Desk's rows in each `kernel_ro` view (real kernel only)."""
    return {view: [row for row in await getattr(records, view)(desk.copy.copy_id)
                   if row.get("desk_id", desk.desk_id) == desk.desk_id]   # approvals belong to the copy
            for view in views}


async def decision_ids(records: Any, desk: GoldenDesk) -> set[str]:
    """The ids of the Desk's stored decisions (real kernel only)."""
    return {row["decision_id"] for row in await records.decisions(desk.copy.copy_id) if row["desk_id"] == desk.desk_id}


# Identity comes from the kernel's tables, never from a request

@pytest.mark.requires("01a")
async def test_identity_fields_never_grant(k: KernelHarness, records):
    """A visitor's request claiming to be Dana, verified or the owner is refused as invalid or
    decided as what the session is, an unverified stranger, wherever the claim sits."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    dana = desk.people["dana"]
    claims = {
        "principal": {"kind": "visitor", "session_id": visitor.state.session_id, "copy_id": desk.copy.copy_id,
                      "desk_id": desk.desk_id, "person_id": dana, "assurance": "demo_code"},
        "person_id": dana,
        "assurance": "demo_code",
        "verified": True,
    }
    args = release_document_args(desk.documents["dana-invoice"])

    def release(**extra: Any) -> dict[str, Any]:
        return {"call_id": new_call_id(), "tool": "native.release_document", "args": args, **extra}

    # Beside the request's own fields, which the contract refuses, so it goes unvalidated.
    await k.call("POST /decide", raw_body={**decide_body(visitor, release()), **claims}, auth=visitor.auth,
                 expect=INVALID_OR_REFUSED)
    # Inside the tool call, and among its args, which the adapter's closed schema doesn't name.
    await k.call("POST /decide", body=decide_body(visitor, release(**claims)), auth=visitor.auth,
                 expect=INVALID_OR_REFUSED)
    await k.call("POST /decide", body=decide_body(visitor, {**release(), "args": {**args, **claims}}),
                 auth=visitor.auth, expect=INVALID_OR_REFUSED)
    # As headers beside the session's own token.
    claimed = Auth.raw({**visitor.auth.headers(), "X-Person-Id": dana, "X-Assurance": "demo_code",
                        "X-Verified": "true", "X-Principal": "owner"})
    await k.call("POST /decide", body=decide_body(visitor, release()), auth=claimed, expect=INVALID_OR_REFUSED)

    await k.call("GET /whoami", auth=visitor.auth, expect=Expect(fields={
        "kind": "visitor", "session.session_id": visitor.state.session_id, "session.verified": False,
        "session.assurance": "none",
    }))
    context = await k.call("GET /context/{session_id}?desk_id=", path={"session_id": visitor.state.session_id},
                           auth=visitor.auth)
    if k.is_real:
        given = [profile.tool for profile in context.tools]
        assert "native.release_document" not in given, f"an unverified visitor is given {given}"
        if k.landed("01b"):   # the tool is Plan 01b's; from then on a verified visitor would be given it
            assert "native.release_document" in [profile.tool for profile in context.tools_declared]
        row = await session_row(records, desk, visitor)
        assert (row["verified"], row["assurance"], row["person_id"]) == (False, "none", None), row
        granted = [row["outcome"] for row in await records.decisions(desk.copy.copy_id)
                   if row["tool"] == "native.release_document" and row["outcome"] != "refuse"]
        assert granted == [], f"a forged release was decided {granted}"


# Tokens

UNAUTHENTICATED = Expect(status=401, fields={"code": "auth"})


@pytest.mark.requires("01a")
async def test_missing_session_token_401(k: KernelHarness, records):
    """A call naming a session but carrying no token, or an empty one, is 401 and ledgered on that
    session's Desk, and decides nothing."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    session_id = visitor.state.session_id
    before = await decision_ids(records, desk) if k.is_real else set()
    for missing in (Auth.none(), Auth.raw({"X-Session-Token": ""})):
        async with assert_ledgered(records, desk.copy, desk.desk_id, "auth", session_id=session_id):
            await k.call("POST /decide", body=decide_body(visitor, find_slots()), auth=missing, expect=UNAUTHENTICATED)
        async with assert_ledgered(records, desk.copy, desk.desk_id, "auth", session_id=session_id):
            await check_reply(k, Caller(visitor.name, visitor.state, missing), CLEAN_EN, expect=UNAUTHENTICATED)
        async with assert_ledgered(records, desk.copy, desk.desk_id, "auth", session_id=session_id):
            await k.call("GET /context/{session_id}?desk_id=", path={"session_id": session_id}, auth=missing,
                         expect=UNAUTHENTICATED)
    if k.is_real:
        assert await decision_ids(records, desk) == before, "a call with no token stored a decision"


@pytest.mark.requires("01a")
async def test_other_sessions_token_401_and_ledgered(k: KernelHarness, records):
    """Session A's id with session B's token is 401 on `/decide` and `/check_reply`, ledgered as
    `auth` on A's Desk with neither token nor its hash, and decides nothing."""
    desk = await golden_desk(k)
    a = await open_caller(k, desk, "visitor")
    b = await open_caller(k, desk, "visitor")
    a_with_bs_token = Caller(a.name, a.state, b.auth)
    tokens = {**token_secrets(a.auth.headers()["X-Session-Token"], "A's"),
              **token_secrets(b.auth.headers()["X-Session-Token"], "B's")}
    before = await decision_ids(records, desk) if k.is_real else set()
    async with assert_ledgered(records, desk.copy, desk.desk_id, "auth", session_id=a.state.session_id) as new:
        await k.call("POST /decide", body=decide_body(a, find_slots()), auth=b.auth, expect=UNAUTHENTICATED)
    assert_only_auth(new, tokens)
    async with assert_ledgered(records, desk.copy, desk.desk_id, "auth", session_id=a.state.session_id) as new:
        await check_reply(k, a_with_bs_token, CLEAN_EN, expect=UNAUTHENTICATED)
    assert_only_auth(new, tokens)
    if k.is_real:
        assert await decision_ids(records, desk) == before, "a call with another session's token stored a decision"


# Another copy's records

NOT_FOUND = Expect(status=404, fields={"code": "not_found"})


def session_token(caller: Caller) -> str:
    return caller.auth.headers()["X-Session-Token"]


@pytest.mark.requires("01a")
async def test_cross_copy_decision_access(k: KernelHarness, fake: FakeAnthropic, records):
    """Copy B's session can't read, execute or cancel copy A's decisions: B's token on A's decision
    is 401, and B's session naming A's decision is 404 `not_found`. Each attempt is ledgered as
    `auth` on the Desk of the session it names, holding nothing of the other copy's, and A's
    decisions stay as they were."""
    a = await golden_desk(k)
    b = await desk_of(k, await k.new_copy())
    a_visitor = await open_caller(k, a, "visitor")
    b_visitor = await open_caller(k, b, "visitor")
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))   # the reviewer passes, if the kernel asks it
    allowed = await decide(k, a_visitor, "native.find_slots", find_slots_args(),
                           expect=Expect(fields={"outcome": "allow", "state": "allowed"}))
    held = await decide(k, a_visitor, "native.quote", quote_args("drain", requested_discount_bp=8000),
                        expect=Expect(fields={"outcome": "hold", "state": "held"}))   # rv-quote allows no discount
    of_a = {**copy_secrets(a.copy, "A's"), **token_secrets(session_token(a_visitor), "A's session")}
    of_b = {**copy_secrets(b.copy, "B's"), **token_secrets(session_token(b_visitor), "B's session")}

    for decision in (allowed, held):   # a read names the decision's session, so it goes on A's ledger
        async with assert_ledgered(records, a.copy, a.desk_id, "auth", session_id=a_visitor.state.session_id) as new:
            await k.call("GET /decisions/{id}", path={"id": decision.decision_id}, auth=b_visitor.auth,
                         expect=UNAUTHENTICATED)
        assert_only_auth(new, of_b)
    b_session = b_visitor.state.session_id   # execute and cancel name B's session, so they go on B's ledger
    async with assert_ledgered(records, b.copy, b.desk_id, "auth", session_id=b_session) as new:
        await k.call("POST /execute", body={"decision_id": allowed.decision_id, "session_id": b_session,
                                            "generation": b_visitor.state.generation},
                     auth=b_visitor.auth, expect=NOT_FOUND)
    assert_only_auth(new, of_a)
    async with assert_ledgered(records, b.copy, b.desk_id, "auth", session_id=b_session) as new:
        await k.call("POST /decisions/{decision_id}/cancel", path={"decision_id": held.decision_id},
                     body={"session_id": b_session}, auth=b_visitor.auth, expect=NOT_FOUND)
    assert_only_auth(new, of_a)

    for decision, state in ((allowed, "allowed"), (held, "held")):   # nothing ran, and nothing was cancelled
        await k.call("GET /decisions/{id}", path={"id": decision.decision_id}, auth=a_visitor.auth,
                     expect=Expect(fields={"decision_id": decision.decision_id, "state": state}))


FIFTEEN_DAYS_S = 15 * 86400   # the seed's calendar runs 14 days from a copy's creation
STAND_IN_LATER_SLOT = "S-20261119-1000"   # the stub's stand-in for a slot of the copy made 15 days later


@pytest.mark.requires("01a")
async def test_decide_on_another_copys_resource_refused(k: KernelHarness, fake: FakeAnthropic, records):
    """A session on copy B can't book copy A's slot. Made 15 days apart, the copies share no slot
    id, so A's slot doesn't resolve in B's copy and the call is refused before it is normalized
    (`action` null). Nothing of A's changes, its ledger included, while A's own visitor can book
    that slot, so the refusal is the copy boundary and not a booking that never works."""
    b = await golden_desk(k)
    k.clock.advance(FIFTEEN_DAYS_S)
    a = await k.new_copy()
    a_desk = a.desk_ids[0]
    if k.is_real:
        upcoming = sorted((row for row in await records.calendar_slots(a.copy_id)
                           if row["desk_id"] == a_desk and row["starts_at"] > k.clock.now()),
                          key=lambda row: row["starts_at"])
        assert upcoming, "copy A's calendar has no upcoming slot"
        slot_id = upcoming[0]["slot_id"]
        b_slots = [row["slot_id"] for row in (await copy_rows(records, b, "calendar_slots"))["calendar_slots"]]
        assert slot_id not in b_slots, f"copy B's calendar has {slot_id} too, so the case tests nothing"
        a_before = {view: await getattr(records, view)(a.copy_id) for view in ("bookings", "decisions")}
    else:
        slot_id = STAND_IN_LATER_SLOT
    b_visitor = await open_caller(k, b, "visitor")   # a fresh session: one idle for 15 days is closed
    async with ledgered_during(records, a, a_desk) as on_a:
        await decide(k, b_visitor, "native.book", book_args(slot_id),
                     expect=Expect(fields={"outcome": "refuse", "state": "refused", "action": None}))
    if k.is_real:
        assert {view: await getattr(records, view)(a.copy_id) for view in a_before} == a_before, "copy A changed"
        assert on_a == [], f"copy B's call wrote on copy A's ledger: {[entry.event.kind for entry in on_a]}"
        booked = [row for row in await records.bookings(b.copy.copy_id) if row["slot_id"] == slot_id]
        assert booked == [], f"copy B booked copy A's slot: {booked}"
    a_visitor = await k.visitor(a)
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))   # the seed's booking cards are reviewed
    await decide(k, Caller("visitor", a_visitor.state, Auth.session(a_visitor)), "native.book", book_args(slot_id),
                 expect=Expect(fields={"outcome": {"$in": ["allow", "hold"]}, "action.copy_id": a.copy_id,
                                       "action.resource.id": {"$has": slot_id}}))


@pytest.mark.requires("01a")
async def test_shared_slot_id_books_only_the_callers_copy(k: KernelHarness, fake: FakeAnthropic, records):
    """Two copies made at once share the seed's slot ids. B's booking of one resolves in B's copy:
    the decision, its action and the booking are B's, and A's slot stays free."""
    a = await golden_desk(k)
    b = await desk_of(k, await k.new_copy())
    slot_id = b.slots["wk"].slot_id
    if k.is_real:
        assert a.slots["wk"].slot_id == slot_id, "copies made at once share the seed's slot ids"
        a_before = await copy_rows(records, a, "bookings", "decisions")
        b_before = await copy_rows(records, b, "bookings")
    b_visitor = await open_caller(k, b, "visitor")
    session_id = b_visitor.state.session_id
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))   # the seed's weekday booking card is reviewed
    async with ledgered_during(records, a.copy, a.desk_id) as on_a:
        decision = await decide(k, b_visitor, "native.book", book_args(slot_id), expect=Expect(fields={
            "outcome": {"$in": ["allow", "hold"]}, "session_id": session_id, "action.copy_id": b.copy.copy_id,
            "action.desk_id": b.desk_id, "action.session_id": session_id, "action.resource.kind": "slot",
            "action.resource.id": {"$has": slot_id},
        }))
        if decision.outcome == "allow":
            await k.call("POST /execute", body={"decision_id": decision.decision_id, "session_id": session_id,
                                                "generation": b_visitor.state.generation},
                         auth=b_visitor.auth, expect=Expect(fields={"state": "succeeded"}))
        else:
            await k.call("POST /approvals/{decision_id}/answer", path={"decision_id": decision.decision_id},
                         body={"answer": "allow_once"}, auth=b.owner,
                         expect=Expect(fields={"decision.state": "executed", "execution.state": "succeeded"}))
    if k.is_real:
        assert await copy_rows(records, a, "bookings", "decisions") == a_before, "copy A changed"
        assert on_a == [], f"copy B's booking wrote on copy A's ledger: {[entry.event.kind for entry in on_a]}"
        b_after = await copy_rows(records, b, "bookings", "decisions")
        booked = [row for row in b_after["bookings"] if row not in b_before["bookings"]]
        assert [row["slot_id"] for row in booked] == [slot_id], f"copy B's new bookings: {booked}"
        assert decision.decision_id in {row["decision_id"] for row in b_after["decisions"]}


@pytest.mark.requires("01a")
async def test_owner_token_of_another_copy_404(k: KernelHarness, fake: FakeAnthropic, records):
    """Copy B's owner token reaches nothing of copy A's: drafting rules for A's Desk, answering or
    reading A's held request and reading A's ledger are each 404 `not_found`. A's policy versions,
    decisions, approvals and bookings are unchanged, and A's ledger gains at most an `auth` entry
    per attempt, with its route and reason and nothing of B's: no token, token hash or id."""
    a = await golden_desk(k)
    b = await desk_of(k, await k.new_copy())
    a_visitor = await open_caller(k, a, "visitor")
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))   # the reviewer passes, if the kernel asks it
    held = await decide(k, a_visitor, "native.quote", quote_args("drain", requested_discount_bp=8000),
                        expect=Expect(fields={"outcome": "hold", "state": "held"}))   # rv-quote allows no discount
    any_discount = RuleCard(card_id="cross-copy-any-discount", applies_to="native.quote", mode="auto", who="anyone",
                            max_discount_bp=10_000, reason="Quotes at any discount, without asking.")
    draft = {"desk_id": a.desk_id, "cards": [any_discount.model_dump(mode="json")],
             "expected_parent": await active_version(k, a)}
    views = ("policy_versions", "decisions", "approvals", "bookings")
    a_before = await copy_rows(records, a, *views) if k.is_real else {}
    async with ledgered_during(records, a.copy, a.desk_id) as on_a:
        await k.call("POST /policy/draft", body=draft, auth=b.owner, expect=NOT_FOUND)
        await k.call("POST /approvals/{decision_id}/answer", path={"decision_id": held.decision_id},
                     body={"answer": "allow_once"}, auth=b.owner, expect=NOT_FOUND)
        await k.call("GET /decisions/{id}", path={"id": held.decision_id}, auth=b.owner, expect=NOT_FOUND)
        await k.call("GET /ledger/{desk_id}?verify=true", path={"desk_id": a.desk_id}, auth=b.owner, expect=NOT_FOUND)
    if k.is_real:
        assert await copy_rows(records, a, *views) == a_before, "copy B's owner changed copy A's records"
        assert len(on_a) <= 4, f"four attempts left {len(on_a)} entries on A's ledger"
        assert_only_auth(on_a, copy_secrets(b.copy, "B's"))
    await k.call("GET /decisions/{id}", path={"id": held.decision_id}, auth=a_visitor.auth,
                 expect=Expect(fields={"decision_id": held.decision_id, "state": "held"}))
    await k.call("GET /ledger/{desk_id}?verify=true", path={"desk_id": a.desk_id}, auth=a.owner,
                 expect=Expect(fields={"chain_ok": True, "first_bad_seq": None}))


# Generations and take-over

@pytest.mark.requires("01a")
async def test_stale_generation_409_and_ledgered(k: KernelHarness, records):
    """After the owner takes a session over and hands it back, work at the old generation is 409
    `stale_generation` on `/decide` and `/check_reply`, ledgered as `auth`, and decides nothing."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    old, session_id = visitor.state.generation, visitor.state.session_id
    for mode in ("owner", "ai"):   # the generation moves on twice, and the session answers again
        visitor.state = await set_mode(k, desk, visitor, mode)
    if k.is_real:
        assert visitor.state.generation > old, (old, visitor.state.generation)
    stale = Caller(visitor.name, visitor.state.model_copy(update={"generation": old}), visitor.auth)
    before = await decision_ids(records, desk) if k.is_real else set()
    stale_generation = Expect(status=409, fields={"code": "stale_generation"})
    async with assert_ledgered(records, desk.copy, desk.desk_id, "auth", session_id=session_id):
        await k.call("POST /decide", body=decide_body(stale, find_slots()), auth=visitor.auth, expect=stale_generation)
    async with assert_ledgered(records, desk.copy, desk.desk_id, "auth", session_id=session_id):
        await check_reply(k, stale, CLEAN_EN, expect=stale_generation)
    if k.is_real:
        assert await decision_ids(records, desk) == before, "work at an old generation stored a decision"


@pytest.mark.requires("01a")
async def test_decide_in_owner_mode_409(k: KernelHarness, records):
    """While the owner has the session, a call at its current generation is 409 `mode_owner`,
    ledgered as `auth`, and decides nothing."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    visitor.state = await set_mode(k, desk, visitor, "owner")
    before = await decision_ids(records, desk) if k.is_real else set()
    async with assert_ledgered(records, desk.copy, desk.desk_id, "auth", session_id=visitor.state.session_id):
        await k.call("POST /decide", body=decide_body(visitor, find_slots()), auth=visitor.auth,
                     expect=Expect(status=409, fields={"code": "mode_owner"}))
    if k.is_real:
        assert await decision_ids(records, desk) == before, "a call in owner mode stored a decision"


# The API's own ledger entries

REFUSED_4XX = Expect(any_of=[Expect(status=status) for status in (400, 401, 403, 404, 409, 422)])


def api_event(kind: str, *, session_id: str | None = None, origin: str = "api") -> dict[str, Any]:
    """A ledger event as the API would report one."""
    return {"kind": kind, "origin": origin, "session_id": session_id, "summary": {"note": "sent by the evals"}}


@pytest.mark.requires("01a")
async def test_ledger_append_only_api_kinds(k: KernelHarness, records):
    """The API appends only its own kinds: a `decide`, `approval` or `execute` entry from a
    visitor's session or the owner is refused (4xx) and nothing is appended in its name; a
    `session` entry sent as the kernel's is stored as `api`, reported rather than verified."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    session_id = visitor.state.session_id
    for auth, named in ((visitor.auth, session_id), (desk.owner, None)):
        for kind in ("decide", "approval", "execute"):   # the contract refuses these, so they go unvalidated
            body = {"desk_id": desk.desk_id, "event": api_event(kind, session_id=named)}
            async with ledgered_during(records, desk.copy, desk.desk_id) as new:
                await k.call("POST /ledger/append", raw_body=body, auth=auth, expect=REFUSED_4XX)
            assert_only_auth(new, {})
    entry = await k.call(
        "POST /ledger/append",
        raw_body={"desk_id": desk.desk_id, "event": api_event("session", session_id=session_id, origin="kernel")},
        auth=visitor.auth,
        expect=Expect(fields={"copy_id": desk.copy.copy_id, "desk_id": desk.desk_id, "event.kind": "session",
                              "event.origin": "api", "event.session_id": session_id}),
    )
    if k.is_real:
        stored = [e for e in await records.ledger_entries(desk.copy.copy_id, desk.desk_id) if e.seq == entry.seq]
        assert [(e.event.kind, e.event.origin) for e in stored] == [("session", "api")], stored


@pytest.mark.requires("01a")
async def test_ledger_append_cannot_name_another_session(k: KernelHarness, records):
    """An API entry names only the session that sent it and a Desk of its own: one naming another
    session, or another copy's Desk, is refused (4xx) and appended on neither copy's ledger."""
    a = await golden_desk(k)
    b = await desk_of(k, await k.new_copy())
    sender = await open_caller(k, a, "visitor")
    other = await open_caller(k, a, "visitor")
    attempts = (
        (sender.auth, a.desk_id, other.state.session_id),    # another session of its own Desk
        (sender.auth, b.desk_id, None),                      # another copy's Desk
        (a.owner, a.desk_id, sender.state.session_id),       # the owner, naming a visitor's session
        (a.owner, b.desk_id, None),                          # the owner, on another copy's Desk
    )
    for auth, desk_id, session_id in attempts:
        body = {"desk_id": desk_id, "event": api_event("session", session_id=session_id)}
        async with ledgered_during(records, a.copy, a.desk_id) as on_a, \
                ledgered_during(records, b.copy, b.desk_id) as on_b:
            await k.call("POST /ledger/append", body=body, auth=auth, expect=REFUSED_4XX)
        assert_only_auth(on_a, copy_secrets(b.copy, "B's"))
        assert_only_auth(on_b, copy_secrets(a.copy, "A's"))


# The Desk's switches

async def tools_given(k: KernelHarness, caller: Caller) -> list[str]:
    """The tools `/context` gives the caller's session now."""
    context = await k.call("GET /context/{session_id}?desk_id=", path={"session_id": caller.state.session_id},
                           auth=caller.auth)
    return [profile.tool for profile in context.tools]


@pytest.mark.requires("01b")
async def test_closed_session_after_desk_delete(k: KernelHarness, records):
    """Deleting a Desk closes its sessions: the visitor's next `/decide` is 409 `closed`, as are its
    draft and context read, and it decides nothing."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    before = await decision_ids(records, desk) if k.is_real else set()
    await k.call("DELETE /desks/{id}", path={"id": desk.desk_id}, auth=desk.owner, expect=Expect(status=204))
    closed = Expect(status=409, fields={"code": "closed"})
    await k.call("POST /decide", body=decide_body(visitor, find_slots()), auth=visitor.auth, expect=closed)
    await check_reply(k, visitor, CLEAN_EN, expect=closed)
    await k.call("GET /context/{session_id}?desk_id=", path={"session_id": visitor.state.session_id},
                 auth=visitor.auth, expect=closed)
    if k.is_real:
        assert await decision_ids(records, desk) == before, "a closed session's call stored a decision"


# With Answering off a visitor keeps lead capture and callback requests: the native ones, and the
# Rivera seed's urgent callback, `desk.emergency-callback`, which is given on `native.request_callback`.
ANSWERING_OFF_TOOLS = {"native.capture_lead", "native.request_callback", "desk.emergency-callback"}


@pytest.mark.requires("01b")
async def test_answering_off_limits_context(k: KernelHarness):
    """With the Desk's Answering switch off, a visitor is given only lead capture and a callback
    request, whether its session opened before the switch or after."""
    desk = await golden_desk(k)
    earlier = await open_caller(k, desk, "visitor")
    given = await tools_given(k, earlier)
    if k.is_real:
        assert "native.quote" in given, f"with Answering on, a visitor is given more: {given}"
    await k.call("PUT /desks/{id}/answering", path={"id": desk.desk_id}, body={"on": False}, auth=desk.owner,
                 expect=Expect(fields={"desk_id": desk.desk_id}))
    later = await open_caller(k, desk, "visitor")
    for visitor in (earlier, later):
        given = await tools_given(k, visitor)
        if k.is_real:
            assert set(given) <= ANSWERING_OFF_TOOLS, f"with Answering off, a visitor is given {given}"
