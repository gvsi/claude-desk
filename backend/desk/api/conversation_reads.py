"""The owner's read markers (`app.conversation_reads`): which conversations hold words the owner hasn't seen yet.

A conversation is unread while a visitor or a visiting agent wrote a message (`visitor_text`, `agent_text`) after the
transcript cursor the owner has seen, or wrote any and the owner never opened it. Rows of Claude's, the owner's and the
API's, and the kernel's status rows, never make a conversation unread, and the owner's own preview never is. Each copy
has one owner, so a marker belongs to the copy.

`mark_read` moves a marker to the cursor the owner's screen last showed (`app.messages.n`), never back and never past
the session's newest row: a stale or replayed call marks nothing unread again, and a message that arrived after the
screen drew stays new. `unread` reads every unread conversation on the given Desks in one query, for the conversations
list and for each Desk's count in the Desk switcher, from the visitors' and agents' words alone (index
`messages_said`), so the polled reads stay cheap.

A new demo copy opens with its seeded conversations read, but for its newest visitor conversations (`seed_reads`).
Every function runs in the caller's transaction and never commits.
"""

from collections.abc import Sequence

from sqlalchemy import and_, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncConnection

from desk.api.deps import OwnerCtx
from desk.api.ro import ro_view, set_copy
from desk.api.store import MESSAGES, SAID_KINDS, Ids
from desk.db.models import ConversationRead

READS = ConversationRead.__table__
# A new demo copy leaves two conversations unread and marks every other seeded conversation read: its newest visitor
# conversation (the live seeded hold, which needs the owner) and its newest agent conversation. The owner's first look
# then shows a waiting chat of each kind beside read ones, and the unread count names chats worth opening rather than
# the whole recorded night.
SEEDED_UNREAD_KINDS = ("visitor_text", "agent_text")


async def mark_read(conn: AsyncConnection, ids: Ids, through: int) -> None:
    """Move the owner's marker on `ids`' conversation forward to `through`, held at the session's newest row; a marker
    already at or past where that lands stays as it is, `read_at` included."""
    newest = (select(func.max(MESSAGES.c.n))
              .where(MESSAGES.c.copy_id == ids.copy_id, MESSAGES.c.session_id == ids.session_id).scalar_subquery())
    marker = insert(READS).values(copy_id=ids.copy_id, desk_id=ids.desk_id, session_id=ids.session_id,
                                  read_through_n=func.least(through, func.coalesce(newest, 0)))
    await conn.execute(marker.on_conflict_do_update(
        index_elements=[READS.c.copy_id, READS.c.session_id],
        set_={"read_through_n": marker.excluded.read_through_n, "read_at": func.now()},
        where=marker.excluded.read_through_n > READS.c.read_through_n))


async def unread(ctx: OwnerCtx, desk_ids: Sequence[str]) -> dict[str, set[str]]:
    """The unread conversations on each of the copy's `desk_ids`, by Desk, read in one query: sessions with a visitor's
    or an agent's message past the owner's marker (or any, with no marker), the owner's previews left out."""
    if not desk_ids:
        return {}
    sessions = ro_view(ctx.ro.schema, "sessions")
    query = (select(MESSAGES.c.desk_id, MESSAGES.c.session_id).distinct()
             .select_from(MESSAGES
                          .outerjoin(READS, and_(READS.c.copy_id == MESSAGES.c.copy_id,
                                                 READS.c.session_id == MESSAGES.c.session_id))
                          .join(sessions, sessions.c.session_id == MESSAGES.c.session_id))
             .where(MESSAGES.c.copy_id == ctx.copy_id, MESSAGES.c.desk_id.in_(list(desk_ids)),
                    MESSAGES.c.kind.in_(SAID_KINDS), MESSAGES.c.n > func.coalesce(READS.c.read_through_n, 0),
                    sessions.c.copy_id == ctx.copy_id, sessions.c.preview.is_not(True)))
    found: dict[str, set[str]] = {}
    try:
        await set_copy(ctx.ro.conn, ctx.copy_id)
        for desk_id, session_id in await ctx.ro.conn.execute(query):
            found.setdefault(desk_id, set()).add(session_id)
    finally:
        await ctx.ro.done()
    return found


async def seed_reads(conn: AsyncConnection, copy_id: str) -> int:
    """Mark a new copy's seeded conversations read through their newest row, all but its newest visitor conversation
    and its newest agent conversation (`SEEDED_UNREAD_KINDS`; newest by their newest row's time, then session ID, so
    the pick is the same every time). Returns how many it marked."""
    rows = (await conn.execute(
        select(MESSAGES.c.desk_id, MESSAGES.c.session_id, func.max(MESSAGES.c.n).label("newest"),
               func.max(MESSAGES.c.created_at).label("last"),
               *(func.bool_or(MESSAGES.c.kind == kind).label(kind) for kind in SEEDED_UNREAD_KINDS))
        .where(MESSAGES.c.copy_id == copy_id, MESSAGES.c.desk_id.is_not(None), MESSAGES.c.session_id.is_not(None))
        .group_by(MESSAGES.c.desk_id, MESSAGES.c.session_id))).all()
    left = set()
    for kind in SEEDED_UNREAD_KINDS:
        said = [row for row in rows if getattr(row, kind)]
        if said:
            left.add(max(said, key=lambda row: (row.last, row.session_id)).session_id)
    marks = [{"copy_id": copy_id, "desk_id": row.desk_id, "session_id": row.session_id, "read_through_n": row.newest}
             for row in rows if row.session_id not in left]
    if marks:
        await conn.execute(insert(READS).values(marks).on_conflict_do_nothing())
    return len(marks)
