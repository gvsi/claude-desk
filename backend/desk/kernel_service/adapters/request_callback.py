"""`native.request_callback`: the visitor asks the owner to call them back.

The call names who to call, how to reach them and why, all text Claude writes into the call from
what the visitor said (untrusted, and the owner reads it under "Claude's note"); it can't name a
time. `execute` opens a new handoff of kind `callback`: a reason carrying that text for the owner, a
window that is the Desk's next open hour (`desks.next_open_window`), or none, the action's id and
the kernel's time, with a `handoff:<id>` fact labelled for the session (the callback confirmed card)
whose only claims are the window, so no visitor text reaches a card. The kernel keeps one open
handoff per session, so first it closes the session's open ones, the handoff card's or an earlier
call-back's (`close_open`), each as the owner's mark of done closes one: `done`, its fact expired,
ledgered `desk_data` `{part: "handoffs", refs: [its id], replaced_by: <this call-back's handoff
id>}`, which tells the owner's history it was replaced, not marked done by the owner. A row's kind
never changes, so an owner's stale mark of done on the card answers 409, never closing the
call-back, and each call-back's reconciliation finds its own row by its action. A session may hold
several open from before, or from the previous release during a deploy, and all of them close. The
execution holds the session row `FOR UPDATE` (`locks_session`), so two such executions, or one and a
reply check opening a card's handoff, take turns; the table itself holds no such rule. The fact
expires when its window ends, and when the owner closes the handoff (`POST /handoffs/{id}/done`), so
a callback that happened is never promised again.
The owner is alerted per the Desk's notification defaults; the alert is read only from the Demo
inbox, so the result's `inbox` stays empty. In the owner's own preview (`session_row.preview`),
the call-back instead inserts its row already `done`, skips `close_open` and sends no alert: no
Needs-you item and no `desk_data` closing entry (the owner's decision of 2026-10-31). Its fact stays
committed until its window ends (an unscheduled one, an urgent request's, for `PREVIEW_UNSCHEDULED_TTL`,
since no Mark done ever closes it), readable only by the owner and that session even after
verification, so the preview still shows the card; its row stays for reconciliation.
"""

from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from desk.contracts import Claim, Fact, Label, LedgerEvent, NormalizedAction, ResourceRef, ToolProfile
from desk.db.models import Fact as FactRow
from desk.db.models import Handoff
from desk.kernel_service import demo_inbox, desks, labels, ledger, render
from desk.kernel_service.adapters import register
from desk.kernel_service.adapters.base import (AdapterResult, ExecCtx, Normalized, NormalizeCtx, business_timezone,
                                               claudes_note)
from desk.kernel_service.repo import KernelCtx, new_id


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


async def close_open(ctx: KernelCtx, desk_id: str, session_id: str) -> list[Handoff]:
    """Closes the session's open handoffs, of either kind, each as the owner's mark of done closes one
    (`app.close_handoff`): `done`, under its row's lock, its `handoff:<id>` fact expired. Newest first
    (`created_at`, rows from before it last, then ID), so their locks come in one order. The caller
    ledgers each closing once its own rows are written, at the ledger head."""
    rows = list(await ctx.db.scalars(ctx.repo.scoped(select(Handoff).where(
        Handoff.desk_id == desk_id, Handoff.session_id == session_id, Handoff.status == "open")
        .order_by(Handoff.created_at.desc().nulls_last(), Handoff.handoff_id).with_for_update())))
    for row in rows:
        row.status = "done"
    return rows


PREVIEW_UNSCHEDULED_TTL = timedelta(hours=24)   # an urgent preview call-back's card, which no Mark done closes


async def open_callback(xctx: ExecCtx, action: NormalizedAction, args: RequestCallbackArgs, *,
                        alert: Callable[[tuple[datetime, datetime] | None], Awaitable[None]],
                        scheduled: bool = True) -> AdapterResult:
    """Open the native callback once; the caller chooses the owner alert in the same transaction. With
    `scheduled` false (an urgent request) the callback gets no next-open-hour window, so the visitor's
    card promises no time and the owner is alerted to call back now."""
    ctx = xctx.ctx
    now = ctx.clock.now()
    window = (desks.next_open_window(xctx.desk_row.hours, await business_timezone(ctx, xctx.desk_row), now)
              if scheduled else None)
    session_id = xctx.session_row.session_id
    start, end = window or (None, None)
    preview = xctx.session_row.preview
    closed = [] if preview else await close_open(ctx, action.desk_id, session_id)
    handoff_id = new_id("handoff")
    ctx.db.add(Handoff(handoff_id=handoff_id, copy_id=action.copy_id, desk_id=action.desk_id, session_id=session_id,
                       reason=f"{args.name} · {args.contact} · {args.reason}",
                       callback_window=f"{start.isoformat()}/{end.isoformat()}" if start and end else None,
                       status="done" if preview else "open", kind="callback", action_id=action.action_id,
                       window_start=start, window_end=end, created_at=now))
    await ctx.db.flush()              # the handoffs, then their facts, as the lock order goes
    if closed:
        expired = await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == action.desk_id,
            FactRow.fact_id.in_([f"handoff:{row.handoff_id}" for row in closed])).with_for_update()))
        for fact_row in expired:
            fact_row.status = "expired"
    # a callback whose window has passed can't be promised again
    label = (Label(readers=["owner", f"session:{session_id}"]) if preview
             else labels.new_fact_label(xctx.session_row))
    fact = Fact(fact_id=f"handoff:{handoff_id}", kind="handoff", status="committed", source="kernel",
                claims=window_claims(window), label=label,
                expires_at=now + PREVIEW_UNSCHEDULED_TTL if preview and window is None and not scheduled else end)
    ctx.db.add(labels.fact_row(action.copy_id, action.desk_id, fact, now, session_id=session_id,
                               action_id=action.action_id))
    await ctx.db.flush()
    for row in closed:
        await ledger.append(ctx, copy_id=action.copy_id, desk_id=action.desk_id, event=LedgerEvent(
            kind="desk_data", origin="kernel",
            summary={"part": "handoffs", "refs": [row.handoff_id], "replaced_by": handoff_id}))
    if not preview:
        await alert(window)
    return AdapterResult(facts=[fact], model_view=model_view(fact.fact_id, handoff_id))

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
        async def alert(window):
            await demo_inbox.alert_owner(xctx.ctx, action.desk_id, "callback", render.owner_preview("callback"),
                                         alert_body(window, args))

        return await open_callback(xctx, action, args, alert=alert)

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
