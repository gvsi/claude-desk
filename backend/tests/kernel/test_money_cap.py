"""The money cap on each rules version (master plan, "Money cap").

Each rules version carries the most an auto rule may take or pay out in one action without asking
(`auto_money_cap_cents`), and the Desk's cap is always its active version's. Unset is 0, so every
charge and payout asks; no cap is ever above `AUTO_MONEY_HARD_CAP_CENTS`, the $10,000 platform
ceiling. Four checks hold it at the same number, each on its own: card validation at draft and
again at confirm, the compiler's amount bound, the baseline's `auto_money_cap` forbid (which reads
the cap of the version being evaluated from the context) and the auto invariants, rendered at each
version's cap and proved for every version. A cap changes only through a draft the owner confirms.

Tests run on a Desk from `POST /desks` (version 1 at 0), or on a Rivera copy (version 1 at $500)
where a test needs people, with a fake `native.payment_link` enabled whose amount each test sets.
A test that proves or confirms a draft needs the solver (`solver`).
"""

import json
import logging
import re
from datetime import time
from pathlib import Path

import desk_kernel
import httpx
import psycopg
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk import money_cap
from desk.contracts import AUTO_MONEY_HARD_CAP_CENTS, Decision, HoursWindow, RuleCard
from desk.contracts import PolicyVersion as PolicyVersionContract
from desk.db.models import Desk, Person, PolicyVersion
from desk.db.session import COPY_SETTING, database_url, libpq_url
from desk.kernel_service import activation, adapters, compiler, render
from desk.kernel_service.seed import RIVERA_CARDS
from desk.money_cap import lower_to_cap

from .fakes import FakeAdapter
from .helpers import compile_at, context, draft_and_confirm, kernel_ctx, rows_of, verify_session
from .test_adapters import Rivera, quote_args, rivera
from .test_decide import Visitor, activate_sets, decided, open_visitor, payment_link, verify_signature
from .test_desk_writes import new_desk, post_desk
from .test_verification import api_rows

BACKEND = Path(__file__).resolve().parents[2]

# A test-only auto set that permits everything, annotated so it lints; its @applies_to names every
# money effect, so decision step 5 counts it as an owner card for money (as in test_cedar.py).
PERMIT_ALL = ('@id("test_permit_all") @card("test-permit-all") @tier("auto") '
              '@applies_to("effect:charge,effect:pay_out")\npermit (principal, action, resource);')


def charge_card(card_id: str, cents: int, **fields) -> RuleCard:
    return RuleCard(card_id=card_id, applies_to="effect:charge", mode="auto", who="anyone", max_amount_cents=cents,
                    reason="Payment links up to a limit.", **fields)


async def enable(app: FastAPI, desk: Rivera, fake: FakeAdapter) -> FakeAdapter:
    """Registers `fake` as its tool's adapter and enables it on the Desk."""
    adapters.register(fake, replace=True)
    async with kernel_ctx(app) as ctx:
        ctx.bind(desk.copy_id)
        ctx.db.add(fake.tools_row(desk.copy_id, desk.desk_id))
    return fake


async def lopez_desk(app: FastAPI, client: httpx.AsyncClient, link: FakeAdapter) -> Rivera:
    """A new Desk from `POST /desks` in a fresh copy, answering, with `link` enabled."""
    copy = await rivera(app, client)
    response = await post_desk(client, copy, new_desk())
    assert response.status_code == 200, response.text
    created = response.json()
    desk = Rivera(copy_id=copy.copy_id, desk_id=created["desk_id"], slug=created["slug"],
                  owner_token=copy.owner_token)
    response = await client.put(f"/desks/{desk.desk_id}/answering", headers=desk.owner, json={"on": True})
    assert response.status_code == 200, response.text
    await enable(app, desk, link)
    return desk


async def versions_of(app: FastAPI, desk: Rivera) -> dict[int, PolicyVersion]:
    rows = await rows_of(app, desk.copy_id, select(PolicyVersion).where(PolicyVersion.desk_id == desk.desk_id))
    return {row.version: row for row in rows}


async def post_draft(client: httpx.AsyncClient, desk: Rivera, cards: list[RuleCard], parent: int | None,
                     **fields) -> httpx.Response:
    return await client.post("/policy/draft", headers=desk.owner, json={
        "desk_id": desk.desk_id, "cards": [card.model_dump(mode="json") for card in cards],
        "expected_parent": parent, **fields})


async def link_for(client: httpx.AsyncClient, visitor: Visitor, link: FakeAdapter, cents: int, call_id: str):
    link.script["normalize"] = payment_link(cents).script["normalize"]
    return await decided(client, visitor, "native.payment_link", call_id=call_id)


async def test_unset_cap_holds_every_money_action(app, client, registry):
    link = payment_link(1)
    desk = await lopez_desk(app, client, link)
    assert (await versions_of(app, desk))[1].auto_money_cap_cents == 0
    await activate_sets(app, desk, A=PERMIT_ALL)                 # version 2, at the cap of version 1: 0
    parent = 2
    assert (await versions_of(app, desk))[parent].auto_money_cap_cents == 0
    visitor = await open_visitor(client, desk)
    for cents in (1, 1_000_000):
        held = await link_for(client, visitor, link, cents, call_id=f"link-{cents}")
        assert held.outcome == "hold", (cents, held)
        assert held.policy_version == parent
    # an auto charge card above the unset cap is refused at draft, and nothing is written
    response = await post_draft(client, desk, [charge_card("links", 2_000)], parent)
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert sorted(await versions_of(app, desk)) == [1, parent]


def draft_refusals(caplog: pytest.LogCaptureFixture) -> list[str]:
    """The reasons the kernel logged for the drafts it refused, in order."""
    return [match.group(1) for record in caplog.records
            if (match := re.fullmatch(r"kernel_failure route=POST /policy/draft status=422 code=invalid reason=(\S+)",
                                      record.getMessage()))]


async def test_a_draft_refused_for_the_cap_is_named_by_its_cards(app, client, registry, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="desk.kernel_service")
    desk = await lopez_desk(app, client, payment_link(1))                      # version 1, at a cap of 0
    above = [charge_card("links", 2_000)]
    asks = [RuleCard(card_id="links", applies_to="effect:charge", mode="ask", who="anyone", reason="Links ask.")]
    response = await post_draft(client, desk, above, 1)
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    # the reason comes from the cards themselves, never from the wording of the check's errors
    worded = {"words that name the cap": [f"card 1: {compiler.ABOVE_MONEY_CAP}: some other reason"],
              "words that don't": ["links: the card doesn't meet the rule card checks"]}
    for words in worded.values():
        monkeypatch.setattr(compiler, "validate_cards", lambda *args, words=words, **kwargs: words)
        for cards in (asks, above):
            response = await post_draft(client, desk, cards, 1)
            assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert draft_refusals(caplog) == ["above_money_cap", "invalid_cards", "above_money_cap", "invalid_cards",
                                      "above_money_cap"]
    assert sorted(await versions_of(app, desk)) == [1]


@pytest.mark.solver
async def test_cap_bounds_auto_money_below_at_and_above(desk_prove, app, client, registry):
    link = payment_link(1)
    desk = await lopez_desk(app, client, link)
    version = await draft_and_confirm(client, desk.owner_token, desk.desk_id, [charge_card("links", 8_000)],
                                      auto_money_cap_cents=8_000)
    assert (version.status, version.auto_money_cap_cents) == ("active", 8_000)
    visitor = await open_visitor(client, desk)
    outcomes = {cents: (await link_for(client, visitor, link, cents, call_id=f"link-{cents}")).outcome
                for cents in (7_999, 8_000, 8_001)}
    assert outcomes == {7_999: "allow", 8_000: "allow", 8_001: "hold"}


async def policy_entries(client: httpx.AsyncClient, desk: Rivera) -> list[dict]:
    response = await client.get(f"/ledger/{desk.desk_id}", headers=desk.owner)
    assert response.status_code == 200, response.text
    return [entry["event"]["summary"] for entry in response.json()["entries"] if entry["event"]["kind"] == "policy"]


async def active_of(app: FastAPI, desk: Rivera) -> PolicyVersion:
    [active] = [row for row in (await versions_of(app, desk)).values() if row.status == "active"]
    return active


@pytest.mark.solver
async def test_card_above_the_cap_is_rejected_at_draft_and_confirm(desk_prove, app, client, registry, monkeypatch):
    desk = await lopez_desk(app, client, payment_link(1))
    await draft_and_confirm(client, desk.owner_token, desk.desk_id, [charge_card("links", 8_000)],
                            auto_money_cap_cents=8_000)
    before = await versions_of(app, desk)
    active = await active_of(app, desk)
    response = await post_draft(client, desk, [charge_card("links", 10_000)], active.version)
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert sorted(await versions_of(app, desk)) == sorted(before)          # no version written
    assert (await active_of(app, desk)).version == active.version

    # a version that holds such a card, as only a draft that skipped validation could: confirm refuses it
    monkeypatch.setattr(compiler, "validate_cards", lambda *args, **kwargs: [])
    response = await post_draft(client, desk, [charge_card("links", 10_000)], active.version)
    assert response.status_code == 200, response.text
    stored = response.json()
    assert (stored["status"], stored["auto_money_cap_cents"]) == ("proved", 8_000)   # the compiler bounds it at 8000
    response = await client.post("/policy/confirm", headers=desk.owner,
                                 json={"desk_id": desk.desk_id, "version": stored["version"]})
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert (await policy_entries(client, desk))[-1] == {"version": stored["version"], "refused": "above_money_cap"}
    assert (await active_of(app, desk)).version == active.version


def link_request(cents: int, *, cap: int, principal: str = "Visitor") -> dict:
    """A stranger's (or a mandate-holding agent's) payment link for `cents`, evaluated at the money cap `cap`."""
    principal_uid, resource_uid = {"type": principal, "id": "session-1"}, {"type": "Quote", "id": "quote-1"}
    attrs = {"verified": False, "assurance": "none", "copy": "copy-1"}
    if principal == "Agent":
        attrs |= {"agent_key_id": "agent-key-1", "mandate_remaining_cents": 1_000_000}
    return {"principal": principal_uid, "action": "native.payment_link", "resource": resource_uid,
            "context": context(record_owner_match=False, local_dow=4, local_minute=600, amount_cents=cents,
                               auto_money_cap_cents=cap),
            "entities": [{"uid": principal_uid, "attrs": attrs, "parents": []},
                         {"uid": resource_uid, "attrs": {"copy": "copy-1"}, "parents": []}]}


def engine_with(sets: compiler.CompiledSets, profiles: list) -> desk_kernel.PolicyEngine:
    engine = desk_kernel.PolicyEngine(compiler.BASELINE)
    assert engine.load("desk-cap:1", json.dumps(compiler.desk_schema(profiles)), json.dumps(sets.sets())) == []
    return engine


def outcome(engine: desk_kernel.PolicyEngine, request: dict) -> dict:
    verdict = json.loads(engine.decide("desk-cap:1", json.dumps(request), "final"))
    assert verdict["errors"] == [], verdict
    return verdict


def test_compiler_caps_at_the_version_cap_when_validation_is_bypassed():
    profiles = [payment_link(1).profile]
    sets = compile_at([charge_card("links", 50_000)], profiles, cap=8_000)       # validation would refuse the card
    assert "context.amount_cents <= 8000" in sets.A and "50000" not in sets.A
    # with the context's cap at the ceiling the baseline lets it through, so the compiler's bound alone holds it
    engine = engine_with(sets, profiles)
    assert outcome(engine, link_request(8_000, cap=1_000_000))["outcome"] == "allow"
    held = outcome(engine, link_request(8_001, cap=1_000_000))
    assert (held["outcome"], held["policy_ids"]) == ("hold", ["H.twin.links"])


async def entries_of(client: httpx.AsyncClient, desk: Rivera, kind: str) -> list[dict]:
    response = await client.get(f"/ledger/{desk.desk_id}", headers=desk.owner)
    assert response.status_code == 200, response.text
    return [entry["event"]["summary"] for entry in response.json()["entries"] if entry["event"]["kind"] == kind]


def with_receipt_line(monkeypatch) -> None:
    """The stand-in link runs with the receipt line the payments plan gives this tool, as every tool must."""
    for language, line in (("en", "Payment link made for this quote"),
                           ("es", "Enlace de pago creado para esta cotización")):
        monkeypatch.setitem(render.EXECUTED[language], "native.payment_link", line)


@pytest.mark.solver
async def test_baseline_holds_auto_money_above_the_context_cap(desk_prove, app, client, registry, monkeypatch):
    profiles = [payment_link(1).profile]
    engine = engine_with(compile_at([charge_card("links", 30_000)], profiles, cap=50_000), profiles)
    assert outcome(engine, link_request(20_000, cap=50_000))["outcome"] == "allow"
    # the same sets, judged by a version whose cap is lower: the baseline's auto_money_cap holds it
    assert outcome(engine, link_request(20_000, cap=10_000))["outcome"] == "hold"
    assert outcome(engine, link_request(10_000, cap=10_000))["outcome"] == "allow"
    without = desk_kernel.PolicyEngine(compiler.BASELINE.replace("context.amount_cents > context.auto_money_cap_cents ||",
                                                                 ""))
    assert without.load("desk-cap:1", json.dumps(compiler.desk_schema(profiles)),
                        json.dumps(compile_at([charge_card("links", 30_000)], profiles, cap=50_000).sets())) == []
    assert outcome(without, link_request(20_000, cap=10_000))["outcome"] == "allow"   # only that forbid held it

    # a Rivera copy decides at its active version's cap, and every entry names the version and the cap
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    quote = await decided(client, visitor, "native.quote", quote_args(("drain", 1)))
    assert (quote.outcome, quote.policy_version) == ("allow", 1)
    response = await client.post("/execute", headers=visitor.headers, json={
        "decision_id": quote.decision_id, "session_id": visitor.session_id, "generation": 0})
    assert response.status_code == 200, response.text
    [decided_entry] = [e for e in await entries_of(client, copy, "decide") if e.get("decision_id") == quote.decision_id]
    assert (decided_entry["policy_version"], decided_entry["auto_money_cap_cents"]) == (1, 50_000)
    [ran] = [e for e in await entries_of(client, copy, "execute") if e.get("decision_id") == quote.decision_id]
    assert (ran["state"], ran["policy_version"], ran["auto_money_cap_cents"]) == ("executed", 1, 50_000)

    # and an allowed $200 link, once a card for it is active at the seed's cap
    with_receipt_line(monkeypatch)
    link = await enable(app, copy, payment_link(20_000))
    version = await draft_and_confirm(client, copy.owner_token, copy.desk_id,
                                      [*RIVERA_CARDS, charge_card("links", 30_000)])
    assert (version.version, version.auto_money_cap_cents) == (2, 50_000)
    allowed = await link_for(client, visitor, link, 20_000, call_id="link-200")
    assert (allowed.outcome, allowed.policy_version) == ("allow", 2)
    response = await client.post("/execute", headers=visitor.headers, json={
        "decision_id": allowed.decision_id, "session_id": visitor.session_id, "generation": 0})
    assert response.status_code == 200, response.text
    [decided_entry] = [e for e in await entries_of(client, copy, "decide") if e.get("decision_id") == allowed.decision_id]
    assert (decided_entry["policy_version"], decided_entry["auto_money_cap_cents"]) == (2, 50_000)
    [ran] = [e for e in await entries_of(client, copy, "execute") if e.get("decision_id") == allowed.decision_id]
    assert (ran["state"], ran["policy_version"], ran["auto_money_cap_cents"]) == ("executed", 2, 50_000)


def test_ceiling_literals_match_the_constant():
    def statement(text: str, policy_id: str) -> str:
        return next(part for part in text.split(";") if f'@id("{policy_id}")' in part)

    ceiling = str(AUTO_MONEY_HARD_CAP_CENTS)
    assert AUTO_MONEY_HARD_CAP_CENTS == 1_000_000
    for policy_id in ("auto_money_cap", "money_has_amount"):
        assert re.findall(r"\b\d{4,}\b", statement(compiler.BASELINE, policy_id)) == [ceiling], policy_id
    platform = (compiler.CEDAR_DIR / "invariants" / "auto" / "platform_money_cap.cedar").read_text()
    assert re.findall(r"\b\d{4,}\b", platform.split("permit", 1)[1]) == [ceiling]
    # the cap invariant holds a placeholder, never a number, and renders at most at the ceiling
    money_cap = (compiler.CEDAR_DIR / "invariants" / "auto" / "money_cap.cedar").read_text()
    assert compiler.CAP_PLACEHOLDER in money_cap and not re.findall(r"\b\d+\b", money_cap.split("permit", 1)[1])
    assert "<= 1000000 }" in compiler.invariants(5_000_000)["auto"]["money_cap"]
    migration = (BACKEND / "alembic" / "versions" / "01b_3b_money_cap.py").read_text()
    assert re.findall(r"CHECK \(auto_money_cap_cents BETWEEN 0 AND (\d+)\)", migration) == [ceiling]


def hashes_of(row: PolicyVersion) -> activation.VersionHashes:
    return activation.VersionHashes(*(getattr(row, field) for field in activation.VersionHashes._fields))


def dollars_in(sentence: str) -> list[int]:
    """The amounts a sentence names, in cents."""
    return [int(float(amount.replace(",", "")) * 100) for amount in re.findall(r"\$([\d,]+(?:\.\d\d)?)", sentence)]


@pytest.mark.solver
async def test_a_version_is_proved_at_its_own_cap(desk_prove, app, client, registry, monkeypatch):
    copy = await rivera(app, client)
    await enable(app, copy, payment_link(1))
    cards = [*RIVERA_CARDS, charge_card("links", 30_000)]
    drafted = {}
    for cap in (30_000, 50_000):
        response = await post_draft(client, copy, cards, 1, auto_money_cap_cents=cap)
        assert response.status_code == 200, response.text
        drafted[cap] = response.json()
        assert (drafted[cap]["status"], drafted[cap]["auto_money_cap_cents"]) == ("proved", cap)
    assert drafted[30_000]["invariants_sha256"] != drafted[50_000]["invariants_sha256"]
    rows = await versions_of(app, copy)
    cache = app.state.kernel.policies.cache
    reports = [cache.get(hashes_of(rows[drafted[cap]["version"]])) for cap in (30_000, 50_000)]
    assert all(report is not None and activation.proved(report) for report in reports)
    assert hashes_of(rows[drafted[30_000]["version"]]) != hashes_of(rows[drafted[50_000]["version"]])

    # a lowering is a new version, proved with the invariants rendered at its own cap
    proved_inputs: list[activation.ProofInputs] = []
    prove = activation.prove

    async def spy(inputs: activation.ProofInputs) -> activation.ProofReport:
        proved_inputs.append(inputs)
        return await prove(inputs)

    monkeypatch.setattr(activation, "prove", spy)
    response = await post_draft(client, copy, [*RIVERA_CARDS, charge_card("links", 10_000)], 1,
                                auto_money_cap_cents=10_000)
    assert (response.status_code, response.json()["status"]) == (200, "proved")
    [inputs] = proved_inputs
    assert inputs.auto == list(compiler.invariants(10_000)["auto"].values())
    assert any("context.amount_cents <= 10000" in text for text in inputs.auto)

    # a compiler that skips the cap is caught by the proof at the version's cap, and can't be confirmed
    compile_cards = compiler.compile_cards
    monkeypatch.setattr(compiler, "validate_cards", lambda *args, **kwargs: [])
    monkeypatch.setattr(compiler, "compile_cards", lambda cards, profiles, *, auto_money_cap_cents, **kwargs:
                        compile_cards(cards, profiles, auto_money_cap_cents=AUTO_MONEY_HARD_CAP_CENTS, **kwargs))
    response = await post_draft(client, copy, [*RIVERA_CARDS, charge_card("links", 50_000)], 1,
                                auto_money_cap_cents=8_000)
    assert response.status_code == 200, response.text
    rejected = response.json()
    assert rejected["status"] == "rejected"
    checks = {check["name"]: check for check in rejected["proof"]["checks"]}
    assert checks["baseline_auto"]["ok"] is False
    plain = checks["baseline_auto"]["counterexample_plain"]
    assert plain.endswith("without asking you.") and dollars_in(plain) and min(dollars_in(plain)) > 8_000, plain
    response = await client.post("/policy/confirm", headers=copy.owner,
                                 json={"desk_id": copy.desk_id, "version": rejected["version"]})
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert (await active_of(app, copy)).version == 1


async def rivera_with_links(app: FastAPI, client: httpx.AsyncClient, cents: int, *,
                            cap: int | None = None) -> tuple[Rivera, FakeAdapter, PolicyVersionContract]:
    """A Rivera copy with the stand-in link enabled and an auto charge card up to `cents` confirmed
    (at the money cap `cap`, else the seed's $500): version 2."""
    copy = await rivera(app, client)
    link = await enable(app, copy, payment_link(1))
    version = await draft_and_confirm(client, copy.owner_token, copy.desk_id,
                                      [*RIVERA_CARDS, charge_card("links", cents)], auto_money_cap_cents=cap)
    return copy, link, version


@pytest.mark.solver
async def test_lowering_drafts_the_active_money_cards_down_to_the_new_cap(desk_prove, app, client, registry):
    copy, link, active = await rivera_with_links(app, client, 30_000)
    assert (active.version, active.auto_money_cap_cents) == (2, 50_000)
    visitor = await open_visitor(client, copy)
    # a draft at 10_000 that keeps the 30_000 card doesn't fit its own cap: refused, nothing written
    response = await post_draft(client, copy, active.cards, 2, auto_money_cap_cents=10_000)
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert sorted(await versions_of(app, copy)) == [1, 2]

    lowered = lower_to_cap(active.cards, active.cards, 10_000)
    response = await post_draft(client, copy, lowered, 2, auto_money_cap_cents=10_000)
    assert response.status_code == 200, response.text
    drafted = PolicyVersionContract.model_validate(response.json())
    assert (drafted.status, drafted.auto_money_cap_cents) == ("proved", 10_000)
    [card] = [card for card in drafted.cards if card.card_id == "links"]
    assert (card.mode, card.max_amount_cents) == ("auto", 10_000)
    # until the owner confirms it, the active version and its cap stay in force
    assert ((await active_of(app, copy)).version, (await active_of(app, copy)).auto_money_cap_cents) == (2, 50_000)
    assert (await link_for(client, visitor, link, 20_000, call_id="before")).outcome == "allow"
    response = await client.post("/policy/confirm", headers=copy.owner,
                                 json={"desk_id": copy.desk_id, "version": drafted.version})
    assert response.status_code == 200, response.text
    assert (await link_for(client, visitor, link, 20_000, call_id="after")).outcome == "hold"
    assert (await link_for(client, visitor, link, 10_000, call_id="at-cap")).outcome == "allow"
    assert (await policy_entries(client, copy))[-1] == {"version": drafted.version, "activated": True, "from": 2,
                                                         "auto_money_cap_cents": 10_000}
    # lowered to 0, the card asks instead
    [asks] = [card for card in lower_to_cap(drafted.cards, drafted.cards, 0) if card.card_id == "links"]
    assert (asks.mode, asks.who, asks.applies_to, asks.max_amount_cents) == ("ask", "anyone", "effect:charge", None)


def test_lower_to_cap_touches_only_carried_money_cards():
    weekdays = HoursWindow(days=["mon", "tue", "wed", "thu", "fri"], start=time(9), end=time(17))
    big = charge_card("links", 30_000, max_discount_bp=500, hours=weekdays, review=True)
    small = RuleCard(card_id="refunds", applies_to="payments.create_refund", mode="auto", who="record_owner",
                     max_amount_cents=5_000, reason="Small refunds to the customer who paid.")
    quotes = RuleCard(card_id="quotes", applies_to="native.quote", mode="auto", who="anyone", max_amount_cents=90_000,
                      reason="Quotes from the price list.")
    active = [big, small, quotes]
    reworded = big.model_copy(update={"reason": "Links for jobs, up to a limit."})
    new = charge_card("new-links", 30_000)
    assert lower_to_cap([big, small, quotes, new], active, 10_000) == [
        big.model_copy(update={"max_amount_cents": 10_000}), small, quotes, new]
    # carried is by card_id alone: the model may reword a card's reason
    assert lower_to_cap([reworded], active, 10_000) == [reworded.model_copy(update={"max_amount_cents": 10_000})]
    assert lower_to_cap([small], active, 5_000) == [small]                    # at the cap: unchanged
    # at 0 a carried money card asks instead, with the same scope and no auto-only limits
    [asks, refunds, *_] = lower_to_cap(active, active, 0)
    assert asks == RuleCard(card_id="links", applies_to="effect:charge", mode="ask", who="anyone",
                            reason=big.reason)
    assert (refunds.mode, refunds.who, refunds.max_amount_cents) == ("ask", "record_owner", None)
    for cap in (-1, 1_000_001, True, 500.0):
        with pytest.raises(ValueError):
            lower_to_cap(active, active, cap)


def test_one_predicate_says_which_cards_the_cap_bounds():
    # the compiler holds cards to the money cap with desk.money_cap's own predicate, never a copy of it
    assert compiler.auto_money is money_cap.auto_money
    assert compiler.moves_money is money_cap.moves_money
    # so the draft check and the lowering agree on every card: a carried card comes down exactly
    # when the check would refuse it
    asks = RuleCard(card_id="ask-links", applies_to="native.payment_link", mode="ask", who="anyone",
                    reason="Payment links ask.")
    refunds = RuleCard(card_id="refunds", applies_to="payments.create_refund", mode="auto", who="record_owner",
                       max_amount_cents=30_000, reason="Refunds to the customer who paid.")
    quotes = RuleCard(card_id="quotes", applies_to="native.quote", mode="auto", who="anyone", max_amount_cents=90_000,
                      reason="Quotes from the price list.")
    for card in (charge_card("links", 30_000), charge_card("small", 5_000), asks, refunds, quotes):
        lowered = lower_to_cap([card], [card], 10_000) != [card]
        assert lowered == bool(compiler.above_money_cap([card], 10_000)), card.card_id


@pytest.mark.solver
async def test_raising_needs_the_owners_confirm(desk_prove, app, client, registry):
    copy, link, active = await rivera_with_links(app, client, 10_000, cap=10_000)
    assert (active.version, active.auto_money_cap_cents) == (2, 10_000)
    visitor = await open_visitor(client, copy)
    response = await post_draft(client, copy, [*RIVERA_CARDS, charge_card("links", 30_000)], 2,
                                auto_money_cap_cents=50_000)
    assert response.status_code == 200, response.text
    raised = PolicyVersionContract.model_validate(response.json())
    assert (raised.status, raised.auto_money_cap_cents) == ("proved", 50_000)
    # drafted, not confirmed: the Desk is still held to 10_000
    current = await active_of(app, copy)
    assert (current.version, current.auto_money_cap_cents) == (2, 10_000)
    assert (await link_for(client, visitor, link, 20_000, call_id="before")).outcome == "hold"
    response = await client.post("/policy/confirm", headers=copy.owner,
                                 json={"desk_id": copy.desk_id, "version": raised.version})
    assert response.status_code == 200, response.text
    assert (await policy_entries(client, copy))[-1] == {"version": raised.version, "activated": True, "from": 2,
                                                         "auto_money_cap_cents": 50_000}
    assert (await link_for(client, visitor, link, 20_000, call_id="after")).outcome == "allow"


@pytest.mark.solver
async def test_an_allow_before_a_cap_change_is_refused_at_execution(desk_prove, app, client, registry, monkeypatch):
    with_receipt_line(monkeypatch)
    copy, link, active = await rivera_with_links(app, client, 30_000)
    visitor = await open_visitor(client, copy)
    allowed = await link_for(client, visitor, link, 20_000, call_id="link-200")
    assert (allowed.outcome, allowed.policy_version) == ("allow", 2)
    lowered = await draft_and_confirm(client, copy.owner_token, copy.desk_id,
                                      lower_to_cap(active.cards, active.cards, 10_000), auto_money_cap_cents=10_000)
    assert (lowered.version, lowered.auto_money_cap_cents) == (3, 10_000)
    response = await client.post("/execute", headers=visitor.headers, json={
        "decision_id": allowed.decision_id, "session_id": visitor.session_id, "generation": 0})
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert "execute" not in link.calls
    response = await client.get(f"/decisions/{allowed.decision_id}", headers=copy.owner)
    assert response.json()["state"] == "refused_at_execution"
    [refused] = [e for e in await entries_of(client, copy, "execute") if e.get("decision_id") == allowed.decision_id]
    assert refused == {"decision_id": allowed.decision_id, "action_id": allowed.action.action_id,
                       "state": "refused_at_execution", "reason": "rules_changed", "check": "policy",
                       "policy_version": 3, "auto_money_cap_cents": 10_000}


async def dana(app: FastAPI, client: httpx.AsyncClient, copy: Rivera) -> Visitor:
    """A visitor confirmed as Dana Whitfield, who is on record."""
    [person] = await rows_of(app, copy.copy_id, select(Person).where(Person.desk_id == copy.desk_id,
                                                                     Person.ref == "dana"))
    visitor = await open_visitor(client, copy)
    await verify_session(app, copy.copy_id, visitor.session_id, person.person_id)
    return visitor


async def answer(client: httpx.AsyncClient, copy: Rivera, decision_id: str, answer: str) -> httpx.Response:
    return await client.post(f"/approvals/{decision_id}/answer", headers=copy.owner, json={"answer": answer})


async def rivera_holding_links(app: FastAPI, client: httpx.AsyncClient) -> tuple[Rivera, FakeAdapter]:
    """A Rivera copy with the stand-in link enabled and no card for it, so every link asks (version 2,
    at the seed's $500)."""
    copy = await rivera(app, client)
    link = await enable(app, copy, payment_link(1))
    version = await draft_and_confirm(client, copy.owner_token, copy.desk_id, RIVERA_CARDS)
    assert (version.version, version.auto_money_cap_cents) == (2, 50_000)
    return copy, link


@pytest.mark.solver
async def test_drafts_take_the_active_cap_and_are_keyed_by_it(desk_prove, app, client, registry, monkeypatch):
    with_receipt_line(monkeypatch)
    copy, link = await rivera_holding_links(app, client)
    held = await link_for(client, await dana(app, client, copy), link, 20_000, call_id="dana-link")
    assert held.outcome == "hold" and "allow_person" in held.answers
    response = await answer(client, copy, held.decision_id, "allow_person")
    assert response.status_code == 200, response.text
    [person_card] = response.json()["card_diff"]
    stranger = await link_for(client, await open_visitor(client, copy), link, 20_000, call_id="stranger-link")
    response = await answer(client, copy, stranger.decision_id, "deny_always")
    assert response.status_code == 200, response.text
    [never_card] = response.json()["card_diff"]

    # drafts without a cap, the kernel's own allow_person and deny_always drafts among them, take the active cap
    without = await post_draft(client, copy, RIVERA_CARDS, 2)
    for cards in ([*RIVERA_CARDS, RuleCard.model_validate(person_card)],
                  [*RIVERA_CARDS, RuleCard.model_validate(never_card)]):
        response = await post_draft(client, copy, cards, 2)
        assert response.status_code == 200, response.text
        assert (response.json()["status"], response.json()["auto_money_cap_cents"]) == ("proved", 50_000)
    assert (without.status_code, without.json()["auto_money_cap_cents"]) == (200, 50_000)
    # the same cards on the same parent at the same cap are the same draft; at another cap, another one
    again = await post_draft(client, copy, RIVERA_CARDS, 2, auto_money_cap_cents=50_000)
    assert again.json()["version"] == without.json()["version"]
    other = await post_draft(client, copy, RIVERA_CARDS, 2, auto_money_cap_cents=30_000)
    assert other.status_code == 200, other.text
    assert other.json()["version"] != without.json()["version"]
    assert other.json()["auto_money_cap_cents"] == 30_000
    assert other.json()["invariants_sha256"] != without.json()["invariants_sha256"]


async def read_decision(client: httpx.AsyncClient, copy: Rivera, decision_id: str) -> Decision:
    response = await client.get(f"/decisions/{decision_id}", headers=copy.owner)
    assert response.status_code == 200, response.text
    return Decision.model_validate(response.json())


@pytest.mark.solver
async def test_allow_person_follows_the_active_cap(desk_prove, app, client, registry, monkeypatch):
    with_receipt_line(monkeypatch)
    copy, link = await rivera_holding_links(app, client)
    visitor = await dana(app, client, copy)
    first = await link_for(client, visitor, link, 20_000, call_id="first")
    assert first.outcome == "hold" and "allow_person" in first.answers          # within the seed's 50_000
    response = await answer(client, copy, first.decision_id, "allow_person")
    assert response.status_code == 200, response.text
    [card] = response.json()["card_diff"]
    assert (card["who"], card["applies_to"], card["max_amount_cents"]) == ("person", "native.payment_link", 20_000)
    waiting = await link_for(client, visitor, link, 20_000, call_id="waiting")   # decided at 50_000, still held
    assert "allow_person" in waiting.answers

    lowered = await draft_and_confirm(client, copy.owner_token, copy.desk_id, RIVERA_CARDS,
                                      auto_money_cap_cents=10_000)
    assert lowered.auto_money_cap_cents == 10_000
    fresh = await link_for(client, visitor, link, 20_000, call_id="fresh")
    assert fresh.outcome == "hold" and "allow_person" not in fresh.answers
    response = await answer(client, copy, fresh.decision_id, "allow_person")
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    # the hold decided before the lowering loses it on its next read, persisted, ledgered and signed again
    reread = await read_decision(client, copy, waiting.decision_id)
    assert (reread.state, reread.answers) == ("held", ["allow_once", "deny_once", "deny_always"])
    assert reread.ledger_seq > waiting.ledger_seq
    verify_signature((await client.get("/health")).json()["public_key_hex"], reread)
    refreshed = [e for e in await entries_of(client, copy, "decide")
                 if e.get("decision_id") == waiting.decision_id and "answers" in e]
    assert refreshed == [{"decision_id": waiting.decision_id, "answers": ["allow_once", "deny_once", "deny_always"],
                          "policy_version": lowered.version, "auto_money_cap_cents": 10_000}]
    assert (await read_decision(client, copy, waiting.decision_id)).ledger_seq == reread.ledger_seq   # once
    response = await answer(client, copy, waiting.decision_id, "allow_person")
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})

    # a later version whose cap covers it puts it back
    raised = await draft_and_confirm(client, copy.owner_token, copy.desk_id, RIVERA_CARDS,
                                     auto_money_cap_cents=50_000)
    assert raised.auto_money_cap_cents == 50_000
    assert "allow_person" in (await read_decision(client, copy, waiting.decision_id)).answers
    response = await answer(client, copy, waiting.decision_id, "allow_person")
    assert response.status_code == 200, response.text
    assert response.json()["decision"]["state"] == "executed"


async def test_new_desks_start_at_zero_and_rivera_at_five_hundred(app, client):
    copy = await rivera(app, client)
    body = new_desk()
    response = await post_desk(client, copy, {**body, "desk": {**body["desk"], "auto_money_cap_cents": 1}})
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert [desk.desk_id for desk in await rows_of(app, copy.copy_id, select(Desk))] == [copy.desk_id]
    response = await post_desk(client, copy, body)
    assert response.status_code == 200, response.text
    lopez = Rivera(copy_id=copy.copy_id, desk_id=response.json()["desk_id"], slug=response.json()["slug"],
                   owner_token=copy.owner_token)
    [first] = (await versions_of(app, lopez)).values()
    assert (first.version, first.status, first.preset, first.auto_money_cap_cents) == (1, "active", "ask_first", 0)
    assert activation.proved(first.proof)                                    # the shipped report, at 0
    for desk, cap, preset in ((lopez, 0, "ask_first"), (copy, 50_000, "rivera")):
        assert api_rows(copy.copy_id, "SELECT version, auto_money_cap_cents FROM kernel_ro.policy_versions"
                                      f" WHERE desk_id = '{desk.desk_id}'") == [(1, cap)]
        assert await policy_entries(client, desk) == [{"version": 1, "status": "active", "preset": preset,
                                                       "activated": True, "from": None, "auto_money_cap_cents": cap}]


async def test_only_the_owner_changes_the_cap(app, client):
    copy, other = await rivera(app, client), await rivera(app, client)
    visitor = await open_visitor(client, copy)
    body = {"desk_id": copy.desk_id, "cards": [], "expected_parent": 1, "auto_money_cap_cents": 1_000_000}
    response = await client.post("/policy/draft", headers=visitor.headers, json=body)
    assert (response.status_code, response.json()) == (401, {"code": "auth"})
    response = await client.post("/policy/draft", headers=other.owner, json=body)
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    assert sorted(await versions_of(app, copy)) == [1]
    # the API process can read the cap and never write it
    with psycopg.connect(libpq_url(database_url("API"))) as api:
        api.execute("SELECT set_config(%s, %s, true)", (COPY_SETTING, copy.copy_id))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            api.execute("UPDATE kernel.policy_versions SET auto_money_cap_cents = 1000000")
    with psycopg.connect(libpq_url(database_url("API"))) as api:
        api.execute("SELECT set_config(%s, %s, true)", (COPY_SETTING, copy.copy_id))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            api.execute("UPDATE kernel_ro.policy_versions SET auto_money_cap_cents = 1000000")
    assert (await versions_of(app, copy))[1].auto_money_cap_cents == 50_000


async def test_desk_data_routes_cannot_set_the_cap(app, client):
    copy = await rivera(app, client)
    bodies = {
        "business": {"name": "Rivera Plumbing", "owner_display_name": "Maria Rivera", "timezone": "America/Los_Angeles"},
        "charter": {"charter": []},
        "hours": {"hours": []},
        "prices": {"price_items": []},
        "calendar": {"calendar_slots": []},
        "people": {"upsert": [], "remove": []},
        "notifications": {"notifications": {"now": [], "briefing": []}},
        "answering": {"on": True},
    }
    ledger_before = await entries_of(client, copy, "desk_data")
    for part, body in bodies.items():
        response = await client.put(f"/desks/{copy.desk_id}/{part}", headers=copy.owner,
                                    json={**body, "auto_money_cap_cents": 1_000_000})
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), part
    assert await entries_of(client, copy, "desk_data") == ledger_before            # nothing written
    [version] = (await versions_of(app, copy)).values()
    assert (version.version, version.status, version.auto_money_cap_cents) == (1, "active", 50_000)
    assert await policy_entries(client, copy) == [{"version": 1, "status": "active", "preset": "rivera",
                                                   "activated": True, "from": None, "auto_money_cap_cents": 50_000}]
