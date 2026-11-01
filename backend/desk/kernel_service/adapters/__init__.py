"""The registry of adapters, one per tool. Each adapter module registers itself at import; the
native adapters (quote, open times, booking, lead capture, callbacks, verification, document
release, payment links and mandate charges), the owner's setup tools (website fetch, memory
reads and web search) and the pinned MCP tools' (`payments_mcp`) are imported at the end of this module.

`register` refuses an adapter whose args model isn't strict and closed, or whose profile's
`input_schema` isn't exactly that model's JSON Schema, so the schema Claude sees is the one the
kernel enforces. It also refuses one whose `releases_private_data` disagrees with its profile: the
declaration is True exactly when the profile has the `private_data` effect, which the rules decide
the tool by, so the execution's checks and the rules never read the tool differently.
"""

import hashlib
import json
import logging
from typing import Literal

import desk_kernel

from desk.contracts import MCP_TOOLS, ToolName, ToolProfile
from desk.kernel_service.adapters.base import Adapter

ADAPTERS: dict[ToolName, Adapter] = {}
log = logging.getLogger(__name__)

# Fields that a tools row's status, review or a pending drift changes; a profile's hash leaves them out.
UNHASHED_PROFILE_FIELDS = frozenset({"status", "pending_definition_text", "pending_sha256", "review_reason"})


def register(adapter: Adapter, *, replace: bool = False) -> Adapter:
    """Add `adapter` for its profile's tool; a second adapter for a tool needs `replace=True`."""
    _check(adapter)
    tool = adapter.profile.tool
    if tool in ADAPTERS and ADAPTERS[tool] is not adapter and not replace:
        raise ValueError(f"an adapter for {tool} is already registered")
    ADAPTERS[tool] = adapter
    return adapter


def registered_profiles(source: Literal["native", "mcp"] | None = None) -> list[ToolProfile]:
    """The registered adapters' profiles, by tool name, optionally only native or only MCP."""
    return [adapter.profile for _, adapter in sorted(ADAPTERS.items())
            if source is None or adapter.profile.source == source]


def profile_sha256(profile: ToolProfile) -> str:
    """sha256 of `canonical_json` of the profile without its status or pending fields."""
    fields = profile.model_dump(mode="json", exclude=set(UNHASHED_PROFILE_FIELDS))
    if profile.business is None:
        fields.pop("business", None)  # preserve every existing native and MCP pin and proof
    return hashlib.sha256(desk_kernel.canonical_json(json.dumps(fields)).encode()).hexdigest()


async def resolve(ctx, desk_id: str, tool: str) -> Adapter | None:
    """Resolve only the copy's own Desk row; malformed or stale block profiles fail closed.

    The pin check for native and MCP tools lives in context.resolved_tools.
    """
    from sqlalchemy import select
    from desk.contracts import is_business_tool
    from desk.db.models import Tool
    from desk.kernel_service.adapters import blocks

    if not is_business_tool(tool):
        return ADAPTERS.get(tool)
    row = (await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(
        Tool.desk_id == desk_id, Tool.tool == tool).execution_options(populate_existing=True)))).one_or_none()
    if row is None or row.source != "business" or row.profile is None or row.profile.business is None:
        return None
    if row.profile.business.config.block not in blocks.SUPPORTED_BLOCKS:
        return None                    # configured future blocks are expected, not factory failures
    try:
        expected = blocks.profile(tool, row.profile.business)
        if (row.profile.tool != tool or row.profile.source != "business"
                or row.definition_sha256 != expected.definition_sha256
                or row.profile.definition_sha256 != expected.definition_sha256
                or row.profile_sha256 != profile_sha256(expected)
                or row.profile_sha256 != profile_sha256(row.profile)):
            log.warning("business_adapter_pin_mismatch desk_id=%s tool=%s", desk_id, tool)
            return None
        adapter = blocks.adapter_for(expected.business, tool)
        _check(adapter)
        return adapter
    except Exception as exc:
        # A broken trusted factory is not a reason to fall back to the base native action.
        from desk.kernel_service import repo
        repo.log_error(log, exc, "business_adapter_resolution_failed desk_id=%s tool=%s", desk_id, tool)
        return None


def _check(adapter: Adapter) -> None:
    if not isinstance(adapter, Adapter):
        raise ValueError(f"{adapter!r} doesn't implement the adapter protocol")
    profile, args = adapter.profile, adapter.Args
    config = args.model_config
    if config.get("extra") != "forbid" or config.get("strict") is not True:
        raise ValueError(f"{profile.tool}: an adapter's Args model is strict with extra='forbid'")
    if profile.input_schema != args.model_json_schema():
        raise ValueError(f"{profile.tool}: the profile's input_schema must be its Args model's JSON Schema")
    if (profile.tool in MCP_TOOLS) != (profile.source == "mcp"):
        raise ValueError(f"{profile.tool}: only the pinned MCP tools have source 'mcp'")
    if not isinstance(adapter.free_text_fields, frozenset) or not adapter.free_text_fields <= set(args.model_fields):
        raise ValueError(f"{profile.tool}: free_text_fields names fields of its Args model")
    if not isinstance(adapter.model_view_keys, frozenset):
        raise ValueError(f"{profile.tool}: model_view_keys is a frozenset")
    if not isinstance(getattr(adapter, "releases_private_data", None), bool):
        raise ValueError(f"{profile.tool}: an adapter declares releases_private_data, True or False")
    if adapter.releases_private_data != ("private_data" in profile.effects):
        raise ValueError(f"{profile.tool}: releases_private_data is True exactly when the profile has the "
                         "private_data effect")


# The native adapters register themselves when imported, so importing this package gives the kernel
# all of them; they import `register` above, which is why they come last.
from desk.kernel_service.adapters import (book, capture_lead, charge_mandate, find_slots,  # noqa: E402, F401
                                         payment_link, payments_mcp, quote, release_document,
                                         request_callback, start_verification)
# The owner's setup tools: website and memory reads, and research about similar businesses.
from desk.kernel_service.adapters import fetch_website, read_memory, web_search  # noqa: E402, F401
