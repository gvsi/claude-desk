"""`native.request_callback`: the visitor asks the owner to call them back.

The call names who to call, how to reach them and why, all text Claude writes into the call from
what the visitor said (untrusted, and the owner reads it under "Claude's note"); it can't name a
time. `execute` makes the session's handoff a call-back's: kind `callback`, a reason carrying that
text for the owner, a window that is the Desk's next open hour (`desks.next_open_window`), or none,
and the action's id, with a `handoff:<id>` fact labelled for the session (the callback confirmed
card) whose only claims are the window, so no visitor text reaches a card. A session holds one open
handoff (`handoffs_one_open_per_session`): when it already has one, the handoff card's or an
earlier call-back's, that one becomes this call-back's, in this execution's transaction, its fact
written or rewritten under the same id, so the owner keeps one item for the conversation and the
visitor's card shows the time now promised; otherwise a new one opens. The execution holds the
session row `FOR UPDATE` (`locks_session`), so two such executions, or one and a reply check
opening a card's handoff, take turns. The fact expires when its window ends, and when the owner
closes the handoff (`POST /handoffs/{id}/done`), so a callback that happened is never promised again.
The owner is alerted per the Desk's notification defaults; the alert is read only from the Demo
inbox, so the result's `inbox` stays empty.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from desk.contracts import Claim, Fact, NormalizedAction, ResourceRef, ToolProfile
from desk.db.models import Fact as FactRow
from desk.db.models import Handoff
from desk.kernel_service import demo_inbox, desks, labels, render
from desk.kernel_service.adapters import register
from desk.kernel_service.adapters.base import (AdapterResult, ExecCtx, Normalized, NormalizeCtx, business_timezone,
                                               claudes_note)
from desk.kernel_service.repo import new_id


class RequestCallbackArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: str = Field(min_length=1, max_length=80)
    contact: str = Field(min_length=1, max_length=120)
    reason: str = Field(min_length=1, max_length=200)


PROFILE = ToolProfile(
    tool="native.request_callback", source="native", effects=["change"], reversible=True,
    adapter="desk.kernel_service.adapters.request_callback", resource_kind="desk",
    description_confirmed=(
        "Asks the owner to call the visitor back. Pass the visitor's name, the phone number or email to reach "
        "them and what the call is about. The time comes from the business's records and the visitor sees it "
        "in a callback card, never in your own words."),
    input_schema=RequestCallbackArgs.model_json_schema(), status="enabled")


def window_claims(window: tuple[datetime, datetime] | None) -> list[Claim]:
    """The fact's claims: the window's start and end in the business's time zone, or none."""
    if window is None:
        return []
    start, end = window
    return [Claim(key="window_start", kind="datetime", value=start.isoformat()),
            Claim(key="window_end", kind="datetime", value=end.isoformat())]


def alert_body(window: tuple[datetime, datetime] | None, args: RequestCallbackArgs) -> str:
    """The owner's alert: when to call back, in business time, then the call's text, quoted under
    "Claude's note" (`claudes_note`)."""
    if window is None:
        when = "No hour is open in the next two weeks, so no time was given."
    else:
        start, end = window
        when = f"Call back on {render.en.date(start)}, between {render.en.clock(start)} and {render.en.clock(end)}."
    return f"{when} {claudes_note((args.name, args.contact, args.reason))}"


def model_view(fact_id: str, handoff_id: str) -> dict[str, Any]:
    return {"fact_id": fact_id, "handoff_id": handoff_id}


class RequestCallbackAdapter:
    profile = PROFILE
    Args = RequestCallbackArgs
    free_text_fields = frozenset({"name", "contact", "reason"})
    model_view_keys = frozenset({"fact_id", "handoff_id"})
    releases_private_data = False         # the session's own callback request
    locks_session = True                  # one open handoff per session: the session row FOR UPDATE in T2

    async def normalize(self, nctx: NormalizeCtx, args: RequestCallbackArgs) -> Normalized:
        return Normalized(resource=ResourceRef(kind="desk", id=nctx.desk_row.desk_id, owner_person_id=None))

    async def execute(self, xctx: ExecCtx, action: NormalizedAction, args: RequestCallbackArgs) -> AdapterResult:
        ctx = xctx.ctx
        now = ctx.clock.now()
        window = desks.next_open_window(xctx.desk_row.hours, await business_timezone(ctx, xctx.desk_row), now)
        session_id = xctx.session_row.session_id
        start, end = window or (None, None)
        written = {"reason": f"{args.name} · {args.contact} · {args.reason}", "kind": "callback",
                   "callback_window": f"{start.isoformat()}/{end.isoformat()}" if start and end else None,
                   "action_id": action.action_id, "window_start": start, "window_end": end}
        handoff = (await ctx.db.scalars(ctx.repo.scoped(select(Handoff).where(
            Handoff.desk_id == action.desk_id, Handoff.session_id == session_id, Handoff.status == "open")
            .with_for_update()))).one_or_none()
        if handoff is None:
            handoff = Handoff(handoff_id=new_id("handoff"), copy_id=action.copy_id, desk_id=action.desk_id,
                              session_id=session_id, status="open", **written)
            ctx.db.add(handoff)
        else:                             # the session's open handoff, a card's or an earlier call-back's
            for column, value in written.items():
                setattr(handoff, column, value)
        await ctx.db.flush()              # the handoff, then its fact, as the lock order goes
        # a callback whose window has passed can't be promised again
        fact = Fact(fact_id=f"handoff:{handoff.handoff_id}", kind="handoff", status="committed", source="kernel",
                    claims=window_claims(window), label=labels.new_fact_label(xctx.session_row), expires_at=end)
        row = labels.fact_row(action.copy_id, action.desk_id, fact, now, session_id=session_id,
                              action_id=action.action_id)
        kept = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == action.desk_id, FactRow.fact_id == fact.fact_id).with_for_update()))).one_or_none()
        if kept is None:
            ctx.db.add(row)
        else:                             # an earlier call-back's: this one's window, label and action
            for column in ("status", "claims", "readers", "record_owner", "expires_at", "session_id", "action_id",
                           "created_at"):
                setattr(kept, column, getattr(row, column))
        await ctx.db.flush()
        await demo_inbox.alert_owner(ctx, action.desk_id, "callback", render.owner_preview("callback"),
                                     alert_body(window, args))
        return AdapterResult(facts=[fact], model_view=model_view(fact.fact_id, handoff.handoff_id))

    async def reconcile(self, xctx: ExecCtx, action: NormalizedAction) -> AdapterResult | None:
        """The handoff the action wrote, if it wrote one."""
        ctx = xctx.ctx
        handoff = (await ctx.db.scalars(ctx.repo.scoped(
            select(Handoff).where(Handoff.action_id == action.action_id)))).one_or_none()
        if handoff is None:
            return None
        fact = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == action.desk_id, FactRow.action_id == action.action_id)))).one()
        return AdapterResult(facts=[labels.fact_of(fact)], model_view=model_view(fact.fact_id, handoff.handoff_id))


ADAPTER = register(RequestCallbackAdapter())
