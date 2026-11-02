"""The Demo inbox: where the prototype "delivers" verification codes, owner alerts and ledger
checkpoints instead of sending real email, SMS or push.

Entries live only in `kernel.demo_inbox`, read back only through the kernel's `GET /demo_inbox`
routes. A writer returns an `InboxNotice` (entry, masked recipient, preview), which is code-free
and safe for SSE and `app.*`, never the body. Writers run in the caller's transaction and never
commit, so an entry exists only if the record that caused it does.

Two reads serve those routes. A session reads only the verification codes of the challenges it
started, or a demo agent it minted started (`agents.minted_sessions`), each code entry naming its
challenge: in the demo, whoever types a person's contact, or has their own agent type it, is shown
the code sent to it, and never a code another session asked for, which may have gone to a contact
the owner has since changed. A session never reads an owner alert or a head checkpoint, nor the
codes of agents another session or the owner minted, and no entry it reads names a decision
(`session_entry`). The owner reads every entry of the copy, a held request's alert with the
decision it is about and each alert to them under its preview line (`owner_entry`).
"""

from typing import get_args

from sqlalchemy import insert, select

from desk.contracts import DemoInboxEntry, InboxNotice
from desk.db.models import ActorSession, NotificationPref, VerificationChallenge
from desk.db.models import DemoInboxEntry as DemoInboxRow
from desk.kernel_service.repo import KernelCtx, new_id

KINDS = frozenset(get_args(DemoInboxEntry.model_fields["kind"].annotation))


async def deliver(ctx: KernelCtx, *, copy_id: str, desk_id: str, to: str, person_id: str | None, kind: str,
                  body: str, preview: str, decision_id: str | None = None,
                  challenge_id: str | None = None) -> InboxNotice:
    """Write one entry in the caller's transaction. `to` is "owner" or the masked contact on record;
    `body` may hold a code, `preview` never does. `decision_id` is only for an owner alert: anywhere
    else it raises ValueError here, before the table's check would refuse the row, saying whether the
    entry went to the owner or to a contact, never which contact. `challenge_id`, the challenge a
    code was sent for, is required on a `verification_code` entry and refused on any other, with a
    ValueError too."""
    if kind not in KINDS:
        raise ValueError(f"{kind!r} is not a Demo inbox kind")
    if decision_id is not None and (kind != "alert" or to != "owner"):
        recipient = "the owner" if to == "owner" else "a contact"
        raise ValueError(f"only an alert to the owner names a decision, not a {kind!r} entry to {recipient}")
    if (challenge_id is not None) != (kind == "verification_code"):
        raise ValueError(f"a code entry names its challenge and no other entry names one, not a {kind!r} entry")
    ctx.bind(copy_id)
    notice = InboxNotice(entry_id=new_id("inbox"), to=to, preview=preview)
    await ctx.db.execute(insert(DemoInboxRow).values(
        entry_id=notice.entry_id, copy_id=copy_id, desk_id=desk_id, to=to, person_id=person_id, kind=kind,
        body=body, preview=preview, created_at=ctx.clock.now(), decision_id=decision_id, challenge_id=challenge_id,
    ))
    return notice


async def alert_owner(ctx: KernelCtx, desk_id: str, event_kind: str, preview: str, body: str, *,
                      decision_id: str | None = None) -> InboxNotice | None:
    """Alert the owner at once when `event_kind` is in the Desk's `notification_prefs.now`; otherwise
    (a briefing kind, or no preferences) write nothing and return None. Runs in the caller's
    transaction, which must already be bound to the Desk's copy. `body` may carry `reason_plain`
    and masked contacts, never a code. `decision_id` is the held decision the alert is about, the
    id the kernel gave the decision it just stored (never text from the model or a visitor), so the
    owner's Demo inbox can link to the request; every other alert has none, and one given with any
    other `event_kind` raises ValueError before the Desk's preferences are read."""
    if decision_id is not None and event_kind != "approval":
        raise ValueError(f"only an approval alert names a decision, not a {event_kind!r} alert")
    prefs = select(NotificationPref.now).where(NotificationPref.desk_id == desk_id)
    alert_now = (await ctx.db.execute(ctx.repo.scoped(prefs))).scalar_one_or_none()
    if not alert_now or event_kind not in alert_now:
        return None
    return await deliver(ctx, copy_id=ctx.copy_id, desk_id=desk_id, to="owner", person_id=None, kind="alert",
                         body=body, preview=preview, decision_id=decision_id)


def owner_entry(row: DemoInboxRow) -> DemoInboxEntry:
    """An entry as the owner reads it: a held request's alert names its decision, and an alert to the
    owner is titled with its fixed preview line (`render.owner_preview`; a preview never holds a code),
    never with anything from its body. Every other entry has no title: a code, a checkpoint, an alert
    to a contact."""
    owner_alert = row.kind == "alert" and row.to == "owner"
    return DemoInboxEntry(entry_id=row.entry_id, to=row.to, kind=row.kind, body=row.body, created_at=row.created_at,
                          decision_id=row.decision_id, title=row.preview if owner_alert else None)


def session_entry(row: DemoInboxRow) -> DemoInboxEntry:
    """An entry as a session reads it: naming no decision, whatever the row holds, since the link to
    a held request is the owner's alone, and with no title, since the preview lines are English and
    a visitor's panel stays in their own language."""
    return DemoInboxEntry(entry_id=row.entry_id, to=row.to, kind=row.kind, body=row.body, created_at=row.created_at,
                          decision_id=None, title=None)


def _ordered(stmt):
    return stmt.order_by(DemoInboxRow.created_at, DemoInboxRow.entry_id)


async def session_entries(ctx: KernelCtx, session_row: ActorSession) -> list[DemoInboxEntry]:
    """The `verification_code` entries, on the session's Desk, of the challenges the session
    started, or an agent session opened with a key it minted started; nothing else, not even
    another session's code for the same person."""
    from desk.kernel_service import agents     # agents writes the ledger, which delivers here

    started_by = [session_row.session_id, *await agents.minted_sessions(ctx, session_row.session_id)]
    rows = await ctx.db.scalars(ctx.repo.scoped(_ordered(select(DemoInboxRow).join(
        VerificationChallenge, VerificationChallenge.challenge_id == DemoInboxRow.challenge_id).where(
        VerificationChallenge.session_id.in_(started_by), DemoInboxRow.desk_id == session_row.desk_id,
        DemoInboxRow.kind == "verification_code"))))
    return [session_entry(row) for row in rows]


async def owner_entries(ctx: KernelCtx) -> list[DemoInboxEntry]:
    """Every entry of the copy the context is bound to: codes, alerts and head checkpoints, each
    held request's alert naming its decision."""
    return [owner_entry(row) for row in await ctx.db.scalars(ctx.repo.scoped(_ordered(select(DemoInboxRow))))]
