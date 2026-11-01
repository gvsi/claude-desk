"""The approval cases' own checks, without a kernel: what a session may not read in `model_view`,
how a leak is found, and the rows a case reads (its facts, approvals and upcoming slots)."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest

from desk.contracts import CopyCreated, ExecResult, Fact, Label, LedgerEntry, RenderedBlock, SessionState
from desk.kernel_api import KernelError
from evals.tier1.golden_desk import Caller, GoldenDesk
from evals.tier1.harness import Auth, TravelClock
from evals.tier1.test_approvals import (
    EMAIL,
    approval_of,
    approvals_of,
    assert_never_runs,
    fact_id_of,
    held_quote_card_problems,
    leaked,
    naming,
    unreadable,
    upcoming_slots,
)

COPY, DESK, OTHER_DESK = "c-1", "d-1", "d-2"
OWN, OTHER = "s-own-1111", "s-other-2222"
NOW = datetime(2026, 11, 3, 18, 0, tzinfo=UTC)


def state(session_id: str, kind: str = "visitor") -> SessionState:
    return SessionState(session_id=session_id, kind=kind, verified=False, assurance="none", mode="ai", generation=0)


DESK_OF_THE_CASE = GoldenDesk(
    copy=CopyCreated(copy_id=COPY, desk_ids=[DESK], owner_session=state("s-owner-3333", "owner"),
                     owner_token="owner-token-4444"),
    desk_id=DESK, slug="turner-plumbing-abc123", prices={}, slots={},
    people={"dana": "p-dana-5555", "bob": "p-bob-6666"}, documents={"dana-invoice": "doc-7777"}, charges={},
)
CALLER = Caller("visitor", state(OWN), Auth.raw({"X-Session-Token": "own-token-8888"}))
DECISION = SimpleNamespace(reason_plain="A visitor asked to book Wednesday. Mike confirms every booking.")


class Views:
    """Records holding a few `kernel_ro` views, whatever copy is asked for."""

    def __init__(self, **views: list[dict[str, Any]]) -> None:
        self.views = views

    def __getattr__(self, view: str) -> Any:
        if view.startswith("__"):
            raise AttributeError(view)

        async def rows(copy_id: str) -> list[dict[str, Any]]:
            return self.views.get(view, [])

        return rows


def fact(fact_id: str, readers: list[str], *claims: tuple[str, str, Any], desk_id: str = DESK) -> dict[str, Any]:
    return {"fact_id": fact_id, "desk_id": desk_id, "readers": readers,
            "claims": [{"key": key, "kind": kind, "value": value} for key, kind, value in claims]}


RECORDS = Views(
    people=[{"masked_contact": "d•••@example.com", "notes": "Prefers a call after five"},
            {"masked_contact": "b•••@example.com", "notes": "VIP"}],
    sessions=[{"session_id": OWN}, {"session_id": OTHER}, {"session_id": "s-owner-3333"}],
    quotes=[{"quote_id": "Q-own-1", "session_id": OWN}, {"quote_id": "Q-other-2", "session_id": OTHER}],
    facts=[
        fact("charter:contact", ["public"], ("contact", "text", "(510) 555-0142")),
        fact("booking:B-own", ["owner", f"session:{OWN}"], ("title", "text", "Drain visit for you")),
        fact("quote:Q-other-2", ["owner", f"session:{OTHER}"], ("title", "text", "Drain clearing quote")),
        fact("document:doc-7777", ["owner", "person:p-dana-5555"], ("title", "text", "Invoice, drain clearing"),
             ("note", "text", "short")),
        fact("note:owner-1", ["owner"], ("total", "money", 18_000), ("ref", "ref", "REF-OWNER-99")),
        fact("note:elsewhere", ["owner"], ("title", "text", "On another Desk entirely"), desk_id=OTHER_DESK),
    ],
)


async def test_unreadable_names_what_the_session_may_not_read():
    values = await unreadable(RECORDS, DESK_OF_THE_CASE, CALLER, DECISION)
    found = set(values.values())
    for kept in ("owner-token-4444", "s-owner-3333", "own-token-8888", DECISION.reason_plain, "p-dana-5555",
                 "p-bob-6666", "doc-7777", "d•••@example.com", "Prefers a call after five", OTHER,
                 "Q-other-2", "quote:Q-other-2", "document:doc-7777", "Invoice, drain clearing", "note:owner-1",
                 "REF-OWNER-99"):
        assert kept in found, f"{kept!r} is something the session may not read"
    for left_out in (OWN, "Q-own-1", "charter:contact", "(510) 555-0142", "booking:B-own", "Drain visit for you",
                     "Drain clearing quote", "short", "VIP", 18_000, "note:elsewhere", "On another Desk entirely"):
        assert left_out not in found, f"{left_out!r} is the session's own, public, too short or another Desk's"
    assert all(value not in label for label, value in values.items() if "token" in label), "a label holds a token"


def test_leaked_finds_whole_tokens_and_names_labels():
    forbidden = {"a quote id": "Q-1", "a token": "tok_SECRET-1"}
    assert leaked('{"quote_id": "Q-10", "note": "XQ-1"}', forbidden) == []
    assert leaked('{"quote_id": "Q-1"}', forbidden) == ["a quote id"]
    assert leaked("sent tok_SECRET-1.", forbidden) == ["a token"]
    assert leaked("see Q-1 and tok_SECRET-1", forbidden) == ["a quote id", "a token"]


def test_email_pattern_finds_contacts_but_not_ids_or_times():
    for contact in ("dana@example.com", "d•••@example.com", '{"to": "bob@example.com"}'):
        assert EMAIL.search(contact), contact
    for other in ("S-20261104-1000", "2026-11-04T10:00:00-08:00", "Booking B-77", "@handle"):
        assert not EMAIL.search(other), other


def facts_of(*kinds: str) -> ExecResult:
    return ExecResult(action_id="a-1", state="succeeded", model_view={}, facts=[
        Fact(fact_id=f"{kind}:{n}", kind=kind, status="committed", source="kernel", claims=[], label=Label())
        for n, kind in enumerate(kinds)
    ])


def test_fact_id_of_needs_one_fact_of_the_kind():
    real, stub = SimpleNamespace(is_real=True), SimpleNamespace(is_real=False)
    assert fact_id_of(real, facts_of("quote", "booking"), "booking") == "booking:1"
    assert fact_id_of(stub, None, "booking") == "booking:stub-booking"
    for execution in (facts_of("quote"), facts_of("booking", "booking"), None):
        with pytest.raises(AssertionError):
            fact_id_of(real, execution, "booking")


async def test_approval_of_needs_one_spent_approval():
    real = SimpleNamespace(is_real=True)
    decision = SimpleNamespace(decision_id="dec-1")
    spent = {"approval_id": "ap-1", "decision_id": "dec-1", "consumed_at": NOW}
    other = {"approval_id": "ap-2", "decision_id": "dec-2", "consumed_at": NOW}
    assert await approval_of(real, Views(approvals=[other, spent]), DESK_OF_THE_CASE, decision) == "ap-1"
    for rows in ([other], [{**spent, "consumed_at": None}], [spent, {**spent, "approval_id": "ap-3"}]):
        with pytest.raises(AssertionError):
            await approval_of(real, Views(approvals=rows), DESK_OF_THE_CASE, decision)
    assert await approval_of(SimpleNamespace(is_real=False), Views(), DESK_OF_THE_CASE, decision) == "stub-approval"


def ledger_entry(seq: int, ref_id: str | None, summary: dict, kind: str = "execute") -> LedgerEntry:
    return LedgerEntry(
        copy_id=COPY, desk_id=DESK, seq=seq, prev_hash="0" * 64, created_at="2026-11-03T18:00:00.000000Z",
        event={"kind": kind, "origin": "kernel", "session_id": OWN, "ref_id": ref_id, "summary": summary},
        hash="1" * 64, signature="2" * 128, key_id="3" * 16,
    )


def test_naming_finds_entries_whose_ref_or_summary_names_the_decision():
    """An entry is about a decision when its `ref_id` is the decision's id or its summary holds it;
    one naming only the session, or another decision, or holding the id inside a longer token,
    isn't, so another decision's lazy-expiry entry can't stand in for the refusal's. The decision's
    own lazy-expiry entry does name it, so `assert_never_runs` reads the decision first and that
    entry is ledgered before the window it checks."""
    decision = SimpleNamespace(decision_id="dec-1")
    by_ref = ledger_entry(1, "dec-1", {"refused": "held"})
    by_summary = ledger_entry(2, None, {"decision_id": "dec-1", "refused": "denied"})
    nested = ledger_entry(3, "act-9", {"refused": {"decisions": ["dec-1"]}})
    others = [ledger_entry(4, None, {"refused": "held"}), ledger_entry(5, "dec-2", {"decision_id": "dec-2"}),
              ledger_entry(6, "dec-10", {"decision_id": "dec-10"})]
    assert [entry.seq for entry in naming([by_ref, *others, by_summary, nested], decision)] == [1, 2, 3]
    assert naming(others, decision) == []


class LapsedDecisionKernel:
    """A real kernel and its records, as far as `assert_never_runs` reads them, holding one decision
    that has lapsed: the first read or `/execute` of it applies the expiry, ledgering an entry that
    names it; every `/execute` is refused, and ledgered naming the decision only with
    `ledgers_refusals`."""

    is_real = True

    def __init__(self, ledgers_refusals: bool) -> None:
        self.ledgers_refusals = ledgers_refusals
        self.entries: list[LedgerEntry] = []
        self.expired = False

    async def ledger_entries(self, copy_id: str, desk_id: str) -> list[LedgerEntry]:
        return list(self.entries)

    async def call(self, route: str, *, path: dict | None = None, body: dict | None = None, **_: Any) -> Any:
        decision_id = path["id"] if path else body["decision_id"]
        if not self.expired:
            self.expired = True
            self.entries.append(ledger_entry(len(self.entries) + 1, decision_id, {"expired": True}, "approval"))
        if route == "GET /decisions/{id}":
            return SimpleNamespace(decision_id=decision_id, state="expired")
        if self.ledgers_refusals:
            self.entries.append(ledger_entry(len(self.entries) + 1, decision_id, {"refused": "expired"}))
        return KernelError(code="conflict")


async def test_a_lapsed_decisions_own_expiry_entry_cant_stand_in_for_the_refusals():
    """A decision's lazy-expiry entry names it, so the check reads the decision before the refused
    `/execute`: a kernel that ledgers the expiry but never the refusal fails it, and one that
    ledgers the refusal as well passes."""
    decision = SimpleNamespace(decision_id="dec-1")
    silent = LapsedDecisionKernel(ledgers_refusals=False)
    with pytest.raises(AssertionError, match="expired decision ledgered nothing naming it"):
        await assert_never_runs(silent, silent, DESK_OF_THE_CASE, CALLER, decision, "expired")
    ledgering = LapsedDecisionKernel(ledgers_refusals=True)
    await assert_never_runs(ledgering, ledgering, DESK_OF_THE_CASE, CALLER, decision, "expired")
    assert [entry.event.kind for entry in ledgering.entries] == ["approval", "execute", "execute"]


async def test_approvals_of_reads_one_or_more_decisions():
    """The approval rows of the decisions given, one or several, and no other decision's."""
    rows = [{"approval_id": f"ap-{n}", "decision_id": f"dec-{n}"} for n in (1, 2, 3)]
    one, two = SimpleNamespace(decision_id="dec-1"), SimpleNamespace(decision_id="dec-2")
    records = Views(approvals=rows)
    assert await approvals_of(records, DESK_OF_THE_CASE, one) == [rows[0]]
    assert await approvals_of(records, DESK_OF_THE_CASE, one, two) == rows[:2]
    assert await approvals_of(records, DESK_OF_THE_CASE, SimpleNamespace(decision_id="dec-4")) == []


async def test_upcoming_slots_are_the_desks_next_slots():
    clock = TravelClock(NOW)
    k = SimpleNamespace(is_real=True, clock=clock)

    def slot(slot_id: str, hours: float, desk_id: str = DESK) -> dict[str, Any]:
        return {"slot_id": slot_id, "desk_id": desk_id, "starts_at": NOW + timedelta(hours=hours)}

    records = Views(calendar_slots=[slot("later", 48), slot("past", -2), slot("soon", 2), slot("next", 24),
                                    slot("elsewhere", 1, OTHER_DESK)])
    assert await upcoming_slots(k, records, DESK_OF_THE_CASE, 3) == ["soon", "next", "later"]
    with pytest.raises(AssertionError, match="3 upcoming slots"):
        await upcoming_slots(k, records, DESK_OF_THE_CASE, 4)


SLICE_EXPIRY = "Good until Friday, November 6, 10:00 am"   # a quote made at START, good for 72 hours


def test_the_slices_quote_card_is_read_where_the_visitor_reads_it():
    """The thin slice's quote card shows the held total as its headline and no amount but that
    total and the list price in its title or any line, whatever its plain text says, and its text
    agrees with them (Plan 01a's quote template: the total, the items, the discount off the list,
    the expiry). Its only date is the quote's own expiry, which the case works out from its clock."""
    def held(title: str, *lines: str) -> RenderedBlock:
        return RenderedBlock(kind="card", template="quote", fact_id="quote:Q-own-1", title=title, lines=list(lines),
                             text="\n".join([title, *lines]))

    card = held("$36.00", "Drain clearing", "Includes 80% off $180.00", SLICE_EXPIRY)
    assert held_quote_card_problems(card, [SLICE_EXPIRY]) == []
    for change in ({"title": "$1.00"}, {"title": "$180.00"},
                   {"lines": ["Drain clearing", "Includes 99% off $1.00", SLICE_EXPIRY]},
                   {"text": f"$36.00\nDrain clearing\n{SLICE_EXPIRY}"},
                   {"lines": ["Drain clearing", "Includes 99% off $180.00", SLICE_EXPIRY],
                    "text": f"$36.00\nDrain clearing\nIncludes 99% off $180.00\n{SLICE_EXPIRY}"},
                   {"lines": ["Drain clearing", "Includes 80% off $180.00", "Was 1.00", SLICE_EXPIRY]}):
        assert held_quote_card_problems(card.model_copy(update=change), [SLICE_EXPIRY]), change
    for title, *lines in (("€36.00", "Drain clearing", "Includes 80% off €180.00", SLICE_EXPIRY),   # in euros
                          ("$36.00", "Drain clearing", "Includes 80% off £180.00", SLICE_EXPIRY)):  # list in pounds
        problems = held_quote_card_problems(held(title, *lines), [SLICE_EXPIRY])
        assert any("US dollars" in problem for problem in problems), (title, lines, problems)
    for lines in (["Drain clearing", "Includes 80% off $180.00", "Good until Monday, January 1, 1:00 am"],
                  ["Drain clearing", "Includes 80% off $180.00", "We will come tomorrow.", SLICE_EXPIRY],
                  ["Drain clearing", "Includes 80% off $180.00"]):
        problems = held_quote_card_problems(held("$36.00", *lines), [SLICE_EXPIRY])
        assert problems, lines
