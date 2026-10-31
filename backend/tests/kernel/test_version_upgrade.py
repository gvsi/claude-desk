"""Rules versions an earlier kernel stored keep working after an upgrade.

A version is proved against the always-on baseline the kernel enforces with it. The kernel core
stored its versions under its own baseline, with a schema that has no `auto_money_cap_cents` in
the context, which this kernel's baseline reads, so such a version doesn't even load. At startup
the kernel rebuilds each active version stored under another baseline from its own cards, at the
money cap the money cap revision kept for it, and puts the rebuild in its place only with a proof
of all seven obligations; a version it can't rebuild and prove refuses every call, and the owner
is alerted. Startup does this from cached reports within a budget before the kernel serves, and
leaves the rest, live proofs included, to a background rebuild while the kernel serves; a version
not yet rebuilt refuses meanwhile.

`fixtures/kernel_core_version.json` is a version exactly as the kernel core stored it, with the
tools it was compiled over: Rivera's cards plus an auto payment link card up to $100, over the
kernel core's native tools and a payment link tool, compiled by the kernel core's compiler and
proved by `desk-prove` on the kernel core's inputs. It is frozen: made again with a later compiler
it would test nothing.
"""

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, select

from desk.contracts import ProofReport, RuleCard, ToolProfile
from desk.db.models import DemoInboxEntry as InboxRow
from desk.db.models import PolicyVersion, Tool
from desk.kernel_service import activation, adapters, compiler, desks
from desk.kernel_service.app import create_app

from .fakes import FakeDecisions, FrozenClock
from .helpers import kernel_ctx, rows_of
from .test_adapters import Rivera, rivera
from .test_decide import decided, open_visitor, payment_link
from .test_execute import post_execute, read
from .test_money_cap import entries_of

KERNEL_CORE = json.loads((Path(__file__).parent / "fixtures" / "kernel_core_version.json").read_text())
KERNEL_CORE_CAP = 50_000          # the cap the money cap revision gives a version stored before it
REFUSED = "Your rules haven't been checked since an update, so it was refused."
ALERT_PREVIEW = "Your rules need checking"
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
    # the Desk was given the native tools registered since, and the one no card for anyone covers asks by default
    assert [card.card_id for card in rebuilt.cards if card.is_default] == ["default:native.release_document"]
    policy = await entries_of(client, copy, "policy")
    assert policy[-1] == {"version": 2, "status": "active", "rebuilt": True, "auto_money_cap_cents": KERNEL_CORE_CAP,
                          "cedar_sha256": rebuilt.cedar_sha256,
                          "from_cedar_sha256": KERNEL_CORE["version"]["cedar_sha256"]}


async def owner_alerts(app: FastAPI, copy: Rivera) -> list[InboxRow]:
    return await rows_of(app, copy.copy_id, select(InboxRow).where(
        InboxRow.desk_id == copy.desk_id, InboxRow.to == "owner", InboxRow.kind == "alert",
    ).order_by(InboxRow.created_at))


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
                    "native.start_verification")


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
    assert set(NEW_NATIVE_TOOLS) <= set(made_now) == {p.tool for p in adapters.registered_profiles(source="native")}
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
    assert startup == activation.StartupRebuild(results={(first.desk_id, 1): None},
                                                left=[(second.copy_id, second.desk_id)])
    # the Desk left refuses until the background rebuilds it, with nothing ledgered or alerted for it before
    visitor = await open_visitor(client, second)
    refused = await decided(client, visitor, "native.find_slots", call_id="slots")
    assert (refused.outcome, refused.policy_version) == ("refuse", 1) and REFUSED in refused.reason_plain
    assert all("rebuilt" not in entry for entry in await entries_of(client, second, "policy"))
    assert activation.REBUILD_ALERT not in [alert.body for alert in await owner_alerts(app, second)]
    assert await activation.rebuild_in_background(app.state.kernel, startup.left) == {(second.desk_id, 1): None}
    allowed = await decided(client, visitor, "native.find_slots", call_id="slots-rebuilt")
    assert (allowed.outcome, allowed.policy_version) == ("allow", 1)
    assert (await entries_of(client, second, "policy"))[-1]["rebuilt"] is True


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
    assert await activation.rebuild_in_background(app.state.kernel, startup.left) == {(copy.desk_id, 2): "not_proved"}
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
