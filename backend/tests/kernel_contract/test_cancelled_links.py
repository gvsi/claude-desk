"""Rule activation's cancelled-link notices, on both kernels (Plan 01c)."""

from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from desk.contracts import HoursWindow, RuleCard
from desk.kernel_api import PolicyConfirmRequest, PolicyDraftRequest
from tests.kernel_contract.test_contract import (
    DANA, checkout, code_in, desk_slug, issue_payment_link, item_id, new_copy, new_visitor,
    session_inbox, verify_check, verify_start,
)


def link_hours(local: datetime, *, controlled_clock: bool) -> HoursWindow:
    if not controlled_clock:
        # The real-kernel contract fixture talks to a process with no clock-control hook.
        # It cannot cross a boundary on demand: allow every day, including midnight
        # (an end of 00:00 means minute 1440), through copy creation and rule proving.
        return HoursWindow(days=["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start=time(0), end=time(0))
    return HoursWindow(days=[local.strftime("%a").lower()], start=time(local.hour),
                       end=time((local.hour + 1) % 24))


@pytest.mark.parametrize("hour", range(24))
def test_link_hours_uses_whole_minutes_at_every_hour(hour):
    local = datetime(2026, 10, 30, hour, 59, tzinfo=ZoneInfo("America/Los_Angeles"))
    for controlled_clock in (True, False):
        hours = link_hours(local, controlled_clock=controlled_clock)
        assert hours.start.second == hours.start.microsecond == 0
        assert hours.end.second == hours.end.microsecond == 0
        if not controlled_clock:
            assert set(hours.days) == {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
            assert hours.start == hours.end == time(0)


@pytest.mark.kernel_plan("01c")
async def test_unrelated_activation_keeps_link_allowed_at_its_decision_time(kernel, ro_read):
    http, schema, state = kernel
    # The fake can cross the window's end without waiting for the system clock.
    if state is not None:
        state.now = datetime(2026, 10, 30, 16, 59, tzinfo=UTC)
    now = state.now if state is not None else datetime.now(UTC)
    local = now.astimezone(ZoneInfo("America/Los_Angeles"))
    hours = link_hours(local, controlled_clock=state is not None)
    copy = await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    (row,) = ro_read(schema, copy.copy_id, "SELECT version, cards FROM {ro}.policy_versions"
                    " WHERE desk_id = %s AND status = 'active'", (desk_id,))
    cards = [RuleCard.model_validate(card) for card in row["cards"] if not card["is_default"]]
    cards = [card.model_copy(update={"review": False, "hours": hours}) if card.card_id == "rv-link" else card
             for card in cards]
    draft = await owner.call("POST /policy/draft", PolicyDraftRequest(
        desk_id=desk_id, cards=cards, expected_parent=row["version"]))
    assert draft.status == "proved"
    active = await owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=desk_id, version=draft.version))
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    session_id = visitor.state.session_id
    token, _ = await issue_payment_link(http.session(visitor.session_token), session_id,
                                       item_id(ro_read, schema, copy, "Service call deposit"), 1)
    if state is not None:
        state.now += timedelta(minutes=2)
    draft = await owner.call("POST /policy/draft", PolicyDraftRequest(
        desk_id=desk_id, expected_parent=active.version, cards=[*cards, RuleCard(
            card_id="unrelated", applies_to="native.capture_lead", mode="auto", who="anyone", reason="Save leads.")]))
    assert draft.status == "proved"
    await owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=desk_id, version=draft.version))
    assert (await checkout(http, "GET /payment_links/{token}", token)).state == "issued"
    assert await owner.call("GET /policy/{version}/cancelled_links?desk_id=", path={"version": draft.version},
                            query={"desk_id": desk_id}) == []


@pytest.mark.kernel_plan("01c")
async def test_unrelated_activation_keeps_link_allowed_for_dana(kernel, ro_read):
    http, schema, _ = kernel
    copy = await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    session_id = visitor.state.session_id
    view = http.session(visitor.session_token)
    started = await verify_start(view, session_id, DANA)
    await verify_check(view, session_id, code_in(await session_inbox(view, session_id), started.inbox[0].entry_id))
    (dana,) = ro_read(schema, copy.copy_id, "SELECT person_id FROM {ro}.people WHERE desk_id = %s"
                     " AND display_name = 'Dana Whitfield'", (desk_id,))
    (row,) = ro_read(schema, copy.copy_id, "SELECT version, cards FROM {ro}.policy_versions"
                    " WHERE desk_id = %s AND status = 'active'", (desk_id,))
    cards = [RuleCard.model_validate(card) for card in row["cards"] if not card["is_default"]]
    cards = [card.model_copy(update={"review": False, "who": "person", "person_id": dana["person_id"]})
             if card.card_id == "rv-link" else card for card in cards]
    draft = await owner.call("POST /policy/draft", PolicyDraftRequest(
        desk_id=desk_id, cards=cards, expected_parent=row["version"]))
    assert draft.status == "proved"
    active = await owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=desk_id, version=draft.version))
    token, _ = await issue_payment_link(view, session_id,
                                       item_id(ro_read, schema, copy, "Service call deposit"), 1)
    draft = await owner.call("POST /policy/draft", PolicyDraftRequest(
        desk_id=desk_id, expected_parent=active.version, cards=[*cards, RuleCard(
            card_id="unrelated", applies_to="native.capture_lead", mode="auto", who="anyone", reason="Save leads.")]))
    assert draft.status == "proved"
    await owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=desk_id, version=draft.version))
    assert (await checkout(http, "GET /payment_links/{token}", token)).state == "issued"
    assert await owner.call("GET /policy/{version}/cancelled_links?desk_id=", path={"version": draft.version},
                            query={"desk_id": desk_id}) == []


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
    token, _ = await issue_payment_link(http.session(visitor.session_token), session_id,
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
    payment = await checkout(http, "GET /payment_links/{token}", token)
    assert payment.state == "cancelled" and payment.cancel_reason == "rules_changed"
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
