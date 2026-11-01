"""Rules versions an earlier kernel stored keep working after an upgrade.

A version is proved against the always-on baseline the kernel enforces with it. The kernel core
stored its versions under its own baseline, with a schema that has no `auto_money_cap_cents` in
the context, which this kernel's baseline reads, so such a version doesn't even load. At startup
the kernel rebuilds each active version stored under another baseline from its own cards, at the
money cap the money cap revision kept for it, and puts the rebuild in its place only with a proof
of all seven obligations; a version it can't rebuild and prove refuses every call, and the owner
is alerted. Startup does this from cached reports within a budget before the kernel serves,
finding the Desks included, and leaves the rest, finding and live proofs included, to a background
rebuild while the kernel serves; a version not yet rebuilt refuses meanwhile, and its owner is told
so before the background starts, at most once an hour.

`fixtures/kernel_core_version.json` is a version exactly as the kernel core stored it, with the
tools it was compiled over: Rivera's cards plus an auto payment link card up to $100, over the
kernel core's native tools and a payment link tool, compiled by the kernel core's compiler and
proved by `desk-prove` on the kernel core's inputs. It is frozen: made again with a later compiler
it would test nothing.
"""

import asyncio
import json
import logging
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import psycopg
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, select

from desk.contracts import ProofReport, RuleCard, ToolProfile
from desk.db.models import DemoInboxEntry as InboxRow
from desk.db.models import Desk, PolicyVersion, Tool
from desk.db.session import database_url, libpq_url
from desk.kernel_service import activation, adapters, compiler, desks
from desk.kernel_service import app as app_module
from desk.kernel_service.app import create_app
from desk.kernel_service.decide import UNCOVERED_PLAIN

from .fakes import FakeDecisions, FrozenClock
from .helpers import kernel_ctx, rows_of
from .test_adapters import Rivera, quote_args, rivera
from .test_approvals import answered
from .test_decide import decided, open_visitor, payment_link
from .test_execute import post_execute, read
from .test_money_cap import entries_of
from .test_probe import setup_desk

KERNEL_CORE = json.loads((Path(__file__).parent / "fixtures" / "kernel_core_version.json").read_text())
KERNEL_CORE_CAP = 50_000          # the cap the money cap revision gives a version stored before it
REFUSED = "Your rules haven't been checked since an update, so it was refused."
ALERT_PREVIEW = "Your rules need checking"
# The owner's alert while a version waits for the background rebuild.
WAITING_ALERT = ("After an update, Claude is checking your rules again, so it won't act on any request until "
                 "they're checked. You don't need to do anything.")
# A card the kernel core took and this kernel refuses: it could stop a verification start.
NO_MESSAGES = RuleCard(card_id="no-messages", applies_to="effect:send_message", mode="never", who="anyone",
                       reason="Claude never sends messages.")


async def with_kernel_core_version(app: FastAPI, copy: Rivera) -> None:
    """The copy's Desk as the kernel core left it and the money cap revision upgraded it: the
    kernel core's tools, and the frozen version active as version 2, over the seed's version 1, at
    the cap the revision gives a version stored before it."""
    stored = KERNEL_CORE["version"]
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        await ctx.db.execute(delete(Tool).where(Tool.desk_id == copy.desk_id))
        for tool in KERNEL_CORE["tools"]:
            row = desks.tool_row(copy.copy_id, copy.desk_id, ToolProfile.model_validate(tool["profile"]))
            row.profile_sha256 = tool["profile_sha256"]
            ctx.db.add(row)
        seed = await activation.active_version(ctx, copy.desk_id)
        seed.status = "superseded"
        await ctx.db.flush()
        ctx.db.add(PolicyVersion(
            desk_id=copy.desk_id, copy_id=copy.copy_id, version=stored["version"],
            parent_version=stored["parent_version"], cards=[RuleCard.model_validate(c) for c in stored["cards"]],
            status=stored["status"], proof=ProofReport.model_validate(stored["proof"]),
            **{field: stored[field] for field in activation.VersionHashes._fields},
            auto_money_cap_cents=KERNEL_CORE_CAP, created_at=ctx.clock.now(), cedar=stored["cedar"],
            schema_json=stored["schema_json"], draft_key_sha256=stored["draft_key_sha256"]))


@asynccontextmanager
async def started_kernel(clock: FrozenClock, reviewer: FakeDecisions) -> AsyncIterator[tuple[FastAPI,
                                                                                         httpx.AsyncClient]]:
    """A kernel started on the same database, as the upgrade starts it, and a client of it, as soon
    as it serves."""
    kernel = create_app(clock=clock, decisions=reviewer)
    async with kernel.router.lifespan_context(kernel):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(kernel), base_url="http://kernel") as http:
            yield kernel, http


@asynccontextmanager
async def upgraded_kernel(clock: FrozenClock, reviewer: FakeDecisions) -> AsyncIterator[httpx.AsyncClient]:
    """A client of a kernel started on the same database, once the Desks its startup left to the
    background are brought up too."""
    async with started_kernel(clock, reviewer) as (kernel, http):
        if kernel.state.rebuilding is not None:
            await kernel.state.rebuilding
        yield http


async def stored_version(app: FastAPI, copy: Rivera, version: int) -> PolicyVersion:
    [row] = await rows_of(app, copy.copy_id, select(PolicyVersion).where(
        PolicyVersion.desk_id == copy.desk_id, PolicyVersion.version == version))
    return row


@pytest.mark.solver
async def test_a_kernel_core_version_decides_after_the_upgrade(app, client, registry, desk_prove, frozen_clock,
                                                               reviewer):
    copy = await rivera(app, client)
    link = payment_link(5_000)
    adapters.register(link, replace=True)
    await with_kernel_core_version(app, copy)
    owner_cards = sorted(card.card_id for card in (await stored_version(app, copy, 2)).cards)

    async with upgraded_kernel(frozen_clock, reviewer) as http:
        visitor = await open_visitor(http, copy)
        slots = await decided(http, visitor, "native.find_slots", call_id="slots")
        assert (slots.outcome, slots.policy_version, slots.card_ids) == ("allow", 2, ["preset-find-slots"])
        within = await decided(http, visitor, "native.payment_link", call_id="link-50")
        assert (within.outcome, within.policy_version, within.card_ids) == ("allow", 2, ["rv-links"])
        link.script["normalize"] = payment_link(20_000).script["normalize"]
        above = await decided(http, visitor, "native.payment_link", call_id="link-200")
        assert (above.outcome, above.policy_version) == ("hold", 2)
        decides = await entries_of(http, copy, "decide")

    assert [(e["policy_version"], e["auto_money_cap_cents"]) for e in decides[-3:]] == [(2, KERNEL_CORE_CAP)] * 3
    rebuilt = await stored_version(app, copy, 2)
    assert (rebuilt.status, rebuilt.auto_money_cap_cents) == ("active", KERNEL_CORE_CAP)
    assert rebuilt.baseline_sha256 == compiler.baseline_sha256() != KERNEL_CORE["version"]["baseline_sha256"]
    assert "auto_money_cap_cents" in rebuilt.schema_json
    assert rebuilt.proof is not None and activation.proved(rebuilt.proof)
    assert sorted(card.card_id for card in rebuilt.cards if not card.is_default) == owner_cards
    # the Desk was given the native tools registered since, and those no card for anyone covers ask by default:
    # the document release, the payments plan's mandate charge, and setup's web search
    assert [card.card_id for card in rebuilt.cards if card.is_default] == [
        "default:native.charge_mandate", "default:native.release_document", "default:native.web_search"]
    policy = await entries_of(client, copy, "policy")
    assert policy[-1] == {"version": 2, "status": "active", "rebuilt": True, "auto_money_cap_cents": KERNEL_CORE_CAP,
                          "cedar_sha256": rebuilt.cedar_sha256,
                          "from_cedar_sha256": KERNEL_CORE["version"]["cedar_sha256"]}


async def owner_alerts(app: FastAPI, copy: Rivera) -> list[InboxRow]:
    return await rows_of(app, copy.copy_id, select(InboxRow).where(
        InboxRow.desk_id == copy.desk_id, InboxRow.to == "owner", InboxRow.kind == "alert",
    ).order_by(InboxRow.created_at))


async def rules_alerts(app: FastAPI, copy: Rivera) -> list[str]:
    """The bodies of the owner's alerts about their rules, oldest first (the seed's held request
    alerts the owner too)."""
    return [alert.body for alert in await owner_alerts(app, copy) if alert.preview == ALERT_PREVIEW]


async def test_a_version_that_cant_be_proved_again_refuses_and_alerts_the_owner(app, client, registry, frozen_clock,
                                                                                reviewer):
    # bounded mode: no proof can be run, and no shipped report covers the kernel core's tools
    copy = await rivera(app, client)
    adapters.register(payment_link(5_000), replace=True)
    await with_kernel_core_version(app, copy)
    for start in (1, 2):                  # each start tries again and, until it can, refuses
        async with upgraded_kernel(frozen_clock, reviewer) as http:
            visitor = await open_visitor(http, copy)
            for tool in ("native.find_slots", "native.payment_link"):
                refused = await decided(http, visitor, tool, call_id=f"{tool}-{start}")
                assert (refused.outcome, refused.state, refused.policy_version) == ("refuse", "refused", 2), tool
                assert REFUSED in refused.reason_plain, tool

    stored = await stored_version(app, copy, 2)
    assert (stored.status, stored.baseline_sha256) == ("active", KERNEL_CORE["version"]["baseline_sha256"])
    decides = await entries_of(client, copy, "decide")
    assert [(e["outcome"], e["reason"], e["policy_version"]) for e in decides[-4:]] == \
        [("refuse", "version_outdated", 2)] * 4
    policy = await entries_of(client, copy, "policy")
    assert policy[-2:] == [{"version": 2, "rebuilt": False, "refused": "not_proved"}] * 2
    alerts = await owner_alerts(app, copy)
    assert [(alert.preview, alert.body) for alert in alerts[-2:]] == [(ALERT_PREVIEW, activation.REBUILD_ALERT)] * 2


def stored_columns(row: PolicyVersion) -> dict:
    return {column.key: getattr(row, column.key) for column in PolicyVersion.__table__.columns}


async def seed_from_an_earlier_kernel(app: FastAPI, copy: Rivera, *more_cards: RuleCard) -> None:
    """The copy's seed version as an earlier kernel stored it (under the kernel core's baseline,
    schema and invariants), holding `more_cards` too."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        seed = await activation.active_version(ctx, copy.desk_id)
        for field in ("schema_json", "schema_sha256", "baseline_sha256", "invariants_sha256"):
            setattr(seed, field, KERNEL_CORE["version"][field])
        seed.cards = [*seed.cards, *more_cards]


async def test_startup_logs_committed_cached_rebuilds_without_card_text(app, client, caplog):
    copy = await rivera(app, client)
    card_word = "CARD_LOG_CANARY_7f2e"
    # Defaults are generated again by the compiler, so their stored wording doesn't change the proof key.
    await seed_from_an_earlier_kernel(app, copy)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = await activation.active_version(ctx, copy.desk_id)
        row.cards = [card.model_copy(update={"reason": card_word}) if card.is_default else card
                     for card in row.cards]
        assert any(card.reason == card_word for card in row.cards)
    with caplog.at_level(logging.INFO, logger="desk.kernel_service.activation"):
        startup = await activation.rebuild_at_startup(app.state.kernel)
    assert startup.results == {(copy.desk_id, 1): None}
    messages = [record.getMessage() for record in caplog.records]
    assert f"version_rebuilt copy_id={copy.copy_id} desk_id={copy.desk_id} version=1 proved=cached" in messages
    assert re.fullmatch(r"startup_rebuild_done rebuilt=1 not_rebuilt=0 left=0 copies_left=0 seconds=\d+\.\d",
                        messages[-1])
    assert all(card_word not in message for message in messages)


async def test_background_logs_actual_proof_sources_and_counts(app, client, registry, monkeypatch, caplog):
    first, second = sorted([await rivera(app, client), await rivera(app, client)],
                           key=lambda copy: (copy.copy_id, copy.desk_id))
    adapters.register(payment_link(5_000), replace=True)
    for copy in (first, second):
        await with_kernel_core_version(app, copy)
    monkeypatch.setattr(activation, "_proof_mode", "symcc")
    proved = []
    report = activation.ShippedReport.model_validate_json((activation.PROOFS_DIR / "rivera.json").read_bytes()).proof

    async def passing(inputs):
        proved.append(inputs)
        return report

    monkeypatch.setattr(activation, "prove", passing)
    startup = await activation.rebuild_at_startup(app.state.kernel)
    assert startup.left == [(copy.copy_id, copy.desk_id) for copy in (first, second)]
    with caplog.at_level(logging.INFO, logger="desk.kernel_service.activation"):
        results = await activation.rebuild_in_background(app.state.kernel, startup)
    assert results == {(copy.desk_id, 2): None for copy in (first, second)}
    assert len(proved) == 1
    messages = [record.getMessage() for record in caplog.records]
    assert [message for message in messages if message.startswith("version_rebuilt ")] == [
        f"version_rebuilt copy_id={copy.copy_id} desk_id={copy.desk_id} version=2 proved={source}"
        for copy, source in ((first, "live"), (second, "cached"))]
    assert messages[-1] == "background_rebuild_done rebuilt=2 not_rebuilt=0"


async def test_startup_omits_a_version_no_longer_due_under_the_lock(app, client, monkeypatch, caplog):
    copy = await rivera(app, client)
    current = stored_columns(await stored_version(app, copy, 1))
    await seed_from_an_earlier_kernel(app, copy)
    lock, raced = activation._lock, []

    async def made_current(ctx, purpose, desk_id):
        await lock(ctx, purpose, desk_id)
        if purpose == "versions":
            # Another kernel finished after _bring_up's due-check, before its locked recheck.
            row = await activation.active_version(ctx, desk_id)
            assert activation.rebuild_due(row, await desks.enabled_profiles(ctx, desk_id))
            for field in ("schema_json", "schema_sha256", "baseline_sha256", "invariants_sha256"):
                setattr(row, field, current[field])
            await ctx.db.flush()
            raced.append(desk_id)

    monkeypatch.setattr(activation, "_lock", made_current)
    with caplog.at_level(logging.INFO, logger="desk.kernel_service.activation"):
        startup = await activation.rebuild_at_startup(app.state.kernel)
    assert raced == [copy.desk_id]
    assert startup == activation.StartupRebuild(results={}, left=[], unscanned=[])
    messages = [record.getMessage() for record in caplog.records]
    assert not any(message.startswith("version_rebuilt ") for message in messages)
    assert re.fullmatch(r"startup_rebuild_done rebuilt=0 not_rebuilt=0 left=0 copies_left=0 seconds=\d+\.\d",
                        messages[-1])
    assert all("rebuilt" not in entry for entry in await entries_of(client, copy, "policy"))


async def test_startup_logs_no_success_for_a_rolled_back_rebuild(app, client, monkeypatch, caplog):
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    rebuild, finished = activation.rebuild_version, []

    async def rebuilt_then_failed(ctx, *args, **kwargs):
        outcome = await rebuild(ctx, *args, **kwargs)
        assert isinstance(outcome, activation.RebuildSuccess)
        finished.append(outcome)

        async def fail_recheck():
            raise RuntimeError("rebuild transaction recheck failed")

        ctx.rechecks["fail-rebuild-commit"] = fail_recheck
        return outcome

    monkeypatch.setattr(activation, "rebuild_version", rebuilt_then_failed)
    with caplog.at_level(logging.INFO, logger="desk.kernel_service.activation"):
        startup = await activation.rebuild_at_startup(app.state.kernel)
    assert len(finished) == 1                       # the rebuild returned before the transaction raised
    assert startup == activation.StartupRebuild(results={}, left=[(copy.copy_id, copy.desk_id)], unscanned=[])
    assert activation.outdated(await stored_version(app, copy, 1))
    assert all("rebuilt" not in entry for entry in await entries_of(client, copy, "policy"))
    messages = [record.getMessage() for record in caplog.records]
    assert not any(message.startswith("version_rebuilt ") for message in messages)
    assert any(record.levelno == logging.ERROR and record.getMessage().startswith("version_rebuild_failed ")
               for record in caplog.records)
    assert re.fullmatch(r"startup_rebuild_done rebuilt=0 not_rebuilt=0 left=1 copies_left=0 seconds=\d+\.\d",
                        messages[-1])


async def test_startup_summary_counts_refused_rebuilds(app, client, caplog):
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy, NO_MESSAGES)
    with caplog.at_level(logging.INFO, logger="desk.kernel_service.activation"):
        startup = await activation.rebuild_at_startup(app.state.kernel)
    assert startup == activation.StartupRebuild(results={(copy.desk_id, 1): "invalid_cards"}, left=[], unscanned=[])
    messages = [record.getMessage() for record in caplog.records]
    assert not any(message.startswith("version_rebuilt ") for message in messages)
    assert re.fullmatch(r"startup_rebuild_done rebuilt=0 not_rebuilt=1 left=0 copies_left=0 seconds=\d+\.\d",
                        messages[-1])
    assert (await entries_of(client, copy, "policy"))[-1] == {
        "version": 1, "rebuilt": False, "refused": "invalid_cards"}


async def test_a_seed_version_from_an_earlier_kernel_is_rebuilt_from_its_shipped_proof(app, client, frozen_clock,
                                                                                       reviewer):
    # bounded mode: the shipped reports are the only proofs there are, as when a seed activates
    upgraded, current = await rivera(app, client), await rivera(app, client)
    await seed_from_an_earlier_kernel(app, upgraded)
    untouched = stored_columns(await stored_version(app, current, 1))

    async with upgraded_kernel(frozen_clock, reviewer) as http:
        visitor = await open_visitor(http, upgraded)
        slots = await decided(http, visitor, "native.find_slots", call_id="slots")
        assert (slots.outcome, slots.policy_version, slots.card_ids) == ("allow", 1, ["preset-find-slots"])

    rebuilt = await stored_version(app, upgraded, 1)
    shipped = activation.ShippedReport.model_validate_json((activation.PROOFS_DIR / "rivera.json").read_bytes())
    assert activation.VersionHashes(*(getattr(rebuilt, field) for field in activation.VersionHashes._fields)) \
        == shipped.hashes
    assert (rebuilt.status, rebuilt.auto_money_cap_cents, rebuilt.proof) == ("active", KERNEL_CORE_CAP, shipped.proof)
    assert (await entries_of(client, upgraded, "policy"))[-1]["rebuilt"] is True
    # a version stored under this kernel's baseline is left as it was, and nothing is ledgered for it
    assert stored_columns(await stored_version(app, current, 1)) == untouched
    assert all("rebuilt" not in entry for entry in await entries_of(client, current, "policy"))


# The native tools this plan registered, which a Desk created before it has no rows for.
NEW_NATIVE_TOOLS = ("native.capture_lead", "native.release_document", "native.request_callback",
                    "native.start_verification", "native.web_search")


async def without_new_native_tools(app: FastAPI, copy: Rivera) -> None:
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        await ctx.db.execute(delete(Tool).where(Tool.desk_id == copy.desk_id, Tool.tool.in_(NEW_NATIVE_TOOLS)))


def tool_columns(rows: list[Tool]) -> dict[str, dict]:
    return {row.tool: {column.key: getattr(row, column.key) for column in Tool.__table__.columns} for row in rows}


async def test_a_desk_from_before_new_native_tools_gets_them_at_startup(app, client, frozen_clock, reviewer):
    # bounded mode: the seed's version from an earlier kernel is rebuilt from its shipped report only over
    # every native tool, so the tools come first; a Desk whose version is current gets them all the same
    current, upgraded = await rivera(app, client), await rivera(app, client)
    made_now = tool_columns(await rows_of(app, current.copy_id, select(Tool).where(Tool.desk_id == current.desk_id)))
    native_now = {tool for tool, columns in made_now.items() if columns["source"] == "native"}   # beside its MCP tools
    assert set(NEW_NATIVE_TOOLS) <= native_now == {p.tool for p in adapters.registered_profiles(source="native")}
    for copy in (current, upgraded):
        await without_new_native_tools(app, copy)
    await seed_from_an_earlier_kernel(app, upgraded)

    async with upgraded_kernel(frozen_clock, reviewer) as http:
        visitor = await open_visitor(http, upgraded)
        slots = await decided(http, visitor, "native.find_slots", call_id="slots")
        assert (slots.outcome, slots.policy_version) == ("allow", 1)

    shipped = activation.ShippedReport.model_validate_json((activation.PROOFS_DIR / "rivera.json").read_bytes())
    rebuilt = await stored_version(app, upgraded, 1)
    assert activation.VersionHashes(*(getattr(rebuilt, field) for field in activation.VersionHashes._fields)) \
        == shipped.hashes
    for copy in (current, upgraded):
        rows = await rows_of(app, copy.copy_id, select(Tool).where(Tool.desk_id == copy.desk_id))
        # as a Desk made now has them: enabled, with the registered profile and its hash
        assert {tool: {**columns, "desk_id": None, "copy_id": None} for tool, columns in tool_columns(rows).items()} \
            == {tool: {**columns, "desk_id": None, "copy_id": None} for tool, columns in made_now.items()}
        assert [entry for entry in await entries_of(client, copy, "desk_data") if entry["part"] == "tools"] == [
            {"part": "tools", "refs": sorted(NEW_NATIVE_TOOLS)}]

    # a second start finds nothing to add or rebuild, and writes nothing
    before = {copy.desk_id: (tool_columns(await rows_of(app, copy.copy_id, select(Tool).where(
        Tool.desk_id == copy.desk_id))), await entries_of(client, copy, "desk_data"),
        await entries_of(client, copy, "policy")) for copy in (current, upgraded)}
    async with upgraded_kernel(frozen_clock, reviewer):
        pass
    after = {copy.desk_id: (tool_columns(await rows_of(app, copy.copy_id, select(Tool).where(
        Tool.desk_id == copy.desk_id))), await entries_of(client, copy, "desk_data"),
        await entries_of(client, copy, "policy")) for copy in (current, upgraded)}
    assert after == before


async def compiled_without(app: FastAPI, copy: Rivera, *tools: str) -> None:
    """The copy's active version compiled again over the Desk's enabled tools but `tools`, at its
    own money cap, its proof kept: a version compiled before `tools` were registered, on a Desk
    whose rows for them a start then added with no rebuild. With no `tools`, compiled over the
    enabled tools as they are."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = await activation.active_version(ctx, copy.desk_id)
        profiles = [profile for profile in await desks.enabled_profiles(ctx, copy.desk_id) if profile.tool not in tools]
        owned, cap = [card for card in row.cards if not card.is_default], row.auto_money_cap_cents
        schema = compiler.desk_schema(profiles)
        compiled = compiler.compile_cards(owned, profiles, auto_money_cap_cents=cap)
        earlier = activation.version_row(
            copy_id=copy.copy_id, desk_id=copy.desk_id, version=row.version, parent_version=row.parent_version,
            compiled=compiled, a0=compiler.compile_cards(owned, profiles, auto_money_cap_cents=cap, review=False).A,
            schema=schema, hashes=activation.version_hashes(compiled, schema, profiles, cards=owned,
                                                            auto_money_cap_cents=cap),
            auto_money_cap_cents=cap, status=row.status, proof=row.proof, created_at=row.created_at)
        for column in ("cards", "cedar", "schema_json", *activation.VersionHashes._fields):
            setattr(row, column, getattr(earlier, column))


async def uncovered(app: FastAPI, copy: Rivera) -> list[str]:
    """The Desk's enabled tools its active version has no rule for: no owner card, default ask or
    `never` card of it names the tool in its Cedar, so the kernel refuses every call to it while the
    owner's rules read as covering it."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = await activation.active_version(ctx, copy.desk_id)
        cedar = "\n".join(row.cedar[name] for name in ("F", "A", "H"))
        return [profile.tool for profile in await desks.enabled_profiles(ctx, copy.desk_id)
                if f'Action::"{profile.tool}"' not in cedar]


async def test_every_enabled_tool_has_a_rule_after_startup(app, client, frozen_clock, reviewer):
    # bounded mode: a copy from before the payments plan, whose version was compiled before the payment link and
    # the mandate charge were registered and whose start then gave it their rows with no rebuild, is rebuilt from
    # its shipped report over every tool it has, so the rules the owner reads are the ones the kernel decides by
    earlier, current = await rivera(app, client), await rivera(app, client)
    await compiled_without(app, earlier, "native.charge_mandate", "native.payment_link")
    assert await uncovered(app, earlier) == ["native.charge_mandate", "native.payment_link"]
    untouched = stored_columns(await stored_version(app, current, 1))

    async with upgraded_kernel(frozen_clock, reviewer):
        pass

    for copy in (earlier, current):
        assert await uncovered(app, copy) == []
    shipped = activation.ShippedReport.model_validate_json((activation.PROOFS_DIR / "rivera.json").read_bytes())
    rebuilt = await stored_version(app, earlier, 1)
    assert activation.VersionHashes(*(getattr(rebuilt, field) for field in activation.VersionHashes._fields)) \
        == shipped.hashes
    assert (rebuilt.status, rebuilt.auto_money_cap_cents, rebuilt.proof) == ("active", KERNEL_CORE_CAP, shipped.proof)
    assert (await entries_of(client, earlier, "policy"))[-1]["rebuilt"] is True
    # a version compiled over the Desk's tools as they are is left as it was
    assert stored_columns(await stored_version(app, current, 1)) == untouched
    assert all("rebuilt" not in entry for entry in await entries_of(client, current, "policy"))


@pytest.mark.solver
async def test_a_payment_link_holds_on_a_desk_whose_version_predates_it(app, client, registry, desk_prove,
                                                                        frozen_clock, reviewer):
    # a Desk set up before the payments plan, on the starter rules at a $0 money cap with no card for money: its
    # version had no rule for the payment link, so a visitor's link was refused, as no rule covered it, rather than
    # held for the owner. Startup leaves the rebuild to a live proof in the background.
    desk = await setup_desk(app, client)
    link = payment_link(5_000)
    adapters.register(link, replace=True)
    async with kernel_ctx(app) as ctx:
        ctx.bind(desk.copy_id)
        await ctx.db.execute(delete(Tool).where(Tool.desk_id == desk.desk_id, Tool.tool == link.profile.tool))
        ctx.db.add(desks.tool_row(desk.copy_id, desk.desk_id, link.profile))
        row = (await ctx.db.scalars(select(Desk).where(Desk.desk_id == desk.desk_id))).one()
        row.answering = True
    await compiled_without(app, desk, "native.payment_link")
    visitor = await open_visitor(client, desk)
    refused = await decided(client, visitor, "native.payment_link", call_id="before")
    assert refused.outcome == "refuse" and UNCOVERED_PLAIN in refused.reason_plain

    async with upgraded_kernel(frozen_clock, reviewer) as http:
        visitor = await open_visitor(http, desk)
        held = await decided(http, visitor, "native.payment_link", call_id="after")
        assert (held.outcome, held.state, held.policy_version) == ("hold", "held", 1)
        approved = await answered(http, desk.owner, held.decision_id, "allow_once")
        assert approved.execution is not None and approved.execution.state == "succeeded"

    assert link.calls.count("execute") == 1
    assert await uncovered(app, desk) == []
    assert (await entries_of(client, desk, "policy"))[-1]["rebuilt"] is True


async def test_a_version_proved_under_other_invariants_refuses_until_startup_rebuilds_it(app, client, frozen_clock,
                                                                                         reviewer):
    # bounded mode: the version was proved under this kernel's baseline but against the invariants and prover an
    # earlier kernel had, so its proof doesn't cover what this kernel checks; it is rebuilt from its shipped report
    copy = await rivera(app, client)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        seed = await activation.active_version(ctx, copy.desk_id)
        seed.invariants_sha256 = KERNEL_CORE["version"]["invariants_sha256"]
    visitor = await open_visitor(client, copy)
    refused = await decided(client, visitor, "native.find_slots", call_id="before")
    assert (refused.outcome, refused.policy_version) == ("refuse", 1)
    assert REFUSED in refused.reason_plain

    async with upgraded_kernel(frozen_clock, reviewer) as http:
        slots = await decided(http, await open_visitor(http, copy), "native.find_slots", call_id="after")
        assert (slots.outcome, slots.policy_version) == ("allow", 1)

    shipped = activation.ShippedReport.model_validate_json((activation.PROOFS_DIR / "rivera.json").read_bytes())
    rebuilt = await stored_version(app, copy, 1)
    assert activation.VersionHashes(*(getattr(rebuilt, field) for field in activation.VersionHashes._fields)) \
        == shipped.hashes
    assert (await entries_of(client, copy, "policy"))[-1]["rebuilt"] is True


async def proved_by_another_kernel(app: FastAPI, copy: Rivera) -> None:
    """The copy's active version as a kernel with other invariants rewrote it in place, as a
    rolling deploy's new kernel does while this one still serves: same Cedar and schema, so a
    version this kernel already loaded is still in its engine."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        (await activation.active_version(ctx, copy.desk_id)).invariants_sha256 = \
            KERNEL_CORE["version"]["invariants_sha256"]


async def test_a_pending_allow_doesnt_run_under_a_loaded_version_another_kernel_proved(app, client):
    # this kernel loaded the version when it decided; once the version is proved under other invariants it counts
    # as outdated here, so the allow it gave doesn't run on the version still in its engine
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    allowed = await decided(client, visitor, "native.find_slots", call_id="slots")
    assert allowed.outcome == "allow"
    await proved_by_another_kernel(app, copy)
    response = await post_execute(client, visitor, allowed)
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    assert (await read(client, visitor.headers, allowed)).state == "refused_at_execution"
    assert f"{copy.desk_id}:1" not in app.state.loaded_versions


async def test_an_approved_hold_doesnt_run_under_a_loaded_version_another_kernel_proved(app, client):
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    held = await decided(client, visitor, "native.quote", quote_args(("drain", 1), discount_bp=1500), call_id="quote")
    assert held.outcome == "hold"
    await proved_by_another_kernel(app, copy)
    result = await answered(client, copy.owner, held.decision_id, "allow_once")
    assert (result.decision.state, result.execution) == ("refused_at_execution", None)
    assert f"{copy.desk_id}:1" not in app.state.loaded_versions


async def with_earlier_profile(app: FastAPI, copy: Rivera, tool: str, *, status: str = "enabled") -> None:
    """The Desk's `tool` row as an earlier kernel wrote it, with the profile it registered then, at
    `status`."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = (await ctx.db.scalars(select(Tool).where(Tool.desk_id == copy.desk_id, Tool.tool == tool))).one()
        earlier = row.profile.model_copy(update={"description_confirmed": "An earlier kernel's words for the tool."})
        row.profile, row.description_confirmed, row.status = earlier, earlier.description_confirmed, status
        row.profile_sha256 = row.definition_sha256 = adapters.profile_sha256(earlier)


async def test_native_tool_rows_an_earlier_kernel_wrote_are_brought_up_to_date(app, client, frozen_clock, reviewer):
    # bounded mode: an earlier kernel wrote a native tool's row with the profile it registered then. Startup points
    # the row at today's profile, keeping its status, as the owner's confirm of the tool would, and rebuilds the
    # version compiled over the old one from its shipped report; a tool the owner turned off stays off
    on, off = await rivera(app, client), await rivera(app, client)
    made_now = tool_columns(await rows_of(app, on.copy_id, select(Tool).where(Tool.desk_id == on.desk_id)))
    await with_earlier_profile(app, on, "native.book")
    await with_earlier_profile(app, off, "native.capture_lead", status="disabled")
    for copy in (on, off):
        await compiled_without(app, copy)
    off_version = stored_columns(await stored_version(app, off, 1))

    async with upgraded_kernel(frozen_clock, reviewer):
        pass

    def anywhere(columns: dict[str, dict]) -> dict[str, dict]:
        return {tool: {**row, "desk_id": None, "copy_id": None} for tool, row in columns.items()}

    for copy, status in ((on, {}), (off, {"native.capture_lead": "disabled"})):
        rows = tool_columns(await rows_of(app, copy.copy_id, select(Tool).where(Tool.desk_id == copy.desk_id)))
        assert anywhere(rows) == {tool: {**row, "status": status.get(tool, row["status"])}
                                  for tool, row in anywhere(made_now).items()}
    assert [entry for entry in await entries_of(client, on, "desk_data") if entry["part"] == "tools"] == [
        {"part": "tools", "refs": ["native.book"]}]
    assert [entry for entry in await entries_of(client, off, "desk_data") if entry["part"] == "tools"] == [
        {"part": "tools", "refs": ["native.capture_lead"]}]
    shipped = activation.ShippedReport.model_validate_json((activation.PROOFS_DIR / "rivera.json").read_bytes())
    rebuilt = await stored_version(app, on, 1)
    assert activation.VersionHashes(*(getattr(rebuilt, field) for field in activation.VersionHashes._fields)) \
        == shipped.hashes
    # the tools the owner's Desk enables are the ones its version was compiled over: nothing to rebuild
    assert stored_columns(await stored_version(app, off, 1)) == off_version


async def test_a_version_that_only_needs_the_desks_tools_keeps_deciding_when_it_cant_be_rebuilt(
        app, client, frozen_clock, reviewer):
    # bounded mode: the owner turned a tool off, so the version was compiled over one more tool than the Desk
    # enables, and no shipped report covers the Desk's tools now. The attempt is ledgered; the version is proved
    # for what it decides, so it keeps deciding, and the owner isn't told Claude won't act
    copy = await rivera(app, client)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = (await ctx.db.scalars(select(Tool).where(Tool.desk_id == copy.desk_id,
                                                       Tool.tool == "native.capture_lead"))).one()
        row.status = "disabled"
    stored = stored_columns(await stored_version(app, copy, 1))

    async with upgraded_kernel(frozen_clock, reviewer) as http:
        slots = await decided(http, await open_visitor(http, copy), "native.find_slots", call_id="slots")
        assert (slots.outcome, slots.policy_version) == ("allow", 1)

    assert stored_columns(await stored_version(app, copy, 1)) == stored
    assert (await entries_of(client, copy, "policy"))[-1] == {"version": 1, "rebuilt": False, "refused": "not_proved"}
    assert await rules_alerts(app, copy) == []


async def test_startup_starts_no_desk_past_its_budget(app, client, monkeypatch):
    # two seeds from an earlier kernel, each rebuilt from its shipped report; the first rebuild takes the whole budget
    first, second = sorted([await rivera(app, client), await rivera(app, client)],
                           key=lambda copy: (copy.copy_id, copy.desk_id))
    for copy in (first, second):
        await seed_from_an_earlier_kernel(app, copy)
    elapsed = [0.0]
    rebuild = activation.rebuild_version

    async def taking_the_budget(*args, **kwargs):
        try:
            return await rebuild(*args, **kwargs)
        finally:
            elapsed[0] += activation.STARTUP_REBUILD_S

    monkeypatch.setattr(activation, "monotonic", lambda: elapsed[0])
    monkeypatch.setattr(activation, "rebuild_version", taking_the_budget)
    startup = await activation.rebuild_at_startup(app.state.kernel)
    # the first copy's rebuild took the whole budget, so startup never looked at the second copy
    assert startup == activation.StartupRebuild(results={(first.desk_id, 1): None}, left=[],
                                                unscanned=[second.copy_id])
    # the Desk left refuses until the background rebuilds it, with nothing ledgered for it before
    visitor = await open_visitor(client, second)
    refused = await decided(client, visitor, "native.find_slots", call_id="slots")
    assert (refused.outcome, refused.policy_version) == ("refuse", 1) and REFUSED in refused.reason_plain
    assert all("rebuilt" not in entry for entry in await entries_of(client, second, "policy"))
    # and its owner is told, before the background reaches it, that their rules are being checked
    alerted_before = []

    async def noting_the_alerts(ctx, desk_id, *args, **kwargs):
        alerted_before.append(await rules_alerts(app, second))
        return await rebuild(ctx, desk_id, *args, **kwargs)

    monkeypatch.setattr(activation, "rebuild_version", noting_the_alerts)
    assert await activation.rebuild_in_background(app.state.kernel, startup) == {(second.desk_id, 1): None}
    assert alerted_before == [[WAITING_ALERT]]
    allowed = await decided(client, visitor, "native.find_slots", call_id="slots-rebuilt")
    assert (allowed.outcome, allowed.policy_version) == ("allow", 1)
    assert (await entries_of(client, second, "policy"))[-1]["rebuilt"] is True
    # the Desk startup rebuilt never refused, so its owner isn't told anything; nor, once rebuilt, is the second's
    assert await rules_alerts(app, first) == []
    assert await rules_alerts(app, second) == [WAITING_ALERT]


async def test_a_version_waiting_for_its_rebuild_alerts_the_owner_at_most_once_an_hour(app, client, frozen_clock,
                                                                                       monkeypatch):
    copy, current = await rivera(app, client), await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    await without_new_native_tools(app, current)                       # left for its tools, its version current
    monkeypatch.setattr(activation, "STARTUP_REBUILD_S", 0.0)          # startup leaves every Desk to the background

    async def not_reached(*args, **kwargs):                            # the background never gets to it either
        return None

    monkeypatch.setattr(activation, "_bring_up", not_reached)
    visitor = await open_visitor(client, copy)
    alerts = []
    for minutes in (0, 30, 31):                                        # starts at 0, 30 and 61 minutes
        frozen_clock.advance(minutes * 60)
        startup = await activation.rebuild_at_startup(app.state.kernel)
        assert (startup.results, startup.left, startup.unscanned) == ({}, [], None)   # with no budget, not even listed
        await activation.rebuild_in_background(app.state.kernel, startup)
        refused = await decided(client, visitor, "native.find_slots", call_id=f"slots-{minutes}")
        assert (refused.outcome, refused.policy_version) == ("refuse", 1) and REFUSED in refused.reason_plain
        alerts.append(await rules_alerts(app, copy))
    assert alerts == [[WAITING_ALERT]] * 2 + [[WAITING_ALERT] * 2]
    # a Desk the background brings up only for its tools refuses nothing meanwhile, so its owner isn't told
    assert await rules_alerts(app, current) == []


async def test_startup_discovery_counts_against_its_budget(app, client, monkeypatch):
    # finding the Desks to bring up is part of startup's budget: discovery that takes all of it (two minutes here)
    # starts no rebuild, and the background finds and brings up the rest
    first, second = sorted([await rivera(app, client), await rivera(app, client)],
                           key=lambda copy: (copy.copy_id, copy.desk_id))
    for copy in (first, second):
        await seed_from_an_earlier_kernel(app, copy)
    elapsed = [0.0]
    discover = activation.desks_to_bring_up

    async def slow(*args, **kwargs):
        elapsed[0] += 120.0
        return await discover(*args, **kwargs)

    started, told = [], []
    rebuild = activation.rebuild_version

    async def counted(ctx, desk_id, *args, **kwargs):
        started.append(desk_id)
        told.append([await rules_alerts(app, copy) for copy in (first, second)])
        return await rebuild(ctx, desk_id, *args, **kwargs)

    monkeypatch.setattr(activation, "monotonic", lambda: elapsed[0])
    monkeypatch.setattr(activation, "desks_to_bring_up", slow)
    monkeypatch.setattr(activation, "rebuild_version", counted)
    startup = await activation.rebuild_at_startup(app.state.kernel)
    # it found the first copy's Desk and had no time left to start it, and never looked at the second copy
    assert startup == activation.StartupRebuild(results={}, left=[(first.copy_id, first.desk_id)],
                                                unscanned=[second.copy_id])
    assert started == []
    for copy in (first, second):
        assert all("rebuilt" not in entry for entry in await entries_of(client, copy, "policy"))
    background = await activation.rebuild_in_background(app.state.kernel, startup)
    assert background == {(first.desk_id, 1): None, (second.desk_id, 1): None}
    assert started == [first.desk_id, second.desk_id]
    # every owner whose Desk waits in the queue is told before the first rebuild starts, not when it is reached
    assert told == [[[WAITING_ALERT], [WAITING_ALERT]]] * 2


async def test_a_copy_whose_lookup_outlasts_the_budget_is_left_to_the_background(app, client, monkeypatch):
    # one copy's lookup is cut off when the budget runs out, however long it would hang, and the copy is left
    # for the background to look at again, as a failed lookup is
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    discover, calls, hung = activation.desks_to_bring_up, [], asyncio.Event()

    async def listed(runtime):
        return [copy.copy_id]                # the listing at once, so no runner's speed spends the budget first

    async def hanging_once(*args, **kwargs):
        calls.append(args[1])
        if len(calls) == 1:
            await hung.wait()                                    # never set: the lookup hangs until it's cut off
        return await discover(*args, **kwargs)

    monkeypatch.setattr(activation, "STARTUP_REBUILD_S", 0.5)
    monkeypatch.setattr(activation, "copy_ids", listed)
    monkeypatch.setattr(activation, "desks_to_bring_up", hanging_once)
    startup = await asyncio.wait_for(activation.rebuild_at_startup(app.state.kernel), timeout=5)  # a deadlock guard
    assert calls == [copy.copy_id]                               # startup reached the lookup, which hung
    assert startup == activation.StartupRebuild(results={}, left=[], unscanned=[copy.copy_id])
    assert await activation.rebuild_in_background(app.state.kernel, startup) == {(copy.desk_id, 1): None}
    assert calls == [copy.copy_id, copy.copy_id]


async def test_a_copy_whose_lookup_fails_at_startup_is_looked_at_again_in_the_background(app, client, monkeypatch):
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    discover, calls = activation.desks_to_bring_up, []

    async def failing_once(*args, **kwargs):
        calls.append(args[1])
        if len(calls) == 1:
            raise RuntimeError("the lookup's connection dropped")
        return await discover(*args, **kwargs)

    monkeypatch.setattr(activation, "desks_to_bring_up", failing_once)
    startup = await activation.rebuild_at_startup(app.state.kernel)
    assert startup == activation.StartupRebuild(results={}, left=[], unscanned=[copy.copy_id])
    assert await activation.rebuild_in_background(app.state.kernel, startup) == {(copy.desk_id, 1): None}
    assert calls == [copy.copy_id, copy.copy_id]


async def test_a_copy_whose_background_lookup_fails_is_looked_at_again_after_a_wait(app, client, monkeypatch):
    # the background's lookups fail too: it waits and looks again, longer each time, while the other copies go on,
    # so the Desk is rebuilt without another start, and refuses until then
    copy, other = await rivera(app, client), await rivera(app, client)
    for each in (copy, other):
        await seed_from_an_earlier_kernel(app, each)
    discover, calls, waits = activation.desks_to_bring_up, [], []

    async def failing(*args, **kwargs):               # the copy's first six lookups fail, the other's first
        calls.append(args[1])
        if calls.count(args[1]) <= (6 if args[1] == copy.copy_id else 1):
            raise RuntimeError("the lookup's connection dropped")
        return await discover(*args, **kwargs)

    visitor, other_visitor = await open_visitor(client, copy), await open_visitor(client, other)

    async def waiting(seconds):
        waits.append(seconds)
        refused = await decided(client, visitor, "native.find_slots", call_id=f"slots-{len(waits)}")
        assert (refused.outcome, refused.policy_version) == ("refuse", 1) and REFUSED in refused.reason_plain
        allowed = await decided(client, other_visitor, "native.find_slots", call_id=f"other-{len(waits)}")
        assert (allowed.outcome, allowed.policy_version) == ("allow", 1)

    monkeypatch.setattr(activation, "desks_to_bring_up", failing)
    monkeypatch.setattr(activation, "wait_to_retry", waiting)
    startup = await activation.rebuild_at_startup(app.state.kernel)
    assert startup == activation.StartupRebuild(results={}, left=[], unscanned=sorted([copy.copy_id, other.copy_id]))
    assert await activation.rebuild_in_background(app.state.kernel, startup) == {(copy.desk_id, 1): None,
                                                                                 (other.desk_id, 1): None}
    assert waits == [5.0, 30.0, 60.0, 60.0, 60.0]
    assert calls.count(copy.copy_id) == 7 and calls.count(other.copy_id) == 2
    allowed = await decided(client, visitor, "native.find_slots", call_id="slots-rebuilt")
    assert (allowed.outcome, allowed.policy_version) == ("allow", 1)
    assert await rules_alerts(app, copy) == [WAITING_ALERT]


@pytest.mark.parametrize("how", ["blocks", "raises"])
async def test_a_copy_listing_that_fails_at_startup_leaves_all_of_it_to_the_background(
        app, client, monkeypatch, how, caplog):
    # listing the copies counts against startup's budget: one that blocks is cut off, one that raises is logged,
    # and either way the background lists them and rebuilds the Desk, which refuses until then
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    listing, calls, never = activation.copy_ids, [], asyncio.Event()

    async def failing_once(*args, **kwargs):
        calls.append(how)
        if len(calls) == 1:
            if how == "blocks":
                await never.wait()                               # never set: cut off by the budget
            raise RuntimeError("the listing's connection dropped")
        return await listing(*args, **kwargs)

    monkeypatch.setattr(activation, "STARTUP_REBUILD_S", 0.05)
    monkeypatch.setattr(activation, "copy_ids", failing_once)
    with caplog.at_level(logging.INFO, logger="desk.kernel_service.activation"):
        startup = await asyncio.wait_for(activation.rebuild_at_startup(app.state.kernel), timeout=5)
    assert (startup.results, startup.left, startup.unscanned, startup.pending) == ({}, [], None, True)
    assert re.fullmatch(r"startup_rebuild_done rebuilt=0 not_rebuilt=0 left=0 copies_left=unlisted seconds=\d+\.\d",
                        caplog.records[-1].getMessage())
    visitor = await open_visitor(client, copy)
    refused = await decided(client, visitor, "native.find_slots", call_id="slots-waiting")
    assert (refused.outcome, refused.policy_version) == ("refuse", 1) and REFUSED in refused.reason_plain
    assert await activation.rebuild_in_background(app.state.kernel, startup) == {(copy.desk_id, 1): None}
    allowed = await decided(client, visitor, "native.find_slots", call_id="slots-rebuilt")
    assert (allowed.outcome, allowed.policy_version) == ("allow", 1)
    assert len(calls) == 2


async def test_two_kernels_starting_at_once_alert_a_waiting_owner_once(app, client, monkeypatch):
    # two starts that both find the Desk waiting each check for a recent alert and write one if there's none:
    # they take the Desk's turn one after the other, so the second sees the first's alert
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    deliver, arrived, both = activation.demo_inbox.deliver, [], asyncio.Event()

    async def together(*args, **kwargs):                  # each waits briefly for the other before it writes
        arrived.append(1)
        if len(arrived) == 2:
            both.set()
        try:
            await asyncio.wait_for(both.wait(), timeout=0.5)
        except TimeoutError:
            pass
        return await deliver(*args, **kwargs)

    monkeypatch.setattr(activation.demo_inbox, "deliver", together)
    await asyncio.gather(*(activation._alert_waiting(app.state.kernel, copy.copy_id, copy.desk_id, lock_s=10.0) for _ in range(2)))
    assert await rules_alerts(app, copy) == [WAITING_ALERT]


async def test_a_blocked_lookup_holds_up_no_desk_the_background_already_knows(app, client, monkeypatch):
    # a copy whose lookup hangs is cut off and looked at again after a wait; the Desk startup already found is
    # rebuilt meanwhile, its owner told first
    known, blocked = await rivera(app, client), await rivera(app, client)
    for each in (known, blocked):
        await seed_from_an_earlier_kernel(app, each)
    discover, calls, waits, never = activation.desks_to_bring_up, [], [], asyncio.Event()

    async def hanging_once(*args, **kwargs):
        calls.append(args[1])
        if calls.count(blocked.copy_id) == 1 and args[1] == blocked.copy_id:
            await never.wait()                                   # never set: cut off by the lookup's bound
        return await discover(*args, **kwargs)

    async def waiting(seconds):
        waits.append(seconds)
        assert await rules_alerts(app, known) == [WAITING_ALERT]  # the known Desk's owner was told first
        monkeypatch.setattr(activation, "BACKGROUND_LOOKUP_S", 10.0)  # only the hanging lookup gets the short bound

    monkeypatch.setattr(activation, "BACKGROUND_LOOKUP_S", 0.05)
    monkeypatch.setattr(activation, "desks_to_bring_up", hanging_once)
    monkeypatch.setattr(activation, "wait_to_retry", waiting)
    startup = activation.StartupRebuild(results={}, left=[(known.copy_id, known.desk_id)], unscanned=[blocked.copy_id])
    rebuilt = await asyncio.wait_for(activation.rebuild_in_background(app.state.kernel, startup), timeout=10)
    assert rebuilt == {(known.desk_id, 1): None, (blocked.desk_id, 1): None}
    assert waits == [5.0] and calls == [blocked.copy_id, blocked.copy_id]


async def test_a_kernel_starts_and_rebuilds_while_the_copies_table_is_locked(app, client, frozen_clock, reviewer,
                                                                            monkeypatch):
    # with every copy listing blocked behind a lock, startup's rebuild and its reconciliation are both cut off at
    # their budgets, the kernel serves, and the background rebuilds the Desk once the lock goes
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    monkeypatch.setattr(activation, "STARTUP_REBUILD_S", 0.2)
    monkeypatch.setattr(activation, "BACKGROUND_LOOKUP_S", 0.2)
    monkeypatch.setattr(app_module, "STARTUP_RECONCILE_S", 0.2)
    released = asyncio.Event()

    async def waiting(seconds):
        await released.wait()
        monkeypatch.setattr(activation, "BACKGROUND_LOOKUP_S", 10.0)  # once the lock goes, a slow runner still finishes

    monkeypatch.setattr(activation, "wait_to_retry", waiting)
    async with await psycopg.AsyncConnection.connect(libpq_url(database_url("ADMIN"))) as admin:
        await admin.execute("LOCK TABLE kernel.copies IN ACCESS EXCLUSIVE MODE")
        async with asyncio.timeout(10):
            async with started_kernel(frozen_clock, reviewer) as (kernel, _):
                rebuilding = kernel.state.rebuilding
                assert rebuilding is not None and not rebuilding.done()
                await admin.rollback()                           # the lock goes
                released.set()
                assert await rebuilding == {(copy.desk_id, 1): None}


async def test_a_desk_whose_rebuild_fails_is_rebuilt_on_a_later_pass(app, client, monkeypatch):
    # a rebuild that fails (a dropped connection) is tried again after a wait, as a failed lookup is,
    # so the owner told it is being checked isn't left with a Desk that refuses until the next start
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    rebuild, calls, waits = activation.rebuild_version, [], []

    async def failing_once(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("the rebuild's connection dropped")
        return await rebuild(*args, **kwargs)

    async def waiting(seconds):
        waits.append(seconds)

    monkeypatch.setattr(activation, "rebuild_version", failing_once)
    monkeypatch.setattr(activation, "wait_to_retry", waiting)
    startup = activation.StartupRebuild(results={}, left=[(copy.copy_id, copy.desk_id)], unscanned=[])
    assert await activation.rebuild_in_background(app.state.kernel, startup) == {(copy.desk_id, 1): None}
    assert (len(calls), waits) == (2, [5.0])


async def test_a_desk_whose_rebuild_fails_at_startup_is_left_to_the_background(app, client, monkeypatch):
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    rebuild, calls = activation.rebuild_version, []

    async def failing_once(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("the rebuild's connection dropped")
        return await rebuild(*args, **kwargs)

    monkeypatch.setattr(activation, "rebuild_version", failing_once)
    startup = await activation.rebuild_at_startup(app.state.kernel)
    assert (startup.results, startup.left, startup.pending) == ({}, [(copy.copy_id, copy.desk_id)], True)
    assert await activation.rebuild_in_background(app.state.kernel, startup) == {(copy.desk_id, 1): None}


async def test_no_rebuild_runs_over_the_old_tools_when_adding_the_new_ones_fails(app, client, monkeypatch):
    # a Desk that couldn't be given the native tools isn't rebuilt over its old tool set; the next pass gives it
    # the tools and then rebuilds it
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    add, rebuild, steps = desks.update_native_tools, activation.rebuild_version, []

    async def adding_fails_once(*args, **kwargs):
        steps.append("tools")
        if steps.count("tools") == 1:
            raise RuntimeError("the tools write's connection dropped")
        return await add(*args, **kwargs)

    async def rebuilding(*args, **kwargs):
        steps.append("rebuild")
        return await rebuild(*args, **kwargs)

    async def waiting(seconds):
        steps.append("wait")

    monkeypatch.setattr(desks, "update_native_tools", adding_fails_once)
    monkeypatch.setattr(activation, "rebuild_version", rebuilding)
    monkeypatch.setattr(activation, "wait_to_retry", waiting)
    startup = activation.StartupRebuild(results={}, left=[(copy.copy_id, copy.desk_id)], unscanned=[])
    assert await activation.rebuild_in_background(app.state.kernel, startup) == {(copy.desk_id, 1): None}
    assert steps == ["tools", "wait", "tools", "rebuild"]


async def test_an_unexpected_startup_error_still_starts_the_background(app, client, frozen_clock, reviewer,
                                                                       monkeypatch):
    # whatever startup's rebuild raises, the kernel serves and the background lists the copies and rebuilds them
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)

    async def raising(runtime):
        raise RuntimeError("something startup didn't expect")

    monkeypatch.setattr(activation, "rebuild_at_startup", raising)
    async with started_kernel(frozen_clock, reviewer) as (kernel, _):
        assert kernel.state.rebuilding is not None
        assert await kernel.state.rebuilding == {(copy.desk_id, 1): None}


async def test_the_background_lists_the_copies_again_after_its_listing_fails(app, client, monkeypatch):
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    listing, calls, waits = activation.copy_ids, [], []

    async def failing_once(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("the listing's connection dropped")
        return await listing(*args, **kwargs)

    async def waiting(seconds):
        waits.append(seconds)

    monkeypatch.setattr(activation, "copy_ids", failing_once)
    monkeypatch.setattr(activation, "wait_to_retry", waiting)
    startup = activation.StartupRebuild(results={}, left=[], unscanned=None)
    assert await activation.rebuild_in_background(app.state.kernel, startup) == {(copy.desk_id, 1): None}
    assert (len(calls), waits) == (2, [5.0])


async def test_a_deleted_desk_gets_neither_the_native_tools_nor_the_waiting_alert(app, client, monkeypatch):
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    await without_new_native_tools(app, copy)
    response = await client.delete(f"/desks/{copy.desk_id}", headers=copy.owner)
    assert response.status_code == 204, response.text
    before = await entries_of(client, copy, "desk_data")
    startup = await activation.rebuild_at_startup(app.state.kernel)
    await activation.rebuild_in_background(app.state.kernel, startup)
    tools = {row.tool for row in await rows_of(app, copy.copy_id, select(Tool).where(Tool.desk_id == copy.desk_id))}
    assert not set(NEW_NATIVE_TOOLS) & tools
    assert await entries_of(client, copy, "desk_data") == before
    assert await rules_alerts(app, copy) == []


async def test_a_failed_waiting_alert_neither_blocks_nor_skips_the_rebuild(app, client, monkeypatch):
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)

    async def failing(*args, **kwargs):
        raise RuntimeError("the inbox write's connection dropped")

    monkeypatch.setattr(activation.demo_inbox, "deliver", failing)
    startup = activation.StartupRebuild(results={}, left=[(copy.copy_id, copy.desk_id)], unscanned=[])
    assert await activation.rebuild_in_background(app.state.kernel, startup) == {(copy.desk_id, 1): None}


async def test_a_desk_deleted_while_its_waiting_alert_is_written_waits_for_it(app, client, monkeypatch):
    # the alert holds the Desk's row from its deletion check to its commit, so a deletion either comes first (and
    # the alert writes nothing) or waits for the alert, never lands in between
    from .helpers import connections_of, until_waiting
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    deliver, paused, go_on = activation.demo_inbox.deliver, asyncio.Event(), asyncio.Event()

    async def held(*args, **kwargs):
        paused.set()
        await go_on.wait()
        return await deliver(*args, **kwargs)

    monkeypatch.setattr(activation.demo_inbox, "deliver", held)
    alerting = asyncio.create_task(activation._alert_waiting(app.state.kernel, copy.copy_id, copy.desk_id, lock_s=10.0))
    await asyncio.wait_for(paused.wait(), timeout=5)
    with connections_of(app) as pids:
        deleting = asyncio.create_task(client.delete(f"/desks/{copy.desk_id}", headers=copy.owner))
        await until_waiting(app, deleting, pids, "kernel.desks")
    assert not deleting.done()                                   # the deletion waits for the alert's commit
    go_on.set()
    await asyncio.wait_for(alerting, timeout=5)
    assert (await asyncio.wait_for(deleting, timeout=5)).status_code == 204
    assert await rules_alerts(app, copy) == [WAITING_ALERT]       # written while the Desk still stood


async def test_a_desk_row_held_by_an_owner_write_holds_up_no_other_desk(app, client, monkeypatch):
    # an owner's write holding one Desk's row (FOR UPDATE) doesn't stop the background: that Desk's alert and
    # rebuild wait for the next pass, and the other Desk is told and rebuilt meanwhile
    from .helpers import kernel_ctx
    held_copy, other = await rivera(app, client), await rivera(app, client)
    for each in (held_copy, other):
        await seed_from_an_earlier_kernel(app, each)
    holding, release = asyncio.Event(), asyncio.Event()

    async def owner_write():
        async with kernel_ctx(app) as ctx:
            ctx.bind(held_copy.copy_id)
            await ctx.db.execute(select(Desk.desk_id).where(Desk.desk_id == held_copy.desk_id).with_for_update())
            holding.set()
            await release.wait()

    waits = []

    async def waiting(seconds):
        waits.append(seconds)
        assert await rules_alerts(app, other) == [WAITING_ALERT]      # the other Desk went on meanwhile
        assert await rules_alerts(app, held_copy) == []
        release.set()
        await writer                     # the write has let go of the row before the next pass, however slow

    writer = asyncio.create_task(owner_write())
    await asyncio.wait_for(holding.wait(), timeout=5)
    monkeypatch.setattr(activation, "BACKGROUND_LOOKUP_S", 0.2)
    monkeypatch.setattr(activation, "wait_to_retry", waiting)
    startup = activation.StartupRebuild(results={}, unscanned=[],
                                        left=sorted([(held_copy.copy_id, held_copy.desk_id), (other.copy_id, other.desk_id)]))
    rebuilt = await asyncio.wait_for(activation.rebuild_in_background(app.state.kernel, startup), timeout=10)
    await writer
    assert rebuilt == {(held_copy.desk_id, 1): None, (other.desk_id, 1): None}
    assert waits == [5.0] and await rules_alerts(app, held_copy) == [WAITING_ALERT]


async def test_a_kernel_starts_within_its_budget_while_a_desk_row_is_held(app, client, frozen_clock, reviewer,
                                                                           monkeypatch):
    # an owner's write holding a Desk's row at startup doesn't hold the kernel past its budget: startup tries the
    # Desk and leaves it to the background, which brings it up once the row is free
    from .helpers import kernel_ctx
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    await without_new_native_tools(app, copy)
    holding, release, served = asyncio.Event(), asyncio.Event(), asyncio.Event()
    bring_up, rebuild_at_startup, tried, startups = activation._bring_up, activation.rebuild_at_startup, [], []

    async def owner_write():
        async with kernel_ctx(app) as ctx:
            ctx.bind(copy.copy_id)
            await ctx.db.execute(select(Desk.desk_id).where(Desk.desk_id == copy.desk_id).with_for_update())
            holding.set()
            await release.wait()

    async def listed(runtime):
        return [copy.copy_id]                # discovery at once, so no runner's speed spends the budget first

    async def found(runtime, copy_id, *args):
        return [copy.desk_id]

    async def trying(runtime, copy_id, desk_id, *, prove, lock_s):
        if not prove:
            tried.append(desk_id)                                # startup's bring-up, which waits on the held row
        return await bring_up(runtime, copy_id, desk_id, prove=prove, lock_s=lock_s)

    async def recorded(runtime):
        startups.append(await rebuild_at_startup(runtime))
        return startups[-1]

    async def waiting(seconds):
        await served.wait()                                      # the row stays held until the kernel serves
        release.set()
        monkeypatch.setattr(activation, "BACKGROUND_LOOKUP_S", 10.0)  # once the row goes, a slow runner still finishes

    writer = asyncio.create_task(owner_write())
    await asyncio.wait_for(holding.wait(), timeout=5)
    monkeypatch.setattr(activation, "STARTUP_REBUILD_S", 1.0)
    monkeypatch.setattr(activation, "BACKGROUND_LOOKUP_S", 0.3)
    monkeypatch.setattr(activation, "copy_ids", listed)
    monkeypatch.setattr(activation, "desks_to_bring_up", found)
    monkeypatch.setattr(activation, "_bring_up", trying)
    monkeypatch.setattr(activation, "rebuild_at_startup", recorded)
    monkeypatch.setattr(activation, "wait_to_retry", waiting)
    async with asyncio.timeout(5):                               # a deadlock guard
        async with started_kernel(frozen_clock, reviewer) as (kernel, _):
            rebuilding = kernel.state.rebuilding
            assert tried == [copy.desk_id]                       # startup reached the held row ...
            assert [startup.left for startup in startups] == [[(copy.copy_id, copy.desk_id)]]   # ... and left the Desk
            assert rebuilding is not None and not rebuilding.done()
            served.set()
            assert await rebuilding == {(copy.desk_id, 1): None}
    await writer


async def test_a_desk_deleted_after_it_was_found_is_neither_rebuilt_nor_given_tools(app, client):
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    await without_new_native_tools(app, copy)
    response = await client.delete(f"/desks/{copy.desk_id}", headers=copy.owner)
    assert response.status_code == 204, response.text
    before = await entries_of(client, copy, "policy")
    assert await activation._bring_up(app.state.kernel, copy.copy_id, copy.desk_id, prove=True, lock_s=10.0) is None
    tools = {row.tool for row in await rows_of(app, copy.copy_id, select(Tool).where(Tool.desk_id == copy.desk_id))}
    assert not set(NEW_NATIVE_TOOLS) & tools
    assert await entries_of(client, copy, "policy") == before
    assert [alert.body for alert in await owner_alerts(app, copy)][-1:] != [activation.REBUILD_ALERT]


async def test_a_waiting_alert_for_a_desk_deleted_after_it_was_found_writes_nothing(app, client):
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    response = await client.delete(f"/desks/{copy.desk_id}", headers=copy.owner)
    assert response.status_code == 204, response.text
    assert await activation._alert_waiting(app.state.kernel, copy.copy_id, copy.desk_id, lock_s=10.0) is True
    assert await rules_alerts(app, copy) == []


async def test_startup_returns_within_its_budget_through_successive_lock_waits(app, client, monkeypatch):
    # the Desk row held for most of the budget, then the versions lock held past it: each wait alone fits the
    # budget, but together they would overrun it; startup still returns within it and leaves the Desk to the
    # background
    from time import monotonic
    from .helpers import kernel_ctx
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    row_held, versions_held, done = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def holding_the_row():
        async with kernel_ctx(app) as ctx:
            ctx.bind(copy.copy_id)
            await ctx.db.execute(select(Desk.desk_id).where(Desk.desk_id == copy.desk_id).with_for_update())
            row_held.set()
            await asyncio.sleep(0.8)

    async def holding_the_versions_lock():
        async with kernel_ctx(app) as ctx:
            ctx.bind(copy.copy_id)
            await activation._lock(ctx, "versions", copy.desk_id)
            versions_held.set()
            await done.wait()

    holders = [asyncio.create_task(holding_the_row()), asyncio.create_task(holding_the_versions_lock())]
    await asyncio.wait_for(asyncio.gather(row_held.wait(), versions_held.wait()), timeout=5)
    monkeypatch.setattr(activation, "STARTUP_REBUILD_S", 1.0)
    started = monotonic()
    startup = await asyncio.wait_for(activation.rebuild_at_startup(app.state.kernel), timeout=10)
    elapsed = monotonic() - started
    done.set()
    await asyncio.gather(*holders)
    assert elapsed < 1.5, f"startup took {elapsed:.2f} s against a 1 s budget"
    assert (startup.results, startup.left) == ({}, [(copy.copy_id, copy.desk_id)])


async def test_startup_leaves_a_live_proof_to_the_background(app, client, registry, monkeypatch):
    # in symcc mode no shipped report covers the kernel core's tools, so only a live proof answers its version
    copy = await rivera(app, client)
    adapters.register(payment_link(5_000), replace=True)
    await with_kernel_core_version(app, copy)
    monkeypatch.setattr(activation, "_proof_mode", "symcc")
    proved = []

    async def prover_away(inputs):        # no desk-prove here: a live proof times out, as with none installed
        proved.append(inputs)
        return activation._timed_out()

    monkeypatch.setattr(activation, "prove", prover_away)
    startup = await activation.rebuild_at_startup(app.state.kernel)
    assert (startup.results, startup.left, proved) == ({}, [(copy.copy_id, copy.desk_id)], [])
    assert all("rebuilt" not in entry for entry in await entries_of(client, copy, "policy"))
    visitor = await open_visitor(client, copy)
    refused = await decided(client, visitor, "native.find_slots", call_id="slots")
    assert (refused.outcome, refused.policy_version) == ("refuse", 2) and REFUSED in refused.reason_plain
    # the background proves it, and refuses and alerts as startup did before it had a budget
    assert await activation.rebuild_in_background(app.state.kernel, startup) == {(copy.desk_id, 2): "not_proved"}
    assert len(proved) == 1
    assert (await entries_of(client, copy, "policy"))[-1] == {"version": 2, "rebuilt": False, "refused": "not_proved"}
    assert [alert.body for alert in await owner_alerts(app, copy)][-1:] == [activation.REBUILD_ALERT]


async def test_the_kernel_serves_while_its_background_rebuild_runs(app, client, frozen_clock, reviewer, monkeypatch):
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    monkeypatch.setattr(activation, "STARTUP_REBUILD_S", 0.0)          # startup leaves every Desk to the background
    go_on = asyncio.Event()
    rebuild = activation.rebuild_version

    async def waiting(*args, **kwargs):
        await go_on.wait()
        return await rebuild(*args, **kwargs)

    monkeypatch.setattr(activation, "rebuild_version", waiting)
    # a kernel stopped before its background rebuild ends cancels it: nothing was written, and the next start
    # takes the Desk up again
    async with started_kernel(frozen_clock, reviewer) as (kernel, _):
        stopped = kernel.state.rebuilding
        assert stopped is not None and not stopped.done()
    assert stopped.cancelled()
    assert all("rebuilt" not in entry for entry in await entries_of(client, copy, "policy"))
    async with started_kernel(frozen_clock, reviewer) as (kernel, http):
        visitor = await open_visitor(http, copy)
        refused = await decided(http, visitor, "native.find_slots", call_id="slots")
        assert (refused.outcome, refused.policy_version) == ("refuse", 1) and REFUSED in refused.reason_plain
        assert not kernel.state.rebuilding.done()
        go_on.set()
        assert await kernel.state.rebuilding == {(copy.desk_id, 1): None}
        allowed = await decided(http, visitor, "native.find_slots", call_id="slots-rebuilt")
        assert (allowed.outcome, allowed.policy_version) == ("allow", 1)
    assert (await entries_of(client, copy, "policy"))[-1]["rebuilt"] is True


async def test_cards_this_kernel_refuses_are_never_rebuilt(app, client, frozen_clock, reviewer):
    # the kernel core took a card that could stop a verification start; this kernel refuses it,
    # so the version is checked as a draft of its cards would be and stays refused
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy, NO_MESSAGES)
    async with upgraded_kernel(frozen_clock, reviewer) as http:
        visitor = await open_visitor(http, copy)
        refused = await decided(http, visitor, "native.find_slots", call_id="slots")
        assert (refused.outcome, refused.policy_version) == ("refuse", 1)
        assert REFUSED in refused.reason_plain
    assert (await stored_version(app, copy, 1)).baseline_sha256 == KERNEL_CORE["version"]["baseline_sha256"]
    refused_entry = {"version": 1, "rebuilt": False, "refused": "invalid_cards"}
    assert (await entries_of(client, copy, "policy"))[-1] == refused_entry
    assert [alert.body for alert in await owner_alerts(app, copy)][-1:] == [activation.REBUILD_ALERT]


async def test_an_allow_from_before_the_upgrade_doesnt_run_under_a_version_left_as_stored(app, client, frozen_clock,
                                                                                          reviewer):
    # the baseline is rechecked at execution, so a version that wasn't rebuilt runs nothing there either
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    allowed = await decided(client, visitor, "native.find_slots", call_id="slots")
    assert allowed.outcome == "allow"
    await seed_from_an_earlier_kernel(app, copy, NO_MESSAGES)
    async with upgraded_kernel(frozen_clock, reviewer) as http:
        response = await post_execute(http, visitor, allowed)
        assert (response.status_code, response.json()) == (409, {"code": "conflict"})
        assert (await read(http, visitor.headers, allowed)).state == "refused_at_execution"


def _uncompilable(*args, **kwargs):
    raise ValueError("a card the compiler can't express")


@pytest.mark.parametrize(("seam", "replacement", "refused"), [
    ((compiler, "compile_cards"), _uncompilable, "uncompilable_cards"),
    ((activation, "load_draft"), lambda *args, **kwargs: ["the sets don't validate"], "unloadable"),
])
async def test_sets_that_dont_compile_or_load_are_never_rebuilt(app, client, frozen_clock, reviewer, monkeypatch, seam,
                                                                 replacement, refused):
    # the seed's cards would hit the shipped report, so only the compile or the load stops them
    copy = await rivera(app, client)
    await seed_from_an_earlier_kernel(app, copy)
    monkeypatch.setattr(*seam, replacement)
    async with upgraded_kernel(frozen_clock, reviewer):
        pass
    assert (await stored_version(app, copy, 1)).baseline_sha256 == KERNEL_CORE["version"]["baseline_sha256"]
    assert (await entries_of(client, copy, "policy"))[-1] == {"version": 1, "rebuilt": False, "refused": refused}
