"""Mandates: what a visiting agent may still spend, and the reservations its money actions hold.

An agent session may hold one mandate, which the copy's demo wallet signed and `agents.open_session`
stored with its limits: `per_charge_cents`, `total_cents` and `expires_at` (master plan "Payments
(mocked) and visiting agents"). What it has left is `remaining_cents`: the smaller of its per-charge
limit and what its total leaves once committed and reserved money is taken off, or None (the
attribute absent, which the baseline refuses for any agent charge) once it has expired, for another
Desk, or when it doesn't allow `charge`. `/decide` and the execution re-check set it on the
principal of every request of a session with a mandate (`session_remaining`), so Cedar bounds each
agent charge by it.

A money action an agent asked for (`native.charge_mandate`, or an agent session's
`native.payment_link`) reserves its amount in its adapter's `prepare`, with the intent row
(`reserve`), under the mandate row's lock and against the same bound, so of two calls racing for the
last of a mandate one reserves and the other is refused at execution (`MandateExhausted`). The
reservation then moves once: `commit` when money moved (the mandate's `reserved_cents` into its
`committed_cents`), `release` when it can't any more (out of `reserved_cents`); while nobody knows
it stays `reserved`. Both are idempotent, and a missing reservation is a no-op (a visitor's link
holds none). Money that moved is never taken back off a mandate: releasing a committed reservation
changes nothing, and committing a released one fails closed (`MandateConflict`), since that would
mean money moved after its reservation was let go.

Only the activation's re-evaluation of an open agent link counts that link's own reservation back
(`own_action_id`), since the link already holds it: a link that took the last of a mandate isn't
cancelled for having taken it.

**Lock order.** The mandate row comes after the session, decision, execution, active version, quote
and payment link rows a caller holds, and before the ledger head; a reservation row after its mandate.
"""

import logging
from datetime import datetime

from sqlalchemy import select

from desk.db.models import Mandate as MandateRow
from desk.db.models import MandateReservation
from desk.kernel_service.agents import parse_signed_time
from desk.kernel_service.auth import SessionRow
from desk.kernel_service.repo import KernelCtx, new_id

log = logging.getLogger(__name__)

RESERVED, COMMITTED, RELEASED = "reserved", "committed", "released"


class MandateExhausted(Exception):
    """The mandate can't cover the amount now: expired, for another Desk, or not enough left."""


class MandateConflict(Exception):
    """A reservation already let go was asked to commit: money moved that its mandate no longer held."""


def _live(row: MandateRow, desk_id: str, now: datetime) -> bool:
    """Whether the mandate is for `desk_id`, allows `charge` and hasn't expired (a time that names
    no moment never comes)."""
    expires_at = parse_signed_time(row.expires_at)
    return (row.desk_id == desk_id and expires_at is not None and expires_at > now
            and "charge" in row.envelope.allowed_effects)


async def remaining_cents(ctx: KernelCtx, mandate_row: MandateRow | None, desk_id: str, now: datetime, *,
                          own_action_id: str | None = None) -> int | None:
    """`min(per_charge_cents, total_cents − committed_cents − reserved_cents)` of the mandate as
    `mandate_row` holds it, or None when there is none, it has expired, it is for another Desk or
    it doesn't allow `charge`. With `own_action_id`, the amount that action still has `reserved` on
    this mandate is counted back before the `min` (the activation's re-check of an open link)."""
    if mandate_row is None or not _live(mandate_row, desk_id, now):
        return None
    left = mandate_row.total_cents - mandate_row.committed_cents - mandate_row.reserved_cents
    if own_action_id is not None:
        own = (await ctx.db.execute(ctx.repo.scoped(select(MandateReservation.amount_cents).where(
            MandateReservation.action_id == own_action_id, MandateReservation.mandate_id == mandate_row.mandate_id,
            MandateReservation.state == RESERVED)))).scalar_one_or_none()
        left += own or 0
    return min(mandate_row.per_charge_cents, left)


async def session_remaining(ctx: KernelCtx, session_row: SessionRow, desk_id: str, *,
                            own_action_id: str | None = None) -> int | None:
    """What the agent session's mandate has left for a request on `desk_id` now (`remaining_cents`),
    read as last committed; None for any other session, one without a mandate, or a mandate stored
    for another session or key."""
    if session_row.kind != "agent" or session_row.mandate_id is None:
        return None
    row = (await ctx.db.scalars(ctx.repo.scoped(select(MandateRow).where(
        MandateRow.mandate_id == session_row.mandate_id).execution_options(populate_existing=True)))).one_or_none()
    if row is None or row.session_id != session_row.session_id or row.agent_key_id != session_row.agent_key_id:
        return None
    return await remaining_cents(ctx, row, desk_id, ctx.clock.now(), own_action_id=own_action_id)


async def _locked_mandate(ctx: KernelCtx, mandate_id: str) -> MandateRow | None:
    return (await ctx.db.scalars(ctx.repo.scoped(select(MandateRow).where(MandateRow.mandate_id == mandate_id)
                                                 .with_for_update().execution_options(populate_existing=True)))
            ).one_or_none()


async def reserve(ctx: KernelCtx, mandate_id: str, action_id: str, amount_cents: int | None, *, desk_id: str) -> None:
    """Reserves `amount_cents` on the mandate for the action on `desk_id`, in the caller's
    transaction: under the mandate row's `FOR UPDATE` lock, as last committed, the amount must be
    within `remaining_cents`, else `MandateExhausted` with nothing written. Adds it to the mandate's
    `reserved_cents` and records the action's reservation."""
    row = await _locked_mandate(ctx, mandate_id)
    bound = await remaining_cents(ctx, row, desk_id, ctx.clock.now())
    if row is None or bound is None or amount_cents is None or not 0 <= amount_cents <= bound:
        raise MandateExhausted(mandate_id)
    now = ctx.clock.now()
    row.reserved_cents += amount_cents
    ctx.db.add(MandateReservation(reservation_id=new_id("resv"), copy_id=row.copy_id, mandate_id=mandate_id,
                                  action_id=action_id, amount_cents=amount_cents, state=RESERVED, created_at=now,
                                  updated_at=now))
    await ctx.db.flush()


async def reservation_state(ctx: KernelCtx, action_id: str) -> str | None:
    """The state of the action's reservation, as last committed; None when it holds none."""
    return (await ctx.db.execute(ctx.repo.scoped(select(MandateReservation.state).where(
        MandateReservation.action_id == action_id).execution_options(populate_existing=True)))).scalar_one_or_none()


async def _settle(ctx: KernelCtx, action_id: str, to: str) -> None:
    found = (await ctx.db.execute(ctx.repo.scoped(select(MandateReservation.mandate_id).where(
        MandateReservation.action_id == action_id)))).scalar_one_or_none()
    if found is None:
        return
    mandate = await _locked_mandate(ctx, found)
    reservation = (await ctx.db.scalars(ctx.repo.scoped(select(MandateReservation).where(
        MandateReservation.action_id == action_id).with_for_update().execution_options(populate_existing=True)))).one()
    if mandate is None:
        raise RuntimeError(f"mandate {found} is gone")
    if reservation.state == to:
        return
    if reservation.state != RESERVED:
        log.error("mandate_reservation_conflict action_id=%s state=%s to=%s", action_id, reservation.state, to)
        if to == COMMITTED:
            raise MandateConflict(action_id)
        return                                            # money that moved stays counted
    mandate.reserved_cents -= reservation.amount_cents
    if to == COMMITTED:
        mandate.committed_cents += reservation.amount_cents
    reservation.state, reservation.updated_at = to, ctx.clock.now()
    await ctx.db.flush()


async def commit(ctx: KernelCtx, action_id: str) -> None:
    """The action's reservation `committed`, in the caller's transaction: its amount moves from the
    mandate's `reserved_cents` into its `committed_cents`, under the mandate row's lock. Idempotent;
    no reservation is a no-op; a released one is `MandateConflict`."""
    await _settle(ctx, action_id, COMMITTED)


async def release(ctx: KernelCtx, action_id: str) -> None:
    """The action's reservation `released`, in the caller's transaction: its amount leaves the
    mandate's `reserved_cents`, under the mandate row's lock. Idempotent; no reservation, or a
    committed one, is a no-op."""
    await _settle(ctx, action_id, RELEASED)
