"""Triage summaries and owner translations (Plan 02b, Task 10; master plan, "Model cost and latency budget"): text
Claude writes for the owner alone, on `claude-haiku-5-5` at low effort.

- `triage_attempt`, the job a turn defers for each attempt the checkpoint stopped, as Safety counts them (a refusal
  when decided, or a reply of Claude's blocked for anything but a paused session): Haiku reads the attempt as the
  copy's kernel_ro views hold it (a decision's reason, tool and effects, with the words of the label Safety shows for
  why it was turned down when it has one; or a reply check's violations) and the session's last visitor or agent
  message, each wrapped, and answers a `Triage`. It is stored as an owner-only
  `triage` row (the `Triage` as JSON, `ref_id` the attempt as Safety names it: the decision's ID, or the reply entry's
  `seq`), with an `annotation` row for the transcript item it shows on, when there is one (a refusal's receipt, or
  for a blocked reply the handoff it ended in or, when Claude could rewrite it, its stopped draft). A replayed attempt
  and replayed words (recorded history, Plan 01d) are never read for one.
- `translate_message`, the job deferred for each visitor and agent message, and each reply of Claude's the kernel
  rendered in another language than English: Haiku reads the message, wrapped, and answers a `Translation`; one that
  isn't English becomes the row's `owner_translation`, with an `annotation` row (`store.set_owner_translation`).
  A replayed row (recorded history, Plan 01d) is never read for one.

Each holds only IDs and reads only the API's rows and the copy's kernel_ro views: no credential, no kernel call. Each
records its call's usage at once (`app.model_calls`, under the conversation's session); a call with no usable answer
(an error, a refusal, an answer that doesn't parse) stores nothing else, and isn't retried. Each try of a call gives
up after `ANNOTATION_TIMEOUT_S`, so a stalled one hands its worker slot back (`jobs`, "Two queues, two workers"). In
production neither calls the model once today's budget is spent. Both are idempotent: an attempt already triaged, or
a message already translated, asks nothing again.

What they write is for the owner's reads (`store.transcript`, Safety's attempts) and nothing else. No visitor event,
visitor transcript, A2A answer, approval card or model context carries it: `triage` and `annotation` rows are never
model-visible or a visitor's, and nothing here emits an event.
"""

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, TypeVar

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from desk.api.metrics import over_daily_budget, record_model_call
from desk.api.model import ModelClient, ModelRequest, ModelUnavailable
from desk.api.prompts import (
    MESSAGE_TAG,
    ROW_TAGS,
    STOPPED_ATTEMPT_TAG,
    TRANSLATION_SYSTEM,
    TRIAGE_SYSTEM,
    TURNED_DOWN_BECAUSE,
    Translation,
    Triage,
    wrap,
)
from desk.api.ro import KERNEL_RO, KernelRO, decision_replayed, replayed
from desk.api.store import (
    MESSAGES,
    NOT_REPLAYED,
    SHOWN_ATTEMPT,
    TRANSLATED_KINDS,
    WITH_EVENTS,
    Ids,
    append_message,
    blocks_text,
    lock_events,
    set_owner_translation,
    triaged,
)

logger = logging.getLogger(__name__)

ANNOTATION_MODEL = "claude-haiku-5-5"
ANNOTATION_TIMEOUT_S = 30.0          # each try of a job's model call (the SDK's own default waits ten minutes)
TRIAGE_ROUTE, TRANSLATION_ROUTE = "triage", "translation"
TRIAGE_MAX_TOKENS = 1000
TRANSLATION_MAX_TOKENS = 4000
SAID_KINDS = ("visitor_text", "agent_text")   # the words a triage reads, wrapped as in the conversation
RefKind = Literal["decision", "reply"]
Output = TypeVar("Output", bound=BaseModel)


@dataclass(frozen=True)
class Stopped:
    """An attempt the checkpoint stopped, as Safety names it: a refused decision (`ref_id` its ID), or a blocked reply
    of Claude's (`ref_id` its ledger entry's `seq`, as text)."""

    ref_kind: RefKind
    ref_id: str


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _user(text: str) -> dict:
    return {"role": "user", "content": [{"type": "text", "text": text}]}


async def _ask(engine: AsyncEngine, model: ModelClient, ids: Ids, request: ModelRequest,
               output: type[Output]) -> Output | None:
    """The route's answer as `output`, its usage recorded right after the call; None when there is no usable one."""
    try:
        response, failed = await model.call(request), False
    except ModelUnavailable as unavailable:
        response, failed = unavailable.response, True
    async with engine.connect() as conn:
        await record_model_call(conn, ids.copy_id, ids.session_id, request.route, response)
        await conn.commit()
    if failed or not isinstance(response.parsed, output):
        logger.info("a %s call gave no answer; nothing is stored", request.route)
        return None
    return response.parsed


async def _budget_spent(conn: AsyncConnection, production: bool, clock: Callable[[], datetime]) -> bool:
    return production and await over_daily_budget(conn, clock)


# Triage ------------------------------------------------------------------------------------------------------


async def _attempt(conn: AsyncConnection, ids: Ids, ref_id: str, ref_kind: RefKind,
                   ro_schema: str) -> dict[str, Any] | None:
    """The stopped attempt as Haiku reads it, from the copy's kernel_ro views: a refusal of this session's when
    decided, or a reply check of Claude's in this session blocked for anything but a pause; None for anything else,
    for an attempt the kernel replayed (its ledger entry marked `summary.replayed`: recorded history), and for one
    whose ledger entry can't be read, so an attempt of unknown origin never reaches the model."""
    from desk.api.owner_reads import refusal_cause, reply_violations  # owner reads also depends on the turn runner

    ro = KernelRO(conn, ids.copy_id, ro_schema)
    if ref_kind == "decision":
        row = await ro.one("decisions", decision_id=ref_id)
        if row is None or (row["desk_id"], row["session_id"], row["outcome"]) != (ids.desk_id, ids.session_id,
                                                                                   "refuse"):
            return None
        entry = None if row["ledger_seq"] is None else await ro.one("ledger_entries", desk_id=ids.desk_id,
                                                                     seq=row["ledger_seq"])
        if decision_replayed(row, entry):                 # replayed, or of unknown origin
            return None
        attempt = {"kind": "refused", "tool": row["tool"], "effects": list(row["effects"] or []),
                   "reason": row["reason_plain"]}
        # Why, in the words of the label Safety shows beside it, its first letter lowercased to follow "It was turned
        # down:", and none when Safety shows none. The cause reads the session's verification as Safety's attempts
        # do; it never clears (`refusal_cause`).
        session = await ro.session(ids.session_id)
        cause = None if session is None else refusal_cause(row, entry, verified=bool(session["verified"]))
        if cause in TURNED_DOWN_BECAUSE:
            label = TURNED_DOWN_BECAUSE[cause]
            attempt["turned_down_because"] = label[:1].lower() + label[1:]
        return attempt
    if ref_kind != "reply" or not (ref_id.isascii() and ref_id.isdigit()) or len(ref_id) > 18:
        return None
    entry = await ro.one("ledger_entries", desk_id=ids.desk_id, seq=int(ref_id))
    event = (entry or {}).get("event") or {}
    summary = event.get("summary") or {}
    violations = [{"kind": kind, "rule": rule} for kind, rule in reply_violations(summary)
                  if kind != "session_paused"]
    if (event.get("kind"), event.get("session_id"), summary.get("author")) != ("reply", ids.session_id, "claude"):
        return None
    if not violations or replayed(entry):
        return None
    return {"kind": "reply_blocked", "violations": violations}


async def _last_said(conn: AsyncConnection, ids: Ids) -> str | None:
    """The session's last live visitor or agent message, wrapped (a replayed one is never read); None before there
    is one."""
    row = (await conn.execute(select(MESSAGES.c.kind, MESSAGES.c.text).where(
        MESSAGES.c.copy_id == ids.copy_id, MESSAGES.c.session_id == ids.session_id,
        MESSAGES.c.kind.in_(SAID_KINDS), NOT_REPLAYED).order_by(MESSAGES.c.n.desc()).limit(1))).first()
    return None if row is None else wrap(ROW_TAGS[row.kind], row.text or "")


async def _shown_on(conn: AsyncConnection, ids: Ids, ref_id: str, ref_kind: RefKind) -> str | None:
    """The `message_id` of the transcript item the attempt shows on, as the owner's transcript reads it
    (`store.SHOWN_ATTEMPT`): a refusal's receipt, or for a blocked reply the handoff its check delivered or, when
    Claude could rewrite it, its stopped draft; None when nothing shows it."""
    kinds = ("status",) if ref_kind == "decision" else ("delivered", "stopped_draft")
    found = select(MESSAGES.c.message_id).select_from(WITH_EVENTS).where(
        MESSAGES.c.copy_id == ids.copy_id, MESSAGES.c.session_id == ids.session_id, MESSAGES.c.kind.in_(kinds),
        SHOWN_ATTEMPT == ref_id)
    return (await conn.execute(found.order_by(MESSAGES.c.n).limit(1))).scalar_one_or_none()


def triage_request(attempt: dict[str, Any], said: str | None) -> ModelRequest:
    """Haiku's request for a stopped attempt (`_attempt`) and the session's last words, already wrapped
    (`_last_said`)."""
    parts = [wrap(STOPPED_ATTEMPT_TAG, json.dumps(attempt, ensure_ascii=False, sort_keys=True)),
             *([said] if said else [])]
    return ModelRequest(route=TRIAGE_ROUTE, system=[{"type": "text", "text": TRIAGE_SYSTEM}],
                        messages=[_user("\n".join(parts))], model=ANNOTATION_MODEL, effort="low",
                        max_tokens=TRIAGE_MAX_TOKENS, output_schema=Triage, timeout_s=ANNOTATION_TIMEOUT_S)


async def triage_attempt(engine: AsyncEngine, model: ModelClient, ids: Ids, ref_id: str, ref_kind: RefKind, *,
                         ro_schema: str = KERNEL_RO, production: bool = False,
                         clock: Callable[[], datetime] = _utc_now) -> bool:
    """Triage one stopped attempt of the session (module docstring); True when a triage was stored."""
    async with engine.connect() as conn:
        attempt = await _attempt(conn, ids, ref_id, ref_kind, ro_schema)
        done = ref_id in await triaged(conn, ids.copy_id, session_id=ids.session_id)
        said = await _last_said(conn, ids)
        spent = attempt is not None and not done and await _budget_spent(conn, production, clock)
        await conn.commit()
    if attempt is None or done or spent:
        return False
    triage = await _ask(engine, model, ids, triage_request(attempt, said), Triage)
    if triage is None:
        return False
    if ref_kind == "reply":
        rules = {violation["rule"] for violation in attempt["violations"]}
        triage = triage.model_copy(update={"category": "other" if rules == {"soft.unavailable"} else "wording"})
    elif triage.category == "wording":
        triage = triage.model_copy(update={"category": "other"})
    async with engine.connect() as conn:
        try:
            await lock_events(conn, ids.session_id)            # one triage per attempt, decided under the lock
            if ref_id in await triaged(conn, ids.copy_id, session_id=ids.session_id):
                await conn.rollback()
                return False
            await append_message(conn, ids, "triage", text=triage.model_dump_json(), ref_id=ref_id)
            if (shown := await _shown_on(conn, ids, ref_id, ref_kind)) is not None:
                await append_message(conn, ids, "annotation", ref_id=shown)
            await conn.commit()
        except BaseException:
            await conn.rollback()
            raise
    return True


# Owner translations ------------------------------------------------------------------------------------------


async def translate_message(engine: AsyncEngine, model: ModelClient, copy_id: str, message_id: str, *,
                            production: bool = False, clock: Callable[[], datetime] = _utc_now) -> bool:
    """Translate one visitor, agent or Claude message for the owner (module docstring); True when a translation was
    stored. A reply the kernel rendered in English, a replayed row, and any other row, ask nothing."""
    async with engine.connect() as conn:
        row = (await conn.execute(select(
            MESSAGES.c.desk_id, MESSAGES.c.session_id, MESSAGES.c.kind, MESSAGES.c.author, MESSAGES.c.text,
            MESSAGES.c.blocks, MESSAGES.c.language, MESSAGES.c.owner_translation).where(
            MESSAGES.c.copy_id == copy_id, MESSAGES.c.message_id == message_id,
            MESSAGES.c.kind.in_(TRANSLATED_KINDS), NOT_REPLAYED))).first()
        text = None
        if row is not None and row.owner_translation is None:
            if row.kind != "delivered":
                text = row.text
            elif row.author == "claude" and row.language != "en":
                text = blocks_text(row.blocks or [])
        spent = bool(text and text.strip()) and await _budget_spent(conn, production, clock)
        await conn.commit()
    if not (text and text.strip()) or spent:
        return False
    ids = Ids(copy_id=copy_id, desk_id=row.desk_id, session_id=row.session_id)
    request = ModelRequest(route=TRANSLATION_ROUTE, system=[{"type": "text", "text": TRANSLATION_SYSTEM}],
                           messages=[_user(wrap(MESSAGE_TAG, text))], model=ANNOTATION_MODEL, effort="low",
                           max_tokens=TRANSLATION_MAX_TOKENS, output_schema=Translation,
                           timeout_s=ANNOTATION_TIMEOUT_S)
    translation = await _ask(engine, model, ids, request, Translation)
    if translation is None or translation.language == "en" or not translation.translation.strip():
        return False
    async with engine.connect() as conn:
        try:
            written = await set_owner_translation(conn, ids, message_id, translation.translation)
            await conn.commit()
        except BaseException:
            await conn.rollback()
            raise
    return written
