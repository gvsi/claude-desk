"""Keep the API's held-card attribution in step with the kernel's quoted hold decider."""

from itertools import combinations
from types import SimpleNamespace

from desk.api import owner_reads
from desk.contracts import RuleCard
from desk.kernel_service import compiler, decide

from .helpers import TEST_CAP
from .test_compiler import card, native_profile, profile


def assert_holding_card_matches_quotes(row, *, hold_count: int):
    cards = {card.card_id: card for card in row.cards}
    heads = decide.policy_heads(row)
    by_policy = {policy_id: list(head.cards) for policy_id, head in heads.items() if head.tier == "hold"}
    policy_ids = sorted(by_policy)
    assert len(policy_ids) == hold_count
    call = SimpleNamespace(version_row=row)

    for size in range(len(policy_ids) + 1):
        for ids in combinations(policy_ids, size):
            card_ids = decide._card_ids(ids, by_policy)
            evaluation = decide.Evaluation(outcome="hold", policy_ids=list(ids), card_ids=card_ids,
                                           review=None, usage=None, strike=False, needed_review=False)
            _, quoted_ids = decide._rules_decided(call, "hold", evaluation)
            # Match _reason_plain's filter: only cards in this version can be quoted.
            quoted = [cards[card_id] for card_id in quoted_ids if card_id in cards]
            picked = owner_reads.holding_card(cards, card_ids)
            assert picked == (quoted[0] if quoted else None), ids


def test_holding_card_matches_the_kernel_for_every_hold_policy_subset():
    cards = [
        RuleCard(card_id="default:native.quote", applies_to="native.quote", mode="ask", who="anyone",
                 is_default=True, reason="Ask when no owner rule covers the request."),
        RuleCard(card_id="a-verified-auto", applies_to="native.quote", mode="auto", who="verified",
                 reason="Verified people can get quotes."),
        RuleCard(card_id="b-verified-ask", applies_to="native.quote", mode="ask", who="verified",
                 reason="Quotes for verified people ask first."),
        RuleCard(card_id="c-record-owner-ask", applies_to="native.quote", mode="ask", who="record_owner",
                 reason="Record owners' quotes ask first."),
        RuleCard(card_id="z-person-auto", applies_to="native.quote", mode="auto", who="person", person_id="dana",
                 reason="Dana can get quotes."),
        RuleCard(card_id="m-person-ask", applies_to="native.quote", mode="ask", who="person", person_id="dana",
                 reason="Dana's quotes ask first."),
        RuleCard(card_id="p-person-effect-ask", applies_to="effect:change", mode="ask", who="person", person_id="dana",
                 reason="Dana's changes ask first."),
        RuleCard(card_id="0-effect-ask", applies_to="effect:change", mode="ask", who="anyone",
                 reason="Changes ask first."),
        RuleCard(card_id="e1-effect-auto", applies_to="effect:read", mode="auto", who="verified",
                 reason="Verified people can read records."),
        RuleCard(card_id="e2-effect-auto", applies_to="effect:change", mode="auto", who="verified",
                 reason="Verified people can change records."),
        RuleCard(card_id="k-agent-auto", applies_to="native.quote", mode="auto", who="agent", agent_key_id="agent",
                 reason="The agent can get quotes."),
    ]
    by_id = {card.card_id: card for card in cards}
    units = [(f"{'ask' if card.mode == 'ask' else 'twin'}.{card.card_id}", [card]) for card in cards]
    units.append(("twin.e1-effect-auto+e2-effect-auto", [by_id["e1-effect-auto"], by_id["e2-effect-auto"]]))
    # Use the compiler's real annotations, including a joint twin's two @card IDs.
    holds = "\n\n".join(compiler._policy(name, behind, "hold", "action", [("when", "true")])
                        for name, behind in units)
    row = SimpleNamespace(cedar={"F": "", "A": "", "H": holds}, cards=cards)
    assert_holding_card_matches_quotes(row, hold_count=12)


def test_holding_card_matches_quotes_for_every_compiled_hold_policy_subset():
    profiles = [
        native_profile("native.quote"),
        profile("desk.read", ["read"], "document", source="business"),
        profile("desk.change", ["change"], "document", source="business"),
        profile("desk.read-change", ["read", "change"], "document", source="business"),
    ]
    cards = [
        card("group-tool-ask", "native.quote", mode="ask"),
        card("person-tool-auto", "native.quote", who="person", person_id="dana"),
        card("person-tool-ask", "native.quote", mode="ask", who="person", person_id="dana"),
        card("person-effect-ask", "effect:change", mode="ask", who="person", person_id="dana"),
        card("read-auto", "effect:read", who="verified"),
        card("change-auto", "effect:change", who="verified"),
    ]
    compiled = compiler.compile_cards(cards, profiles, auto_money_cap_cents=TEST_CAP)
    row = SimpleNamespace(cedar=compiled.sets(), cards=compiled.cards)
    heads = decide.policy_heads(row)
    assert any(head.tier == "hold" and set(head.cards) == {"read-auto", "change-auto"}
               for head in heads.values())
    assert any(card.is_default for card in row.cards)
    assert_holding_card_matches_quotes(row, hold_count=10)
