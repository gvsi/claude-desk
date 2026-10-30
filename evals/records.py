"""What a run left in the database, read from outside the kernel.

`Records` reads as the API's role (desk_api), the way the API sees kernel data: one reader per
`kernel_ro` view, each scoped to one copy (`await records.people(copy_id)`), a whole copy at once
(`snapshot`), the ledger as `LedgerEntry`s, and the API's own `app.*` rows for a session.
White-box readers use the kernel's role (desk_kernel) for the two things no view shows: document
canaries and the person a session verified as. Records are evidence a case checks, never a
verdict, and nothing here imports kernel code.
"""

import functools
import json
import re
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine
from sqlalchemy.pool import NullPool

from desk.contracts import LedgerEntry
from desk.db.session import COPY_SETTING
from desk.db.tables import KERNEL_RO_COLUMNS, KERNEL_RO_VIEWS

_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]*$")


class Records:
    """Read-only access to a run's rows: `api_dsn` as desk_api; `kernel_dsn`, when given, as
    desk_kernel for the white-box readers.

    Each call opens its own connection (no pool), so one `Records` serves any event loop."""

    def __init__(self, api_dsn: str, kernel_dsn: str | None = None):
        self._api = create_async_engine(api_dsn, poolclass=NullPool)
        self._kernel = create_async_engine(kernel_dsn, poolclass=NullPool) if kernel_dsn else None

    def __getattr__(self, name: str) -> Callable[[str], Awaitable[list[dict]]]:
        """A reader for each `kernel_ro` view: `await records.<view>(copy_id) -> list[dict]`. The
        ledger's is `ledger_entries(copy_id, desk_id)`, typed; `snapshot` has its raw rows."""
        if name in KERNEL_RO_VIEWS:
            return functools.partial(self._view, name)
        raise AttributeError(f"Records has no reader {name!r}; the kernel_ro views are {list(KERNEL_RO_VIEWS)}")

    async def close(self) -> None:
        await self._api.dispose()
        if self._kernel is not None:
            await self._kernel.dispose()

    # As desk_api

    async def _view(self, view: str, copy_id: str) -> list[dict]:
        async with self._api.begin() as conn:
            await _as_copy(conn, copy_id)
            return await _view_rows(conn, view, copy_id)

    async def snapshot(self, copy_id: str) -> dict[str, list[dict]]:
        """Every `kernel_ro` view's rows for the copy, read in one transaction."""
        async with self._api.begin() as conn:
            await _as_copy(conn, copy_id)
            return {view: await _view_rows(conn, view, copy_id) for view in KERNEL_RO_VIEWS}

    async def ledger_entries(self, copy_id: str, desk_id: str) -> list[LedgerEntry]:
        """A Desk's ledger, in order, as the contract's entries (for the oracles to verify)."""
        columns = ", ".join(KERNEL_RO_COLUMNS["ledger_entries"])
        async with self._api.begin() as conn:
            await _as_copy(conn, copy_id)
            result = await conn.execute(
                text(f"SELECT {columns} FROM kernel_ro.ledger_entries WHERE copy_id = :copy_id AND desk_id = :desk_id "
                     "ORDER BY seq"),
                {"copy_id": copy_id, "desk_id": desk_id},
            )
            return [LedgerEntry.model_validate(dict(row)) for row in result.mappings()]

    async def run_events(self, session_id: str) -> list[dict]:
        """The session's `app.run_events` rows, oldest first."""
        return await self._app_rows("run_events", session_id)

    async def model_calls(self, session_id: str) -> list[dict]:
        """The session's `app.model_calls` rows (usage only, never content), oldest first."""
        return await self._app_rows("model_calls", session_id)

    async def app_rows(self, session_id: str) -> str:
        """Every `app.*` row naming the session, as text (one line per row), for leak scans."""
        async with self._api.connect() as conn:
            tables = (await conn.execute(text(
                "SELECT table_name FROM information_schema.columns "
                "WHERE table_schema = 'app' AND column_name = 'session_id' ORDER BY table_name"
            ))).scalars().all()
        lines = []
        for table in tables:
            for row in await self._app_rows(table, session_id):
                lines.append(f"app.{table} {json.dumps(row, default=str, sort_keys=True)}")
        return "\n".join(lines)

    async def _app_rows(self, table: str, session_id: str) -> list[dict]:
        """A table's rows for the session, oldest first (every `app.*` table has `created_at`)."""
        if not _IDENTIFIER.match(table):
            raise ValueError(f"not a table name: {table!r}")
        async with self._api.connect() as conn:
            result = await conn.execute(
                text(f"SELECT * FROM app.{table} WHERE session_id = :session_id ORDER BY created_at, 1"),
                {"session_id": session_id},
            )
            return [dict(row) for row in result.mappings()]

    # White-box, as desk_kernel

    async def document_canaries(self, copy_id: str) -> list[str]:
        """The canary planted in each of the copy's documents, by document id."""
        rows = await self._kernel_rows(
            copy_id, "SELECT canary FROM kernel.documents WHERE copy_id = :copy_id ORDER BY document_id", {}
        )
        return [row["canary"] for row in rows]

    async def document_canary(self, copy_id: str, document_id: str) -> str:
        """The canary planted in one of the copy's documents, such as Dana's invoice."""
        rows = await self._kernel_rows(
            copy_id, "SELECT canary FROM kernel.documents WHERE copy_id = :copy_id AND document_id = :document_id",
            {"document_id": document_id},
        )
        if not rows:
            raise LookupError(f"no document {document_id!r} in copy {copy_id!r}")
        return rows[0]["canary"]

    async def session_person(self, session_id: str, *, copy_id: str) -> str | None:
        """The person a session is verified as (`kernel.sessions.person_id`), None if unverified.

        Kernel tables admit one copy per transaction, so the reader names the session's copy."""
        rows = await self._kernel_rows(
            copy_id, "SELECT person_id FROM kernel.sessions WHERE copy_id = :copy_id AND session_id = :session_id",
            {"session_id": session_id},
        )
        if not rows:
            raise LookupError(f"no session {session_id!r} in copy {copy_id!r}")
        return rows[0]["person_id"]

    async def _kernel_rows(self, copy_id: str, sql: str, params: dict[str, Any]) -> list[dict]:
        if self._kernel is None:
            raise RuntimeError("white-box records need the kernel's database URL (Records(api_dsn, kernel_dsn))")
        async with self._kernel.begin() as conn:
            await _as_copy(conn, copy_id)
            result = await conn.execute(text(sql), {"copy_id": copy_id, **params})
            return [dict(row) for row in result.mappings()]


class NoRecords:
    """The contract stub's records: there are none, so every reader fails the case.

    A case reads records only where a real kernel answered, under `if k.is_real:`."""

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        raise AssertionError(f"records.{name}: the contract stub keeps no records; read them under `if k.is_real:`")


async def _as_copy(conn: AsyncConnection, copy_id: str) -> None:
    """Run the rest of the transaction as `copy_id`, the only copy row security then admits."""
    if not copy_id:
        raise ValueError("records are read one copy at a time; copy_id is empty")
    await conn.execute(select(func.set_config(COPY_SETTING, copy_id, True)))


async def _view_rows(conn: AsyncConnection, view: str, copy_id: str) -> list[dict]:
    """Every column the view shows the API (`*`, so a leak scan sees a column added later too)."""
    if view not in KERNEL_RO_VIEWS:
        raise ValueError(f"not a kernel_ro view: {view!r}")
    result = await conn.execute(
        text(f"SELECT * FROM kernel_ro.{view} WHERE copy_id = :copy_id ORDER BY 1, 2, 3"), {"copy_id": copy_id}
    )
    return [dict(row) for row in result.mappings()]


__all__ = ["NoRecords", "Records"]
