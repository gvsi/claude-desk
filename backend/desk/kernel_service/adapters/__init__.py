"""The registry of adapters, one per tool. Each adapter module registers itself at import; the
native adapters (quote, open times, booking, lead capture, callbacks, verification, document
release, payment links and mandate charges), the owner's setup tools (website fetch and memory
reads) and the pinned MCP tools' (`payments_mcp`) are imported at the end of this module.

`register` refuses an adapter whose args model isn't strict and closed, or whose profile's
`input_schema` isn't exactly that model's JSON Schema, so the schema Claude sees is the one the
kernel enforces. It also refuses one whose `releases_private_data` disagrees with its profile: the
declaration is True exactly when the profile has the `private_data` effect, which the rules decide
the tool by, so the execution's checks and the rules never read the tool differently.
"""

import hashlib
import json
from typing import Literal

import desk_kernel

from desk.contracts import MCP_TOOLS, ToolName, ToolProfile
from desk.kernel_service.adapters.base import Adapter

ADAPTERS: dict[ToolName, Adapter] = {}

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
    return hashlib.sha256(desk_kernel.canonical_json(json.dumps(fields)).encode()).hexdigest()


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
# The owner's setup tools: reading the business's website and the owner's (simulated) memory.
from desk.kernel_service.adapters import fetch_website, read_memory  # noqa: E402, F401
