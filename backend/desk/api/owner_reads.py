"""The owner's read models (Plan 02a, "Read models" and Task 9): what needs the owner, conversations, Today's briefing
and last 7 days, and Safety's attempts; the reports (Plan 02b, Task 8); and the Desk list's unfinished setups (#233).

Every read is one copy's and one Desk's: kernel rows through the request's `KernelRO`, which reads only the copy the
owner's `WhoAmI` answer named, filtered by the path Desk, and the API's own rows filtered by that copy and Desk. The
route has already checked that the Desk is one of the copy's (`OwnerCtx.desk`). The Desk list's unfinished setups are
the one read across the copy's Desks: the API's own interview rows, filtered by that copy and its Desks. Only the
Desk's visitor and agent sessions count, the owner's previews among them; the owner's own session (its setup calls)
never does. Nothing here writes or commits. Reads are computed from the current rows, except final execution
refusal reasons: a bounded process-local cache avoids reading the same immutable kernel reason on each poll.

The unfinished-setup guard assumes no Desk is made outside setup between a start's boundary read and its create
call (the web never makes Desks outside setup), and the kernel's clock does not step backwards during a start.
An outside Desk in that gap can take the claim; a backwards clock can leave the start's own Desk reading live.
Identifying the exact Desk without those assumptions requires a kernel request tag on the Desk.

Names, notes, reasons and texts a visitor typed are passed on as they are (a conversation's glimpse of the visitor's
latest message only has its whitespace collapsed and its length cut: `visitor_line`), for the owner's screens to show
as untrusted text; nothing here reaches a visitor or a model.

Recorded history (Plan 01d): a copy may open on a night the kernel replayed into it. Today flags each section that
counts any of it, and the reports flag themselves when they do (`recorded_history`), from what the API's reads carry:
its own rows' `replay_id`, and ledger entries the kernel marked `summary.replayed`, which also mark the decisions they
record (a booking, a refusal; a decision whose entry can't be read counts as replayed, failing closed). Replayed rows
never count as needing the owner, so "needs you" is never flagged. A conversation, its transcript and a lead say
whether they are recorded history too (`replayed`, from `history_sessions`), so the owner's screens label them and
offer no take-over on them.
"""

import asyncio
import logging
from collections import Counter, OrderedDict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from desk.api.deps import OwnerCtx
from desk.api.kernel_client import KernelFailed, KernelUnavailable
from desk.api.ro import decision_replayed, replayed, ro_view, set_copy
from desk.api.schemas import (
    Attempt,
    Briefing,
    BriefingItem,
    BriefingList,
    BriefingNewest,
    ConversationSummary,
    Lead,
    DeskSetup,
    Handoff,
    NeedsYouItem,
    NeedsYouSession,
    RecordedHistory,
    RefusalCause,
    Reports,
    ThisWeek,
    Today,
    WeekDay,
)
from desk.api.setup import INTERVIEWS
from desk.api.sse import RUN_EVENTS
from desk.api.store import MESSAGES, WITH_EVENTS, newest_triage, triaged
from desk.contracts import Decision, DecisionState, is_business_tool


VISITOR_TEXT = ("visitor_text", "agent_text")      # what a visitor, or a visiting agent, wrote
OWNER_NOTES = ("triage", "annotation")              # what the API writes later for the owner: never activity
LIVE_FOR = timedelta(minutes=5)                    # Today's "Live now": activity this recent
VISITOR_LINE_MAX = 200                             # a conversation's glimpse of the visitor's words, in characters
BRIEFING_FROM = time(18)                           # "Since last night": from 18:00 yesterday
WEEK_DAYS = 7                                      # "Last 7 days": today and the six dates before it
KIND_ORDER = {"turned_down": 0, "booking": 1, "lead": 2, "answer": 3}
REFUSAL_CACHE_SIZE = 1024
# Exact final decision version -> (session, reason); the session is still checked on every cache hit.
_REFUSAL_REASONS: OrderedDict[tuple[str, int], tuple[str, str | None]] = OrderedDict()
# The owner's line for a reply of Claude's the checkpoint stopped, and why: by rule ID where one says more than its
# violation kind (a booking claim, which is a `promise_word`), else by the kind.
REPLY_STOPPED = "A reply was stopped before it was shown"
BOOKING_CLAIM = "it said a booking was made instead of showing the card"
REPLY_WHY_BY_RULE = {
    "lex.en.booking": BOOKING_CLAIM, "lex.es.booking": BOOKING_CLAIM,
    "soft.jev": "a second check flagged a promise the business's records don't back",
    # The owner's wording of 2026-11-01: chats render Markdown.
    "markdown.link": "it linked to a site the business's contact details don't name",
    "markdown.image": "it included an image",
    # Proposed wording awaiting the owner's sign-off.
    "policy_combined": "it cited a policy line the checkpoint now withholds",
    "soft.unavailable": "the checkpoint wasn't available",
    "soft.denies_ai": "it said it wasn't an AI",
}
REPLY_WHY = {
    "number_in_prose": "it wrote a number outside a checked card",
    "promise_word": "it made a promise the rules don't back",
    "soft_promise": "it made a promise the rules don't back",
    "unknown_fact": "it cited something the checkpoint doesn't know",
    "unentitled_fact": "it cited something this person may not see",
    "stale_fact": "it cited something out of date",
    "canary": "it quoted a private document",
    "unsupported_language": "it wasn't in English or Spanish",
    "check_unavailable": "the checkpoint wasn't available",
    "uncertain_language": "it didn't read clearly as English or Spanish",
}


def utc(moment: datetime) -> datetime:
    """An aware time in UTC, so times from any source compare and serialize alike."""
    if moment.tzinfo is None:
        raise ValueError("a time without a zone can't be placed")
    return moment.astimezone(UTC)


class People:
    """The Desk's visitor and agent sessions (the owner's session belongs to the copy, not to a Desk), and who each one
    is, for the owner: the verified person's display name, else the name the session's newest lead gave (untrusted),
    else None."""

    def __init__(self, sessions: Iterable[dict], people: Iterable[dict], leads: Iterable[dict]):
        self.sessions = {row["session_id"]: row for row in sessions}
        names = {row["person_id"]: row["display_name"] for row in people}
        self._verified = {session_id: names.get(row["person_id"]) for session_id, row in self.sessions.items()
                          if row["verified"] and row["person_id"] is not None}
        self._leads: dict[str, str] = {}
        for lead in sorted(leads, key=lambda row: (utc(row["created_at"]), row["lead_id"])):
            if lead["session_id"] is not None:
                self._leads[lead["session_id"]] = lead["display_name"]

    def name(self, session_id: str | None) -> str | None:
        if session_id is None:
            return None
        return self._verified.get(session_id) or self._leads.get(session_id)

    def brief(self, session_id: str) -> NeedsYouSession | None:
        row = self.sessions.get(session_id)
        if row is None:
            return None
        return NeedsYouSession(session_id=session_id, kind=row["kind"], display_name=self.name(session_id),
                               verified=row["verified"], assurance=row["assurance"])


async def people(ctx: OwnerCtx, desk_id: str) -> People:
    """The Desk's sessions, people and leads, read for their names."""
    return People(await ctx.ro.rows("sessions", desk_id=desk_id), await ctx.ro.rows("people", desk_id=desk_id),
                  await ctx.ro.rows("leads", desk_id=desk_id))


async def last_texts(ctx: OwnerCtx, desk_id: str, session_ids: Iterable[str],
                     kinds: tuple[str, ...] = VISITOR_TEXT) -> dict[str, str]:
    """What each session's visitor (or visiting agent) wrote last: its newest row of `kinds`, read for every session
    in one query."""
    wanted = sorted(set(session_ids))
    if not wanted:
        return {}
    newest = (select(func.max(MESSAGES.c.n))
              .where(MESSAGES.c.copy_id == ctx.copy_id, MESSAGES.c.desk_id == desk_id,
                     MESSAGES.c.session_id.in_(wanted), MESSAGES.c.kind.in_(kinds))
              .group_by(MESSAGES.c.session_id))
    rows = await ctx.ro.conn.execute(select(MESSAGES.c.session_id, MESSAGES.c.text).where(
        MESSAGES.c.copy_id == ctx.copy_id, MESSAGES.c.desk_id == desk_id, MESSAGES.c.n.in_(newest)))
    return dict(rows.all())


async def recent_texts(ctx: OwnerCtx, desk_id: str, session_ids: Iterable[str], count: int = 2,
                       kinds: tuple[str, ...] = VISITOR_TEXT) -> dict[str, list[str]]:
    """What each session's visitor (or visiting agent) wrote most recently: its newest `count` rows of `kinds`, oldest
    first, read for every session in one query."""
    wanted = sorted(set(session_ids))
    if not wanted:
        return {}
    ranked = (select(MESSAGES.c.session_id, MESSAGES.c.text, MESSAGES.c.n,
                     func.row_number().over(partition_by=MESSAGES.c.session_id,
                                            order_by=MESSAGES.c.n.desc()).label("newest"))
              .where(MESSAGES.c.copy_id == ctx.copy_id, MESSAGES.c.desk_id == desk_id,
                     MESSAGES.c.session_id.in_(wanted), MESSAGES.c.kind.in_(kinds))
              .subquery())
    rows = await ctx.ro.conn.execute(select(ranked.c.session_id, ranked.c.text)
                                     .where(ranked.c.newest <= count).order_by(ranked.c.session_id, ranked.c.n))
    found: dict[str, list[str]] = {}
    for session_id, text in rows:
        found.setdefault(session_id, []).append(text)
    return found


def visitor_lines(texts: Iterable[str | None]) -> str | None:
    """Several of a visitor's messages as one owner-facing line: each a glimpse (`visitor_line`), oldest first, joined
    with " · ", the separator a call-back note uses. None when nothing is left."""
    return " · ".join(line for text in texts if (line := visitor_line(text)) is not None) or None


def visitor_line(text: str | None) -> str | None:
    """A visitor's message as the owner's one-line glimpse of it: whitespace runs collapsed to single spaces and
    trimmed, and past `VISITOR_LINE_MAX` characters cut to the first 199, trimmed again, and "…". Nothing else is
    changed: it stays the visitor's untrusted text. None when nothing is left."""
    line = " ".join((text or "").split())
    if len(line) > VISITOR_LINE_MAX:
        return line[:VISITOR_LINE_MAX - 1].rstrip() + "…"
    return line or None


async def refusal_reason(ctx: OwnerCtx, decision_id: str, session_id: str, state: DecisionState,
                         ledger_seq: int) -> str | None:
    """Read the owner-only reason for a copy-scoped status, never from a visitor-readable stored row.

    Match the exact state and ledger entry being displayed, so a later read cannot annotate an older status.
    An unavailable or refused kernel read leaves the reason null and logs only the error type.
    Matching final reasons are cached for this process's life, up to 1,024 entries, evicting the least recently used;
    failures and mismatches are retried on later reads. The caller has already scoped the session or decision row
    to the owner's Desks.
    """
    if state != "refused_at_execution":
        return None
    key = (decision_id, ledger_seq)
    if key in _REFUSAL_REASONS:
        cached_session, reason = _REFUSAL_REASONS[key]
        if cached_session != session_id:
            return None
        _REFUSAL_REASONS.move_to_end(key)
        return reason
    try:
        decision = await ctx.kernel.call("GET /decisions/{id}", path={"id": decision_id})
    except (KernelFailed, KernelUnavailable) as error:
        logging.getLogger(__name__).warning("Owner refusal reason unavailable: %s", type(error).__name__)
        return None
    if (decision.decision_id, decision.session_id, decision.state, decision.ledger_seq) != (
            decision_id, session_id, state, ledger_seq):
        return None
    _REFUSAL_REASONS[key] = (session_id, decision.owner_plain)
    _REFUSAL_REASONS.move_to_end(key)
    if len(_REFUSAL_REASONS) > REFUSAL_CACHE_SIZE:
        _REFUSAL_REASONS.popitem(last=False)
    return decision.owner_plain


async def _held_by(ctx: OwnerCtx, desk_id: str, decisions: list[Decision]) -> dict[str, str | None]:
    """The reason of the rule card that held each decision: its first `card_ids` entry, in the policy version it was
    decided under (default cards included), by decision ID."""
    versions = sorted({decision.policy_version for decision in decisions})
    if not versions:
        return {}
    cards: dict[tuple[int, str], str] = {}
    for row in await ctx.ro.rows("policy_versions", desk_id=desk_id, version=versions):
        for card in row["cards"] or []:
            cards[(row["version"], card["card_id"])] = card["reason"]
    return {decision.decision_id: cards.get((decision.policy_version, decision.card_ids[0]))
            if decision.card_ids else None for decision in decisions}


async def needs_you(ctx: OwnerCtx, desk_id: str) -> list[NeedsYouItem]:
    """The Desk's held requests, each read from the kernel with the owner's credential (which applies expiry, so a
    request that expired meanwhile drops out), oldest first, then its open handoffs, call-back requests and the handoff
    card's, each with its kind. A card's handoff has no action: its kernel row's `action_id`, which no view shows,
    names the handoff itself."""
    who = await people(ctx, desk_id)
    held_rows = [row for row in await ctx.ro.rows("decisions", desk_id=desk_id, state="held",
                                                  order_by=("created_at", "decision_id"))
                 if row["session_id"] in who.sessions]
    read = await asyncio.gather(*(ctx.kernel.call("GET /decisions/{id}", path={"id": row["decision_id"]})
                                  for row in held_rows))
    held = [(row, decision) for row, decision in zip(held_rows, read, strict=True)
            if decision.state == "held" and decision.decision_id == row["decision_id"]]
    handoffs = [row for row in await ctx.ro.rows("handoffs", desk_id=desk_id, status="open", order_by=("handoff_id",))
                if row["session_id"] in who.sessions]
    asked = [decision.session_id for _, decision in held] + [row["session_id"] for row in handoffs]
    texts = {session_id: visitor_lines(said) for session_id, said in (await recent_texts(ctx, desk_id, asked)).items()}
    # AI-written triage never sits beside an approval it could sway: only a handoff gets one, which asks the owner
    # for no decision, and not while the same session has a held request awaiting them.
    waiting = {decision.session_id for _, decision in held}
    handed = [row["session_id"] for row in handoffs if row["session_id"] not in waiting]
    summaries = {session_id: triage.summary
                 for session_id, triage in (await newest_triage(ctx.ro.conn, ctx.copy_id, desk_id, handed)).items()}
    held_by = await _held_by(ctx, desk_id, [decision for _, decision in held])
    items = []
    for row, decision in held:
        if (session := who.brief(decision.session_id)) is not None:
            items.append(NeedsYouItem(decision=decision, held_by=held_by[decision.decision_id],
                                      held_at=utc(row["created_at"]), handoff=None, session=session,
                                      from_the_visitor=texts.get(decision.session_id), claude_summary=None))
    for row in handoffs:
        if (session := who.brief(row["session_id"])) is not None:
            handoff = Handoff(handoff_id=row["handoff_id"], session_id=row["session_id"], reason=row["reason"],
                              callback_window=row["callback_window"], status=row["status"], kind=row["kind"])
            items.append(NeedsYouItem(decision=None, held_by=None, held_at=None, handoff=handoff, session=session,
                                      from_the_visitor=texts.get(row["session_id"]),
                                      claude_summary=summaries.get(row["session_id"])))
    return items


# Today's windows (Task 9) -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Windows:
    """Today's windows in the business's time zone, each edge taken from its own local date (so a daylight-saving
    change moves no row) and held in UTC: the briefing runs from `since` (18:00 yesterday) to `now`, the week from
    `start` (00:00 on the first of `dates`) to `now`."""

    zone: ZoneInfo
    now: datetime
    since: datetime
    start: datetime
    dates: tuple[date, ...]                    # the seven local dates, oldest first, the last one today

    def local_date(self, moment: datetime) -> date:
        return moment.astimezone(self.zone).date()


def windows(now: datetime, timezone: str) -> Windows:
    zone = ZoneInfo(timezone)
    now = utc(now)
    today = now.astimezone(zone).date()
    dates = tuple(today - timedelta(days=back) for back in range(WEEK_DAYS - 1, -1, -1))

    def local(day: date, at: time) -> datetime:
        return datetime.combine(day, at, tzinfo=zone).astimezone(UTC)

    return Windows(zone=zone, now=now, since=local(today - timedelta(days=1), BRIEFING_FROM),
                   start=local(dates[0], time(0)), dates=dates)


def entry_time(entry: dict) -> datetime:
    """When a ledger entry happened: its `event.summary.replayed.at` when present (a replayed entry's recorded time),
    else its `created_at`."""
    summary = (entry["event"] or {}).get("summary") or {}
    replayed = summary.get("replayed")
    if isinstance(replayed, dict) and isinstance(replayed.get("at"), str):
        try:
            return utc(datetime.fromisoformat(replayed["at"]))
        except ValueError:
            pass
    return utc(datetime.fromisoformat(entry["created_at"]))


@dataclass(frozen=True)
class Timed:
    """Something that happened in a session at a time: a booking, a lead, a hold, a callback, an attempt."""

    at: datetime
    session_id: str | None
    ref_id: str
    line: str | None = None
    replayed: bool = False                     # recorded history, replayed into the copy (module docstring)


@dataclass(frozen=True)
class Stopped(Timed):
    """An attempt the checkpoint stopped: a refused decision, or a reply of Claude's it blocked."""

    kind: Literal["refused", "reply_blocked"] = "refused"
    reason_plain: str = ""
    card_ids: tuple[str, ...] = ()
    origin: Literal["kernel", "api"] = "kernel"
    ledger_seq: int = 0
    cause: RefusalCause | None = None


REFUSAL_REASONS: dict[str, RefusalCause] = {
    "paused": "paused", "unknown_tool": "tool_not_available", "not_given": "tool_not_available",
    "invalid_args": "incomplete_request", "no_active_version": "no_rules",
    "version_unloadable": "rules_unchecked", "version_outdated": "rules_unchecked",
    "evaluation_error": "rules_unchecked",
}
REFUSAL_CHECKS: dict[str, RefusalCause] = {
    "answer_count": "incomplete_request",  # Intake needs one answer per configured question at normalization.
    "note_canary": "incomplete_request",  # A booking note holding private document text is refused at normalization.
    "no_such_slot": "no_such_slot", "unknown_item": "unknown_item", "over_limit": "over_quote_ceiling",
    "no_such_quote": "quote_unpayable", "quote_paid": "quote_unpayable", "quote_paying": "quote_unpayable",
    "no_such_charge": "no_such_charge", "not_refundable": "not_refundable",
    "no_such_document": "no_such_document",
}
# In precedence order, after any owner never card. The private-data cause depends on session verification.
BASELINE_CAUSES: dict[str, RefusalCause] = {
    "B.same_copy": "other_copy", "B.private_data_record_owner": "not_verified",
    "B.recipient_owner_or_verified_contact": "recipient", "B.no_agent_pay_out": "agent_pay_out",
    "B.agent_charge_within_mandate": "agent_limit", "B.money_has_amount": "no_amount",
}


def refusal_cause(row: dict, entry: dict | None, *, verified: bool) -> RefusalCause | None:
    """A refused decision's cause, from its row and the already-read kernel-built `decide` entry.

    Exact codes only; never inspect or echo owner/visitor prose. Early `reason` wins, including an unknown one.
    For evaluated refusals, take the first match in the policy precedence below, regardless of the IDs' row order.
    Unknown codes/IDs and a missing, malformed or mismatched entry have no label. A valid entry has a `decide`
    event with matching `ref_id` and `session_id`, a dict summary with outcome `refuse`, and a matching summary
    decision ID when present. Early refusals omit the summary decision ID, so the event reference is required.
    The web holds the labels.

    Source                                           Cause                 Signed label
    reason: paused                                   paused                The chat was paused
    reason: unknown_tool, not_given                  tool_not_available    Not a tool this chat can use
    reason: invalid_args                             incomplete_request    The request wasn't in a form I can use
    reason: no_active_version                        no_rules              No rules turned on yet
    reason: version_unloadable, version_outdated,
            evaluation_error                         rules_unchecked       Your rules couldn't be checked, so I said no
    reason: adapter_refused, by check:
      no_such_slot                                   no_such_slot          That time isn't open
      unknown_item                                   unknown_item          Not on the price list
      over_limit                                     over_quote_ceiling    Over the $10,000 quote ceiling
      no_such_quote, quote_paid, quote_paying         quote_unpayable       That quote can't be paid now
      no_such_charge                                 no_such_charge        Couldn't find that payment
      not_refundable                                 not_refundable        That payment can't be refunded
      no_such_document                               no_such_document      No such document
      answer_count, note_canary                      incomplete_request    The request wasn't in a form I can use
      not_verified, no_mandate, mandate_exhausted,
      not_an_agent_with_a_mandate (unreachable),
      search_limit (execution only)                   null                  (no label)
    policy precedence:
      F.never.*                                      owner_rule            Your rule says no
      B.same_copy                                    other_copy            Not a record on this Desk
      B.private_data_record_owner, unverified        not_verified          Not verified yet
      B.private_data_record_owner, verified          not_their_record      Only for the person it belongs to
      B.recipient_owner_or_verified_contact          recipient             Only to you or a contact on record
      B.no_agent_pay_out                             agent_pay_out         Agents can't send money out
      B.agent_charge_within_mandate                  agent_limit           Outside the agent's spending limit
      B.money_has_amount                             no_amount             Not a valid amount
    no reason, empty policy_ids and card_ids         no_rule               No rule covers this yet
    anything else                                    null                  (no label)
    """
    if entry is None:
        return None
    event = entry.get("event")
    if not isinstance(event, dict) or event.get("kind") != "decide":
        return None
    if event.get("ref_id") != row["decision_id"] or event.get("session_id") != row["session_id"]:
        return None
    summary = event.get("summary")
    if not isinstance(summary, dict) or summary.get("outcome") != "refuse":
        return None
    if "decision_id" in summary and summary["decision_id"] != row["decision_id"]:
        return None
    if any(key in summary and not isinstance(summary[key], str) for key in ("reason", "check")):
        return None
    if "reason" in summary:
        if summary["reason"] == "adapter_refused":
            return REFUSAL_CHECKS.get(summary.get("check"))
        return REFUSAL_REASONS.get(summary["reason"])
    policies = row["policy_ids"]
    if any(policy.startswith("F.never.") for policy in policies):
        return "owner_rule"
    for policy, cause in BASELINE_CAUSES.items():
        if policy in policies:
            # tools_given gives private-data tools only after verification; an unverified caller gets
            # not_given before evaluation. Verification binds a person once and never clears/rebinds them,
            # so a historical private-data refusal cannot predate that binding. Reading verified in the same
            # snapshot as the decision is safe: this verified person's refusal means another person's record.
            if policy == "B.private_data_record_owner" and verified:
                return "not_their_record"
            return cause
    return None if policies or row["card_ids"] else "no_rule"


def reply_violations(summary: dict) -> list[tuple[str, str | None]]:
    """A `reply` ledger entry's violations as (kind, rule ID) pairs, read from its summary's `violations` and, beside
    them one for one, `rule_ids`, as the kernel writes them. Rule IDs that don't line up with the kinds (missing, or
    another count) name none of them, so no kind is ever given another's rule."""
    kinds = list(summary.get("violations") or [])
    rule_ids = summary.get("rule_ids")
    if not isinstance(rule_ids, list) or len(rule_ids) != len(kinds):
        rule_ids = [None] * len(kinds)
    return [(kind, rule_id if isinstance(rule_id, str) else None)
            for kind, rule_id in zip(kinds, rule_ids, strict=True) if isinstance(kind, str)]


def reply_reason(violations: Iterable[tuple[str, str | None]]) -> str:
    """The owner's line for a blocked reply of Claude's, from its violations: each one's rule ID's line, else its
    kind's. When both promise checkers block, the owner reads the model check's line alone (owner decision,
    2026-10-31)."""
    violations = list(violations)
    if any(rule_id == "soft.promise" for _, rule_id in violations):
        violations = [(kind, rule_id) for kind, rule_id in violations if rule_id != "soft.jev"]
    why = list(dict.fromkeys(line for kind, rule_id in violations
                             if (line := REPLY_WHY_BY_RULE.get(rule_id or "") or REPLY_WHY.get(kind))))
    return f"{REPLY_STOPPED}, because {' and '.join(why)}." if why else f"{REPLY_STOPPED}."


@dataclass(frozen=True)
class Activity:
    """What happened on a Desk, each thing timed as Today's windows say: kernel rows at their `created_at`, ledger
    entries at `entry_time`, the API's transcript rows at their `created_at`."""

    people: People
    bookings: list[Timed]                      # native.book or a typed_booking block executed, at its ledger entry
    booked: dict[str, int]                     # each booking's amount, by its decision ID (`booked_amounts`)
    leads: list[Timed]
    stopped: list[Stopped]
    holds: list[Timed]                         # decisions with outcome hold
    callbacks: list[Timed]                     # native.request_callback or an urgent block executed, at its ledger entry
    stepped: list[Timed]                       # the owner stepping into a session
    texts: list[Timed]                         # visitor and agent text rows
    replies: list[Timed]                       # Claude's delivered events whose handoff flag is false
    handoffs: list[Timed]                      # Claude's delivered events whose handoff flag is true


def _stopped_attempts(decisions: list[dict], ledger: list[dict], sessions: dict[str, dict]) -> list[Stopped]:
    """Stopped attempts in `sessions` (the Desk's visitor and agent sessions): a decision refused when decided
    (`outcome = "refuse"`, at its `created_at`), or a `reply` entry of Claude's with a violation other than
    `session_paused`. A refusal at execution, a denial, an expiry, an owner's say and a paused chat's handoff aren't
    attempts. A refusal is recorded history as on its tool's page (`decision_replayed`, failing closed)."""
    entries = {entry["seq"]: entry for entry in ledger}
    found = []
    for row in decisions:
        if row["outcome"] != "refuse" or row["session_id"] not in sessions:
            continue
        entry = entries.get(row["ledger_seq"])
        event = entry.get("event") if entry else None
        origin = event.get("origin", "kernel") if isinstance(event, dict) else "kernel"
        found.append(Stopped(at=utc(row["created_at"]), session_id=row["session_id"], ref_id=row["decision_id"],
                             line=row["reason_plain"], replayed=decision_replayed(row, entry), kind="refused",
                             reason_plain=row["reason_plain"], card_ids=tuple(row["card_ids"] or ()), origin=origin,
                             ledger_seq=row["ledger_seq"],
                             cause=refusal_cause(row, entry, verified=sessions[row["session_id"]]["verified"])))
    for entry in ledger:
        event = entry.get("event")
        if not isinstance(event, dict) or not isinstance(event.get("summary"), dict):
            continue
        summary = event["summary"]
        if event.get("kind") != "reply" or summary.get("author") != "claude" or event.get("session_id") not in sessions:
            continue
        violations = reply_violations(summary)
        if not [kind for kind, _ in violations if kind != "session_paused"]:
            continue
        found.append(Stopped(at=entry_time(entry), session_id=event.get("session_id"), ref_id=str(entry["seq"]),
                             line=None, replayed=replayed(entry), kind="reply_blocked",
                             reason_plain=reply_reason(violations), origin=event.get("origin", "kernel"),
                             ledger_seq=entry["seq"]))
    return found


def from_price_list(quote: dict) -> bool:
    """Whether a quote was priced from the Desk's price list, not written by a business tool: a purpose payment's
    quote record names its tool (`desk.<name>`) as its line's item, which no price list item can (`ITEM_ID_PATTERN`
    has no dot)."""
    return not any(is_business_tool(line["item_id"]) for line in quote["items"])


def booked_amounts(bookings: Iterable[Timed], quotes: Iterable[dict]) -> dict[str, int]:
    """What each booking was booked for, by its decision ID. Taking the bookings in time order, each takes the newest
    quote of its session made at or before it (the latest `created_at`, then the greatest `quote_id`) that no earlier
    booking took, and is booked for its `amount_cents`; with none it is booked for 0, so a quote backs at most one
    booking. A quote with no `created_at` can't be placed before a booking and backs none, nor does a purpose
    payment's quote record, such as a deposit's (`from_price_list`)."""
    by_session: dict[str, list[dict]] = {}
    for quote in quotes:
        if quote["created_at"] is not None and quote["session_id"] is not None and from_price_list(quote):
            by_session.setdefault(quote["session_id"], []).append(quote)
    taken: set[str] = set()
    amounts: dict[str, int] = {}
    for booking in sorted(bookings, key=lambda booking: (booking.at, booking.ref_id)):
        made = [quote for quote in by_session.get(booking.session_id, ())
                if quote["quote_id"] not in taken and utc(quote["created_at"]) <= booking.at]
        newest = max(made, key=lambda quote: (utc(quote["created_at"]), quote["quote_id"]), default=None)
        if newest is not None:
            taken.add(newest["quote_id"])
        amounts[booking.ref_id] = newest["amount_cents"] if newest is not None else 0
    return amounts


STEPPED_KINDS = ("approval", "takeover", "whisper", "breaker")


def _stepped_in(decisions: list[dict], ledger: list[dict]) -> list[Timed]:
    """Ledger entries of the owner stepping into a session: an `approval` (not for a decision now `cancelled`: a
    visitor's own cancel isn't the owner's), a `takeover`, a `whisper`, or a `breaker` resuming a paused chat. An entry
    names its session, or for an approval its decision does."""
    by_id = {row["decision_id"]: row for row in decisions}
    found = []
    for entry in ledger:
        event = entry["event"] or {}
        kind, summary = event.get("kind"), event.get("summary") or {}
        if kind not in STEPPED_KINDS or (kind == "breaker" and not summary.get("resumed")):
            continue
        session_id = event.get("session_id")
        if kind == "approval":
            decision = by_id.get(event.get("ref_id") or summary.get("decision_id"))
            if decision is not None and decision["state"] == "cancelled":
                continue
            session_id = session_id or (decision["session_id"] if decision else None)
        if session_id is not None:
            found.append(Timed(at=entry_time(entry), session_id=session_id, ref_id=str(entry["seq"]),
                               replayed=replayed(entry)))
    return found


async def activity(ctx: OwnerCtx, desk_id: str, start: datetime) -> Activity:
    """The Desk's activity in its visitor and agent sessions, their transcript rows from `start` on. Decisions are read
    before the ledger, so every decision's entry is there. A business tool's run counts under its tool's current block
    (wish #465 tracks recording the block each run used)."""
    who = await people(ctx, desk_id)
    leads = [row for row in await ctx.ro.rows("leads", desk_id=desk_id)
             if row["session_id"] is None or row["session_id"] in who.sessions]
    decisions = [row for row in await ctx.ro.rows("decisions", desk_id=desk_id) if row["session_id"] in who.sessions]
    ledger = await ctx.ro.rows("ledger_entries", desk_id=desk_id, order_by=("seq",))
    entries = {entry["seq"]: entry for entry in ledger}
    quotes = [row for row in await ctx.ro.rows("quotes", desk_id=desk_id) if row["session_id"] in who.sessions]
    tools_by_block = {"urgent": {"native.request_callback"}, "typed_booking": {"native.book"}}
    for row in await ctx.ro.rows("tools", desk_id=desk_id, source="business"):
        business = row["business"]
        config = business.get("config") if isinstance(business, dict) else None
        block = config.get("block") if isinstance(config, dict) else None
        if isinstance(block, str) and block in tools_by_block:
            tools_by_block[block].add(row["tool"])

    def executed(tools: set[str]) -> list[Timed]:
        return [Timed(at=entry_time(entry), session_id=row["session_id"], ref_id=row["decision_id"],
                      line=row["reason_plain"], replayed=decision_replayed(row, entry))
                for row in decisions if row["tool"] in tools and row["state"] == "executed"
                and (entry := entries.get(row["ledger_seq"])) is not None]

    rows = await ctx.ro.conn.execute(
        select(MESSAGES.c.n, MESSAGES.c.session_id, MESSAGES.c.kind, MESSAGES.c.author,
               RUN_EVENTS.c.payload["handoff"].as_boolean().label("handoff"),
               MESSAGES.c.created_at, MESSAGES.c.replay_id)
        .select_from(WITH_EVENTS)
        .where(MESSAGES.c.copy_id == ctx.copy_id, MESSAGES.c.desk_id == desk_id, MESSAGES.c.created_at >= start,
               MESSAGES.c.kind.in_((*VISITOR_TEXT, "delivered", "owner_say", "whisper")))
        .order_by(MESSAGES.c.n))
    texts, replies, handoffs, stepped = [], [], [], _stepped_in(decisions, ledger)
    for row in rows:
        if row.session_id not in who.sessions:
            continue
        at = Timed(at=utc(row.created_at), session_id=row.session_id, ref_id=str(row.n),
                   replayed=row.replay_id is not None)
        if row.kind in VISITOR_TEXT:
            texts.append(at)
        elif row.author == "owner":
            stepped.append(at)                         # a say, a whisper, or a say delivered
        elif row.kind == "delivered" and row.author == "claude":
            if row.handoff:
                handoffs.append(at)
            else:
                replies.append(at)
    bookings = executed(tools_by_block["typed_booking"])
    return Activity(
        people=who, bookings=bookings, booked=booked_amounts(bookings, quotes),
        callbacks=executed(tools_by_block["urgent"]),
        leads=[Timed(at=utc(row["created_at"]), session_id=row["session_id"], ref_id=row["lead_id"], line=row["note"])
               for row in leads],
        stopped=_stopped_attempts(decisions, ledger, who.sessions),
        holds=[Timed(at=utc(row["created_at"]), session_id=row["session_id"], ref_id=row["decision_id"])
               for row in decisions if row["outcome"] == "hold"],
        stepped=stepped, texts=texts, replies=replies, handoffs=handoffs)


def _within(things: Iterable[Timed], start: datetime, end: datetime) -> list[Timed]:
    return [thing for thing in things if start <= thing.at <= end]


def _sessions(things: Iterable[Timed]) -> set[str]:
    return {thing.session_id for thing in things if thing.session_id is not None}


def _newest_first(items: list[BriefingItem]) -> list[BriefingItem]:
    """By `at`, newest first, then by kind (turned_down, booking, lead, answer), then by `ref_id` descending."""
    items = sorted(items, key=lambda item: item.ref_id, reverse=True)
    items.sort(key=lambda item: KIND_ORDER[item.kind])
    items.sort(key=lambda item: item.at, reverse=True)
    return items


@dataclass(frozen=True)
class Counted:
    """What the briefing from `start` to `end` counts: the refused requests, bookings and leads, the conversations'
    text rows, and each conversation Claude answered alone (a delivered event with no handoff flag, and no
    booking, lead, hold, refused request, callback or delivered handoff) at its newest such reply, by session.
    Stopped drafts do not make a conversation busy."""

    stopped: list[Stopped]
    bookings: list[Timed]
    leads: list[Timed]
    texts: list[Timed]
    answers: dict[str, Timed]


def briefing_counts(done: Activity, start: datetime, end: datetime) -> Counted:
    stopped = [attempt for attempt in _within(done.stopped, start, end) if attempt.kind == "refused"]
    bookings, leads = _within(done.bookings, start, end), _within(done.leads, start, end)
    busy = _sessions([*stopped, *bookings, *leads, *_within(done.holds, start, end),
                      *_within(done.callbacks, start, end), *_within(done.handoffs, start, end)])
    texts = _within(done.texts, start, end)
    conversations = _sessions(texts)
    newest: dict[str, Timed] = {}
    for reply in _within(done.replies, start, end):
        if reply.session_id in conversations and reply.session_id not in busy:
            if reply.session_id not in newest or reply.at >= newest[reply.session_id].at:
                newest[reply.session_id] = reply
    return Counted(stopped=stopped, bookings=bookings, leads=leads, texts=texts, answers=newest)


def briefing_items(done: Activity, start: datetime, end: datetime) -> list[BriefingItem]:
    """Every briefing item from `start` to `end`, newest first: each refused request, booking and lead, and each
    conversation Claude answered alone, at its newest such reply (`briefing_counts`)."""
    who = done.people

    def item(kind: str, thing: Timed, ref_id: str | None = None, line: str | None = None,
             cause: RefusalCause | None = None) -> BriefingItem:
        return BriefingItem(kind=kind, at=thing.at, session_id=thing.session_id,
                            display_name=who.name(thing.session_id), ref_id=ref_id or thing.ref_id, line=line, cause=cause)

    counted = briefing_counts(done, start, end)
    items = [item("turned_down", attempt, line=attempt.line, cause=attempt.cause) for attempt in counted.stopped]
    items += [item("booking", booking, line=booking.line) for booking in counted.bookings]
    items += [item("lead", lead, line=lead.line) for lead in counted.leads]
    items += [item("answer", reply, ref_id=session_id) for session_id, reply in counted.answers.items()]
    return _newest_first(items)


def briefing(done: Activity, frame: Windows) -> Briefing:
    items = briefing_items(done, frame.since, frame.now)

    def first(*kinds: str) -> BriefingItem | None:
        return next((item for item in items if item.kind in kinds), None)

    return Briefing(
        since=frame.since, conversations=len(_sessions(_within(done.texts, frame.since, frame.now))),
        bookings=sum(item.kind == "booking" for item in items), leads=sum(item.kind == "lead" for item in items),
        turned_down=sum(item.kind == "turned_down" for item in items),
        answers=sum(item.kind == "answer" for item in items), total=len(items),
        newest=BriefingNewest(turned_down=first("turned_down"), booking=first("booking"),
                              lead_or_answer=first("lead", "answer")))


@dataclass(frozen=True)
class WeekCounted:
    """What a span of days counts from `start` to `end`, Today's last 7 days and the reports alike: the conversations'
    text rows, the bookings, the requests the kernel refused, and the owner stepping into those conversations; and
    from them, how many conversations there were, how many the owner stepped into and how many Claude handled alone.
    `stopped` holds the refused requests only: a draft of Claude's the reply check stopped is no attempt anyone made,
    so it is listed on Safety but omitted from the briefing and never counted here."""

    texts: list[Timed]
    bookings: list[Timed]
    stopped: list[Stopped]
    stepped: list[Timed]

    @property
    def conversations(self) -> int:
        """The conversations with a text row in the span."""
        return len(_sessions(self.texts))

    @property
    def stepped_in(self) -> int:
        """The conversations the owner stepped into in the span (`stepped` holds the span's conversations only)."""
        return len(_sessions(self.stepped))

    @property
    def handled(self) -> int:
        """The conversations Claude handled alone: every one the owner didn't step into."""
        return self.conversations - self.stepped_in


def week_counts(done: Activity, start: datetime, end: datetime) -> WeekCounted:
    """The one count of a span of days, so the last 7 days and the reports can't drift apart."""
    texts = _within(done.texts, start, end)
    conversations = _sessions(texts)
    return WeekCounted(texts=texts, bookings=_within(done.bookings, start, end),
                       stopped=[attempt for attempt in _within(done.stopped, start, end) if attempt.kind == "refused"],
                       stepped=[thing for thing in _within(done.stepped, start, end)
                                if thing.session_id in conversations])


def this_week(done: Activity, frame: Windows) -> ThisWeek:
    """The last 7 days: totals from `start` to now, and each local date's conversations, bookings and refused
    requests (`week_counts`). A conversation the owner stepped into (inside the window) isn't one Claude handled.
    Each booking's amount is taken over all the Desk's bookings, so a quote a booking before the window took backs
    none in it."""
    counted = week_counts(done, frame.start, frame.now)
    talked: dict[date, set[str]] = {day: set() for day in frame.dates}
    for text in counted.texts:
        talked.setdefault(frame.local_date(text.at), set()).add(text.session_id)
    booked = Counter(frame.local_date(booking.at) for booking in counted.bookings)
    refused = Counter(frame.local_date(attempt.at) for attempt in counted.stopped)
    return ThisWeek(
        timezone=frame.zone.key, start=frame.dates[0], end=frame.dates[-1], bookings=len(counted.bookings),
        booked_cents=sum(done.booked[booking.ref_id] for booking in counted.bookings),
        conversations=counted.conversations, handled=counted.handled, stepped_in=counted.stepped_in,
        stopped=len(counted.stopped),
        days=[WeekDay(date=day, conversations=len(talked[day]), bookings=booked[day], stopped=refused[day])
              for day in frame.dates])


def recorded_history(done: Activity, frame: Windows) -> RecordedHistory:
    """Which of Today's sections count recorded history: each is flagged when something it counts is replayed (module
    docstring). "Needs you" never is: replayed rows never count as needing the owner (Plan 01d replays finished things
    only). "Since last night" and "last 7 days" are read from what they count (`briefing_counts`, `week_counts`), so
    a flag can't drift from the numbers it labels."""
    since = briefing_counts(done, frame.since, frame.now)
    week = week_counts(done, frame.start, frame.now)
    return RecordedHistory(
        needs_you=False,
        briefing=any(thing.replayed for thing in (*since.stopped, *since.bookings, *since.leads, *since.texts,
                                                  *since.answers.values())),
        this_week=any(thing.replayed for thing in (*week.texts, *week.bookings, *week.stopped, *week.stepped)))


async def desk_zone(ctx: OwnerCtx, desk_id: str) -> tuple[dict, dict]:
    """The Desk's kernel_ro row and its business's."""
    desk = await ctx.ro.one("desks", desk_id=desk_id)
    business = await ctx.ro.one("businesses", business_id=desk["business_id"]) if desk else None
    if desk is None or business is None:
        raise LookupError("the Desk or its business isn't in the copy")
    return desk, business


async def briefing_list(ctx: OwnerCtx, desk_id: str, now: datetime) -> BriefingList:
    _, business = await desk_zone(ctx, desk_id)
    frame = windows(now, business["timezone"])
    return BriefingList(since=frame.since, items=briefing_items(await activity(ctx, desk_id, frame.since),
                                                                frame.since, frame.now))


# Reports (Plan 02b, Task 8) -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Paid:
    """A payment the reports count: its amount, and whether it is recorded history."""

    cents: int
    replayed: bool


async def _paid(ctx: OwnerCtx, desk_id: str, sessions: dict[str, dict], start: datetime, end: datetime) -> list[Paid]:
    """The payments in the Desk's visitor and agent sessions from `start` to `end`: each payment link paid, for the
    link's amount, when its move to `paid` (its first `payment` ledger entry in that state, not a refused retry, which
    the kernel ledgers with the link's state too) falls in the window; and each agent's mandate charge executed, at its
    decision's entry, for the amount the decision was made on, read from the kernel with the owner's credential. A
    link is recorded history when its `payment` entry is marked replayed, a charge when its decision is
    (`decision_replayed`)."""
    ledger = await ctx.ro.rows("ledger_entries", desk_id=desk_id, order_by=("seq",))
    entries = {entry["seq"]: entry for entry in ledger}
    links = {row["link_id"]: row["amount_cents"] for row in await ctx.ro.rows("payment_links", desk_id=desk_id,
                                                                                state="paid")
             if row["session_id"] in sessions}
    paid = []
    for entry in ledger:
        event = entry["event"] or {}
        summary = event.get("summary") or {}
        if (event.get("kind") == "payment" and summary.get("state") == "paid" and not summary.get("refused")
                and summary.get("link_id") in links):
            amount = links.pop(summary["link_id"])         # a link moves to `paid` once, wherever the window is
            if start <= entry_time(entry) <= end:
                paid.append(Paid(cents=amount, replayed=replayed(entry)))
    charges = [row for row in await ctx.ro.rows("decisions", desk_id=desk_id, tool="native.charge_mandate",
                                                state="executed")
               if row["session_id"] in sessions and row["ledger_seq"] in entries
               and start <= entry_time(entries[row["ledger_seq"]]) <= end]
    for row in charges:
        decision = await ctx.kernel.call("GET /decisions/{id}", path={"id": row["decision_id"]})
        paid.append(Paid(cents=(decision.action.amount_cents or 0) if decision.action is not None else 0,
                         replayed=decision_replayed(row, entries[row["ledger_seq"]])))
    return paid


async def reports(ctx: OwnerCtx, desk_id: str, now: datetime, days: int) -> Reports:
    """The last `days` local dates in the business's time zone, today included, from 00:00 on the first of them to
    now, counted as Today's last 7 days are (`week_counts`): bookings, money paid, and the conversations Claude
    handled alone versus the ones the owner stepped into. `recorded_history` is read from what those counts include,
    so it can't drift from the numbers it labels: a replayed booking, payment, conversation row or owner's step into
    one flags it."""
    _, business = await desk_zone(ctx, desk_id)
    zone, now = ZoneInfo(business["timezone"]), utc(now)
    first = now.astimezone(zone).date() - timedelta(days=days - 1)
    start = datetime.combine(first, time(0), tzinfo=zone).astimezone(UTC)
    done = await activity(ctx, desk_id, start)
    counted = week_counts(done, start, now)
    paid = await _paid(ctx, desk_id, done.people.sessions, start, now)
    return Reports(bookings=len(counted.bookings), paid_cents=sum(payment.cents for payment in paid),
                   handled_by_claude=counted.handled, needed_you=counted.stepped_in,
                   recorded_history=any(thing.replayed
                                        for thing in (*counted.bookings, *counted.texts, *counted.stepped, *paid)))


# Conversations ------------------------------------------------------------------------------------------------


async def history_sessions(ctx: OwnerCtx, desk_id: str) -> tuple[set[str], set[str]]:
    """The Desk's sessions that are recorded history, and those known to be live. A session is recorded history when
    the API stored its transcript with a `replay_id` (`store_replayed_night`) or the kernel marked one of its `session`
    ledger entries replayed (which only the kernel writes, for history it wrote into the copy); it is known live when it
    has `session` entries, none of them marked, and no stored row with a `replay_id`. A live session is never recorded
    history: its rows carry no `replay_id`, and the kernel opens it with an unmarked entry."""
    stored = set((await ctx.ro.conn.scalars(select(MESSAGES.c.session_id).distinct().where(
        MESSAGES.c.copy_id == ctx.copy_id, MESSAGES.c.desk_id == desk_id, MESSAGES.c.replay_id.is_not(None)))).all())
    entries = ro_view(ctx.ro.schema, "ledger_entries")
    try:
        await set_copy(ctx.ro.conn, ctx.copy_id)
        events = (await ctx.ro.conn.execute(select(entries.c.event).where(
            entries.c.copy_id == ctx.copy_id, entries.c.desk_id == desk_id,
            entries.c.event.op("->>")("kind") == "session"))).scalars().all()
    finally:
        await ctx.ro.done()
    recorded, opened = set(stored), set()
    for event in events:
        session_id = event.get("session_id") if isinstance(event, dict) else None
        if isinstance(session_id, str):
            opened.add(session_id)
            if replayed({"event": event}):
                recorded.add(session_id)
    return recorded, opened - recorded


async def transcript_replayed(ctx: OwnerCtx, desk_id: str, session_id: str) -> bool:
    """Whether an opened conversation is recorded history (`history_sessions`)."""
    recorded, _ = await history_sessions(ctx, desk_id)
    return session_id in recorded


async def leads(ctx: OwnerCtx, desk_id: str) -> list[Lead]:
    """The leads visitors left on the Desk, newest first, their names and notes as typed (untrusted text). A lead is
    recorded history unless the session it was left in is known live (`history_sessions`), failing closed as
    `decision_replayed` does: one with no session, or a session the ledger doesn't show opening, counts as history."""
    _, live = await history_sessions(ctx, desk_id)
    rows = sorted(await ctx.ro.rows("leads", desk_id=desk_id),
                  key=lambda row: (utc(row["created_at"]), row["lead_id"]), reverse=True)
    return [Lead(lead_id=row["lead_id"], display_name=row["display_name"], note=row["note"],
                 created_at=row["created_at"], replayed=row["session_id"] not in live) for row in rows]


async def conversations(ctx: OwnerCtx, desk_id: str, who: People | None = None) -> list[ConversationSummary]:
    """The Desk's conversations: each visitor or agent session with a transcript row or a decision, the latest
    activity first. A visitor's conversation, other than the owner's own preview, carries the newest message the
    visitor typed (`visitor_line`); an agent's carries none."""
    who = who or await people(ctx, desk_id)
    decisions = await ctx.ro.rows("decisions", desk_id=desk_id)
    latest = dict((await ctx.ro.conn.execute(
        select(MESSAGES.c.session_id, func.max(MESSAGES.c.created_at))
        .where(MESSAGES.c.copy_id == ctx.copy_id, MESSAGES.c.desk_id == desk_id, MESSAGES.c.kind.not_in(OWNER_NOTES))
        .group_by(MESSAGES.c.session_id))).all())
    counts: dict[str, Counter] = {}
    for row in decisions:
        counts.setdefault(row["session_id"], Counter())[row["state"]] += 1
        decided = utc(row["created_at"])
        if row["session_id"] not in latest or utc(latest[row["session_id"]]) < decided:
            latest[row["session_id"]] = decided
    visitors = [session_id for session_id, row in who.sessions.items()
                if session_id in latest and row["kind"] == "visitor" and not row["preview"]]
    said = await last_texts(ctx, desk_id, visitors, kinds=("visitor_text",))
    recorded, _ = await history_sessions(ctx, desk_id)
    found = []
    for session_id, row in who.sessions.items():
        if session_id not in latest:
            continue
        found.append(ConversationSummary(
            session_id=session_id, kind=row["kind"], display_name=who.name(session_id), verified=row["verified"],
            mode=row["mode"], last_activity=max(utc(latest[session_id]), utc(row["created_at"])),
            outcome_counts=dict(counts.get(session_id, {})), owner_preview=row["preview"],
            latest_visitor_text=visitor_line(said.get(session_id)), replayed=session_id in recorded))
    found.sort(key=lambda summary: summary.session_id, reverse=True)
    found.sort(key=lambda summary: summary.last_activity, reverse=True)
    return found


async def today(ctx: OwnerCtx, desk_id: str, now: datetime) -> Today:
    """Today, computed from the rows on each read. What needs the owner is read first, from the kernel (which applies
    expiry), so the rows read after it already show any hold it expired."""
    held = await needs_you(ctx, desk_id)
    _, business = await desk_zone(ctx, desk_id)
    frame = windows(now, business["timezone"])
    done = await activity(ctx, desk_id, frame.start)
    live = [summary for summary in await conversations(ctx, desk_id, done.people)
            if summary.last_activity >= frame.now - LIVE_FOR]
    return Today(greeting_name=(business["owner_display_name"].split() or [""])[0], needs_you_count=len(held),
                 live=live, briefing=briefing(done, frame), this_week=this_week(done, frame),
                 recorded_history=recorded_history(done, frame))


# Safety -------------------------------------------------------------------------------------------------------


async def attempts(ctx: OwnerCtx, desk_id: str) -> list[Attempt]:
    """The Desk's refused requests and Claude's stopped drafts, newest first, each with its AI-written triage once
    written (Plan 02b, Task 10), else None. Only refusals count in Today; their nullable `cause` maps the decision's
    `policy_ids`, its already-read ledger decide summary's `reason`/`check` and the session's verified state
    through `refusal_cause`.
    Sessions, decisions and ledger entries share one snapshot so a newly verified session's refusal cannot be
    labelled with an older verification state. No kernel call runs while the snapshot is open."""
    conn = ctx.ro.conn
    await conn.commit()
    await conn.execution_options(isolation_level="REPEATABLE READ")   # reset when the connection is pooled again
    sessions = {row["session_id"]: row for row in await ctx.ro.rows("sessions", desk_id=desk_id)}
    decisions = await ctx.ro.rows("decisions", desk_id=desk_id)
    ledger = await ctx.ro.rows("ledger_entries", desk_id=desk_id, order_by=("seq",))
    triage = await triaged(ctx.ro.conn, ctx.copy_id, desk_id=desk_id)
    await conn.commit()
    found = sorted(_stopped_attempts(decisions, ledger, sessions), key=lambda attempt: attempt.ref_id, reverse=True)
    found.sort(key=lambda attempt: attempt.at, reverse=True)
    return [Attempt(ref_id=attempt.ref_id, kind=attempt.kind, reason_plain=attempt.reason_plain,
                    card_ids=list(attempt.card_ids), origin=attempt.origin, created_at=attempt.at,
                    triage=triage.get(attempt.ref_id), ledger_seq=attempt.ledger_seq,
                    cause=attempt.cause) for attempt in found]


# The Desk list (#233) -----------------------------------------------------------------------------------------


async def unfinished_setups(ctx: OwnerCtx, desks: list[dict]) -> dict[str, DeskSetup]:
    """The setup interviews of the copy's Desks that haven't gone live, by Desk ID, so the owner can go back into one.
    Only the copy's own interview rows are read, for its Desks. A Desk made outside setup has no interview, and one
    whose interview is `live` has finished. Pending keyed starts, in created order, each cover at most one unlinked
    Desk: the earliest after their kernel-clock boundary that no earlier row claimed. A definite kernel refusal
    with no linked Desk claims nothing. Deleted Desks keep their claims, so deletion cannot move a claim to another
    Desk; only active Desks are returned. Each Desk's actual interview wins; were there more, the newest would stand.
    """
    if not ctx.desk_ids:
        return {}
    rows = await ctx.ro.conn.execute(
        select(INTERVIEWS.c.desk_id, INTERVIEWS.c.interview_id, INTERVIEWS.c.step,
               INTERVIEWS.c.idempotency_key, INTERVIEWS.c.desk_requested_at, INTERVIEWS.c.start_error)
        .where(INTERVIEWS.c.copy_id == ctx.copy_id,
               INTERVIEWS.c.desk_id.in_([desk["desk_id"] for desk in desks]) | (
                   INTERVIEWS.c.desk_id.is_(None) & INTERVIEWS.c.idempotency_key.is_not(None)
                   & INTERVIEWS.c.desk_requested_at.is_not(None)))
        .order_by(INTERVIEWS.c.created_at, INTERVIEWS.c.interview_id))
    rows = rows.mappings().all()
    newest = {row["desk_id"]: row for row in rows if row["desk_id"] is not None}
    found = {desk_id: DeskSetup(interview_id=row["interview_id"], step=row["step"])
             for desk_id, row in newest.items() if row["step"] != "live"}
    unlinked = sorted((desk for desk in desks if desk["desk_id"] not in newest),
                      key=lambda desk: (utc(desk["created_at"]), desk["desk_id"]))
    for row in rows:
        if row["desk_id"] is not None or (row["start_error"] or {}).get("kernel") == "failed":
            continue
        for desk in unlinked:
            if desk["desk_id"] not in found and utc(desk["created_at"]) > utc(row["desk_requested_at"]):
                # desk_requested_at is the newest pre-request Desk timestamp in the kernel's clock domain,
                # not Postgres's request time. Strict ordering excludes all Desks that already existed.
                # Fail safe: if both link writes are lost (a stopped process or database outage), this Desk
                # stays in setup indefinitely. Desks created before the request keep their live status.
                # Assumes no outside-setup Desk is made between the boundary read and POST /desks (the web
                # never does that), and the kernel clock never steps backwards during the start. The former
                # can steal the claim; the latter can leave the start's Desk reading live. Exact ownership
                # needs a kernel request tag on the Desk.
                found[desk["desk_id"]] = DeskSetup(interview_id=row["interview_id"], step="questions")
                break
    return {desk_id: setup for desk_id, setup in found.items() if desk_id in ctx.desk_ids}
