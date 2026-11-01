"""Owner explanations cover the rule IDs emitted by the kernel's soft-check result path."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from desk.api.owner_reads import REPLY_WHY_BY_RULE
from desk.kernel_service import reply_check
from desk.kernel_service.decisions import SoftPromiseInput, SoftPromiseVerdict


@pytest.mark.parametrize(("verdict", "kind", "rule_id"), [
    pytest.param(None, "check_unavailable", "soft.unavailable", id="unavailable"),
    pytest.param(SoftPromiseVerdict(promises_beyond_cards=False, denies_being_ai=True), "soft_promise",
                 "soft.denies_ai", id="denies-ai"),
])
async def test_owner_copy_covers_the_kernels_soft_check_rule_ids(verdict, kind, rule_id, monkeypatch):
    """One try (no recheck): the kernel asks the model once, with no per-try timeout of its own."""
    soft_promise = AsyncMock(return_value=(verdict, None))
    ctx = SimpleNamespace(decisions=SimpleNamespace(soft_promise=soft_promise),
                          repo=SimpleNamespace(scoped=lambda query: query),
                          db=SimpleNamespace(scalars=AsyncMock(return_value=SimpleNamespace(one=lambda: None))))
    monkeypatch.setattr(reply_check.context, "resolved_tools", AsyncMock(return_value=[]))
    monkeypatch.setattr(reply_check, "principal_for", lambda session: None)
    prose = "Here is the information."

    violations, usage = await reply_check.soft_promises(ctx, SimpleNamespace(desk_id="desk"), "en", prose, [])

    soft_promise.assert_awaited_once_with(SoftPromiseInput(language="en", prose=prose, cards=[], next_steps=[]))
    assert usage is None
    assert [(violation.kind, violation.rule_id) for violation in violations] == [(kind, rule_id)]
    assert {violation.rule_id for violation in violations} <= REPLY_WHY_BY_RULE.keys()
