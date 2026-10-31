"""Best-effort delivery after policy activation; no kernel call holds a delivery lock."""

import logging
from typing import TYPE_CHECKING

from sqlalchemy import cast, exists, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncEngine

from desk.api.deliver import Reply, deliver, run_lock
from desk.api.ro import kernel_session
from desk.api.store import MESSAGES, Ids
from desk.contracts import PolicyVersion

if TYPE_CHECKING:
    from desk.api.deps import OwnerCtx

logger = logging.getLogger(__name__)
ROUTE = "GET /policy/{version}/cancelled_links?desk_id="


async def tell_cancelled_links(owner: "OwnerCtx", engine: AsyncEngine, desk_id: str, active: PolicyVersion) -> None:
    """Show the confirmed version's notices and retry its parent's once. Activation stands if any notice fails.

    The delivered card's `payment_link:<link_id>` fact ID is the durable guard: a link can be cancelled only once.
    Check it under the session's run lock, in the transaction that stores the unmodified verdict and its event.
    Kernel re-reads issue fresh message IDs, so `deliver()`'s message-ID guard alone would not suffice. No delivery
    record is written for a fenced verdict, letting the next read try it again. Like payment confirmations, a
    notice signed at the current generation is shown even while the owner has taken over the chat.
    """
    for version in dict.fromkeys(v for v in (active.version, active.parent_version) if v is not None):
        try:
            notices = await owner.kernel.call(ROUTE, path={"version": version}, query={"desk_id": desk_id})
        except Exception as error:
            logger.error("link_notices_unavailable version=%s link_id=unknown error=%s", version, type(error).__name__)
            continue
        for notice in notices:
            try:
                if (not notice.verdict.ok or [(block.template, block.fact_id) for block in notice.verdict.blocks]
                        != [("link_cancelled", f"payment_link:{notice.link_id}")]):
                    logger.error("link_notice_unexpected version=%s link_id=%s", version, notice.link_id)
                    continue
                async with engine.connect() as conn:
                    await run_lock(conn, notice.session_id)
                    session = await kernel_session(conn, notice.session_id, owner.ro.schema)
                    if (session is None or session["closed_at"] is not None or session["copy_id"] != owner.copy_id
                            or session["desk_id"] != desk_id):
                        logger.warning("link_notice_no_chat version=%s link_id=%s", version, notice.link_id)
                        continue
                    shown = (await conn.execute(select(exists().where(
                        MESSAGES.c.session_id == notice.session_id, MESSAGES.c.kind == "delivered",
                        MESSAGES.c.author == "desk", cast(MESSAGES.c.blocks, JSONB).contains([
                            {"template": "link_cancelled", "fact_id": f"payment_link:{notice.link_id}"}])
                    )))).scalar_one()
                    if shown:
                        continue
                    ids = Ids(copy_id=session["copy_id"], desk_id=desk_id, session_id=notice.session_id)
                    seq = await deliver(conn, ids, Reply(notice.verdict, "desk", via="kernel"),
                                        ro_schema=owner.ro.schema)
                    await conn.commit()
                    if seq is None:
                        logger.warning("link_notice_fenced version=%s link_id=%s", version, notice.link_id)
            except Exception as error:
                logger.error("link_notice_failed version=%s link_id=%s error=%s",
                             version, notice.link_id, type(error).__name__)
