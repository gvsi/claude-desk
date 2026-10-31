"""Owner explanations cover the rule IDs emitted by the kernel's soft-check result path."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from desk.api.owner_reads import REPLY_WHY_BY_RULE
from desk.kernel_service import reply_check
from desk.kernel_service.decisions import SoftPromiseInput, SoftPromiseVerdict


@pytest.mark.parametrize("verdict", [
    pytest.param(None, id="unavailable"),
    pytest.param(SoftPromiseVerdict(promises_beyond_cards=False, denies_being_ai=True), id="denies-ai"),
])
async def test_owner_copy_covers_the_kernels_soft_check_rule_ids(verdict):
    soft_promise = AsyncMock(return_value=(verdict, None))
    ctx = SimpleNamespace(decisions=SimpleNamespace(soft_promise=soft_promise))
    prose = "Here is the information."

    violations, usage = await reply_check.soft_promises(ctx, "en", prose, [])

    soft_promise.assert_awaited_once_with(SoftPromiseInput(language="en", prose=prose, cards=[]))
    assert usage is None
    assert len(violations) == 1 and violations[0].kind == "soft_promise"
    assert {violation.rule_id for violation in violations} <= REPLY_WHY_BY_RULE.keys()
