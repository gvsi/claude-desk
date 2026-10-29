"""The golden /decide table: overlap and coverage, discounts, hours, reviewer handling, the seed's
cards, people, money and agents.

Each row of `golden/decide.yaml` is one case on its own golden Desk (`golden_desk.py`), gated by
the plans the row requires: the caller opens its session (verifying or minting a demo agent where
the row says so), gets any quote its call names, the owner drafts and confirms the row's cards,
the reviewer's reply is scripted, and the call's decision must be the row's. Four cases follow the
table: the strike breaker, an erroring forbid from Python, and setup probes against the same drafts.
"""

import json
from pathlib import Path

import pytest

from desk.contracts import RuleCard
from evals.fakes import FakeAnthropic, Json
from evals.tier1.args import find_slots_args, quote_args
from evals.tier1.golden_desk import (
    P,
    RESOURCE_KINDS,
    REVIEW_PASS,
    REVIEWER_MODEL,
    Row,
    call_args,
    check_args_schema,
    confirm_cards,
    decide,
    draft_cards,
    golden_desk,
    load_rows,
    open_caller,
    reviewer_reply,
    session_row,
)
from evals.tier1.harness import Expect, KernelHarness

ROWS = load_rows()
ROWS_BY_ID = {row.id: row for row in ROWS}
FIXTURES = Path(__file__).resolve().parents[2] / "kernel" / "cedar" / "fixtures"


@pytest.mark.parametrize(
    "row", [pytest.param(row, id=row.id, marks=pytest.mark.requires(*row.requires)) for row in ROWS]
)
async def test_decide_row(k: KernelHarness, fake: FakeAnthropic, records, row: Row):
    desk = await golden_desk(k, custom=row.call.needs_custom)
    caller = await open_caller(k, desk, row.caller)
    args = await call_args(k, desk, caller, row.call)   # a payment link or charge gets its quote first
    if row.raw_args is not None:
        args = {**args, **row.raw_args}
    version = None
    if row.cards is not None:
        version = await confirm_cards(k, desk, [spec.card(desk) for spec in row.cards])
    elif row.seed == "answering-off":
        await k.call(
            "PUT /desks/{id}/answering",
            path={"id": desk.desk_id},
            body={"on": False},
            auth=desk.owner,
            expect=Expect(fields={"desk_id": desk.desk_id}),
        )
    if row.reviewer is not None:
        reply, required = reviewer_reply(row.reviewer)
        if required:
            fake.script(REVIEWER_MODEL, reply)   # one reply: a second reviewer call is unscripted and fails the case
        else:
            fake.default(REVIEWER_MODEL, reply)
    caller.turn()
    if row.raw_args is None:
        await check_args_schema(k, caller, row.call.tool, args)
    await decide(k, caller, row.call.tool, args, expect=row.decision_expect())

    checks = row.checks
    if k.is_real:
        if checks.reviewer_calls is not None:
            assert len(fake.calls(REVIEWER_MODEL)) == checks.reviewer_calls
        if checks.strikes is not None:
            assert (await session_row(records, desk, caller))["strikes"] == checks.strikes
        if checks.default_ask is not None:
            assert version is not None
            assert [
                card.card_id for card in version.cards
                if card.is_default and card.mode == "ask" and card.who == "anyone"
                and card.applies_to == checks.default_ask
            ], f"the confirmed version has no default ask card for {checks.default_ask}: {version.cards}"


@pytest.mark.requires("01a")
async def test_three_blocks_pause_until_owner_resumes(k: KernelHarness, fake: FakeAnthropic, records):
    desk = await golden_desk(k)
    visitor = await open_caller(k, desk, "visitor")
    await confirm_cards(k, desk, [
        RuleCard(card_id="g-auto-quote-reviewed", applies_to="native.quote", mode="auto", who="anyone", review=True,
                 reason="Quotes at list price, checked by the reviewer."),
        RuleCard(card_id="g-auto-find-slots", applies_to="native.find_slots", mode="auto", who="anyone",
                 reason="Anyone can see open times."),
    ])
    block = Json({**REVIEW_PASS, "recommendation": "block"})
    fake.script(REVIEWER_MODEL, block, block, block)
    held = Expect(fields={"outcome": "hold", "state": "held"})
    blocked = [await decide(k, visitor, "native.quote", quote_args("drain"), expect=held) for _ in range(3)]

    whoami = await k.call(
        "GET /whoami",
        auth=visitor.auth,
        expect=Expect(fields={"session.session_id": visitor.state.session_id, "session.mode": "paused"}),
    )
    visitor.state = whoami.session
    if k.is_real:
        assert len(fake.calls(REVIEWER_MODEL)) == 3
        session = await session_row(records, desk, visitor)
        assert (session["strikes"], session["mode"]) == (3, "paused")
        breaker = [
            entry.event.summary for entry in await records.ledger_entries(desk.copy.copy_id, desk.desk_id)
            if entry.event.kind == "breaker" and entry.event.session_id == visitor.state.session_id
        ]
        assert [summary["strike"] for summary in breaker if "strike" in summary] == [1, 2, 3], breaker
        assert [summary for summary in breaker if summary.get("paused") is True], breaker
        # The third decision carries the pause's owner alert beside its own hold alert.
        assert len(blocked[2].inbox) == len(blocked[0].inbox) + 1, [decision.inbox for decision in blocked]

    refused = Expect(fields={"outcome": "refuse", "state": "refused"})   # paused: a 200 refusal, whatever the rules
    await decide(k, visitor, "native.find_slots", find_slots_args(), expect=refused)
    visitor.state = await k.call(
        "POST /sessions/{id}/mode",
        path={"id": visitor.state.session_id},
        body={"mode": "ai", "generation": visitor.state.generation},
        auth=desk.owner,
        expect=Expect(fields={"mode": "ai"}),
    )
    allowed = Expect(fields={"outcome": "allow", "state": "allowed"})
    await decide(k, visitor, "native.find_slots", find_slots_args(), expect=allowed)

    if k.landed("01b"):
        inbox = await k.call("GET /demo_inbox", auth=desk.owner)
        if k.is_real:   # the third decision's owner notices, the pause's among them, are alerts in the owner's inbox
            alerts = {entry.entry_id for entry in inbox if entry.kind == "alert"}
            notices = {notice.entry_id for notice in blocked[2].inbox if notice.to == "owner"}
            assert notices and notices <= alerts, (notices, alerts)


@pytest.mark.requires("master")
@pytest.mark.white_box
def test_erroring_forbid_refuses_from_python():
    """A baseline forbid whose condition overflows refuses: Cedar alone would skip it and allow.
    Unreachable over HTTP, since `never_errors` rejects any draft holding such a forbid."""
    import desk_kernel

    def fixture(name: str) -> str:
        return (FIXTURES / name).read_text()

    engine = desk_kernel.PolicyEngine(fixture("baseline.cedar") + "\n" + fixture("erroring_forbid.cedar"))
    sets = {"F": "", "A": fixture("auto.cedar"), "H": fixture("hold.cedar")}
    assert engine.load("golden-erroring:1", fixture("schema.cedarschema.json"), json.dumps(sets)) == []

    def payment_link(amount_cents: int) -> str:
        visitor = {"uid": {"type": "Visitor", "id": "session-v"},
                   "attrs": {"verified": False, "assurance": "none", "copy": "copy-1"}, "parents": []}
        quote = {"uid": {"type": "Quote", "id": "quote-1"}, "attrs": {"copy": "copy-1"}, "parents": []}
        context = {"amount_cents": amount_cents, "record_owner_match": False, "local_dow": 2, "local_minute": 600}
        return json.dumps({"principal": visitor["uid"], "action": "native.payment_link", "resource": quote["uid"],
                           "context": context, "entities": [visitor, quote]})

    # Below the overflow the forbid's condition is false, and the deposit card allows the link.
    assert json.loads(engine.decide("golden-erroring:1", payment_link(500), "final"))["outcome"] == "allow"
    for phase in ("pre", "final"):
        verdict = json.loads(engine.decide("golden-erroring:1", payment_link(2000), phase))
        assert verdict["outcome"] == "refuse", (phase, verdict)
        assert "overflowing_amount_check" in json.dumps(verdict["errors"]), (phase, verdict)


# The rows a setup probe can stand in for: the 01a card rows the reviewer plays no part in, and
# every hours row (01a and 01b), each probed for an unverified visitor ("anyone").
PROBED = [
    row for row in ROWS
    if row.cards is not None and row.reviewer is None and (row.requires == ["01a"] or row.id.startswith("hours-"))
]


def probe_for(desk, row: Row) -> dict:
    """The row's call as a setup probe: who "anyone", the tool's resource kind, P as the stand-in
    price on quote rows, and the slot's start on hours rows. A dict, since `starts_at` arrives
    with master Task 2b's `Probe`."""
    call = row.call
    probe = {
        "actor": "visitor",
        "who": "anyone",
        "call": {"call_id": f"probe-{row.id}", "tool": call.tool, "args": call.static_args(desk)},
        "resource_kind": RESOURCE_KINDS[call.tool],
    }
    if call.tool == "native.quote":
        probe["amount_cents"] = P
    if row.id.startswith("hours-"):
        probe["starts_at"] = desk.slot(call.slot).starts_at.isoformat()
    return probe


@pytest.mark.requires("01c-setup")
async def test_probes_agree_with_session_decisions(k: KernelHarness):
    assert len(PROBED) == 23 and all(row.caller == "visitor" for row in PROBED), [row.id for row in PROBED]
    desk = await golden_desk(k)
    for row in PROBED:
        draft = await draft_cards(k, desk, [spec.card(desk) for spec in row.cards])
        await k.call(
            "POST /policy/{version}/probe",
            path={"version": draft.version},
            body={"desk_id": desk.desk_id, "probes": [probe_for(desk, row)]},
            auth=desk.owner,
            expect=Expect(fields={"0.outcome": row.outcome}),
        )


@pytest.mark.requires("01c-setup")
async def test_review_gated_probe_holds_without_a_reviewer(k: KernelHarness, fake: FakeAnthropic):
    row = ROWS_BY_ID["review-pass"]
    desk = await golden_desk(k)
    draft = await draft_cards(k, desk, [spec.card(desk) for spec in row.cards])
    await k.call(
        "POST /policy/{version}/probe",
        path={"version": draft.version},
        body={"desk_id": desk.desk_id, "probes": [probe_for(desk, row)]},
        auth=desk.owner,
        expect=Expect(fields={"0.outcome": "hold", "0.depends_on_review": True}),
    )
    if k.is_real:
        assert fake.calls(REVIEWER_MODEL) == []
