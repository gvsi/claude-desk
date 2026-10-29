"""Reads of the kernel's read-only views (`kernel_ro.*`), as desk_api, one copy at a time.

The views leave out every secret and admit only the rows of the copy the transaction set in
`desk.copy_id` (migrations 0002 and 0005). `KernelRO(conn, copy_id, schema)` names that copy from a
`WhoAmI` answer, never from the browser, and sets it before each read, so a read always runs as the
copy it was built for, whatever the transaction read before; each query also filters on `copy_id`
itself. Reads run in the caller's transaction and never commit. Only the master plan's views and
columns (`KERNEL_RO_COLUMNS`) can be named; `schema` is `kernel_ro`, or the fake's mirror in tests.
"""

import re
from typing import Any

from sqlalchemy import TableClause, column, func, select, table
from sqlalchemy.ext.asyncio import AsyncConnection

from desk.db.session import COPY_SETTING
from desk.db.tables import KERNEL_RO_COLUMNS

KERNEL_RO = "kernel_ro"
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
