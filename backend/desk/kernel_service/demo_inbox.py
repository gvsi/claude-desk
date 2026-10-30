"""The Demo inbox: where the prototype "delivers" verification codes, owner alerts and ledger
checkpoints instead of sending real email, SMS or push.

Entries live only in `kernel.demo_inbox`, read back only through the kernel's `GET /demo_inbox`
routes. A writer returns an `InboxNotice` (entry, masked recipient, preview), which is code-free
and safe for SSE and `app.*`, never the body. Writers run in the caller's transaction and never
commit, so an entry exists only if the record that caused it does.
"""

from typing import get_args

from sqlalchemy import insert, select

from desk.contracts import DemoInboxEntry, InboxNotice
from desk.db.models import DemoInboxEntry as DemoInboxRow
from desk.db.models import NotificationPref
from desk.kernel_service.repo import KernelCtx, new_id

KINDS = frozenset(get_args(DemoInboxEntry.model_fields["kind"].annotation))


async def deliver(ctx: KernelCtx, *, copy_id: str, desk_id: str, to: str, person_id: str | None, kind: str,
                  body: str, preview: str) -> InboxNotice:
    """Write one entry in the caller's transaction. `to` is "owner" or the masked contact on record;
    `body` may hold a code, `preview` never does."""
    if kind not in KINDS:
        raise ValueError(f"{kind!r} is not a Demo inbox kind")
    ctx.bind(copy_id)
    notice = InboxNotice(entry_id=new_id("inbox"), to=to, preview=preview)
    await ctx.db.execute(insert(DemoInboxRow).values(
        entry_id=notice.entry_id, copy_id=copy_id, desk_id=desk_id, to=to, person_id=person_id, kind=kind,
        body=body, preview=preview, created_at=ctx.clock.now(),
    ))
    return notice


async def alert_owner(ctx: KernelCtx, desk_id: str, event_kind: str, preview: str, body: str) -> InboxNotice | None:
    """Alert the owner at once when `event_kind` is in the Desk's `notification_prefs.now`; otherwise
    (a briefing kind, or no preferences) write nothing and return None. Runs in the caller's
    transaction, which must already be bound to the Desk's copy. `body` may carry `reason_plain`
    and masked contacts, never a code."""
    prefs = select(NotificationPref.now).where(NotificationPref.desk_id == desk_id)
    alert_now = (await ctx.db.execute(ctx.repo.scoped(prefs))).scalar_one_or_none()
    if not alert_now or event_kind not in alert_now:
        return None
    return await deliver(ctx, copy_id=ctx.copy_id, desk_id=desk_id, to="owner", person_id=None, kind="alert",
                         body=body, preview=preview)
