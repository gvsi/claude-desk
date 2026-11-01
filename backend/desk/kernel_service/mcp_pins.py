"""Tool pins: connecting the mock payments server's tools, checking their pins, and the owner's
reviews and switches ("Payments (mocked)", "Activation gate").

A connected MCP tool is pinned by the hash of its listed definition (`mcp_client.pin_sha256`): its
`tools` row holds the adapter's profile with that `definition_sha256`, and Claude is given the
adapter's description and input schema, never the server's. Only the tools in `MCP_OPERATIONS` are
ever profiled; anything else the server lists reaches no one.

- `connect` (`POST /tools/connect`) pins each listed tool at its listing hash, `needs_review`
  (`review_reason` "new") until a proved draft enables it; a tool already on the Desk is left as it
  is. `POST /copies` connects the seed's servers with their tools `enabled`, at the hashes the seed
  was proved with (`mcp_client.seed_pins()`), or not at all (503 `seed_unproved`).
- `check_pin` lists the tools again and compares one tool's hash with its pin. A changed definition
  puts an enabled tool back to `needs_review` ("changed", the new entry as quoted untrusted
  `pending_definition_text` and its `pending_sha256`); a delisted one too ("delisted", no pending
  fields). Either alerts the owner in the Demo inbox at once, whatever their notification
  preferences, and is ledgered `tool_pin` `drift`, all in the caller's transaction. A server that
  can't list within `MCP_DEADLINE_S` changes nothing: the caller refuses.
- `simulate_change` (`POST /tools/simulate_change`) is the demo's "Simulate a tool change": the
  server changes the copy's definition (ledgered `simulated`), then `check_pin` runs at once.
- `confirm_tools` (`POST /tools/confirm`) takes a batch of tools, each named by the hash the owner
  reviewed (an MCP tool's listing hash or pending hash, a native tool's adapter `profile_sha256`).
  Enabling drafts one rules version that turns them all on (`activation.draft` with `enables`),
  proved like any draft and activated by `/policy/confirm`, which checks each pin again
  (`check_enables`) and turns the tools on in its own transaction (`enable_tools`). Disabling takes
  effect at once for all of them, unproved since it only narrows. Any entry that fails its check
  fails the whole batch with nothing changed, ledgered; Verification can't be turned off.

Every row change is ledgered `tool_pin` with the tool's name; a refusal is ledgered after the
request's transaction rolls back. Ledger summaries carry tool names, hashes and states, never server
text.
"""

import json
import logging
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from functools import partial
from typing import Any, Literal

import desk_kernel
from sqlalchemy import select

from desk import always_on
from desk.contracts import InboxNotice, LedgerEvent, ToolProfile
from desk.db.models import Tool
from desk.kernel_api import ToolConfirmed, ToolPin
from desk.kernel_service import adapters, demo_inbox, ledger, mcp_client, render
from desk.kernel_service.auth import OwnerCtx
from desk.kernel_service.mcp_client import McpUnavailable, pin_sha256
from desk.kernel_service.repo import KernelCtx, KernelFailure

log = logging.getLogger(__name__)

# The pinned MCP tools and the server operation each calls; nothing else listed is ever profiled.
MCP_OPERATIONS: dict[str, str] = {"payments.list_charges": "list_charges", "payments.create_refund": "create_refund"}
SERVERS: dict[str, tuple[str, ...]] = {"mock_payments": tuple(sorted(MCP_OPERATIONS))}
# What the owner calls each tool in an alert.
TOOL_LABELS: dict[str, str] = {"payments.list_charges": "Payment history", "payments.create_refund": "Refunds"}
CHANGED_ALERT = "{label} changed. Review it before Claude uses it again."
DELISTED_ALERT = "{label} is no longer offered. Claude won't use it."
# Built-in tools the owner can't turn off (owner decision, 2026-10-29) are the always-on tools,
# named once in `desk.always_on.ALWAYS_ON_TOOLS`: Verification is always on.


# ---- Profiles and rows ------------------------------------------------------------------------------

def is_mcp(tool: str) -> bool:
    return tool in MCP_OPERATIONS


def native_pin(tool: str) -> str:
    """The hash the owner names a native tool by: its registered adapter profile's `profile_sha256`."""
    return adapters.profile_sha256(adapters.ADAPTERS[tool].profile)


class BusinessProfileChanged(ValueError):
    """A configured definition no longer matches the pin a draft was proved against."""


def pinned_profile(tool: str, definition_sha256: str | None, stored: ToolProfile | None = None) -> ToolProfile:
    """The adapter's profile for `tool`, enabled, an MCP tool's pinned at `definition_sha256` (a
    native tool's profile carries no hash): what a version enabling it is proved over."""
    from desk.contracts import is_business_tool
    if is_business_tool(tool):
        if stored is None or stored.source != "business" or stored.tool != tool or stored.definition_sha256 != definition_sha256:
            raise BusinessProfileChanged("business_profile_changed")
        profile = stored
    else:
        profile = adapters.ADAPTERS[tool].profile
    return profile.model_copy(update={
        "status": "enabled", "definition_sha256": definition_sha256 if profile.source in ("mcp", "business") else None,
        "pending_definition_text": None, "pending_sha256": None, "review_reason": None})


def pin_row(row: Tool, tool: str, definition_sha256: str, *, status: str, review_reason: str | None) -> Tool:
    """Points `row` at the adapter's profile pinned at `definition_sha256` (a native tool's
    `profile_sha256`), at `status`, with no pending definition."""
    profile = pinned_profile(tool, definition_sha256, row.profile)
    row.source, row.effects, row.reversible = profile.source, profile.effects, profile.reversible
    row.description_confirmed, row.profile = profile.description_confirmed, profile
    row.profile_sha256 = adapters.profile_sha256(profile)
    row.definition_sha256 = definition_sha256 if profile.source in ("mcp", "business") else row.profile_sha256
    row.status, row.review_reason = status, review_reason
    row.pending_definition_text = row.pending_sha256 = None
    return row


def owner_profile(row: Tool) -> ToolProfile:
    """A tools row as the owner reviews it: the adapter's profile at the row's status, pin, pending
    definition (quoted untrusted text) and review reason."""
    return row.profile.model_copy(update={
        "status": row.status, "definition_sha256": row.definition_sha256,
        "pending_definition_text": row.pending_definition_text, "pending_sha256": row.pending_sha256,
        "review_reason": row.review_reason})


def pending_text(entry: Mapping[str, Any]) -> str:
    """A listed entry as the owner reads it: its canonical JSON, the exact text that was hashed."""
    return desk_kernel.canonical_json_any(json.dumps(entry))


async def _rows(ctx: KernelCtx, desk_id: str, tools: Iterable[str], *, lock: bool) -> dict[str, Tool]:
    stmt = (select(Tool).where(Tool.desk_id == desk_id, Tool.tool.in_(sorted(set(tools))))
            .order_by(Tool.tool).execution_options(populate_existing=True))
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return {row.tool: row for row in await ctx.db.scalars(ctx.repo.scoped(stmt))}


async def _ledger(ctx: KernelCtx, desk_id: str, summary: dict[str, Any]) -> None:
    await ledger.append(ctx, copy_id=ctx.copy_id, desk_id=desk_id,
                        event=LedgerEvent(kind="tool_pin", origin="kernel", summary=summary))


async def _listed(ctx: KernelCtx) -> dict[str, dict[str, Any]]:
    """The copy's listing; an unreachable or slow server is 503 `internal`, logged `mockpay_unavailable`."""
    try:
        return await mcp_client.client(ctx.settings).list_tools_raw(ctx.copy_id)
    except McpUnavailable:
        log.warning("mockpay_unavailable copy_id=%s", ctx.copy_id)
        raise KernelFailure(503, "internal", "mockpay_unavailable") from None


# ---- Connect ----------------------------------------------------------------------------------------

async def connect(ctx: KernelCtx, desk_id: str, server: str, *,
                  seed_pins: Mapping[str, str] | None = None) -> list[Tool]:
    """Pins each of `server`'s tools the server lists, in the caller's transaction, ledgered
    `tool_pin` `{tool, event: "connected", status, definition_sha256}`; a tool already on the Desk
    stays as it is. Without `seed_pins` a new tool waits for review (`needs_review`, "new"). With
    them (`POST /copies`) every tool must be listed at exactly its seed pin, or nothing is written
    (503 `seed_unproved`), and each is `enabled`. Returns the server's rows on the Desk."""
    listed = await _listed(ctx)
    tools = SERVERS[server]
    hashes = {tool: pin_sha256(listed[MCP_OPERATIONS[tool]]) for tool in tools if MCP_OPERATIONS[tool] in listed}
    if seed_pins is not None and any(hashes.get(tool) != seed_pins.get(MCP_OPERATIONS[tool]) for tool in tools):
        log.error("seed_unproved server=%s reason=pin_changed", server)
        raise KernelFailure(503, "seed_unproved", "seed_pin_changed")
    rows = await _rows(ctx, desk_id, tools, lock=True)
    status, reason = ("enabled", None) if seed_pins is not None else ("needs_review", "new")
    for tool in tools:
        if tool in rows or tool not in hashes:
            continue
        row = pin_row(Tool(desk_id=desk_id, tool=tool, copy_id=ctx.copy_id), tool, hashes[tool], status=status,
                      review_reason=reason)
        ctx.db.add(row)
        rows[tool] = row
        await ctx.db.flush()
        await _ledger(ctx, desk_id, {"tool": tool, "event": "connected", "status": status,
                                     "definition_sha256": hashes[tool]})
    return [rows[tool] for tool in tools if tool in rows]


# ---- Checking a pin ---------------------------------------------------------------------------------

@dataclass(frozen=True)
class PinCheck:
    """What a re-list found for one tool: `ok` (listed at the hash the row is checked against: its
    pending hash while a change waits for review, else its pin; `entry` and `sha256` as listed),
    `drifted` (listed at another hash), `removed` (not listed) or `unavailable` (no listing). So
    `ok` alone doesn't say a tool may run: the execution re-check also needs the row `enabled` and
    `sha256` equal to its `definition_sha256`. `notice` is the owner's alert a drift wrote, for the
    refused decision's `inbox`."""

    state: Literal["ok", "drifted", "removed", "unavailable"]
    entry: dict[str, Any] | None = None
    sha256: str | None = None
    notice: InboxNotice | None = None


async def _alert(ctx: KernelCtx, desk_id: str, body: str) -> InboxNotice:
    """The owner's Demo inbox alert, delivered at once: a tool change isn't in any `now` list."""
    return await demo_inbox.deliver(ctx, copy_id=ctx.copy_id, desk_id=desk_id, to="owner", person_id=None,
                                    kind="alert", body=body, preview=render.owner_preview("drift"))


async def check_pin(ctx: KernelCtx, desk_id: str, tool: str, *,
                    listed: Mapping[str, Mapping[str, Any]] | None = None) -> PinCheck:
    """Lists the copy's tools again (or takes `listed`, a listing the caller has just made) and
    checks `tool` (an MCP tool on the Desk) against its pin: the pending hash while a change waits
    for review, else `definition_sha256`. A change is written in the caller's transaction, the row
    locked `FOR UPDATE` after the listing: an enabled or waiting tool becomes `needs_review`
    ("changed" with the pending entry, or "delisted" with none), the owner is alerted, and it is
    ledgered `tool_pin` `{tool, event: "drift", status, ...}`. A disabled tool keeps its status and
    gets the pending entry, with no alert. A delisted tool already recorded as such, or an
    unavailable listing, writes nothing."""
    if listed is None:
        try:
            listed = await mcp_client.client(ctx.settings).list_tools_raw(ctx.copy_id)
        except McpUnavailable:
            return PinCheck("unavailable")
    row = (await _rows(ctx, desk_id, [tool], lock=True)).get(tool)
    if row is None or not is_mcp(tool):
        raise ValueError(f"{tool} isn't a connected tool of this Desk")
    found = listed.get(MCP_OPERATIONS[tool])
    entry = dict(found) if found is not None else None
    sha = pin_sha256(entry) if entry is not None else None
    if sha is not None and sha == (row.pending_sha256 or row.definition_sha256):
        return PinCheck("ok", entry, sha)
    if sha is None and row.review_reason == "delisted":
        return PinCheck("removed")
    disabled = row.status == "disabled"
    if not disabled:
        row.status, row.review_reason = "needs_review", "changed" if sha is not None else "delisted"
    row.pending_definition_text = pending_text(entry) if entry is not None else None
    row.pending_sha256 = sha
    await ctx.db.flush()
    summary: dict[str, Any] = {"tool": tool, "event": "drift", "status": row.status,
                               "definition_sha256": row.definition_sha256}
    summary |= {"pending_sha256": sha} if sha is not None else {"removed": True}
    await _ledger(ctx, desk_id, summary)
    notice = None
    if not disabled:
        template = CHANGED_ALERT if sha is not None else DELISTED_ALERT
        notice = await _alert(ctx, desk_id, template.format(label=TOOL_LABELS[tool]))
    return PinCheck("drifted" if sha is not None else "removed", entry, sha, notice)


async def simulate_change(ctx: KernelCtx, desk_id: str, tool: str) -> Tool:
    """The demo's "Simulate a tool change" for a connected tool: the server changes the copy's
    definition of it (ledgered `tool_pin` `{tool, event: "simulated"}`), then `check_pin` runs at
    once, so an enabled tool is `needs_review` straight away. Returns its row. A native tool is 422
    `invalid`, an MCP tool not on the Desk 404 `not_found`, a server that can't be reached 503."""
    from desk.kernel_service import payments     # payments imports activation, which imports this module

    if not is_mcp(tool):
        raise KernelFailure(422, "invalid", "not_connected_tool")
    if tool not in await _rows(ctx, desk_id, [tool], lock=False):
        raise KernelFailure(404, "not_found", "unknown_tool")
    try:
        await payments.provider(ctx).simulate_change(MCP_OPERATIONS[tool])
    except (payments.ProviderError, payments.ProviderTimeout):
        log.warning("mockpay_unavailable copy_id=%s op=simulate_change", ctx.copy_id)
        raise KernelFailure(503, "internal", "mockpay_unavailable") from None
    await _ledger(ctx, desk_id, {"tool": tool, "event": "simulated"})
    await check_pin(ctx, desk_id, tool)
    return (await _rows(ctx, desk_id, [tool], lock=False))[tool]


# ---- The owner's confirm ----------------------------------------------------------------------------

async def _ledger_refusal(ctx: KernelCtx, *, copy_id: str, desk_id: str, summary: dict[str, Any]) -> None:
    ctx.bind(copy_id)
    await _ledger(ctx, desk_id, summary)


def _refused(ctx: KernelCtx, desk_id: str, pins: Sequence[ToolPin], enable: bool, status: int, code: str,
             reason: str) -> KernelFailure:
    """A refused confirm, ledgered `tool_pin` `{tools, enable, refused}` once the request rolls back."""
    summary = {"tools": [pin.tool for pin in pins], "enable": enable, "refused": reason}
    return KernelFailure(status, code, reason,
                         persist=partial(_ledger_refusal, copy_id=ctx.copy_id, desk_id=desk_id, summary=summary))


def _named_by(row: Tool) -> set[str]:
    """The hashes the owner may name a tool by to turn it off: what they see on its row (its pin or
    its pending hash), or a native tool's current adapter profile."""
    hashes = {row.definition_sha256, row.pending_sha256}
    if row.source == "native":
        hashes.add(native_pin(row.tool))
    return {sha for sha in hashes if sha is not None}


async def confirm_tools(ctx: KernelCtx, owner: OwnerCtx, desk_id: str, pins: Sequence[ToolPin],
                        enable: bool) -> ToolConfirmed:
    """The owner's batch confirm (`POST /tools/confirm`), in the caller's transaction. In order,
    refusing the whole batch with nothing changed, each refusal ledgered:

    - turning off an always-on tool (Verification) is 422 `invalid`;
    - a tool the Desk doesn't have, or that no adapter runs, is 404 `not_found`;
    - to disable: a hash that isn't the tool's pin, pending hash or (native) adapter profile hash
      is 409 `conflict`; then every tool is `disabled` at once (pending fields kept), each ledgered
      `tool_pin` `{tool, event: "disabled"}`, and no draft;
    - to enable: the MCP tools are listed again (unreachable: 503 `internal`), and each hash must
      be what is current, the listing hash or a native tool's adapter `profile_sha256` (409
      `conflict` otherwise). Tools already enabled at that hash are left alone; the rest go into
      one draft on the active version, with its owner cards and money cap unchanged, that enables
      them (`activation.draft(..., enables=)`), and stay as they are until it is confirmed.

    Returns the tools as they stand, in the request's order, and the draft, if any."""
    from desk.kernel_service import activation   # activation imports this module

    names = [pin.tool for pin in pins]
    if not enable and always_on.ALWAYS_ON_TOOLS & set(names):
        raise _refused(ctx, desk_id, pins, enable, 422, "invalid", "always_on")
    rows = await _rows(ctx, desk_id, names, lock=not enable)
    for tool in names:
        if rows.get(tool) is None or rows[tool].profile is None or await adapters.resolve(ctx, desk_id, tool) is None:
            raise _refused(ctx, desk_id, pins, enable, 404, "not_found", "unknown_tool")

    def answer(draft=None) -> ToolConfirmed:
        return ToolConfirmed(profiles=[owner_profile(rows[tool]) for tool in names], draft=draft)

    if not enable:
        if any(pin.definition_sha256 not in _named_by(rows[pin.tool]) for pin in pins):
            raise _refused(ctx, desk_id, pins, enable, 409, "conflict", "hash_changed")
        for tool in sorted(names):
            row = rows[tool]
            if row.status == "disabled":
                continue
            row.status, row.review_reason = "disabled", None
            await ctx.db.flush()
            await _ledger(ctx, desk_id, {"tool": tool, "event": "disabled"})
        return answer()

    listed: dict[str, dict[str, Any]] = {}
    if any(is_mcp(tool) for tool in names):
        try:
            listed = await mcp_client.client(ctx.settings).list_tools_raw(ctx.copy_id)
        except McpUnavailable:
            log.warning("mockpay_unavailable copy_id=%s op=tools_confirm", ctx.copy_id)
            raise _refused(ctx, desk_id, pins, enable, 503, "internal", "mockpay_unavailable") from None
    enables: list[ToolPin] = []
    for pin in pins:
        row, tool = rows[pin.tool], pin.tool
        if is_mcp(tool):
            entry = listed.get(MCP_OPERATIONS[tool])
            current = pin_sha256(entry) if entry is not None else None
        elif row.source == "business":
            current = row.definition_sha256
        else:
            current = native_pin(tool)
        if current is None or pin.definition_sha256 != current:
            raise _refused(ctx, desk_id, pins, enable, 409, "conflict", "hash_changed")
        if row.status == "enabled" and row.definition_sha256 == current:
            continue
        enables.append(ToolPin(tool=tool, definition_sha256=current))
    if not enables:
        return answer()
    active = await activation.active_version(ctx, desk_id)
    if active is None:
        raise _refused(ctx, desk_id, pins, enable, 409, "conflict", "no_active_version")
    draft = await activation.draft(ctx, owner, desk_id, [card for card in active.cards if not card.is_default],
                                   active.version, enables=enables)
    return answer(draft)


# ---- Activating a draft that enables tools ------------------------------------------------------------

@dataclass(frozen=True)
class EnablesCheck:
    """What `check_enables` found: every pin still current (`ok`), one changed or delisted
    (`changed`, with the tools whose drift the check found), or the server unreachable."""

    state: Literal["ok", "changed", "unavailable"]
    drifted: tuple[str, ...] = ()


async def check_enables(ctx: KernelCtx, desk_id: str, enables: Sequence[ToolPin]) -> EnablesCheck:
    """Whether each tool a draft enables is still at the hash it was proved with: a native tool's
    adapter profile unchanged, an MCP tool listed at exactly that hash (`check_pin`, which records a
    drift it finds in the caller's transaction). Stops at the first that isn't."""
    drifted: list[str] = []
    rows = await _rows(ctx, desk_id, [pin.tool for pin in enables], lock=False)
    for pin in sorted(enables, key=lambda pin: pin.tool):
        row = rows.get(pin.tool)
        if row is not None and row.source == "business":
            if row.definition_sha256 != pin.definition_sha256 or await adapters.resolve(ctx, desk_id, pin.tool) is None:
                return EnablesCheck("changed")
            continue
        if not is_mcp(pin.tool):
            if pin.tool not in adapters.ADAPTERS or native_pin(pin.tool) != pin.definition_sha256:
                return EnablesCheck("changed")
            continue
        check = await check_pin(ctx, desk_id, pin.tool)
        if check.state == "unavailable":
            return EnablesCheck("unavailable")
        if check.state != "ok":
            drifted.append(pin.tool)
            return EnablesCheck("changed", tuple(drifted))
        if check.sha256 != pin.definition_sha256:
            return EnablesCheck("changed")
    return EnablesCheck("ok")


async def record_drift(ctx: KernelCtx, desk_id: str, tools: Iterable[str]) -> None:
    """Checks `tools` again in a fresh transaction, so a drift found by a refused activation is
    recorded (the row, the alert and the ledger entry) after its own transaction rolled back."""
    for tool in sorted(set(tools)):
        await check_pin(ctx, desk_id, tool)


def enabled_with(profiles: Sequence[ToolProfile], enables: Sequence[ToolPin],
                 available: Mapping[str, ToolProfile] | None = None) -> list[ToolProfile]:
    """The enabled `profiles` plus the profiles `enables` turns on, each pinned at its hash (one a
    draft re-pins replaces the enabled one), by tool name."""
    by_tool = {profile.tool: profile for profile in profiles}
    for pin in enables:
        by_tool[pin.tool] = pinned_profile(pin.tool, pin.definition_sha256, (available or {}).get(pin.tool))
    return [by_tool[tool] for tool in sorted(by_tool)]


async def enable_tools(ctx: KernelCtx, desk_id: str, version: int, enables: Sequence[ToolPin]) -> list[LedgerEvent]:
    """Turns on the tools an activating version enables, in its transaction: each row `enabled` at
    the hash the version was proved with, its pending fields and review reason cleared. Returns
    their `tool_pin` `{tool, event: "enabled", version, definition_sha256}` events, which the
    activation ledgers after its `policy` entry."""
    from desk.kernel_service.activation import ConfirmConflict

    rows = await _rows(ctx, desk_id, [pin.tool for pin in enables], lock=True)
    events = []
    for pin in sorted(enables, key=lambda pin: pin.tool):
        if pin.tool not in rows:
            raise ConfirmConflict(ctx.copy_id, desk_id, version, "pin_changed")
        try:
            pin_row(rows[pin.tool], pin.tool, pin.definition_sha256, status="enabled", review_reason=None)
        except BusinessProfileChanged:
            raise ConfirmConflict(ctx.copy_id, desk_id, version, "pin_changed") from None
        events.append(LedgerEvent(kind="tool_pin", origin="kernel", summary={
            "tool": pin.tool, "event": "enabled", "version": version, "definition_sha256": pin.definition_sha256}))
    await ctx.db.flush()
    return events
