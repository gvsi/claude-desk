"""Reads of the kernel's read-only views (`kernel_ro.*`), as desk_api, one copy at a time.

The views leave out every secret and admit only the rows of the copy the transaction set in
`desk.copy_id` (migrations 0002 and 0005). `KernelRO(conn, copy_id, schema)` names that copy from a
`WhoAmI` answer, never from the browser, and sets it before each read, so a read always runs as the
copy it was built for, whatever the transaction read before; each query also filters on `copy_id`
itself. Reads run in the caller's transaction and never commit. Only the master plan's views and
columns (`KERNEL_RO_COLUMNS`) can be named; `schema` is `kernel_ro`, or the fake's mirror in tests.

Two reads start from no `WhoAmI` answer: `kernel_session`, for a session a kernel answer just named (a
payment completion names only the session), and `due_decisions`, for the job that surfaces decisions
gone final. Each takes the copy from the API's own rows for that session or decision, which were written
under a `WhoAmI` answer, and reads only there; a session or decision the API has no row for is not found.
Neither ever comes from the browser.
"""

import re
from collections.abc import Sequence
from typing import Any

from sqlalchemy import TableClause, column, func, select, table, union
from sqlalchemy.ext.asyncio import AsyncConnection

from desk.db.models import Message, RunEvent
from desk.db.session import COPY_SETTING
from desk.db.tables import KERNEL_RO_COLUMNS

KERNEL_RO = "kernel_ro"
MESSAGES = Message.__table__
RUN_EVENTS = RunEvent.__table__
_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
_MANY = (list, tuple, set, frozenset)


def ro_view(schema: str, view: str) -> TableClause:
    """One of the master plan's views, with exactly its columns."""
    if view not in KERNEL_RO_COLUMNS:
        raise ValueError(f"{view!r} is not a kernel_ro view")
    return table(view, *(column(name) for name in KERNEL_RO_COLUMNS[view]), schema=schema)


async def set_copy(conn: AsyncConnection, copy_id: str) -> None:
    """Run the rest of the transaction's kernel_ro reads as `copy_id`."""
    if not copy_id:
        raise ValueError("a kernel_ro read needs a copy_id")
    await conn.execute(select(func.set_config(COPY_SETTING, copy_id, True)))


class KernelRO:
    """One copy's kernel_ro rows: `rows`, `one`, `session` and `desks`."""

    def __init__(self, conn: AsyncConnection, copy_id: str, schema: str = KERNEL_RO):
        if not copy_id:
            raise ValueError("KernelRO needs the copy_id of a WhoAmI answer")
        if not _IDENTIFIER.match(schema):
            raise ValueError("schema is a plain identifier")
        self.conn, self.copy_id, self.schema = conn, copy_id, schema

    async def rows(self, view: str, *, order_by: tuple[str, ...] = (), **equals: Any) -> list[dict[str, Any]]:
        """The view's rows in this copy where each named column equals its value (any of them, for a list)."""
        source = ro_view(self.schema, view)
        for name in (*equals, *order_by):
            if name not in source.c:
                raise ValueError(f"kernel_ro.{view} has no column {name!r}")
        conditions = [source.c.copy_id == self.copy_id]
        for name, value in equals.items():
            conditions.append(source.c[name].in_(list(value)) if isinstance(value, _MANY) else source.c[name] == value)
        await set_copy(self.conn, self.copy_id)
        result = await self.conn.execute(select(source).where(*conditions).order_by(*(source.c[n] for n in order_by)))
        return [dict(row._mapping) for row in result]

    async def one(self, view: str, **equals: Any) -> dict[str, Any] | None:
        """The one matching row, None when there is none; more than one is an error."""
        found = await self.rows(view, **equals)
        if len(found) > 1:
            raise LookupError(f"more than one kernel_ro.{view} row matches")
        return found[0] if found else None

    async def session(self, session_id: str) -> dict[str, Any] | None:
        return await self.one("sessions", session_id=session_id)

    async def desks(self) -> list[dict[str, Any]]:
        return await self.rows("desks", order_by=("created_at", "desk_id"))


async def kernel_session(conn: AsyncConnection, session_id: str, schema: str = KERNEL_RO) -> dict[str, Any] | None:
    """The kernel_ro row of a session a kernel answer just named, read in the copy of the API's rows for it."""
    copies = union(
        select(MESSAGES.c.copy_id).where(MESSAGES.c.session_id == session_id),
        select(RUN_EVENTS.c.copy_id).where(RUN_EVENTS.c.session_id == session_id)).subquery()
    found = (await conn.execute(select(copies.c.copy_id))).scalars().all()
    if len(found) != 1:
        return None                       # no row of the API's names it (or, impossibly, two copies do)
    return await KernelRO(conn, found[0], schema).session(session_id)


async def due_decisions(conn: AsyncConnection, decision_ids: Sequence[str], schema: str = KERNEL_RO) -> list[dict[str, Any]]:
    """The kernel_ro rows of these decisions, each read in the copy of the run events that published or await it."""
    if not decision_ids:
        return []
    named = RUN_EVENTS.c.payload["decision_id"].astext
    pairs = await conn.execute(select(RUN_EVENTS.c.copy_id, named).distinct().where(
        named.in_(list(decision_ids)), RUN_EVENTS.c.kind.in_(("sse", "control"))))
    by_copy: dict[str, list[str]] = {}
    for copy_id, decision_id in pairs:
        by_copy.setdefault(copy_id, []).append(decision_id)
    found = []
    for copy_id, ids in sorted(by_copy.items()):
        found += await KernelRO(conn, copy_id, schema).rows("decisions", decision_id=ids)
    return found
