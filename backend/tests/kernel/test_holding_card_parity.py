"""Keep the API's held-card attribution in step with the kernel's quoted hold decider."""

from itertools import combinations
from types import SimpleNamespace

from desk.api import owner_reads
from desk.contracts import RuleCard
from desk.kernel_service import compiler, decide


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
    by_policy = decide.policy_cards(row)
    policy_ids = sorted(by_policy)
    assert len(policy_ids) == 11

    for size in range(1, len(policy_ids) + 1):
        for ids in combinations(policy_ids, size):
            card_ids = decide._card_ids(ids, by_policy)
            decider = decide.hold_decider(row, ids)
            assert decider is not None, ids
            quoted = decider.card_ids or card_ids
            picked = owner_reads.holding_card(by_id, card_ids)
            assert picked is not None, ids
            assert picked.card_id == quoted[0], ids
