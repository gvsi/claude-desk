"""Setup safety probes: `POST /policy/{version}/probe` tries a rules version on hypothetical callers.

Setup drafts the owner's rules and, before they go live, asks what they would decide for a stranger,
a verified customer, a visiting agent or the owner's own setup. A probe names the caller's standing,
the tool and its arguments, and stand-ins for everything the kernel would otherwise look up (the
record's owner, the price, the time). Nothing is resolved or executed: no quote, slot or document is
read, no reviewer is asked, and no decision, approval or execution is written.

Tests run on a new Desk from `POST /desks`, which starts with Answering off, as setup finds it, and
draft their cards through `POST /policy/draft` in the kernel's `bounded` mode, so the version probed
is a draft that never activates. `native.payment_link` and `native.charge_mandate` are stand-ins
(`FakeAdapter`) whose hooks would fail the test if a probe ever called them.
"""

from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
import psycopg
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import PolicyVersion, Probe, ProbeResult, RuleCard
from desk.db.models import PolicyVersion as PolicyVersionRow
from desk.db.session import database_url, libpq_url
from desk.db.tables import KERNEL_TABLES
from desk.kernel_api import ToolConfirmed
from desk.kernel_service import activation, mcp_pins

from .fakes import FakeAdapter
from .helpers import TEST_CAP, kernel_ctx, ledger_rows, rows_of
from .test_adapters import Rivera, quote_args, rivera
from .test_compiler import WEEKDAYS
from .test_decide import PASS, open_visitor
from .test_desk_writes import new_desk, post_desk
from .test_mcp_pins import confirm_tools, connect, tool_rows
from .test_money_cap import enable, post_draft


async def setup_desk(app: FastAPI, client: httpx.AsyncClient) -> Rivera:
    """A new Desk from `POST /desks` in a fresh copy: the starter rules active, Answering off."""
    copy = await rivera(app, client)
    response = await post_desk(client, copy, new_desk())
    assert response.status_code == 200, response.text
    created = response.json()
    return Rivera(copy_id=copy.copy_id, desk_id=created["desk_id"], slug=created["slug"], owner_token=copy.owner_token)


async def drafted(client: httpx.AsyncClient, desk: Rivera, cards: list[RuleCard]) -> PolicyVersion:
    """`cards` drafted on the Desk's first version at a $500 money cap: checked, never active."""
    response = await post_draft(client, desk, cards, 1, auto_money_cap_cents=TEST_CAP)
    assert response.status_code == 200, response.text
    version = PolicyVersion.model_validate(response.json())
    assert (version.status, version.proof.method) == ("draft", "bounded"), version.proof
    return version


def probe(tool: str, args: dict | None = None, *, resource_kind: str = "desk", actor: str = "visitor",
          who: str = "anyone", **fields) -> dict:
    return {"actor": actor, "who": who, "call": {"call_id": "probe", "tool": tool, "args": args or {}},
            "resource_kind": resource_kind, **fields}


async def post_probes(client: httpx.AsyncClient, desk: Rivera, version: int, probes: list[dict], *,
                      headers: dict[str, str] | None = None) -> httpx.Response:
    return await client.post(f"/policy/{version}/probe", headers=desk.owner if headers is None else headers,
                             json={"desk_id": desk.desk_id, "probes": probes})


async def probed(client: httpx.AsyncClient, desk: Rivera, version: int, probes: list[dict]) -> list[ProbeResult]:
    response = await post_probes(client, desk, version, probes)
    assert response.status_code == 200, response.text
    results = [ProbeResult.model_validate(result) for result in response.json()]
    assert [result.probe for result in results] == [Probe.model_validate(probe) for probe in probes]
    return results


def rule(card_id: str, applies_to: str, reason: str, mode: str = "auto", who: str = "anyone", **fields) -> RuleCard:
    return RuleCard(card_id=card_id, applies_to=applies_to, mode=mode, who=who, reason=reason, **fields)


QUOTES = rule("quotes", "native.quote", "Quotes go ahead with up to 10% off.", max_discount_bp=1_000)
RECORDS = rule("records", "native.release_document", "Customers get their own records.", who="record_owner")


async def test_stranger_asking_half_off_asks_the_owner(app, client, reviewer):
    desk = await setup_desk(app, client)
    version = await drafted(client, desk, [QUOTES])
    # the stand-in price decides, not the price list's $95 visit, which no probe reads
    half_off, tenth_off = await probed(client, desk, version.version, [
        probe("native.quote", quote_args(("visit", 1), discount_bp=5_000), amount_cents=20_000),
        probe("native.quote", quote_args(("visit", 1), discount_bp=1_000), amount_cents=20_000)])
    assert (half_off.outcome, half_off.card_ids, half_off.depends_on_review) == ("hold", ["quotes"], False)
    assert half_off.reason_plain == ("A stranger asks to get a quote for $100 with 50% off. It would ask you first. "
                                     "Quotes go ahead with up to 10% off.")
    assert (tenth_off.outcome, tenth_off.card_ids, tenth_off.depends_on_review) == ("allow", ["quotes"], False)
    assert tenth_off.reason_plain.startswith("A stranger asks to get a quote for $180 with 10% off. "
                                             "It would go ahead without asking you.")
    assert reviewer.inputs == []


def row_counts() -> dict[str, int]:
    """How many rows each kernel table holds, read as desk_admin across every copy."""
    with psycopg.connect(libpq_url(database_url("ADMIN"))) as admin:
        return {table: admin.execute(f"SELECT count(*) FROM kernel.{table}").fetchone()[0] for table in KERNEL_TABLES}


async def statuses(app: FastAPI, desk: Rivera) -> dict[int, str]:
    rows = await rows_of(app, desk.copy_id, select(PolicyVersionRow).where(PolicyVersionRow.desk_id == desk.desk_id))
    return {row.version: row.status for row in rows}


async def test_probes_change_nothing(app, client, reviewer):
    desk = await setup_desk(app, client)
    version = await drafted(client, desk, [QUOTES, rule("book", "native.book", "Weekday visits book.", hours=WEEKDAYS)])
    before, versions = row_counts(), await statuses(app, desk)
    assert versions == {1: "active", 2: "draft"}
    probes = [probe("native.quote", quote_args(("visit", 1), discount_bp=5_000), amount_cents=20_000),
              probe("native.book", {"slot_id": "S-20261102-0900"}, resource_kind="slot")]
    assert [result.outcome for result in await probed(client, desk, version.version, probes)] == ["hold", "allow"]
    # the active version can be probed as well: under the starter rules both ask the owner
    assert [result.outcome for result in await probed(client, desk, 1, probes)] == ["hold", "hold"]

    # nothing was decided, approved, executed, alerted or activated: only the two probes were ledgered
    after = row_counts()
    assert after == before | {"ledger_entries": before["ledger_entries"] + 2}
    assert await statuses(app, desk) == versions
    policy = [entry.event for entry in await ledger_rows(app, desk) if entry.event.kind == "policy"]
    assert [(event.origin, event.session_id, event.summary) for event in policy[-2:]] == [
        ("kernel", None, {"version": 2, "probes": 2, "outcomes": ["hold", "allow"]}),
        ("kernel", None, {"version": 1, "probes": 2, "outcomes": ["hold", "hold"]})]
    assert reviewer.inputs == []


async def test_review_gated_card_probes_as_hold_depending_on_review(app, client, reviewer):
    reviewer.answer = PASS                       # a reviewer that would agree is still never asked
    desk = await setup_desk(app, client)
    version = await drafted(client, desk, [rule("book", "native.book", "Visits book once the reviewer agrees.",
                                                review=True)])
    [result] = await probed(client, desk, version.version, [
        probe("native.book", {"slot_id": "S-20261102-0900"}, resource_kind="slot")])
    assert (result.outcome, result.depends_on_review, result.card_ids) == ("hold", True, ["book"])
    assert result.reason_plain == ("A stranger asks to book a visit. It would ask you first. Visits book once the "
                                   "reviewer agrees. It would go ahead on its own if the reviewer finds it within "
                                   "your rules.")
    assert reviewer.inputs == []


def stand_in(tool: str) -> FakeAdapter:
    """A charge tool whose hooks fail the test if a probe ever runs one."""
    fake = FakeAdapter(tool, effects=["charge"], resource_kind="quote")
    for hook in ("normalize", "prepare", "execute", "reconcile"):
        fake.script[hook] = AssertionError(f"a probe ran {tool}'s {hook}")
    return fake


@pytest.mark.parametrize(("remaining", "outcome"), [(1_000, "refuse"), (5_000, "allow")])
async def test_agent_probe_uses_the_hypothetical_mandate(app, client, registry, remaining, outcome):
    desk = await setup_desk(app, client)
    charge = await enable(app, desk, stand_in("native.charge_mandate"))
    version = await drafted(client, desk, [rule("agent-charges", "native.charge_mandate",
                                                "Visiting agents pay deposits up to $50.", max_amount_cents=5_000)])
    [result] = await probed(client, desk, version.version, [
        probe("native.charge_mandate", resource_kind="quote", actor="agent", amount_cents=2_000,
              agent_mandate_remaining_cents=remaining)])
    assert (result.outcome, result.depends_on_review) == (outcome, False)
    if outcome == "refuse":                      # the always-on rule refuses a charge above the mandate's room
        assert result.card_ids == []
        assert result.reason_plain == ("A visiting agent asks to be charged $20. It would be refused. "
                                       + activation.BASELINE_REASONS["agent_charge_within_mandate"])
    else:
        assert result.card_ids == ["agent-charges"]
        assert result.reason_plain == ("A visiting agent asks to be charged $20. It would go ahead without asking "
                                       "you. Visiting agents pay deposits up to $50.")
    assert charge.calls == []


async def test_money_probes_need_no_quote(app, client, registry):
    desk = await setup_desk(app, client)
    link = await enable(app, desk, stand_in("native.payment_link"))
    version = await drafted(client, desk, [rule("links", "native.payment_link", "Payment links up to $100 go out.",
                                                max_amount_cents=10_000)])
    # no quote exists: the stand-in amount is what the rules decide on
    within, above, unpriced = await probed(client, desk, version.version, [
        probe("native.payment_link", resource_kind="quote", amount_cents=8_000),
        probe("native.payment_link", resource_kind="quote", amount_cents=12_000),
        probe("native.payment_link", resource_kind="quote")])
    assert (within.outcome, within.card_ids) == ("allow", ["links"])
    assert within.reason_plain == ("A stranger asks to get a payment link for $80. It would go ahead without asking "
                                   "you. Payment links up to $100 go out.")
    assert (above.outcome, above.card_ids) == ("hold", ["links"])
    assert above.reason_plain.startswith("A stranger asks to get a payment link for $120. It would ask you first.")
    assert (unpriced.outcome, unpriced.card_ids, unpriced.depends_on_review) == ("refuse", [], False)
    assert unpriced.reason_plain == ("A stranger asks to get a payment link. It would be refused. "
                                     "A payment always names an amount.")
    assert link.calls == []


async def test_unknown_or_withheld_tool_probes_refuse(app, client):
    desk = await setup_desk(app, client)
    version = await drafted(client, desk, [QUOTES])
    unknown, refund, website = await probed(client, desk, version.version, [
        probe("admin.export_customers", {"all": True}),
        probe("payments.create_refund", {"charge_id": "ch_1"}, resource_kind="charge", actor="agent", amount_cents=500),
        probe("native.fetch_website", {"url": "https://example.com/"}, actor="agent")])
    for result in (unknown, refund, website):
        assert (result.outcome, result.card_ids, result.depends_on_review) == ("refuse", [], False)
    assert unknown.reason_plain == ("A stranger asks for something this Desk can't do. It would be refused. "
                                    "This Desk has no tool for that.")
    assert refund.reason_plain.startswith("A visiting agent asks to get a $5 refund. It would be refused. ")
    assert website.reason_plain == ("A visiting agent asks to read a website. It would be refused. "
                                    "This caller can't use that tool.")

    # rules that can't load still answer each probe, with a refusal
    broken = await drafted(client, desk, [QUOTES, RECORDS])
    async with kernel_ctx(app) as ctx:
        ctx.bind(desk.copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(select(PolicyVersionRow).where(
            PolicyVersionRow.desk_id == desk.desk_id, PolicyVersionRow.version == broken.version)))).one()
        row.cedar_sha256 = "0" * 64
    [unloadable] = await probed(client, desk, broken.version, [probe("native.quote", quote_args(("visit", 1)))])
    assert (unloadable.outcome, unloadable.card_ids, unloadable.reason_plain) == (
        "refuse", [], "A stranger asks to get a quote. It would be refused. These rules couldn't be loaded.")

    # only a malformed body fails the batch: too many probes, or text the answer can't carry back
    entries = len(await ledger_rows(app, desk))
    too_many = await post_probes(client, desk, version.version, [probe("native.quote")] * (activation.MAX_PROBES + 1))
    lone_surrogate = ('{"desk_id": "%s", "probes": [{"actor": "visitor", "who": "anyone", "resource_kind": "desk", '
                      '"call": {"call_id": "probe", "tool": "native.quote", "args": {"note": "\\ud800"}}}]}')
    unsendable = await client.post(f"/policy/{version.version}/probe", content=lone_surrogate % desk.desk_id,
                                   headers={**desk.owner, "content-type": "application/json"})
    for response in (too_many, unsendable):
        assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert len(await ledger_rows(app, desk)) == entries


async def tools_confirm_draft(app: FastAPI, client: httpx.AsyncClient, desk: Rivera, tool: str) -> PolicyVersion:
    """The rules draft `/tools/confirm` answers with when the owner turns `tool` on: a built-in tool
    the owner turned off first, or a payments tool just connected and waiting for review. Checked
    (in the kernel's `bounded` mode) or proved (with the solver), never active, and the tool stays
    off until the owner confirms it."""
    if mcp_pins.is_mcp(tool):
        connected = {profile.tool: profile for profile in await connect(client, desk)}
        pin = (tool, connected[tool].definition_sha256)
    else:
        pin = (tool, (await tool_rows(app, desk.copy_id, desk.desk_id))[tool].definition_sha256)
        response = await confirm_tools(client, desk, [pin], enable=False)
        assert response.status_code == 200, response.text
    off = (await tool_rows(app, desk.copy_id, desk.desk_id))[tool].status
    assert off in ("disabled", "needs_review")
    response = await confirm_tools(client, desk, [pin], enable=True)
    assert response.status_code == 200, response.text
    draft = ToolConfirmed.model_validate(response.json()).draft
    assert draft is not None and (draft.status, draft.proof.method) in {("draft", "bounded"), ("proved", "symcc")}
    assert (await tool_rows(app, desk.copy_id, desk.desk_id))[tool].status == off
    return draft


TURNED_ON = {
    "built_in": ("native.book", probe("native.book", {"slot_id": "S-20261102-0900"}, resource_kind="slot"),
                 "A stranger asks to book a visit."),
    "connected": ("payments.list_charges",
                  probe("payments.list_charges", resource_kind="charge", who="record_owner", resource_owner="caller"),
                  "A verified customer asks to see payment history."),
}


@pytest.mark.parametrize("turned_on", TURNED_ON)
async def test_draft_turning_a_tool_on_probes_it_as_usable(app, client, turned_on):
    tool, tried, asked = TURNED_ON[turned_on]
    desk = await setup_desk(app, client)
    draft = await tools_confirm_draft(app, client, desk, tool)
    before = (await tool_rows(app, desk.copy_id, desk.desk_id))[tool].status
    # the draft's rules decide the tool it turns on: under the starter rules it asks the owner
    [on] = await probed(client, desk, draft.version, [tried])
    assert (on.outcome, on.depends_on_review) == ("hold", False)
    assert on.reason_plain.startswith(f"{asked} It would ask you first.")
    # the active rules don't have it: the tool is off on this Desk until the owner confirms the draft
    [off] = await probed(client, desk, 1, [tried])
    assert (off.outcome, off.card_ids, off.reason_plain) == (
        "refuse", [], f"{asked} It would be refused. This caller can't use that tool.")
    # probing turned nothing on
    assert (await tool_rows(app, desk.copy_id, desk.desk_id))[tool].status == before
    assert await statuses(app, desk) == {1: "active", draft.version: "draft"}


@pytest.mark.solver
async def test_tool_turned_off_after_its_version_activated_probes_as_off(desk_prove, app, client):
    tool, tried, asked = TURNED_ON["built_in"]
    desk = await setup_desk(app, client)
    draft = await tools_confirm_draft(app, client, desk, tool)
    response = await client.post("/policy/confirm", headers=desk.owner,
                                 json={"desk_id": desk.desk_id, "version": draft.version})
    assert response.status_code == 200, response.text
    [on] = await probed(client, desk, draft.version, [tried])
    assert (on.outcome, on.depends_on_review) == ("hold", False)
    # the owner turns the tool off again, which takes effect at once without a new version: the
    # active version turned it on when it activated, and it doesn't turn it on again when probed
    rows = await tool_rows(app, desk.copy_id, desk.desk_id)
    response = await confirm_tools(client, desk, [(tool, rows[tool].definition_sha256)], enable=False)
    assert response.status_code == 200, response.text
    [off] = await probed(client, desk, draft.version, [tried])
    assert (off.outcome, off.card_ids, off.reason_plain) == (
        "refuse", [], f"{asked} It would be refused. This caller can't use that tool.")
    assert await statuses(app, desk) == {1: "superseded", draft.version: "active"}


CALLERS = {
    "unverified": ("anyone", "caller", "refuse", [],
                   "A stranger asks to receive a private document. It would be refused. "
                   "This caller can't use that tool."),
    "someone_elses": ("verified", "other", "refuse", [],
                      "A verified customer asks to receive a private document. It would be refused. "
                      + activation.BASELINE_REASONS["private_data_record_owner"]),
    "their_own": ("record_owner", "caller", "allow", ["records"],
                  "A verified customer asks to receive a private document. It would go ahead without asking you. "
                  "Customers get their own records."),
}


@pytest.mark.parametrize("caller", CALLERS)
async def test_probe_callers(app, client, caller):
    who, resource_owner, outcome, card_ids, reason = CALLERS[caller]
    desk = await setup_desk(app, client)
    version = await drafted(client, desk, [RECORDS])
    # no document is read: the record and its owner are stand-ins
    [result] = await probed(client, desk, version.version, [
        probe("native.release_document", {"document_id": "not-a-document"}, resource_kind="document", who=who,
              resource_owner=resource_owner)])
    assert (result.outcome, result.card_ids, result.depends_on_review, result.reason_plain) == (
        outcome, card_ids, False, reason)


CHICAGO = ZoneInfo("America/Chicago")         # Lopez Electric's time zone; the kernel's clock reads Friday noon there
STARTS = {
    "sunday_night": (datetime(2026, 11, 1, 22, 0, tzinfo=CHICAGO), "S-20261101-2200", "hold"),
    "tuesday_morning": (datetime(2026, 11, 3, 10, 0, tzinfo=CHICAGO), "S-20261103-1000", "allow"),
}


@pytest.mark.parametrize("start", STARTS)
async def test_probe_uses_its_start_time(app, client, start):
    starts_at, slot_id, outcome = STARTS[start]
    desk = await setup_desk(app, client)
    version = await drafted(client, desk, [rule("weekdays", "native.book", "Weekday visits book on their own.",
                                                hours=WEEKDAYS)])
    [result] = await probed(client, desk, version.version, [
        probe("native.book", {"slot_id": slot_id}, resource_kind="slot", starts_at=starts_at.isoformat())])
    assert (result.outcome, result.card_ids, result.depends_on_review) == (outcome, ["weekdays"], False)


async def test_probe_requires_the_owner_of_the_copy(app, client):
    desk = await setup_desk(app, client)
    version = await drafted(client, desk, [QUOTES])
    probes = [probe("native.quote", quote_args(("visit", 1)), amount_cents=9_500)]
    entries = len(await ledger_rows(app, desk))
    other = await rivera(app, client)
    visitor = await open_visitor(client, desk)
    for headers, status, code in [(other.owner, 404, "not_found"), (visitor.headers, 401, "auth"), ({}, 401, "auth")]:
        response = await post_probes(client, desk, version.version, probes, headers=headers)
        assert (response.status_code, response.json()) == (status, {"code": code})
    # the owner probes only versions the Desk has
    for missing in (9, 2**70):
        response = await post_probes(client, desk, missing, probes)
        assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    assert len(await ledger_rows(app, desk)) == entries + 1          # the visitor's session, nothing for any probe
    assert [result.outcome for result in await probed(client, desk, version.version, probes)] == ["allow"]
    # a deleted Desk has nothing left to set up
    assert (await client.delete(f"/desks/{desk.desk_id}", headers=desk.owner)).status_code == 204
    response = await post_probes(client, desk, version.version, probes)
    assert (response.status_code, response.json()) == (409, {"code": "closed"})
