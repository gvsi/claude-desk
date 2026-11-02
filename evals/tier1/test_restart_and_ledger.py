"""Restart races, idempotency and ledger verification: what holds when the kernel dies or is raced.

An execution commits its intent row before any side effect. If the kernel dies after that (here a
`SimulatedCrash` from Plan 01a's `_after_intent` hook, which the kernel's handlers don't catch), a
restart leaves a fresh intent alone, so `/execute` can't run it twice, and reconciles one older
than 30 seconds exactly once, by what really happened. Racing answers, cancels and executions
settle on one outcome; two bookings of one slot leave one booking; a repeated `/decide` returns
the decision it made. The ledger verifies from its serialized page alone, with the evals' own
oracle and the kernel's `verify_chain` agreeing, names the edited entry when one is tampered with,
holds an entry for every decision, reply check and verification attempt, checkpoints its head every
50 entries, and is signed with the key `/health` reports.
"""

import asyncio
import copy
import hashlib
import json
import secrets
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from desk.contracts import ApprovalResult, Decision, ExecResult, LedgerEntry, LedgerPage
from desk.kernel_api import KernelError
from evals.fakes import FakeAnthropic, Json
from evals.oracles import canonical, verify_ledger_page
from evals.oracles.ledger import ENVELOPE
from evals.oracles.signatures import LEDGER_DOMAIN, key_id_of
from evals.tier1.args import book_args, find_slots_args, quote_args, release_document_args
from evals.tier1.golden_desk import REVIEW_PASS, REVIEWER_MODEL, Caller, GoldenDesk, decide, golden_desk, open_caller
from evals.tier1.harness import Auth, Expect, KernelHarness
from evals.tier1.targets import crash_after_intent, restart_kernel
from evals.tier1.test_approvals import (
    ALLOWED,
    CONFLICT,
    answer,
    cancel,
    fact_id_of,
    hold_quote,
    not_run,
    quotes_of,
    ran,
    read,
    replay_spent_approval,
    slot_bookings,
    verified_ledger,
)
from evals.tier1.test_reply_golden import (
    CLEAN_EN,
    NUMBER_PROSE,
    QUOTE_PROSE,
    check_reply,
    passes,
    signing_key,
    status_lined,
)
from evals.tier1.test_sessions import NOT_FOUND, assert_ledgered
from evals.tier1.test_verification import (
    CHECKPOINT_EVERY,
    DANA,
    INVALID,
    NOTHING_SENT,
    STRANGER,
    check,
    code_for,
    start,
    verified_as,
    wrong_codes,
)

ORPHAN_AFTER_S = 30   # Plan 01a's ORPHAN_AFTER: an intent younger than this may still be running


# Steps a case takes

async def allowed_booking(k: KernelHarness, fake: FakeAnthropic, caller: Caller, slot_id: str) -> Decision:
    """The caller's booking of a weekday slot, which the seed's reviewed `rv-book-wk` card allows
    once the reviewer passes it."""
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))
    caller.turn()
    decision = await decide(k, caller, "native.book", book_args(slot_id), expect=Expect(fields={
        "outcome": "allow", "state": "allowed", "session_id": caller.state.session_id,
        "action.resource.kind": "slot", "action.resource.id": {"$has": slot_id},
    }))
    assert decision.action is not None
    return decision


def execute_body(caller: Caller, decision: Decision) -> dict:
    """`/execute` for the caller's allow, at its session's generation."""
    return {"decision_id": decision.decision_id, "session_id": caller.state.session_id,
            "generation": caller.state.generation}


def unchanged(decision: Decision) -> Expect:
    """A read of the decision as it was: the same state, ledger entry and signature."""
    return Expect(fields={"decision_id": decision.decision_id, "state": decision.state,
                          "ledger_seq": decision.ledger_seq, "signature": decision.signature})


# A crash between the intent and the side effect

@pytest.mark.requires("01a")
async def test_crash_after_intent_leaves_a_fresh_intent_alone(k: KernelHarness, fake: FakeAnthropic, records):
    """The kernel dies after a booking's intent row is committed, before the booking, and restarts
    at once. The intent may still be running elsewhere, so the restart leaves it alone: the decision
    reads as it was, `allowed`, and `/execute` is 409 `conflict` (an intent with no result), so the
    booking can't run twice. Nothing was booked. The clock ticks, so a run too slow to finish
    within 30 seconds of the crash fails as too slow, not as the kernel's mistake."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    slot_id = desk.slots["wk"].slot_id
    allowed = await allowed_booking(k, fake, visitor, slot_id)
    crashed_at = k.clock.now()
    try:
        with crash_after_intent(k) as crash:
            await crash.call("POST /execute", body=execute_body(visitor, allowed), auth=visitor.auth)
        await restart_kernel(k)
        await k.call("GET /decisions/{id}", path={"id": allowed.decision_id}, auth=visitor.auth,
                     expect=unchanged(allowed))
        await k.call("POST /execute", body=execute_body(visitor, allowed), auth=visitor.auth, expect=CONFLICT)
        await k.call("GET /decisions/{id}", path={"id": allowed.decision_id}, auth=visitor.auth,
                     expect=unchanged(allowed))
    finally:   # replaces a read's failure when the intent had already aged into an orphan
        elapsed = (k.clock.now() - crashed_at).total_seconds()
        assert elapsed < ORPHAN_AFTER_S, (
            f"the run took {elapsed:.0f} s from the crash to its last read, too slow to test an intent younger "
            f"than {ORPHAN_AFTER_S} s")
    if k.is_real:
        assert await slot_bookings(records, desk, slot_id, status="confirmed") == [], \
            "a booking whose kernel died before it was booked"


@pytest.mark.requires("01a")
async def test_orphaned_intent_reconciles_once_after_the_window(k: KernelHarness, fake: FakeAnthropic, records):
    """The same crash, then a restart 31 seconds later: the intent is an orphan now, and the
    restart reconciles it by what happened. The crash came before the booking, so the decision is
    `failed`, never `allowed` again, and nothing is booked. `/execute` returns the stored failed
    result each time, and a second restart later changes nothing: it reconciled once."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    slot_id = desk.slots["wk"].slot_id
    allowed = await allowed_booking(k, fake, visitor, slot_id)
    with crash_after_intent(k) as crash:
        await crash.call("POST /execute", body=execute_body(visitor, allowed), auth=visitor.auth)
    k.clock.advance(ORPHAN_AFTER_S + 1)
    await restart_kernel(k)
    failed = Expect(fields={"decision_id": allowed.decision_id, "state": "failed"})
    await k.call("GET /decisions/{id}", path={"id": allowed.decision_id}, auth=visitor.auth, expect=failed)
    assert allowed.action is not None
    stored = Expect(fields={"action_id": allowed.action.action_id, "state": "failed", "facts": [], "model_view": {}})
    results = [await k.call("POST /execute", body=execute_body(visitor, allowed), auth=visitor.auth, expect=stored)
               for _ in range(2)]
    assert results[0] == results[1], "a repeated /execute didn't return the stored result"
    settled = await k.call("GET /decisions/{id}", path={"id": allowed.decision_id}, auth=visitor.auth, expect=failed)
    k.clock.advance(ORPHAN_AFTER_S + 1)
    await restart_kernel(k)
    await k.call("GET /decisions/{id}", path={"id": allowed.decision_id}, auth=visitor.auth, expect=unchanged(settled))
    if k.is_real:
        assert await slot_bookings(records, desk, slot_id, status="confirmed") == [], \
            "a booking whose kernel died before it was booked"


# Replays after a restart prove only state the database holds (`targets.restart_kernel`)

@pytest.mark.requires("01a")
async def test_spent_approval_refused_after_restart(k: KernelHarness, records):
    """A spent approval stays spent across a restart. Held quote A, allowed once, runs and consumes
    its approval; after the kernel restarts, replaying that approval in `/execute` for held quote B
    of the same session is 409 and runs nothing, so only A's quote ran and B is still held."""
    await replay_spent_approval(k, records, restart=True)


# Races settle on one outcome

@pytest.mark.requires("01a")
async def test_concurrent_answers_one_wins(k: KernelHarness, records):
    """The owner allows and denies one held quote at once (two tabs): one answer wins with 200, the
    other is 409, and the decision ends as the winner left it, with the quote run only if the
    allow won."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    held = await hold_quote(k, visitor)
    # Each answer is the winner or 409; the stub answers each with its first alternative.
    answers = await asyncio.gather(
        answer(k, desk, held, "allow_once", expect=Expect(any_of=[ran(held), CONFLICT])),
        answer(k, desk, held, "deny_once", expect=Expect(any_of=[CONFLICT, not_run(held, "denied")])),
    )
    won = [result for result in answers if isinstance(result, ApprovalResult)]
    assert len(won) == 1, f"{len(won)} of two racing answers won"
    state = won[0].decision.state
    await read(k, desk.owner, held, state)
    if k.is_real:
        rows = await quotes_of(records, desk, visitor)
        assert len(rows) == (1 if state == "executed" else 0), f"the {state} decision ran {len(rows)} quotes"


@pytest.mark.requires("01a")
async def test_answer_races_cancel(k: KernelHarness, records):
    """The owner allows a held quote as the visitor cancels it: exactly one wins, so the decision
    is `executed` with its one quote, or `cancelled` with none, and the other call is 409."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    held = await hold_quote(k, visitor)
    cancelled = Expect(fields={"decision_id": held.decision_id, "state": "cancelled"})
    answered, withdrawn = await asyncio.gather(
        answer(k, desk, held, "allow_once", expect=Expect(any_of=[ran(held), CONFLICT])),
        cancel(k, visitor, held, expect=Expect(any_of=[CONFLICT, cancelled])),
    )
    states = [result.decision.state if isinstance(result, ApprovalResult) else result.state
              for result in (answered, withdrawn) if not isinstance(result, KernelError)]
    assert states in (["executed"], ["cancelled"]), f"the racing answer and cancel left {states}"
    await read(k, visitor.auth, held, states[0])
    if k.is_real:
        rows = await quotes_of(records, desk, visitor)
        assert len(rows) == (1 if states == ["executed"] else 0), f"the {states[0]} decision ran {len(rows)} quotes"


@pytest.mark.requires("01a")
async def test_concurrent_execute_is_idempotent(k: KernelHarness, records):
    """Two `/execute` calls for one allowed quote at once (a retry racing the original): it runs
    once. Each call gets the stored result or 409 `conflict` while the other runs, at least one
    succeeds, every result is the same, a later call returns it again, and there is one quote."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    allowed = await decide(k, visitor, "native.quote", quote_args("drain"), expect=ALLOWED)
    succeeded = Expect(fields={"state": "succeeded"})
    racing = await asyncio.gather(*[
        k.call("POST /execute", body=execute_body(visitor, allowed), auth=visitor.auth,
               expect=Expect(any_of=[succeeded, CONFLICT]))
        for _ in range(2)
    ])
    results = [result for result in racing if isinstance(result, ExecResult)]
    assert results, "neither racing /execute ran the quote"
    results.append(await k.call("POST /execute", body=execute_body(visitor, allowed), auth=visitor.auth,
                                expect=succeeded))
    assert all(result == results[0] for result in results), "the executions returned different results"
    await read(k, visitor.auth, allowed, "executed")
    if k.is_real:
        rows = await quotes_of(records, desk, visitor)
        assert len(rows) == 1, f"one allow, executed concurrently, ran {len(rows)} quotes"


@pytest.mark.requires("01a")
async def test_one_booking_per_slot_under_race(k: KernelHarness, fake: FakeAnthropic, records):
    """Two visitors are each allowed the same free slot, then execute at once: one booking
    succeeds and the other fails with nothing written for it (the slot was taken), so the slot
    has one confirmed booking and each decision ends as its execution did."""
    desk = await golden_desk(k)
    slot_id = desk.slots["wk"].slot_id
    visitors = [await open_caller(k, desk, "visitor") for _ in range(2)]
    allowed = [await allowed_booking(k, fake, visitor, slot_id) for visitor in visitors]
    succeeded = Expect(fields={"state": "succeeded"})
    failed = Expect(fields={"state": "failed", "facts": [], "model_view": {}})   # nothing written for it
    # Each booking succeeds or fails; the stub answers each with its first alternative.
    results = await asyncio.gather(*[
        k.call("POST /execute", body=execute_body(visitor, decision), auth=visitor.auth, expect=Expect(any_of=order))
        for visitor, decision, order in zip(visitors, allowed, ([succeeded, failed], [failed, succeeded]), strict=True)
    ])
    states = [result.state for result in results]
    assert sorted(states) == ["failed", "succeeded"], f"two bookings of one slot ended {states}"
    for visitor, decision, result in zip(visitors, allowed, results, strict=True):
        await read(k, visitor.auth, decision, "executed" if result.state == "succeeded" else "failed")
    if k.is_real:
        booked = await slot_bookings(records, desk, slot_id, status="confirmed")
        assert len(booked) == 1, f"the slot has {len(booked)} confirmed bookings"


# A call is decided once

@pytest.mark.requires("01a")
async def test_decide_is_idempotent_per_call(k: KernelHarness, records):
    """A `/decide` repeated with the same session, generation, call id and call (its args in any
    key order) returns the original decision and stores no other; the same call id with another
    tool or other args is 409 `conflict`. `by_call` recovers the decision, as the API does after a
    lost response, and a call id never sent is 404."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    session_id, generation = visitor.state.session_id, visitor.state.generation
    call_id = f"restart-{secrets.token_hex(6)}"
    args = quote_args("drain", requested_discount_bp=0)
    call = {"call_id": call_id, "tool": "native.quote", "args": args}
    body = {"session_id": session_id, "generation": generation, "call": call}
    first = await k.call("POST /decide", body=body, auth=visitor.auth,
                         expect=Expect(fields={**ALLOWED.fields, "session_id": session_id, "call_id": call_id}))
    original = unchanged(first)
    reordered = {**call, "args": dict(reversed(list(args.items())))}
    for again in (call, reordered):
        await k.call("POST /decide", body={**body, "call": again}, auth=visitor.auth, expect=original)
    another_tool = {**call, "tool": "native.find_slots", "args": find_slots_args()}
    for other in (another_tool, {**call, "args": quote_args("heater")}):
        await k.call("POST /decide", body={**body, "call": other}, auth=visitor.auth, expect=CONFLICT)
    by_call = "GET /decisions/by_call?session_id=&generation=&call_id="
    named = {"session_id": session_id, "generation": generation}
    await k.call(by_call, query={**named, "call_id": call_id}, auth=visitor.auth, expect=original)
    await k.call(by_call, query={**named, "call_id": f"restart-{secrets.token_hex(6)}"}, auth=visitor.auth,
                 expect=NOT_FOUND)
    if k.is_real:
        stored = [row["decision_id"] for row in await records.decisions(desk.copy.copy_id)
                  if row["session_id"] == session_id]
        assert stored == [first.decision_id], f"one call id stored the decisions {stored}"


# The ledger verifies from its page alone

async def thin_slice_ledger(k: KernelHarness) -> tuple[GoldenDesk, LedgerPage]:
    """The Friday thin slice (a held quote, allowed once and run, then a reply citing it) and the
    Desk's ledger page as its owner reads it, which the kernel says verifies."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    held = await hold_quote(k, visitor)
    answered = await answer(k, desk, held, "allow_once", expect=ran(held))
    quote = fact_id_of(k, answered.execution, "quote")
    await check_reply(k, visitor, QUOTE_PROSE, [{"template": "quote", "fact_id": quote}],
                      expect=passes(visitor, ["prose", "quote"]))
    page = await k.call("GET /ledger/{desk_id}?verify=true", path={"desk_id": desk.desk_id}, auth=desk.owner,
                        expect=Expect(fields={"chain_ok": True, "first_bad_seq": None}))
    return desk, page


def kernel_verdict(entries: list[dict[str, Any]], key: str) -> tuple[bool, int | None]:
    """What the kernel's own verifier (`desk_kernel.verify_chain`) says of the entries: the
    cross-check on the evals' oracle, never the verdict. Real kernel only."""
    import desk_kernel   # kernel code, imported only where a real kernel runs

    verdict = json.loads(desk_kernel.verify_chain(json.dumps(entries), key))
    return verdict["ok"], verdict["first_bad_seq"]


def both_verdicts(
    page: dict[str, Any], key: str, desk: GoldenDesk
) -> tuple[tuple[bool, int | None], tuple[bool, int | None]]:
    """The evals' check of a serialized page (`verify_ledger_page`, bound to the Desk it was read
    for) and the kernel's of its entries."""
    check = verify_ledger_page(page, key, copy_id=desk.copy.copy_id, desk_id=desk.desk_id)
    return (check.ok, check.first_bad_seq), kernel_verdict(page["entries"], key)


@pytest.mark.requires("01a")
async def test_serialized_ledger_verifies_without_the_database(k: KernelHarness, tmp_path: Path):
    """The thin slice's ledger page, written to a file and read back as JSON, verifies with nothing
    but the file and `/health`'s key: the evals' oracle recomputes every hash, link and signature,
    and agrees with the page's `chain_ok` and with the kernel's own `verify_chain`."""
    desk, page = await thin_slice_ledger(k)
    saved = tmp_path / "ledger-page.json"
    saved.write_text(page.model_dump_json())
    if k.is_real:
        read_back = assert_saved_page_verifies(saved, await signing_key(k), desk)
        kinds = {entry["event"]["kind"] for entry in read_back["entries"]}
        assert {"decide", "approval", "execute", "reply"} <= kinds, f"the slice's ledger has only {sorted(kinds)}"


def assert_saved_page_verifies(saved: Path, key: str, desk: GoldenDesk) -> dict[str, Any]:
    """A ledger page read back from its file verifies: it is still a whole `LedgerPage`, and the
    evals' check (bound to the Desk), the kernel's `verify_chain` and the page's own claim all say
    the chain holds. Returns the page as read."""
    read_back = json.loads(saved.read_text())
    LedgerPage.model_validate(read_back)
    claimed = (read_back["chain_ok"], read_back["first_bad_seq"])
    ours, kernels = both_verdicts(read_back, key, desk)
    assert ours == kernels == claimed == (True, None), (
        f"the page claims {claimed}, the evals' check says {ours}, the kernel's verify_chain {kernels}")
    return read_back


def edited(page: dict[str, Any], index: int) -> dict[str, Any]:
    """The page with one entry's summary edited after it was signed."""
    tampered = copy.deepcopy(page)
    event = tampered["entries"][index]["event"]
    event["summary"] = {**event["summary"], "edited_by": "the evals"}
    return tampered


def dropped(page: dict[str, Any], index: int) -> dict[str, Any]:
    """The page with one entry taken out."""
    tampered = copy.deepcopy(page)
    del tampered["entries"][index]
    return tampered


def forged(page: dict[str, Any], index: int, key: Ed25519PrivateKey) -> dict[str, Any]:
    """The page with one entry edited, then hashed again and signed with another key under that
    key's id, as someone without the kernel's key would forge it."""
    tampered = edited(page, index)
    entry = tampered["entries"][index]
    digest = hashlib.sha256(canonical({field: entry[field] for field in ENVELOPE})).digest()
    public_key_hex = key.public_key().public_bytes_raw().hex()
    entry.update(hash=digest.hex(), signature=key.sign(LEDGER_DOMAIN + digest).hex(),
                 key_id=key_id_of(public_key_hex))
    return tampered


@pytest.mark.requires("01a")
async def test_tampered_ledger_is_detected(k: KernelHarness):
    """Tampering with the thin slice's serialized ledger is caught by the evals' oracle and the
    kernel's `verify_chain` alike, at the same entry: an edited first, middle or last entry is
    named by its seq; a dropped entry fails at the one after it; an entry forged with another key
    fails at that entry; and the page checked against another key fails at its first entry. A
    dropped last entry leaves the page's head naming it, so the page check fails (`verify_chain`
    reads entries alone)."""
    desk, page = await thin_slice_ledger(k)
    if k.is_real:
        assert_tampering_is_caught(page.model_dump(mode="json"), await signing_key(k), desk)


def assert_tampering_is_caught(page: dict[str, Any], key: str, desk: GoldenDesk) -> None:
    """Each tampering of a verifying page fails both checks at the same entry (see
    `test_tampered_ledger_is_detected`); a page of fewer than three entries can't show it."""
    ids = {"copy_id": desk.copy.copy_id, "desk_id": desk.desk_id}
    assert both_verdicts(page, key, desk) == ((True, None),) * 2, "the page doesn't verify before it is tampered with"
    seqs = [entry["seq"] for entry in page["entries"]]
    assert len(seqs) >= 3, f"the ledger has {len(seqs)} entries, too few to tamper with in the middle"
    middle, last = len(seqs) // 2, len(seqs) - 1
    def fails_at(index: int) -> tuple[tuple[bool, int], tuple[bool, int]]:
        return (False, seqs[index]), (False, seqs[index])

    for index in (0, middle, last):
        assert both_verdicts(edited(page, index), key, desk) == fails_at(index), f"entry {seqs[index]} edited"
    assert both_verdicts(dropped(page, middle), key, desk) == fails_at(middle + 1), f"entry {seqs[middle]} dropped"
    assert not verify_ledger_page(dropped(page, last), key, **ids).ok, "the page passes with its last entry dropped"
    other = Ed25519PrivateKey.generate()
    assert both_verdicts(forged(page, middle, other), key, desk) == fails_at(middle), f"entry {seqs[middle]} forged"
    other_hex = other.public_key().public_bytes_raw().hex()
    assert both_verdicts(page, other_hex, desk) == fails_at(0), "the page checked against another key"


# Every attempt is ledgered

def assert_names(entries: dict[int, LedgerEntry], seq: int, kind: str, named: str, what: str) -> None:
    """The ledger entry at `seq` is a `kind` entry naming `named` (by its ref or in its summary)."""
    entry = entries.get(seq)
    found = entry.event.kind if entry else "no entry"
    assert entry is not None and found == kind, f"{what} points at ledger entry {seq}, which is {found}, not {kind}"
    assert named in json.dumps(entry.event.model_dump(mode="json")), f"{what}'s {kind} entry {seq} doesn't name it"


@pytest.mark.requires("01a")
async def test_every_decision_reply_and_verification_attempt_is_ledgered(k: KernelHarness, records):
    """Each decision, allowed, held or refused, points at the `decide` entry that names it, and
    each reply verdict, passed or handed off, at the `reply` entry that names its message. Once
    Plan 01b has landed, each verification attempt writes a `verify` entry for its session: a
    start for a contact nobody has, a start for Dana, a wrong code and the right one."""
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    decisions = [
        await decide(k, visitor, "native.quote", quote_args("drain"), expect=ALLOWED),
        await hold_quote(k, visitor),
        await decide(k, visitor, "native.release_document", release_document_args(desk.documents["dana-invoice"]),
                     expect=Expect(fields={"outcome": "refuse", "state": "refused", "action": None})),
    ]
    verdicts = [
        await check_reply(k, visitor, CLEAN_EN, expect=passes(visitor, ["prose"])),
        # the quote above is held for the owner, so a blocked reply shows the status line, not the call-back offer
        await check_reply(k, visitor, NUMBER_PROSE, expect=status_lined(visitor, "number_in_prose")),
    ]
    if k.landed("01b"):
        caller = await open_caller(k, desk, "visitor")

        def ledgered_verify() -> Any:
            return assert_ledgered(records, desk.copy, desk.desk_id, "verify", session_id=caller.state.session_id)

        async with ledgered_verify():
            await start(k, caller, STRANGER, expect=NOTHING_SENT)
        async with ledgered_verify():
            started = await start(k, caller, DANA, expect=Expect(fields={"inbox": {"$len": 1}}))
        code = await code_for(k, caller, started.inbox[0])
        async with ledgered_verify():
            await check(k, caller, wrong_codes(code, 1)[0], expect=INVALID)
        async with ledgered_verify():
            await check(k, caller, code, expect=verified_as(caller))
    page = await verified_ledger(k, desk)
    if k.is_real:
        entries = {entry.seq: entry for entry in page.entries}
        for decision in decisions:
            what = f"the {decision.state} decision"
            assert_names(entries, decision.ledger_seq, "decide", decision.decision_id, what)
        for verdict in verdicts:
            what = f"the {'passed' if verdict.ok else 'handed-off'} reply verdict"
            assert_names(entries, verdict.ledger_seq, "reply", verdict.message_id, what)


# Head checkpoints and the signing key

async def append_until(k: KernelHarness, records: Any, desk: GoldenDesk, seq: int) -> None:
    """Entries the owner reports (`POST /ledger/append`) until the Desk's ledger reaches entry
    `seq` (the kernel's own entries, checkpoints included, count too). On the stub, one entry is
    contract-checked."""
    event = {"kind": "session", "origin": "api", "session_id": None, "summary": {"note": "an entry from the evals"}}
    appended = Expect(fields={"desk_id": desk.desk_id, "event.kind": "session", "event.origin": "api"})
    while True:
        count = 1
        if k.is_real:
            entries = await records.ledger_entries(desk.copy.copy_id, desk.desk_id)
            count = seq - (entries[-1].seq if entries else 0)
        if count <= 0:
            return
        for _ in range(count):
            await k.call("POST /ledger/append", body={"desk_id": desk.desk_id, "event": event}, auth=desk.owner,
                         expect=appended)
        if not k.is_real:
            return


def checkpointed(entry: LedgerEntry, hashes: dict[int, str]) -> set[int]:
    """The entries a `head_checkpoint` entry names: the one whose hash its event holds or its
    `prev_hash` links (it is appended right after the head it checkpoints, in that head's
    transaction), and any `checkpoint_seq` its summary gives."""
    event = json.dumps(entry.event.model_dump(mode="json"))
    named = {seq for seq, digest in hashes.items() if digest in event or digest == entry.prev_hash}
    checkpoint_seq = entry.event.summary.get("checkpoint_seq")
    if type(checkpoint_seq) is int:
        named.add(checkpoint_seq)
    return named


@pytest.mark.requires("01a")
async def test_head_checkpoint_every_fifty_entries(k: KernelHarness, records):
    """The kernel checkpoints the Desk's ledger head every 50 entries: with the ledger past entry
    100, its `head_checkpoint` entries name exactly the 50th and the 100th entries' hashes, each
    written by the kernel just after that entry. Once Plan 01b has landed, the owner's Demo inbox
    holds a checkpoint naming each of those hashes."""
    desk = await golden_desk(k)
    await append_until(k, records, desk, 2 * CHECKPOINT_EVERY)
    page = await verified_ledger(k, desk)
    hashes = {entry.seq: entry.hash for entry in page.entries}
    if k.is_real:
        checkpoints = [entry for entry in page.entries if entry.event.kind == "head_checkpoint"]
        named = [checkpointed(entry, hashes) for entry in checkpoints]
        wanted = [{CHECKPOINT_EVERY}, {2 * CHECKPOINT_EVERY}]
        assert named == wanted, f"the head_checkpoint entries {[e.seq for e in checkpoints]} name the entries {named}"
        for entry, [seq] in zip(checkpoints, named, strict=True):
            assert (entry.event.origin, entry.seq) == ("kernel", seq + 1), (
                f"the checkpoint of entry {seq} is entry {entry.seq} from {entry.event.origin}, not the kernel's next")
    if k.landed("01b"):
        inbox = await k.call("GET /demo_inbox", auth=desk.owner)
        if k.is_real:
            bodies = [entry.body for entry in inbox if entry.kind == "head_checkpoint"]
            for seq in (CHECKPOINT_EVERY, 2 * CHECKPOINT_EVERY):
                held = any(hashes[seq] in body for body in bodies)
                assert held, f"no head checkpoint in the owner's Demo inbox names entry {seq}'s hash"


@pytest.mark.requires("01a")
async def test_health_key_matches_the_ledger_key(k: KernelHarness):
    """`/health` reports the key the ledger is signed with: under `DESK_ENV=test` with no seed it is
    the development key, and says so; its `key_id` is the first 16 hex characters of the key's
    sha256; the Desk's ledger page names the same key and id, every entry is signed under that id
    and verifies with it. A restart keeps the key, so the ledger written before it still verifies."""
    health = await k.call("GET /health", auth=Auth.none(), expect=Expect(fields={"dev_signing_key": True}))
    desk = await golden_desk(k)
    same_key = {"public_key_hex": health.public_key_hex, "key_id": health.key_id}
    page = await k.call("GET /ledger/{desk_id}?verify=true", path={"desk_id": desk.desk_id}, auth=desk.owner,
                        expect=Expect(fields={"chain_ok": True, **same_key}))
    if k.is_real:
        assert health.key_id == key_id_of(health.public_key_hex), "/health's key_id isn't its key's"
        signed_under = {entry.key_id for entry in page.entries}
        assert signed_under == {health.key_id}, f"the ledger is signed under {signed_under}"
        check = verify_ledger_page(page, health.public_key_hex, copy_id=desk.copy.copy_id, desk_id=desk.desk_id)
        assert check.ok, f"the ledger fails the evals' check at entry {check.first_bad_seq}: {check.reason}"
    await restart_kernel(k)
    await k.call("GET /health", auth=Auth.none(), expect=Expect(fields={"dev_signing_key": True, **same_key}))
    await verified_ledger(k, desk)
