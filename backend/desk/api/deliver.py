"""deliver(): the only writer of what a visitor sees from a conversation (master plan, "Delivery").

A visitor sees a reply only after the kernel checked it, and a status only as the kernel signed it. Both
reach the session as one of the four signed events, which only this module builds:

- `Reply(verdict, author, via, call_id)`: a `ReplyVerdict` becomes `EvMessage` (`handoff` when its shown
  blocks include the handoff clause) and a `delivered` row carrying the event's `seq`
  and, for Claude's `send_reply`, the call's ID. A verdict checked at a generation the session has since
  left (a take-over, a hand-back) is dropped: nothing is shown and None is returned. `via` says who
  produced it and fixes the author: `model` (Claude's `send_reply`) and `api` (a handoff the loop asked for, or a
  reply of Claude's replayed into a copy) are Claude's, `owner` (a say) the owner's and `kernel` (a payment
  confirmation) the Desk's.
- `Status(decision, phase)`: a signed decision becomes `EvReceipt`, `EvHeld` or `EvResolved` with its
  signed fields unchanged, and a `status` row. Statuses aren't generation-fenced (an approved hold
  resumes across a take-over); a decision's state at a ledger entry is shown once, and a state older than
  one already shown (a `/decide` answer held up while the owner answered, a receipt read before the
  kernel reconciled an `unknown` outcome) never is: either way it is None, so the visitor never sees a
  decision go back. `status_shown` answers whether it is shown (or, with `or_later`, whether that state or
  a later one is).

Recorded history (Plan 01d): `replayed` delivers a verdict or decision the kernel re-signed for a replayed night,
written at the moment it was shown and with the copy's `replay_id` (`store.Replayed`), its signed fields unchanged.

Each call runs in the caller's transaction under the session's run lock (`run_lock`, a transaction-level
advisory lock held until the caller commits), the lock take-over and hand-back hold around a mode change.
The run lock comes before the session's events lock (taken by `sse.append_event` and `store.append_message`): a
transaction that calls `emit()` or `append_message()` and then `deliver()` takes `run_lock` before its first `emit` or
append, or it can deadlock against another delivery.
The session's generation is read from `kernel_ro.sessions` after the lock is taken, in a READ COMMITTED
transaction, so a mode change committed while delivery waited is seen. The session is named only by a
kernel answer (`Ids` from `/whoami` or a kernel result naming it) within that answer's copy.
"""

from dataclasses import dataclass
from typing import Literal

from sqlalchemy import BigInteger, exists, func, select, text
from sqlalchemy.ext.asyncio import AsyncConnection

from desk.api.ro import KERNEL_RO, KernelRO
from desk.api.sse import RUN_EVENTS, append_event
from desk.api.store import MESSAGES, Ids, Replayed, append_message, lock_key
from desk.contracts import Decision, ReplyVerdict
from desk.events import EvHeld, EvMessage, EvReceipt, EvResolved

Phase = Literal["receipt", "held", "resolved"]
PHASES = ("receipt", "held", "resolved")
# A decision in one of these states may still change ("Decision lifecycle"): an allow may yet run or expire, a hold be
# answered, cancelled or expire, an approval finish, and an `unknown` execution be reconciled. Its final state is
# published once it has one, through a control row the session's next request handles.
NOT_FINAL = frozenset({"allowed", "held", "approved", "unknown"})
AUTHOR_BY_VIA = {"model": "claude", "api": "claude", "owner": "owner", "kernel": "desk"}


def visitor_safe(decision: Decision) -> Decision:
    """Copy a kernel decision without its owner-only line (`owner_plain`: why an execution was refused, or that the
    visitor's booking closed a held request) before a visitor or agent crossing.

    The signed visitor fields stay unchanged; the owner's original record keeps its line. Serialized job
    arguments must also exclude the cleared `owner_plain` field, so no visitor-side store carries even its key.
    """
    return decision.model_copy(update={"owner_plain": None})


@dataclass(frozen=True)
class Reply:
    verdict: ReplyVerdict
    author: Literal["claude", "owner", "desk"]
    via: Literal["model", "api", "owner", "kernel"]
    call_id: str | None = None             # the send_reply tool_use ID, for a reply Claude's call produced

    @property
    def handoff(self) -> bool:
        """The flag stored on the delivered event: its shown blocks include the handoff clause."""
        return any(block.template == "handoff" for block in self.verdict.blocks)

    def __post_init__(self) -> None:
        if self.via not in AUTHOR_BY_VIA or AUTHOR_BY_VIA[self.via] != self.author:
            raise ValueError("a reply's author follows from its via: model or api is claude, owner is owner and "
                             "kernel is desk")
        if (self.via == "model") != (self.call_id is not None):
            raise ValueError("only Claude's send_reply calls deliver via the model, each with its call ID")


@dataclass(frozen=True)
class Status:
    decision: Decision
    phase: Phase

    def __post_init__(self) -> None:
        if self.phase not in PHASES:
            raise ValueError("a status is a receipt, held or resolved")
        if (self.phase == "held") != (self.decision.state == "held"):
            raise ValueError("a held status shows a held decision, and only a held status does")
        object.__setattr__(self, "decision", visitor_safe(self.decision))


class SessionNotFound(LookupError):
    """The session isn't in the copy that named it; nothing is delivered."""


async def run_lock(conn: AsyncConnection, session_id: str) -> None:
    """The master's run lock: held until the caller's transaction ends, across API workers and tasks."""
    await conn.execute(select(func.pg_advisory_xact_lock(lock_key("run:" + session_id))))


async def deliver(conn: AsyncConnection, ids: Ids, item: Reply | Status, *, ro_schema: str = KERNEL_RO,
                  replayed: Replayed | None = None) -> int | None:
    """Publish a checked reply or a signed status to the session; returns the event's `seq`, or None when it is
    stale or already shown. `ro_schema` is `kernel_ro` (the fake's mirror in tests); `replayed` writes recorded
    history at its moment, with its `replay_id` (module docstring)."""
    if not isinstance(item, (Reply, Status)):
        raise TypeError("deliver() takes a Reply or a Status")
    isolation = (await conn.execute(text("SHOW transaction_isolation"))).scalar_one()
    if isolation != "read committed":
        raise RuntimeError("deliver() reads the current generation, which needs a READ COMMITTED transaction")
    await run_lock(conn, ids.session_id)
    if isinstance(item, Reply):
        return await _deliver_reply(conn, ids, item, ro_schema, replayed)
    return await _deliver_status(conn, ids, item, replayed)


async def _deliver_reply(conn: AsyncConnection, ids: Ids, reply: Reply, ro_schema: str,
                         replayed: Replayed | None) -> int | None:
    session = await KernelRO(conn, ids.copy_id, ro_schema).session(ids.session_id)
    if session is None or session["desk_id"] != ids.desk_id:
        raise SessionNotFound(ids.session_id)
    verdict = reply.verdict
    if verdict.generation != session["generation"]:
        return None
    shown = (await conn.execute(select(func.count()).where(
        MESSAGES.c.session_id == ids.session_id, MESSAGES.c.kind == "delivered",
        MESSAGES.c.ref_id == verdict.message_id))).scalar_one()
    if shown:
        return None
    event = EvMessage(type="message", message_id=verdict.message_id, generation=verdict.generation,
                      author=reply.author, language=verdict.language,
                      handoff=reply.handoff,
                      blocks=verdict.blocks,
                      visitor_plain=verdict.visitor_plain, ledger_seq=verdict.ledger_seq, signature=verdict.signature)
    seq = await append_event(conn, ids, event, replayed=replayed)
    await append_message(conn, ids, "delivered", replayed=replayed, author=reply.author, blocks=verdict.blocks,
                         language=verdict.language, ref_id=verdict.message_id, call_id=reply.call_id, event_seq=seq)
    return seq


async def status_shown(conn: AsyncConnection, decision: Decision, *, or_later: bool = False) -> bool:
    """Whether the decision's session already shows it at its ledger entry (a decision's state at a ledger entry is
    shown once) or, with `or_later`, at that entry or a later one: a state the session has moved past is stale."""
    ledger_seq = RUN_EVENTS.c.payload["ledger_seq"].astext
    at = ledger_seq.cast(BigInteger) >= decision.ledger_seq if or_later else ledger_seq == str(decision.ledger_seq)
    return (await conn.execute(select(exists().where(
        RUN_EVENTS.c.session_id == decision.session_id, RUN_EVENTS.c.kind == "sse", RUN_EVENTS.c.type.in_(PHASES),
        RUN_EVENTS.c.payload["decision_id"].astext == decision.decision_id, at)))).scalar_one()


async def _deliver_status(conn: AsyncConnection, ids: Ids, status: Status, replayed: Replayed | None) -> int | None:
    decision = status.decision
    if decision.session_id != ids.session_id:
        raise ValueError("a decision is shown only in its own session")
    if await status_shown(conn, decision, or_later=True):     # under the run lock: nothing can show meanwhile
        return None
    signed = {"decision_id": decision.decision_id, "state": decision.state, "visitor_plain": decision.visitor_plain,
              "ledger_seq": decision.ledger_seq, "signature": decision.signature}
    if status.phase == "receipt":
        event = EvReceipt(type="receipt", **signed)
    elif status.phase == "held":
        event = EvHeld(type="held", **signed)
    else:
        event = EvResolved(type="resolved", **signed)
    seq = await append_event(conn, ids, event, replayed=replayed)
    await append_message(conn, ids, "status", replayed=replayed, ref_id=decision.decision_id, event_seq=seq)
    return seq
