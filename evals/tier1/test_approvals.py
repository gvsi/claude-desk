"""Approvals, expiry and generation fencing: a held request runs once, as asked, while it still may.

The owner answers a held request (`POST /approvals/{decision_id}/answer`). `allow_once` and
`allow_person` run it inside the answer call as the held session, never as the owner, even while
the owner has taken the session over or the breaker has paused it; `deny_once` and `deny_always`
close it; and `allow_person` and `deny_always` draft the card the owner would confirm next.
`deny_always` is offered only where the tool itself was held, by an `ask` card or the compiler's
default ask; a request an `auto` card's limit held keeps the tool, so it isn't offered. A
decision is answered at most once, within its 24 hours and before the visitor cancels it. An allow
runs within 60 seconds, at the generation it was decided at. An answer re-checks the current rules
first, so a request they no longer allow, or one whose Desk was deleted, is refused at execution.
An approval binds one decision: replayed on another, it runs nothing.

On the real kernel each case also reads what ran (`kernel_ro.quotes`, `bookings`, `facts`), and
signatures and the ledger are judged by the evals' own oracles against `/health`'s key.
"""

import json
import re
from typing import Any

import pytest

from desk.contracts import ApprovalResult, Decision, ExecResult, Fact, LedgerEntry, RuleCard
from evals.fakes import FakeAnthropic, Json
from evals.oracles import (
    card_amount_problems,
    scan_visible,
    verify_decision_sig,
    verify_ledger_page,
    verify_verdict_sig,
)
from evals.tier1.args import book_args, quote_args
from evals.tier1.golden_desk import (
    REVIEW_PASS,
    REVIEWER_MODEL,
    P,
    SEED_TITLES,
    Caller,
    CallerName,
    GoldenDesk,
    confirm_cards,
    decide,
    golden_desk,
    make_quote,
    open_caller,
    quote_expiries,
    session_row,
)
from evals.tier1.harness import Expect, KernelHarness
from evals.tier1.targets import restart_kernel
from evals.tier1.test_reply_golden import QUOTE_PROSE, check_reply, handed_off, passes, set_mode, signing_key
from evals.tier1.test_sessions import NOT_FOUND, assert_ledgered, ledgered_during, session_token

HOLD_DISCOUNT_BP = 8_000   # a discount the seed's rv-quote card (list price only) holds for the owner
HOLD_CENTS = P - P * HOLD_DISCOUNT_BP // 10_000   # the held drain quote's amount: 3600
PERSON_DISCOUNT_BP = 3_000   # Dana's held quote: 30% off
PERSON_CENTS = P - P * PERSON_DISCOUNT_BP // 10_000   # 12600
HOLD_LIFE_S = 24 * 3600   # a held request expires 24 hours after it was decided
ALLOW_LIFE_S = 60         # an allow, 60 seconds after

ALLOWED = Expect(fields={"outcome": "allow", "state": "allowed"})
HELD = Expect(fields={"outcome": "hold", "state": "held"})
CONFLICT = Expect(status=409, fields={"code": "conflict"})   # a decision not in the state the call needs

BOOKING_PROSE = "Here is your booking."
ASK_BOOK = RuleCard(card_id="a-ask-book", applies_to="native.book", mode="ask", who="anyone",
                    reason="Mike confirms every booking.")
NEVER_QUOTE = RuleCard(card_id="a-never-quote", applies_to="native.quote", mode="never", who="anyone",
                       reason="No quotes here for now.")
FIND_SLOTS_CARD = RuleCard(card_id="a-auto-find-slots", applies_to="native.find_slots", mode="auto", who="anyone",
                           reason="Anyone can see open times.")
# The stub's stand-ins for a fresh copy's next open slots (the seed's weekday slots, `S-<yyyymmdd>-<hhmm>`).
STAND_IN_SLOTS = [f"S-202611{day:02d}-{hour:02d}00" for day in (4, 5) for hour in (8, 10, 12, 14, 16)]
EMAIL = re.compile(r"[^\s@\"']+@[^\s@\"']+")   # any address-shaped token: a contact, masked or not
MIN_CLAIM = 8   # owner-only text shorter than this could be a word a booking shows anyway


# Steps a case takes

async def hold_quote(
    k: KernelHarness, caller: Caller, discount_bp: int = HOLD_DISCOUNT_BP, *, answers: Any = None
) -> Decision:
    """A drain clearing quote at `discount_bp`, which the seed's no-discount rv-quote card holds for
    the owner: the decision names the caller's session and the price list's amounts, and offers
    `allow_once` (or what `answers` matches)."""
    caller.turn()
    session_id = caller.state.session_id
    return await decide(k, caller, "native.quote", quote_args("drain", requested_discount_bp=discount_bp),
                        expect=Expect(fields={
                            **HELD.fields, "session_id": session_id, "action.session_id": session_id,
                            "action.tool": "native.quote", "action.list_cents": P, "action.discount_bp": discount_bp,
                            "action.amount_cents": P - P * discount_bp // 10_000,
                            "answers": {"$has": "allow_once"} if answers is None else answers,
                        }))


async def book(k: KernelHarness, caller: Caller, slot_id: str, *, expect: Expect) -> Decision:
    """The caller's booking of a slot, decided."""
    caller.turn()
    return await decide(k, caller, "native.book", book_args(slot_id), expect=expect)


async def upcoming_slots(k: KernelHarness, records: Any, desk: GoldenDesk, n: int) -> list[str]:
    """The ids of the Desk's next `n` slots after now (`kernel_ro.calendar_slots`); on the stub, stand-ins."""
    if not k.is_real:
        return STAND_IN_SLOTS[:n]
    rows = sorted((row for row in await records.calendar_slots(desk.copy.copy_id)
                   if row["desk_id"] == desk.desk_id and row["starts_at"] > k.clock.now()),
                  key=lambda row: row["starts_at"])
    assert len(rows) >= n, f"the Desk has {len(rows)} upcoming slots, and the case books {n}"
    return [row["slot_id"] for row in rows[:n]]


async def answer(
    k: KernelHarness, desk: GoldenDesk, decision: Decision, given: str, *, expect: Expect
) -> ApprovalResult:
    """The owner's answer to a held request."""
    return await k.call("POST /approvals/{decision_id}/answer", path={"decision_id": decision.decision_id},
                        body={"answer": given}, auth=desk.owner, expect=expect)


def ran(decision: Decision) -> Expect:
    """An answer that ran the held request inside the call: executed, and succeeded."""
    return Expect(fields={"decision.decision_id": decision.decision_id, "decision.state": "executed",
                          "execution.state": "succeeded"})


def not_run(decision: Decision, state: str) -> Expect:
    """An answer that closed the held request in `state` without running it."""
    return Expect(fields={"decision.decision_id": decision.decision_id, "decision.state": state, "execution": None})


def never_drafted(decision: Decision, who: str, person_id: str | None = None, *, tool: str) -> Expect:
    """A `deny_always` answer: the request denied, not run, and one `never` card drafted for its tool."""
    return Expect(fields={
        **not_run(decision, "denied").fields, "card_diff": {"$len": 1}, "card_diff.0.mode": "never",
        "card_diff.0.applies_to": tool, "card_diff.0.who": who,
        "card_diff.0.person_id": person_id, "card_diff.0.agent_key_id": None, "card_diff.0.is_default": False,
    })


async def read(k: KernelHarness, auth: Any, decision: Decision, state: str) -> Decision:
    """`GET /decisions/{id}`, which applies lazy expiry: the decision must be in `state`."""
    return await k.call("GET /decisions/{id}", path={"id": decision.decision_id}, auth=auth,
                        expect=Expect(fields={"decision_id": decision.decision_id, "state": state}))


async def execute(
    k: KernelHarness, caller: Caller, decision: Decision, *, generation: int | None = None, expect: Expect
) -> ExecResult:
    """The caller runs an allow, at its session's generation unless given."""
    body = {"decision_id": decision.decision_id, "session_id": caller.state.session_id,
            "generation": caller.state.generation if generation is None else generation}
    return await k.call("POST /execute", body=body, auth=caller.auth, expect=expect)


async def cancel(k: KernelHarness, caller: Caller, decision: Decision, *, expect: Expect) -> Decision:
    """The visitor cancels a held request of its own session."""
    return await k.call("POST /decisions/{decision_id}/cancel", path={"decision_id": decision.decision_id},
                        body={"session_id": caller.state.session_id}, auth=caller.auth, expect=expect)


def fact_id_of(k: KernelHarness, execution: ExecResult | None, kind: str) -> str:
    """The id of the one `kind` fact an execution wrote; on the stub, a stand-in shaped like the kernel's."""
    if not k.is_real:
        return f"{kind}:stub-{kind}"
    assert execution is not None, "the request didn't run"
    found = [fact.fact_id for fact in execution.facts if fact.kind == kind]
    assert len(found) == 1, f"the execution wrote {len(found)} {kind} facts: {[f.fact_id for f in execution.facts]}"
    return found[0]


def ran_execution(answered: ApprovalResult) -> ExecResult:
    """The execution an answer ran (real kernel only)."""
    assert answered.execution is not None, f"the answer ran nothing: the decision is {answered.decision.state}"
    return answered.execution


def fact_in(answered: ApprovalResult, fact_id: str) -> Fact:
    """The fact with this id among those the answer's execution wrote (real kernel only)."""
    [fact] = [fact for fact in ran_execution(answered).facts if fact.fact_id == fact_id]
    return fact


async def approvals_of(records: Any, desk: GoldenDesk, *decisions: Decision) -> list[dict[str, Any]]:
    """The approval rows the given decisions have, one or more (`kernel_ro.approvals`; real kernel only)."""
    ids = {decision.decision_id for decision in decisions}
    return [row for row in await records.approvals(desk.copy.copy_id) if row["decision_id"] in ids]


async def approval_of(k: KernelHarness, records: Any, desk: GoldenDesk, decision: Decision) -> str:
    """The id of the one approval of a decision, spent (`kernel_ro.approvals`); on the stub, a stand-in."""
    if not k.is_real:
        return "stub-approval"
    rows = await approvals_of(records, desk, decision)
    assert len(rows) == 1, f"decision {decision.decision_id} has {len(rows)} approvals"
    assert rows[0]["consumed_at"] is not None, "the approval that ran the request isn't spent"
    return rows[0]["approval_id"]


async def slot_bookings(
    records: Any, desk: GoldenDesk, slot_id: str, *, status: str | None = None
) -> list[dict[str, Any]]:
    """The Desk's `kernel_ro.bookings` rows for one slot, only those in `status` when given (real
    kernel only). The one booking filter the approval and restart cases share."""
    return [row for row in await records.bookings(desk.copy.copy_id)
            if row["desk_id"] == desk.desk_id and row["slot_id"] == slot_id
            and (status is None or row["status"] == status)]


async def quotes_of(records: Any, desk: GoldenDesk, caller: Caller) -> list[dict[str, Any]]:
    """The quotes run in the caller's session (`kernel_ro.quotes`; real kernel only)."""
    return [row for row in await records.quotes(desk.copy.copy_id)
            if row["desk_id"] == desk.desk_id and row["session_id"] == caller.state.session_id]


async def unreadable(records: Any, desk: GoldenDesk, caller: Caller, decision: Decision) -> dict[str, str]:
    """What the caller's session may not read, by label (real kernel only): the owner's token and
    session, the caller's own token, other sessions', people's and documents' ids, masked contacts
    and notes on record, other sessions' quote ids, the ids of facts it can't read and the text of
    facts no session can, and the decision's owner-facing reason."""
    copy_id, session_id = desk.copy.copy_id, caller.state.session_id
    readable = {"public", f"session:{session_id}"}
    values = {
        "the owner token": desk.copy.owner_token, "the owner session's id": desk.copy.owner_session.session_id,
        "the session's own token": session_token(caller), "the decision's owner-facing reason": decision.reason_plain,
    }
    values.update({f"{name}'s person id": person_id for name, person_id in desk.people.items()})
    values.update({f"document {ref}'s id": document_id for ref, document_id in desk.documents.items()})
    for n, row in enumerate(await records.people(copy_id)):
        values[f"person {n}'s masked contact"] = row["masked_contact"]
        if len(row["notes"] or "") >= MIN_CLAIM:
            values[f"person {n}'s notes"] = row["notes"]
    others = [row["session_id"] for row in await records.sessions(copy_id) if row["session_id"] != session_id]
    values.update({f"another session's id ({n})": other for n, other in enumerate(others)})
    values.update({f"another session's quote id ({n})": row["quote_id"] for n, row in enumerate(
        row for row in await records.quotes(copy_id) if row["session_id"] != session_id)})
    for fact in await records.facts(copy_id):
        if fact["desk_id"] != desk.desk_id or readable & set(fact["readers"]):
            continue
        values[f"fact {fact['fact_id']}'s id"] = fact["fact_id"]
        if not any(reader.startswith("session:") for reader in fact["readers"]):   # owner or person only
            values.update({f"a claim of fact {fact['fact_id']}": claim["value"] for claim in fact["claims"]
                           if claim["kind"] in ("text", "ref") and len(str(claim["value"])) >= MIN_CLAIM})
    return {label: value for label, value in values.items() if value}


def leaked(text: str, forbidden: dict[str, str]) -> list[str]:
    """The labels of the forbidden values `text` holds as a whole token, with no letter or digit
    touching it (so `Q-1` isn't found in `Q-10`); a failure names labels, never values."""
    return [label for label, value in forbidden.items()
            if re.search(rf"(?<![0-9A-Za-z]){re.escape(value)}(?![0-9A-Za-z])", text)]


def naming(entries: list[LedgerEntry], decision: Decision) -> list[LedgerEntry]:
    """The entries about `decision`: its id is the entry's `ref_id`, or a whole token of its summary."""
    decision_id = {"the decision": decision.decision_id}
    return [entry for entry in entries if entry.event.ref_id == decision.decision_id
            or leaked(json.dumps(entry.event.summary), decision_id)]


def held_quote_card_problems(block: Any, expires: list[str]) -> list[str]:
    """How the slice's quote card departs from the held quote, read where the visitor reads it
    (`card_amount_problems`): its title is the held total in US dollars, its title and lines show
    no amount but that total and the drain's list price, no percentage but the held discount, and
    no date but the quote's own expiry, one of `expires` (`quote_expiries`)."""
    return card_amount_problems(block, {HOLD_CENTS, P}, headline=HOLD_CENTS, percents=[HOLD_DISCOUNT_BP // 100],
                                items=[SEED_TITLES["drain"]], expires=expires)


async def verified_ledger(k: KernelHarness, desk: GoldenDesk) -> Any:
    """The Desk's ledger as its owner reads it: the kernel says the chain holds, and on the real
    kernel the evals' own check of the page agrees, against `/health`'s key, with every entry this
    copy's and this Desk's."""
    page = await k.call("GET /ledger/{desk_id}?verify=true", path={"desk_id": desk.desk_id}, auth=desk.owner,
                        expect=Expect(fields={"chain_ok": True, "first_bad_seq": None}))
    if k.is_real:
        check = verify_ledger_page(page, await signing_key(k), copy_id=desk.copy.copy_id, desk_id=desk.desk_id)
        assert check.ok, f"the evals' check of the ledger page fails at entry {check.first_bad_seq}: {check.reason}"
    return page


# The thin slice

@pytest.mark.requires("01a")
async def test_thin_slice_quote_hold_approve_execute_receipt_ledger(k: KernelHarness, records):
    """The Friday thin slice as one kernel test: a visitor's quote at 80% off holds for the owner,
    who allows it once; it runs inside the answer and leaves a quote fact the visitor's reply cites
    in a quote card; the decision's and the reply's receipts are signed, and the Desk's ledger
    verifies with the evals' own check."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    session_id = visitor.state.session_id
    made_from = k.clock.now()
    held = await hold_quote(k, visitor)
    answered = await answer(k, desk, held, "allow_once", expect=Expect(fields={
        **ran(held).fields, "decision.session_id": session_id, "card_diff": None,
    }))
    made_until = k.clock.now()   # the quote was made in between, which pins its expiry
    quote = fact_id_of(k, answered.execution, "quote")
    verdict = await check_reply(k, visitor, QUOTE_PROSE, [{"template": "quote", "fact_id": quote}],
                                expect=passes(visitor, ["prose", "quote"]))
    page = await verified_ledger(k, desk)

    if k.is_real:
        key = await signing_key(k)
        for decision in (held, answered.decision):
            assert verify_decision_sig(session_id, decision, key), f"the {decision.state} decision's signature"
        assert verify_verdict_sig(session_id, verdict, key), "the reply verdict's signature"
        fact = fact_in(answered, quote)
        assert f"session:{session_id}" in fact.label.readers, f"the quote fact's readers: {fact.label.readers}"
        totals = [claim.value for claim in fact.claims if claim.kind == "money" and claim.key == "total"]
        assert totals == [HOLD_CENTS], f"the quote fact's totals {totals}, expected {HOLD_CENTS} cents"
        problems = held_quote_card_problems(verdict.blocks[1], quote_expiries(made_from, made_until, "en"))
        assert not problems, f"the quote card, {HOLD_CENTS} cents off a list of {P}: {problems}"
        receipts = (held.visitor_plain, answered.decision.visitor_plain, verdict.visitor_plain)
        hits = [(text, hit.kind, hit.span) for text in receipts for hit in scan_visible(text)]
        assert hits == [], f"the receipts carry amounts or dates: {hits}"
        kinds = {entry.event.kind for entry in page.entries if entry.seq >= held.ledger_seq}
        missing = {"decide", "approval", "execute", "reply"} - kinds
        assert not missing, f"the ledger has no {sorted(missing)} entry for the slice; it has {sorted(kinds)}"
        rows = [(row["discount_bp"], row["amount_cents"]) for row in await quotes_of(records, desk, visitor)]
        assert rows == [(HOLD_DISCOUNT_BP, HOLD_CENTS)], f"the session's quotes: {rows}"


# Each held request is answered once, in time

@pytest.mark.requires("01a")
async def test_second_answer_409_and_one_execution(k: KernelHarness, records):
    """Once a held request ran, any second answer is 409 and ledgered as `approval`, and the
    request ran once: the decision stays executed, with one quote."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    held = await hold_quote(k, visitor)
    await answer(k, desk, held, "allow_once", expect=ran(held))
    for again in ("allow_once", "deny_once"):
        async with assert_ledgered(records, desk.copy, desk.desk_id, "approval"):
            await answer(k, desk, held, again, expect=CONFLICT)
    await read(k, visitor.auth, held, "executed")
    if k.is_real:
        rows = await quotes_of(records, desk, visitor)
        assert len(rows) == 1, f"one approval ran {len(rows)} quotes"


@pytest.mark.requires("01a")
async def test_answer_after_expiry(k: KernelHarness, records):
    """A held request lasts 24 hours: an answer a second later is 409 and ledgered, nothing runs,
    and the decision reads `expired` (read by the owner, since the visitor's session has closed)."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    held = await hold_quote(k, visitor)
    k.clock.advance(HOLD_LIFE_S + 1)
    async with assert_ledgered(records, desk.copy, desk.desk_id, "approval"):
        await answer(k, desk, held, "allow_once", expect=CONFLICT)
    await read(k, desk.owner, held, "expired")
    if k.is_real:
        assert await quotes_of(records, desk, visitor) == [], "an expired request ran"


@pytest.mark.requires("01a")
async def test_answer_after_cancel(k: KernelHarness, records):
    """A visitor who cancels a held request ends it: the owner's answer afterwards is 409 and
    ledgered, nothing runs, and the decision stays `cancelled`."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    held = await hold_quote(k, visitor)
    await cancel(k, visitor, held, expect=Expect(fields={"decision_id": held.decision_id, "state": "cancelled"}))
    async with assert_ledgered(records, desk.copy, desk.desk_id, "approval"):
        await answer(k, desk, held, "allow_once", expect=CONFLICT)
    await read(k, visitor.auth, held, "cancelled")
    if k.is_real:
        assert await quotes_of(records, desk, visitor) == [], "a cancelled request ran"


@pytest.mark.requires("01a")
async def test_cancel_after_execution_409(k: KernelHarness, records):
    """A request the owner allowed has run, so the visitor can't cancel it: 409, and it stays
    `executed`, with its one quote."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    held = await hold_quote(k, visitor)
    await answer(k, desk, held, "allow_once", expect=ran(held))
    await cancel(k, visitor, held, expect=CONFLICT)
    await read(k, visitor.auth, held, "executed")
    if k.is_real:
        rows = await quotes_of(records, desk, visitor)
        assert len(rows) == 1, f"the request ran {len(rows)} quotes"


# Allows run within a minute, at their generation

@pytest.mark.requires("01a")
async def test_allow_expires_after_sixty_seconds(k: KernelHarness, records):
    """An allow runs within 60 seconds of its decision: two quotes at list price are allowed at
    once, the first runs at +55 s, and the second at +61 s is 409, runs nothing and reads `expired`.
    The control runs five seconds inside the minute so the real time a slow runner spends between the
    two executes can't push it past the boundary and fail the case for no real reason."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    early, late = [await decide(k, visitor, "native.quote", quote_args("drain"), expect=ALLOWED) for _ in range(2)]
    k.clock.advance(ALLOW_LIFE_S - 5)
    await execute(k, visitor, early, expect=Expect(fields={"state": "succeeded"}))   # the control: still in time
    k.clock.advance(6)
    await execute(k, visitor, late, expect=CONFLICT)
    await read(k, visitor.auth, late, "expired")
    if k.is_real:
        rows = await quotes_of(records, desk, visitor)
        assert len(rows) == 1, f"two allows, one in time, ran {len(rows)} quotes"


@pytest.mark.requires("01a")
async def test_allow_at_old_generation_expires(k: KernelHarness, records):
    """The owner takes the session over between an allow and its execution: the allow, run at the
    generation it was decided at, is 409 `stale_generation`, ledgered as `auth`, runs nothing and
    reads `expired`."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    allowed = await decide(k, visitor, "native.quote", quote_args("drain"), expect=ALLOWED)
    taken = await set_mode(k, desk, visitor, "owner")
    if k.is_real:
        assert taken.generation > visitor.state.generation, (visitor.state.generation, taken.generation)
    async with assert_ledgered(records, desk.copy, desk.desk_id, "auth", session_id=visitor.state.session_id):
        await execute(k, visitor, allowed, expect=Expect(status=409, fields={"code": "stale_generation"}))
    await read(k, desk.owner, allowed, "expired")
    if k.is_real:
        assert await quotes_of(records, desk, visitor) == [], "an allow from an old generation ran"


# An approved hold runs whatever the session's mode, as the held session

@pytest.mark.requires("01a")
async def test_approved_hold_executes_during_take_over(k: KernelHarness, records):
    """A take-over doesn't cancel a held request: approved while the owner has the session, it runs
    inside the answer, for the held session, and the session stays the owner's."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    held = await hold_quote(k, visitor)
    taken = await set_mode(k, desk, visitor, "owner")
    answered = await answer(k, desk, held, "allow_once", expect=ran(held))
    quote = fact_id_of(k, answered.execution, "quote")
    if k.is_real:
        fact = fact_in(answered, quote)
        assert f"session:{visitor.state.session_id}" in fact.label.readers, fact.label.readers
        row = await session_row(records, desk, visitor)
        assert (row["mode"], row["generation"]) == ("owner", taken.generation), (row["mode"], row["generation"])
        assert len(await quotes_of(records, desk, visitor)) == 1


@pytest.mark.requires("01a")
async def test_approved_hold_executes_during_breaker_pause(k: KernelHarness, fake: FakeAnthropic, records):
    """A breaker pause doesn't cancel a held request: three `block` recommendations hold three
    quotes and pause the session, and the first, approved, runs inside the answer, with the session
    still paused."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    await confirm_cards(k, desk, [
        RuleCard(card_id="a-auto-quote-reviewed", applies_to="native.quote", mode="auto", who="anyone", review=True,
                 reason="Quotes at list price, checked by the reviewer."),
    ])
    block = Json({**REVIEW_PASS, "recommendation": "block"})
    fake.script(REVIEWER_MODEL, block, block, block)   # a fourth reviewer call is unscripted and fails the case
    blocked = [await decide(k, visitor, "native.quote", quote_args("drain"), expect=HELD) for _ in range(3)]
    await k.call("GET /whoami", auth=visitor.auth, expect=Expect(fields={
        "session.session_id": visitor.state.session_id, "session.mode": "paused"}))
    answered = await answer(k, desk, blocked[0], "allow_once", expect=ran(blocked[0]))
    fact_id_of(k, answered.execution, "quote")
    if k.is_real:
        assert (await session_row(records, desk, visitor))["mode"] == "paused", "the answer resumed the session"
        assert len(await quotes_of(records, desk, visitor)) == 1


@pytest.mark.requires("01a")
async def test_approved_hold_runs_as_the_held_session(k: KernelHarness, records):
    """A booking held under an `ask` card runs, once approved, as the visitor's session and never as
    the owner: its facts are labelled for the owner and that session, its booking names no person,
    and what Claude reads of it (`model_view`) holds no contact, no other session's, person's or
    document's id, and nothing only the owner may read. The held session can cite the booking;
    another session citing it gets `unentitled_fact`."""
    desk = await golden_desk(k)
    other = await open_caller(k, desk, "visitor")
    await make_quote(k, desk, other, "drain")   # another session's quote, with a fact the held session can't read
    await confirm_cards(k, desk, [ASK_BOOK])
    visitor = await open_caller(k, desk, "visitor")
    session_id, slot_id = visitor.state.session_id, desk.slots["wk"].slot_id
    held = await decide(k, visitor, "native.book", book_args(slot_id), expect=Expect(fields={
        **HELD.fields, "action.session_id": session_id, "action.resource.kind": "slot",
        "action.resource.id": {"$has": slot_id}, "answers": {"$has": "allow_once"},
    }))
    answered = await answer(k, desk, held, "allow_once", expect=ran(held))
    booking = fact_id_of(k, answered.execution, "booking")
    if k.is_real:
        execution = ran_execution(answered)
        labels = [sorted(fact.label.readers) for fact in execution.facts]
        assert labels and all(readers == ["owner", f"session:{session_id}"] for readers in labels), labels
        view = json.dumps(execution.model_view, ensure_ascii=False)
        assert not EMAIL.search(view), "model_view holds an email address"
        leaks = leaked(view, await unreadable(records, desk, visitor, held))
        assert not leaks, f"model_view holds {leaks}"
        booked = [row["person_id"] for row in await slot_bookings(records, desk, slot_id)]
        assert booked == [None], f"the slot's bookings name the people {booked}"
    cited = [{"template": "booking_confirmed", "fact_id": booking}]
    await check_reply(k, visitor, BOOKING_PROSE, cited, expect=passes(visitor, ["prose", "booking_confirmed"]))
    await check_reply(k, other, BOOKING_PROSE, cited, expect=handed_off(other, "unentitled_fact"))


# What the owner may answer, and the cards an answer drafts

@pytest.mark.requires("01a")
async def test_allow_person_only_for_verified_or_agent(k: KernelHarness, records):
    """`allow_person` drafts a card for one person or agent, so an unverified visitor's held
    request doesn't offer it, and answering with it is 422 before anything runs: the request stays
    held. Once Plan 01b has landed, Dana's held request offers it; once Plan 01c has, an agent's."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    held = await hold_quote(k, visitor, answers={"$has": "allow_once", "$not": {"$has": "allow_person"}})
    await answer(k, desk, held, "allow_person", expect=Expect(status=422, fields={"code": "invalid"}))
    await read(k, visitor.auth, held, "held")
    if k.is_real:
        assert await quotes_of(records, desk, visitor) == [], "a refused answer ran the request"
    offered: tuple[tuple[CallerName, str], ...] = (("dana", "01b"), ("agent", "01c"))
    for name, plan in offered:
        if k.landed(plan):
            await hold_quote(k, await open_caller(k, desk, name), answers={"$has": "allow_person"})


@pytest.mark.requires("01a")
async def test_policy_changed_before_answer_rules_changed(k: KernelHarness, records):
    """An answer re-checks the current rules: after the owner confirms a `never` card for quotes,
    allowing an earlier held quote is refused at execution, "rules changed", and nothing runs."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    held = await hold_quote(k, visitor)
    await confirm_cards(k, desk, [NEVER_QUOTE])
    refused = await answer(k, desk, held, "allow_once", expect=not_run(held, "refused_at_execution"))
    await read(k, desk.owner, held, "refused_at_execution")
    if k.is_real:
        said = {"reason_plain": refused.decision.reason_plain, "visitor_plain": refused.decision.visitor_plain}
        assert any("rules changed" in text.lower() for text in said.values()), f"neither says rules changed: {said}"
        assert await quotes_of(records, desk, visitor) == [], "a request the rules now refuse ran"


@pytest.mark.requires("01a")
async def test_deny_always_drafts_a_never_card(k: KernelHarness, records):
    """A request held because its tool itself asks (a `native.book` ask card for anyone) offers
    `deny_always`, which closes it without running it and drafts one `never` card for that tool,
    for the owner to confirm: scoped to anyone for an unverified visitor, and, once Plan 01b has
    landed, to Dana alone for her verified session."""
    desk = await golden_desk(k)
    await confirm_cards(k, desk, [ASK_BOOK])
    slots = iter(await upcoming_slots(k, records, desk, 2))
    tool_held = Expect(fields={**HELD.fields, "answers": {"$has": "deny_always"}})
    visitor = await open_caller(k, desk, "visitor")
    slot_id = next(slots)
    held = await book(k, visitor, slot_id, expect=tool_held)
    await answer(k, desk, held, "deny_always", expect=never_drafted(held, "anyone", tool="native.book"))
    await read(k, visitor.auth, held, "denied")
    if k.is_real:
        assert await slot_bookings(records, desk, slot_id) == [], "a denied request ran"
    if k.landed("01b"):
        dana = await open_caller(k, desk, "dana")
        held = await book(k, dana, next(slots), expect=tool_held)
        await answer(k, desk, held, "deny_always",
                     expect=never_drafted(held, "person", desk.people["dana"], tool="native.book"))


@pytest.mark.requires("01a")
async def test_limit_hold_offers_no_deny_always(k: KernelHarness, records):
    """A request held by an `auto` card's limit, not by its tool, offers no `deny_always`: the
    discount quote the seed's rv-quote card (list price only) holds through its hold twin lists
    `allow_once` without it, answering `deny_always` is 422 before anything runs, the request stays
    held with no approval written, and a later `allow_once` still runs it."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    held = await hold_quote(k, visitor, answers={"$has": "allow_once", "$not": {"$has": "deny_always"}})
    await answer(k, desk, held, "deny_always", expect=Expect(status=422, fields={"code": "invalid"}))
    await read(k, visitor.auth, held, "held")
    if k.is_real:
        assert await quotes_of(records, desk, visitor) == [], "a refused answer ran the request"
        assert await approvals_of(records, desk, held) == [], "a refused deny_always wrote an approval"
    await answer(k, desk, held, "allow_once", expect=ran(held))   # the hold still stands, so an allow runs it
    await read(k, visitor.auth, held, "executed")
    if k.is_real:
        assert len(await quotes_of(records, desk, visitor)) == 1, "the later allow_once didn't run the quote"


# Approvals and signatures bind one decision

MADE_UP_APPROVAL = "ap-made-up-000000"
CONFLICT_OR_NOT_FOUND = Expect(any_of=[CONFLICT, NOT_FOUND])


async def assert_never_runs(
    k: KernelHarness, records: Any, desk: GoldenDesk, caller: Caller, decision: Decision, state: str
) -> None:
    """Executing a decision that was never allowed is refused and leaves it untouched: `/execute`
    with the generation (no approval) is 409 `conflict` and ledgered, by a new entry whose `ref_id`
    or summary names the decision, a made-up `approval_id` is 409 or 404, and the decision stays
    in `state`. The decision is read first, so a lazy expiry, whose entry names it too, is ledgered
    before the refused `/execute` and only the refusal's own entry can name it in that window."""
    await read(k, caller.auth, decision, state)
    async with ledgered_during(records, desk.copy, desk.desk_id) as new:
        await execute(k, caller, decision, expect=CONFLICT)
    if k.is_real:
        kinds = [entry.event.kind for entry in new]
        assert naming(new, decision), f"refusing to execute a {state} decision ledgered nothing naming it: {kinds}"
    made_up = {"decision_id": decision.decision_id, "session_id": caller.state.session_id,
               "approval_id": MADE_UP_APPROVAL}
    await k.call("POST /execute", body=made_up, auth=caller.auth, expect=CONFLICT_OR_NOT_FOUND)
    await read(k, caller.auth, decision, state)


@pytest.mark.requires("01a")
async def test_held_decision_never_runs_without_its_approval(k: KernelHarness, records):
    """Nothing runs on an owner approval that isn't there. A visitor's held quote, a denied one, a
    cancelled one and an expired one each refuse `/execute` with the generation (409 `conflict`,
    ledgered naming the decision) and with a made-up `approval_id` (409 or 404), and stay as they
    were. No quote runs throughout, and the held, cancelled and expired quotes have no approval."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    held = await hold_quote(k, visitor)
    denied = await hold_quote(k, visitor, discount_bp=7_000)
    await answer(k, desk, denied, "deny_once", expect=not_run(denied, "denied"))
    cancelled = await hold_quote(k, visitor, discount_bp=6_000)
    await cancel(k, visitor, cancelled,
                 expect=Expect(fields={"decision_id": cancelled.decision_id, "state": "cancelled"}))
    expiring = await hold_quote(k, visitor, discount_bp=5_000)

    for decision, state in ((held, "held"), (denied, "denied"), (cancelled, "cancelled")):
        await assert_never_runs(k, records, desk, visitor, decision, state)

    # A held request lasts 24 h; reading the session's context partway keeps it open, so the expired
    # decision is refused as expired, not as a closed session.
    k.clock.advance(HOLD_LIFE_S // 2)
    await k.call("GET /context/{session_id}?desk_id=", path={"session_id": visitor.state.session_id},
                 auth=visitor.auth)
    k.clock.advance(HOLD_LIFE_S // 2 + 1)
    await assert_never_runs(k, records, desk, visitor, expiring, "expired")

    if k.is_real:
        assert await quotes_of(records, desk, visitor) == [], "a request with no approval ran a quote"
        # The denied quote isn't checked: `approvals` has an `answer` column, and Plan 01a's answer
        # task doesn't say whether a denial records one there.
        for decision in (held, cancelled, expiring):
            assert await approvals_of(records, desk, decision) == [], "a refused execute wrote an approval"


async def replay_spent_approval(k: KernelHarness, records: Any, *, restart: bool) -> None:
    """Held quote A, allowed once, runs and spends its approval; with `restart`, the kernel then
    restarts. Replaying A's approval in `/execute` for held quote B of the same session is 409 and
    runs nothing: B stays held, A executed, and only A's quote ran."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    a = await hold_quote(k, visitor)
    b = await hold_quote(k, visitor, discount_bp=1_500)
    await answer(k, desk, a, "allow_once", expect=ran(a))
    approval_id = await approval_of(k, records, desk, a)
    if restart:
        await restart_kernel(k)
    await k.call("POST /execute", body={"decision_id": b.decision_id, "session_id": visitor.state.session_id,
                                        "approval_id": approval_id}, auth=visitor.auth, expect=CONFLICT)
    await read(k, visitor.auth, b, "held")
    await read(k, visitor.auth, a, "executed")
    if k.is_real:
        rows = [row["discount_bp"] for row in await quotes_of(records, desk, visitor)]
        after = " after a restart" if restart else ""
        assert rows == [HOLD_DISCOUNT_BP], f"the spent approval ran quotes{after} with discounts {rows}, not A's alone"


@pytest.mark.requires("01a")
async def test_replayed_approval_id_refused(k: KernelHarness, records):
    """An approval is single use and bound to its decision: the approval that ran held quote A,
    replayed in `/execute` for held quote B of the same session, is 409, and B stays held with
    nothing run."""
    await replay_spent_approval(k, records, restart=False)


@pytest.mark.requires("01a")
async def test_decision_signatures_follow_each_state(k: KernelHarness, records):
    """Each state change re-signs the decision at a new ledger entry: the held and the executed
    decision each verify with `/health`'s key, at different `ledger_seq`s naming a `decide` and an
    `execute` entry, and a later read returns the executed signature. The check bites: the held
    signature doesn't cover the executed state, and no signature covers another session."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    other = await open_caller(k, desk, "visitor")
    held = await hold_quote(k, visitor)
    executed = (await answer(k, desk, held, "allow_once", expect=ran(held))).decision
    again = await read(k, visitor.auth, held, "executed")
    if k.is_real:
        key, session_id = await signing_key(k), visitor.state.session_id
        for decision in (held, executed, again):
            assert verify_decision_sig(session_id, decision, key), f"the {decision.state} decision's signature"
        assert executed.ledger_seq > held.ledger_seq, (held.ledger_seq, executed.ledger_seq)
        assert (again.ledger_seq, again.signature) == (executed.ledger_seq, executed.signature)
        resigned = {**executed.model_dump(mode="json"), "signature": held.signature}
        assert not verify_decision_sig(session_id, resigned, key), "the held signature covers the executed state"
        assert not verify_decision_sig(other.state.session_id, executed, key), "the signature covers another session"
        entries = {entry.seq: entry for entry in await records.ledger_entries(desk.copy.copy_id, desk.desk_id)}
        for decision, kind in ((held, "decide"), (executed, "execute")):
            entry = entries.get(decision.ledger_seq)
            assert entry is not None and entry.event.kind == kind, f"the {decision.state} decision's entry: {entry}"
            named = held.decision_id in json.dumps(entry.event.model_dump(mode="json"))
            assert named, f"the {kind} entry at {decision.ledger_seq} doesn't name the decision"


# Person cards and a deleted Desk (Plan 01b)

@pytest.mark.requires("01b")
async def test_allow_person_drafts_a_person_card(k: KernelHarness):
    """`allow_person` on verified Dana's held 30%-off quote runs it and drafts one `auto` card for
    her alone, no wider than what the owner just approved: her quotes up to this amount and
    discount, any hour, without the reviewer."""
    desk = await golden_desk(k)
    dana = await open_caller(k, desk, "dana")
    held = await hold_quote(k, dana, PERSON_DISCOUNT_BP, answers={"$has": "allow_person"})
    answered = await answer(k, desk, held, "allow_person", expect=Expect(fields={
        **ran(held).fields, "card_diff": {"$len": 1}, "card_diff.0.applies_to": "native.quote",
        "card_diff.0.mode": "auto", "card_diff.0.who": "person", "card_diff.0.person_id": desk.people["dana"],
        "card_diff.0.agent_key_id": None, "card_diff.0.max_amount_cents": PERSON_CENTS,
        "card_diff.0.max_discount_bp": PERSON_DISCOUNT_BP, "card_diff.0.hours": None, "card_diff.0.review": False,
        "card_diff.0.is_default": False,
    }))
    if k.is_real:
        assert held.action is not None and answered.card_diff
        assert answered.card_diff[0].max_amount_cents == held.action.amount_cents, "the card is wider than the request"


@pytest.mark.requires("01b")
async def test_others_still_hold_after_allow_person_or_deny_always(k: KernelHarness, records):
    """A card for one person leaves everyone else asking. With no card on `native.book`, Dana's
    booking holds; after `allow_person` and its card confirmed, Dana's next booking is allowed but a
    visitor's still holds, not refused. Likewise after Bob's `deny_always`: Bob's next booking is
    refused, a visitor's still holds."""
    desk = await golden_desk(k)
    slots = iter(await upcoming_slots(k, records, desk, 6))
    cards = [FIND_SLOTS_CARD]   # no card on native.book: it falls to the compiler's default ask
    version = await confirm_cards(k, desk, cards)
    if k.is_real:
        defaults = [card.card_id for card in version.cards if card.is_default and card.applies_to == "native.book"]
        assert defaults, f"the confirmed version has no default ask for native.book: {version.cards}"
    visitor = await open_caller(k, desk, "visitor")

    dana = await open_caller(k, desk, "dana")
    held = await book(k, dana, next(slots), expect=Expect(fields={**HELD.fields, "answers": {"$has": "allow_person"}}))
    allowed = await answer(k, desk, held, "allow_person", expect=Expect(fields={
        **ran(held).fields, "card_diff": {"$len": 1}, "card_diff.0.applies_to": "native.book",
        "card_diff.0.mode": "auto", "card_diff.0.who": "person", "card_diff.0.person_id": desk.people["dana"],
    }))
    cards += allowed.card_diff or []
    await confirm_cards(k, desk, cards)
    await book(k, visitor, next(slots), expect=HELD)
    await book(k, dana, next(slots), expect=ALLOWED)   # the card is in force

    bob = await open_caller(k, desk, "bob")
    held = await book(k, bob, next(slots), expect=Expect(fields={**HELD.fields, "answers": {"$has": "deny_always"}}))
    denied = await answer(k, desk, held, "deny_always",
                          expect=never_drafted(held, "person", desk.people["bob"], tool="native.book"))
    cards += denied.card_diff or []
    await confirm_cards(k, desk, cards)
    await book(k, visitor, next(slots), expect=HELD)
    await book(k, bob, next(slots), expect=Expect(fields={"outcome": "refuse", "state": "refused"}))   # in force


@pytest.mark.requires("01b")
async def test_desk_deleted_before_answer_never_executes(k: KernelHarness, records):
    """A held request whose Desk the owner deleted can't run: allowing it afterwards is refused at
    execution, with nothing run."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    held = await hold_quote(k, visitor)
    await k.call("DELETE /desks/{id}", path={"id": desk.desk_id}, auth=desk.owner, expect=Expect(status=204))
    await answer(k, desk, held, "allow_once", expect=not_run(held, "refused_at_execution"))
    if k.is_real:
        assert await quotes_of(records, desk, visitor) == [], "a deleted Desk's request ran"
