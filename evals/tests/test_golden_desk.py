"""The golden Desk's helpers and the decide table's rows, checked without a kernel."""

import re
from collections import Counter
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Literal
from zoneinfo import ZoneInfo

import httpx
import pytest
from pydantic import BaseModel, ConfigDict, Field

from desk.contracts import DemoInboxEntry, Review
from evals.fakes import FakeAnthropic, HttpError, Json, Refusal, Sleep, Text
from evals.tier1 import test_decide_golden as decide_golden
from evals.tier1.args import quote_args, schema_mismatches
from desk.kernel_api import DeskCalendarRequest, DeskPricesRequest
from evals.tier1.golden_desk import (
    CUSTOM_ITEMS,
    CUSTOM_SLOTS,
    REVIEW_PASS,
    REVIEWER_MODEL,
    SEED_TITLES,
    START,
    Slot,
    charge_id,
    code_from_inbox,
    custom_calendar,
    custom_prices,
    Row,
    load_rows,
    make_quote_fact,
    quote_expiries,
    reviewer_reply,
    seed_slots,
)


class QuoteItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    item_id: str
    qty: int = Field(1, ge=1, le=10)


class QuoteArgs(BaseModel):
    """Shaped like Plan 01a's quote adapter Args, so the schema has $defs, $ref and an optional field."""

    model_config = ConfigDict(extra="forbid")
    items: list[QuoteItem]
    requested_discount_bp: int = 0
    note: str | None = None
    kind: Literal["plain"] | None = None


def test_schema_mismatches_follow_refs_and_optionals():
    schema = QuoteArgs.model_json_schema()
    assert schema_mismatches(quote_args("drain", requested_discount_bp=1000), schema) == []
    assert schema_mismatches({"items": [{"item_id": "drain", "quantity": 1}]}, schema) == [
        "args.items.0.quantity isn't in the schema"
    ]
    assert schema_mismatches({"requested_discount_bp": 0, "amount_cents": 100}, schema) == [
        "args.amount_cents isn't in the schema",
        "args.items is required",
    ]


def test_reviewer_replies():
    passing = Review(within_charter_bp=10000, manipulation_bp=0, recommendation="allow")
    assert Review.model_validate(REVIEW_PASS) == passing
    assert reviewer_reply("pass") == (Json(REVIEW_PASS), True)
    assert reviewer_reply("refusal") == (Refusal(), True)
    # Fields written over pass keep their YAML types, so wrong types reach the kernel as sent.
    float_score, _ = reviewer_reply({"json": {"within_charter_bp": 10000.0}})
    assert float_score.obj == {**REVIEW_PASS, "within_charter_bp": 10000.0}
    assert type(float_score.obj["within_charter_bp"]) is float
    assert reviewer_reply({"sleep": 5}) == (Sleep(5, Json(REVIEW_PASS)), True)
    assert reviewer_reply({"http_error": 500}) == (HttpError(500), True)
    assert reviewer_reply({"text": "Looks fine to me"}) == (Text("Looks fine to me"), True)
    assert reviewer_reply({"if_called": "pass"}) == (Json(REVIEW_PASS), False)
    for bad in ("allow", {"json": 1}, {"sleep": "5"}, {"text": "a", "sleep": 1}, {"if_called": {"if_called": "pass"}}):
        with pytest.raises(ValueError):
            reviewer_reply(bad)


SIX_DIGITS = re.compile(r"(?<![0-9])[0-9]{6}(?![0-9])")   # the shape of a code, whichever one it is


def inbox_entry(kind: str, body: str) -> DemoInboxEntry:
    return DemoInboxEntry(entry_id=f"e-{len(body)}", to="d•••@example.com", kind=kind, body=body,
                          created_at=datetime(2026, 11, 3, 18, tzinfo=UTC))


def test_code_from_inbox():
    """The code is read from the one `verification_code` entry; any other inbox fails with counts
    only, so no code the inbox held reaches a failure message, pytest's explanation included."""
    code = inbox_entry("verification_code", "Your Turner Plumbing code is 042917. It expires in ten minutes.")
    assert code_from_inbox([code]) == "042917"
    alert = inbox_entry("alert", "A request needs your answer: 123456")
    assert code_from_inbox([alert, code]) == "042917"
    malformed = {
        "no entries": [], "no code entry": [alert],
        "two code entries": [code, inbox_entry("verification_code", "Tu código es 111111.")],
        "two codes in one entry": [inbox_entry("verification_code", "Codes 123456 and 654321")],
        "a code entry with no code": [inbox_entry("verification_code", "Your code is on its way.")],
    }
    for what, entries in malformed.items():
        with pytest.raises(AssertionError) as failure:
            code_from_inbox(entries)
        shown = str(failure.value)
        assert not any(held in shown for held in ("042917", "123456", "111111", "654321")), (what, shown)
        assert not SIX_DIGITS.search(shown), (what, shown)


def calendar_rows(days: int = 14) -> list[dict]:
    """kernel_ro.calendar_slots rows as Plan 01a seeds them from Tuesday 2026-11-03: two-hour
    slots from the next day, Mon-Fri 08:00-16:00 and Sat 09:00 and 11:00, stored in UTC."""
    tz = ZoneInfo("America/Los_Angeles")
    rows = []
    for offset in range(1, days + 1):
        day = datetime(2026, 11, 3, tzinfo=tz) + timedelta(days=offset)
        hours = (8, 10, 12, 14, 16) if day.weekday() < 5 else (9, 11) if day.weekday() == 5 else ()
        for hour in hours:
            starts_at = day.replace(hour=hour)
            rows.append({"slot_id": starts_at.strftime("S-%Y%m%d-%H%M"), "copy_id": "c-1", "desk_id": "d-1",
                         "starts_at": starts_at.astimezone(UTC), "minutes": 120})
    return rows


def test_seed_slots_by_role():
    slots = seed_slots(calendar_rows())
    assert slots == {
        "wk": Slot("S-20261104-1000", datetime(2026, 11, 4, 18, tzinfo=UTC)),
        "sat": Slot("S-20261107-0900", datetime(2026, 11, 7, 17, tzinfo=UTC)),
    }
    without_saturday = [row for row in calendar_rows() if row["slot_id"] != "S-20261107-0900"]
    with pytest.raises(AssertionError, match="sat"):
        seed_slots(without_saturday)


def charge_fact(charge: str, person: str, claims: list[dict]) -> dict:
    return {"fact_id": f"charge:{charge}", "copy_id": "c-1", "desk_id": "d-1", "kind": "charge",
            "status": "committed", "claims": claims, "readers": ["owner", f"person:{person}"], "expires_at": None}


def test_charge_by_owner_and_amount_or_title():
    facts = [
        charge_fact("ch-1", "p-dana", [{"key": "total", "kind": "money", "value": 18000}]),
        charge_fact("ch-2", "p-dana", [{"key": "total", "kind": "money", "value": 25000}]),
        charge_fact("ch-3", "p-bob", [{"key": "total", "kind": "money", "value": 25000}]),
        {**charge_fact("ch-4", "p-dana", []), "kind": "refund", "fact_id": "refund:r-1"},
    ]
    assert charge_id(facts, "p-dana", 25000, "Leak repair") == "ch-2"
    # A seeded fact may carry only the charge's title.
    titled = [charge_fact("ch-5", "p-dana", [{"key": "title", "kind": "text", "value": "Leak repair"}]),
              charge_fact("ch-6", "p-dana", [{"key": "title", "kind": "text", "value": "Drain clearing"}])]
    assert charge_id(titled, "p-dana", 25000, "Leak repair") == "ch-5"
    for rows in ([], facts[:1], facts + titled):
        with pytest.raises(AssertionError):
            charge_id(rows, "p-dana", 25000, "Leak repair")


def test_custom_rows_keep_the_seed_and_one_row_per_id():
    seed = calendar_rows()
    calendar = DeskCalendarRequest.model_validate({"calendar_slots": custom_calendar(seed)}).calendar_slots
    ids = [slot.slot_id for slot in calendar]
    assert len(ids) == len(set(ids)) == len(seed) + 3   # S-20261110-0800 is already a seed slot
    assert {"S-20261110-0800", "S-20261110-1659", "S-20261110-1700", "S-20261108-2200"} <= set(ids)
    assert {slot.slot_id: slot.starts_at for slot in calendar}["S-20261108-2200"] == CUSTOM_SLOTS["sun22"].starts_at
    clash = [{**seed[0], "slot_id": "S-20261110-1659"}]   # a seed id at another time can't be merged
    with pytest.raises(AssertionError, match="S-20261110-1659"):
        custom_calendar(clash)

    seed_prices = [{"item_id": "drain", "copy_id": "c-1", "desk_id": "d-1", "title": "Drain clearing",
                    "unit_cents": 18000}]
    prices = DeskPricesRequest.model_validate({"price_items": custom_prices(seed_prices)}).price_items
    assert {item.item_id: item.unit_cents for item in prices} == {"drain": 18000, **CUSTOM_ITEMS}
    assert CUSTOM_ITEMS == {"v20": 2000, "v25": 2500, "v80": 8000, "v120": 12000, "v800": 80000}


# Holds an `ask` card (or the compiler's default ask) decided, which offer `deny_always`, and holds
# an `auto` card's limit decided (an amount, discount, hours or review-gate hold), which don't.
ASK_HOLDS = {
    "change-auto-book-ask", "tie-auto-ask", "default-ask-uncovered", "verified-card-stranger",
    "person-auto-stranger", "person-never-stranger", "person-beats-tool-stranger",
    "money-person-auto-stranger",   # the ask card g-ask-charge; Dana's auto card doesn't cover a visitor
}
LIMIT_HOLDS = {
    "specific-auto-over", "discount-1001", "discount-8000", "hours-sat", "hours-sun-2200", "hours-tue-1700",
    "review-timeout", "review-error", "review-refusal", "review-unparsable", "review-high", "review-negative",
    "review-low-charter", "review-float-score", "review-string-score", "review-bool-score", "review-rec-hold",
    "review-rec-block", "money-card-120", "person-cap-dana",
    "s-discount-8000",   # the seed's rv-quote (auto, no discount): its hold twin, a limit hold
}


def test_deny_always_matchers_mark_ask_holds_and_limit_holds():
    """Every hold whose deciding policy is unambiguous pins `deny_always`: an ask-decided hold offers
    it, a limit hold (through an auto card's hold twin, a failed review gate included) leaves it out
    and the kernel refuses it with 422."""
    rows = {row.id: row for row in load_rows()}
    for row_id in ASK_HOLDS:
        assert rows[row_id].outcome == "hold" and rows[row_id].expect.get("answers") == {"$has": "deny_always"}, row_id
    for row_id in LIMIT_HOLDS:
        want = {"$not": {"$has": "deny_always"}}
        assert rows[row_id].outcome == "hold" and rows[row_id].expect.get("answers") == want, row_id


def test_rows_load_with_the_plans_counts():
    rows = load_rows()
    assert len(rows) == len({row.id for row in rows}) == 66
    assert Counter(row.requires[-1] for row in rows) == {"01a": 39, "01b": 13, "01c": 14}
    # Every row states its outcome, and a /decide answer's state follows it ("Decision lifecycle").
    states = {"allow": "allowed", "hold": "held", "refuse": "refused"}
    for row in rows:
        fields = row.decision_expect().fields
        assert fields["state"] == states[fields["outcome"]], row.id
    # A scripted reviewer reply is one call; {if_called} allows any number, and with no reviewer any call fails.
    calls = {row.id: row.checks.reviewer_calls for row in rows if row.reviewer is not None}
    assert {row_id: n for row_id, n in calls.items() if row_id.startswith("review-") and n != 1} == {}
    assert calls["send-message-review"] == calls["send-message-reviewer-down"] == 1
    assert calls["s-discount-8000"] is None


GOOD_ROW = {
    "id": "a-row",
    "requires": ["01a"],
    "cards": [{"card_id": "g-auto-quote", "mode": "auto", "applies_to": "native.quote"}],
    "call": {"tool": "native.quote", "item": "drain"},
    "expect": {"outcome": "allow"},
}


@pytest.mark.parametrize("change", [
    {"seed": "active"},                                                     # cards and seed
    {"cards": None},                                                        # neither
    {"requires": ["01d"]},
    {"caller": "dana"},                                                     # verifying is 01b's
    {"call": {"tool": "native.book", "slot": "sun22"}},                     # a custom slot is 01b's
    {"requires": ["01b"], "caller": "agent"},                               # a demo agent is 01c's
    {"caller": "maria"},
    {"colour": "teal"},                                                     # an unknown key
    {"expect": {"outcome": "allowed"}},
    {"expect": {"outcome": "allow", "outcom": "allow"}},                    # not a Decision path
    {"expect": {"outcome": "allow", "strikes": "0"}},
    {"expect": {"outcome": "allow", "default_ask": "native.dance"}},
    {"reviewer": "maybe"},
    {"reviewer": "pass", "expect": {"outcome": "allow", "reviewer_calls": 0}},   # a scripted reply is one call
    {"reviewer": {"http_error": 500}, "expect": {"outcome": "hold", "reviewer_calls": 2}},
    {"call": {"tool": "native.quote", "item": "drain", "slot": "wk"}},      # names what a quote doesn't take
    {"call": {"tool": "native.quote", "item": "boiler"}},
    {"call": {"tool": "native.book", "slot": "mon-0600"}},
    {"call": {"tool": "native.transfer_funds"}},                            # no adapter: the row gives args
    {"call": {"tool": "native.capture_lead", "args": {"name": "Ann"}}},     # an adapter no row builds yet
    {"cards": [{"card_id": "g-auto-book", "mode": "auto", "applies_to": "native.book", "person": "dana"}]},
    {"cards": [{"card_id": "g-auto-charge", "mode": "auto", "applies_to": "effect:charge"}]},   # RuleCard: no cap
    {"cards": [{"card_id": "g-auto", "mode": "auto", "applies_to": "native.book",
                "hours": {"days": ["mon"], "start": "17:00", "end": "08:00"}}]},
])
def test_rows_refuse_mistakes(change):
    Row.model_validate(GOOD_ROW)
    with pytest.raises(ValueError):
        Row.model_validate({**GOOD_ROW, **change})


def test_rows_with_one_id_twice_are_refused(tmp_path):
    path = tmp_path / "decide.yaml"
    row = "- {id: a, requires: [01a], seed: active, call: {tool: native.find_slots}, expect: {outcome: allow}}\n"
    path.write_text(row * 2)
    with pytest.raises(ValueError, match="repeats the row ids"):
        load_rows(path)


class ScriptedKernel:
    """A real-kernel stand-in that answers each call with the next scripted body, in order."""

    is_real = True

    def __init__(self, *bodies: object) -> None:
        self.bodies, self.routes = list(bodies), []

    async def call(self, route: str, **_: object) -> object:
        self.routes.append(route)
        return self.bodies.pop(0)


def quoting_visitor() -> SimpleNamespace:
    return SimpleNamespace(state=SimpleNamespace(session_id="s-1", generation=0), auth=None, turn=lambda: None)


async def test_quote_facts_come_from_the_adapters_model_view():
    """A quote's fact id is the one the quote adapter names (`model_view.fact_id`), not one rebuilt
    from its quote id, so a reply clause cites the fact the kernel wrote."""
    allow = SimpleNamespace(outcome="allow", decision_id="d-1")
    view = {"fact_id": "quote:7f3a", "quote_id": "Q-7f3a", "items": "Drain clearing", "status": "available"}
    k = ScriptedKernel(allow, SimpleNamespace(model_view=view))
    assert await make_quote_fact(k, None, quoting_visitor(), "drain") == "quote:7f3a"
    assert k.routes == ["POST /decide", "POST /execute"]
    no_fact = ScriptedKernel(allow, SimpleNamespace(model_view={"quote_id": "Q-7f3a"}))
    with pytest.raises(AssertionError, match="no fact_id"):
        await make_quote_fact(no_fact, None, quoting_visitor(), "drain")


async def run_review_row(monkeypatch: pytest.MonkeyPatch, row_id: str, *, reviewed: bool) -> FakeAnthropic:
    """`test_decide_row` for a reviewer row on a real-kernel stand-in whose `/decide` calls the
    started fake reviewer once, or never; returns the fake, stopped."""
    row = {row.id: row for row in load_rows()}[row_id]
    caller = SimpleNamespace(state=SimpleNamespace(session_id="s-1", generation=0), auth=None, turn=lambda: None)

    async def returns(value: object = None) -> object:
        return value

    async def decide(k, who, tool, args, *, expect):
        if reviewed:
            async with httpx.AsyncClient(base_url=fake.url) as client:
                await client.post("/v1/messages", json={"model": REVIEWER_MODEL, "max_tokens": 64,
                                                       "messages": [{"role": "user", "content": "Review this."}]})

    for name, stand_in in {
        "golden_desk": lambda *args, **kwargs: returns(SimpleNamespace()),
        "open_caller": lambda *args, **kwargs: returns(caller),
        "call_args": lambda *args, **kwargs: returns({}),
        "confirm_cards": lambda *args, **kwargs: returns(),
        "check_args_schema": lambda *args, **kwargs: returns(),
        "decide": decide,
    }.items():
        monkeypatch.setattr(decide_golden, name, stand_in)
    fake = FakeAnthropic().start()
    try:
        await decide_golden.test_decide_row(SimpleNamespace(is_real=True), fake, None, row)
    finally:
        fake.stop()
    return fake


@pytest.mark.parametrize("row_id", ["review-unparsable", "review-error", "review-refusal"])
async def test_a_reviewer_row_fails_when_the_reviewer_is_never_called(
    monkeypatch: pytest.MonkeyPatch, row_id: str,
):
    """A row that scripts the reviewer's reply holds because the reviewer failed, not because it
    was skipped: with no reviewer call the row fails, and the fake reports the reply unused; with
    the one call it passes and the fake is satisfied."""
    with pytest.raises(AssertionError, match="0 reviewer calls"):
        await run_review_row(monkeypatch, row_id, reviewed=False)
    fake = await run_review_row(monkeypatch, row_id, reviewed=True)
    fake.check()
    skipped = FakeAnthropic()
    skipped.script(REVIEWER_MODEL, Text("Never asked for"))
    with pytest.raises(AssertionError, match="1 scripted replies were never used"):
        skipped.check()


def test_a_quotes_expiry_is_72_hours_after_it_was_made_in_business_time():
    """A quote made in the seconds after START (Tuesday 10:00 in Los Angeles) is good until Friday
    10:00 there: 72 hours later, read in the business's time zone, whatever zone the case's clock
    gives (UTC). The window's last instant rounds up, so a renderer that rounds is accepted too."""
    made = START.astimezone(UTC)
    assert quote_expiries(made, made, "en") == ["Good until Friday, November 6, 10:00 am"]
    assert quote_expiries(made, made + timedelta(seconds=4), "es") == [
        "Válido hasta viernes 6 de noviembre, 10:00", "Válido hasta viernes 6 de noviembre, 10:01"]
    assert len(quote_expiries(made, made, None)) == 2   # no language pinned: both
    assert SEED_TITLES["drain"] == "Drain clearing"
