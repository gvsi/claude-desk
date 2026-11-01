"""The payments and agent cases' own checks: a link's token, fact totals, ledger secrets, the
customer a caller is charged under and the copy's store charges counted apart from the kernel."""

from types import SimpleNamespace

import pytest

from desk.contracts import LedgerEntry
from evals.tier1.golden_desk import P, Caller
from evals.tier1.harness import Auth, TravelClock
from evals.tier1.stub import ContractStub
from evals.tier1.test_payments_and_agents import (
    CHARGE,
    LINK,
    agent_secrets,
    assert_hold_none,
    assert_store_charged,
    assert_store_names,
    charged_amounts,
    customer_of,
    link_token,
    new_store_charges,
    totals,
)


def test_link_token_reads_only_the_checkout_path():
    """A link card's href is the checkout's path and its token; anything else fails the case."""
    assert link_token("/pay/AbC-12_x") == "AbC-12_x"
    for href in (None, "", "/pay/", "/api/d/AbC", "https://pay.example/pay/AbC", "/pay/AbC/more", "/pay/AbC?x=1",
                 "/pay/Ab C", "/pay/AbC\n", "pay/AbC"):
        with pytest.raises(AssertionError, match="href"):
            link_token(href)


def charge(charge_id: str, amount_cents: int, customer_id: str = "session:s-visitor", refunded_cents: int = 0) -> dict:
    """One row of the store's charges, as `store_charges_of_copy` reads it."""
    return {"charge_id": charge_id, "customer_id": customer_id, "amount_cents": amount_cents,
            "refunded_cents": refunded_cents}


def charges(*rows: dict) -> dict[str, dict]:
    return {row["charge_id"]: row for row in rows}


SEED = charges(charge("ch-seed-1", 25_000, "person:p-dana"), charge("ch-seed-2", 15_000, "person:p-bob"))


def test_store_charge_count_is_independent_of_the_kernel():
    """The store's own successful charges are counted, so a second provider charge the kernel never
    recorded fails the oracle rather than passing it, and a refunded charge fails too."""
    assert charged_amounts([charge("a", P), charge("b", 2_000)]) == [2_000, P]
    assert_store_charged([charge("a", P)], 1, P, "a visitor")   # one honest charge passes
    with pytest.raises(AssertionError, match="charges"):
        assert_store_charged([charge("a", P), charge("b", P)], 1, P, "a visitor")   # a second, unrecorded charge
    with pytest.raises(AssertionError, match="charges"):
        assert_store_charged([], 1, P, "a visitor")   # none at all
    with pytest.raises(AssertionError, match="refunded"):
        assert_store_charged([charge("a", P, refunded_cents=P)], 1, P, "a visitor")
    assert_store_charged([], 0, P, "a visitor")   # nothing charged, as expected


def test_new_store_charges_count_the_whole_copy():
    """The charges a case made are what the copy's store holds that it didn't before, under any
    customer: a charge under a customer no case expected (an agent's link is a checkout under its
    session, not its key) is counted, not filtered out of sight, and the seed's are never counted."""
    after = {**SEED, **charges(charge("ch-1", P), charge("ch-2", P, "agent:k-unexpected"))}
    new = new_store_charges(SEED, after)
    assert sorted(row["charge_id"] for row in new) == ["ch-1", "ch-2"]
    with pytest.raises(AssertionError, match="2 charges totalling 36000 cents"):
        assert_store_charged(new, 1, P, "a visitor")   # one kernel fact, two provider charges
    assert new_store_charges(SEED, SEED) == []


def test_new_store_charges_fail_when_an_earlier_charge_changed():
    """A case that moves money one way never touches the charges the store already held: one of
    them refunded, voided (so no longer successful) or changed fails the case."""
    refunded = {**SEED, "ch-seed-1": {**SEED["ch-seed-1"], "refunded_cents": 25_000}}
    voided = {"ch-seed-2": SEED["ch-seed-2"]}
    for after in (refunded, voided):
        with pytest.raises(AssertionError, match="changed 1 charge"):
            new_store_charges(SEED, after)


def test_store_names_binds_the_store_to_the_kernel():
    """The store's new charges are exactly those the kernel's charge facts name, each under the
    payer Plan 01c charges: a charge no fact names, a fact naming no new charge, or a charge made
    under another customer fails."""
    new = [charge("ch-1", P), charge("ch-2", P)]
    assert_store_names(new, ["ch-2", "ch-1"], "session:s-visitor", "a visitor")
    with pytest.raises(AssertionError, match="no charge fact names"):
        assert_store_names(new, ["ch-1"], "session:s-visitor", "a visitor")
    with pytest.raises(AssertionError, match="no charge fact names"):
        assert_store_names(new, ["ch-1", "ch-3"], "session:s-visitor", "a visitor")
    with pytest.raises(AssertionError, match="under"):
        assert_store_names([charge("ch-1", P, "person:p-dana")], ["ch-1"], "session:s-visitor", "a visitor")


async def test_customer_of_follows_the_charge_path():
    """A mandate charge is made under the agent's signing key; a payment link's checkout, under the
    session, an agent's link included. A verified person's link (`person:`) isn't built, and a
    mandate charge needs an agent."""
    issued = await ContractStub().call("POST /agents/demo", body={"desk_id": "d-1"}, auth=Auth.none())
    agent = Caller("agent", SimpleNamespace(session_id="s-agent", verified=False),
                   Auth.agent(issued, "turner-plumbing-abc123", TravelClock()))
    assert customer_of(agent, CHARGE) == f"agent:{issued.agent_key_id}"
    assert customer_of(agent, LINK) == "session:s-agent"
    visitor = Caller("visitor", SimpleNamespace(session_id="s-visitor", verified=False),
                     Auth.raw({"X-Session-Token": "tok"}))
    assert customer_of(visitor, LINK) == "session:s-visitor"
    with pytest.raises(AssertionError, match="mandate"):
        customer_of(visitor, CHARGE)
    verified = Caller("dana", SimpleNamespace(session_id="s-dana", verified=True), Auth.raw({"X-Session-Token": "t"}))
    with pytest.raises(AssertionError, match="verified"):
        customer_of(verified, LINK)


def test_totals_are_the_money_totals_a_fact_claims():
    row = {"claims": [
        {"key": "total", "kind": "money", "value": 2_000}, {"key": "list", "kind": "money", "value": 3_000},
        {"key": "title", "kind": "text", "value": "Service call deposit"},
        {"key": "total", "kind": "text", "value": "twenty dollars"},
    ]}
    assert totals(row) == [2_000]
    assert totals({"claims": []}) == []


def entry(summary: dict) -> LedgerEntry:
    return LedgerEntry(
        copy_id="c-1", desk_id="d-1", seq=7, prev_hash="0" * 64, created_at="2026-11-03T18:00:00.000000Z",
        event={"kind": "agent_auth", "origin": "kernel", "session_id": "s-1", "summary": summary},
        hash="1" * 64, signature="2" * 128, key_id="3" * 16,
    )


async def test_ledger_entries_hold_no_agent_secret():
    """An entry holding the agent's key or a signature it sent fails the case, named by label and
    never by value; a call that sent no signature adds nothing to look for."""
    issued = await ContractStub().call("POST /agents/demo", body={"desk_id": "d-1"}, auth=Auth.none())
    signed = Auth.agent(issued, "turner-plumbing-abc123", TravelClock())
    forbidden = agent_secrets(issued, Auth.none(), signed)
    assert forbidden == {"the agent's private key": issued.agent_private_key_hex, "signature 0": "",
                         "signature 1": signed.headers()["X-Agent-Sig"]}
    assert_hold_none([entry({"reason": "bad_signature", "agent_key_id": issued.agent_key_id})], forbidden)
    for leaked, label in ((issued.agent_private_key_hex, "the agent's private key"),
                          (signed.headers()["X-Agent-Sig"], "signature 1")):
        with pytest.raises(AssertionError) as raised:
            assert_hold_none([entry({"reason": "bad_signature", "detail": f"sig={leaked}"})], forbidden)
        assert label in str(raised.value) and leaked not in str(raised.value)
