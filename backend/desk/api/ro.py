"""Reads of the kernel's read-only views (`kernel_ro.*`), as desk_api, one copy at a time.

The views leave out every secret and admit only the rows of the copy the transaction set in
`desk.copy_id` (migrations 0002 and 0005). `KernelRO(conn, copy_id, schema)` names that copy from a
`WhoAmI` answer, never from the browser, and sets it before each read, so a read always runs as the
copy it was built for, whatever the transaction read before; each query also filters on `copy_id`
itself. Reads run in the caller's transaction and never commit; built with `own_transactions`, as
for work that waits on a model between its reads, each read instead ends the transaction it opened
(`done`), so none stays open while the work waits. Only the master plan's views and columns
(`KERNEL_RO_COLUMNS`) can be named; `schema` is `kernel_ro`, or the fake's mirror in tests.

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

    def __init__(self, conn: AsyncConnection, copy_id: str, schema: str = KERNEL_RO, *,
                 own_transactions: bool = False):
        if not copy_id:
            raise ValueError("KernelRO needs the copy_id of a WhoAmI answer")
        if not _IDENTIFIER.match(schema):
            raise ValueError("schema is a plain identifier")
        self.conn, self.copy_id, self.schema = conn, copy_id, schema
        self.own_transactions = own_transactions

    async def done(self) -> None:
        """End the transaction a read opened, when the reads run in transactions of their own (nothing on the
        connection writes, so it is rolled back); a read in the caller's transaction leaves it as it is."""
        if self.own_transactions and self.conn.in_transaction():
            await self.conn.rollback()

    async def rows(self, view: str, *, order_by: tuple[str, ...] = (), nulls_first: tuple[str, ...] = (),
                   **equals: Any) -> list[dict[str, Any]]:
        """The view's rows in this copy where each named column equals its value (any of them, for a list).
        Order in SQL, with NULLs first for the named ordering columns; other columns keep PostgreSQL's default."""
        source = ro_view(self.schema, view)
        for name in (*equals, *order_by, *nulls_first):
            if name not in source.c:
                raise ValueError(f"kernel_ro.{view} has no column {name!r}")
        if any(name not in order_by for name in nulls_first):
            raise ValueError("nulls_first columns must be named in order_by")
        conditions = [source.c.copy_id == self.copy_id]
        for name, value in equals.items():
            conditions.append(source.c[name].in_(list(value)) if isinstance(value, _MANY) else source.c[name] == value)
        try:
            await set_copy(self.conn, self.copy_id)
            result = await self.conn.execute(select(source).where(*conditions)
                                             .order_by(*(source.c[n].nulls_first() if n in nulls_first else source.c[n]
                                                         for n in order_by)))
            return [dict(row._mapping) for row in result]
        finally:
            await self.done()

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


def replayed(entry: dict | None) -> bool:
    """Whether a ledger entry is recorded history: a kernel entry whose summary carries the `replayed` mark, which only
    the kernel's replay writes (Plan 01d). Malformed events or summaries count as replayed conservatively.
    A missing entry is not, so this is for an entry the caller has read; a read
    about a decision, whether it keeps the decision from a model or labels it for the owner (a booking, a charge, a
    refusal, a tool's decision), asks `decision_replayed`, which fails closed."""
    if entry is None:
        return False
    event = entry.get("event")
    if not isinstance(event, dict) or not isinstance(event.get("summary"), dict):
        return True
    return event.get("origin", "kernel") == "kernel" and isinstance(event["summary"].get("replayed"), dict)


def decision_replayed(decision: dict[str, Any], entry: dict[str, Any] | None) -> bool:
    """Whether a `kernel_ro.decisions` row is recorded history, failing closed, for a read that keeps it from a model
    or labels it for the owner (a tool's decisions, and the bookings, charges and refusals the owner's screens count).
    `entry` is the copy's `ledger_entries` row at the decision's `ledger_seq` (None when none was read). The decision
    is live only when it names an entry, that entry was read and the kernel didn't mark it replayed; a null
    `ledger_seq`, an entry that can't be read (missing, or outside the copy's view) or one other than the entry it
    names counts as replayed, so a decision of unknown origin is never treated as live."""
    seq = decision["ledger_seq"]
    return seq is None or entry is None or entry["seq"] != seq or replayed(entry)


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
