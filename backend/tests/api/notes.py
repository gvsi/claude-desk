"""Read the conversation notes an assertion means, separately from the model's clock updates."""

from sqlalchemy import or_, select, text

from desk.api.store import MESSAGES, TIME_NOTE_REF


async def conversation_notes(engine, session_id: str, *columns: str) -> list[tuple]:
    """All non-clock notes, in order, retaining notes with no reference and every requested column."""
    async with engine.connect() as conn:
        found = await conn.execute(select(text(", ".join(columns))).select_from(MESSAGES).where(
            MESSAGES.c.session_id == session_id, MESSAGES.c.kind == "note",
            or_(MESSAGES.c.ref_id.is_(None),
                ~MESSAGES.c.ref_id.startswith(TIME_NOTE_REF, autoescape=True))).order_by(MESSAGES.c.n))
        return [tuple(row) for row in found]
