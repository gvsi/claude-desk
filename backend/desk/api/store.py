"""The transcript store (`app.messages`): append-only conversations and the model input built from them.

Rows are never edited or deleted. The only later writes are a pending row's place in the model's history
(`model_context`, `model_seq`, set once), a pending row's `wake` cleared when a paused session hands off
(`clear_wake`), and an owner translation. Every function runs in the caller's transaction and never commits.

What the model sees (Plan 02a, "Transcript contract"):

- A model context is the session's rows with a `model_seq` in the current `model_context`, in order. It
  opens with a `context_start` row holding its frozen `tools` and, after the first context, a summary of
  the conversation so far built by code.
- A row the model will see is written with its frozen block (`model_content`): untrusted text only inside
  a wrapper (`wrap`), with `&`, `<` and `>` escaped, so no text can close its wrapper or open another.
  It waits with a null `model_seq` until the next model call, when `prepare_model_input` gives it one.
  Pending work is a waiting row with `wake`.
- Assistant rows replay their content unchanged, thinking included. The rows between two of them merge
  into one user message, `tool_result` blocks first; pending tool changes then form one `role: "system"`
  message, always last before the assistant turn and never the first message.
- Each assistant response is written before any of its tool calls runs, and its results row (each
  `tool_use` answered once, in block order) follows. Until then `prepare_model_input` raises
  `UnansweredToolUse`, so an action that ran is recovered by its call ID, never proposed again.

Model-visible kinds and their wrappers: `visitor_text` <visitor_message>, `agent_text` <agent_message>,
`owner_say` <owner_said_to_visitor>, `whisper` <owner_whisper> (an untrusted owner note in the user turn,
never system text), `action_update` <action_update decision_id state>, `desk_context` <desk_context>,
`note` <note>, and a `delivered` row whose author is the Desk <shown_to_visitor>. Claude's own delivered
replies are replayed through its `send_reply` calls; an owner's say reaches the model through its
`owner_say` row. `status` and `triage` rows are never model-visible.
"""

import hashlib
import json
import re
import secrets
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import and_, func, insert, or_, select, update
from sqlalchemy.ext.asyncio import AsyncConnection

from desk.api.schemas import OwnerTranscriptItem, TranscriptItem
from desk.contracts import RenderedBlock
from desk.db.models import Message, RunEvent

MESSAGES = Message.__table__
RUN_EVENTS = RunEvent.__table__
SUMMARY_TAG = "conversation_so_far"
_TAG = re.compile(r"^[a-z_]+$")


@dataclass(frozen=True)
class Ids:
    """The copy, Desk and session a request works in, taken only from a kernel answer (`/whoami`)."""

    copy_id: str
    desk_id: str
    session_id: str


@dataclass(frozen=True)
class ModelInput:
    tools: list[dict]
    messages: list[dict]


@dataclass(frozen=True)
class OpenToolUse:
    """An assistant row whose `tool_use` blocks have no results row yet, and the session generation its turn made
    them at (the kernel keys a call's decision by it)."""

    assistant_n: int
    tool_uses: list[dict]
    generation: int


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
    tag: str | None               # the wrapper of the frozen block the model sees, if any
    wake: bool                    # pending work by default


ROW_KINDS: dict[str, _Kind] = {
    "visitor_text": _Kind("visitor", "public", "visitor_message", True),
    "agent_text": _Kind("agent", "public", "agent_message", True),
    "owner_say": _Kind("owner", "model", "owner_said_to_visitor", False),
    "whisper": _Kind("owner", "owner", "owner_whisper", True),
    "action_update": _Kind("api", "model", "action_update", True),
    "desk_context": _Kind("api", "model", "desk_context", False),
    "note": _Kind("api", "model", "note", False),
    "delivered": _Kind(None, "public", "shown_to_visitor", False),
    "status": _Kind("desk", "public", None, False),
    "triage": _Kind("api", "owner", None, False),
}
TEXT_KINDS = frozenset({"visitor_text", "agent_text", "owner_say", "whisper", "desk_context", "note",
                        "action_update", "triage"})
DELIVERY_AUTHORS = frozenset({"claude", "owner", "desk"})
COLUMNS = frozenset({"author", "text", "blocks", "language", "owner_translation", "wake", "ref_id", "call_id",
                     "event_seq"})


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def wrap(tag: str, text: str, **attributes: str) -> str:
    """`text` inside `<tag ...>`, with `&`, `<` and `>` escaped (and `"` in attribute values)."""
    if not _TAG.match(tag) or not all(_TAG.match(name) for name in attributes):
        raise ValueError("wrapper tags and attribute names are lowercase words")
    attrs = "".join(f' {name}="{_escape(str(value)).replace(chr(34), "&quot;")}"' for name, value in attributes.items())
    return f"<{tag}{attrs}>{_escape(text)}</{tag}>"


def lock_key(name: str) -> int:
    """A Postgres advisory lock key: the first 8 bytes of sha256(name), as a signed bigint."""
    return int.from_bytes(hashlib.sha256(name.encode()).digest()[:8], "big", signed=True)


async def _lock_transcript(conn: AsyncConnection, session_id: str) -> None:
    """Serialize the session's `model_seq` assignments until the transaction ends."""
    await conn.execute(select(func.pg_advisory_xact_lock(lock_key("transcript:" + session_id))))


def blocks_text(blocks: Sequence[RenderedBlock | dict]) -> str:
    return "\n".join(RenderedBlock.model_validate(block).text for block in blocks)


def _text_block(text: str) -> dict:
    return {"type": "text", "text": text}


def _frozen_block(kind: str, values: dict[str, Any], state: str | None) -> dict | None:
    """The block the model will see for a new row, or None when the model never sees it."""
    tag = ROW_KINDS[kind].tag
    if kind == "action_update":
        return _text_block(wrap(tag, values["text"], decision_id=values["ref_id"], state=state))
    if kind == "delivered":
        return _text_block(wrap(tag, blocks_text(values["blocks"]))) if values["author"] == "desk" else None
    return _text_block(wrap(tag, values["text"])) if tag else None


def _new_message_id() -> str:
    return "m-" + secrets.token_hex(12)


async def _insert(conn: AsyncConnection, ids: Ids, **values: Any) -> int:
    row = {"message_id": _new_message_id(), "copy_id": ids.copy_id, "desk_id": ids.desk_id,
           "session_id": ids.session_id, **values}
    return (await conn.execute(insert(MESSAGES).values(**row).returning(MESSAGES.c.n))).scalar_one()


async def append_message(conn: AsyncConnection, ids: Ids, kind: str, *, state: str | None = None,
                         **columns: Any) -> int:
    """Append a transcript row and return its `n`. A row the model will see is written with its frozen block
    and waits for the next model call. `state` (the decision's) is required for an `action_update`, whose
    `ref_id` is the decision and `text` its `visitor_plain`. Context, tool-change and model rows have their
    own functions."""
    spec = ROW_KINDS.get(kind)
    if spec is None:
        raise ValueError(f"append_message doesn't write {kind!r} rows")
    if unknown := set(columns) - COLUMNS:
        raise TypeError(f"not app.messages columns: {sorted(unknown)}")
    values = {"author": spec.author, "wake": spec.wake, "text": None, "ref_id": None, "blocks": None, **columns}
    if spec.author is not None and values["author"] != spec.author:
        raise ValueError(f"a {kind} row's author is {spec.author}")
    if kind in TEXT_KINDS and not isinstance(values["text"], str):
        raise ValueError(f"a {kind} row has text")
    if kind == "action_update" and not (values["ref_id"] and state):
        raise ValueError("an action_update names its decision (ref_id) and state")
    if kind != "action_update" and state is not None:
        raise ValueError("only an action_update has a state")
    if kind == "delivered" and (values["author"] not in DELIVERY_AUTHORS or values["blocks"] is None):
        raise ValueError("a delivered row has blocks and an author: claude, owner or desk")
    return await _insert(conn, ids, kind=kind, visibility=spec.visibility,
                         model_content=_frozen_block(kind, values, state), **values)


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


async def _pending(conn: AsyncConnection, session_id: str) -> list[Any]:
    """Rows the model hasn't been sent yet, in the order they were written."""
    return list(await conn.execute(select(MESSAGES.c.n, MESSAGES.c.kind).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.model_seq.is_(None),
        MESSAGES.c.model_content.is_not(None)).order_by(MESSAGES.c.n)))


async def unanswered_tool_use(conn: AsyncConnection, session_id: str) -> OpenToolUse | None:
    """The session's last assistant row, when it has `tool_use` blocks and no results row follows it."""
    last = (await conn.execute(select(MESSAGES.c.n, MESSAGES.c.model_seq, MESSAGES.c.model_content,
                                      MESSAGES.c.generation).where(
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
    return None if answered else OpenToolUse(assistant_n=last.n, tool_uses=tool_uses, generation=last.generation)


async def delivered_reply(conn: AsyncConnection, session_id: str, call_id: str) -> Any | None:
    """What Claude's `send_reply` call `call_id` put on the visitor's screen: its `delivered` row's kernel message ID
    (`ref_id`) and `blocks`, or None when nothing was shown for that call."""
    return (await conn.execute(select(MESSAGES.c.ref_id, MESSAGES.c.blocks).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.kind == "delivered", MESSAGES.c.call_id == call_id)
        .order_by(MESSAGES.c.n).limit(1))).first()


async def _refuse_open_tool_use(conn: AsyncConnection, session_id: str) -> None:
    if (open_tool_use := await unanswered_tool_use(conn, session_id)) is not None:
        raise UnansweredToolUse(open_tool_use)


def _summary_line(row: Any) -> str:
    if row.kind == "delivered":
        label, text = f"{row.author} (shown to the visitor)", blocks_text(row.blocks or [])
    elif row.kind == "action_update":
        label, text = "action_update", row.text
    else:
        label, text = row.author, row.text
    return f"{label}: {_escape(' '.join((text or '').splitlines()))}"


async def _summary(conn: AsyncConnection, session_id: str) -> str:
    """The conversation so far, by code: texts, delivered blocks (says included) and action updates, each on one
    labelled, escaped line. Rows still waiting for the model are left out; they follow it in full."""
    rows = await conn.execute(select(MESSAGES.c.kind, MESSAGES.c.author, MESSAGES.c.text, MESSAGES.c.blocks).where(
        MESSAGES.c.session_id == session_id,
        MESSAGES.c.kind.in_(("visitor_text", "agent_text", "delivered", "action_update")),
        ~and_(MESSAGES.c.model_seq.is_(None), MESSAGES.c.model_content.is_not(None)),
    ).order_by(MESSAGES.c.n))
    lines = [_summary_line(row) for row in rows]
    return "\n".join([f"<{SUMMARY_TAG}>", *lines, f"</{SUMMARY_TAG}>"])


async def start_fresh_context(conn: AsyncConnection, ids: Ids, tools: list[dict]) -> int:
    """Open a new model context with these frozen tools and, after the first context, the code-built summary.

    What the old context was still waiting for closes it unsent: tool changes (the new tools supersede them)
    and says (the summary carries them, from their delivered rows). The last desk context is stated again,
    since the facts Claude cites must be in the context it answers from."""
    await _lock_transcript(conn, ids.session_id)
    await _refuse_open_tool_use(conn, ids.session_id)
    current = await _current_context(conn, ids.session_id)
    summary = None
    if current is not None:
        closing = [row.n for row in await _pending(conn, ids.session_id) if row.kind in ("tool_change", "owner_say")]
        await _place(conn, closing, current, await _next_seq(conn, ids.session_id))
        summary = await _summary(conn, ids.session_id)
        facts = (await conn.execute(select(MESSAGES.c.text, MESSAGES.c.model_seq).where(
            MESSAGES.c.session_id == ids.session_id, MESSAGES.c.kind == "desk_context")
            .order_by(MESSAGES.c.n.desc()).limit(1))).first()
        if facts is not None and facts.model_seq is not None:
            await append_message(conn, ids, "desk_context", text=facts.text)
    return await _insert(conn, ids, kind="context_start", author="api", visibility="model",
                         model_context=0 if current is None else current + 1,
                         model_seq=await _next_seq(conn, ids.session_id),
                         model_content={"tools": tools, "summary": summary})


async def context_tools(conn: AsyncConnection, session_id: str) -> tuple[list[dict], list[tuple[str, str]]] | None:
    """The current model context's tools as its `context_start` row froze them, and its tool changes since, as
    (`tool_addition` or `tool_removal`, tool name) in order, those waiting for the next call included; None before
    the session's first context."""
    current = await _current_context(conn, session_id)
    if current is None:
        return None
    start = (await conn.execute(select(MESSAGES.c.model_content).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.kind == "context_start",
        MESSAGES.c.model_context == current))).scalar_one()
    changes = await conn.execute(select(MESSAGES.c.model_content).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.kind == "tool_change",
        or_(MESSAGES.c.model_context == current, MESSAGES.c.model_seq.is_(None))).order_by(MESSAGES.c.n))
    return start["tools"], [(change["type"], change["tool"]["name"]) for (change,) in changes]


async def prepare_model_input(conn: AsyncConnection, session_id: str) -> ModelInput:
    """Give the waiting rows their place (user-turn rows, then tool changes) and build the current context's
    request: its frozen tools and messages. Raises `UnansweredToolUse` while a tool call has no result."""
    await _lock_transcript(conn, session_id)
    current = await _current_context(conn, session_id)
    if current is None:
        raise NoModelContext(session_id)
    await _refuse_open_tool_use(conn, session_id)
    pending = await _pending(conn, session_id)
    ordered = [row.n for row in pending if row.kind != "tool_change"] + [
        row.n for row in pending if row.kind == "tool_change"]
    await _place(conn, ordered, current, await _next_seq(conn, session_id))

    rows = await conn.execute(select(MESSAGES.c.kind, MESSAGES.c.model_content).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.model_context == current).order_by(MESSAGES.c.model_seq))
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
            tools = row.model_content["tools"]
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
    return ModelInput(tools=tools, messages=messages)


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


async def latest_pending(conn: AsyncConnection, session_id: str) -> int | None:
    """The `n` of the session's latest pending row (`has_pending`), or None when no work is waiting."""
    return (await conn.execute(select(func.max(MESSAGES.c.n)).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.model_seq.is_(None), MESSAGES.c.wake,
        MESSAGES.c.model_content.is_not(None)))).scalar_one()


async def clear_wake(conn: AsyncConnection, session_id: str) -> int:
    """Stop the session's pending work from starting turns (a paused session hands off instead); the rows still wait
    for the model and reach it at its next call. Returns how many rows it cleared."""
    cleared = await conn.execute(update(MESSAGES).where(
        MESSAGES.c.session_id == session_id, MESSAGES.c.model_seq.is_(None), MESSAGES.c.wake).values(wake=False))
    return cleared.rowcount



# Read models ---------------------------------------------------------------------------------------------

AUDIENCE_KINDS = {
    "visitor": ("visitor_text", "delivered", "status"),
    "owner": ("visitor_text", "agent_text", "delivered", "status", "whisper"),
}


async def transcript(conn: AsyncConnection, ids: Ids, audience: str, after: int = 0) -> list[TranscriptItem]:
    """The session's transcript after the cursor `after`, as `audience` (visitor or owner) may see it. A visitor
    sees their own words and what was delivered to them (each with its stored event); the owner also sees agent
    text and whispers, with AI-written translations and triage. Model rows, notes, context and tool-change rows
    are never items."""
    if audience not in AUDIENCE_KINDS:
        raise ValueError("a transcript is the visitor's or the owner's")
    rows = (await conn.execute(
        select(MESSAGES.c.n, MESSAGES.c.kind, MESSAGES.c.created_at, MESSAGES.c.text, MESSAGES.c.ref_id,
               MESSAGES.c.owner_translation, RUN_EVENTS.c.payload)
        .select_from(MESSAGES.outerjoin(RUN_EVENTS, and_(
            RUN_EVENTS.c.session_id == MESSAGES.c.session_id, RUN_EVENTS.c.kind == "sse",
            RUN_EVENTS.c.seq == MESSAGES.c.event_seq)))
        .where(MESSAGES.c.copy_id == ids.copy_id, MESSAGES.c.session_id == ids.session_id,
               MESSAGES.c.kind.in_(AUDIENCE_KINDS[audience]), MESSAGES.c.n > after)
        .order_by(MESSAGES.c.n))).all()
    delivered = ("delivered", "status")
    if audience == "visitor":
        return [TranscriptItem(n=row.n, kind=row.kind, created_at=row.created_at,
                               text=None if row.kind in delivered else row.text,
                               event=row.payload if row.kind in delivered else None) for row in rows]
    triage = {row.ref_id: row.text for row in await conn.execute(
        select(MESSAGES.c.ref_id, MESSAGES.c.text).where(
            MESSAGES.c.session_id == ids.session_id, MESSAGES.c.kind == "triage").order_by(MESSAGES.c.n))}
    return [OwnerTranscriptItem(n=row.n, kind=row.kind, created_at=row.created_at,
                                text=None if row.kind in delivered else row.text,
                                event=row.payload if row.kind in delivered else None,
                                owner_translation=row.owner_translation,
                                triage=triage.get(row.ref_id) if row.ref_id else None) for row in rows]
