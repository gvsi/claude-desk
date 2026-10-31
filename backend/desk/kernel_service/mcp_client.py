"""The kernel's MCP client of the mock payments server, and the pin of a listed tool definition.

The kernel is the server's only client (master plan, "Payments (mocked)"). Every call builds a
fresh `mcp.Client` with its list cache off (`cache=None`: the SDK caches `tools/list` by default,
which would hide a changed definition) over `streamable_http_client` on a fresh
`httpx2.AsyncClient` that reads no proxy settings from the environment (`trust_env=False`), with
the kernel's key in `X-Mockpay-Key` and the copy in `X-Desk-Copy`. The key comes from the kernel's
settings and goes in no log line, error or repr.

- `list_tools_raw(copy_id)`: every page of the copy's `tools/list`, name to entry, each entry the
  SDK's parsed `Tool` dumped as listed (`by_alias`, `exclude_unset`), within `MCP_DEADLINE_S` in
  all. Any failure (no key, a refused or slow connection, a malformed page, a name listed twice,
  too many pages) is `McpUnavailable`: a pin can't be checked, so the caller refuses.
- `call_tool(copy_id, name, arguments)`: one `tools/call`. `McpUnavailable` only when the call was
  never sent (no key, or the client couldn't start), `McpTimeout` once the deadline passes after it
  may have been sent; any other error propagates, and the caller treats its outcome as unknown.
- `pin_sha256(entry)`: the master's `definition_sha256`, sha256 of `canonical_json_any` of every
  field of a listed entry. A field the SDK's `Tool` drops reaches no one, so it isn't pinned.
- `seed_pins()`: the same over the server's default definitions (`desk.mockpay.definitions`), so
  `make proofs` and a copy's seed need no server to know the hashes the seed is proved with.
"""

import asyncio
import contextlib
import hashlib
import json
import logging
from collections.abc import AsyncIterator, Mapping
from typing import Any, Protocol

import desk_kernel
import httpx2
import mcp_types as types
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from desk.mockpay import definitions

log = logging.getLogger(__name__)

MCP_DEADLINE_S = 2.0      # a re-list or a call, in all: below the API client's 6 s with the rest of an execution
MAX_PAGES = 10            # the mock server lists one page; more than this is a server that never stops paging
KEY_MIN_LENGTH = 32       # the mock payments server refuses a shorter key, so none is ever sent
KEY_HEADER = "X-Mockpay-Key"
COPY_HEADER = "X-Desk-Copy"
MCP_PATH = "/mcp"


class McpUnavailable(Exception):
    """The server couldn't be asked: nothing was sent, or the listing can't be trusted."""


class McpTimeout(Exception):
    """A call may have reached the server and its outcome is unknown."""


class MockpaySettings(Protocol):
    mockpay_url: str
    mockpay_key: str


def listed_entry(tool: types.Tool) -> dict[str, Any]:
    """A parsed `tools/list` entry as the kernel pins it: every field the server set, by its wire name."""
    return tool.model_dump(mode="json", by_alias=True, exclude_unset=True)


def pin_sha256(entry: Mapping[str, Any]) -> str:
    """sha256 of `canonical_json_any(entry)`: the pin of one listed definition."""
    return hashlib.sha256(desk_kernel.canonical_json_any(json.dumps(entry)).encode()).hexdigest()


def seed_pins() -> dict[str, str]:
    """The pins of the server's default definitions, by tool name, parsed as a listing is."""
    return {name: pin_sha256(listed_entry(types.Tool.model_validate(definitions.default(name))))
            for name in definitions.TOOL_NAMES}


class McpClient:
    """The mock payments server's MCP endpoint, for any copy."""

    def __init__(self, *, url: str, key: str):
        self._url = url.rstrip("/") + MCP_PATH
        self._key = key

    def __repr__(self) -> str:                    # never the key
        return f"McpClient(url={self._url!r})"

    @contextlib.asynccontextmanager
    async def _session(self, copy_id: str) -> AsyncIterator[Client]:
        if not isinstance(self._key, str) or len(self._key) < KEY_MIN_LENGTH:
            raise McpUnavailable("no_key")
        headers = {KEY_HEADER: self._key, COPY_HEADER: copy_id}
        async with httpx2.AsyncClient(headers=headers, trust_env=False, follow_redirects=False) as http:
            async with Client(streamable_http_client(self._url, http_client=http), cache=None) as session:
                yield session

    async def list_tools_raw(self, copy_id: str) -> dict[str, dict[str, Any]]:
        """Every tool the server lists for `copy_id`, by name, as `listed_entry` dumps it."""
        try:
            async with asyncio.timeout(MCP_DEADLINE_S):
                async with self._session(copy_id) as session:
                    listed: dict[str, dict[str, Any]] = {}
                    cursor: str | None = None
                    for _ in range(MAX_PAGES):
                        page = await session.list_tools(cursor=cursor)
                        for tool in page.tools:
                            if tool.name in listed:
                                raise McpUnavailable("listed_twice")
                            listed[tool.name] = listed_entry(tool)
                        cursor = page.next_cursor
                        if cursor is None:
                            return listed
                    raise McpUnavailable("too_many_pages")
        except McpUnavailable as error:
            log.warning("mcp_unavailable op=list reason=%s", error)
            raise
        except TimeoutError:
            log.warning("mcp_unavailable op=list reason=deadline")
            raise McpUnavailable("deadline") from None
        except Exception as error:
            log.warning("mcp_unavailable op=list reason=%s", type(error).__name__)
            raise McpUnavailable("error") from None

    async def call_tool(self, copy_id: str, name: str, arguments: dict[str, Any]) -> types.CallToolResult:
        """One `tools/call` for `copy_id`: the server's result, `isError` included."""
        sent = False
        try:
            async with asyncio.timeout(MCP_DEADLINE_S):
                async with self._session(copy_id) as session:
                    sent = True
                    return await session.call_tool(name, arguments)
        except McpUnavailable as error:
            log.warning("mcp_unavailable op=call tool=%s reason=%s", name, error)
            raise
        except TimeoutError:
            if not sent:
                log.warning("mcp_unavailable op=call tool=%s reason=deadline", name)
                raise McpUnavailable("deadline") from None
            log.warning("mcp_timeout op=call tool=%s", name)
            raise McpTimeout("deadline") from None
        except Exception as error:
            if not sent:
                log.warning("mcp_unavailable op=call tool=%s reason=%s", name, type(error).__name__)
                raise McpUnavailable("error") from None
            raise


def client(settings: MockpaySettings) -> McpClient:
    """The MCP client for the kernel's settings (`MOCKPAY_URL`, `MOCKPAY_KEY`)."""
    return McpClient(url=settings.mockpay_url, key=settings.mockpay_key)
