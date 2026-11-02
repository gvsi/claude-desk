"""The transcript store (`app.messages`): append-only conversations and the model input built from them.

Rows are never edited or deleted. The only later writes are a pending row's place in the model's history
(`model_context`, `model_seq`, set once), a pending row's `wake` cleared when a paused session hands off
(`clear_wake`), and an owner translation (`set_owner_translation`, once). Every function runs in the caller's
transaction and never commits.

Recorded history (Plan 01d): a row replayed into a new copy is written with `Replayed` (its recording's `replay_id`
and the moment it was shown, which becomes its `created_at`). It is data for the owner's reads, not a turn: it has no
frozen block and wakes nothing, and the queries that build a model context (the rows waiting for the model, the
code-built summary) leave out every row with a `replay_id`, so no model ever sees it, whatever session it is in.

`n` is the transcript cursor the owner polls with (`?after=n`), so a session's rows must commit in the order of their
`n`: `append_message` takes the session's events lock (`lock_events`, the one `sse.append_event` takes) before it
inserts, and holds it until the caller's transaction ends. A later row of the session waits for an earlier one to
commit, so a poll never sees a row while one numbered before it is still to come. The lock order is the run lock
(`deliver.run_lock`), then the events lock: a transaction that appends a message and then delivers takes the run lock
before its first append.

What is written onto an earlier row later, an owner translation or a triage (Plan 02b, Task 10), also appends an
`annotation` row naming that row's `message_id`, in the same transaction: the owner's transcript turns it into the
annotated item again, under its own `n` and with the annotation's `n` as its cursor, so a poll already past the item
sees it once more, annotated, and once only.

What the model sees (Plan 02a, "Transcript contract"):

- A model context is the session's rows with a `model_seq` in the current `model_context`, in order. It
  opens with a `context_start` row holding its frozen `tools`, its frozen `system` prompt (the blocks every call
  in the context sends: Opus 5.5 binds each thinking block to the prompt it was made under, so the loop opens a
  fresh context when the prompt it renders differs) and, after the first context, a summary of the conversation
  so far built by code. A context opened before contexts froze their prompt has no `system`.
- A row the model will see is written with its frozen block (`model_content`): untrusted text only inside
  a wrapper (`prompts.wrap`), with `&`, `<` and `>` escaped, so no text can close its wrapper or open another.
  It waits with a null `model_seq` until the next model call, when `prepare_model_input` gives it one.
  Pending work is a waiting row with `wake`.
- Assistant rows replay their content unchanged, thinking included. The rows between two of them merge
  into one user message, `tool_result` blocks first; pending tool changes then form one `role: "system"`
  message, always last before the assistant turn and never the first message.
- Each assistant response is written before any of its tool calls runs, and its results row (each
  `tool_use` answered once, in block order) follows. Until then `prepare_model_input` raises
  `UnansweredToolUse`, so an action that ran is recovered by its call ID, never proposed again.

Model-visible kinds and their wrappers (prompts.py's `ROW_TAGS`): `visitor_text` <visitor_message>, `agent_text`
<agent_message>, `owner_say` <owner_said_to_visitor>, `whisper` <owner_whisper> (an untrusted owner note in the user
turn, never system text), `action_update` <action_update decision_id state>, `desk_context` <desk_context>, `note`
<note> (its `ref_id` may be `business_local_time:{timezone}|{local_now}`), and a `delivered` row whose author is the
Desk <shown_to_visitor>. Claude's own delivered replies are replayed
through its `send_reply` calls; an owner's say reaches the model through its `owner_say` row. `status`, `triage` and
`annotation` rows are never model-visible, and neither are `owner_joined` and `owner_left` (Plan 02b): each keeps a
take-over or a hand-back in the transcript, holding the event the visitor's stream got (`event_seq`), while Claude
reads the change from its `note`. Nor is a `stopped_draft` (Plan 02b), a draft of Claude's the reply check stopped,
shown in the owner's transcript alone (`text` its `StoppedDraftRow`: the `StoppedDraft` and the verdict's ledger entry
when its triage shows on it; `ref_id` the verdict's `message_id`): Claude already has its own call and the blocked
result, and no visitor read has the kind. The summary of the conversation so far labels its lines with prompts.py's
labels (`SUMMARY_LABELS`, `SHOWN_LABELS`).
"""

import hashlib
import json
import secrets
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, get_args

from pydantic import ConfigDict, ValidationError
from pydantic_core import from_json
from sqlalchemy import and_, case, cast, func, insert, or_, select, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncConnection

from desk.api.prompts import (
    NOTES,
    ROW_TAGS,
    SEND_REPLY_TOOL,
    SHOWN_LABELS,
    SUMMARY_LABELS,
    TIME_NOTE,
    WEEKDAYS,
    Triage,
    TriageCategory,
    conversation_so_far,
    result_line,
    summary_line,
    wrap,
    wrap_action_update,
)
from desk.api.schemas import OwnerTranscriptItem, StoppedDraft, TranscriptItem
from desk.contracts import RenderedBlock
from desk.db.models import ActionUpdateMetadata, Message, RunEvent
from desk.kernel_api import ContextClock

MESSAGES = Message.__table__
RUN_EVENTS = RunEvent.__table__


@dataclass(frozen=True)
class Ids:
    """The copy, Desk and session a request works in, taken only from a kernel answer (`/whoami`)."""

    copy_id: str
    desk_id: str
    session_id: str


@dataclass(frozen=True)
class Said:
    """A visitor's or a visiting agent's message: its transcript cursor `n` and its text (untrusted)."""

    n: int
    text: str


@dataclass(frozen=True)
class ModelInput:
    """A model call's request as the current context holds it: the system prompt it froze (None for a context opened
    before contexts froze one), its frozen tools and its messages."""

    system: list[dict] | None
    tools: list[dict]
    messages: list[dict]


@dataclass(frozen=True)
class OpenToolUse:
    """An assistant row whose `tool_use` blocks have no results row yet, the session generation its turn made them at
    (the kernel keys a call's decision by it) and when it was written."""

    assistant_n: int
    tool_uses: list[dict]
    generation: int
    created_at: datetime


@dataclass(frozen=True)
class UnreadResults:
    """The results row answering Claude's last response, which Claude hasn't read (no assistant row follows it, in
    any context): its `n`, and each call's result but `send_reply`'s (whose replies the transcript keeps) as
    (tool name, `tool_result` block) in block order."""

    n: int
    results: list[tuple[str, dict]]


@dataclass(frozen=True)
class Replayed:
    """A row or event of recorded history replayed into a copy: the copy's `replay_id` and the moment it was shown."""

    replay_id: str
    at: datetime

    def __post_init__(self) -> None:
        if not self.replay_id or self.at.tzinfo is None:
            raise ValueError("a replayed row names its recording and an aware time")


class UnansweredToolUse(Exception):
    def __init__(self, open_tool_use: OpenToolUse):
        super().__init__(f"assistant row {open_tool_use.assistant_n} has unanswered tool_use blocks")
        self.open = open_tool_use


class NoModelContext(LookupError):
    """The session has no model context yet: `start_fresh_context` opens one."""


@dataclass(frozen=True)
class _Kind:
    author: str | None            # None: the caller names it
    visibility: str
    wake: bool                    # pending work by default


# Each kind's author, visibility and wake; the wrapper of the frozen block the model sees, if any, is prompts.py's
# (`ROW_TAGS`).
ROW_KINDS: dict[str, _Kind] = {
    "visitor_text": _Kind("visitor", "public", True),
    "agent_text": _Kind("agent", "public", True),
    "owner_say": _Kind("owner", "model", False),
    "whisper": _Kind("owner", "owner", True),
    "action_update": _Kind("api", "model", True),
    "desk_context": _Kind("api", "model", False),
    "note": _Kind("api", "model", False),
    "delivered": _Kind(None, "public", False),
    "status": _Kind("desk", "public", False),
    "triage": _Kind("api", "owner", False),
    "annotation": _Kind("api", "owner", False),        # a later write onto `ref_id`'s row (Plan 02b)
    "owner_joined": _Kind("api", "public", False),     # the owner's take-over, as its event (Plan 02b)
    "owner_left": _Kind("api", "public", False),       # the owner's hand-back, as its event (Plan 02b)
    "stopped_draft": _Kind("claude", "owner", False),  # a draft of Claude's the reply check stopped (Plan 02b)
}
TEXT_KINDS = frozenset({"visitor_text", "agent_text", "owner_say", "whisper", "desk_context", "note",
                        "action_update", "triage", "stopped_draft"})
DELIVERY_AUTHORS = frozenset({"claude", "owner", "desk"})
COLUMNS = frozenset({"author", "text", "blocks", "language", "owner_translation", "wake", "ref_id", "call_id",
                     "event_seq"})
REPLAYED_KINDS = frozenset({"visitor_text", "agent_text", "delivered", "status"})   # what a recorded night holds
SAID_KINDS = ("visitor_text", "agent_text")   # what a visitor, or a visiting agent, wrote
PRESENCE_KINDS = frozenset({"owner_joined", "owner_left"})   # the owner's take-over and hand-back, as their events
EVENT_KINDS = frozenset({"delivered", "status", *PRESENCE_KINDS})   # rows holding the event they published
NOT_REPLAYED = MESSAGES.c.replay_id.is_(None)   # every query that builds a model context leaves out recorded history
SEND_REPLY = SEND_REPLY_TOOL["name"]
# The notes whose state a fresh context's summary keeps, the latest of each group: the visitor verified, and the
# owner's latest take-over, hand-back or resume.
VERIFIED_NOTES = (NOTES["verified"], "The visitor verified as the contact on record.")
STATE_NOTES = (VERIFIED_NOTES, (NOTES["taken_over"], NOTES["handed_back"], NOTES["resumed"]))


def lock_key(name: str) -> int:
    """A Postgres advisory lock key: the first 8 bytes of sha256(name), as a signed bigint."""
    return int.from_bytes(hashlib.sha256(name.encode()).digest()[:8], "big", signed=True)


async def lock_events(conn: AsyncConnection, session_id: str) -> None:
    """The session's events lock, held until the transaction ends: its SSE events take their `seq`, and its transcript
    rows their `n`, one transaction at a time."""
    await conn.execute(select(func.pg_advisory_xact_lock(lock_key("events:" + session_id))))


async def _lock_transcript(conn: AsyncConnection, session_id: str) -> None:
    """Serialize the session's `model_seq` assignments until the transaction ends."""
    await conn.execute(select(func.pg_advisory_xact_lock(lock_key("transcript:" + session_id))))


def blocks_text(blocks: Sequence[RenderedBlock | dict]) -> str:
    return "\n".join(RenderedBlock.model_validate(block).text for block in blocks)


def _text_block(text: str) -> dict:
    return {"type": "text", "text": text}


def _frozen_block(kind: str, values: dict[str, Any], state: str | None,
                  result_fact_ids: Sequence[str] = ()) -> dict | None:
    """The block the model will see for a new row, or None when the model never sees it."""
    if kind == "action_update":
        return _text_block(wrap_action_update(values["text"], values["ref_id"], state, result_fact_ids))
    if kind == "delivered":
        return _text_block(wrap(ROW_TAGS[kind], blocks_text(values["blocks"]))) if values["author"] == "desk" else None
    return _text_block(wrap(ROW_TAGS[kind], values["text"])) if kind in ROW_TAGS else None


def _new_message_id() -> str:
    return "m-" + secrets.token_hex(12)


async def _insert(conn: AsyncConnection, ids: Ids, **values: Any) -> int:
    row = {"message_id": _new_message_id(), "copy_id": ids.copy_id, "desk_id": ids.desk_id,
           "session_id": ids.session_id, **values}
    return (await conn.execute(insert(MESSAGES).values(**row).returning(MESSAGES.c.n))).scalar_one()


async def append_message(conn: AsyncConnection, ids: Ids, kind: str, *, state: str | None = None,
                         result_fact_ids: Sequence[str] = (),
                         replayed: Replayed | None = None, **columns: Any) -> int:
    """Append a transcript row and return its `n`, under the session's events lock (module docstring). A row the
    model will see is written with its frozen block and waits for the next model call. `state` (the decision's) is
    required for an `action_update`, whose `ref_id` is the decision and `text` its `visitor_plain`. Its optional
    `result_fact_ids` and state are stored in `blocks` for the code-built summary, independently of the frozen
    block. A `replayed` row
    (a visitor's, an agent's, a delivered one or a status) is recorded history: written at its moment with its
    `replay_id`, with no frozen block and no `wake`. Context, tool-change and model rows, which no reader polls,
    have their own functions."""
    spec = ROW_KINDS.get(kind)
    if spec is None:
        raise ValueError(f"append_message doesn't write {kind!r} rows")
    if unknown := set(columns) - COLUMNS:
        raise TypeError(f"not app.messages columns: {sorted(unknown)}")
    if replayed is not None and (kind not in REPLAYED_KINDS or columns.get("wake")):
        raise ValueError("recorded history holds visitor, agent, delivered and status rows, and wakes nothing")
    values = {"author": spec.author, "wake": spec.wake and replayed is None, "text": None, "ref_id": None,
              "blocks": None, **columns}
    if spec.author is not None and values["author"] != spec.author:
        raise ValueError(f"a {kind} row's author is {spec.author}")
    if kind in TEXT_KINDS and not isinstance(values["text"], str):
        raise ValueError(f"a {kind} row has text")
    if kind == "action_update" and not (values["ref_id"] and state):
        raise ValueError("an action_update names its decision (ref_id) and state")
    if kind == "action_update":
        values["blocks"] = ActionUpdateMetadata(state=state, result_fact_ids=list(result_fact_ids))
    if kind == "annotation" and not values["ref_id"]:
        raise ValueError("an annotation names the row it annotates (ref_id, its message_id)")
    if kind in PRESENCE_KINDS and not values.get("event_seq"):
        raise ValueError(f"a {kind} row names the event it holds (event_seq)")
    if kind == "stopped_draft" and not (values["ref_id"] and _stored_draft(values["text"])):
        raise ValueError("a stopped_draft row names the verdict (ref_id, its message_id) and holds a StoppedDraftRow")
    if kind != "action_update" and state is not None:
        raise ValueError("only an action_update has a state")
    if kind == "delivered" and (values["author"] not in DELIVERY_AUTHORS or values["blocks"] is None):
        raise ValueError("a delivered row has blocks and an author: claude, owner or desk")
    await lock_events(conn, ids.session_id)
    if replayed is not None:
        return await _insert(conn, ids, kind=kind, visibility=spec.visibility, model_content=None,
                             created_at=replayed.at, replay_id=replayed.replay_id, **values)
    return await _insert(conn, ids, kind=kind, visibility=spec.visibility,
                         model_content=_frozen_block(kind, values, state, result_fact_ids), **values)


TRANSLATED_KINDS = ("visitor_text", "agent_text", "delivered")


async def set_owner_translation(conn: AsyncConnection, ids: Ids, message_id: str, translation: str) -> bool:
    """Write the owner's translation onto the session's message `message_id` (a visitor's, an agent's or a delivered
    one) and its `annotation` row, under the session's events lock; False, writing nothing, when the message isn't
    there or already has one."""
    await lock_events(conn, ids.session_id)
    written = await conn.execute(update(MESSAGES).where(
        MESSAGES.c.copy_id == ids.copy_id, MESSAGES.c.session_id == ids.session_id,
        MESSAGES.c.message_id == message_id, MESSAGES.c.kind.in_(TRANSLATED_KINDS),
        MESSAGES.c.owner_translation.is_(None)).values(owner_translation=translation))
    if written.rowcount != 1:
        return False
    await append_message(conn, ids, "annotation", ref_id=message_id)
    return True


async def triaged(conn: AsyncConnection, copy_id: str, **where: str) -> dict[str, Triage]:
    """The copy's triage rows (by `session_id` or `desk_id`, as `where` says), each read back as its `Triage` by the
    attempt it is about (`ref_id`); one that doesn't read back is left out."""
    if not where or set(where) - {"session_id", "desk_id"}:
        raise ValueError("triage rows are read by session_id or desk_id")
    rows = await conn.execute(select(MESSAGES.c.ref_id, MESSAGES.c.text).where(
        MESSAGES.c.copy_id == copy_id, MESSAGES.c.kind == "triage",
        *(MESSAGES.c[name] == value for name, value in where.items())).order_by(MESSAGES.c.n))
    found = {}
    for ref_id, text in rows:
        if (triage := _read_triage(text)) is not None:
            found[ref_id] = triage
    return found


async def newest_triage(conn: AsyncConnection, copy_id: str, desk_id: str,
                        session_ids: Iterable[str]) -> dict[str, Triage]:
    """Each of the Desk's given sessions' newest triage row that reads back as its `Triage`, by `session_id`; a
    session with none is left out."""
    wanted = sorted(set(session_ids))
    if not wanted:
        return {}
    rows = await conn.execute(select(MESSAGES.c.session_id, MESSAGES.c.text).where(
        MESSAGES.c.copy_id == copy_id, MESSAGES.c.desk_id == desk_id, MESSAGES.c.kind == "triage",
        MESSAGES.c.session_id.in_(wanted)).order_by(MESSAGES.c.n))
    found = {}
    for session_id, text in rows:
        if (triage := _read_triage(text)) is not None:
            found[session_id] = triage
    return found


_LEGACY_TRIAGE_CATEGORIES = {
    "discount_push": "prices", "private_data": "records", "code_redirect": "codes",
    "injection": "instructions", "over_limit": "limits", "impersonation": "other",
}


def _read_triage(text: str | None) -> Triage | None:
    """Read stored categories into today's filters without rewriting the owner's summary.

    Compatibility belongs here, never in `Triage`: fresh model output must use the current categories.
    None for a row whose JSON or remaining fields don't read back as a triage.
    """
    try:
        stored = from_json(text or "")
        if isinstance(stored, dict):
            category = stored.get("category")
            category = _LEGACY_TRIAGE_CATEGORIES.get(category, category) if isinstance(category, str) else "other"
            stored["category"] = category if category in get_args(TriageCategory) else "other"
        return Triage.model_validate(stored)
    except ValueError:
        return None


class StoppedDraftRow(StoppedDraft):
    """A `stopped_draft` row's `text` as stored (`append_stopped_draft`): the `StoppedDraft` and the attempt its item
    shows (`KeptDraft.ledger_seq`, null for none), always stated, and no other key."""

    model_config = ConfigDict(extra="forbid")

    ledger_seq: int | None


def _stored_draft(text: str | None) -> StoppedDraftRow | None:
    """A `stopped_draft` row's `StoppedDraftRow`, with no key its models don't know at any depth (the draft and the
    violations are held to the row's rule here) and no value that is only coercible to its type (a `ledger_seq` of
    "7", 7.0 or true); None for a text that doesn't read back as one. A write is checked with it, so a row the
    owner's read can't read back is never stored."""
    try:
        return StoppedDraftRow.model_validate_json(text or "", strict=True, extra="forbid")
    except ValidationError:
        return None


def _read_stopped_draft(text: str | None) -> StoppedDraft | None:
    """The owner's view of a `stopped_draft` row: its `StoppedDraft` alone, without the attempt it shows; None for a
    row that doesn't read back (`_stored_draft`)."""
    if (row := _stored_draft(text)) is None:
        return None
    return StoppedDraft.model_validate(row.model_dump(exclude={"ledger_seq"}))


@dataclass(frozen=True)
class KeptDraft:
    """A draft of Claude's the reply check stopped, as the owner keeps it (`append_stopped_draft`): the verdict's
    `message_id`, the draft as the check had it with the violations the check found and, when nothing was shown in
    the draft's place (Claude may rewrite it), the verdict's ledger entry `seq`: the attempt as Safety names it, whose
    triage then shows on the draft's item (`SHOWN_ATTEMPT`). A handoff shown in its place shows that attempt instead,
    so a draft it replaced has none, and each attempt shows on one item."""

    message_id: str
    stopped: StoppedDraft
    ledger_seq: int | None = None


async def append_stopped_draft(conn: AsyncConnection, ids: Ids, kept: KeptDraft) -> int:
    """Keep a draft of Claude's the reply check stopped for the owner: a `stopped_draft` row, `ref_id` the verdict's
    `message_id` and `text` its `StoppedDraftRow` (the `StoppedDraft` with the `ledger_seq` it shows, null for none),
    in the caller's transaction (under the session's events lock, as any append); returns its `n`. The owner's
    transcript reads the `StoppedDraft` alone."""
    row = StoppedDraftRow(**kept.stopped.model_dump(), ledger_seq=kept.ledger_seq)
    return await append_message(conn, ids, "stopped_draft", text=row.model_dump_json(), ref_id=kept.message_id)


async def append_note_once(conn: AsyncConnection, ids: Ids, text: str, *, wake: bool) -> int | None:
    """Append a `note` row of `text` unless the session already has one, deciding and writing under the session's
    events lock, so two requests can't both write it; its `n`, or None when the note was already there."""
    await lock_events(conn, ids.session_id)
    noted = (await conn.execute(select(MESSAGES.c.n).where(
        MESSAGES.c.copy_id == ids.copy_id, MESSAGES.c.session_id == ids.session_id, MESSAGES.c.kind == "note",
        MESSAGES.c.text.in_(VERIFIED_NOTES if text in VERIFIED_NOTES else (text,))).limit(1))).first()
    if noted is not None:
        return None
    return await append_message(conn, ids, "note", text=text, wake=wake)


TIME_NOTE_REF = "business_local_time:"


async def append_time_note(conn: AsyncConnection, ids: Ids, clock: ContextClock) -> int | None:
    """Keep the kernel's business time in a model-only note; its ref_id retains the zone and offset-aware local_now.

    Read and write under the events lock, so a concurrent refresh can't append the same note twice."""
    local = datetime.fromisoformat(clock.local_now)
    await lock_events(conn, ids.session_id)
    previous = (await conn.execute(select(MESSAGES.c.ref_id).where(
        MESSAGES.c.copy_id == ids.copy_id, MESSAGES.c.session_id == ids.session_id, MESSAGES.c.kind == "note",
        MESSAGES.c.ref_id.startswith(TIME_NOTE_REF, autoescape=True)).order_by(MESSAGES.c.n.desc()).limit(1)
    )).scalar_one_or_none()
    if previous is not None:
        zone, separator, timestamp = previous.removeprefix(TIME_NOTE_REF).partition("|")
        # Older markers have no zone: replace them on the next turn.
        if separator and zone == clock.timezone:
            last = datetime.fromisoformat(timestamp)
            elapsed = local.astimezone(UTC) - last.astimezone(UTC)
            if local.date() == last.date() and timedelta(0) <= elapsed < timedelta(minutes=10):
                return None
    offset = local.strftime("%z")
    return await append_message(conn, ids, "note", ref_id=f"{TIME_NOTE_REF}{clock.timezone}|{clock.local_now}",
                                text=TIME_NOTE.format(weekday=WEEKDAYS[clock.weekday], date=local.date().isoformat(),
                                                      time=local.strftime("%H:%M"), timezone=clock.timezone,
                                                      offset=f"UTC{offset[:3]}:{offset[3:5]}"))


async def append_tool_change(conn: AsyncConnection, ids: Ids, change: str, tool_name: str) -> int:
    """A change to the session's tools (`tool_addition` or `tool_removal` of a declared tool, by its API name),
    sent at the next model call in a `role: "system"` message after the user turn. The context's declared
    tools never change; a changed definition is a removal, then a fresh context."""
    if change not in ("tool_addition", "tool_removal"):
        raise ValueError("a tool change is a tool_addition or a tool_removal")
    if not tool_name:
        raise ValueError("a tool change names the tool")
    block = {"type": change, "tool": {"type": "tool_reference", "name": tool_name}}
    return await _insert(conn, ids, kind="tool_change", author="api", visibility="model", text=tool_name,
                         model_content=block)


# The model's history -------------------------------------------------------------------------------------


async def _current_context(conn: AsyncConnection, session_id: str) -> int | None:
    return (await conn.execute(select(func.max(MESSAGES.c.model_context)).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.kind == "context_start"))).scalar_one()


async def _next_seq(conn: AsyncConnection, session_id: str) -> int:
    last = (await conn.execute(select(func.max(MESSAGES.c.model_seq)).where(
        MESSAGES.c.session_id == session_id))).scalar_one()
    return 1 if last is None else last + 1


async def _place(conn: AsyncConnection, ns: Sequence[int], context: int, first_seq: int) -> None:
    for offset, n in enumerate(ns):
        await conn.execute(update(MESSAGES).where(MESSAGES.c.n == n, MESSAGES.c.model_seq.is_(None))
                           .values(model_context=context, model_seq=first_seq + offset))


async def _pending(conn: AsyncConnection, session_id: str, through: int | None = None) -> list[Any]:
    """Rows the model hasn't been sent yet, in the order they were written, up to `through` when given; recorded
    history never is."""
    bound = [] if through is None else [MESSAGES.c.n <= through]
    return list(await conn.execute(select(MESSAGES.c.n, MESSAGES.c.kind).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.model_seq.is_(None),
        MESSAGES.c.model_content.is_not(None), NOT_REPLAYED, *bound).order_by(MESSAGES.c.n)))


async def unanswered_tool_use(conn: AsyncConnection, session_id: str) -> OpenToolUse | None:
    """The session's last assistant row, when it has `tool_use` blocks and no results row follows it."""
    last = (await conn.execute(select(MESSAGES.c.n, MESSAGES.c.model_seq, MESSAGES.c.model_content,
                                      MESSAGES.c.generation, MESSAGES.c.created_at).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.kind == "model_assistant")
        .order_by(MESSAGES.c.model_seq.desc()).limit(1))).first()
    if last is None:
        return None
    tool_uses = [block for block in last.model_content if block.get("type") == "tool_use"]
    if not tool_uses:
        return None
    answered = (await conn.execute(select(func.count()).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.kind == "model_tool_results",
        MESSAGES.c.model_seq > last.model_seq))).scalar_one()
    return None if answered else OpenToolUse(assistant_n=last.n, tool_uses=tool_uses, generation=last.generation,
                                             created_at=last.created_at)


async def unread_results(conn: AsyncConnection, session_id: str) -> UnreadResults | None:
    """The results Claude hasn't read yet (`UnreadResults`), read across the session's contexts (`model_seq` runs
    through them all): the results row answering Claude's last response, in whatever context it was written, so a
    fresh context with no answer yet still has its predecessor's results unread. None when the last response has no
    results row yet, or there is no response."""
    last = (await conn.execute(select(MESSAGES.c.n, MESSAGES.c.kind, MESSAGES.c.model_content).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.kind.in_(("model_assistant", "model_tool_results")))
        .order_by(MESSAGES.c.model_seq.desc()).limit(2))).all()
    if [row.kind for row in last] != ["model_tool_results", "model_assistant"]:
        return None
    results, assistant = last
    names = {block["id"]: block["name"] for block in assistant.model_content if block.get("type") == "tool_use"}
    return UnreadResults(n=results.n, results=[
        (names[block["tool_use_id"]], block) for block in results.model_content
        if names.get(block["tool_use_id"]) not in (None, SEND_REPLY)])


async def delivered_reply(conn: AsyncConnection, session_id: str, call_id: str) -> Any | None:
    """What Claude's `send_reply` call `call_id` put on the visitor's screen: its `delivered` row's kernel message ID
    (`ref_id`), its `blocks` and its event's `handoff` flag, or None when nothing was shown for that call."""
    return (await conn.execute(select(MESSAGES.c.ref_id, MESSAGES.c.blocks,
                                     RUN_EVENTS.c.payload["handoff"].as_boolean().label("handoff"))
        .select_from(WITH_EVENTS).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.kind == "delivered", MESSAGES.c.call_id == call_id)
        .order_by(MESSAGES.c.n).limit(1))).first()


async def _refuse_open_tool_use(conn: AsyncConnection, session_id: str) -> None:
    if (open_tool_use := await unanswered_tool_use(conn, session_id)) is not None:
        raise UnansweredToolUse(open_tool_use)


def _summary_line(row: Any) -> str:
    """A summary line for a row, labelled as prompts.py says: a delivered row by its author, any other by its kind."""
    if row.kind == "delivered":
        return summary_line(SHOWN_LABELS[row.author], blocks_text(row.blocks or []))
    if row.kind == "action_update":
        # Older rows have no structured metadata; retain their decision and text without parsing frozen text.
        metadata = f'decision_id={json.dumps(row.ref_id, ensure_ascii=False)} '
        if row.blocks is not None:
            metadata += (f'state={json.dumps(row.blocks.state)} '
                         f'result_fact_ids={json.dumps(" ".join(row.blocks.result_fact_ids), ensure_ascii=False)} ')
        return summary_line(SUMMARY_LABELS[row.kind], metadata + (row.text or ""))
    return summary_line(SUMMARY_LABELS[row.kind], row.text or "")


def _result_text(block: dict) -> str:
    """A `tool_result` block's content as text: the JSON string the loop writes, or its text blocks'."""
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(item.get("text", "") for item in content if isinstance(item, dict))
    return json.dumps(content, ensure_ascii=False)


async def _state_notes(conn: AsyncConnection, session_id: str) -> list[Any]:
    """The latest note of each `STATE_NOTES` group and the latest business time, when the model has been sent it;
    one still waiting follows the summary in full, and an older one is overtaken by it."""
    rows = (await conn.execute(select(MESSAGES.c.n, MESSAGES.c.kind, MESSAGES.c.author, MESSAGES.c.text,
                                      MESSAGES.c.blocks, MESSAGES.c.model_seq, MESSAGES.c.ref_id).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.kind == "note",
        or_(MESSAGES.c.text.in_([text for group in STATE_NOTES for text in group]),
            MESSAGES.c.ref_id.startswith(TIME_NOTE_REF, autoescape=True))).order_by(MESSAGES.c.n))).all()
    latest = [next((row for row in reversed(rows) if row.text in group), None) for group in STATE_NOTES]
    latest.append(next((row for row in reversed(rows) if (row.ref_id or "").startswith(TIME_NOTE_REF)), None))
    return [row for row in latest if row is not None and row.model_seq is not None]


async def _summary(conn: AsyncConnection, session_id: str, unread: UnreadResults | None) -> str:
    """The conversation so far, by code: texts, delivered blocks (says included), action updates and the latest
    state notes (including business time; whispers never), each on one labelled, escaped line, and, where they were
    written, the results Claude hadn't read (`unread`), one line each, labelled by tool: the context they were written in is
    closing, and Claude must not lose what its calls did. Rows still waiting for the model are left out; they follow
    it in full. Recorded history is never in it."""
    rows = await conn.execute(select(MESSAGES.c.n, MESSAGES.c.kind, MESSAGES.c.author, MESSAGES.c.text,
                                     MESSAGES.c.blocks, MESSAGES.c.ref_id, MESSAGES.c.model_content).where(
        MESSAGES.c.session_id == session_id,
        MESSAGES.c.kind.in_(("visitor_text", "agent_text", "delivered", "action_update")),
        ~and_(MESSAGES.c.model_seq.is_(None), MESSAGES.c.model_content.is_not(None)), NOT_REPLAYED,
    ).order_by(MESSAGES.c.n))
    lines = [(row.n, _summary_line(row)) for row in [*rows, *await _state_notes(conn, session_id)]]
    if unread is not None:
        lines += [(unread.n, result_line(tool, _result_text(block))) for tool, block in unread.results]
    return conversation_so_far([line for _, line in sorted(lines, key=lambda item: item[0])])


async def start_fresh_context(conn: AsyncConnection, ids: Ids, tools: list[dict], *, system: list[dict]) -> int:
    """Open a new model context with these frozen tools, this frozen system prompt (the blocks every call in the
    context sends) and, after the first context, the code-built summary.

    What the old context was still waiting for closes it unsent: tool changes (the new tools supersede them)
    and says (the summary carries them, from their delivered rows). Results of Claude's calls it hadn't read go
    into the summary too (`_summary`). The last desk context is stated again, since the facts Claude cites must be
    in the context it answers from."""
    if not system:
        raise ValueError("a model context freezes the system prompt its calls send")
    await _lock_transcript(conn, ids.session_id)
    await _refuse_open_tool_use(conn, ids.session_id)
    current = await _current_context(conn, ids.session_id)
    summary = None
    if current is not None:
        unread = await unread_results(conn, ids.session_id)
        closing = [row.n for row in await _pending(conn, ids.session_id) if row.kind in ("tool_change", "owner_say")]
        await _place(conn, closing, current, await _next_seq(conn, ids.session_id))
        summary = await _summary(conn, ids.session_id, unread)
        facts = (await conn.execute(select(MESSAGES.c.text, MESSAGES.c.model_seq).where(
            MESSAGES.c.session_id == ids.session_id, MESSAGES.c.kind == "desk_context")
            .order_by(MESSAGES.c.n.desc()).limit(1))).first()
        if facts is not None and facts.model_seq is not None:
            await append_message(conn, ids, "desk_context", text=facts.text)
    return await _insert(conn, ids, kind="context_start", author="api", visibility="model",
                         model_context=0 if current is None else current + 1,
                         model_seq=await _next_seq(conn, ids.session_id),
                         model_content={"tools": tools, "summary": summary, "system": system})


async def _context_start(conn: AsyncConnection, session_id: str, context: int) -> dict:
    """What the `context_start` row of model context `context` froze."""
    return (await conn.execute(select(MESSAGES.c.model_content).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.kind == "context_start",
        MESSAGES.c.model_context == context))).scalar_one()


async def context_system(conn: AsyncConnection, session_id: str) -> list[dict] | None:
    """The system prompt the current model context froze; None before the session's first context, and for a context
    opened before contexts froze one."""
    current = await _current_context(conn, session_id)
    if current is None:
        return None
    return (await _context_start(conn, session_id, current)).get("system")


async def context_tools(conn: AsyncConnection, session_id: str) -> tuple[list[dict], list[tuple[str, str]]] | None:
    """The current model context's tools as its `context_start` row froze them, and its tool changes since, as
    (`tool_addition` or `tool_removal`, tool name) in order, those waiting for the next call included; None before
    the session's first context."""
    current = await _current_context(conn, session_id)
    if current is None:
        return None
    start = await _context_start(conn, session_id, current)
    changes = await conn.execute(select(MESSAGES.c.model_content).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.kind == "tool_change",
        or_(MESSAGES.c.model_context == current, MESSAGES.c.model_seq.is_(None))).order_by(MESSAGES.c.n))
    return start["tools"], [(change["type"], change["tool"]["name"]) for (change,) in changes]


async def prepare_model_input(conn: AsyncConnection, session_id: str, *, through: int | None = None) -> ModelInput:
    """Give the waiting rows their place (user-turn rows, then tool changes) and build the current context's
    request: its frozen system prompt and tools, and its messages. Raises `UnansweredToolUse` while a tool call has
    no result. With `through` (a `newest_row` the caller read), only rows up to it are placed, and any written since
    keep waiting for the next call: the loop tells the kernel the newest message it will place before it places it."""
    await _lock_transcript(conn, session_id)
    current = await _current_context(conn, session_id)
    if current is None:
        raise NoModelContext(session_id)
    await _refuse_open_tool_use(conn, session_id)
    pending = await _pending(conn, session_id, through)
    ordered = [row.n for row in pending if row.kind != "tool_change"] + [
        row.n for row in pending if row.kind == "tool_change"]
    await _place(conn, ordered, current, await _next_seq(conn, session_id))

    rows = await conn.execute(select(MESSAGES.c.kind, MESSAGES.c.model_content).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.model_context == current).order_by(MESSAGES.c.model_seq))
    system_prompt: list[dict] | None = None
    tools: list[dict] = []
    messages: list[dict] = []
    results: list[dict] = []
    user: list[dict] = []
    system: list[dict] = []

    def close_gap() -> None:
        if results or user:
            messages.append({"role": "user", "content": [*results, *user]})
        if system:
            if not messages:
                raise ValueError("a tool change can't open a model context")
            messages.append({"role": "system", "content": list(system)})
        results.clear(), user.clear(), system.clear()

    for row in rows:
        if row.kind == "context_start":
            system_prompt, tools = row.model_content.get("system"), row.model_content["tools"]
            if row.model_content["summary"] is not None:
                user.append(_text_block(row.model_content["summary"]))
        elif row.kind == "model_assistant":
            close_gap()
            messages.append({"role": "assistant", "content": row.model_content})
        elif row.kind == "model_tool_results":
            results.extend(row.model_content)
        elif row.kind == "tool_change":
            system.append(row.model_content)
        else:
            user.append(row.model_content)
    close_gap()
    return ModelInput(system=system_prompt, tools=tools, messages=messages)


async def append_assistant(conn: AsyncConnection, ids: Ids, content: list[dict], *, generation: int) -> int:
    """Write Claude's response (frozen, thinking included) as the next step of the current context, before any
    of its blocks is routed; returns its `n`. `generation` is the session generation its turn runs at, which its
    tool calls are decided at: a turn interrupted after a call finds the call's decision by it."""
    await _lock_transcript(conn, ids.session_id)
    current = await _current_context(conn, ids.session_id)
    if current is None:
        raise NoModelContext(ids.session_id)
    await _refuse_open_tool_use(conn, ids.session_id)
    return await _insert(conn, ids, kind="model_assistant", author="claude", visibility="model",
                         model_context=current, model_seq=await _next_seq(conn, ids.session_id),
                         model_content=content, generation=generation)


async def append_tool_results(conn: AsyncConnection, ids: Ids, assistant_n: int, results: list[dict]) -> int:
    """Answer the open assistant row's `tool_use` blocks: one `tool_result` each, in block order."""
    await _lock_transcript(conn, ids.session_id)
    open_tool_use = await unanswered_tool_use(conn, ids.session_id)
    if open_tool_use is None or open_tool_use.assistant_n != assistant_n:
        raise ValueError(f"assistant row {assistant_n} is not waiting for tool results")
    answered = [result.get("tool_use_id") for result in results if result.get("type") == "tool_result"]
    if len(answered) != len(results) or answered != [block["id"] for block in open_tool_use.tool_uses]:
        raise ValueError("answer each tool_use once, in block order, with tool_result blocks only")
    current = await _current_context(conn, ids.session_id)
    return await _insert(conn, ids, kind="model_tool_results", author="api", visibility="model",
                         model_context=current, model_seq=await _next_seq(conn, ids.session_id),
                         model_content=results)


def context_text(facts: Sequence[Any], knowledge: Sequence[Any]) -> str:
    """A `desk_context` row's text: the facts and knowledge `/context` returned, as canonical JSON."""
    dump = [item.model_dump(mode="json") if hasattr(item, "model_dump") else item for item in (*facts, *knowledge)]
    body = {"facts": dump[:len(facts)], "knowledge": dump[len(facts):]}
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def context_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


async def last_context_hash(conn: AsyncConnection, session_id: str) -> str | None:
    """The hash of the session's last `desk_context` text: a new row is written only when it changes."""
    text = (await conn.execute(select(MESSAGES.c.text).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.kind == "desk_context")
        .order_by(MESSAGES.c.n.desc()).limit(1))).scalar_one_or_none()
    return None if text is None else context_hash(text)


async def has_pending(conn: AsyncConnection, session_id: str) -> bool:
    """Pending work: a row the model hasn't been sent whose `wake` starts a turn (visitor and agent text in mode
    `ai`, whispers, action updates, the verification note)."""
    return await latest_pending(conn, session_id) is not None


async def has_unanswered_visitor(conn: AsyncConnection, session_id: str) -> bool:
    """Whether the latest conversational message is the visitor's, with no delivered reply after it.

    Mode markers, private whispers and bookkeeping aren't answers. Read under the events lock so a message
    being stored has committed before deciding whether the hand-back should wake Claude.
    """
    await lock_events(conn, session_id)
    kind = (await conn.execute(select(MESSAGES.c.kind).where(
        MESSAGES.c.session_id == session_id, NOT_REPLAYED,
        MESSAGES.c.kind.in_(("visitor_text", "agent_text", "owner_say", "delivered")))
        .order_by(MESSAGES.c.n.desc()).limit(1))).scalar_one_or_none()
    return kind == "visitor_text"


async def latest_pending(conn: AsyncConnection, session_id: str) -> int | None:
    """The `n` of the session's latest pending row (`has_pending`), or None when no work is waiting."""
    return (await conn.execute(select(func.max(MESSAGES.c.n)).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.model_seq.is_(None), MESSAGES.c.wake,
        MESSAGES.c.model_content.is_not(None)))).scalar_one()


async def newest_row(conn: AsyncConnection, session_id: str) -> int | None:
    """The `n` of the session's newest row, or None for a session with none: the cutoff a model call places rows up
    to (`prepare_model_input(through=)`), read before the loop looks for the message to tell the kernel
    (`latest_said(through=)`). A row takes its `n` when it is inserted, so one still open can sit below a newer row
    that committed first: a visitor's or an agent's message, which `append_message` inserts under the session's events
    lock, below a loop row (tool results, an assistant row, a context or tool change), which takes no such lock. So
    this takes the events lock first, waiting out any open `append_message`: every message below the cutoff is then
    committed, and the look sees it. The lock is held until the caller's transaction ends, which the loop ends before
    any kernel call."""
    await lock_events(conn, session_id)
    return (await conn.execute(select(func.max(MESSAGES.c.n)).where(
        MESSAGES.c.session_id == session_id))).scalar_one()


async def latest_said(conn: AsyncConnection, session_id: str, *, through: int | None = None) -> Said | None:
    """The newest visitor or agent message the session's next model call places in its context (the rows `_pending`
    finds, up to `through` when given), whether or not it woke the turn: text written while the owner had the chat
    wakes nothing, yet reaches Claude with the next turn. The turn tells the kernel its language (`loop`). None when
    no such message waits (only a whisper, an action update or a note does)."""
    bound = [] if through is None else [MESSAGES.c.n <= through]
    found = (await conn.execute(select(MESSAGES.c.n, MESSAGES.c.text).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.kind.in_(SAID_KINDS),
        MESSAGES.c.model_seq.is_(None), MESSAGES.c.model_content.is_not(None), NOT_REPLAYED, *bound)
        .order_by(MESSAGES.c.n.desc()).limit(1))).first()
    return None if found is None else Said(found.n, found.text)


async def clear_wake(conn: AsyncConnection, session_id: str) -> int:
    """Stop the session's pending work from starting turns (a paused session hands off instead); the rows still wait
    for the model and reach it at its next call. Returns how many rows it cleared."""
    cleared = await conn.execute(update(MESSAGES).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.model_seq.is_(None), MESSAGES.c.wake).values(wake=False))
    return cleared.rowcount



# Read models ---------------------------------------------------------------------------------------------

AUDIENCE_KINDS = {
    "visitor": ("visitor_text", "delivered", "status", *sorted(PRESENCE_KINDS)),
    "owner": ("visitor_text", "agent_text", "delivered", "status", "whisper", *sorted(PRESENCE_KINDS), "stopped_draft"),
}
UNTEXTED_KINDS = frozenset({*EVENT_KINDS, "stopped_draft"})   # items whose `text` is null: an event, or a stopped draft
# Each row with the event it published, if any (`event_seq`).
WITH_EVENTS = MESSAGES.outerjoin(RUN_EVENTS, and_(
    RUN_EVENTS.c.session_id == MESSAGES.c.session_id, RUN_EVENTS.c.kind == "sse",
    RUN_EVENTS.c.seq == MESSAGES.c.event_seq))
# The attempt a row of `WITH_EVENTS` shows, as Safety names it and a triage's `ref_id` holds it: a status's decision,
# the reply check a delivered handoff answered (its ledger entry's `seq`), or the check that stopped a draft nothing
# was shown in place of (`KeptDraft.ledger_seq`). Each branch reads only rows of its own kind, so only a stopped
# draft's text is read as JSON.
SHOWN_ATTEMPT = case((MESSAGES.c.kind == "status", MESSAGES.c.ref_id),
                     (MESSAGES.c.kind == "delivered", RUN_EVENTS.c.payload["ledger_seq"].astext),
                     (MESSAGES.c.kind == "stopped_draft", cast(MESSAGES.c.text, JSONB)["ledger_seq"].astext))


async def transcript(conn: AsyncConnection, ids: Ids, audience: str, after: int = 0) -> list[TranscriptItem]:
    """The session's transcript after the cursor `after`, as `audience` (visitor or owner) may see it. A visitor
    sees their own words, what was delivered to them and where the owner joined and left (each with its stored
    event); the owner also sees agent text, whispers and Claude's stopped drafts, with AI-written translations and
    triage, and an item annotated after `after` (its `annotation` row is past it) comes again, with that row's `n` as
    its cursor (module docstring). Model rows, notes, context, tool-change, triage and annotation rows are never items.

    One statement reads it all, so an annotation committed meanwhile is either wholly in the answer (what it wrote and
    its cursor) or wholly in the next one: a poll never sees it twice."""
    if audience not in AUDIENCE_KINDS:
        raise ValueError("a transcript is the visitor's or the owner's")
    mine = and_(MESSAGES.c.copy_id == ids.copy_id, MESSAGES.c.session_id == ids.session_id)
    source = WITH_EVENTS
    columns = [MESSAGES.c.n, MESSAGES.c.kind, MESSAGES.c.created_at, MESSAGES.c.text, MESSAGES.c.owner_translation,
               RUN_EVENTS.c.payload]
    shown = MESSAGES.c.n > after
    if audience == "owner":
        # each item's latest annotation past the cursor, and the triage of the attempt it shows (`SHOWN_ATTEMPT`)
        marks = MESSAGES.alias("marks")
        marked = select(marks.c.ref_id.label("message_id"), func.max(marks.c.n).label("cursor")).where(
            marks.c.copy_id == ids.copy_id, marks.c.session_id == ids.session_id, marks.c.kind == "annotation",
            marks.c.n > after).group_by(marks.c.ref_id).subquery()
        notes = MESSAGES.alias("notes")
        triage = select(notes.c.text).where(
            notes.c.copy_id == ids.copy_id, notes.c.session_id == ids.session_id, notes.c.kind == "triage",
            notes.c.ref_id == SHOWN_ATTEMPT).order_by(notes.c.n).limit(1).scalar_subquery()
        source = source.outerjoin(marked, marked.c.message_id == MESSAGES.c.message_id)
        columns += [marked.c.cursor, triage.label("triage")]
        shown = or_(shown, marked.c.cursor.is_not(None))
    rows = (await conn.execute(select(*columns).select_from(source).where(
        mine, MESSAGES.c.kind.in_(AUDIENCE_KINDS[audience]), shown).order_by(MESSAGES.c.n))).all()
    if audience == "visitor":
        return [TranscriptItem(n=row.n, kind=row.kind, created_at=row.created_at,
                               text=None if row.kind in EVENT_KINDS else row.text,
                               event=row.payload if row.kind in EVENT_KINDS else None) for row in rows]
    return [OwnerTranscriptItem(n=row.n, cursor=max(row.n, row.cursor or 0), kind=row.kind, created_at=row.created_at,
                                text=None if row.kind in UNTEXTED_KINDS else row.text,
                                event=row.payload if row.kind in EVENT_KINDS else None,
                                owner_translation=row.owner_translation, triage=_read_triage(row.triage),
                                owner_plain=None,
                                stopped_draft=_read_stopped_draft(row.text) if row.kind == "stopped_draft" else None)
            for row in rows]
