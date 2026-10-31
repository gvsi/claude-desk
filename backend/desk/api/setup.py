"""Setup (Plan 02b, Tasks 6 and 7): the owner's description, the Desk, the memory and website reads and the questions
(part 1); then the Desk's parts, its rule cards, the situations and safety check tried against them, the confirm and
going live (part 2, from "Setup, part 2" below).

An interview (`app.setup_interviews`, one row per interview, copy-scoped) runs in three kinds of request:

- **Start** (`start`): one structured model call reads the owner's description (`SetupStart`), then the kernel makes
  the Desk (`POST /desks`, which activates the `ask_first` preset: its auto cards cover the setup tools) and turns
  Answering off, so nothing answers the public until setup takes the Desk live (tried twice; a Desk that stays
  answering is deleted, and the request answers the kernel's error). Claude then asks for consent. A start sent with
  the client's `idempotency_key` writes the interview's row first, holding the key and its body's hash, with no Desk
  yet (a read of it is 404 meanwhile); a unique index on `(copy_id, idempotency_key)` lets one row in a copy hold a
  key. A start that fails before the kernel is asked for the Desk (Claude couldn't answer, say) deletes its row, since
  nothing was made, so the same request can be sent again; once the Desk was asked for, the row keeps the outcome,
  a failure too (`start_error`). A repeat (`repeated_start`) finds the row and answers its interview as it stands,
  with nothing made: 409 `conflict` for another body, the stored failure again when the first failed, and while the
  first is still starting, 409 `in_progress` at once (`retry_after` 2 s), holding nothing while the client waits;
  a row still starting after the longest a start can take (`START_ABANDONED_S`) is abandoned, and a repeat deletes it.
  The lookup, the limits and the claim run under the key's lock in this process (`ADMISSIONS`), so a concurrent
  repeat waits for the first's admission and is never counted; another process's repeat meets the unique index
  instead. A start without a key writes its row last.
- **Consent** (`consent`): stored once. On yes, the owner's Claude memory is searched (`native.read_memory`), then
  the website read (`native.fetch_website`) when the description named one; then the first question. On no, no
  memory or website read ever runs for the interview, and a website the owner names later is kept as text.
- **Answer** (`answer`): one structured model call over the business type, the question asked, the answers so far
  and the wrapped memory, website and owner's answer, answered in that question's own model (`SETUP_TURNS`). Its
  patch merges into the answers. Each limit (the quote, discount and payment link limits, the documents rule, the
  money cap and the refunds rule, which is the money question's: refunds are money going out) is a field only of its
  own question's model, whose message leaves the memory and website out, and code drops it from any other turn's
  patch too, so no other turn, and nothing the website or memory says, can set it. A limit question's model has no
  fact either (its turn reads none of the facts so far), and code drops a fact from a limit turn's patch too, but for
  the quote question's prices, named from the owner's answer alone (the turn reads no price list): code updates the
  item of each title or adds it, never removing one. A fact question clears the hours or the prices only by its
  flag, since an empty list leaves them as they are. A new website is read only with consent; a new owner or business
  name goes to the kernel (`PUT /desks/{id}/business`). Once the last question is answered, the interview moves on to
  step `tools`.

Each setup tool call is an owner call on the new Desk (`run_setup_tool`): the tool must be in the owner's `/context`,
then `/decide`, and `/execute` only on an allow. A read that is held, refused or fails doesn't stop setup: its inline
label says it couldn't. What a read returned is kept in the transcript (for later turns, as untrusted text), never
shown to the owner beyond its label, and reaches the model only inside a wrapper (`prompts.wrap`).

Model calls use route `setup` on `claude-opus-5-5` at low effort, each bounded by `SETUP_TIMEOUT_S` (the SDK's
retries included) and recorded right after it returns. An answer that doesn't fit its model gets one retry with the
errors; then the request is 503 `model_unavailable` and nothing of it is stored. An answer that stopped before it
finished (`max_tokens`, say), or a call that ran out of time, is 503 at once, whatever its text.

No transaction waits on the model, a read or the kernel. A consent or an answer reads the interview, does its work, then
locks the row only to check that nothing changed since its read and to save (409 `conflict` when something did, with
nothing saved); every row lock is waited for at most `LOCK_TIMEOUT`, then 409 too. While one runs, another for the same
interview is 409 at once in this process, before any model call or read (another process's is caught when it saves).
An answer names the question it answers (409 when another is waiting), so two answers can't both answer one question
and an answer sent twice can't answer the next.

Part 2 runs through the proving routes (`desk.api.proving`). The rules step puts the Desk's parts on the kernel
(`seed_parts`, by code from the answers), has Claude draft rule cards (route `card_draft`), which code checks (a target
the Desk offers, the contract's limits, the answered limits and money cap, the owner's "never" answers, no money going
out on its own), stores them, and posts them after the Ask me first preset's utility cards to `POST /policy/draft`,
which compiles and proves them. Cards code can't use, or that the kernel refuses as invalid (naming no card), get
Claude's one retry, then the template cards. A re-post sends the stored cards and never drafts again; a rejected proof,
or stored cards the kernel refuses, fall back to the template cards once. The situations (route `situations`) and the
safety check (`SAFETY_PROBES`) are probes the kernel decides against the draft, running nothing. The confirm activates
the draft with Answering still off, and going live turns it on.
"""

import asyncio
import contextlib
import inspect
import json
import logging
import re
import secrets
import unicodedata
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, time, timedelta
from time import monotonic
from typing import Literal, TypeVar, cast, get_args
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from psycopg.errors import LockNotAvailable
from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy import Interval, delete, func, insert, literal, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import OperationalError
from sqlalchemy.sql import Executable
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from desk.api.deps import ApiProblem, OwnerCtx
from desk.api.idempotency import Admissions, body_sha256
from desk.api.kernel_client import DEFAULT_TIMEOUT_S, KernelFailed, KernelUnavailable
from desk.api.metrics import record_model_call
from desk.api.model import (
    CONVERSATION_MODEL,
    Effort,
    ModelClient,
    ModelRequest,
    ModelResponse,
    ModelUnavailable,
    parse_structured,
)
from desk.api.prompts import (
    ANSWERS_SO_FAR_TAG,
    ANSWERS_TAG,
    CARD_DRAFT_SYSTEM,
    CARD_ERROR_LINE,
    CARD_ERRORS,
    CARDS_REFUSED,
    DRAFT_RETRY,
    LIMIT_QUESTIONS,
    LIMIT_TURN_FACTS,
    MEMORY_TAG,
    OWNER_ANSWER_TAG,
    OWNER_DESCRIPTION_TAG,
    PRICE_ITEMS_MAX,
    PRICES_TAG,
    QUESTION_KEYS,
    RULES_TAG,
    SETUP_RETRY,
    SETUP_START_SYSTEM,
    SETUP_TURN_SYSTEM,
    SETUP_TURNS,
    SITUATIONS_HEAD,
    SITUATIONS_SYSTEM,
    TOOLS_TAG,
    BusinessType,
    DraftedRules,
    DraftedSituations,
    PlannedOutcome,
    PriceAnswer,
    QuestionKey,
    RuleCardDraft,
    SetupAnswers,
    SetupPatch,
    SetupStart,
    SituationDraft,
    card_draft_head,
    question_text,
    setup_turn_head,
    wrap,
    wrap_website,
)
from desk.api.proving import AnswerError
from desk.api.ro import KernelRO
from desk.api.schemas import (
    OWNER_NAME_CHARS,
    RulesDraft,
    SafetyCheck,
    SafetyRow,
    SetupMessage,
    SetupStartIn,
    SetupState,
    SetupStep,
    SetupTools,
    Situation,
    SituationResult,
    ToolRow,
    WentLive,
)
from desk.api.setup_templates import SAFETY_PROBES, SafetyProbe, template_cards
from desk.api.versions import (
    active_row,
    checkable,
    connect_payments,
    post_draft,
    rules_draft,
    tool_rows,
    version_from_row,
)
from desk.contracts import (
    MCP_TOOLS,
    MONEY_TOOLS,
    BusinessSeed,
    CalendarSlot,
    Claim,
    DeskSeed,
    Effect,
    ExecResult,
    HoursWindow,
    NotificationDefaults,
    PolicyVersion,
    PriceItem,
    Probe,
    ProbeResult,
    RuleCard,
    ToolCall,
)
from desk.db.models import SetupInterview
from desk.kernel_api import (
    CreateDeskRequest,
    DecideRequest,
    DeskAnsweringRequest,
    DeskBusinessRequest,
    DeskCalendarRequest,
    DeskCharterRequest,
    DeskHoursRequest,
    DeskNotificationsRequest,
    DeskPricesRequest,
    ExecuteRequest,
    PolicyConfirmRequest,
    PolicyProbeRequest,
)
from desk.presets import PRESETS

logger = logging.getLogger(__name__)

INTERVIEWS = SetupInterview.__table__
ROUTE = "setup"
START_MAX_TOKENS = 2048
TURN_MAX_TOKENS = 4096
# The most one structured setup call may take, the SDK's retries included (and each of its tries): a stalled call ends
# as 503 `model_unavailable` instead of holding the owner's request. A rules chat has its own (`rules.CHAT_TIMEOUT_S`).
SETUP_TIMEOUT_S = 60.0
LOCK_TIMEOUT = "5s"              # the most an interview write waits for the row's lock (then 409 `conflict`)
START_RETRY_S = 2               # when to send a repeat again that found its first still starting (409 `in_progress`)
ADMISSIONS = Admissions()       # a keyed start's lookup, limits and claim, one at a time per (copy, key)
# The longest a start can run: Claude's reading of the description and its one retry, each bounded by
# `SETUP_TIMEOUT_S`, then its kernel calls (`POST /desks`, two tries at turning Answering off and the `DELETE` when
# both fail), each bounded by the kernel client's timeout, with a minute's slack for the database and the process. A
# keyed row still starting after this is abandoned: its request stopped.
START_KERNEL_CALLS = 4
START_ABANDONED_S = 2 * SETUP_TIMEOUT_S + START_KERNEL_CALLS * DEFAULT_TIMEOUT_S + 60
_STALE = INTERVIEWS.c.created_at < func.now() - literal(timedelta(seconds=START_ABANDONED_S), Interval())
DESK_NAME = "Main line"
MEMORY_QUERY = "business services prices hours area contact website"
READ_TEXT_MAX = 8000             # what a read keeps for later turns: the website tool's own model_view cut
URL_MAX = 2048                   # the website tool's url argument
OWNER_NAME_MAX = 40
OWNER_NAME_FALLBACK = "Owner"
# Outside Plan 01a's owner_display_name pattern (`OWNER_NAME_PATTERN`): dropped from a name.
_OUTSIDE_OWNER_NAME = re.compile(rf"[^{OWNER_NAME_CHARS}]")
_HOST = re.compile(r"[a-z0-9.-]{1,253}")

# Owner-facing copy the API composes: sentence case, plain, no arrows or exclamation marks.
CONSENT_QUESTION = ("Can I look at your Claude memory and your website to fill in what I can? If you'd rather not, "
                    "you can type it all in.")
CONSENT_ANSWERS = {True: "Yes, use it", False: "No, I'll type it"}
MEMORY_LABEL = "Searched your Claude memory"
MEMORY_FAILED_LABEL = "Couldn't search your Claude memory"
WEBSITE_LABEL = "Read {host}"
WEBSITE_PAGES_LABEL = "Read {host}, {pages} pages"
WEBSITE_FAILED_LABEL = "Couldn't read {host}"
QUESTIONS_DONE = "That's everything I need to ask. Next, the tools your Desk can use."

# Each limit is taken only on the turn answering its own question (`LIMIT_QUESTIONS`), whose message carries the
# owner's answer with no memory or website beside it and whose model alone has the field; a patch that carries it on
# any other turn has it dropped and logged (by these labels, never its value), so no other turn's answer, and nothing
# the memory or the website says, can set it.
LIMIT_LABELS = {"quote_auto_max_cents": "a quote limit", "discount_auto_max_bp": "a discount limit",
                "payment_link_auto_max_cents": "a payment link limit", "documents": "a documents rule",
                "auto_money_cap_cents": "a money cap", "refunds": "a refunds rule"}

Record = Callable[[ModelResponse], Awaitable[None]]
Output = TypeVar("Output", bound=BaseModel)


# Names and defaults ----------------------------------------------------------------------------------------------


def reduce_name(text: str | None) -> str:
    """`text` reduced to Plan 01a's owner name pattern: other characters dropped, spaces collapsed and trimmed, cut
    to 40; "" when nothing is left."""
    kept = " ".join(_OUTSIDE_OWNER_NAME.sub("", text or "").split())
    return kept[:OWNER_NAME_MAX].strip()


def owner_name(given: str | None, described: str | None, business_name: str) -> str:
    """The name customers see for the owner: the one the owner gave, else the one their description gave, else the
    business name, each reduced to the kernel's pattern; "Owner" when all reduce to nothing."""
    for candidate in (given, described, business_name):
        reduced = reduce_name(candidate)
        if reduced:
            return reduced
    return OWNER_NAME_FALLBACK


def default_notifications(business_type: BusinessType) -> NotificationDefaults:
    """What alerts the owner at once and what waits for the briefing: a trade is also alerted to emergencies."""
    now = ["approval", "breaker", "lockout"] + (["emergency"] if business_type == "trade" else [])
    return NotificationDefaults(now=now, briefing=["lead", "callback", "booking"])


def website_url(text: str | None) -> tuple[str, str] | None:
    """(url, host) of a website the owner named, as the fetch tool takes it (`https://` added when no scheme is
    given), or None for anything that isn't an http(s) address with a plain host name. The kernel's fetch guard
    decides what may be fetched; this only shapes the argument and the label."""
    candidate = (text or "").strip()
    if not candidate:
        return None
    if "://" not in candidate:
        candidate = "https://" + candidate
    if len(candidate) > URL_MAX:
        return None
    try:
        parts = urlsplit(candidate)
        host = parts.hostname
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not host or not _HOST.fullmatch(host):
        return None
    return candidate, host


# The transcript ----------------------------------------------------------------------------------------------------


class Entry(BaseModel):
    """One stored line of an interview: what the owner sees (`role`, `text`), and for code alone, the question a
    Claude line asks, the read a label stands for and what it returned (untrusted text, for later turns), and a
    website the line named or read."""

    model_config = ConfigDict(extra="forbid")

    role: Literal["claude", "owner", "tool_label"]
    text: str
    question: Literal["consent"] | QuestionKey | None = None
    read: Literal["memory", "website"] | None = None
    content: str | None = None
    website: str | None = None


@dataclass
class Interview:
    interview_id: str
    copy_id: str
    desk_id: str
    business_type: BusinessType
    step: SetupStep
    consent: bool | None
    answers: SetupAnswers
    transcript: list[Entry]
    draft_cards: list[RuleCard] = field(default_factory=list)   # setup's own cards for its rules draft, once drafted
    draft_version: int | None = None                            # the kernel's version of the last rules draft

    @property
    def question(self) -> QuestionKey | None:
        """The question waiting for an answer: the last one asked, from consent until the questions step ends."""
        if self.step != "questions" or self.consent is None:
            return None
        asked = [entry.question for entry in self.transcript if entry.question in QUESTION_KEYS]
        return asked[-1] if asked else None

    def tried_websites(self) -> set[str]:
        return {entry.website for entry in self.transcript if entry.read == "website" and entry.website}


async def _load(conn: AsyncConnection, copy_id: str, interview_id: str, *, lock: bool = False) -> Interview:
    """The copy's interview, locked for the transaction when `lock` (waiting at most `LOCK_TIMEOUT` for another
    transaction's lock, then 409 `conflict`); 404 when the copy has none by that ID."""
    query = select(INTERVIEWS).where(INTERVIEWS.c.interview_id == interview_id, INTERVIEWS.c.copy_id == copy_id)
    if lock:
        await conn.execute(select(func.set_config("lock_timeout", LOCK_TIMEOUT, True)))
        query = query.with_for_update()
    try:
        row = (await conn.execute(query)).mappings().one_or_none()
    except OperationalError as failed:
        if isinstance(failed.orig, LockNotAvailable):
            raise ApiProblem(409, "conflict") from None
        raise
    if row is None or row["desk_id"] is None:
        raise ApiProblem(404, "not_found")
    return Interview(interview_id=row["interview_id"], copy_id=row["copy_id"], desk_id=row["desk_id"],
                     business_type=row["business_type"], step=row["step"], consent=row["consent"],
                     answers=SetupAnswers.model_validate(row["answers"]),
                     transcript=[Entry.model_validate(entry) for entry in row["transcript"]],
                     draft_cards=[RuleCard.model_validate(card) for card in row["draft_cards"] or []],
                     draft_version=row["draft_version"])


def _stored(interview: Interview) -> dict:
    return {"step": interview.step, "consent": interview.consent,
            "answers": interview.answers.model_dump(mode="json"),
            "transcript": [entry.model_dump(mode="json", exclude_none=True) for entry in interview.transcript],
            "draft_cards": [card.model_dump(mode="json") for card in interview.draft_cards],
            "draft_version": interview.draft_version}


async def _save(conn: AsyncConnection, interview: Interview) -> None:
    await conn.execute(update(INTERVIEWS).where(INTERVIEWS.c.interview_id == interview.interview_id)
                       .values(**_stored(interview), updated_at=func.now()))


async def _read(engine: AsyncEngine, owner: OwnerCtx, interview_id: str) -> Interview:
    """The copy's interview as it stands, on a connection of its own that holds no lock and is let go at once."""
    async with engine.connect() as conn:
        return await _load(conn, owner.copy_id, interview_id)


async def _commit(engine: AsyncEngine, owner: OwnerCtx, interview: Interview, seen: dict) -> None:
    """Save `interview` as a turn changed it, only while the stored interview is still `seen` (`_stored` of what the
    turn read): 409 `conflict`, with nothing saved, when another request changed it meanwhile. The row is locked only
    for this read and write."""
    async with engine.connect() as conn, conn.begin():
        current = await _load(conn, owner.copy_id, interview.interview_id, lock=True)
        if _stored(current) != seen:
            raise ApiProblem(409, "conflict")
        await _save(conn, interview)


_RUNNING: set[str] = set()       # the interviews with a consent or an answer running in this process


@contextlib.contextmanager
def _turn(interview_id: str) -> Iterator[None]:
    """Hold the interview's one running consent or answer in this process: another sent meanwhile is 409 `conflict` at
    once, before any model call or read (one in another process is caught when it saves, by `_commit`)."""
    if interview_id in _RUNNING:
        raise ApiProblem(409, "conflict")
    _RUNNING.add(interview_id)
    try:
        yield
    finally:
        _RUNNING.discard(interview_id)


def setup_state(interview: Interview, slug: str) -> SetupState:
    """The interview as the owner sees it. Its messages leave out the transcript's first entry, the owner's own
    description (`start` puts it there), which the owner isn't shown back; the stored transcript, which later turns
    read, keeps it."""
    return SetupState(interview_id=interview.interview_id, desk_id=interview.desk_id, slug=slug, step=interview.step,
                      consent=interview.consent, question=interview.question,
                      messages=[SetupMessage(role=entry.role, text=entry.text) for entry in interview.transcript[1:]])


async def _slug(owner: OwnerCtx, desk_id: str) -> str:
    desk = await owner.ro.one("desks", desk_id=owner.desk(desk_id))
    if desk is None:
        raise ApiProblem(404, "not_found")
    return desk["slug"]


# Model calls -------------------------------------------------------------------------------------------------------


def recorder(engine: AsyncEngine, owner: OwnerCtx, route: str = ROUTE) -> Record:
    """Writes each setup model call's usage row (`route`) on its own connection, committed at once, under the owner
    session."""

    async def record(response: ModelResponse) -> None:
        async with engine.connect() as conn:
            await record_model_call(conn, owner.copy_id, owner.owner_session_id, route, response)
            await conn.commit()

    return record


def _user(text: str) -> dict:
    return {"role": "user", "content": [{"type": "text", "text": text}]}


def _answer_text(response: ModelResponse) -> str | None:
    texts = [block.get("text") for block in response.content if block.get("type") == "text"]
    return texts[0] if len(texts) == 1 and isinstance(texts[0], str) else None


def _errors(output: type[BaseModel], text: str) -> str | None:
    """What doesn't fit `output` in the answer, by field and without its values; None when it fits."""
    try:
        parse_structured(output, text)
    except ValidationError as invalid:
        return "\n".join(f"- {'.'.join(str(part) for part in error['loc']) or 'answer'}: {error['msg']}"
                         for error in invalid.errors(include_url=False, include_input=False)[:20])
    return None


async def ask_model(model: ModelClient, record: Record, system: str, messages: list[dict], output: type[Output], *,
                    max_tokens: int, route: str = ROUTE, effort: Effort = "low",
                    check: Callable[[Output], str | None | Awaitable[str | None]] | None = None,
                    timeout_s: float | None = None) -> Output | None:
    """A structured setup answer as `output` that `check` (if given, awaited when it answers an awaitable) finds
    nothing wrong with. A finished answer (`end_turn`) that doesn't fit, or that `check` lists problems with, gets one
    retry with them; None when the retry doesn't fit either. 503 `model_unavailable` when the model gives no answer at
    all, one that stopped before it finished (any other stop reason, `max_tokens` say) whatever its text, or none
    within `timeout_s` (`SETUP_TIMEOUT_S` unless the caller gives another): each call's usage is recorded first, a
    timed-out one as failed."""
    messages = list(messages)
    bound = SETUP_TIMEOUT_S if timeout_s is None else timeout_s
    for attempt in (1, 2):
        request = ModelRequest(route=route, system=[{"type": "text", "text": system}], messages=list(messages),
                               model=CONVERSATION_MODEL, effort=effort, max_tokens=max_tokens, output_schema=output,
                               timeout_s=bound)
        started = monotonic()
        try:
            async with asyncio.timeout(bound):
                response = await model.call(request)
        except ModelUnavailable as unavailable:
            response = unavailable.response
        except TimeoutError:
            logger.warning("a %s call ran out of time", route)
            response = ModelResponse(content=[], stop_reason="error", usage=None,
                                     latency_ms=round((monotonic() - started) * 1000), finished_at=datetime.now(UTC),
                                     model=request.model)
        await record(response)
        text = _answer_text(response)
        parsed = response.parsed if isinstance(response.parsed, output) else None
        retry = None
        if parsed is None:
            if text is None or response.stop_reason != "end_turn":   # no finished answer to fix: unavailable
                raise ApiProblem(503, "model_unavailable")
            errors = _errors(output, text)
            if errors is None:
                parsed = cast(Output, parse_structured(output, text))
            else:
                retry = SETUP_RETRY.format(errors=errors)
        if parsed is not None:
            problems = check(parsed) if check is not None else None
            if inspect.isawaitable(problems):
                problems = await problems
            if problems is None:
                return parsed
            retry = DRAFT_RETRY.format(errors=problems)
        logger.info("a %s answer didn't fit %s (attempt %d)", route, output.__name__, attempt)
        answered = text if text is not None else parsed.model_dump_json()
        messages += [{"role": "assistant", "content": [{"type": "text", "text": answered}]}, _user(retry)]
    return None


async def structured(model: ModelClient, record: Record, system: str, messages: list[dict],
                     output: type[Output], max_tokens: int) -> Output:
    """The setup route's answer as `output`. An answer that doesn't fit gets one retry, with its errors; then, or
    when the model gives no answer at all, 503 `model_unavailable`."""
    answer = await ask_model(model, record, system, messages, output, max_tokens=max_tokens)
    if answer is None:
        raise ApiProblem(503, "model_unavailable")
    return answer


# Setup tools -------------------------------------------------------------------------------------------------------


async def run_setup_tool(owner: OwnerCtx, desk_id: str, tool: str, args: dict) -> ExecResult | None:
    """Run an owner setup tool on `desk_id` as the owner: only a tool in the owner's `/context` for the Desk, then
    `/decide`, and `/execute` on an allow. None when it isn't given, is held or refused, or the kernel refuses or
    can't be reached: nothing ran that the kernel didn't allow, and setup goes on."""
    session_id, generation = owner.owner_session_id, owner.owner_generation
    try:
        context = await owner.kernel.call("GET /context/{session_id}?desk_id=", path={"session_id": session_id},
                                          query={"desk_id": desk_id})
        if tool not in {profile.tool for profile in context.tools}:
            logger.info("the setup tool %s isn't given on this Desk", tool)
            return None
        call = ToolCall(call_id="setup-" + secrets.token_hex(12), tool=tool, args=args)
        decision = await owner.kernel.call("POST /decide", DecideRequest(session_id=session_id, generation=generation,
                                                                         call=call, desk_id=desk_id))
        if decision.outcome != "allow":
            logger.info("the setup tool %s was decided %s", tool, decision.outcome)
            return None
        return await owner.kernel.call("POST /execute", ExecuteRequest(decision_id=decision.decision_id,
                                                                       session_id=session_id, generation=generation))
    except KernelFailed as failure:
        logger.warning("the setup tool %s was refused (%s)", tool, failure.code)
    except KernelUnavailable:
        logger.warning("the setup tool %s couldn't reach the kernel", tool)
    return None


def _memory_text(view: dict) -> str:
    items = view.get("items")
    lines = [f"{item['title']}: {item['text']}" for item in (items if isinstance(items, list) else [])
             if isinstance(item, dict) and isinstance(item.get("title"), str) and isinstance(item.get("text"), str)]
    return "\n".join(lines)[:READ_TEXT_MAX]


async def _read_memory(owner: OwnerCtx, desk_id: str) -> Entry:
    result = await run_setup_tool(owner, desk_id, "native.read_memory", {"query": MEMORY_QUERY})
    if result is None or result.state != "succeeded":
        return Entry(role="tool_label", text=MEMORY_FAILED_LABEL, read="memory")
    return Entry(role="tool_label", text=MEMORY_LABEL, read="memory", content=_memory_text(result.model_view))


async def _read_website(owner: OwnerCtx, desk_id: str, url: str, host: str) -> Entry:
    result = await run_setup_tool(owner, desk_id, "native.fetch_website", {"url": url})
    if result is None or result.state != "succeeded":
        return Entry(role="tool_label", text=WEBSITE_FAILED_LABEL.format(host=host), read="website", website=url)
    view = result.model_view
    content = "\n".join(part for part in (view.get("title"), view.get("text")) if isinstance(part, str))
    pages = view.get("pages")
    label = (WEBSITE_PAGES_LABEL.format(host=host, pages=pages)
             if type(pages) is int and pages > 1 else WEBSITE_LABEL.format(host=host))
    return Entry(role="tool_label", text=label, read="website", content=content[:READ_TEXT_MAX], website=url)


# The interview -----------------------------------------------------------------------------------------------------


async def _answering_off(owner: OwnerCtx, desk_id: str) -> None:
    """Turn the new Desk's Answering off, trying twice. When it stays on, the Desk is deleted (best effort: a failed
    delete is logged) and the last failure raised, so no Desk the owner never got answers the public."""
    for attempt in (1, 2):
        try:
            await owner.kernel.call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=False), path={"id": desk_id})
            return
        except (KernelFailed, KernelUnavailable) as failure:
            logger.warning("a new Desk's Answering couldn't be turned off (attempt %d)", attempt)
            if attempt == 2:
                try:
                    await owner.kernel.call("DELETE /desks/{id}", path={"id": desk_id})
                except (KernelFailed, KernelUnavailable):
                    logger.error("a new Desk that couldn't stop answering couldn't be deleted")
                raise failure from None


async def _read_description(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient,
                            body: SetupStartIn) -> tuple[SetupStart, CreateDeskRequest]:
    """Claude's reading of the owner's description, and the Desk to ask the kernel for. Nothing is made here."""
    described = await structured(model, recorder(engine, owner), SETUP_START_SYSTEM,
                                 [_user(wrap(OWNER_DESCRIPTION_TAG, body.description))], SetupStart, START_MAX_TOKENS)
    business_name = " ".join(described.business_name.split())
    name = owner_name(body.owner_display_name, described.owner_display_name, business_name)
    seed = DeskSeed(name=DESK_NAME, charter=[], hours=[], price_items=[], calendar_slots=[], people=[], documents=[],
                    notifications=default_notifications(described.business_type))
    return described, CreateDeskRequest(
        business=BusinessSeed(name=business_name, owner_display_name=name, timezone=body.timezone), desk=seed)


async def _make_desk(owner: OwnerCtx, body: SetupStartIn, described: SetupStart, desk: CreateDeskRequest,
                     interview_id: str) -> tuple[Interview, str]:
    """Ask the kernel for the Desk and turn its Answering off: the interview asking for consent, and the Desk's slug.
    Nothing of the interview is stored here."""
    created = await owner.kernel.call("POST /desks", desk)
    await _answering_off(owner, created.desk_id)
    site = website_url(described.website)
    interview = Interview(
        interview_id=interview_id, copy_id=owner.copy_id, desk_id=created.desk_id,
        business_type=described.business_type, step="questions", consent=None,
        answers=SetupAnswers(summary=described.summary, business_name=desk.business.name,
                             owner_display_name=desk.business.owner_display_name),
        transcript=[Entry(role="owner", text=body.description, website=site[0] if site else None),
                    Entry(role="claude", text=CONSENT_QUESTION, question="consent")])
    return interview, created.slug


def start_sha256(body: SetupStartIn) -> str:
    """The sha256 of the start's canonical body, its key left out: what a repeat with the key must match."""
    return body_sha256(body.model_dump(mode="json", exclude={"idempotency_key"}))


async def _claim(engine: AsyncEngine, copy_id: str, key: str, request_sha256: str) -> str | None:
    """Write a keyed start's row, with no Desk yet: its interview ID, or None when the copy already holds the key."""
    claim = (pg_insert(INTERVIEWS)
             .values(interview_id="setup-" + secrets.token_hex(16), copy_id=copy_id, idempotency_key=key,
                     request_sha256=request_sha256)
             .on_conflict_do_nothing(index_elements=[INTERVIEWS.c.copy_id, INTERVIEWS.c.idempotency_key],
                                     index_where=INTERVIEWS.c.idempotency_key.is_not(None))
             .returning(INTERVIEWS.c.interview_id))
    async with engine.connect() as conn:
        interview_id = (await conn.execute(claim)).scalar_one_or_none()
        await conn.commit()
    return interview_id


def _failure_record(error: BaseException) -> dict:
    """What a keyed start that failed answered, for a repeat to answer again (`_failure`)."""
    if isinstance(error, ApiProblem):
        return {"status": error.status, "error": error.error, "code": error.code}
    if isinstance(error, KernelFailed):
        return {"kernel": "failed", "status": error.status, "code": error.code}
    if isinstance(error, KernelUnavailable):
        return {"kernel": "unavailable", "route": error.route, "status": error.status, "code": error.code}
    return {"status": 500, "error": "internal", "code": None}


def _failure(record: dict) -> Exception:
    """The error a stored failure answers with again, as the app answered the first."""
    if record.get("kernel") == "failed":
        return KernelFailed(record["status"], record["code"])
    if record.get("kernel") == "unavailable":
        return KernelUnavailable(record["route"], record["status"], record["code"])
    return ApiProblem(record["status"], record["error"], code=record["code"])


async def _desks_now(owner: OwnerCtx) -> OwnerCtx:
    """The owner's context with the copy's Desks as the kernel's `/whoami` answers now, so a Desk the first start
    made after this request read them counts as the copy's (`OwnerCtx.desk` stays the check)."""
    who = await owner.kernel.whoami()
    if who.copy_id != owner.copy_id:
        raise ApiProblem(404, "not_found")
    return replace(owner, desk_ids=tuple(who.desk_ids))


async def repeated_start(owner: OwnerCtx, engine: AsyncEngine, body: SetupStartIn) -> SetupState | None:
    """The interview a start with this key made in the copy, as it stands now; None when none holds the key. 409
    `conflict` when the key's start had another body, and the first's failure again when it failed. While the first
    is still starting, 409 `in_progress` at once, to be sent again in `START_RETRY_S`. A row still starting after
    `START_ABANDONED_S` is abandoned (its request stopped): it is deleted, if it still is one, and the key is free."""
    key, sha = body.idempotency_key, start_sha256(body)
    found = select(INTERVIEWS.c.interview_id, INTERVIEWS.c.desk_id, INTERVIEWS.c.request_sha256,
                   INTERVIEWS.c.start_error, _STALE.label("stale")).where(INTERVIEWS.c.copy_id == owner.copy_id,
                                                                         INTERVIEWS.c.idempotency_key == key)
    async with engine.connect() as conn:
        row = (await conn.execute(found)).mappings().one_or_none()
    if row is None:
        return None
    if row["request_sha256"] != sha:
        raise ApiProblem(409, "conflict")
    if row["start_error"] is not None:
        raise _failure(row["start_error"])
    if row["desk_id"] is None:
        if row["stale"] and await _drop_abandoned(engine, owner.copy_id, row["interview_id"]):
            return None
        raise ApiProblem(409, "in_progress", retry_after=START_RETRY_S)
    if row["desk_id"] not in owner.desk_ids:          # made after this request read the copy's Desks
        owner = await _desks_now(owner)
    return await read(owner, engine, row["interview_id"])


async def _drop_abandoned(engine: AsyncEngine, copy_id: str, interview_id: str) -> bool:
    """Delete an abandoned keyed row only while it still is one (no Desk, no failure, older than
    `START_ABANDONED_S`), so a start that finished meanwhile keeps its row: whether it went."""
    async with engine.connect() as conn:
        gone = await conn.execute(delete(INTERVIEWS).where(
            INTERVIEWS.c.interview_id == interview_id, INTERVIEWS.c.copy_id == copy_id, INTERVIEWS.c.desk_id.is_(None),
            INTERVIEWS.c.start_error.is_(None), _STALE))
        await conn.commit()
    if gone.rowcount == 1:
        logger.warning("a keyed setup start abandoned mid-way was let go")
    return gone.rowcount == 1


async def start(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, body: SetupStartIn, *,
                admit: Callable[[], Awaitable[None]]) -> SetupState:
    """Read the owner's description, make the Desk with Answering off, and ask for consent, once `admit` (the route's
    limits) lets the start through. With the client's key, a repeat is answered before `admit` counts it; otherwise
    the interview's row is written first, under the key's lock, and the start's outcome saved to it, its failure too
    (module docstring). A request another process admitted meanwhile is answered as a repeat."""
    key = body.idempotency_key
    if key is None:
        await admit()
        described, desk = await _read_description(owner, engine, model, body)
        interview, slug = await _make_desk(owner, body, described, desk, "setup-" + secrets.token_hex(16))
        async with engine.connect() as conn:
            await conn.execute(insert(INTERVIEWS).values(interview_id=interview.interview_id,
                                                         copy_id=interview.copy_id, desk_id=interview.desk_id,
                                                         business_type=interview.business_type, **_stored(interview)))
            await conn.commit()
        return setup_state(interview, slug)

    async with ADMISSIONS.admitting(owner.copy_id, key):
        repeat = await repeated_start(owner, engine, body)
        if repeat is not None:
            return repeat
        await admit()
        interview_id = await _claim(engine, owner.copy_id, key, start_sha256(body))
    if interview_id is None:                        # another process took the key since this one looked
        repeat = await repeated_start(owner, engine, body)
        if repeat is None:                          # and has let it go again: this one is to be sent again
            raise ApiProblem(409, "in_progress", retry_after=START_RETRY_S)
        return repeat
    keyed = (INTERVIEWS.c.interview_id == interview_id, INTERVIEWS.c.copy_id == owner.copy_id)
    try:
        described, desk = await _read_description(owner, engine, model, body)
    except BaseException:                           # nothing was made: the key is free for the same request again
        await _settle(engine, delete(INTERVIEWS).where(*keyed))
        raise
    try:
        interview, slug = await _make_desk(owner, body, described, desk, interview_id)
        async with engine.connect() as conn:
            await conn.execute(update(INTERVIEWS).where(*keyed).values(
                desk_id=interview.desk_id, business_type=interview.business_type, **_stored(interview),
                updated_at=func.now()))
            await conn.commit()
    except BaseException as error:                  # the Desk was asked for: the key keeps the outcome
        await _settle(engine, update(INTERVIEWS).where(*keyed).values(start_error=_failure_record(error),
                                                                      updated_at=func.now()))
        raise
    return setup_state(interview, slug)


async def _settle(engine: AsyncEngine, statement: Executable) -> None:
    """A failed keyed start's last write to its row, on a connection of its own. One that fails is logged by type
    only: the start's own answer still goes out, and its row stays in progress for a repeat to find."""
    try:
        async with engine.connect() as conn:
            await conn.execute(statement)
            await conn.commit()
    except Exception as failed:
        logger.warning("a keyed setup start's row couldn't be settled (%s)", type(failed).__name__)


async def read(owner: OwnerCtx, engine: AsyncEngine, interview_id: str) -> SetupState:
    async with engine.connect() as conn:
        interview = await _load(conn, owner.copy_id, interview_id)
    return setup_state(interview, await _slug(owner, interview.desk_id))


def _ask(interview: Interview, key: QuestionKey) -> Entry:
    return Entry(role="claude", text=question_text(key, interview.business_type), question=key)


async def consent(owner: OwnerCtx, engine: AsyncEngine, interview_id: str, allow: bool) -> SetupState:
    """Store the owner's consent, once; on yes, search their memory and read the website the description named.
    Then the first question. The reads run with no lock held (module docstring)."""
    interview = await _read(engine, owner, interview_id)
    desk_id = owner.desk(interview.desk_id)
    if interview.consent is not None or interview.step != "questions":
        raise ApiProblem(409, "conflict")
    seen = _stored(interview)
    with _turn(interview_id):
        entries = [Entry(role="owner", text=CONSENT_ANSWERS[allow])]
        if allow:
            entries.append(await _read_memory(owner, desk_id))
            site = website_url(interview.transcript[0].website)
            if site is not None:
                entries.append(await _read_website(owner, desk_id, *site))
        interview.consent = allow
        interview.transcript += entries
        interview.transcript.append(_ask(interview, QUESTION_KEYS[0]))
        await _commit(engine, owner, interview, seen)
    return setup_state(interview, await _slug(owner, desk_id))


def _turn_message(interview: Interview, key: QuestionKey, text: str) -> dict:
    """The answer turn's one message: the fixed head, then everything untrusted inside its wrapper. A limit question's
    turn (`LIMIT_QUESTIONS`) leaves out what the memory and the website said, and of the answers so far reads only the
    limits already answered (each taken on its own turn), never a fact an earlier turn may have taken from them: not
    even the price list the quote question's prices merge into, whose titles may be website or memory text."""
    limit_turn = key in LIMIT_QUESTIONS.values()
    so_far = interview.answers.model_dump_json(exclude_defaults=True)
    if limit_turn:
        so_far = interview.answers.model_dump_json(include=set(LIMIT_QUESTIONS), exclude_defaults=True)
    parts = [setup_turn_head(interview.business_type, key), wrap(ANSWERS_SO_FAR_TAG, so_far)]
    reads = [] if limit_turn else interview.transcript
    for entry in reads:
        if entry.read == "memory" and entry.content:
            parts.append(wrap(MEMORY_TAG, entry.content))
        elif entry.read == "website" and entry.content:
            parts.append(wrap_website(entry.content, entry.website or ""))
    parts.append(wrap(OWNER_ANSWER_TAG, text))
    return _user("\n\n".join(parts))


def _title(title: str) -> str:
    return " ".join(title.split()).casefold()


def _priced(listed: list[dict], named: list[PriceAnswer], key: QuestionKey) -> list[dict]:
    """The price list with the prices a limit turn named (`LIMIT_TURN_FACTS`): each updates the price of the item
    listed with the same title (ignoring case and spacing), else is added at the end; no item is removed. A new item
    past the list's `PRICE_ITEMS_MAX` is dropped and logged."""
    prices = [dict(item) for item in listed]
    at = {_title(item["title"]): index for index, item in enumerate(prices)}
    for price in named:
        found = at.get(_title(price.title))
        if found is not None:
            prices[found]["unit_cents"] = price.unit_cents
        elif len(prices) < PRICE_ITEMS_MAX:
            at[_title(price.title)] = len(prices)
            prices.append(price.model_dump())
        else:
            logger.warning("a setup turn answering %s dropped a price past the list's %d items", key, PRICE_ITEMS_MAX)
    return prices


def merged(answers: SetupAnswers, patch: SetupPatch, key: QuestionKey) -> SetupAnswers:
    """`answers` with what the patch sets (a blank text sets nothing). Each limit is taken only on the turn answering
    its own question (`LIMIT_QUESTIONS`), and a fact only on a turn answering a question that owns no limit, but for
    the prices the quote question names, which only update or add items (`_priced`); anything else is dropped and
    logged (by its label or field name, never its value). Names are reduced as the Desk takes them."""
    values = answers.model_dump()
    limit_turn = key in LIMIT_QUESTIONS.values()
    for name, value in patch:
        if value is None or (isinstance(value, str) and not value.strip()):
            continue
        if name in LIMIT_QUESTIONS and key != LIMIT_QUESTIONS[name]:
            logger.warning("a setup turn answering %s carried %s; it was dropped", key, LIMIT_LABELS[name])
            continue
        if limit_turn and name not in LIMIT_QUESTIONS:
            if LIMIT_TURN_FACTS.get(name) == key:
                values[name] = _priced(values[name], value, key)
            else:
                logger.warning("a setup turn answering %s carried %s; it was dropped", key, name)
            continue
        if name == "hours":
            value = [window.window() for window in value]
        elif name == "owner_display_name":
            value = reduce_name(value) or None
        elif name == "business_name":
            value = " ".join(value.split()) or None
        if value is not None:
            values[name] = value
    return SetupAnswers.model_validate(values)


async def _rename(owner: OwnerCtx, desk_id: str, patch: SetupPatch) -> None:
    """Send a new owner or business name the turn gave to the kernel (`PUT /desks/{id}/business`)."""
    name, owner_display_name = " ".join((patch.business_name or "").split()), reduce_name(patch.owner_display_name)
    if not name and not owner_display_name:
        return
    desk = await owner.ro.one("desks", desk_id=desk_id)
    business = await owner.ro.one("businesses", business_id=desk["business_id"]) if desk is not None else None
    if business is None:
        raise ApiProblem(404, "not_found")
    renamed = (name or business["name"], owner_display_name or business["owner_display_name"])
    if renamed == (business["name"], business["owner_display_name"]):
        return
    await owner.kernel.call("PUT /desks/{id}/business", DeskBusinessRequest(
        name=renamed[0], owner_display_name=renamed[1], timezone=business["timezone"], brand=business["brand"] or {}),
        path={"id": desk_id})


async def answer(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview_id: str, question: QuestionKey,
                 text: str) -> SetupState:
    """One answer turn on the question waiting (module docstring); 409 `conflict`, before any model call, when none
    is, the answer names another (an answer sent twice finds the next question waiting) or one is running already.
    The model call, the website read and the kernel's rename run with no lock held."""
    interview = await _read(engine, owner, interview_id)
    desk_id = owner.desk(interview.desk_id)
    key = interview.question
    if key is None or key != question:
        raise ApiProblem(409, "conflict")
    seen = _stored(interview)
    with _turn(interview_id):
        turn = await structured(model, recorder(engine, owner), SETUP_TURN_SYSTEM,
                                [_turn_message(interview, key, text)], SETUP_TURNS[key], TURN_MAX_TOKENS)
        patch = turn.patch()
        said = Entry(role="owner", text=text)
        entries = [said]
        if turn.reply.strip():
            entries.append(Entry(role="claude", text=turn.reply.strip()))
        site = website_url(turn.website)
        if site is not None and site[0] not in interview.tried_websites():
            if interview.consent:
                entries.append(await _read_website(owner, desk_id, *site))
            else:
                said.website = site[0]                   # kept as text: nothing is read without consent
        await _rename(owner, desk_id, patch)
        interview.answers = merged(interview.answers, patch, key)
        if turn.step_done:
            later = QUESTION_KEYS[QUESTION_KEYS.index(key) + 1:]
            if later:
                entries.append(_ask(interview, later[0]))
            else:
                interview.step = "tools"
                entries.append(Entry(role="claude", text=QUESTIONS_DONE))
        interview.transcript += entries
        await _commit(engine, owner, interview, seen)
    return setup_state(interview, await _slug(owner, desk_id))


# Setup, part 2 (Task 7): the Desk's parts, rule cards, situations, the safety check and going live -----------------

RULE_STEPS: tuple[SetupStep, ...] = ("tools", "rules", "situations", "safety_check")
STEP_ORDER: tuple[SetupStep, ...] = ("questions", "tools", "rules", "situations", "safety_check", "preview", "live")
CARD_DRAFT_ROUTE, SITUATIONS_ROUTE = "card_draft", "situations"
CARD_DRAFT_MAX_TOKENS = 4096
SITUATIONS_MAX_TOKENS = 4096
CALENDAR_DAYS = 14
SLOT_MINUTES = 60
ITEM_ID_MAX = 40
WEEK = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
# The Ask me first preset's utility cards: in every setup draft, so slots, leads, callbacks, verification and the
# setup reads never fall to a default ask. Setup drafts no card of its own on these tools.
UTILITY_CARDS: tuple[RuleCard, ...] = tuple(PRESETS["ask_first"])
UTILITY_TOOLS = frozenset(card.applies_to for card in UTILITY_CARDS)
EFFECT_TARGETS = tuple(f"effect:{effect}" for effect in get_args(Effect))
MONEY_TARGETS = MONEY_TOOLS | {"effect:charge", "effect:pay_out"}
# Where each tool a situation can call acts (as its profile says), for the probe's stand-in resource.
RESOURCE_KINDS: dict[str, str] = {
    "native.quote": "desk", "native.find_slots": "desk", "native.book": "slot", "native.release_document": "document",
    "native.payment_link": "quote", "native.charge_mandate": "quote", "native.capture_lead": "desk",
    "native.request_callback": "desk", "native.start_verification": "desk", "payments.list_charges": "charge",
    "payments.create_refund": "charge"}
# A probe's stand-in arguments: nothing is looked up or run, so they only need to fit the tool's input schema.
PROBE_ID, PROBE_NAME, PROBE_CONTACT, PROBE_ITEM = "probe", "A visitor", "visitor@example.com", "item"


class RulesChangedSinceDraft(AnswerError):
    """A confirm found the rules changed after the draft: `draft` is the same cards drafted again on the rules now in
    force (the route answers 409 `RulesChanged`). It is the confirm's answer, so a retry after a 202 hears it once."""

    def __init__(self, draft: RulesDraft):
        super().__init__("rules changed since the draft")
        self.draft = draft


@contextlib.asynccontextmanager
async def detached(owner: OwnerCtx, engine: AsyncEngine, ro_schema: str) -> AsyncIterator[OwnerCtx]:
    """The owner's context on a database connection of its own, for proving work that may outlive its request (whose
    connection closes with it). It carries the same copy and kernel view, and never commits; each read ends its own
    transaction (`KernelRO`'s `own_transactions`), so none stays open while the work waits on the model or the
    kernel."""
    async with engine.connect() as conn:
        yield replace(owner, ro=KernelRO(conn, owner.copy_id, ro_schema, own_transactions=True))


async def interview_desk(owner: OwnerCtx, engine: AsyncEngine, interview_id: str) -> str:
    """The Desk of the copy's interview `interview_id` (404 for any other)."""
    async with engine.connect() as conn:
        interview = await _load(conn, owner.copy_id, interview_id)
    return owner.desk(interview.desk_id)


def _require_step(interview: Interview, steps: tuple[SetupStep, ...], *, drafted: bool = False) -> None:
    """409 `conflict` unless the interview is at one of `steps` (and, with `drafted`, has a rules draft)."""
    if interview.step not in steps or (drafted and interview.draft_version is None):
        raise ApiProblem(409, "conflict")


def _later(step: SetupStep, than: SetupStep) -> SetupStep:
    return max(step, than, key=STEP_ORDER.index)


async def _update(engine: AsyncEngine, owner: OwnerCtx, interview_id: str,
                  change: Callable[[Interview], None]) -> Interview:
    """Apply `change` to the interview under its row lock and save it, in one transaction."""
    async with engine.connect() as conn, conn.begin():
        interview = await _load(conn, owner.copy_id, interview_id, lock=True)
        change(interview)
        await _save(conn, interview)
    return interview


# The Desk's parts --------------------------------------------------------------------------------------------------


class SeedParts(BaseModel):
    """What setup puts on the new Desk before its rules, by code from the answers (`PUT /desks/{id}/{part}`)."""

    charter: list[Claim]
    hours: list[HoursWindow]
    prices: list[PriceItem]
    calendar: list[CalendarSlot]
    notifications: NotificationDefaults


def item_slug(title: str) -> str:
    """A price item's id from its title: ASCII-folded, lowercase letters and digits, other runs as one "-", cut to
    40; "" when nothing is left."""
    folded = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", folded).strip("-")[:ITEM_ID_MAX].strip("-")


def price_items(prices: list[PriceAnswer]) -> list[PriceItem]:
    """The price list, each item's id the slug of its title ("item" when empty), a repeat made unique with "-2",
    "-3", and so on."""
    taken: set[str] = set()
    items = []
    for price in prices:
        base = item_slug(price.title) or PROBE_ITEM
        item_id, count = base, 1
        while item_id in taken:
            count += 1
            suffix = f"-{count}"
            item_id = base[:ITEM_ID_MAX - len(suffix)].rstrip("-") + suffix
        taken.add(item_id)
        items.append(PriceItem(item_id=item_id, title=price.title, unit_cents=price.unit_cents))
    return items


def _minute(moment: time) -> int:
    return moment.hour * 60 + moment.minute


def calendar_slots(hours: list[HoursWindow], timezone: str, today: date) -> list[CalendarSlot]:
    """60-minute slots inside the opening hours on the 14 days after `today`, each named `S-<yyyymmdd>-<hhmm>` by its
    start in the business's time zone (a window's end is exclusive; 00:00 is midnight)."""
    zone = ZoneInfo(timezone)
    slots: dict[str, CalendarSlot] = {}
    for offset in range(1, CALENDAR_DAYS + 1):
        day = today + timedelta(days=offset)
        for window in hours:
            if WEEK[day.weekday()] not in window.days:
                continue
            end = _minute(window.end) or 24 * 60
            for start in range(_minute(window.start), end - SLOT_MINUTES + 1, SLOT_MINUTES):
                local = time(start // 60, start % 60)
                slot_id = f"S-{day:%Y%m%d}-{local:%H%M}"
                slots.setdefault(slot_id, CalendarSlot(slot_id=slot_id, starts_at=datetime.combine(day, local, zone),
                                                       minutes=SLOT_MINUTES))
    return sorted(slots.values(), key=lambda slot: slot.slot_id)


def seed_parts(answers: SetupAnswers, timezone: str, *, business_type: BusinessType, today: date) -> SeedParts:
    """The Desk's parts from the answers: the public charter (the contact and the service area; never hours, which
    have their own part), the hours, the price list, the calendar and the notification defaults."""
    charter = [Claim(key=key, kind="text", value=value.strip())
               for key, value in (("contact", answers.public_contact), ("policy:service_area", answers.service_area))
               if value and value.strip()]
    return SeedParts(charter=charter, hours=list(answers.hours), prices=price_items(answers.price_items),
                     calendar=calendar_slots(answers.hours, timezone, today),
                     notifications=default_notifications(business_type))


async def _put_parts(owner: OwnerCtx, desk_id: str, parts: SeedParts) -> None:
    path = {"id": desk_id}
    await owner.kernel.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=parts.charter), path=path)
    await owner.kernel.call("PUT /desks/{id}/hours", DeskHoursRequest(hours=parts.hours), path=path)
    await owner.kernel.call("PUT /desks/{id}/prices", DeskPricesRequest(price_items=parts.prices), path=path)
    await owner.kernel.call("PUT /desks/{id}/calendar", DeskCalendarRequest(calendar_slots=parts.calendar), path=path)
    await owner.kernel.call("PUT /desks/{id}/notifications",
                            DeskNotificationsRequest(notifications=parts.notifications), path=path)


async def _business(owner: OwnerCtx, desk_id: str) -> dict:
    desk = await owner.ro.one("desks", desk_id=desk_id)
    business = await owner.ro.one("businesses", business_id=desk["business_id"]) if desk is not None else None
    if business is None:
        raise ApiProblem(404, "not_found")
    return business


async def _prices(owner: OwnerCtx, desk_id: str) -> dict[str, int]:
    """The Desk's price list as the kernel has it: item id to price."""
    return {row["item_id"]: row["unit_cents"] for row in await owner.ro.rows("price_items", desk_id=desk_id,
                                                                            order_by=("item_id",))}


# Rule cards --------------------------------------------------------------------------------------------------------


def _pays_out(applies_to: str, tools: list[dict]) -> bool:
    """Whether a card on `applies_to` covers money going out: the pay-out effect, or a tool offered with it."""
    return applies_to == "effect:pay_out" or any(tool["tool"] == applies_to and "pay_out" in tool["effects"]
                                                 for tool in tools)


def _covering(tool: str, tools: list[dict], effects: frozenset[str] | None = None) -> frozenset[str]:
    """The targets a card covers `tool` by: the tool itself, when offered, and each of its effects (only those in
    `effects`, when given) as `effect:<name>`."""
    offered = next((entry["effects"] for entry in tools if entry["tool"] == tool), None)
    if offered is None:
        return frozenset()
    return frozenset({tool, *(f"effect:{effect}" for effect in offered if effects is None or effect in effects)})


def _past_a_limit(card: RuleCard, tools: list[dict], answers: SetupAnswers) -> str | None:
    """The answered limit an auto card goes past, by the tool it names or an effect the tool has, or None: a quote's
    amount (which it must set) and discount past the answered quote and discount limits, a document going out unless
    verified owners get their own, or a payment link's amount past the lower of the answered link limit and the money
    cap. An unanswered limit is 0."""
    if card.applies_to in _covering("native.quote", tools):
        if card.max_amount_cents is None or card.max_amount_cents > (answers.quote_auto_max_cents or 0):
            return "quote_limit"
        if card.max_discount_bp > (answers.discount_auto_max_bp or 0):
            return "discount_limit"
    if (card.applies_to in _covering("native.release_document", tools, frozenset({"private_data"}))
            and answers.documents != "verified_owner"):
        return "documents"
    link_limit = min(answers.payment_link_auto_max_cents or 0, answers.auto_money_cap_cents)
    if card.applies_to in _covering("native.payment_link", tools) and (card.max_amount_cents or 0) > link_limit:
        return "link_limit"
    return None


def _against_a_never(card: RuleCard, tools: list[dict], answers: SetupAnswers) -> str | None:
    """The owner's "never" answer a card that isn't `never` goes against, or None: documents "none", for a card
    covering a document going out (the tool or its private data effect), and refunds "never", for a card covering
    money going out. The template cards keep each with a `never` card, and so must Claude's."""
    if card.mode == "never":
        return None
    if answers.documents == "none" and card.applies_to in _covering("native.release_document", tools,
                                                                    frozenset({"private_data"})):
        return "documents_none"
    if answers.refunds == "never" and _pays_out(card.applies_to, tools):
        return "refunds_never"
    return None


def _card_problems(drafted: DraftedRules, tools: list[dict], answers: SetupAnswers) -> str | None:
    """What makes a drafted card unusable, one line each (none drafted counts): a target that is neither a tool
    offered nor an effect, a card the contract refuses, a card that goes against the owner's "never" answer on
    documents or refunds (`_against_a_never`), an auto card that pays money out (setup's answers have refunds ask or
    never, so no draft sends money out on its own), an auto money card above the answered money cap, or an auto card
    past another answered limit (`_past_a_limit`)."""
    cap = answers.auto_money_cap_cents
    targets = frozenset(tool["tool"] for tool in tools) | frozenset(EFFECT_TARGETS)
    if not drafted.cards:
        return CARD_ERROR_LINE.format(index=0, problem=CARD_ERRORS["none"])
    problems = []
    for index, draft in enumerate(drafted.cards):
        if draft.applies_to not in targets:
            problems.append(CARD_ERROR_LINE.format(index=index, problem=CARD_ERRORS["target"]))
            continue
        try:
            card = _card(index, draft)
        except ValidationError as invalid:
            problems += [CARD_ERROR_LINE.format(index=index, problem=error["msg"])
                         for error in invalid.errors(include_url=False, include_input=False)]
            continue
        if (against := _against_a_never(card, tools, answers)) is not None:
            problems.append(CARD_ERROR_LINE.format(index=index, problem=CARD_ERRORS[against]))
            continue
        if card.mode != "auto":
            continue
        if _pays_out(card.applies_to, tools):
            problems.append(CARD_ERROR_LINE.format(index=index, problem=CARD_ERRORS["pay_out"]))
        elif card.applies_to in MONEY_TARGETS and (card.max_amount_cents or 0) > cap:
            problems.append(CARD_ERROR_LINE.format(index=index, problem=CARD_ERRORS["above_cap"]))
        elif (past := _past_a_limit(card, tools, answers)) is not None:
            problems.append(CARD_ERROR_LINE.format(index=index, problem=CARD_ERRORS[past]))
    return "\n".join(problems) or None


def _card(index: int, draft: RuleCardDraft) -> RuleCard:
    return RuleCard(card_id=f"card-{index + 1}", applies_to=draft.applies_to, mode=draft.mode, who=draft.who,
                    max_amount_cents=draft.max_amount_cents, max_discount_bp=draft.max_discount_bp,
                    hours=draft.hours.window() if draft.hours is not None else None, review=draft.review,
                    reason=draft.reason.strip())


async def draft_cards(model: ModelClient, record: Record, business_type: BusinessType, answers: SetupAnswers,
                      tools: list[dict],
                      post: Callable[[list[RuleCard]], Awaitable[PolicyVersion | None]]) -> PolicyVersion | None:
    """Claude's rule cards from the answers (route `card_draft`), ids `card-1`…, for the `tools` offered (every
    enabled tool but the utility cards' ones, as `{tool, effects}`) or an effect, as `post` drafts them on the kernel.
    A draft code can't use (no card, a target not offered, a card the contract refuses, a card against the owner's
    "never" answer on documents or refunds, money going out on its own, or an auto card past an answered limit: the
    money cap, the quote, discount and payment link limits, or the documents rule), or one `post` answers None for (the
    kernel refused the set as invalid, which names no card), gets one retry with what is wrong: the one retry every
    draft gets, whichever found it. The version `post` drafted, or None when the retry can't be used either: the caller
    drafts the template cards."""
    cap = answers.auto_money_cap_cents
    message = _user("\n\n".join([card_draft_head(business_type, cap), wrap(TOOLS_TAG, json.dumps(tools)),
                                 wrap(ANSWERS_TAG, answers.model_dump_json(exclude_defaults=True))]))
    posted: list[PolicyVersion] = []

    async def usable(drafted: DraftedRules) -> str | None:
        problems = _card_problems(drafted, tools, answers)
        if problems is not None:
            return problems
        version = await post([_card(index, draft) for index, draft in enumerate(drafted.cards)])
        if version is None:
            return CARDS_REFUSED
        posted.append(version)
        return None

    drafted = await ask_model(model, record, CARD_DRAFT_SYSTEM, [message], DraftedRules,
                              max_tokens=CARD_DRAFT_MAX_TOKENS, route=CARD_DRAFT_ROUTE, effort="medium", check=usable)
    if drafted is None:
        logger.warning("the drafted rule cards couldn't be used twice; setup uses the template cards")
        return None
    return posted[-1]


async def _rule_tools(owner: OwnerCtx, desk_id: str) -> list[dict]:
    """The enabled tools setup drafts cards for: every one but the utility cards' tools."""
    rows = await owner.ro.rows("tools", desk_id=desk_id, status="enabled", order_by=("tool",))
    return [{"tool": row["tool"], "effects": list(row["effects"])} for row in rows if row["tool"] not in UTILITY_TOOLS]


async def _post_draft(owner: OwnerCtx, desk_id: str, cards: list[RuleCard]) -> PolicyVersion:
    """The kernel's draft of the utility cards and `cards`, on the active version (`versions.post_draft`).

    The money cap: setup's money cards are held to the answered cap (`template_cards`, `_card_problems`). The draft
    names no cap yet: `PolicyDraftRequest` gains `auto_money_cap_cents` with the kernel's money cap contract (master
    "Money cap"), and this request then sends the answered cap. Until then the kernel holds every version to the
    platform's cap, which the answered cap can't pass."""
    active = await active_row(owner, desk_id)
    return await post_draft(owner, desk_id, [*UTILITY_CARDS, *cards], active["version"])


async def _posted(owner: OwnerCtx, desk_id: str, cards: list[RuleCard],
                  template: list[RuleCard]) -> PolicyVersion | None:
    """The kernel's checkable draft of setup's `cards` (`_post_draft`), or None when the kernel refuses them as invalid
    (422, which names no card: the kernel logs why). The `template` cards refused are the owner's error to see."""
    try:
        return checkable(await _post_draft(owner, desk_id, cards))
    except KernelFailed as refused:
        if refused.code != "invalid" or cards == template:
            raise
        logger.warning("the kernel refused setup's cards as invalid")
        return None


async def _store_cards(engine: AsyncEngine, owner: OwnerCtx, interview_id: str, cards: list[RuleCard], *,
                       replace_stored: bool = False) -> list[RuleCard]:
    """Store setup's cards for its rules draft and return the cards stored: those already there when another request
    stored them first, unless `replace_stored`."""
    def keep(interview: Interview) -> None:
        if replace_stored or not interview.draft_cards:
            interview.draft_cards = list(cards)

    return (await _update(engine, owner, interview_id, keep)).draft_cards


async def _drafted(engine: AsyncEngine, owner: OwnerCtx, interview_id: str, version: int, step: SetupStep) -> None:
    def note(interview: Interview) -> None:
        interview.draft_version = version
        interview.step = _later(interview.step, step)

    await _update(engine, owner, interview_id, note)


async def rules(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview_id: str,
                now: datetime) -> RulesDraft:
    """The new Desk's parts and its first rules draft. The first time, the parts go to the kernel, then Claude
    drafts the cards, each set stored before the kernel drafts it; a set the kernel refuses as invalid gets Claude's
    one retry (`draft_cards`). Any later request re-posts the stored cards and never drafts again. A proof that is
    rejected, Claude's cards that can't be used after the retry, or stored cards the kernel refuses as invalid fall
    back once to the template cards, stored in their place; the kernel refusing the template is the owner's error."""
    async with engine.connect() as conn:
        interview = await _load(conn, owner.copy_id, interview_id)
    desk_id = owner.desk(interview.desk_id)
    _require_step(interview, RULE_STEPS)
    answers, business_type = interview.answers, interview.business_type
    cards = interview.draft_cards
    template = template_cards(business_type, answers)
    version: PolicyVersion | None
    if not cards:
        timezone = (await _business(owner, desk_id))["timezone"]
        today = now.astimezone(ZoneInfo(timezone)).date()
        await _put_parts(owner, desk_id, seed_parts(answers, timezone, business_type=business_type, today=today))

        async def post(drafted: list[RuleCard]) -> PolicyVersion | None:
            nonlocal cards                      # the first set keeps cards another request stored first
            cards = await _store_cards(engine, owner, interview_id, drafted, replace_stored=bool(cards))
            return await _posted(owner, desk_id, cards, template)

        version = await draft_cards(model, recorder(engine, owner, CARD_DRAFT_ROUTE), business_type, answers,
                                    await _rule_tools(owner, desk_id), post)
    else:
        version = await _posted(owner, desk_id, cards, template)
    if (version is None or version.status == "rejected") and cards != template:
        cards = await _store_cards(engine, owner, interview_id, template, replace_stored=bool(cards))
        version = checkable(await _post_draft(owner, desk_id, cards))
    await _drafted(engine, owner, interview_id, version.version, "rules")
    return rules_draft(version, answers.auto_money_cap_cents)


# Situations and the safety check -----------------------------------------------------------------------------------


def _local(moment: datetime, zone: ZoneInfo) -> datetime:
    return moment.astimezone(zone)


def _open_at(moment: datetime, hours: list[HoursWindow]) -> HoursWindow | None:
    """The window `moment` (local) falls in, if any (a window's end is exclusive; 00:00 is midnight)."""
    minute = _minute(moment.time())
    for window in hours:
        if WEEK[moment.weekday()] in window.days and _minute(window.start) <= minute < (_minute(window.end) or 1440):
            return window
    return None


def _next_day_with_hours(hours: list[HoursWindow], today: date) -> date | None:
    for offset in range(1, 8):
        day = today + timedelta(days=offset)
        if any(WEEK[day.weekday()] in window.days for window in hours):
            return day
    return None


def after_hours_start(hours: list[HoursWindow], timezone: str, now: datetime) -> datetime:
    """When an after-hours situation happens: the end of the latest window on the next day that has hours (a window's
    end is exclusive, so that minute is outside it; past one that another window continues, its end), or the next
    Sunday 22:00 in the business's time zone when there are no hours."""
    zone = ZoneInfo(timezone)
    today = _local(now, zone).date()
    day = _next_day_with_hours(hours, today)
    if day is None:
        sunday = today + timedelta(days=(6 - today.weekday()) % 7 or 7)
        return datetime.combine(sunday, time(22), zone)
    ends = [_minute(window.end) or 1440 for window in hours if WEEK[day.weekday()] in window.days]
    moment = datetime.combine(day, time(0), zone) + timedelta(minutes=max(ends))
    for _ in range(len(hours) * 7):                      # a window that continues past it moves it on
        window = _open_at(moment, hours)
        if window is None:
            break
        moment = datetime.combine(moment.date(), time(0), zone) + timedelta(minutes=_minute(window.end) or 1440)
    return moment


def next_opening(hours: list[HoursWindow], timezone: str, now: datetime) -> datetime | None:
    """The start of the first window on the next day that has hours, in the business's time zone (None without
    hours): when a booking situation that isn't after hours happens, so it doesn't depend on the clock it is run."""
    zone = ZoneInfo(timezone)
    day = _next_day_with_hours(hours, _local(now, zone).date())
    if day is None:
        return None
    start = min(_minute(window.start) for window in hours if WEEK[day.weekday()] in window.days)
    return datetime.combine(day, time(start // 60, start % 60), zone)


def probe_args(tool: str, *, item_id: str | None = None, discount_bp: int | None = None,
               slot_at: datetime | None = None, reason: str = "") -> dict:
    """A probe's stand-in arguments for `tool`, fitting its input schema; nothing in them is looked up."""
    if tool == "native.quote":
        args: dict = {"items": [{"item_id": item_id or PROBE_ITEM, "qty": 1}]}
        return {**args, "requested_discount_bp": discount_bp} if discount_bp else args
    if tool == "native.book":
        return {"slot_id": f"S-{slot_at:%Y%m%d-%H%M}"}
    if tool == "native.release_document":
        return {"document_id": PROBE_ID}
    if tool in ("native.payment_link", "native.charge_mandate"):
        return {"quote_id": PROBE_ID}
    if tool == "native.capture_lead":
        return {"name": PROBE_NAME}
    if tool == "native.request_callback":
        return {"name": PROBE_NAME, "contact": PROBE_CONTACT, "reason": reason[:200] or PROBE_NAME}
    if tool == "native.start_verification":
        return {"contact": PROBE_CONTACT}
    if tool == "payments.create_refund":
        return {"charge_id": PROBE_ID}
    return {}


def _largest(prices: dict[str, int]) -> tuple[str, int] | None:
    return max(prices.items(), key=lambda item: (item[1], item[0])) if prices else None


def situation(number: int, draft: SituationDraft, prices: dict[str, int], hours: list[HoursWindow], timezone: str,
              now: datetime) -> Situation:
    """A drafted situation with the probe code builds for it: the caller from `who` (an agent's spending limit the
    stand-in price, so the probe asks the owner's rules and not the agent's limit), the resource, the price of the
    item named (else the largest), and the time: after hours by `after_hours_start`, a booking at `next_opening`."""
    actor = "agent" if draft.who == "agent" else "visitor"
    verified = draft.who == "verified"
    own = verified and draft.own_record
    resource_kind = RESOURCE_KINDS[draft.tool]
    named = (draft.item_id, prices[draft.item_id]) if draft.item_id in prices else _largest(prices)
    priced = draft.tool == "native.quote" or draft.tool in MONEY_TOOLS
    amount = named[1] if priced and named is not None else None
    starts_at = (after_hours_start(hours, timezone, now) if draft.who == "after_hours"
                 else next_opening(hours, timezone, now) if draft.tool == "native.book" else None)
    mandate = amount if actor == "agent" and draft.tool in ("native.payment_link", "native.charge_mandate") else None
    args = probe_args(draft.tool, item_id=named[0] if named else None, discount_bp=draft.requested_discount_bp,
                      slot_at=_local(starts_at or now, ZoneInfo(timezone)), reason=draft.title)
    probe = Probe(actor=actor, who="record_owner" if own else "verified" if verified else "anyone",
                  agent_mandate_remaining_cents=mandate,
                  call=ToolCall(call_id=f"situation-{number}", tool=draft.tool, args=args),
                  resource_kind=resource_kind,
                  resource_owner=("caller" if own else "other") if resource_kind in ("document", "charge") else "none",
                  amount_cents=amount, starts_at=starts_at)
    return Situation(title=draft.title.strip(), who=draft.who, probe=probe, expected=draft.expected)


async def _run_probes(owner: OwnerCtx, desk_id: str, version: int, probes: list[Probe]) -> list[ProbeResult]:
    """The kernel's result for each probe against `version`, in order; a kernel that doesn't answer in time is 409
    `rules_cannot_be_checked`."""
    try:
        results = await owner.kernel.call("POST /policy/{version}/probe",
                                          PolicyProbeRequest(desk_id=desk_id, probes=probes),
                                          path={"version": version})
    except KernelUnavailable as unavailable:
        if unavailable.status is None:
            raise ApiProblem(409, "rules_cannot_be_checked") from None
        raise
    if [result.probe for result in results] != probes:
        raise KernelUnavailable("POST /policy/{version}/probe")   # not one answer per probe, in order
    return results


async def _drafted_cards(owner: OwnerCtx, desk_id: str, version: int) -> list[RuleCard]:
    row = await owner.ro.one("policy_versions", desk_id=desk_id, version=version)
    if row is None:
        raise ApiProblem(409, "conflict")
    return [RuleCard.model_validate(card) for card in row["cards"]]


async def situations(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview_id: str,
                     now: datetime) -> list[SituationResult]:
    """Six situations Claude writes from the answers and the drafted cards (route `situations`), each tried against
    the draft by the kernel, with whether the result is what was planned (`situation_matches`)."""
    async with engine.connect() as conn:
        interview = await _load(conn, owner.copy_id, interview_id)
    desk_id = owner.desk(interview.desk_id)
    _require_step(interview, RULE_STEPS, drafted=True)
    version = interview.draft_version
    drafted_cards = await _drafted_cards(owner, desk_id, version)
    cards = [card for card in drafted_cards if not card.is_default]
    prices = await _prices(owner, desk_id)
    timezone = (await _business(owner, desk_id))["timezone"]
    rules_text = json.dumps([card.model_dump(mode="json", exclude={"card_id", "person_id", "agent_key_id",
                                                                   "is_default"}) for card in cards])
    message = _user("\n\n".join([SITUATIONS_HEAD.format(business_type=interview.business_type),
                                 wrap(RULES_TAG, rules_text), wrap(PRICES_TAG, json.dumps(prices)),
                                 wrap(ANSWERS_TAG, interview.answers.model_dump_json(exclude_defaults=True))]))
    drafted = await ask_model(model, recorder(engine, owner, SITUATIONS_ROUTE), SITUATIONS_SYSTEM, [message],
                              DraftedSituations, max_tokens=SITUATIONS_MAX_TOKENS, route=SITUATIONS_ROUTE,
                              effort="medium")
    if drafted is None:
        raise ApiProblem(503, "model_unavailable")
    built = [situation(number, draft, prices, interview.answers.hours, timezone, now)
             for number, draft in enumerate(drafted.situations, 1)]
    results = await _run_probes(owner, desk_id, version, [each.probe for each in built])
    await _update(engine, owner, interview_id, lambda found: setattr(found, "step", _later(found.step, "situations")))
    by_id = {card.card_id: card for card in drafted_cards}
    return [SituationResult(situation=each, result=result, matches=situation_matches(each.expected, result, by_id))
            for each, result in zip(built, results, strict=True)]


def situation_matches(planned: PlannedOutcome, result: ProbeResult, cards: dict[str, RuleCard]) -> bool:
    """Whether the kernel's result is what the situation planned. A plan of `allow_if_reviewed` matches a result
    that depends on the reviewer and that an auto rule with `review` decided (one of its `card_ids`); any other plan
    matches the same outcome when it doesn't depend on the reviewer, so an unconditional "does it", "asks" or
    "never" that the reviewer would decide is flagged."""
    if planned == "allow_if_reviewed":
        return result.depends_on_review and any(
            card.mode == "auto" and card.review for card in (cards.get(card_id) for card_id in result.card_ids)
            if card is not None)
    return result.outcome == planned and not result.depends_on_review


def safety_probes(answers: SetupAnswers, prices: dict[str, int]) -> list[tuple[SafetyProbe, Probe]]:
    """Each safety probe with the `Probe` built for it from the Desk's prices and the answered limits; a row whose
    stand-in price the Desk lacks is left out."""
    largest = _largest(prices)
    built = []
    for number, spec in enumerate(SAFETY_PROBES, 1):
        item_id, amount = (largest if largest is not None else (None, None))
        if spec.stand_in == "over_mandate" and amount is not None:
            amount = max(amount, (spec.mandate_cents or 0) + 1)
        elif spec.stand_in == "over_money_limit" and answers.payment_link_auto_max_cents is not None:
            amount = min(answers.payment_link_auto_max_cents, answers.auto_money_cap_cents) + 1
        if spec.stand_in is not None and amount is None:
            continue
        probe = Probe(actor=spec.actor, who=spec.who, agent_mandate_remaining_cents=spec.mandate_cents,
                      call=ToolCall(call_id=f"safety-{number}", tool=spec.tool,
                                    args=probe_args(spec.tool, item_id=item_id, discount_bp=spec.discount_bp)),
                      resource_kind=spec.resource_kind, resource_owner=spec.resource_owner,
                      amount_cents=amount if spec.stand_in is not None else None)
        built.append((spec, probe))
    return built


async def safety_check(owner: OwnerCtx, engine: AsyncEngine, interview_id: str) -> SafetyCheck:
    """What a bad actor would try, against the draft: each row's outcome and reason are the kernel's, verbatim, and a
    row is blocked only by an outcome that stops it and never when it depends on the reviewer."""
    async with engine.connect() as conn:
        interview = await _load(conn, owner.copy_id, interview_id)
    desk_id = owner.desk(interview.desk_id)
    _require_step(interview, RULE_STEPS, drafted=True)
    built = safety_probes(interview.answers, await _prices(owner, desk_id))
    started = monotonic()
    results = await _run_probes(owner, desk_id, interview.draft_version, [probe for _, probe in built])
    seconds = round(monotonic() - started, 1)
    rows = [SafetyRow(label=spec.label, tries=spec.tries, result=result,
                      blocked=result.outcome in spec.blocked_by and not result.depends_on_review)
            for (spec, _), result in zip(built, results, strict=True)]
    await _update(engine, owner, interview_id,
                  lambda found: setattr(found, "step", _later(found.step, "safety_check")))
    return SafetyCheck(rows=rows, blocked=sum(row.blocked for row in rows), total=len(rows), seconds=seconds)


# Confirming and going live -----------------------------------------------------------------------------------------


async def confirm(owner: OwnerCtx, engine: AsyncEngine, interview_id: str) -> PolicyVersion:
    """Activate the rules draft, with Answering still off (step `preview`). When the kernel finds the rules changed
    since the draft (409), the same cards are drafted again on the rules now in force, and the new draft is raised
    (`RulesChangedSinceDraft`) for the owner to confirm instead. A draft the kernel already activated (a confirm
    whose answer was lost) moves setup on without activating anything again; any other draft that isn't proved is
    409 `conflict`."""
    async with engine.connect() as conn:
        interview = await _load(conn, owner.copy_id, interview_id)
    desk_id = owner.desk(interview.desk_id)
    _require_step(interview, RULE_STEPS, drafted=True)
    row = await owner.ro.one("policy_versions", desk_id=desk_id, version=interview.draft_version)
    if row is not None and row["status"] == "active":     # a Desk has one active version: this draft is in force
        await _update(engine, owner, interview_id, lambda found: setattr(found, "step", "preview"))
        return version_from_row(row)
    if row is None or row["status"] != "proved":
        raise ApiProblem(409, "conflict")
    try:
        active = await owner.kernel.call("POST /policy/confirm", PolicyConfirmRequest(
            desk_id=desk_id, version=interview.draft_version))
    except KernelFailed as refused:
        if refused.code != "conflict":
            raise
        version = checkable(await _post_draft(owner, desk_id, interview.draft_cards))
        await _drafted(engine, owner, interview_id, version.version, "rules")
        raise RulesChangedSinceDraft(rules_draft(version, interview.answers.auto_money_cap_cents)) from None
    await _update(engine, owner, interview_id, lambda found: setattr(found, "step", "preview"))
    return active


async def go_live(owner: OwnerCtx, engine: AsyncEngine, interview_id: str, public_origin: str) -> WentLive:
    """Turn Answering on once the rules are confirmed (step `preview`, else 409 `conflict`): the Desk answers the
    public at its address (step `live`)."""
    async with engine.connect() as conn:
        interview = await _load(conn, owner.copy_id, interview_id)
    desk_id = owner.desk(interview.desk_id)
    _require_step(interview, ("preview",))
    await owner.kernel.call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=True), path={"id": desk_id})
    await _update(engine, owner, interview_id, lambda found: setattr(found, "step", "live"))
    slug = await _slug(owner, desk_id)
    return WentLive(public_url=f"{public_origin}/d/{slug}", slug=slug)


# Tools -------------------------------------------------------------------------------------------------------------


async def setup_tools(owner: OwnerCtx, engine: AsyncEngine, interview_id: str) -> SetupTools:
    """The new Desk's tools as the kernel lists them, each with the active rules' cards that cover it, and the mock
    payments server while it isn't connected."""
    desk_id = await interview_desk(owner, engine, interview_id)
    rows = await tool_rows(owner, desk_id, version_from_row(await active_row(owner, desk_id)).cards)
    connected = any(row.tool in MCP_TOOLS for row in rows)
    return SetupTools(tools=rows, connectable=[] if connected else ["mock_payments"])


async def connect_tools(owner: OwnerCtx, engine: AsyncEngine, interview_id: str) -> list[ToolRow]:
    """Connect the mock payments server to the new Desk before its rules are confirmed: its tools come back pinned and
    `needs_review`."""
    async with engine.connect() as conn:
        interview = await _load(conn, owner.copy_id, interview_id)
    desk_id = owner.desk(interview.desk_id)
    _require_step(interview, RULE_STEPS)
    return await connect_payments(owner, desk_id)
