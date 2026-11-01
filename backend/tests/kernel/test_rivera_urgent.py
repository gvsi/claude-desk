"""On a fresh Turner copy an emergency is handled as urgent. The seed gives the Desk an enabled
urgent business tool, `desk.emergency-callback`, written through the owner's own replacement and
turned on by the seed's proved rules version, so a stranger's burst pipe at 03:00 alerts Mike at
once, whatever his notification settings, instead of waiting for a Monday call-back."""

from datetime import datetime

import psycopg
import pytest
from sqlalchemy import select

from desk.contracts import BusinessToolDef, RuleCard
from desk.db.models import DemoInboxEntry, Handoff, NotificationPref, PolicyVersion, Tool
from desk.db.session import database_url, libpq_url
from desk.kernel_api import ToolPin
from desk.kernel_service import activation, business_tools, mcp_pins, reply_check, seed
from desk.kernel_service.adapters import blocks
from desk.kernel_service.repo import storable

from .helpers import kernel_ctx, ledger_rows, rows_of
from .test_adapters import visitor_of
from .test_context import context_of
from .test_decide import decided
from .test_execute import executed, read
from .test_lead_tools import CALLBACK, TZ

TOOL = "desk.emergency-callback"
BURST = {"name": "Sam Lee", "contact": "(510) 555-0100", "reason": "My pipes have burst"}


def seeded_tool():
    [tool] = seed.RIVERA_BUSINESS_TOOLS
    return tool


def definition_hash() -> str:
    return blocks.definition_sha256(BusinessToolDef.model_validate(seeded_tool().model_dump(exclude={"tool"})))


def test_the_seed_configures_an_urgent_emergency_callback_and_a_card_for_it():
    tool = seeded_tool()
    assert tool.model_dump(mode="json") == {
        "tool": TOOL, "title": "Emergency callback",
        "description": "Asks Mike to call back urgently about an emergency.",
        "config": {"block": "urgent",
                   "urgent_when": "A burst or leaking pipe, flooding, a sewage backup, or no water"}}
    [card] = [card for card in seed.RIVERA_CARDS if card.applies_to == TOOL]
    assert card == RuleCard(card_id="rv-urgent", applies_to=TOOL, mode="auto", who="anyone",
                            reason="Anyone can ask for an urgent callback, which alerts you at once.")
    assert card.max_amount_cents is None and not card.review and card.hours is None
    # the shipped proof covers the tool, enabled and pinned at its definition
    [profile] = [p for p in activation.shipped_profiles("rivera") if p.source == "business"]
    assert (profile.tool, profile.status, profile.review_reason, profile.effects) == (TOOL, "enabled", None, ["change"])
    assert profile.definition_sha256 == definition_hash()
    assert not [p for p in activation.shipped_profiles("ask_first") if p.source == "business"]


def test_the_seed_strings_pass_the_card_text_check():
    """Every string the seed's urgent tool and its card carry passes the business-tool card-text
    check (no amount, currency, percentage, promise word or hidden control), each field on its own
    and all together, which is stricter than the replacement's check of the title alone."""
    tool = seeded_tool()
    [card] = [card for card in seed.RIVERA_CARDS if card.card_id == "rv-urgent"]
    texts = {"title": tool.title, "description": tool.description, "urgent_when": tool.config.urgent_when,
             "reason": card.reason}
    for field, text in texts.items():
        assert storable(text), field
        assert reply_check.scan_prose(text) == [], field
        assert business_tools.hidden_fields({field: text}) == {}, field
        assert reply_check.scan_public_policies({field: text}, amenities=False) == {}, field
    assert reply_check.scan_public_policies(texts, amenities=False) == {}
    fields = business_tools.public_fields(tool)
    assert business_tools.card_refusal(tool, reply_check.scan_public_policies(
        fields, allow_words=business_tools.free_allow_words(tool), amenities=False)) == {}


async def test_a_fresh_copy_has_the_emergency_callback_enabled_and_offered_to_a_visitor(app, client):
    copy, visitor = await visitor_of(app, client)
    [row] = await rows_of(app, copy.copy_id, select(Tool).where(Tool.source == "business"))
    assert (row.desk_id, row.tool, row.status, row.review_reason) == (copy.desk_id, TOOL, "enabled", None)
    assert row.definition_sha256 == row.profile.definition_sha256 == definition_hash()
    assert row.profile.business.model_dump(mode="json") == seeded_tool().model_dump(mode="json", exclude={"tool"})
    assert row.pending_definition_text is None and row.pending_sha256 is None
    # version 1 is the seed's proved rules, and it is what turned the tool on
    [version] = await rows_of(app, copy.copy_id, select(PolicyVersion))
    assert (version.version, version.status, version.preset) == (1, "active", "rivera")
    assert version.enables == [ToolPin(tool=TOOL, definition_sha256=definition_hash())]
    assert "rv-urgent" in {card.card_id for card in version.cards}
    entries = await ledger_rows(app, copy)
    [written] = [entry.event.summary for entry in entries if entry.event.kind == "business_tools"]
    assert written == {"tools": [{"tool": TOOL, "block": "urgent", "definition_sha256": definition_hash(),
                                  "change": "new"}]}
    kinds = [(entry.event.kind, entry.event.summary.get("event")) for entry in entries]
    assert kinds.index(("business_tools", None)) < kinds.index(("policy", None)) < kinds.index(("tool_pin", "enabled"))
    [enabled] = [entry.event.summary for entry in entries if entry.event.summary.get("event") == "enabled"]
    assert enabled == {"tool": TOOL, "event": "enabled", "version": 1, "definition_sha256": definition_hash()}
    # a stranger is given it, beside its base tool
    seen = await context_of(client, visitor.session_id, visitor.headers)
    assert {TOOL, "native.request_callback"} <= {profile.tool for profile in seen.tools}
    assert TOOL in {profile.tool for profile in seen.tools_declared}


async def test_a_burst_pipe_at_three_in_the_morning_alerts_maria_at_once(app, client, frozen_clock):
    frozen_clock.travel(datetime(2026, 10, 25, 3, 0, tzinfo=TZ))     # a Sunday, 03:00 in Oakland
    copy, visitor = await visitor_of(app, client)
    # Mike hears of call-backs in his briefing, not at once: the urgent alert mustn't lean on his settings
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        [settings] = await ctx.db.scalars(ctx.repo.scoped(select(NotificationPref)))
        settings.now = [kind for kind in settings.now if kind != "callback"]
        settings.briefing = [*(kind for kind in settings.briefing if kind != "callback"), "callback"]
    [prefs] = await rows_of(app, copy.copy_id, select(NotificationPref))
    assert "callback" not in prefs.now and "callback" in prefs.briefing
    decision = await decided(client, visitor, TOOL, BURST)
    assert (decision.outcome, decision.card_ids) == ("allow", ["rv-urgent"]), decision.reason_plain
    result = await executed(client, visitor, decision)
    assert result.state == "succeeded"
    [handoff] = await rows_of(app, copy.copy_id, select(Handoff))
    assert (handoff.kind, handoff.status, handoff.action_id) == ("callback", "open", decision.action.action_id)
    assert (handoff.window_start, handoff.window_end) == (None, None)    # urgent: no Monday slot promised
    [alert] = await rows_of(app, copy.copy_id, select(DemoInboxEntry).where(
        DemoInboxEntry.preview == "Urgent callback requested"))
    assert (alert.to, alert.kind, alert.created_at) == ("owner", "alert", frozen_clock.now())
    assert alert.body.startswith("Reported as urgent through “Emergency callback”. ")
    receipt = await read(client, visitor.headers, decision)
    assert receipt.visitor_plain == "“Emergency callback”: urgent request sent to Mike Turner"
    [after] = await rows_of(app, copy.copy_id, select(NotificationPref))
    assert (after.now, after.briefing) == (prefs.now, prefs.briefing)


async def test_the_native_callback_stays_a_plain_callback_on_a_fresh_copy(app, client):
    """The urgent tool sits beside the native callback; a non-urgent call-back still uses it."""
    copy, visitor = await visitor_of(app, client)
    decision = await decided(client, visitor, "native.request_callback", CALLBACK)
    assert decision.outcome == "allow"
    assert (await executed(client, visitor, decision)).state == "succeeded"
    assert not await rows_of(app, copy.copy_id, select(DemoInboxEntry).where(
        DemoInboxEntry.preview == "Urgent callback requested"))


async def test_a_seed_tool_the_card_text_check_refuses_creates_no_copy(app, client, monkeypatch, caplog):
    """The seed's business tools are checked as an owner's batch is; one the check refuses fails
    the copy closed (503 `seed_unproved`), with nothing written and no refusal ledgered on a Desk
    that never existed."""
    promised = seeded_tool().model_copy(update={"title": "Guaranteed callback"})
    monkeypatch.setattr(seed, "RIVERA_BUSINESS_TOOLS", [promised])
    response = await client.post("/copies", json={})
    assert (response.status_code, response.json()) == (503, {"code": "seed_unproved"})
    assert any(r.getMessage().startswith("seed_unproved reason=business_tools_refused") for r in caplog.records)
    with psycopg.connect(libpq_url(database_url("ADMIN"))) as admin:
        counts = {table: admin.execute(f"SELECT count(*) FROM kernel.{table}").fetchone()[0]
                  for table in ("copies", "desks", "tools", "policy_versions", "ledger_entries")}
    assert counts == dict.fromkeys(counts, 0)


@pytest.mark.parametrize("fault", ["pin_changed", "profile_changed"])
async def test_a_seed_tool_its_version_cannot_turn_on_creates_no_copy(app, client, monkeypatch, caplog, fault):
    """The seed's version turns its urgent tool on only at the pin it was proved with: a pin that is no
    longer current, or a stored profile that no longer matches its definition, is the shipped set left
    unproved, as a missing report is (503 `seed_unproved`, the preset listed in `/health`), with
    nothing written."""
    if fault == "pin_changed":
        async def changed(ctx, desk_id, enables):
            return mcp_pins.EnablesCheck("changed")

        monkeypatch.setattr(mcp_pins, "check_enables", changed)
    else:
        pinned = mcp_pins.pinned_profile

        def stale(tool, definition_sha256, stored=None):
            if tool == TOOL:
                raise mcp_pins.BusinessProfileChanged("business_profile_changed")
            return pinned(tool, definition_sha256, stored)

        monkeypatch.setattr(mcp_pins, "pinned_profile", stale)
    response = await client.post("/copies", json={})
    assert (response.status_code, response.json()) == (503, {"code": "seed_unproved"})
    assert (await client.get("/health")).json()["unproved_seeds"] == ["rivera"]
    assert any(r.getMessage().startswith(f"seed_unproved preset=rivera reason={fault}") for r in caplog.records)
    with psycopg.connect(libpq_url(database_url("ADMIN"))) as admin:
        counts = {table: admin.execute(f"SELECT count(*) FROM kernel.{table}").fetchone()[0]
                  for table in ("copies", "desks", "tools", "policy_versions", "ledger_entries")}
    assert counts == dict.fromkeys(counts, 0)
