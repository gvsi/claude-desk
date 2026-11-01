"""Owner explanations cover the rule IDs emitted by the kernel's soft-check result path."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from desk.api.owner_reads import REPLY_WHY_BY_RULE
from desk.kernel_service import jev, reply_check
from desk.kernel_service.decisions import SoftPromiseInput, SoftPromiseVerdict


@pytest.mark.parametrize(("verdict", "jev_blocked"), [
    pytest.param(None, False, id="unavailable"),
    pytest.param(SoftPromiseVerdict(promises_beyond_cards=False, denies_being_ai=True), False, id="denies-ai"),
    pytest.param(SoftPromiseVerdict(promises_beyond_cards=False, denies_being_ai=False), True, id="jev"),
])
async def test_owner_copy_covers_the_kernels_soft_check_rule_ids(verdict, jev_blocked, monkeypatch):
    soft_promise = AsyncMock(return_value=(verdict, None))
    ctx = SimpleNamespace(decisions=SimpleNamespace(soft_promise=soft_promise),
                          settings=SimpleNamespace(typesafe_api_key="fake-key"),
                          repo=SimpleNamespace(scoped=lambda query: query),
                          db=SimpleNamespace(scalars=AsyncMock(return_value=SimpleNamespace(one=lambda: None))))
    monkeypatch.setattr(reply_check.context, "resolved_tools", AsyncMock(return_value=[]))
    monkeypatch.setattr(reply_check, "principal_for", lambda session: None)
    scores = dict.fromkeys(jev.STATEMENTS, 0.0)
    scores["owner_promised"] = 0.95 if jev_blocked else 0.0
    monkeypatch.setattr(jev, "evaluate", AsyncMock(return_value=jev.Result(status="ok", scores=scores,
                                                                          blocked=jev_blocked)))
    prose = "Here is the information."

    violations, usage, record = await reply_check.soft_promises(ctx, SimpleNamespace(desk_id="desk"), "en", prose, [])

    soft_promise.assert_awaited_once_with(SoftPromiseInput(language="en", prose=prose, cards=[]))
    assert usage is None
    assert len(violations) == 1 and violations[0].kind == "soft_promise"
    assert {violation.rule_id for violation in violations} <= REPLY_WHY_BY_RULE.keys()
    if jev_blocked:
        assert REPLY_WHY_BY_RULE["soft.jev"] == "Jev flagged a promise or identity claim the cards don't back"
