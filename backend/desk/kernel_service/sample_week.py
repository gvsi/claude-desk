"""The sample week: hand-written past conversations written into a new hosted copy as finished history.

`seed.seed_sample_week` calls `write` from inside `POST /copies` (`copies.create_copy`), in the copy's transaction,
after the seed's cards are active and its held request is decided, only when the kernel's settings turn it on
(`SAMPLE_WEEK=1`) and the API asks (`replay_night`). It writes what Plan 01d's recorded night would have, through
the same output contract the API and the owner's screens already read, but from `seed.RIVERA_SAMPLE_WEEK`'s
written conversations instead of a recording:

- **Data, never decisions.** Nothing here decides, acts or checks: no adapter `normalize`, `execute` or
  `reconcile`, no `decide.decide_call`, no execution or approval route function, no reply-check `check_draft`, no
  model and no outbound HTTP. It uses the kernel's pure helpers alone: the quote adapter's `price` and
  `discounted` for amounts, `decide`'s own text functions (`_reason_plain`, `status_line`) and `sign_decision`,
  `render.render_clause` and `reply_check.sign_verdict`, `reply_check.scan_prose` (each reply's prose must pass),
  and `desks.next_open_window` and `desks.mask_contact`. Since no model ran, sample bookings and payment links,
  whose cards send them to the reviewer, carry a fixed reviewer result (`SAMPLE_REVIEW`) and no `review` ledger
  entry, which a live decision gets only for a reviewer call it made. An unverified document request mirrors
  the live path's early `not_given` refusal, with no action or deciding policy.
- **Terminal states only.** Sessions are closed at generation 0. Decisions are `executed`, `refused` or `denied`
  (the denied hold's approval row answered `deny_once` and used up). Quotes are `expired` or `paid`, their facts
  expired, the
  callback's handoff is `done` with its fact expired, and bookings are `confirmed` on past slots: a slot ID in
  the seed's form for a time before the copy was made, which is no `calendar_slots` row, so no live call can book
  it, and no owner calendar write is held up by it. Each booking decision is timed on its conversation's local
  date, so Today has no booking bar. The deposit conversation also books; its link and quote are paid, with a
  session-only charge fact, the live completion's paid ledger shape and a signed payment confirmation. The old
  completion marker cannot make a paid link actionable. No provider checkout, execution, reservation, mandate
  or Demo inbox entry is written. The paid sample contributes its marked amount to Reports. Refund normalization
  refuses a known charge with no verified record owner before provider access. The urgent callback's unscheduled
  handoff mirrors `request_callback.open_callback` and is done after 15 minutes, without an alert.
- **One archived sample person.** The invoice conversation alone is verified with assurance `demo_code` as a
  sample-only person from `seed.SAMPLE_CUSTOMER`. Its consumed, long-expired challenge has an empty hash, which
  cannot match a live six-digit code, and no failed attempts. Its verification entries are historical, with no
  delivery. The person is already removed from the live record, so verification's contact lookup cannot send
  them a fresh code. The invoice and released link facts are expired, labelled only for owner and that person;
  the document link is voided and expired. Other sessions are unverified, with owner/session-only facts. All
  session tokens are discarded. No sample names a seeded person; every word is in `seed.py`.
- **Marked history.** Every kernel event (including verification, link issuance/payment and callback handling)
  is one normal `ledger.append`, in sample-time order, hashed, chained and signed as usual, its summary carrying
  `replayed: {"at": <the sample moment>, "recording": <recording ID>}`. Each decision's `ledger_seq` is the entry
  that recorded its final state. A head checkpoint the appends call for is a real event, written unmarked by the
  ledger as always. Every time on a row is its sample moment.

Fixed conversations fall on local days 1 to 6 before `now`, at unambiguous wall times. The first three instead
start 180, 135 and 90 minutes before the copy's UTC instant, including across a clock change. If any relative
start crosses today's local midnight, all three use yesterday's fixed times. Every event stays at least an hour
before `now`; otherwise, or when anything can't be written, the caller rolls the week back whole.
Only the first three seed conversations fall in yesterday's 18:00-to-now briefing window: two answered alone
and one refused. The live seeded hold remains the only Needs-you item.
"""

import secrets
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import BaseModel
from sqlalchemy import select

from desk.contracts import (
    Claim,
    Clause,
    Fact,
    Label,
    LedgerEvent,
    NormalizedAction,
    RenderedBlock,
    ReplayedEvent,
    ReplyVerdict,
    ResourceRef,
    Review,
    ToolCall,
)
from desk.db.models import Action as ActionRow
from desk.db.models import (Approval, Booking, Business, Desk, Document, DocumentLink, Handoff, Lead, PaymentLink,
                            Person, Quote, VerificationChallenge)
from desk.db.models import Decision as DecisionRow
from desk.db.models import Fact as FactRow
from desk.kernel_api import DecideRequest
from desk.kernel_service import activation, adapters, auth, decide, desks, labels, ledger, render, reply_check, seed
from desk.kernel_service.adapters import quote as quotes
from desk.kernel_service.adapters import blocks, payment_link, release_document
from desk.kernel_service.adapters.capture_lead import lead_note
from desk.kernel_service.adapters.request_callback import window_claims
from desk.kernel_service.auth import SessionRow
from desk.kernel_service.clock import signed_time
from desk.kernel_service.render.cards import DeskInfo
from desk.kernel_service.repo import KernelCtx, new_id
from desk.kernel_service.sessions import principal_for

LANGUAGE = "en"
RUN_S = 2                                 # an allowed call runs this many seconds after it is decided
CLOSE_AFTER = timedelta(minutes=2)        # a sample session closes this long after its last event
QUIET_BEFORE_NOW = timedelta(hours=1)     # nothing sample happens in the hour before the copy is made
# What the reviewer said of sample bookings and payment links, whose cards require review.
SAMPLE_REVIEW = Review(within_charter_bp=9_600, manipulation_bp=150, recommendation="allow")
# The card that allows each sample tool, by tool; a booking's is its slot's day's (`_booking_card`).
ALLOWING_CARDS = {"native.quote": "rv-quote", "native.capture_lead": "preset-capture-lead",
                  "native.request_callback": "preset-request-callback", "native.release_document": "rv-docs",
                  "native.payment_link": "rv-link", "desk.emergency-callback": "rv-urgent"}
HOLDING_CARDS = {"native.quote": "rv-quote"}


class SampleWeekRefused(RuntimeError):
    """The sample week can't be written whole as the copy's history; the caller rolls it back."""


@dataclass
class _Desk:
    """What every sample conversation reads of the new copy's Desk once."""

    copy_id: str
    desk_row: Desk
    business: Business
    version_row: Any
    tools: dict[str, Any]
    tz: ZoneInfo
    now: datetime
    recording: str
    taken: set[str] = field(default_factory=set)       # the sample bookings' slots so far
    relative_today: bool = False

    @property
    def desk_id(self) -> str:
        return self.desk_row.desk_id

    @property
    def info(self) -> DeskInfo:
        return DeskInfo(owner_display_name=self.business.owner_display_name, timezone=self.business.timezone)

    @property
    def cap(self) -> int:
        return activation.version_cap(self.version_row)


@dataclass
class _Entry:
    """A ledger entry to append at its sample moment, then hand its seq to `done`."""

    at: datetime
    order: int
    kind: str
    session_id: str | None
    ref_id: str | None
    summary: dict[str, Any]
    done: Callable[[int], None] = lambda seq: None


@dataclass
class _Written:
    """What the week has written so far: rows to add, entries to append, events to return."""

    rows: list[Any] = field(default_factory=list)
    entries: list[_Entry] = field(default_factory=list)
    decisions: list[DecisionRow] = field(default_factory=list)
    finals: dict[str, datetime] = field(default_factory=dict)      # each decision's final moment
    replies: list[tuple[datetime, str, Callable[[], ReplyVerdict]]] = field(default_factory=list)
    said: list[tuple[datetime, str, str]] = field(default_factory=list)

    def entry(self, at: datetime, kind: str, session_id: str | None, ref_id: str | None, summary: dict[str, Any],
              done: Callable[[int], None] = lambda seq: None) -> None:
        self.entries.append(_Entry(at, len(self.entries), kind, session_id, ref_id, summary, done))


def moment(today: date, days_back: int, at: time, tz: ZoneInfo) -> datetime:
    """The instant of wall time `at` on the local date `days_back` days before `today`, in UTC. A wall time the
    clock change skips or repeats is refused, so each sample moment is one real instant."""
    local = datetime.combine(today - timedelta(days=days_back), at, tzinfo=tz)
    instant = local.astimezone(UTC)
    if (instant.astimezone(tz).replace(tzinfo=None) != local.replace(tzinfo=None)
            or local.replace(fold=1).utcoffset() != local.utcoffset()):
        raise SampleWeekRefused("clock_change")
    return instant


def past_slot(day: date, today: date, start: time, tz: ZoneInfo, taken: set[str]) -> tuple[str, datetime]:
    """A sample booking's slot, which no other sample booking has (`taken`, which it joins): on the first day after
    `day`, and before `today`, that the seed gives a free slot (`seed.SLOT_STARTS`), at `start` when that one is
    free and else at the day's first free start; its ID in the seed's form."""
    for offset in range(1, (today - day).days):
        slot_day = day + timedelta(days=offset)
        starts = seed.SLOT_STARTS.get(slot_day.weekday(), ())
        for chosen in sorted(starts, key=lambda at: at != start):
            starts_at = datetime.combine(slot_day, chosen, tzinfo=tz)
            slot_id = starts_at.strftime("S-%Y%m%d-%H%M")
            if slot_id not in taken:
                taken.add(slot_id)
                return slot_id, starts_at
    raise SampleWeekRefused("no_past_slot")


def _booking_card(starts_at: datetime, tz: ZoneInfo) -> str:
    return "rv-book-sat" if starts_at.astimezone(tz).weekday() == 5 else "rv-book-wk"


def _policy_id(desk: _Desk, kind: str, card_id: str) -> str:
    """The deciding policy of `card_id` in the copy's active version: its auto permit (`A.auto.<card>`) or its
    hold twin (`H.twin.<card>`), which must be there."""
    policy_id = f"A.auto.{card_id}" if kind == "allow" else f"H.twin.{card_id}"
    heads = decide.policy_heads(desk.version_row)
    if policy_id not in heads or heads[policy_id].cards != (card_id,):
        raise SampleWeekRefused("no_policy")
    return policy_id


def _marked(summary: dict[str, Any], at: datetime, recording: str) -> dict[str, Any]:
    return {**summary, "replayed": {"at": signed_time(at), "recording": recording}}


async def write(ctx: KernelCtx, copy_id: str, desk_id: str, now: datetime, sessions: list[seed.SampleSession],
                recording: str) -> list[ReplayedEvent]:
    """Write `sessions` into the copy's Desk as finished history (module docstring) in the caller's transaction,
    and return the events the API stores as their transcripts, in shown order."""
    now = now.astimezone(UTC)
    ctx.bind(copy_id)
    desk_row = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == desk_id)))).one()
    business = (await ctx.db.scalars(ctx.repo.scoped(
        select(Business).where(Business.business_id == desk_row.business_id)))).one()
    version_row = await activation.active_version(ctx, desk_id)
    if version_row is None:
        raise SampleWeekRefused("no_active_version")
    desk = _Desk(copy_id=copy_id, desk_row=desk_row, business=business, version_row=version_row,
                 tools=await decide.enabled_tools(ctx, desk_id), tz=ZoneInfo(business.timezone), now=now,
                 recording=recording)
    names = [desk_row.name, business.name]
    today = now.astimezone(desk.tz).date()
    desk.relative_today = all(
        (now - timedelta(minutes=sample.before_now_minutes)).astimezone(desk.tz).date() == today
        for sample in sessions if sample.before_now_minutes is not None)
    written = _Written()
    for sample in sessions:
        await _conversation(ctx, desk, sample, written, names)
    latest = max(entry.at for entry in written.entries)
    if latest > now - QUIET_BEFORE_NOW:
        raise SampleWeekRefused("too_recent")
    for entry in sorted(written.entries, key=lambda entry: (entry.at, entry.order)):
        appended = await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id, event=LedgerEvent(
            kind=entry.kind, origin="kernel", session_id=entry.session_id, ref_id=entry.ref_id,
            summary=_marked(entry.summary, entry.at, recording)))
        entry.done(appended.seq)
    for row in written.decisions:
        decide._sign(ctx, row)
    ctx.db.add_all(written.rows)
    await ctx.db.flush()
    events = [ReplayedEvent(session_id=session_id, shown_at=signed_time(at), kind="visitor_message", text=text,
                            verdict=None, decision=None) for at, session_id, text in written.said]
    events += [ReplayedEvent(session_id=session_id, shown_at=signed_time(at), kind="reply", text=None,
                             verdict=verdict(), decision=None) for at, session_id, verdict in written.replies]
    for row in written.decisions:
        events.append(ReplayedEvent(session_id=row.session_id, shown_at=signed_time(written.finals[row.decision_id]),
                                    kind="receipt", text=None, verdict=None,
                                    decision=await decide.decision_contract(ctx, row)))
    return sorted(events, key=lambda event: event.shown_at)


async def _conversation(ctx: KernelCtx, desk: _Desk, sample: seed.SampleSession, written: _Written,
                        names: list[str]) -> None:
    """One sample conversation's rows, entries and events (module docstring)."""
    today = desk.now.astimezone(desk.tz).date()
    if not 1 <= sample.days_back <= 6:
        raise SampleWeekRefused("outside_the_week")
    # Subtract from the UTC instant: a DST fold is then one known instant, not an ambiguous wall input.
    start = (desk.now - timedelta(minutes=sample.before_now_minutes)
             if sample.before_now_minutes is not None and desk.relative_today
             else moment(today, sample.days_back, sample.start, desk.tz))
    replied_at = start + timedelta(seconds=sample.reply_s)
    session = SessionRow(session_id=auth.new_session_id(), copy_id=desk.copy_id, desk_id=desk.desk_id, kind="visitor",
                         secret_hash=auth.hash_token(auth.new_token()), verified=False, assurance="none",
                         person_id=None, mode="ai", generation=0, strikes=0, preview=False, last_language=LANGUAGE,
                         created_at=start, last_seen_at=replied_at)
    written.rows.append(session)
    written.entry(start, "session", session.session_id, None, {"session_id": session.session_id, "kind": "visitor"})
    written.said.append((start, session.session_id, sample.said))
    facts: dict[str, Fact] = {}            # the facts the reply cites, by template, as the visitor saw them
    ends = [replied_at]
    for n, call in enumerate(sample.calls, start=1):
        ends.append(await _call(ctx, desk, sample, session, start, n, call, written, facts))
    session.closed_at = max(ends) + CLOSE_AFTER
    for row in written.rows:              # a quote, and its fact, expired as the conversation closed
        if (isinstance(row, Quote) or (isinstance(row, FactRow) and row.kind == "quote")) and (
                row.session_id == session.session_id):
            row.expires_at = session.closed_at
    _reply(ctx, desk, sample, session, replied_at, facts, written, names)


async def _call(ctx: KernelCtx, desk: _Desk, sample: seed.SampleSession, session: SessionRow, start: datetime,
                n: int, call: seed.SampleCall, written: _Written, facts: dict[str, Fact]) -> datetime:
    """One call's action, decision, side effects and entries; returns the moment it reached its final state."""
    at = start + timedelta(seconds=call.at_s)
    profile = desk.tools.get(call.tool)
    if profile is None:
        raise SampleWeekRefused("tool_not_enabled")
    adapter = (blocks.adapter_for(profile.profile.business, call.tool) if call.tool.startswith("desk.")
               else adapters.ADAPTERS[call.tool])
    raw, starts_at = _args(desk, sample, call)
    if call.tool == "native.payment_link" and call.outcome == "executed":
        raw["quote_id"] = facts["quote"].fact_id.removeprefix("quote:")
    if sample.verified_customer:
        raw["document_id"] = _verified_customer(ctx, desk, session, start, written)
    args = adapter.Args.model_validate(raw)
    tool_call = ToolCall(call_id=f"sample-{n}", tool=call.tool, args=args.model_dump(mode="json", exclude_none=True))
    request = DecideRequest(session_id=session.session_id, generation=0, call=tool_call)
    principal = principal_for(session)
    action = (None if call.outcome == "refused"
              else await _action(ctx, desk, session, call, args, profile, at, starts_at, written))
    sample_call = decide._Call(principal=principal, session_row=session, req=request,
                               call_sha256=decide.call_sha256(request), desk_row=desk.desk_row,
                               business=desk.business, subject=await decide._subject(ctx, principal),
                               version_row=desk.version_row, adapter=adapter, args=args, action=action,
                               quotes=decide.free_text(adapter, args))
    outcome = {"executed": "allow", "denied": "hold", "refused": "refuse"}[call.outcome]
    state = {"executed": "executed", "denied": "denied", "refused": "refused"}[call.outcome]
    evaluation = None if action is None else _evaluation(desk, outcome, call.tool, action)
    reason = ("not_given" if call.check == "not_given" else "adapter_refused") if action is None else None
    final_at = {"executed": at + timedelta(seconds=RUN_S), "refused": at,
                "denied": start + timedelta(seconds=call.answered_s or 0)}[call.outcome]
    if final_at < at:
        raise SampleWeekRefused("answered_before_asked")
    row = DecisionRow(
        decision_id=new_id("dec"), copy_id=desk.copy_id, desk_id=desk.desk_id, session_id=session.session_id,
        generation=0, call_id=tool_call.call_id, call_sha256=sample_call.call_sha256,
        tool=call.tool, effects=action.effects if action else [], outcome=outcome, state=state,
        answers=(decide.held_answers(principal, action, ask_held=False, auto_money_cap_cents=desk.cap)
                 if outcome == "hold" else []),
        allow_person_eligible=False, policy_version=desk.version_row.version,
        card_ids=evaluation.card_ids if evaluation else [], policy_ids=evaluation.policy_ids if evaluation else [],
        review=evaluation.review if evaluation else None,
        reason_plain=decide._reason_plain(sample_call, outcome, reason, evaluation),
        visitor_plain=decide.status_line(state, tool=call.tool, session=session,
                                         owner=desk.business.owner_display_name, business=profile.profile.business),
        owner_plain=None, expires_at=at + decide.LIFETIME[outcome], ledger_seq=0, created_at=at, updated_at=final_at,
        action_id=action.action_id if action else None)
    written.rows.append(row)
    written.decisions.append(row)
    written.finals[row.decision_id] = final_at

    def recorded(seq: int) -> None:
        row.ledger_seq = seq

    if action is None:
        written.entry(at, "decide", session.session_id, row.decision_id,
                      {"outcome": "refuse", "tool": ledger.safe_ref(call.tool), "reason": reason,
                       "policy_version": row.policy_version, "auto_money_cap_cents": desk.cap,
                       **({"check": ledger.safe_ref(call.check or "")} if reason == "adapter_refused" else {})}, recorded)
        return final_at
    written.entry(at, "decide", session.session_id, row.decision_id, {
        "decision_id": row.decision_id, "action_id": action.action_id, "tool": action.tool, "outcome": outcome,
        "card_ids": row.card_ids, "policy_version": row.policy_version, "auto_money_cap_cents": desk.cap,
        "reviewed": bool(evaluation and evaluation.needed_review)})
    if call.outcome == "denied":
        written.rows.append(Approval(approval_id=new_id("apr"), copy_id=desk.copy_id, decision_id=row.decision_id,
                                     answer="deny_once", policy_version=row.policy_version,
                                     expires_at=row.expires_at, created_at=final_at, consumed_at=final_at))
        written.entry(final_at, "approval", session.session_id, row.decision_id, {
            "decision_id": row.decision_id, "action_id": action.action_id, "answer": "deny_once",
            "state": "denied"}, recorded)
        return final_at
    written.entry(final_at, "execute", session.session_id, row.decision_id, {
        "decision_id": row.decision_id, "action_id": action.action_id, "state": "executed",
        "policy_version": row.policy_version, "auto_money_cap_cents": desk.cap}, recorded)
    await _effects(ctx, desk, sample, session, start, call, args, action, final_at, written, facts)
    return final_at


def _args(desk: _Desk, sample: seed.SampleSession, call: seed.SampleCall) -> tuple[dict[str, Any], datetime | None]:
    """The call's arguments, and a booking's slot start: its slot is the sample's own past one (`past_slot`)."""
    if call.tool != "native.book":
        return dict(call.args), None
    today = desk.now.astimezone(desk.tz).date()
    if sample.days_back < 3 or call.slot_start is None:
        raise SampleWeekRefused("booking_needs_a_past_slot")
    slot_id, starts_at = past_slot(today - timedelta(days=sample.days_back), today, call.slot_start, desk.tz,
                                   desk.taken)
    return {**call.args, "slot_id": slot_id}, starts_at


async def _action(ctx: KernelCtx, desk: _Desk, session: SessionRow, call: seed.SampleCall, args: BaseModel,
                  profile: Any, at: datetime, slot_starts_at: datetime | None, written: _Written) -> NormalizedAction:
    """The call's action as its adapter would resolve it, from the seed's own rows: a quote priced from the price
    list (`quotes.price`, `quotes.discounted`), a booking on its past slot, anything else on the Desk."""
    resource = ResourceRef(kind="desk", id=desk.desk_id, owner_person_id=None)
    list_cents = discount_bp = amount_cents = None
    starts_at = None
    if call.tool == "native.quote":
        _, list_cents = await quotes.price(ctx, desk.desk_id, args.items)
        discount_bp = args.requested_discount_bp
        amount_cents = quotes.discounted(list_cents, discount_bp)
    elif call.tool == "native.book":
        starts_at = slot_starts_at
        resource = ResourceRef(kind="slot", id=args.slot_id, owner_person_id=None)
    elif call.tool == "native.release_document":
        resource = ResourceRef(kind="document", id=args.document_id, owner_person_id=session.person_id)
    elif call.tool == "native.payment_link":
        quote = next(row for row in written.rows if isinstance(row, Quote) and row.quote_id == args.quote_id)
        amount_cents = quote.amount_cents
        resource = ResourceRef(kind="quote", id=quote.quote_id, owner_person_id=None)
    args_json = args.model_dump(mode="json", exclude_none=True)
    action = NormalizedAction(
        action_id=new_id("act"), copy_id=desk.copy_id, desk_id=desk.desk_id, session_id=session.session_id,
        generation=0, tool=call.tool, effects=profile.profile.effects, args_sha256=decide.args_sha256(args_json),
        profile_sha256=profile.profile_sha256, resource=resource, list_cents=list_cents, discount_bp=discount_bp,
        amount_cents=amount_cents, recipient="verified_contact" if call.tool == "native.release_document" else None,
        starts_at=starts_at)
    ctx.db.add(ActionRow(**action.model_dump(exclude={"resource"}), resource=action.resource,
                         resource_kind=action.resource.kind, args_json=args_json, created_at=at))
    return action


def _verified_customer(ctx: KernelCtx, desk: _Desk, session: SessionRow, start: datetime,
                       written: _Written) -> str:
    """Historical verification only: no usable code, no delivery, and no person still on record.

    Removal is the existing live verification barrier, rather than a new exception to verification.
    The document and release facts remain private and expired; the link is voided on removal.
    """
    if session.person_id is not None:
        raise SampleWeekRefused("duplicate_sample_verification")
    person_id, document_id, challenge_id = new_id("person"), new_id("document"), new_id("challenge")
    started, verified_at, archived = (start + timedelta(seconds=n) for n in (5, 45, 180))
    customer, invoice = seed.SAMPLE_CUSTOMER, seed.SAMPLE_INVOICE
    person = Person(person_id=person_id, copy_id=desk.copy_id, desk_id=desk.desk_id,
                    display_name=customer["name"], contact=customer["contact"], ref=customer["ref"],
                    contact_norm=desks.normalize_contact(customer["contact"]),
                    masked_contact=desks.mask_contact(customer["contact"]), created_at=start, removed_at=archived)
    document = Document(document_id=document_id, copy_id=desk.copy_id, desk_id=desk.desk_id,
                        title=invoice["title"], body=invoice["body"], ref=invoice["ref"],
                        record_owner_person_id=person_id, canary=new_id("canary"), created_at=start)
    fact = Fact(fact_id=f"document:{document_id}", kind="document", status="expired", source="kernel",
                claims=[Claim(key="title", kind="text", value=invoice["title"]),
                        Claim(key="ref", kind="ref", value=document_id)],
                label=Label(readers=["owner", f"person:{person_id}"], record_owner=person_id), expires_at=archived)
    ctx.db.add_all([person, document, labels.fact_row(desk.copy_id, desk.desk_id, fact, start)])
    written.rows.append(VerificationChallenge(
        challenge_id=challenge_id, copy_id=desk.copy_id, desk_id=desk.desk_id, session_id=session.session_id,
        person_id=person_id, code_hash="", status="consumed", failed_at=[], created_at=started,
        expires_at=started + timedelta(minutes=10)))
    session.person_id, session.verified, session.assurance = person_id, True, "demo_code"
    written.entry(start, "desk_data", session.session_id, None, {"part": "people", "refs": [person_id]})
    written.entry(started, "verify", session.session_id, None, {"outcome": "started", "challenge_id": challenge_id})
    written.entry(verified_at, "verify", session.session_id, None,
                  {"outcome": "verified", "challenge_id": challenge_id})
    written.entry(archived, "desk_data", session.session_id, None, {"part": "people", "refs": [person_id]})
    return document_id


def _evaluation(desk: _Desk, outcome: str, tool: str, action: NormalizedAction) -> decide.Evaluation:
    """How the copy's rules decided the call: the card that allows it (an auto permit), or the card whose hold
    twin held it, with the reviewer's answer when that card asks for one."""
    if outcome == "allow":
        card_id = (_booking_card(action.starts_at, desk.tz) if tool == "native.book" else ALLOWING_CARDS[tool])
    else:
        card_id = HOLDING_CARDS[tool]
    card = next((card for card in desk.version_row.cards if card.card_id == card_id), None)
    if card is None:
        raise SampleWeekRefused("no_card")
    reviewed = bool(card.review) and outcome == "allow"
    return decide.Evaluation(outcome, [_policy_id(desk, outcome, card_id)], [card_id],
                             SAMPLE_REVIEW if reviewed else None, None, strike=False, needed_review=reviewed)


async def _effects(ctx: KernelCtx, desk: _Desk, sample: seed.SampleSession, session: SessionRow, start: datetime,
                   call: seed.SampleCall, args: BaseModel, action: NormalizedAction, at: datetime, written: _Written,
                   facts: dict[str, Fact]) -> None:
    """What an executed call left: the rows and the session's fact its adapter writes, each at its sample moment and
    in its terminal state; the fact as the visitor saw it is kept for the reply's card."""
    label = Label(readers=["owner", f"session:{session.session_id}"])

    def keep(template: str, fact: Fact, stored_status: str, expires_at: datetime | None,
             created_at: datetime | None = None) -> None:
        facts[template] = fact
        written.rows.append(labels.fact_row(desk.copy_id, desk.desk_id, fact.model_copy(
            update={"status": stored_status, "expires_at": expires_at}), created_at or at, session_id=session.session_id,
            action_id=action.action_id))

    if call.tool == "native.quote":
        lines, _ = await quotes.price(ctx, desk.desk_id, args.items)
        quote_id = new_id("quote")
        good_until = at + quotes.QUOTE_TTL
        written.rows.append(Quote(quote_id=quote_id, copy_id=desk.copy_id, desk_id=desk.desk_id,
                                  session_id=session.session_id, items=lines, list_cents=action.list_cents,
                                  discount_bp=action.discount_bp, amount_cents=action.amount_cents, status="expired",
                                  expires_at=at, action_id=action.action_id, created_at=at))
        keep("quote", Fact(fact_id=f"quote:{quote_id}", kind="quote", status="available", source="kernel", claims=[
            Claim(key="items", kind="text", value=quotes.items_text(lines)),
            Claim(key="list", kind="money", value=action.list_cents),
            Claim(key="total", kind="money", value=action.amount_cents),
            Claim(key="discount", kind="percent_bp", value=action.discount_bp),
            Claim(key="expires", kind="datetime", value=good_until.astimezone(desk.tz).isoformat()),
        ], label=label, expires_at=good_until), "expired", at)
    elif call.tool == "native.book":
        booking_id = new_id("booking")
        written.rows.append(Booking(booking_id=booking_id, copy_id=desk.copy_id, desk_id=desk.desk_id,
                                    slot_id=action.resource.id, starts_at=action.starts_at, person_id=None,
                                    status="confirmed", action_id=action.action_id, session_id=session.session_id))
        keep("booking_confirmed", Fact(
            fact_id=f"booking:{booking_id}", kind="booking", status="committed", source="kernel",
            claims=[Claim(key="starts_at", kind="datetime", value=action.starts_at.astimezone(desk.tz).isoformat()),
                    Claim(key="minutes", kind="text", value=str(seed.SLOT_MINUTES)),
                    Claim(key="booking", kind="ref", value=booking_id)], label=label), "committed", None)
    elif call.tool == "native.capture_lead":
        written.rows.append(Lead(lead_id=new_id("lead"), copy_id=desk.copy_id, desk_id=desk.desk_id,
                                 session_id=session.session_id, display_name=args.name, note=lead_note(args),
                                 created_at=at))
    elif call.tool == "native.release_document":
        link_id, token = new_id("doclink"), secrets.token_urlsafe(32)
        archived = start + timedelta(seconds=180)
        expires = at + release_document.LINK_TTL
        written.rows.append(DocumentLink(
            link_id=link_id, copy_id=desk.copy_id, desk_id=desk.desk_id, document_id=action.resource.id,
            session_id=session.session_id, person_id=session.person_id, token=token,
            token_sha256=auth.hash_token(token), created_at=at, expires_at=expires, voided_at=archived))
        private = Label(readers=["owner", f"person:{session.person_id}"], record_owner=session.person_id)
        keep("document_link", Fact(
            fact_id=f"document_link:{link_id}", kind="document", status="available", source="kernel",
            claims=[Claim(key="title", kind="text", value=seed.SAMPLE_INVOICE["title"]),
                    Claim(key="ref", kind="ref", value=link_id)], label=private, expires_at=expires), "expired", archived)
        written.entry(at, "document_link", session.session_id, link_id,
                      {"link_id": link_id, "document_id": action.resource.id, "issued": True})
        written.entry(archived, "document_link", session.session_id, link_id, {"link_id": link_id, "voided": True})
    elif call.tool == "native.payment_link":
        quote = next(row for row in written.rows if isinstance(row, Quote) and row.quote_id == action.resource.id)
        link_id, token = new_id("paylink"), secrets.token_urlsafe(32)
        expires = at + payment_link.LINK_TTL
        if sample.paid_s is None:
            raise SampleWeekRefused("payment_unfinished")
        paid_at = start + timedelta(seconds=sample.paid_s)
        if paid_at <= max(at, start + timedelta(seconds=sample.reply_s)):
            raise SampleWeekRefused("payment_before_link")
        charge_id = new_id("samplecharge")
        quote.status = "paid"
        title = quotes.items_text(quote.items)
        written.rows.append(PaymentLink(
            link_id=link_id, copy_id=desk.copy_id, desk_id=desk.desk_id, session_id=session.session_id,
            quote_id=quote.quote_id, action_id=action.action_id, title=title, amount_cents=action.amount_cents,
            state="paid", token=token, token_sha256=auth.hash_token(token),
            provider_checkout_id=new_id("samplecheckout"), customer_id=f"session:{session.session_id}",
            completion_started_at=paid_at - timedelta(seconds=1),
            expires_at=expires, created_at=at, updated_at=paid_at))
        keep("payment_link", Fact(
            fact_id=f"payment_link:{link_id}", kind="payment_link", status="available", source="kernel",
            claims=[Claim(key="title", kind="text", value=title),
                    Claim(key="total", kind="money", value=action.amount_cents),
                    Claim(key="ref", kind="ref", value=link_id)], label=label, expires_at=expires), "expired", expires)
        keep("payment_confirmed", Fact(
            fact_id=f"charge:{charge_id}", kind="charge", status="committed", source="kernel",
            claims=[Claim(key="title", kind="text", value=title),
                    Claim(key="total", kind="money", value=action.amount_cents),
                    Claim(key="ref", kind="ref", value=link_id)], label=label), "committed", None, created_at=paid_at)
        written.entry(at, "payment", session.session_id, link_id,
                      {"link_id": link_id, "state": "issued", "version": desk.version_row.version})
        written.entry(paid_at, "payment", session.session_id, link_id, {
            "link_id": link_id, "state": "paid", "charge_id": charge_id,
            "policy_version": desk.version_row.version, "auto_money_cap_cents": desk.cap})
        _reply(ctx, desk, sample, session, paid_at + timedelta(seconds=1), facts, written,
               [desk.desk_row.name, desk.business.name], prose="", templates=("payment_confirmed",), author="desk")
    elif call.tool in {"native.request_callback", "desk.emergency-callback"}:
        urgent = call.tool == "desk.emergency-callback"
        window = None if urgent else desks.next_open_window(desk.desk_row.hours, desk.tz, at)
        if (window is None and not urgent) or sample.handled_s is None:
            raise SampleWeekRefused("callback_unhandled")
        window_start, window_end = window or (None, None)
        handled_at = start + timedelta(seconds=sample.handled_s)
        if window_start is not None:
            handled_at = max(handled_at, window_start + timedelta(minutes=10))
        handoff_id = new_id("handoff")
        written.rows.append(Handoff(
            handoff_id=handoff_id, copy_id=desk.copy_id, desk_id=desk.desk_id, session_id=session.session_id,
            reason=f"{args.name} · {args.contact} · {args.reason}",
            callback_window=f"{window_start.isoformat()}/{window_end.isoformat()}" if window else None,
            status="done", kind="callback",
            action_id=action.action_id, window_start=window_start, window_end=window_end, created_at=at))
        keep("callback_confirmed", Fact(fact_id=f"handoff:{handoff_id}", kind="handoff", status="committed",
                                        source="kernel", claims=window_claims(window), label=label,
                                        expires_at=window_end), "expired", handled_at)
        written.entry(handled_at, "desk_data", None, None, {"part": "handoffs", "refs": [handoff_id]})
    else:
        raise SampleWeekRefused("no_sample_effect")


def _reply(ctx: KernelCtx, desk: _Desk, sample: seed.SampleSession, session: SessionRow, at: datetime,
           facts: dict[str, Fact], written: _Written, names: list[str], *, prose: str | None = None,
           templates: tuple[str, ...] | None = None, author: str = "claude") -> None:
    """Claude's reply: its prose, which must pass the reply check's prose scan, then a card per template the sample
    names, rendered from the fact this conversation wrote; ledgered `reply` and signed at that entry."""
    prose = sample.prose if prose is None else prose
    templates = sample.cards if templates is None else templates
    if reply_check.scan_prose(prose, names=names, booking_card="booking_confirmed" in templates,
                              callback_card="callback_confirmed" in templates):
        raise SampleWeekRefused("prose_fails_the_scan")
    if any(template not in facts for template in templates):
        raise SampleWeekRefused("card_without_fact")

    def href(template: str) -> str | None:
        # This is the signed snapshot when issued, not a fresh citation of a now-expired link.
        if template not in {"document_link", "payment_link"}:
            return None
        link_id = next(claim.value for claim in facts[template].claims if claim.key == "ref")
        model = DocumentLink if template == "document_link" else PaymentLink
        link = next(row for row in written.rows if isinstance(row, model) and row.link_id == link_id)
        return f"/api/d/{link.token}" if template == "document_link" else f"/pay/{link.token}"

    cards = [render.render_clause(Clause(template=template, fact_id=facts[template].fact_id), facts[template],
                                  LANGUAGE, desk.info, href=href(template)) for template in templates]
    blocks = [*([RenderedBlock(kind="prose", text=prose)] if prose else []), *cards]
    fact_ids = [card.fact_id for card in cards]
    message_id = new_id("msg")
    visitor_plain = render.status("reply_checked", LANGUAGE, owner=desk.business.owner_display_name)
    sealed: dict[str, int] = {}

    def recorded(seq: int) -> None:
        sealed["seq"] = seq

    def verdict() -> ReplyVerdict:
        seq = sealed["seq"]
        return ReplyVerdict(ok=True, language=LANGUAGE, blocks=blocks, violations=[], message_id=message_id,
                            generation=0, visitor_plain=visitor_plain, ledger_seq=seq,
                            signature=reply_check.sign_verdict(ctx.signer, session_id=session.session_id,
                                                               generation=0, message_id=message_id, blocks=blocks,
                                                               visitor_plain=visitor_plain, ledger_seq=seq))

    written.entry(at, "reply", session.session_id, message_id, {
        "message_id": message_id, "author": author, "ok": True, "language": LANGUAGE, "violations": [],
        "rule_ids": [], "fact_ids": [ledger.safe_ref(fact_id) for fact_id in fact_ids], "soft_promise": None,
        "soft_checks": None, "dropped": [], "final": True}, recorded)
    written.replies.append((at, session.session_id, verdict))
