"""Rule activation's cancelled-link notices, on both kernels (Plan 01c)."""

import pytest

from desk.contracts import RuleCard
from desk.kernel_api import PolicyConfirmRequest, PolicyDraftRequest
from tests.kernel_contract.test_contract import (
    desk_slug, issue_payment_link, item_id, new_copy, new_visitor,
)


@pytest.mark.kernel_plan("01c")
async def test_activation_lists_cancelled_link_once_per_read(kernel, ro_read):
    http, schema, _ = kernel
    copy = await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    (row,) = ro_read(schema, copy.copy_id, "SELECT version, cards FROM {ro}.policy_versions"
                    " WHERE desk_id = %s AND status = 'active'", (desk_id,))
    cards = [RuleCard.model_validate(card) for card in row["cards"] if not card["is_default"]]
    # No reviewer is needed to open the link on either kernel.
    cards = [card.model_copy(update={"review": False}) if card.card_id == "rv-link" else card for card in cards]
    draft = await owner.call("POST /policy/draft", PolicyDraftRequest(
        desk_id=desk_id, cards=cards, expected_parent=row["version"]))
    assert draft.status == "proved"
    active = await owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=desk_id, version=draft.version))
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    session_id = visitor.state.session_id
    await issue_payment_link(http.session(visitor.session_token), session_id,
                             item_id(ro_read, schema, copy, "Service call deposit"), 1)
    draft = await owner.call("POST /policy/draft", PolicyDraftRequest(
        desk_id=desk_id, expected_parent=active.version,
        cards=[card.model_copy(update={"max_amount_cents": 1000}) if card.card_id == "rv-link" else card
               for card in cards]))
    assert draft.status == "proved"
    await owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=desk_id, version=draft.version))
    (link,) = ro_read(schema, copy.copy_id, "SELECT link_id, state FROM {ro}.payment_links WHERE session_id = %s",
                     (session_id,))
    assert link["state"] == "cancelled"
    reads = [await owner.call("GET /policy/{version}/cancelled_links?desk_id=", path={"version": draft.version},
                              query={"desk_id": desk_id}) for _ in range(2)]
    for notices in reads:
        assert len(notices) == 1
        notice = notices[0]
        assert (notice.link_id, notice.session_id) == (link["link_id"], session_id)
        assert notice.verdict.ok and notice.verdict.generation == visitor.state.generation
        assert [(block.template, block.fact_id) for block in notice.verdict.blocks] == [
            ("link_cancelled", f"payment_link:{link['link_id']}")]
    # Re-reads return freshly signed verdicts; the API must deduplicate by link, not message ID.
    assert reads[0][0].verdict.message_id != reads[1][0].verdict.message_id
