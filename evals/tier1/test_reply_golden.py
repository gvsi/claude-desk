"""The reply check's golden fixtures in English and Spanish, and the cases around a draft's verdict.

Each row of `golden/replies.yaml` is one draft on its own golden Desk (`golden_desk.py`): a fresh
visitor session checks the row's prose and clauses with `POST /check_reply`, after any setup the
row names, and the verdict must be the row's. Clauses cite facts by id, or by role: this session's
quote or booking, another session's quote or booking, or an owner statement made in another session.

On the real kernel each verdict is also judged from outside the reply check: its signature
verifies with `/health`'s key (`verify_verdict_sig`), its visible free text holds nothing the
evals' own scanner reads as an amount or a date, a quote card shows the seed's drain price in US
dollars and no other amount in its title and each line (what the web app shows) and its text agrees
with them, and a handoff names the owner. Nine cases follow the table: stale and owner-mode
drafts, a paused session, owner say and whisper, signatures, the soft-promise call and a digit scan
of every visitor-bound kernel text.
"""

import json
from collections import Counter
from pathlib import Path
from typing import Any, Literal, get_args

import pytest
import yaml
from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError, model_validator

from desk.api.prompts import STATUS_LINES
from desk.contracts import ClauseTemplate, LedgerEntry, OwnerMessageResult, ReplyVerdict, RuleCard, Violation
from desk.markdown_text import blank_list_markers
from desk.rewrites import PROSE_ONLY, REWRITABLE
from evals.fakes import FakeAnthropic, HttpError, Json, Refusal, Reply, Sleep, Text
from evals.oracles import card_amount_problems, denies_ai, scan_visible, verify_verdict_sig, visible_texts
from evals.tier1.args import book_args, payment_link_args, quote_args
from evals.tier1.golden_desk import (
    GOLDEN_DIR,
    P,
    QUOTE_LIFE,
    REVIEW_PASS,
    REVIEWER_MODEL,
    SEED_TITLES,
    Caller,
    GoldenDesk,
    confirm_cards,
    decide,
    golden_desk,
    make_quote_fact,
    open_caller,
    quote_expiries,
)
from evals.tier1.harness import KERNEL_PLANS, PLANS, Auth, Expect, KernelHarness
from evals.tier1.targets import SOFT_PROMISE_MODEL, SOFT_PROMISE_PASS

OWNER = "Mike Turner"   # the seed's owner_display_name, which the handoff clause names
CLEAN_EN = "I can help with that. Which day works for you?"
CLEAN_ES = "Con gusto le ayudo. ¿Qué día le viene bien?"
QUOTE_PROSE = "Here is your quote."
NUMBER_PROSE = "That will be $89."
FRENCH_PROSE = "Je peux vous aider avec ça."
OWNER_SAY = "I'll come and look at the sink myself."
STAND_IN_CANARY = "cdk-0000000000000000"   # the stub's document canary, shaped like the kernel's
KEEP_ALIVE_S = 12 * 3600   # a hop well inside the 24 hours a visitor session may sit idle before it closes
HANDED_OFF = ["handoff"]
# A failure only of the prose with no card at all (none to keep, no drafted handoff) asks the visitor first: the
# kernel's call-back offer, as prose, since the golden Desk (a Turner copy) offers visitors a call back (the owner's
# decision of 2026-11-01). A checker outage (`check_unavailable`) hands off.
OFFERED = ["prose"]
OFFER = STATUS_LINES["offer_callback"]

# Rows of golden/replies.yaml

_ROW = ConfigDict(extra="forbid")
ViolationKind = Violation.model_fields["kind"].annotation
FactRole = Literal["own-quote", "other-session-quote", "own-booking", "other-session-booking",
                   "other-session-owner-statement", "own-payment-link"]
QUOTE_ROLES = ("own-quote", "other-session-quote")
BLOCK_NAMES = ("prose", *get_args(ClauseTemplate))
LINED_CARDS = ("quote", "charges")   # cards that fill lines as well as a title (the master's "Clauses" row)
# The soft-promise check's reply a row scripts; with `pass` the target's default answers (it passes).
SOFT_PROMISE_REPLIES: dict[str, Reply] = {
    "pass": Json(SOFT_PROMISE_PASS),
    "refusal": Refusal(),
    "flag": Json({**SOFT_PROMISE_PASS, "promises_beyond_cards": True}),
    "denies_ai": Json({**SOFT_PROMISE_PASS, "denies_being_ai": True}),   # the reply claims to be a person
    "error": HttpError(500),
    "timeout": Sleep(9, Json(SOFT_PROMISE_PASS)),   # past the check's 8 s timeout
    "unparsable": Text("maybe"),
}
# The soft-promise violation's rule_id for each flag (Plan 01a step 5): a denial of being an AI is
# `soft.denies_ai`, the only fixed, model-free handling of prose that denies being Claude.
DENIES_AI_RULE_ID = "soft.denies_ai"


class ClauseSpec(BaseModel):
    """A clause in a row: its template and the fact it cites, by role or by id (neither: no fact)."""

    model_config = _ROW
    template: ClauseTemplate
    fact: FactRole | None = None
    fact_id: str | None = None

    @model_validator(mode="after")
    def _one_fact(self) -> "ClauseSpec":
        if self.fact is not None and self.fact_id is not None:
            raise ValueError("a clause cites its fact by role or by id, not both")
        return self

    def cited(self, facts: dict[str, str]) -> str | None:
        return facts[self.fact] if self.fact is not None else self.fact_id


class ReplyExpect(BaseModel):
    """The verdict a row expects. A failed check names the violation kinds it has (`violations`,
    exactly those) or may have (`violations_any`, one or more of those, nothing else)."""

    model_config = _ROW
    ok: StrictBool
    language: Literal["en", "es"] | None = None
    violations: list[ViolationKind] | None = None
    violations_any: list[ViolationKind] | None = None
    blocks: list[Literal[BLOCK_NAMES]] | None = None

    @model_validator(mode="after")
    def _kinds_follow_ok(self) -> "ReplyExpect":
        named = [kinds for kinds in (self.violations, self.violations_any) if kinds is not None]
        if self.ok and named:
            raise ValueError("a passing verdict has no violations")
        if not self.ok and len(named) != 1:
            raise ValueError("a failed check names its violations or violations_any, one of the two")
        for kinds in named:
            if not kinds or len(set(kinds)) != len(kinds):
                raise ValueError("violation kinds are listed once each, at least one")
        return self

    @property
    def kinds(self) -> list[str]:
        return self.violations or self.violations_any or []


def shown_blocks(blocks: list[str]) -> dict[str, Any]:
    """Expect fields for the blocks a verdict shows, in order: "prose", or a card's template."""
    fields: dict[str, Any] = {"blocks": {"$len": len(blocks)}}
    for n, block in enumerate(blocks):
        fields[f"blocks.{n}.kind"] = "prose" if block == "prose" else "card"
        fields[f"blocks.{n}.template"] = None if block == "prose" else block
    return fields


class ReplyRow(BaseModel):
    """One row of the reply table (`golden/replies.yaml` says what each key means)."""

    model_config = _ROW
    id: str
    requires: list[str] = Field(min_length=1)
    setup: Literal["session_language_es", "travel_past_expiry"] | None = None
    prose: str
    clauses: list[ClauseSpec] = []
    final: StrictBool = True
    soft_promise: Literal["pass", "flag", "denies_ai", "error", "timeout", "unparsable", "refusal"] = "pass"
    expect: ReplyExpect

    @model_validator(mode="after")
    def _holds_together(self) -> "ReplyRow":
        if unknown := [plan for plan in self.requires if plan not in PLANS]:
            raise ValueError(f"requires names unknown plans {unknown}; the plans are {list(PLANS)}")
        kernel = [KERNEL_PLANS.index(plan) for plan in self.requires if plan in KERNEL_PLANS]
        if not kernel or max(kernel) < KERNEL_PLANS.index(self.needs):
            raise ValueError(f"the row needs plan {self.needs} (the reply check, or the facts it cites), "
                             "so it requires it")
        if self.expect.blocks is not None and self.expect.blocks != self.blocks:
            raise ValueError(f"the draft shows {self.blocks}, not {self.expect.blocks}: a failed check shows "
                             "checked cards, then any drafted handoff, for prose-only failures, or with no card "
                             "to keep the call-back offer as prose, otherwise the handoff clause (or no blocks on "
                             "a rewritable first attempt), a passing one its prose and cards in order")
        if self.setup == "travel_past_expiry" and not any(clause.fact in QUOTE_ROLES for clause in self.clauses):
            raise ValueError("travel_past_expiry travels past a cited quote's expiry, so the row cites a quote")
        if self.soft_promise != "pass":   # one try, no recheck: the reply decides the verdict
            kinds = ["soft_promise"] if self.soft_promise in ("flag", "denies_ai") else ["check_unavailable"]
            if self.expect.ok or self.expect.violations != kinds:
                raise ValueError("a flag is a soft_promise violation and no verdict is check_unavailable, "
                                 "each the only one")
        return self

    @property
    def needs(self) -> str:
        """The last kernel plan needed: payments 01c, owner statements 01b, other facts 01a."""
        if any(clause.fact == "own-payment-link" for clause in self.clauses):
            return "01c"
        return "01b" if any(clause.fact == "other-session-owner-statement" for clause in self.clauses) else "01a"

    @property
    def kept_clauses(self) -> list[ClauseSpec]:
        """Cards a prose-only failure may keep; a drafted handoff isn't one, and follows them."""
        return [clause for clause in self.clauses if clause.template != "handoff"]

    @property
    def blocks(self) -> list[str]:
        """Prose-only failures keep their cards, then a drafted handoff clause, or with no card at
        all show the call-back offer, but for a checker outage, which hands off; other failures
        hand off. A rewritable first attempt shows nothing, and a passing one its prose and cited
        cards. (Each row is a fresh session, so none has an open handoff, which keeps the card.)"""
        if not self.expect.ok:
            if not self.final and set(self.expect.kinds) <= REWRITABLE:
                return []
            if set(self.expect.kinds) <= PROSE_ONLY:
                if self.kept_clauses:
                    drafted = any(clause.template == "handoff" for clause in self.clauses)
                    return [clause.template for clause in self.kept_clauses] + (HANDED_OFF if drafted else [])
                if not self.clauses and "check_unavailable" not in self.expect.kinds:
                    return OFFERED
            return HANDED_OFF
        return (["prose"] if self.prose else []) + [clause.template for clause in self.clauses]

    def draft_clauses(self, facts: dict[str, str]) -> list[dict[str, Any]]:
        return [{"template": clause.template, "fact_id": clause.cited(facts)} for clause in self.clauses]

    def verdict_expect(self, generation: int, facts: dict[str, str]) -> Expect:
        """The verdict as dotted paths: ok, language, the first violation's kind, and each block's
        kind and template in order; a card from a clause carries that clause's fact and its data."""
        expect = self.expect
        fields: dict[str, Any] = {"ok": expect.ok, "generation": generation}
        if expect.language is not None:
            fields["language"] = expect.language
        if expect.ok:
            fields["violations"] = []
        else:
            fields["violations.0.kind"] = {"$in": expect.kinds}
        fields |= shown_blocks(self.blocks)
        if not expect.ok and self.blocks == OFFERED:   # the kernel's words, in the reply's language
            fields["blocks.0.text"] = (OFFER[expect.language] if expect.language is not None
                                       else {"$in": list(OFFER.values())})
        cited = iter(self.clauses if expect.ok else self.kept_clauses if self.blocks != HANDED_OFF else [])
        for n, block in enumerate(self.blocks):
            if block == "prose":
                continue
            if (clause := next(cited, None)) is not None:
                at = f"blocks.{n}."
                fields |= {at + "fact_id": clause.cited(facts), at + "title": {"$not": None}}
                if block in LINED_CARDS:
                    fields[at + "lines"] = {"$not": {"$len": 0}}
        return Expect(fields=fields)

    def kind_mismatches(self, verdict: ReplyVerdict) -> list[str]:
        """How the verdict's violation kinds differ from the row's, as sets."""
        kinds, expected = {violation.kind for violation in verdict.violations}, set(self.expect.kinds)
        if self.expect.violations_any is not None:
            fits = bool(kinds) and kinds <= expected
        else:
            fits = kinds == expected
        stated = self.expect.model_dump(exclude_none=True)
        return [] if fits else [f"violation kinds {sorted(kinds)}, expected {stated}"]


def load_rows(path: Path = GOLDEN_DIR / "replies.yaml") -> list[ReplyRow]:
    """The table's rows; a malformed row or a repeated id raises ValueError, so collection fails."""
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, list):
        raise ValueError(f"{path.name} is a list of rows")
    rows = []
    for n, item in enumerate(data):
        try:
            rows.append(ReplyRow.model_validate(item))
        except ValidationError as error:
            name = item.get("id") if isinstance(item, dict) else None
            raise ValueError(f"{path.name} row {n} ({name}): {error}") from None
    if repeated := sorted(row_id for row_id, n in Counter(row.id for row in rows).items() if n > 1):
        raise ValueError(f"{path.name} repeats the row ids {repeated}")
    return rows


ROWS = load_rows()


# Steps a case takes

async def check_reply(
    k: KernelHarness, caller: Caller, prose: str, clauses: list[dict[str, Any]] | None = None, *,
    expect: Expect, generation: int | None = None, final: bool | None = None,
) -> Any:
    """`POST /check_reply` for one draft, at the caller's current generation unless given."""
    draft = {
        "session_id": caller.state.session_id,
        "generation": caller.state.generation if generation is None else generation,
        "prose": prose,
        "clauses": clauses or [],
    }
    body = {"draft": draft, **({"final": final} if final is not None else {})}
    return await k.call("POST /check_reply", body=body, auth=caller.auth, expect=expect)


def passes(caller: Caller, blocks: list[str], *, language: str | None = None) -> Expect:
    """A passing verdict showing `blocks` ("prose" or a card's template, in order)."""
    fields: dict[str, Any] = {"ok": True, "generation": caller.state.generation, "violations": [],
                              **shown_blocks(blocks)}
    if language is not None:
        fields["language"] = language
    return Expect(fields=fields)


def handed_off(caller: Caller, kind: str) -> Expect:
    """A failed check: a `kind` violation, and only the handoff clause to show."""
    return Expect(fields={"ok": False, "generation": caller.state.generation, "violations.0.kind": kind,
                          **shown_blocks(HANDED_OFF)})


def offered(caller: Caller, kind: str, language: str = "en") -> Expect:
    """A check failed only for its prose with no card to keep: a `kind` violation, and only the
    kernel's call-back offer to show, as prose in `language`."""
    return Expect(fields={"ok": False, "generation": caller.state.generation, "violations.0.kind": kind,
                          **shown_blocks(OFFERED), "blocks.0.text": OFFER[language]})


def status_lined(caller: Caller, kind: str, language: str = "en") -> Expect:
    """A check failed only for its prose, with no card to keep, while a held request awaits the owner: a `kind`
    violation, and only the kernel's status line to show, as prose in `language`."""
    return Expect(fields={"ok": False, "generation": caller.state.generation, "violations.0.kind": kind,
                          **shown_blocks(OFFERED), "blocks.0.text": STATUS_LINES["check_status"][language]})


async def owner_says(k: KernelHarness, desk: GoldenDesk, session: Caller, text: str, *, expect: Expect) -> Any:
    """The owner's say into a session (`POST /owner/messages`, Plan 01b)."""
    return await k.call(
        "POST /owner/messages",
        body={"session_id": session.state.session_id, "text": text, "kind": "say"},
        auth=desk.owner,
        expect=expect,
    )


def said_verbatim(text: str) -> Expect:
    """An owner say's result: a passing verdict with one `owner_said` card holding the text verbatim."""
    return Expect(fields={"verdict.ok": True, "verdict.violations": [], "verdict.blocks": {"$len": 1},
                          "verdict.blocks.0.kind": "card", "verdict.blocks.0.template": "owner_said",
                          "verdict.blocks.0.text": text})


async def owner_statement(k: KernelHarness, records: Any, desk: GoldenDesk, session: Caller) -> str:
    """The `owner_statement` fact an owner say leaves in `session`, by its id."""
    result: OwnerMessageResult = await owner_says(k, desk, session, OWNER_SAY, expect=said_verbatim(OWNER_SAY))
    if not k.is_real:
        return f"owner:{result.message_id}"
    reader = f"session:{session.state.session_id}"
    found = [row["fact_id"] for row in await records.facts(desk.copy.copy_id)
             if row["desk_id"] == desk.desk_id and row["kind"] == "owner_statement" and reader in row["readers"]]
    assert len(found) == 1, f"expected one owner_statement fact readable by {reader}, found {found}"
    return found[0]


async def booking_fact(k: KernelHarness, fake: FakeAnthropic, desk: GoldenDesk, session: Caller) -> str:
    """The session's booking of the seed's weekday slot, which the seed's reviewed `rv-book-wk` card
    allows once the reviewer passes it, executed: the id of the `booking` fact it wrote, the id a
    `booking_confirmed` clause cites (on the stub, a stand-in shaped like the kernel's)."""
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))
    session.turn()
    decision = await decide(k, session, "native.book", book_args(desk.slots["wk"].slot_id),
                            expect=Expect(fields={"outcome": "allow", "state": "allowed"}))
    result = await k.call(
        "POST /execute",
        body={"decision_id": decision.decision_id, "session_id": session.state.session_id,
              "generation": session.state.generation},
        auth=session.auth,
        expect=Expect(fields={"state": "succeeded"}),
    )
    if not k.is_real:
        return "booking:stub-booking"
    found = [fact.fact_id for fact in result.facts if fact.kind == "booking"]
    assert len(found) == 1, f"the booking wrote {len(found)} booking facts: {[f.fact_id for f in result.facts]}"
    return found[0]


async def cite_facts(
    k: KernelHarness, fake: FakeAnthropic, records: Any, desk: GoldenDesk, caller: Caller, row: ReplyRow
) -> dict[str, str]:
    """The fact id for each role the row's clauses name: the caller's own drain quote or booking,
    another visitor's, or an owner statement in another visitor's session."""
    roles = {clause.fact for clause in row.clauses if clause.fact is not None}
    facts = {}
    if roles & {"own-quote", "own-payment-link"}:
        facts["own-quote"] = await make_quote_fact(k, desk, caller, "drain")
    if "own-payment-link" in roles:
        fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))
        caller.turn()
        decision = await decide(k, caller, "native.payment_link",
                                payment_link_args(facts["own-quote"].removeprefix("quote:")),
                                expect=Expect(fields={"outcome": "allow", "state": "allowed"}))
        result = await k.call("POST /execute", body={"decision_id": decision.decision_id,
                              "session_id": caller.state.session_id, "generation": caller.state.generation},
                              auth=caller.auth, expect=Expect(fields={"state": "succeeded"}))
        facts["own-payment-link"] = (next(f.fact_id for f in result.facts if f.kind == "payment_link")
                                     if k.is_real else "payment_link:stub-link")
    if "other-session-quote" in roles:
        other = await open_caller(k, desk, "visitor")
        facts["other-session-quote"] = await make_quote_fact(k, desk, other, "drain")
    if "own-booking" in roles:
        facts["own-booking"] = await booking_fact(k, fake, desk, caller)
    if "other-session-booking" in roles:
        other = await open_caller(k, desk, "visitor")
        facts["other-session-booking"] = await booking_fact(k, fake, desk, other)
    if "other-session-owner-statement" in roles:
        other = await open_caller(k, desk, "visitor")
        facts["other-session-owner-statement"] = await owner_statement(k, records, desk, other)
    return facts


async def travel_past_expiry(
    k: KernelHarness, records: Any, desk: GoldenDesk, caller: Caller, fact_ids: list[str]
) -> None:
    """Travel past the facts' `expires_at` in hops, the session reading its context after each so
    it never sits idle long enough to close."""
    if k.is_real:
        rows = {row["fact_id"]: row for row in await records.facts(desk.copy.copy_id) if row["desk_id"] == desk.desk_id}
        missing = [fact_id for fact_id in fact_ids if fact_id not in rows or rows[fact_id]["expires_at"] is None]
        assert not missing, f"facts with no expires_at to travel past: {missing}"
        until = max(rows[fact_id]["expires_at"] for fact_id in fact_ids)
    else:
        until = k.clock.now() + QUOTE_LIFE   # the stub's stand-in for the quotes' expires_at
    while k.clock.now() <= until:
        k.clock.advance(min(KEEP_ALIVE_S, (until - k.clock.now()).total_seconds() + 60))
        await k.call("GET /context/{session_id}?desk_id=", path={"session_id": caller.state.session_id},
                     auth=caller.auth)


async def set_mode(k: KernelHarness, desk: GoldenDesk, session: Caller, mode: str) -> Any:
    """The owner takes the session over ("owner") or hands it back ("ai"); either moves its generation on."""
    session_id = session.state.session_id
    return await k.call(
        "POST /sessions/{id}/mode",
        path={"id": session_id},
        body={"mode": mode, "generation": session.state.generation},
        auth=desk.owner,
        expect=Expect(fields={"session_id": session_id, "mode": mode}),
    )


async def signing_key(k: KernelHarness) -> str:
    return (await k.call("GET /health", auth=Auth.none())).public_key_hex


def visible_hits(verdict: ReplyVerdict) -> list[tuple[str, str, str]]:
    """Every amount, percentage or date the evals' scanner finds in the verdict's visible free text,
    but a numbered list's markers in its prose, as the kernel reads them (`blank_list_markers`: a list
    from 1 of at most nine items, the owner's decision of 2026-11-01, which covers this check)."""
    prose = {block.text for block in verdict.blocks if block.kind == "prose"}
    return [(text, hit.kind, hit.span) for text in visible_texts(verdict)
            for hit in scan_visible(blank_list_markers(text) if text in prose else text)]


async def ledger_head(records: Any, desk: GoldenDesk) -> int:
    entries = await records.ledger_entries(desk.copy.copy_id, desk.desk_id)
    return entries[-1].seq if entries else 0


async def ledgered_since(records: Any, desk: GoldenDesk, seq: int) -> list[LedgerEntry]:
    return [entry for entry in await records.ledger_entries(desk.copy.copy_id, desk.desk_id) if entry.seq > seq]


async def assert_auth_ledgered(records: Any, desk: GoldenDesk, session_id: str, since: int) -> None:
    """A refused session call wrote an `auth` entry on the session's Desk ("Session state responses")."""
    entries = [entry.event for entry in await ledgered_since(records, desk, since) if entry.event.kind == "auth"]
    assert entries, "the refused draft wrote no auth entry"
    assert all(event.session_id in (None, session_id) for event in entries), entries


# The table

@pytest.mark.parametrize(
    "row", [pytest.param(row, id=row.id, marks=pytest.mark.requires(*row.requires)) for row in ROWS]
)
async def test_reply_row(k: KernelHarness, fake: FakeAnthropic, records, row: ReplyRow):
    desk = await golden_desk(k)
    caller = await open_caller(k, desk, "visitor")
    if row.soft_promise == "denies_ai":   # the fixture only tests the flag if its prose really denies being an AI
        assert denies_ai(row.prose), f"{row.id}'s prose must deny being an AI: {row.prose!r}"
    made_from = k.clock.now()
    facts = await cite_facts(k, fake, records, desk, caller, row)
    made_until = k.clock.now()   # a quote the row cites was made in between, which pins its expiry
    if row.setup == "session_language_es":   # the session's last language becomes Spanish
        await check_reply(k, caller, CLEAN_ES, expect=passes(caller, ["prose"], language="es"))
    elif row.setup == "travel_past_expiry":
        cited = [facts[clause.fact] for clause in row.clauses if clause.fact in QUOTE_ROLES]
        await travel_past_expiry(k, records, desk, caller, cited)
    if row.soft_promise != "pass":   # one reply; a second try would get the default pass, and is caught below
        fake.script(SOFT_PROMISE_MODEL, SOFT_PROMISE_REPLIES[row.soft_promise], schema="SoftPromiseVerdict")
    checks_before = len(fake.calls(SOFT_PROMISE_MODEL, schema="SoftPromiseVerdict"))
    verdict = await check_reply(
        k, caller, row.prose, row.draft_clauses(facts), final=row.final,
        expect=row.verdict_expect(caller.state.generation, facts)
    )

    if k.is_real:
        assert not (mismatches := row.kind_mismatches(verdict)), mismatches
        assert verify_verdict_sig(caller.state.session_id, verdict, await signing_key(k)), "the verdict's signature"
        assert not (hits := visible_hits(verdict)), f"the evals' scanner reads amounts or dates in visible text: {hits}"
        for block in verdict.blocks:
            if block.template == "handoff":
                assert OWNER in block.text, f"the handoff names {OWNER}: {block.text!r}"
            if block.template == "quote":   # every quote a row cites is one drain clearing at list price
                problems = card_amount_problems(
                    block, {P}, headline=P, percents=(), items=[SEED_TITLES["drain"]],
                    expires=quote_expiries(made_from, made_until, row.expect.language))
                assert not problems, f"the quote card, for one drain clearing at {P} cents: {problems}"
        if row.soft_promise != "pass" or (row.expect.ok and row.prose):
            assert len(fake.calls(SOFT_PROMISE_MODEL, schema="SoftPromiseVerdict")) - checks_before == 1, (
                "one soft-promise check: no recheck and no fallback")
        if row.soft_promise == "denies_ai":   # the only model-free handling of a reply that denies being an AI
            denials = [violation for violation in verdict.violations if violation.kind == "soft_promise"]
            assert denials and all(violation.rule_id == DENIES_AI_RULE_ID for violation in denials), (
                f"a reply the check read as denying it is an AI is {DENIES_AI_RULE_ID}: "
                f"{[violation.rule_id for violation in denials]}")


# Session states

@pytest.mark.requires("01a")
async def test_draft_at_old_generation_409(k: KernelHarness, records):
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    old, session_id = visitor.state.generation, visitor.state.session_id
    for mode in ("owner", "ai"):   # take over, then hand back: the generation moves on twice
        visitor.state = await set_mode(k, desk, visitor, mode)
    if k.is_real:
        assert visitor.state.generation > old
        since = await ledger_head(records, desk)
    stale = Expect(status=409, fields={"code": "stale_generation"})
    await check_reply(k, visitor, CLEAN_EN, generation=old, expect=stale)
    if k.is_real:
        await assert_auth_ledgered(records, desk, session_id, since)


@pytest.mark.requires("01a")
async def test_draft_in_owner_mode_409(k: KernelHarness, records):
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    session_id = visitor.state.session_id
    visitor.state = await set_mode(k, desk, visitor, "owner")
    if k.is_real:
        since = await ledger_head(records, desk)
    await check_reply(k, visitor, CLEAN_EN, expect=Expect(status=409, fields={"code": "mode_owner"}))
    if k.is_real:
        await assert_auth_ledgered(records, desk, session_id, since)


@pytest.mark.requires("01a")
async def test_paused_session_gets_only_the_handoff(k: KernelHarness, fake: FakeAnthropic):
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    await confirm_cards(k, desk, [
        RuleCard(card_id="g-auto-quote-reviewed", applies_to="native.quote", mode="auto", who="anyone", review=True,
                 reason="Quotes at list price, checked by the reviewer."),
    ])
    block = Json({**REVIEW_PASS, "recommendation": "block"})
    fake.script(REVIEWER_MODEL, block, block, block)
    for _ in range(3):   # three blocks trip the breaker
        await decide(k, visitor, "native.quote", quote_args("drain"), expect=Expect(fields={"outcome": "hold"}))
    whoami = await k.call("GET /whoami", auth=visitor.auth, expect=Expect(fields={
        "session.session_id": visitor.state.session_id, "session.mode": "paused"}))
    visitor.state = whoami.session

    verdict = await check_reply(k, visitor, CLEAN_EN, expect=Expect(fields={
        "ok": False, "violations": {"$len": 1}, "violations.0.kind": "session_paused",
        "blocks": {"$len": 1}, "blocks.0.kind": "card", "blocks.0.template": "handoff",
    }))
    if k.is_real:
        assert verify_verdict_sig(visitor.state.session_id, verdict, await signing_key(k))
        assert OWNER in verdict.blocks[0].text


# Owner say and whisper

@pytest.mark.requires("01b")
async def test_owner_say_renders_verbatim_and_signs(k: KernelHarness):
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    text = "It's forty dollars today, Dana"   # an owner say may name a price: the number rule doesn't apply
    result = await owner_says(k, desk, visitor, text, expect=said_verbatim(text))
    if k.is_real:
        assert verify_verdict_sig(visitor.state.session_id, result.verdict, await signing_key(k))


@pytest.mark.requires("01b")
async def test_owner_whisper_has_no_verdict_and_is_ledgered(k: KernelHarness, records):
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    result = await k.call(
        "POST /owner/messages",
        body={"session_id": visitor.state.session_id, "text": "She sounds worried about cost, so go gently.",
              "kind": "whisper"},
        auth=desk.owner,
        expect=Expect(fields={"verdict": None}),
    )
    context = await k.call("GET /context/{session_id}?desk_id=", path={"session_id": visitor.state.session_id},
                           auth=visitor.auth)
    if k.is_real:
        entries = [entry for entry in await records.ledger_entries(desk.copy.copy_id, desk.desk_id)
                   if entry.seq == result.ledger_seq]
        assert [entry.event.kind for entry in entries] == ["whisper"], entries
        assert entries[0].event.session_id in (None, visitor.state.session_id), entries
        # A whisper creates no fact, so nothing of it can reach the visitor through a card.
        assert [fact.fact_id for fact in context.facts if fact.kind == "owner_statement"] == []


@pytest.mark.requires("01b")
async def test_owner_say_with_a_canary_is_blocked(k: KernelHarness, records):
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    canary = (await records.document_canaries(desk.copy.copy_id))[0] if k.is_real else STAND_IN_CANARY
    if k.is_real:
        since = await ledger_head(records, desk)
    result = await owner_says(k, desk, visitor, f"Your invoice reference is {canary}.", expect=Expect(fields={
        "verdict.ok": False, "verdict.violations.0.kind": "canary", "verdict.blocks": [],   # no handoff for a say
    }))
    if k.is_real:
        assert {violation.kind for violation in result.verdict.violations} == {"canary"}, result.verdict.violations
        assert verify_verdict_sig(visitor.state.session_id, result.verdict, await signing_key(k))
        assert canary not in json.dumps(result.model_dump(mode="json")), "the blocked say's result echoes the canary"
        echoed = [entry.seq for entry in await ledgered_since(records, desk, since)
                  if canary in json.dumps(entry.model_dump(mode="json"))]
        assert echoed == [], f"ledger entries {echoed} hold the canary"


# Signatures, the soft-promise call and visitor-bound text

@pytest.mark.requires("01a")
async def test_verdict_signatures_verify_independently(k: KernelHarness):
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    quote = await make_quote_fact(k, desk, visitor, "drain")
    verdicts = [
        await check_reply(k, visitor, CLEAN_EN, expect=passes(visitor, ["prose"])),
        await check_reply(k, visitor, NUMBER_PROSE, expect=offered(visitor, "number_in_prose")),
        await check_reply(k, visitor, FRENCH_PROSE, expect=handed_off(visitor, "unsupported_language")),
        await check_reply(k, visitor, QUOTE_PROSE, [{"template": "quote", "fact_id": quote}],
                          expect=passes(visitor, ["prose", "quote"])),
    ]
    key = await signing_key(k)
    if k.is_real:
        session_id = visitor.state.session_id
        for verdict in verdicts:
            assert verify_verdict_sig(session_id, verdict, key), verdict
        # The check bites: an edited card, another generation or another session fails it.
        signed = verdicts[-1].model_dump(mode="json")
        edited = json.loads(json.dumps(signed))
        edited["blocks"][-1]["title"] = "$1.00"
        assert not verify_verdict_sig(session_id, edited, key)
        assert not verify_verdict_sig(session_id, {**signed, "generation": signed["generation"] + 1}, key)
        other = await open_caller(k, desk, "visitor")
        assert not verify_verdict_sig(other.state.session_id, signed, key)


@pytest.mark.requires("01a")
async def test_soft_promise_check_runs_on_sonnet_once_per_draft(k: KernelHarness, fake: FakeAnthropic):
    assert SOFT_PROMISE_MODEL == "claude-sonnet-5-5"
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    for prose in (CLEAN_EN, "You may want to ask Mike about that."):   # plain ASCII, so it reads back from the request
        all_before, before = len(fake.calls()), len(fake.calls(SOFT_PROMISE_MODEL, schema="SoftPromiseVerdict"))
        await check_reply(k, visitor, prose, expect=passes(visitor, ["prose"]))
        if k.is_real:
            checks = fake.calls(SOFT_PROMISE_MODEL, schema="SoftPromiseVerdict")[before:]
            assert len(checks) == 1, f"{len(checks)} soft-promise calls for one draft"
            assert len(fake.calls()) - all_before == 1, "a model other than the soft-promise check's was called"
            assert prose in json.dumps(checks[0]), "the soft-promise check didn't read this draft's prose"


@pytest.mark.requires("01a")
async def test_visitor_bound_kernel_text_has_no_digits(k: KernelHarness, fake: FakeAnthropic):
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))   # the reviewer passes, if the kernel asks it
    held = await decide(k, visitor, "native.quote", quote_args("drain", requested_discount_bp=1500),
                        expect=Expect(fields={"outcome": "hold", "state": "held"}))   # rv-quote allows no discount
    quote = await make_quote_fact(k, desk, visitor, "drain")
    verdicts = [
        await check_reply(k, visitor, CLEAN_EN, expect=passes(visitor, ["prose"])),
        await check_reply(k, visitor, NUMBER_PROSE, expect=status_lined(visitor, "number_in_prose")),   # held
        await check_reply(k, visitor, QUOTE_PROSE, [{"template": "quote", "fact_id": quote}],
                          expect=passes(visitor, ["prose", "quote"])),
    ]
    if k.is_real:
        texts = visible_texts([called.raw for called in k.responses])
        for shown in (held.visitor_plain, *(verdict.visitor_plain for verdict in verdicts)):
            assert shown in texts, f"{shown!r} wasn't among the visible texts scanned"
        hits = [(text, hit.kind, hit.span) for text in texts for hit in scan_visible(text)
                if hit.kind in ("digit", "currency", "percent")]
        assert hits == [], f"visitor-bound kernel text carries digits or money: {hits}"


@pytest.mark.requires("01c")
async def test_unmarked_payment_caption_rewrites_then_delivers(k: KernelHarness, fake: FakeAnthropic, records):
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    row = next(row for row in ROWS if row.id == "c-unmarked-payment-rewrite")
    facts = await cite_facts(k, fake, records, desk, visitor, row)
    clauses = row.draft_clauses(facts)
    await check_reply(k, visitor, row.prose, clauses, final=False,
                      expect=row.verdict_expect(visitor.state.generation, facts))
    verdict = await check_reply(k, visitor, "Here is the link to pay.", clauses, final=True,
                                expect=passes(visitor, ["prose", "payment_link"]))
    if k.is_real:
        assert verify_verdict_sig(visitor.state.session_id, verdict, await signing_key(k))
        events = [e.event for e in await records.ledger_entries(desk.copy.copy_id, desk.desk_id)
                  if e.event.session_id == visitor.state.session_id]
        assert not [e for e in events if e.kind == "desk_data" and e.summary.get("part") == "handoffs"]
