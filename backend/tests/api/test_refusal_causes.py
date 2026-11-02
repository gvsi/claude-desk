"""Safety causes use only the kernel's exact reason/check codes and deciding policy IDs."""

import ast
import re
from pathlib import Path
from typing import get_args

import pytest
from pydantic import ValidationError

from desk.api.owner_reads import refusal_cause
from desk.api.schemas import Attempt, RefusalCause
from desk.kernel_service import decide


@pytest.mark.parametrize(("summary", "policies", "expected"), [
    ({"reason": "paused"}, [], "paused"),
    *[({"reason": code}, [], "tool_not_available") for code in ("unknown_tool", "not_given")],
    ({"reason": "invalid_args"}, [], "incomplete_request"),
    ({"reason": "no_active_version"}, [], "no_rules"),
    *[({"reason": code}, [], "rules_unchecked")
      for code in ("version_unloadable", "version_outdated", "evaluation_error")],
    *[({"reason": "adapter_refused", "check": code}, [], cause) for code, cause in [
        ("no_such_slot", "no_such_slot"), ("unknown_item", "unknown_item"), ("over_limit", "over_quote_ceiling"),
        ("no_such_quote", "quote_unpayable"), ("quote_paid", "quote_unpayable"), ("quote_paying", "quote_unpayable"),
        ("no_such_charge", "no_such_charge"), ("not_refundable", "not_refundable"),
        ("no_such_document", "no_such_document"), ("not_verified", None),
        ("answer_count", "incomplete_request"), ("contact_needed", "incomplete_request"),
        ("no_mandate", None), ("mandate_exhausted", None),
        ("not_an_agent_with_a_mandate", None),
    ]],
    ({}, ["F.never.card"], "owner_rule"),
    *[({}, [policy], cause) for policy, cause in [
        ("B.same_copy", "other_copy"), ("B.private_data_record_owner", "not_verified"),
        ("B.recipient_owner_or_verified_contact", "recipient"), ("B.no_agent_pay_out", "agent_pay_out"),
        ("B.agent_charge_within_mandate", "agent_limit"), ("B.money_has_amount", "no_amount"),
    ]],
    ({}, [], "no_rule"),
    ({"reason": "new_reason"}, ["F.never.card"], None),
    ({"reason": "adapter_refused", "check": "new_check"}, ["F.never.card"], None),
    ({"reason": {"withheld": True}}, [], None),
    ({"reason": "adapter_refused", "check": {"withheld": True}}, [], None),
    ({"reason": "paused", "check": {"withheld": True}}, [], None),
    ({"check": {"withheld": True}}, ["F.never.card"], None),
    ({"reason": None}, [], None),
    ({"reason": "adapter_refused", "check": None}, [], None),
    ({"reason": "adapter_refused"}, [], None),
    ({}, ["B.new_policy"], None),
    ({}, ["B.auto_money_cap"], None),
    ({}, ["B.money_has_amount", "B.same_copy", "F.never.card"], "owner_rule"),
    ({}, ["B.money_has_amount", "B.same_copy"], "other_copy"),
    ({}, ["B.agent_charge_within_mandate", "B.private_data_record_owner"], "not_verified"),
    ({"reason": "paused"}, ["F.never.card"], "paused"),
    ({"reason": "Paused"}, [], None),
    ({"reason": "adapter_refused", "check": "no_such_slot extra"}, [], None),
    ({}, ["X.F.never.card"], None),
])
def test_refusal_cause_uses_exact_kernel_codes(summary, policies, expected):
    row = {"decision_id": "decision", "session_id": "session", "policy_ids": policies,
           "reason_plain": "Your rule says never", "card_ids": []}
    entry = {"event": {"kind": "decide", "ref_id": "decision", "session_id": "session",
                       "summary": {"outcome": "refuse", **summary}}}

    assert refusal_cause(row, entry, verified=False) == expected


def test_refusal_cause_is_closed_and_held_requests_have_no_cause():
    expected = {
        "owner_rule", "not_verified", "not_their_record", "recipient", "no_such_slot", "unknown_item", "over_quote_ceiling",
        "quote_unpayable", "no_such_charge", "not_refundable", "no_such_document", "no_amount",
        "tool_not_available", "incomplete_request", "paused", "no_rules", "rules_unchecked", "agent_pay_out",
        "agent_limit", "other_copy", "no_rule",
    }
    assert set(get_args(RefusalCause)) == expected
    held = Attempt(ref_id="decision", kind="held", reason_plain="Waiting for you", card_ids=[], origin="kernel",
                   created_at="2026-10-31T00:00:00Z", triage=None, ledger_seq=1, cause=None, from_the_visitor=None)
    assert held.cause is None
    with pytest.raises(ValidationError):
        Attempt.model_validate({**held.model_dump(), "kind": "refused", "cause": "new_code"})


@pytest.mark.parametrize("kind", ["held", "reply_blocked"])
def test_only_refused_attempts_accept_a_cause(kind):
    data = {"ref_id": "decision", "kind": kind, "reason_plain": "Stopped", "card_ids": [], "origin": "kernel",
            "created_at": "2026-10-31T00:00:00Z", "triage": None, "ledger_seq": 1, "from_the_visitor": None}
    with pytest.raises(ValidationError):
        Attempt.model_validate({**data, "cause": "owner_rule"})
    assert Attempt.model_validate({**data, "cause": None}).cause is None


@pytest.mark.parametrize("kind", ["held", "reply_blocked"])
def test_only_refused_attempts_quote_the_visitor(kind):
    data = {"ref_id": "decision", "kind": kind, "reason_plain": "Stopped", "card_ids": [], "origin": "kernel",
            "created_at": "2026-10-31T00:00:00Z", "triage": None, "ledger_seq": 1, "cause": None}
    with pytest.raises(ValidationError):
        Attempt.model_validate({**data, "from_the_visitor": "Can I get 20% off?"})
    assert Attempt.model_validate({**data, "kind": "refused", "from_the_visitor": "Can I get 20% off?"}
                                  ).from_the_visitor == "Can I get 20% off?"


def test_attempt_cause_is_required_and_nullable():
    data = {"ref_id": "decision", "kind": "refused", "reason_plain": "Stopped", "card_ids": [], "origin": "kernel",
            "created_at": "2026-10-31T00:00:00Z", "triage": None, "ledger_seq": 1, "from_the_visitor": None}
    with pytest.raises(ValidationError):
        Attempt.model_validate(data)
    assert Attempt.model_validate({**data, "cause": None}).cause is None
    assert Attempt.model_validate({**data, "cause": "owner_rule"}).cause == "owner_rule"


def test_refusal_without_its_ledger_entry_has_no_cause():
    assert refusal_cause({"policy_ids": []}, None, verified=False) is None


@pytest.mark.parametrize("entry", [
    {}, {"event": None}, {"event": []}, {"event": "decide"},
    {"event": {"kind": "reply", "summary": {"outcome": "refuse", "reason": "paused"}}},
    {"event": {"kind": "decide"}},
    *[{"event": {"kind": "decide", "summary": value}} for value in (None, [], "refuse", 1)],
    {"event": {"kind": "decide", "summary": {}}},
    *[{"event": {"kind": "decide", "summary": {"outcome": value, "reason": "paused"}}}
      for value in (None, "allow", "hold")],
    {"event": {"kind": "decide", "summary": {
        "outcome": "refuse", "decision_id": "someone-else", "reason": "paused"}}},
    {"event": {"kind": "decide", "summary": {"outcome": "refuse", "decision_id": None}}},
    {"event": {"kind": "decide", "ref_id": "someone-else", "summary": {
        "outcome": "refuse", "reason": "paused"}}},
    {"event": {"kind": "decide", "session_id": "another-session", "summary": {
        "outcome": "refuse", "reason": "paused"}}},
    {"event": {"kind": "decide", "ref_id": None, "summary": {"outcome": "refuse", "reason": "paused"}}},
    {"event": {"kind": "decide", "session_id": None, "summary": {"outcome": "refuse", "reason": "paused"}}},
])
def test_refusal_requires_matching_refused_decide_entry(entry):
    row = {"decision_id": "decision", "session_id": "session", "policy_ids": [], "card_ids": []}
    if isinstance(entry.get("event"), dict):
        entry = {"event": {"ref_id": "decision", "session_id": "session", **entry["event"]}}
    assert refusal_cause(row, entry, verified=False) is None


@pytest.mark.parametrize("decision_id", [None, "decision"])
def test_plain_deny_requires_no_cards(decision_id):
    summary = {"outcome": "refuse"}
    if decision_id is not None:
        summary["decision_id"] = decision_id
    entry = {"event": {"kind": "decide", "ref_id": "decision", "session_id": "session", "summary": summary}}
    row = {"decision_id": "decision", "session_id": "session", "policy_ids": [], "card_ids": ["unmapped-card"]}
    assert refusal_cause(row, entry, verified=False) is None
    assert refusal_cause({**row, "card_ids": []}, entry, verified=False) == "no_rule"


def test_refusal_reasons_track_kernel_early_refusals():
    from desk.api.owner_reads import REFUSAL_REASONS

    assert set(decide.REFUSED_PLAIN) - {"adapter_refused"} == set(REFUSAL_REASONS)


def test_refusal_checks_track_kernel_adapters():
    from desk.api.owner_reads import REFUSAL_CHECKS
    from desk.kernel_service.adapters.payment_link import NO_SUCH_QUOTE

    adapter_dir = Path(decide.__file__).parent / "adapters"
    codes = {
        node.args[0].value
        for source in adapter_dir.glob("*.py")
        for node in ast.walk(ast.parse(source.read_text()))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "AdapterRefusal"
        and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)
    }
    # payable_quote returns these dynamic codes to AdapterRefusal(found).
    codes |= {NO_SUCH_QUOTE, "quote_paid", "quote_paying"}
    unreachable_at_decide = {
        "no_mandate": "Payment-link prepare checks the mandate only during execution.",
        "mandate_exhausted": "Mandate reservation happens in prepare during execution.",
        "not_an_agent_with_a_mandate": "tools_given excludes charge_mandate without an agent's mandate.",
        "not_verified": "tools_given excludes private-data payments tools before normalization: not_given wins.",
        "search_limit": "The web search cap is counted in prepare during execution, for owner sessions only.",
    }
    assert all(unreachable_at_decide.values())
    assert set(REFUSAL_CHECKS).isdisjoint(unreachable_at_decide)
    assert codes == set(REFUSAL_CHECKS) | set(unreachable_at_decide)
    for code in unreachable_at_decide:
        row = {"decision_id": "decision", "session_id": "session", "policy_ids": [], "card_ids": []}
        entry = {"event": {"kind": "decide", "ref_id": "decision", "session_id": "session",
                           "summary": {"outcome": "refuse", "reason": "adapter_refused", "check": code}}}
        assert refusal_cause(row, entry, verified=False) is None, code


def test_baseline_causes_cover_every_refusing_policy():
    from desk.api.owner_reads import BASELINE_CAUSES

    baseline = Path(__file__).resolve().parents[3] / "kernel/cedar/baseline.cedar"
    ids = {f"B.{policy}" for policy in re.findall(r'@id\("([^"]+)"\)', baseline.read_text())}
    never_decides_refusal = {
        # The evaluation path converts this auto-set cap into a hold for owner approval.
        "B.auto_money_cap": "Auto money cap produces a hold rather than a refused decision.",
    }
    assert set(BASELINE_CAUSES).isdisjoint(never_decides_refusal)
    assert ids == set(BASELINE_CAUSES) | set(never_decides_refusal)
