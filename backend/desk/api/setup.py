"""Setup (Plan 02b, Tasks 6 and 7): the owner's description, the Desk, the memory and website reads and the questions
(part 1); then the Desk's parts, its rule cards, the situations and safety check tried against them, the confirm and
going live (part 2, from "Setup, part 2" below).

An interview (`app.setup_interviews`, one row per interview, copy-scoped) runs in three kinds of request:

- **Start** (`start`): one structured model call reads the owner's description (`SetupStart`), then the kernel makes
  the Desk (`POST /desks`, which activates the `ask_first` preset: its auto cards cover the setup tools). Its ID is
  committed as soon as the kernel returns it and kept on failure. A failed start deletes its Desk best effort;
  a failed delete is logged by type, and the start's own failure still goes out. The start turns Answering off, so
  nothing answers the public until setup takes the Desk live (tried twice; a Desk that stays answering is deleted,
  and the request answers the kernel's error). Claude then asks for consent. Each start carries
  the client's `idempotency_key` (required) and writes the interview's row first, holding the key and its body's
  hash, with no Desk yet. A keyed start is finished only once its transcript is stored (`_start_finished`); a read
  before that is 404, even after the Desk is linked. An old unkeyed row counts as finished without this check.
  A unique index on `(copy_id, idempotency_key)` lets one row
  in a copy hold a key. A start that fails before the kernel is asked for the Desk (Claude couldn't answer, say)
  deletes its row, since nothing was made, so the same request can be sent again. Before the kernel is asked for the
  Desk, the start records a boundary in the kernel's clock domain on the row (`desk_requested_at`, committed): the
  copy's newest Desk creation time, or 1970-01-01 UTC when none exists. From then on the row keeps the outcome, a
  failure too (`start_error`). The Desk-list guard assumes no Desk is made outside setup between this read and
  `POST /desks` (the web never does that), and the kernel clock does not step backwards during the start. An outside
  Desk in that gap can take the claim; a backwards clock can leave the start's own Desk reading live. Removing
  these assumptions requires a kernel request tag on the Desk.
  A repeat (`repeated_start`) finds the row and answers its interview as it stands, with
  nothing made: 409 `conflict` for another body, 409 `key_spent` when the first failed (the key can't start again,
  so a new click sends a new key), and while the first is still starting, 409 `in_progress` at once (`retry_after`
  2 s), holding nothing while the client waits. A row still starting after the longest a start can take
  (`START_ABANDONED_S`) has stopped. One that never recorded asking for its Desk is abandoned, and a repeat deletes
  it. One that did record it, with no Desk and no failure, stays uncertain (the Desk may exist, its answer lost).
  A linked-but-unfinished row has its Desk ID but no transcript. Both states are kept and their keys spent
  (409 `key_spent`) after abandonment, so only a new key starts again.
  The lookup, the limits and the claim run under the key's lock in this process (`ADMISSIONS`), so a concurrent
  repeat waits for the first's admission and is never counted; another process's repeat meets the unique index
  instead. A row written before the key was required may hold none (the column stays nullable); it is read and
  moved on like any other.
- **Consent** (`consent`): the shared turn runner stores the owner's answer at once, then searches
  their Claude memory (`native.read_memory`) and reads the named website (`native.fetch_website`) on yes. On no it
  skips both. `_after_consent` appends the consultant opening and first fact question; the labels and reply are saved together.
  No memory or website read ever runs after no, and a website the owner names later is kept as text.
- **Answer** (`answer`): one structured model call over the business type, the question asked, the answers so far
  and the wrapped memory, website, current question's earlier owner answers and Claude replies, and owner's answer,
  answered in that question's own model (`SETUP_TURNS`). With one ask, the exchange starts after it; with follow-ups,
  it starts at this topic's first ask, keeping every question and answer in view. Its patch merges into the answers.
  Each limit (the quote, discount and payment link limits, the documents rule, the money cap and the refunds rule,
  which is the money question's: refunds are money going out) is
  a field only of its own question's model, whose message leaves the memory and website out, and code drops it from
  any other turn's patch too, so no other turn, and nothing the website or memory says, can set it. A limit question's model has no
  fact either (its turn reads none of the facts so far), and code drops a fact from a limit turn's patch too, but for
  the quote question's prices, named from the owner's answer alone (the turn reads no price list): code updates the
  item of each title or adds it, never removing one. A fact question clears the hours or the prices only by its
  flag, since an empty list leaves them as they are. A new website is read only with consent; a new owner or business
  name goes to the kernel (`PUT /desks/{id}/business`). Once the last question is answered, the interview moves on to
  step `tools`: settle the cards, append Claude's closing plan, then finish. Only a failed or empty closing plan
  after its retry gets the fixed transition line instead.

`run_turn` runs consent, answers and card decisions with one guard and one background task per interview. After
admission it stores staged entries with a fresh pending run ID. Any pending entry makes the interview busy. The
request waits for this commit, then up to `TURN_WAIT_S` (25 seconds): 200 with the landed state, an error if the task
fails in time, or 202 with the stored busy state. Cancelling the request leaves the task working on its own
connections. Any turn while busy returns that state without running or counting on the limits.
The task commits its changes and clears or removes staged entries together within `TURN_RUN_TIMEOUT_S` (100
seconds). An optional `after` hook runs outside that deadline, with no transaction open and its own
`TURN_AFTER_TIMEOUT_S` bound (30 seconds); its failures are logged by type only and return the landed state.
Failure, deadline or shutdown before the final commit removes only entries marked by that run. Shutdown after
the final commit ends the task without rollback. Removing a pending answer immediately
after Claude's consent question also reopens consent. GET and every turn recover all pending entries older than
`TURN_ABANDONED_S` (120 seconds) when this process holds no run for the interview.

Each setup tool call is an owner call on the new Desk (`run_setup_tool`): the tool must be in the owner's `/context`,
then `/decide`, and `/execute` only on an allow. A read that is held, refused or fails doesn't stop setup: its inline
label says it couldn't. What a read returned is kept in the transcript (for later turns, as untrusted text), never
shown to the owner beyond its label, and reaches the model only inside a wrapper (`prompts.wrap`).

Model calls use route `setup` on `claude-opus-5-5` at low effort, each bounded by `SETUP_TIMEOUT_S`, except the
understanding call at medium effort with `UNDERSTAND_TIMEOUT_S`. The SDK's retries are included, and each call is
recorded right after it returns. An answer that doesn't fit its model gets one retry with the
errors; then the request is 503 `model_unavailable` and nothing of it is stored. An answer that stopped before it
finished (`max_tokens`, say), or a call that ran out of time, is 503 at once, whatever its text.

No transaction waits on the model, a read or the kernel. Consent saves its busy state first; its final write and an
answer lock the row only to check that nothing changed since the snapshot and save (409 `conflict` when something
did, with nothing saved); every row lock is waited for at most `LOCK_TIMEOUT`, then 409 too. While a turn runs,
another turn is 409 at once in this process, except a busy consent repeat, which answers 202 before taking the guard.
Another process's changed snapshot is caught when it saves.
An answer names the question it answers (409 when another is waiting), so two answers can't both answer one question
and an answer sent twice can't answer the next.

Part 2 runs through the proving routes (`desk.api.proving`). The rules step puts the Desk's parts on the kernel
(`seed_parts`, by code from the answers), has Claude draft rule cards (route `card_draft`), which code checks (a target
the Desk offers, the contract's limits, the answered limits and money cap, the owner's "never" answers, no money going
out on its own), stores them, and posts them after the Ask me first preset's utility cards to `POST /policy/draft`,
which compiles and proves them. Cards code can't use, or that the kernel refuses as invalid (naming no card), get
Claude's one retry, then the template cards; so do cards that would change starting a verification, which the API
refuses before the kernel is asked, with the check the kernel refuses them with. A re-post sends the stored cards and
never drafts again; a rejected proof, or stored cards the kernel refuses, fall back to the template cards once. The
situations (route `situations`) and the safety check (`SAFETY_PROBES`) are probes the kernel decides against the draft,
running nothing. The confirm activates the draft with Answering still off, and going live turns it on.
"""

import asyncio
import contextlib
import inspect
import json
import logging
import re
import secrets
import unicodedata
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Iterator
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, time, timedelta
from functools import partial
from time import monotonic
from typing import Literal, TypeVar, cast, get_args
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from psycopg.errors import LockNotAvailable
from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy import Interval, delete, func, literal, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import OperationalError
from sqlalchemy.sql import Executable
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from desk.api.turn_runs import TurnRuns
from desk.api.deps import ApiProblem, OwnerCtx
from desk.api.idempotency import Admissions, body_sha256
from desk.api.kernel_client import DEFAULT_TIMEOUT_S, KernelFailed, KernelUnavailable
from desk.api.link_notices import tell_cancelled_links
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
    CAPABILITIES,
    CARD_DRAFT_SYSTEM,
    CARD_ERROR_LINE,
    CARD_ERRORS,
    CARDS_REFUSED,
    CONNECTOR_LABELS,
    DRAFT_RETRY,
    LIMIT_CHOICES,
    LIMIT_QUESTIONS,
    LIMIT_TURN_FACTS,
    MEMORY_TAG,
    OPT_IN_TOPICS,
    OWNER_ANSWER_TAG,
    OWNER_DECISION_TAG,
    OWNER_DESCRIPTION_TAG,
    PRICE_ITEMS_MAX,
    PRICES_TAG,
    QUESTION_KEYS,
    QUESTION_ASKED_TAG,
    RULES_TAG,
    SETUP_EXCHANGE_LABELS,
    SETUP_NEXT_HEAD,
    SETUP_NEXT_SYSTEM,
    SETUP_CARD_ANSWER_SYSTEM,
    SETUP_CLIENT_CARDS,
    SETUP_CLOSING_LINE,
    SETUP_PLAN_TAG,
    SETUP_RETRY,
    SETUP_START_SYSTEM,
    SETUP_TURN_SYSTEM,
    SETUP_TURNS,
    SETUP_UNDERSTAND_HEAD,
    SETUP_UNDERSTAND_SYSTEM,
    SETUP_PAYMENT_UNAVAILABLE_LINE,
    SITUATIONS_HEAD,
    SITUATIONS_SYSTEM,
    SITUATION_CALLER_TOOL_REQUIRED,
    SITUATION_PRICE_REQUIRED,
    SITUATION_TOOLS_BY_WHO,
    TOOLS_TAG,
    BusinessType,
    Choice,
    ConnectorProposal,
    ConnectorKey,
    DraftedRules,
    DraftedSituations,
    DraftOutput,
    JobDraft,
    JobProposal,
    MemoryDraft,
    PlannedOutcome,
    PriceAnswer,
    ProposalCard,
    SetupNextStep,
    SetupCardAnswer,
    QuestionKey,
    RuleCardDraft,
    SetupAnswers,
    SetupPatch,
    SetupStart,
    SetupUnderstanding,
    SituationDraft,
    SuggestedFacts,
    card_draft_head,
    new_proposal_id,
    question_text,
    setup_turn_head,
    summary_line,
    this_question_so_far,
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
    ChangesAlwaysOn,
    active_row,
    checkable,
    connect_payments,
    post_draft,
    rules_draft,
    tool_rows,
    version_cap,
    version_from_row,
)
from desk.contracts import (
    AUTO_MONEY_HARD_CAP_CENTS,
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
    DeskMemoryRequest,
    DeskNotificationsRequest,
    DeskPricesRequest,
    ExecuteRequest,
    MemoryItem,
    PolicyConfirmRequest,
    PolicyProbeRequest,
)
from desk.presets import PRESETS

logger = logging.getLogger(__name__)

INTERVIEWS = SetupInterview.__table__
ROUTE = "setup"
START_MAX_TOKENS = 4096
TURN_MAX_TOKENS = 4096
# The most one structured setup call may take, the SDK's retries included (and each of its tries): a stalled call ends
# as 503 `model_unavailable` instead of holding the owner's request. A rules chat has its own (`rules.CHAT_TIMEOUT_S`).
SETUP_TIMEOUT_S = 60.0
UNDERSTAND_TIMEOUT_S = 60.0
UNDERSTAND_MAX_TOKENS = 8192
TURN_WAIT_S = 25             # the request's wait; the run keeps going after a 202 or a disconnect
TURN_RUN_TIMEOUT_S = 100     # below abandonment, including during a deploy's overlap
TURN_AFTER_TIMEOUT_S = 30    # post-commit work cannot fail or undo the landed turn
TURN_ROLLBACK_TIMEOUT_S = 10  # cleanup also ends before another process may recover the row
TURN_ABANDONED_S = 120       # recover only when this process holds no run
LOCK_TIMEOUT = "5s"              # the most an interview write waits for the row's lock (then 409 `conflict`)
START_RETRY_S = 2               # when to send a repeat again that found its first still starting (409 `in_progress`)
ADMISSIONS = Admissions()       # a keyed start's lookup, limits and claim, one at a time per (copy, key)
# The longest a start can run: Claude's reading of the description and its one retry, each bounded by
# `SETUP_TIMEOUT_S`, then its kernel calls (`POST /desks`, two tries at turning Answering off and a failed start's
# `DELETE`), plus the sample memory write, each bounded by the kernel client's timeout, with a minute's slack for
# the database and the process. A keyed row still starting after this is abandoned: its request stopped.
START_KERNEL_CALLS = 5
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
PAYMENT_LINE = ("I'll ask you before any payment. You can set an amount I handle on my own, "
                "now or later in Rules.")

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


def owner_name(given: str | None, described: str | None) -> str:
    """The name customers see: the one the owner gave, else the one their description gave, reduced to the kernel's
    pattern; "Owner" when neither gives a name. A business name is never a person's name."""
    for candidate in (given, described):
        reduced = reduce_name(candidate)
        if reduced:
            return reduced
    return OWNER_NAME_FALLBACK


def default_notifications(business_type: BusinessType) -> NotificationDefaults:
    """What alerts the owner at once and what waits for the briefing: a held request, a paused chat, a paused
    verification and a conversation the Desk handed to the owner (the handoff card's) alert at once, and a trade is
    also alerted to emergencies."""
    now = ["approval", "breaker", "lockout", "handoff"] + (["emergency"] if business_type == "trade" else [])
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
    website the line named or read. A Claude question can carry choices; a card is a Claude entry with empty text.
    Covered topics record what this entry's turn finished or skipped, for code alone. Planned cards and dropped
    proposal ids are hidden turn metadata; a shown card is a separate copy so its decision can change in place.
    A pending run ID marks an answer until its background work lands."""

    model_config = ConfigDict(extra="forbid")

    role: Literal["claude", "owner", "tool_label"]
    text: str
    question: Literal["consent"] | QuestionKey | None = None
    read: Literal["memory", "website"] | None = None
    content: str | None = None
    website: str | None = None
    choices: list[Choice] = []
    card: ProposalCard | None = None
    covered: list[QuestionKey] = []
    suggested: SuggestedFacts | None = None
    planned: list[ProposalCard] = []
    dropped: list[str] = []
    cards: bool | None = None
    pending: str | None = None
    connected_apps: list[ConnectorKey] | None = None


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
    business_tools_enabled: bool = False   # runtime setting, never stored in the interview row
    turn_deadline: float | None = None     # runtime event-loop clock, never stored
    updated_at: datetime | None = None

    def __post_init__(self) -> None:
        """Recover sequential progress only when no entry has consultant coverage metadata."""
        if any(entry.covered or "covered" in entry.model_fields_set for entry in self.transcript):
            return
        waiting = self.question
        if waiting is None:
            return
        completed = list(dict.fromkeys(entry.question for entry in self.transcript
                                       if entry.question in QUESTION_KEYS and entry.question != waiting))
        if completed:
            # Persist on the next normal save, preserving the waiting question and every stored answer.
            self.latest_ask.covered = completed

    @property
    def shows_cards(self) -> bool:
        return any(entry.role == "owner" and entry.cards is True for entry in self.transcript)

    @property
    def busy(self) -> bool:
        """A stored transcript entry explicitly marks a pending background run."""
        return any(entry.pending is not None for entry in self.transcript)

    @property
    def connected_apps(self) -> list[ConnectorKey]:
        """The simulated apps kept with the owner's opening description, absent on older interviews."""
        if not self.transcript:
            return []
        return self.transcript[0].connected_apps or []

    @property
    def question(self) -> QuestionKey | None:
        """The question waiting for an answer: the last one asked, from consent until the questions step ends."""
        if self.step != "questions" or self.consent is None or self.busy:
            return None
        asked = self.latest_ask
        return asked.question if asked is not None and asked.question in QUESTION_KEYS else None

    @property
    def latest_ask(self) -> Entry | None:
        return next((entry for entry in reversed(self.transcript) if entry.question or entry.card), None)

    @property
    def pending_card(self) -> str | None:
        asked = self.latest_ask
        if self.step == "questions" and asked is not None and asked.card and asked.card.state == "proposed":
            return asked.card.proposal_id
        return None

    @property
    def planned(self) -> list[ProposalCard]:
        shown = {entry.card.proposal_id: entry.card for entry in self.transcript if entry.card}
        return [shown.get(card.proposal_id, card) for entry in self.transcript for card in entry.planned]

    @property
    def dropped(self) -> set[str]:
        return {proposal_id for entry in self.transcript for proposal_id in entry.dropped}

    @property
    def unshown(self) -> list[ProposalCard]:
        shown = {entry.card.proposal_id for entry in self.transcript if entry.card}
        return [card for card in self.planned if card.proposal_id not in shown | self.dropped
                and card.state == "proposed"]

    def tried_websites(self) -> set[str]:
        return {entry.website for entry in self.transcript if entry.read == "website" and entry.website}

    @property
    def suggested(self) -> SuggestedFacts | None:
        return next((entry.suggested for entry in self.transcript if entry.suggested is not None), None)

    @property
    def covered(self) -> set[QuestionKey]:
        return {key for entry in self.transcript for key in entry.covered}

    def cover(self, keys: Iterable[QuestionKey]) -> None:
        """Record newly finished or skipped topics on the last entry, keeping answered limits and all facts."""
        added = set(keys) - self.covered
        self.transcript[-1].covered.extend(key for key in QUESTION_KEYS if key in added)
        # Unanswered amounts already ask and the cap is already 0.
        if LIMIT_QUESTIONS["documents"] in added and self.answers.documents is None:
            self.answers.documents = "ask"
        if "money_limit" in added and self.answers.refunds is None:
            self.answers.refunds = "ask"


def _start_finished(row) -> bool:
    """Old unkeyed interviews are readable; a keyed start finishes when its transcript is stored."""
    return row["idempotency_key"] is None or bool(row["transcript"])


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
    if row is None or row["desk_id"] is None or not _start_finished(row):
        # Linking the Desk is earlier than finishing the start; that alone exposes no readable interview.
        raise ApiProblem(404, "not_found")
    return Interview(interview_id=row["interview_id"], copy_id=row["copy_id"], desk_id=row["desk_id"],
                     business_type=row["business_type"], step=row["step"], consent=row["consent"],
                     answers=SetupAnswers.model_validate(row["answers"]),
                     transcript=[Entry.model_validate(entry) for entry in row["transcript"]],
                     draft_cards=[RuleCard.model_validate(card) for card in row["draft_cards"] or []],
                     draft_version=row["draft_version"], updated_at=row["updated_at"])


def _stored(interview: Interview) -> dict:
    return {"step": interview.step, "consent": interview.consent,
            "answers": interview.answers.model_dump(mode="json"),
            # Omit only top-level nulls and empty additions; nested card nulls are part of its payload.
            "transcript": [entry.model_dump(mode="json", exclude={name for name, value in entry
                                                                 if value is None or
                                                                 (name in {"choices", "covered", "planned", "dropped", "cards"}
                                                                  and not value)})
                           for entry in interview.transcript],
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


def setup_state(interview: Interview, slug: str, *, cards: bool = False) -> SetupState:
    """The interview as the owner sees it. Its messages leave out the transcript's first entry, the owner's own
    description (`start` puts it there), which the owner isn't shown back; the stored transcript, which later turns
    read, keeps it. Card messages appear only when requested by a client that can render them."""
    return SetupState(interview_id=interview.interview_id, desk_id=interview.desk_id, slug=slug, step=interview.step,
                      consent=interview.consent, question=interview.question, busy=interview.busy,
                      pending_card=interview.pending_card,
                      messages=[SetupMessage(role=entry.role, text=entry.text, choices=entry.choices, card=entry.card)
                                for entry in interview.transcript[1:]
                                if (entry.text or entry.choices or entry.card is not None) and
                                (cards or entry.card is None) and (entry.role != "owner" or bool(entry.text))])


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
                    timeout_s: float | Callable[[], float] | None = None,
                    retry_min_s: float = 0) -> Output | None:
    """A structured setup answer as `output` that `check` (if given, awaited when it answers an awaitable) finds
    nothing wrong with. A finished answer (`end_turn`) that doesn't fit, or that `check` lists problems with, gets one
    retry with them; None when the retry doesn't fit either. 503 `model_unavailable` when the model gives no answer at
    all, one that stopped before it finished (any other stop reason, `max_tokens` say) whatever its text, or none
    within `timeout_s` (`SETUP_TIMEOUT_S` unless the caller gives another): each call's usage is recorded first, a
    timed-out one as failed."""
    messages = list(messages)
    for attempt in (1, 2):
        bound = timeout_s() if callable(timeout_s) else SETUP_TIMEOUT_S if timeout_s is None else timeout_s
        if bound <= 0 or (attempt == 2 and bound < retry_min_s):
            return None
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
    answer = await _ask_drafts(model, record, system, messages, output, max_tokens=max_tokens)
    if answer is None:
        raise ApiProblem(503, "model_unavailable")
    return answer


async def _ask_drafts(model: ModelClient, record: Record, system: str, messages: list[dict],
                      output: type[Output], **kwargs) -> Output | None:
    """Retry dropped proposals once; a partial second answer remains usable, including on an unavailable retry."""
    last = None

    def check(parsed: Output) -> str | None:
        nonlocal last
        first = last is None
        last = parsed
        errors = parsed._draft_errors if isinstance(parsed, DraftOutput) else []
        return "\n".join(errors) if first and errors else None

    try:
        answer = await ask_model(model, record, system, messages, output, check=check, **kwargs)
        return answer if answer is not None else last
    except ApiProblem:
        if last is not None:
            return last
        raise


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
    """Turn the new Desk's Answering off, trying twice. Raise the last failure when it stays on; `start` deletes
    the Desk best effort, as it does for any failure after the Desk is made."""
    for attempt in (1, 2):
        try:
            await owner.kernel.call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=False), path={"id": desk_id})
            return
        except (KernelFailed, KernelUnavailable):
            logger.warning("a new Desk's Answering couldn't be turned off (attempt %d)", attempt)
            if attempt == 2:
                raise


async def _read_description(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient,
                            body: SetupStartIn) -> tuple[SetupStart, CreateDeskRequest]:
    """Claude's reading of the owner's description, and the Desk to ask the kernel for. Nothing is made here."""
    described = await structured(model, recorder(engine, owner), SETUP_START_SYSTEM,
                                 [_user(wrap(OWNER_DESCRIPTION_TAG, body.description))], SetupStart, START_MAX_TOKENS)
    business_name = " ".join(described.business_name.split())
    name = owner_name(body.owner_display_name, described.owner_display_name)
    seed = DeskSeed(name=DESK_NAME, charter=[], hours=[], price_items=[], calendar_slots=[], people=[], documents=[],
                    notifications=default_notifications(described.business_type))
    return described, CreateDeskRequest(
        business=BusinessSeed(name=business_name, owner_display_name=name, timezone=body.timezone), desk=seed)


def memory_items(drafts: list[MemoryDraft]) -> list[MemoryItem]:
    """Build kernel-safe IDs and topics that make every drafted note findable by setup's memory query."""
    items = []
    used: set[str] = set()
    query = set(MEMORY_QUERY.split())
    for draft in drafts:
        slug = "-".join(re.findall(r"[a-z]+", draft.title.lower()))
        base = ("m-" + slug)[:60].rstrip("-") if slug else "m-note"
        item_id = base
        suffix = ord("b")
        while item_id in used:
            item_id = base[:58].rstrip("-") + "-" + chr(suffix)
            suffix += 1
        used.add(item_id)
        topics = list(dict.fromkeys(topic for value in draft.topics
                                    if 1 <= len(topic := value.strip().lower()) <= 60))[:9]
        if not query.intersection(topics):
            topics.append("business")
        items.append(MemoryItem(id=item_id, title=draft.title, topics=topics, text=draft.text))
    return items


async def _make_desk(owner: OwnerCtx, body: SetupStartIn, described: SetupStart, desk: CreateDeskRequest,
                     interview_id: str, link: Callable[[str], Awaitable[None]]) -> tuple[Interview, str]:
    """Ask the kernel for the Desk and turn its Answering off: the interview asking for consent, and the Desk's slug.
    Commit its link as soon as the kernel returns, before writing sample memory, turning Answering off and building
    the interview."""
    created = await owner.kernel.call("POST /desks", desk)
    try:
        await link(created.desk_id)
        if described.memory:
            try:
                memory = DeskMemoryRequest(about=described.summary[:500], items=memory_items(described.memory))
                await owner.kernel.call("PUT /desks/{id}/memory", memory,
                                        path={"id": created.desk_id})
            except ValidationError as failure:
                logger.warning("the sample memory couldn't be written (%s)", type(failure).__name__)
            except (KernelFailed, KernelUnavailable) as failure:
                logger.warning("the sample memory couldn't be written (%s %s)", type(failure).__name__, failure.code)
    finally:
        # A failed link write must still try to stop answering before start deletes the Desk.
        await _answering_off(owner, created.desk_id)
    site = website_url(described.website)
    interview = Interview(
        interview_id=interview_id, copy_id=owner.copy_id, desk_id=created.desk_id,
        business_type=described.business_type, step="questions", consent=None,
        answers=SetupAnswers(summary=described.summary, business_name=desk.business.name,
                             owner_display_name=(reduce_name(body.owner_display_name)
                                                 or reduce_name(described.owner_display_name) or None)),
        transcript=[Entry(role="owner", text=body.description, website=site[0] if site else None,
                          connected_apps=described.connected_apps),
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
    """What a start that failed once its Desk was asked for answered, kept on its row: the row is settled and its key
    spent. A repeat answers 409 `key_spent` from its presence. The Desk-list guard also distinguishes a definite
    kernel refusal (`kernel: failed`, no Desk made only when the row keeps no Desk ID) from an uncertain outcome
    (`kernel: unavailable`)."""
    if isinstance(error, ApiProblem):
        return {"status": error.status, "error": error.error, "code": error.code}
    if isinstance(error, KernelFailed):
        return {"kernel": "failed", "status": error.status, "code": error.code}
    if isinstance(error, KernelUnavailable):
        return {"kernel": "unavailable", "route": error.route, "status": error.status, "code": error.code}
    return {"status": 500, "error": "internal", "code": None}


async def _desks_now(owner: OwnerCtx) -> OwnerCtx:
    """The owner's context with the copy's Desks as the kernel's `/whoami` answers now, so a Desk the first start
    made after this request read them counts as the copy's (`OwnerCtx.desk` stays the check)."""
    who = await owner.kernel.whoami()
    if who.copy_id != owner.copy_id:
        raise ApiProblem(404, "not_found")
    return replace(owner, desk_ids=tuple(who.desk_ids))


async def repeated_start(owner: OwnerCtx, engine: AsyncEngine, body: SetupStartIn, *,
                         cards: bool = False) -> SetupState | None:
    """The interview a start with this key made in the copy, as it stands now; None when none holds the key. 409
    `conflict` when the key's start had another body, and 409 `key_spent` when it failed: its Desk was asked for and
    may exist, so the key can't start again. While the first is still starting, 409 `in_progress` at once, to be sent
    again in `START_RETRY_S`. A row still starting after `START_ABANDONED_S` has stopped. One that never recorded
    asking the kernel for its Desk is abandoned (its request stopped before anything was made): it is deleted, if it
    still is one, and the key is free. One that did record it is kept, since its Desk may exist, and its key is spent
    (409 `key_spent`). The Desk ID is committed as soon as the kernel returns it and retained on failure. A keyed
    row is readable only after its transcript is stored (`_start_finished`): linked-but-unfinished rows, like
    uncertain rows with no ID kept, answer `in_progress` until abandonment, then `key_spent`."""
    key, sha = body.idempotency_key, start_sha256(body)
    found = select(INTERVIEWS.c.interview_id, INTERVIEWS.c.desk_id, INTERVIEWS.c.request_sha256,
                   INTERVIEWS.c.start_error, INTERVIEWS.c.desk_requested_at, INTERVIEWS.c.transcript,
                   INTERVIEWS.c.idempotency_key,
                   _STALE.label("stale")).where(
        INTERVIEWS.c.copy_id == owner.copy_id, INTERVIEWS.c.idempotency_key == key)
    async with engine.connect() as conn:
        row = (await conn.execute(found)).mappings().one_or_none()
    if row is None:
        return None
    if row["request_sha256"] != sha:
        raise ApiProblem(409, "conflict")
    if row["start_error"] is not None:
        raise ApiProblem(409, "key_spent")
    if row["desk_id"] is None or not _start_finished(row):
        if row["stale"] and row["desk_requested_at"] is not None:
            raise ApiProblem(409, "key_spent")
        if row["stale"] and await _drop_abandoned(engine, owner.copy_id, row["interview_id"]):
            return None
        raise ApiProblem(409, "in_progress", retry_after=START_RETRY_S)
    if row["desk_id"] not in owner.desk_ids:          # made after this request read the copy's Desks
        owner = await _desks_now(owner)
    interview = await _read(engine, owner, row["interview_id"])
    return setup_state(interview, await _slug(owner, interview.desk_id), cards=cards)


async def _drop_abandoned(engine: AsyncEngine, copy_id: str, interview_id: str) -> bool:
    """Delete an abandoned keyed row only while it still is one (no Desk asked for, no Desk, no failure, older than
    `START_ABANDONED_S`), so a start that moved on meanwhile keeps its row: whether it went."""
    async with engine.connect() as conn:
        gone = await conn.execute(delete(INTERVIEWS).where(
            INTERVIEWS.c.interview_id == interview_id, INTERVIEWS.c.copy_id == copy_id, INTERVIEWS.c.desk_id.is_(None),
            INTERVIEWS.c.start_error.is_(None), INTERVIEWS.c.desk_requested_at.is_(None), _STALE))
        await conn.commit()
    if gone.rowcount == 1:
        logger.warning("a keyed setup start abandoned mid-way was let go")
    return gone.rowcount == 1


async def start(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, body: SetupStartIn, *,
                admit: Callable[[], Awaitable[None]], cards: bool = False) -> SetupState:
    """Read the owner's description, make the Desk with Answering off, and ask for consent, once `admit` (the route's
    limits) lets the start through. A repeat of the client's key is answered before `admit` counts it; otherwise the
    interview's row is written first, under the key's lock, and the start's outcome saved to it, its failure too
    (module docstring). A request another process admitted meanwhile is answered as a repeat."""
    key = body.idempotency_key
    async with ADMISSIONS.admitting(owner.copy_id, key):
        repeat = await repeated_start(owner, engine, body, cards=cards)
        if repeat is not None:
            return repeat
        await admit()
        interview_id = await _claim(engine, owner.copy_id, key, start_sha256(body))
    if interview_id is None:                        # another process took the key since this one looked
        repeat = await repeated_start(owner, engine, body, cards=cards)
        if repeat is None:                          # and has let it go again: this one is to be sent again
            raise ApiProblem(409, "in_progress", retry_after=START_RETRY_S)
        return repeat
    keyed = (INTERVIEWS.c.interview_id == interview_id, INTERVIEWS.c.copy_id == owner.copy_id)
    try:
        described, desk = await _read_description(owner, engine, model, body)
        await _asking_for_desk(owner, engine, keyed)
    except BaseException:                           # nothing was made: the key is free for the same request again
        await _settle(engine, delete(INTERVIEWS).where(*keyed))
        raise
    created_desk_id = None

    async def link(desk_id: str) -> None:
        nonlocal created_desk_id
        created_desk_id = desk_id          # the failure write also knows it if this first write fails
        async with engine.connect() as conn:
            await conn.execute(update(INTERVIEWS).where(*keyed).values(desk_id=desk_id, updated_at=func.now()))
            await conn.commit()

    try:
        interview, slug = await _make_desk(owner, body, described, desk, interview_id, link)
        async with engine.connect() as conn:
            await conn.execute(update(INTERVIEWS).where(*keyed).values(
                desk_id=interview.desk_id, business_type=interview.business_type, **_stored(interview),
                updated_at=func.now()))
            await conn.commit()
    except BaseException as error:                  # the Desk was asked for: the key keeps the outcome
        if created_desk_id is not None:
            try:
                await owner.kernel.call("DELETE /desks/{id}", path={"id": created_desk_id})
            except Exception as failed:
                logger.error("a failed setup start's Desk couldn't be deleted (%s)", type(failed).__name__)
        await _settle(engine, update(INTERVIEWS).where(*keyed).values(
            desk_id=created_desk_id, start_error=_failure_record(error), updated_at=func.now()))
        raise
    return setup_state(interview, slug, cards=cards)


async def _asking_for_desk(owner: OwnerCtx, engine: AsyncEngine, keyed: tuple) -> None:
    """Record on the keyed row, committed, that the start is about to ask the kernel for its Desk: from then on the
    Desk may exist, so the row is never taken over as abandoned. 409 `in_progress`, with no Desk asked for, when the
    row isn't there to record it on (a repeat took it over)."""
    # This boundary is in the kernel's clock domain, not Postgres's: only a Desk newer than every Desk
    # already in this copy can belong to this start, even when the two processes' clocks disagree.
    async with engine.connect() as conn:
        desks = await KernelRO(conn, owner.copy_id, owner.ro.schema).desks()
        boundary = max((desk["created_at"] for desk in desks), default=datetime(1970, 1, 1, tzinfo=UTC))
        recorded = await conn.execute(update(INTERVIEWS).where(*keyed, INTERVIEWS.c.desk_requested_at.is_(None))
                                      .values(desk_requested_at=boundary, updated_at=func.now()))
        await conn.commit()
    if recorded.rowcount != 1:
        raise ApiProblem(409, "in_progress", retry_after=START_RETRY_S)


async def _settle(engine: AsyncEngine, statement: Executable) -> None:
    """A failed keyed start's last write to its row, on a connection of its own. One that fails is logged by type
    only: the start's own answer still goes out, and its row stays in progress for a repeat to find."""
    try:
        async with engine.connect() as conn:
            await conn.execute(statement)
            await conn.commit()
    except Exception as failed:
        logger.warning("a keyed setup start's row couldn't be settled (%s)", type(failed).__name__)


async def _recover_turn(owner: OwnerCtx, engine: AsyncEngine, interview_id: str,
                        runs: TurnRuns) -> Interview:
    interview = await _read(engine, owner, interview_id)
    if interview.busy and not runs.holds(interview_id) and _turn_abandoned(interview):
        await _rollback_turn(owner, engine, interview_id, None, abandoned=True)
        interview = await _read(engine, owner, interview_id)
    return interview


def _turn_abandoned(interview: Interview) -> bool:
    return (interview.updated_at is not None
            and (datetime.now(UTC) - interview.updated_at).total_seconds() > TURN_ABANDONED_S)


async def read(owner: OwnerCtx, engine: AsyncEngine, interview_id: str, *, runs: TurnRuns, cards: bool = False) -> SetupState:
    interview = await _recover_turn(owner, engine, interview_id, runs)
    return setup_state(interview, await _slug(owner, interview.desk_id), cards=cards)


def _ask(interview: Interview, key: QuestionKey) -> Entry:
    return Entry(role="claude", text=question_text(key, interview.business_type), question=key,
                 choices=_limit_choices(interview, key))


def _limit_choices(interview: Interview, key: QuestionKey) -> list[Choice]:
    return [Choice(text=choice.text, recommended=False) for choice in LIMIT_CHOICES[key](interview.business_type)] \
        if key in LIMIT_CHOICES else []


def _run_id(interview: Interview) -> str | None:
    return next((entry.pending for entry in interview.transcript if entry.pending is not None), None)


def _history(interview: Interview, run_id: str | None = None) -> list[Entry]:
    """The run's staged answer is current input, never part of its own transcript history."""
    run_id = run_id or _run_id(interview)
    return [entry for entry in interview.transcript if run_id is None or entry.pending != run_id]


def _understanding_message(interview: Interview, entries: list[Entry]) -> dict:
    """The description and consented homework, each inside its information wrapper."""
    parts = [SETUP_UNDERSTAND_HEAD.format(business_type=interview.business_type),
             SETUP_CLIENT_CARDS[interview.shows_cards],
             wrap(OWNER_DESCRIPTION_TAG, _history(interview)[0].text)]
    if not interview.business_tools_enabled:
        parts.insert(1, SETUP_PAYMENT_UNAVAILABLE_LINE)
    for entry in entries:
        if entry.pending is not None and entry.pending == _run_id(interview):
            continue
        if entry.read == "memory" and entry.content:
            parts.append(wrap(MEMORY_TAG, entry.content))
        elif entry.read == "website" and entry.content:
            parts.append(wrap_website(entry.content, entry.website or ""))
    return _user("\n\n".join(parts))


def _normalize_choices(choices: list[Choice]) -> list[Choice]:
    """Two to four choices, with at most the first marked recommendation moved to the front."""
    choices = choices[:4]
    if len(choices) < 2:
        return []
    recommended = next((index for index, choice in enumerate(choices) if choice.recommended), None)
    normalized = [choice.model_copy(update={"recommended": index == recommended})
                  for index, choice in enumerate(choices)]
    if recommended is not None:
        normalized.insert(0, normalized.pop(recommended))
    return normalized


async def _after_consent(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview: Interview,
                         entries: list[Entry]) -> None:
    """Append the consultant opening and its first fact question; the caller owns persistence."""
    def time_left() -> float:
        if interview.turn_deadline is None:
            return UNDERSTAND_TIMEOUT_S
        return min(UNDERSTAND_TIMEOUT_S, interview.turn_deadline - asyncio.get_running_loop().time() - 10)

    try:
        answer = await _ask_drafts(model, recorder(engine, owner), SETUP_UNDERSTAND_SYSTEM,
                                 [_understanding_message(interview, entries)], SetupUnderstanding,
                                 # Fifteen seconds left on the turn: ten to finish, five for a retry.
                                 max_tokens=UNDERSTAND_MAX_TOKENS, effort="medium", timeout_s=time_left, retry_min_s=5)
    except ApiProblem as failed:
        if failed.status != 503 or failed.error != "model_unavailable":
            raise
        answer = None
    if answer is None:
        logger.warning("the setup understanding was unavailable; asking the first question")
        interview.transcript.append(_ask(interview, "what_you_do"))
        return
    opening = Entry(role="claude", text=answer.reply.strip(), suggested=answer.suggested)
    interview.transcript.append(opening)
    opening.planned = [card for draft in answer.jobs if (card := _planned_job(interview, draft)) is not None]
    seen = set()
    for draft in answer.connectors:
        if draft.app in seen:
            continue
        seen.add(draft.app)
        connector = ConnectorProposal(app=draft.app, label=CONNECTOR_LABELS[draft.app], why=draft.why,
                                      connectable=True)
        opening.planned.append(ProposalCard(
            proposal_id=new_proposal_id(), kind="connector", state="proposed", job=None, connector=connector))
    interview.transcript.append(Entry(role="claude", text=answer.question.strip() or
                                     question_text(answer.next_topic, interview.business_type),
                                     question=answer.next_topic, choices=_normalize_choices(answer.choices)))


def _setup_plan(interview: Interview, *, run_id: str | None = None) -> dict:
    transcript = _history(interview, run_id)
    shown = {entry.card.proposal_id: entry.card for entry in transcript if entry.card}
    planned = [shown.get(card.proposal_id, card) for entry in transcript for card in entry.planned]
    dropped = {proposal_id for entry in transcript for proposal_id in entry.dropped}
    items = []
    for card in planned:
        status = (card.state if card.state != "proposed" else
                  "dropped" if card.proposal_id in dropped else
                  "shown" if card.proposal_id in shown else "planned")
        if card.state == "changed":
            status = f"changed (replaced by {card.superseded_by})"
        payload = (card.job.model_dump(include={"title", "why", "how", "autonomy"}) if card.job else
                   card.connector.model_dump(include={"app", "label", "why"}))
        items.append({"id": card.proposal_id, "kind": card.kind, **payload, "status": status})
    return {"understanding": next((entry.text for entry in transcript if entry.suggested is not None), ""),
            "items": items}


async def _rollback_turn(owner: OwnerCtx, engine: AsyncEngine, interview_id: str, run_id: str | None, *,
                         abandoned: bool = False) -> None:
    """Remove only this run's pending entries, or every pending entry when the row is abandoned."""
    async with engine.connect() as conn, conn.begin():
        current = await _load(conn, owner.copy_id, interview_id, lock=True)
        if not current.busy or (abandoned and not _turn_abandoned(current)):
            return
        kept = []
        for index, entry in enumerate(current.transcript):
            if entry.pending is not None and (abandoned or entry.pending == run_id):
                previous = current.transcript[index - 1] if index else None
                if previous is not None and previous.role == "claude" and previous.question == "consent":
                    current.consent = None
            else:
                kept.append(entry)
        if len(kept) == len(current.transcript):
            return
        current.transcript = kept
        await _save(conn, current)


async def run_turn(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview_id: str, *,
                   runs: TurnRuns, ro_schema: str, admit: Callable[[], Awaitable[None]],
                   check: Callable[[Interview], None], stage: Callable[[Interview], list[Entry]],
                   turn: Callable[[OwnerCtx, Interview, list[Entry]], Awaitable[None]],
                   keep_staged: bool = True,
                   after: Callable[[OwnerCtx, Interview], Awaitable[None]] | None = None,
                   render: Callable[[Interview, str], SetupState] = setup_state) -> SetupState:
    """Store staged entries, run a detached owner turn, and return its landed or busy state.

    `stage` only produces entries; consent alone may also set `interview.consent`. Every other change (answers,
    card state, step) belongs in `turn`, so rollback needs no in-memory undo and works after a process dies.
    Hand the guard to the task immediately after admission, without an await in between. Request cancellation
    never cancels the run; wait for its busy commit, then up to `TURN_WAIT_S` for its final state.
    `keep_staged=False` removes temporary markers on success. The run deadline covers detached connection
    acquisition through the final commit.
    `after` keeps the guard, without a transaction open, under its own `TURN_AFTER_TIMEOUT_S` bound; its failure
    is logged by type only and returns the landed state. Shutdown cancellation after commit propagates without
    rolling back the turn.
    """
    interview = await _recover_turn(owner, engine, interview_id, runs)
    desk_id = owner.desk(interview.desk_id)
    if interview.busy:
        return render(interview, await _slug(owner, desk_id))
    seen = _stored(interview)
    check(interview)
    guard = contextlib.ExitStack()
    guard.enter_context(_turn(interview_id))
    busy_stored = asyncio.Event()
    pending: SetupState | None = None

    async def run() -> SetupState:
        nonlocal pending
        run_id = secrets.token_hex(8)
        busy = None
        committed = False
        try:
            async with contextlib.AsyncExitStack() as stack:
                async with asyncio.timeout(TURN_RUN_TIMEOUT_S):
                    ctx = await stack.enter_async_context(detached(owner, engine, ro_schema))
                    slug = await _slug(ctx, desk_id)
                    staged = stage(interview)
                    for entry in staged:
                        entry.pending = run_id
                    interview.transcript += staged
                    busy = _stored(interview)
                    try:
                        await _commit(engine, ctx, interview, seen)
                    except ApiProblem:
                        busy = None          # rejected before storing; another run's snapshot is never ours
                        raise
                    pending = render(interview, slug)
                    busy_stored.set()
                    await turn(ctx, interview, staged)
                    if keep_staged:
                        for entry in staged:
                            entry.pending = None
                    else:
                        interview.transcript = [entry for entry in interview.transcript if entry.pending != run_id]
                    await _commit(engine, ctx, interview, busy)
                    committed = True
                if after is not None:
                    try:
                        async with asyncio.timeout(TURN_AFTER_TIMEOUT_S):
                            await after(ctx, interview)
                    except Exception as failed:
                        logger.warning("setup turn after failed (%s)", type(failed).__name__)
                return render(interview, slug)
        except BaseException as failed:
            if committed:
                if isinstance(failed, asyncio.CancelledError):
                    raise
                logger.warning("setup turn after failed (%s)", type(failed).__name__)
                return render(interview, slug)
            logger.warning("setup turn failed (%s)", type(failed).__name__)
            if busy is not None:
                try:
                    async with asyncio.timeout(TURN_ROLLBACK_TIMEOUT_S):
                        await _rollback_turn(owner, engine, interview_id, run_id)
                except Exception as rollback_failed:
                    logger.warning("setup turn couldn't be reopened (%s)", type(rollback_failed).__name__)
            if isinstance(failed, TimeoutError):
                raise ApiProblem(503, "model_unavailable") from None
            raise
        finally:
            guard.close()
            busy_stored.set()                 # a failed busy commit wakes the request to receive its error

    try:
        await admit()
        task = runs.start(interview_id, run())
    except BaseException:
        guard.close()
        raise

    def settled(_: asyncio.Task) -> None:
        # Cancellation before the coroutine starts must also release the guard and wake the request.
        guard.close()
        busy_stored.set()

    task.add_done_callback(settled)
    await asyncio.shield(busy_stored.wait())
    if pending is None:
        return await asyncio.shield(task)
    done, _ = await asyncio.wait({task}, timeout=TURN_WAIT_S)
    if done:
        return task.result()
    return pending


async def consent(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview_id: str, allow: bool, *,
                  runs: TurnRuns, ro_schema: str, admit: Callable[[], Awaitable[None]],
                  cards: bool = False, business_tools_enabled: bool = False) -> SetupState:
    """Run consent and its reads through the shared turn runner; no reads run after no."""
    def check(interview: Interview) -> None:
        if interview.consent is not None or interview.step != "questions":
            raise ApiProblem(409, "conflict")

    def stage(interview: Interview) -> list[Entry]:
        interview.consent = allow
        return [Entry(role="owner", text=CONSENT_ANSWERS[allow], cards=cards)]

    async def turn(ctx: OwnerCtx, interview: Interview, staged: list[Entry]) -> None:
        entries = []
        if allow:
            entries.append(await _read_memory(ctx, interview.desk_id))
            site = website_url(interview.transcript[0].website)
            if site is not None:
                entries.append(await _read_website(ctx, interview.desk_id, *site))
        interview.transcript += entries
        interview.business_tools_enabled = business_tools_enabled
        await _after_consent(ctx, engine, model, interview, entries)

    return await run_turn(owner, engine, model, interview_id, runs=runs, ro_schema=ro_schema, admit=admit,
                          check=check, stage=stage, turn=turn, render=partial(setup_state, cards=cards))


def _turn_message(interview: Interview, key: QuestionKey, text: str, *, run_id: str | None = None) -> dict:
    """The answer turn's one message: a fact's actual question is wrapped; a limit keeps its fixed head. A limit
    turn (`LIMIT_QUESTIONS`) leaves out what the memory and the website said, and of the answers so far reads only the
    limits already answered (each taken on its own turn), never a fact an earlier turn may have taken from them: not
    even the price list the quote question's prices merge into, whose titles may be website or memory text. Every
    turn includes earlier owner answers and Claude replies since this topic began, including its follow-up asks.
    With more than one ask, the exchange includes the first ask too. It never includes tool labels or their content.
    On a limit question these replies were made under the same isolation;
    earlier questions' replies, which may repeat memory or website text, never enter the exchange. The run's staged
    entries never enter history: its current answer appears only in `owner_answer`."""
    transcript = _history(interview, run_id)
    limit_turn = key in LIMIT_QUESTIONS.values()
    so_far = interview.answers.model_dump_json(exclude_defaults=True)
    if limit_turn:
        so_far = interview.answers.model_dump_json(include=set(LIMIT_QUESTIONS), exclude_defaults=True)
    asked = next((entry.text for entry in reversed(transcript) if entry.question == key), "")
    parts = ([setup_turn_head(interview.business_type, key)] if limit_turn else
             [SETUP_NEXT_HEAD.format(business_type=interview.business_type,
                                     covered=", ".join(key for key in QUESTION_KEYS if key in interview.covered),
                                     uncovered=", ".join(key for key in QUESTION_KEYS if key not in interview.covered)),
              wrap(QUESTION_ASKED_TAG, asked)])
    if not limit_turn and not interview.business_tools_enabled:
        parts.insert(1, SETUP_PAYMENT_UNAVAILABLE_LINE)
    parts.append(wrap(ANSWERS_SO_FAR_TAG, so_far))
    reads = [] if limit_turn else transcript
    for entry in reads:
        if entry.read == "memory" and entry.content:
            parts.append(wrap(MEMORY_TAG, entry.content))
        elif entry.read == "website" and entry.content:
            parts.append(wrap_website(entry.content, entry.website or ""))
    if not limit_turn:
        parts.append(SETUP_CLIENT_CARDS[interview.shows_cards])
        parts.append(wrap(SETUP_PLAN_TAG, json.dumps(_setup_plan(interview, run_id=run_id), ensure_ascii=False)))
    start = len(transcript)
    asks = 0
    for index in range(len(transcript) - 1, -1, -1):
        entry = transcript[index]
        if entry.card is not None or (entry.question is not None and entry.question != key):
            break
        if entry.question == key:
            asks += 1
            start = index + 1
    if asks > 1:
        start -= 1
    lines = [summary_line(SETUP_EXCHANGE_LABELS[entry.role], entry.text)
             for entry in transcript[start:] if entry.role in SETUP_EXCHANGE_LABELS and entry.card is None]
    if lines:
        parts.append(this_question_so_far(lines))
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


def _planned_job(interview: Interview, draft: JobDraft) -> ProposalCard | None:
    if draft.job == "payment" and not interview.business_tools_enabled:
        logger.warning("setup dropped an unavailable job of kind %s", draft.job)
        return None
    fields = draft.model_dump(mode="json")
    if fields["config"] is not None and fields["config"]["block"] == "purpose_payment":
        fields["config"]["amount_cents"] = None
    if not interview.business_tools_enabled:
        fields["config"] = None
    return ProposalCard(proposal_id=new_proposal_id(), kind="job", state="proposed",
                        job=JobProposal(**fields, can_do_today=CAPABILITIES[draft.job]), connector=None)


def _next_ask(interview: Interview, source, available: list[ProposalCard]) -> QuestionKey | ProposalCard | None:
    """Honor one fitting ask, otherwise ordinary topics first, then the hidden plan in order."""
    unshown = [card for card in available if card.proposal_id not in interview.dropped] if interview.shows_cards else []
    proposed = source.next if source is not None else None
    if proposed is not None:
        if proposed.kind == "topic" and proposed.topic not in interview.covered:
            return proposed.topic
        if proposed.kind in {"job", "connector"}:
            found = next((card for card in unshown if _names_card(source, card)), None)
            if found is not None:
                return found
    return next((key for key in QUESTION_KEYS if key not in interview.covered and key not in OPT_IN_TOPICS),
                unshown[0] if unshown else None)


def _names_card(source, card: ProposalCard) -> bool:
    if source is None or source.next.kind not in {"job", "connector"}:
        return False
    selector = source.next.job if source.next.kind == "job" else source.next.connector
    return selector == card.proposal_id or bool(card.connector and selector == card.connector.app)


async def _next_step(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient,
                     interview: Interview, decision: str | None = None, *,
                     text: str | None = None, closing: bool = False) -> SetupNextStep | SetupCardAnswer | None:
    """Plan after a limit or card decision without any field that can set a limit."""
    parts = [
        SETUP_NEXT_HEAD.format(business_type=interview.business_type,
                               covered=", ".join(key for key in QUESTION_KEYS if closing or key in interview.covered),
                               uncovered="" if closing else ", ".join(key for key in QUESTION_KEYS
                                                                    if key not in interview.covered)),
        wrap(ANSWERS_SO_FAR_TAG, interview.answers.model_dump_json()),
        wrap(SETUP_PLAN_TAG, json.dumps(_setup_plan(interview), ensure_ascii=False)),
    ]
    if not interview.business_tools_enabled:
        parts.insert(1, SETUP_PAYMENT_UNAVAILABLE_LINE)
    parts.append(SETUP_CLIENT_CARDS[interview.shows_cards])
    if closing:
        parts.append(SETUP_CLOSING_LINE)
    if decision is not None:
        parts.append(wrap(OWNER_DECISION_TAG, decision))
    if text is not None:
        parts.append(wrap(OWNER_ANSWER_TAG, text))
    else:
        # A limit answer also reaches its next-step and closing calls once, outside all history and plan data.
        current = next((entry.text for entry in interview.transcript
                        if entry.pending == _run_id(interview) and entry.pending is not None
                        and entry.role == "owner" and entry.text), None)
        if current is not None:
            parts.append(wrap(OWNER_ANSWER_TAG, current))
    system = SETUP_CARD_ANSWER_SYSTEM if text is not None else SETUP_NEXT_SYSTEM
    output = SetupCardAnswer if text is not None else SetupNextStep
    try:
        answer = await _ask_drafts(model, recorder(engine, owner), system, [_user("\n\n".join(parts))],
                                   output, max_tokens=TURN_MAX_TOKENS, effort="low")
    except ApiProblem:
        if text is not None:
            raise
        answer = None
    if answer is None:
        logger.warning("the setup next step was unavailable; using uncovered topics and planned items")
    return answer


# A "?" asks only where it ends a sentence: before a space, the end, or a closing quote or bracket. One inside a
# link or mid-word ("example/?ref=desk") asks nothing, so it leaves the topic's question to be asked.
_ENDS_A_QUESTION = re.compile(r"\?(?=\s|$|[\"'\u201d\u2019)\]])")


def _asks(text: str) -> bool:
    return _ENDS_A_QUESTION.search(text) is not None


@dataclass
class _TurnReplies:
    """Keep reply provenance for the whole answer, including any recursive planning calls."""

    entries: list[tuple[Entry, bool]] = field(default_factory=list)

    def track(self, reply: Entry, *, reads_untrusted: bool = True) -> None:
        self.entries.append((reply, reads_untrusted))

    def before(self, question: QuestionKey | None) -> None:
        if question in LIMIT_CHOICES:
            for reply, reads_untrusted in self.entries:
                if reads_untrusted:
                    # Keep coverage and hidden plan metadata; empty messages are omitted from the view.
                    reply.text = ""


async def _ensure_answerable(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview: Interview, *,
                             since: int, replies: _TurnReplies, key: QuestionKey | None = None,
                             follow_up=None) -> None:
    """Before saving, leave a fresh question, a waiting card, or a closed interview."""
    if interview.step != "questions" or interview.pending_card is not None:
        return
    if any(entry.role == "claude" and entry.question in QUESTION_KEYS and entry.text.strip()
           for entry in interview.transcript[since:]):
        return
    if follow_up is not None:
        reason = "topic_again"
        reply = next((entry for entry, _ in reversed(replies.entries) if entry.text.strip()), None)
        asked = _ask(interview, key)
        if key in LIMIT_CHOICES and reply is not None and _asks(reply.text):
            reply.question = key
            reply.choices = asked.choices
            return
        if key not in LIMIT_CHOICES:
            if reply is not None and _asks(reply.text):
                reply.question = key
                return
            question = follow_up.question.strip()
            fitting = follow_up.next.kind == "done" or (follow_up.next.kind == "topic"
                                                        and follow_up.next.topic not in LIMIT_CHOICES)
            if question and fitting and (reply is None or question != reply.text.strip()):
                asked.text = question
                asked.choices = _normalize_choices(follow_up.choices)
                reason = "turn_question"
    else:
        added = {card.proposal_id for entry in interview.transcript[since:] for card in entry.planned}
        available = [card for card in interview.unshown if card.proposal_id not in added]
        following = _next_ask(interview, None, available)
        if isinstance(following, str):
            asked = _ask(interview, following)
        elif isinstance(following, ProposalCard):
            asked = Entry(role="claude", text="", card=following.model_copy(deep=True))
        else:
            asked = None
        reason = "next_topic" if asked is not None else "close"
    topic = (asked.question or "card") if asked is not None else "done"
    logger.warning("setup answer gap filled (%s, %s)", topic, reason)
    if asked is not None:
        replies.before(asked.question)
        interview.transcript.append(asked)
    else:
        await close_setup(owner, engine, model, interview)


async def _advance(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview: Interview,
                   source, reply: Entry, *, closing_call: bool = False, replies: _TurnReplies | None = None) -> None:
    """Choose the final ask before deciding which of this answer's replies can be stored beside it."""
    replies = replies if replies is not None else _TurnReplies()
    replies.track(reply)
    await _advance_ask(owner, engine, model, interview, source, reply, replies, closing_call=closing_call)
    asked = interview.latest_ask
    replies.before(asked.question if interview.step == "questions" and asked is not None else None)


async def _advance_ask(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview: Interview,
                       source, reply: Entry, replies: _TurnReplies, *, closing_call: bool = False) -> None:
    """Append exactly one ask or close. Metadata lives on this turn's Claude entry, never on a card."""
    if source is not None:
        interview.cover(source.skip)
    available = _record_plan(interview, source, reply)
    if interview.shows_cards and source is not None and source.next.kind == "connector":
        app = source.next.connector
        existing = [*interview.planned, *(entry.card for entry in interview.transcript if entry.card)]
        if app in get_args(ConnectorKey) and not any(card.connector and card.connector.app == app for card in existing):
            card = ProposalCard(proposal_id=new_proposal_id(), kind="connector", state="proposed", job=None,
                                connector=ConnectorProposal(app=app, label=CONNECTOR_LABELS[app],
                                                            why=source.question.strip()[:200],
                                                            connectable=True))
            reply.planned.append(card)
            available.append(card)
    asked = _next_ask(interview, source, available)
    if isinstance(asked, str):
        fitting = source is not None and source.next.kind == "topic" and source.next.topic == asked
        interview.transcript.append(_ask(interview, asked) if asked in LIMIT_CHOICES or not fitting else
                                    Entry(role="claude", text=source.question.strip() or
                                          question_text(asked, interview.business_type), question=asked,
                                          choices=_normalize_choices(source.choices)))
    elif isinstance(asked, ProposalCard):
        fitting = _names_card(source, asked)
        if fitting and source.question.strip():
            interview.transcript.append(Entry(role="claude", text=source.question.strip()))
        _show_card(interview, asked)
    else:
        # An added job becomes eligible only on a later planning call, never on the turn that minted it.
        if interview.shows_cards and interview.unshown:
            following = None if closing_call else await _next_step(owner, engine, model, interview)
            entry = Entry(role="claude", text=following.reply.strip() if following else "")
            interview.transcript.append(entry)
            replies.track(entry)
            await _advance_ask(owner, engine, model, interview, following, entry, replies, closing_call=True)
            return
        await close_setup(owner, engine, model, interview)


def _show_card(interview: Interview, card: ProposalCard) -> None:
    interview.transcript.append(Entry(role="claude", text="", card=card.model_copy(deep=True)))
    payment = bool((card.job and card.job.job == "payment") or
                   (card.connector and card.connector.app == "stripe"))
    if payment and not interview.answers.auto_money_cap_cents and not any(
            entry.role == "claude" and entry.text == PAYMENT_LINE for entry in interview.transcript):
        interview.transcript.append(Entry(role="claude", text=PAYMENT_LINE))


def _record_plan(interview: Interview, source, reply: Entry) -> list[ProposalCard]:
    """Record additions and valid drops even on a follow-up; return only items available before this turn."""
    available = interview.unshown
    if source is not None:
        available_ids = {card.proposal_id for card in available}
        reply.dropped = list(dict.fromkeys(proposal_id for proposal_id in source.drop if proposal_id in available_ids))
        reply.planned = [card for draft in source.add_jobs if (card := _planned_job(interview, draft)) is not None]
    return available


def _decide_typed(interview: Interview, proposal_id: str, accept: bool) -> bool:
    """Decide only the waiting card, preserving its payload and the original planned item."""
    if interview.pending_card != proposal_id:
        return False
    card = interview.latest_ask.card
    if accept and card.job and card.job.config and card.job.config.block == "purpose_payment" and \
            card.job.config.amount_cents is None:
        return False
    card.state = "accepted" if accept else "declined"
    return True


async def card_turn(owner, engine, model, interview: Interview, proposal_id: str,
                    text: str | None = None) -> None:
    """Continue an in-place or typed card decision. The guarded route owns saving and after_finish."""
    since = len(interview.transcript)
    await _card_turn(owner, engine, model, interview, proposal_id, text)
    if len(interview.transcript) == since:
        return
    replies = _TurnReplies(entries=[(entry, True) for entry in interview.transcript[since:]
                                    if entry.role == "claude"])
    await _ensure_answerable(owner, engine, model, interview, since=since, replies=replies)


async def _card_turn(owner, engine, model, interview: Interview, proposal_id: str,
                     text: str | None = None) -> None:
    card = next((entry.card for entry in reversed(interview.transcript)
                 if entry.card and entry.card.proposal_id == proposal_id), None)
    if card is None or (text is None and card.state == "proposed"):
        return
    if text is not None and interview.pending_card != proposal_id:
        raise ApiProblem(409, "conflict")
    payload = card.job.model_dump(mode="json") if card.job else card.connector.model_dump(mode="json")
    decision = json.dumps({"proposal_id": proposal_id,
                           "decision": "waiting" if text is not None else card.state, **payload}, ensure_ascii=False)
    following = await _next_step(owner, engine, model, interview, decision, text=text)
    if text is not None and following is None:
        raise ApiProblem(503, "model_unavailable")
    reply = Entry(role="claude", text=following.reply.strip() if following else "")
    interview.transcript.append(reply)
    if text is not None:
        if following.decision == "change":
            if card.job is None or not following.revised:
                return
            replacement = _planned_job(interview, following.revised[0])
            if replacement is None:
                return
            # Keep the stored plan and its shown copy settled together; only the replacement waits.
            for entry in interview.transcript:
                for planned in entry.planned:
                    if planned.proposal_id == proposal_id:
                        planned.state = "changed"
                        planned.superseded_by = replacement.proposal_id
            card.state = "changed"
            card.superseded_by = replacement.proposal_id
            reply.planned = [replacement]
            if following.question.strip():
                interview.transcript.append(Entry(role="claude", text=following.question.strip()))
            _show_card(interview, replacement)
            return
        if following.decision == "none" or not _decide_typed(interview, proposal_id,
                                                            following.decision == "accept"):
            return
    await _advance(owner, engine, model, interview, following, reply)


async def answer(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview_id: str, question: QuestionKey | None,
                 text: str, *, runs: TurnRuns, ro_schema: str, admit: Callable[[], Awaitable[None]],
                 card: str | None = None, cards: bool = False, business_tools_enabled: bool = False) -> SetupState:
    """Run a question or typed card answer through the shared turn runner; busy repeats do no work."""
    if (question is None) == (card is None):
        raise ApiProblem(422, "invalid_request")

    def check(interview: Interview) -> None:
        if card is not None:
            if card != interview.pending_card:
                raise ApiProblem(409, "conflict")
        elif interview.question is None or interview.question != question:
            raise ApiProblem(409, "conflict")

    def stage(interview: Interview) -> list[Entry]:
        return [Entry(role="owner", text=text)]

    async def run(ctx: OwnerCtx, interview: Interview, staged: list[Entry]) -> None:
        interview.business_tools_enabled = business_tools_enabled
        if card is not None:
            await card_turn(ctx, engine, model, interview, card, text=text)
            return
        since = len(interview.transcript)
        key = question
        desk_id = interview.desk_id
        said, = staged
        turn = await structured(model, recorder(engine, ctx), SETUP_TURN_SYSTEM,
                                [_turn_message(interview, key, text, run_id=said.pending)], SETUP_TURNS[key], TURN_MAX_TOKENS)
        patch = turn.patch()
        if key in LIMIT_CHOICES:
            choice = next((choice for choice in LIMIT_CHOICES[key](interview.business_type)
                           if text.strip() == choice.text), None)
            if choice is not None:
                patch = SetupPatch.model_validate({**patch.model_dump(), **choice.values})
                turn.step_done = True
        entries = []
        reply = Entry(role="claude", text=turn.reply.strip())
        replies = _TurnReplies()
        replies.track(reply, reads_untrusted=key not in LIMIT_CHOICES)
        if reply.text:
            entries.append(reply)
        site = website_url(turn.website)
        if site is not None and site[0] not in interview.tried_websites():
            if interview.consent:
                entries.append(await _read_website(ctx, desk_id, *site))
            else:
                said.website = site[0]                   # kept as text: nothing is read without consent
        await _rename(ctx, desk_id, patch)
        interview.answers = merged(interview.answers, patch, key)
        interview.transcript += entries
        if turn.step_done:
            interview.cover([key])
            following = await _next_step(ctx, engine, model, interview) if key in LIMIT_CHOICES else turn
            next_reply = reply
            if key in LIMIT_CHOICES:
                next_reply = Entry(role="claude", text=following.reply.strip() if following else "")
                interview.transcript.append(next_reply)
            elif not any(entry is reply for entry in interview.transcript):
                interview.transcript.append(reply)
            await _advance(ctx, engine, model, interview, following, next_reply,
                           closing_call=key in LIMIT_CHOICES, replies=replies)
        elif key not in LIMIT_CHOICES:
            if not any(entry is reply for entry in interview.transcript):
                interview.transcript.append(reply)
            _record_plan(interview, turn, reply)
        await _ensure_answerable(ctx, engine, model, interview, since=since, replies=replies, key=key,
                                 follow_up=turn if not turn.step_done else None)

    async def after(ctx: OwnerCtx, interview: Interview) -> None:
        if interview.step == "tools":
            await after_finish(ctx, interview)

    return await run_turn(owner, engine, model, interview_id, runs=runs, ro_schema=ro_schema, admit=admit,
                          check=check, stage=stage, turn=run, after=after,
                          render=partial(setup_state, cards=cards))


# Finish ------------------------------------------------------------------------------------------------------

def settle_plan(interview: Interview) -> None:
    # Leave changed cards and their superseded_by links intact; settle only their replacements.
    pass


async def close_setup(owner, engine, model, interview: Interview) -> None:
    """Settle cards, end with the closing plan (or a fixed line without one), then finish.

    The caller owns persistence and after_finish.
    """
    settle_plan(interview)
    plan = ""
    for attempt in range(2):
        closing = await _next_step(owner, engine, model, interview, closing=True)
        if closing is None:
            break
        plan = closing.plan.strip()
        if plan or attempt == 1:
            if closing.reply.strip():
                interview.transcript.append(Entry(role="claude", text=closing.reply.strip()))
            if plan:
                interview.transcript.append(Entry(role="claude", text=plan))
            break
    if not plan:
        interview.transcript.append(Entry(role="claude", text=QUESTIONS_DONE))
    finish(interview)


def finish(interview: Interview) -> None:
    interview.cover(QUESTION_KEYS)
    interview.step = "tools"


async def after_finish(owner, interview) -> None:
    pass


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
    """The owner's context on a database connection of its own, for background work that may outlive its request (whose
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


async def _post_draft(owner: OwnerCtx, desk_id: str, cards: list[RuleCard], cap: int) -> PolicyVersion:
    """The kernel's draft of the utility cards and `cards`, on the active version (`versions.post_draft`), at the
    owner's answered money cap `cap` (0 when unanswered).

    The money cap: setup's money cards are held to the answered cap (`template_cards`, `_card_problems`), and the
    draft names it (`PolicyDraftRequest.auto_money_cap_cents`, master "Money cap"), so the kernel compiles and proves
    the version at that cap; it becomes the Desk's only once the owner confirms the draft. The cap the owner reads
    back is the version's (`versions.version_cap`)."""
    active = await active_row(owner, desk_id)
    return await post_draft(owner, desk_id, [*UTILITY_CARDS, *cards], active["version"], auto_money_cap_cents=cap)


async def _posted(owner: OwnerCtx, desk_id: str, cards: list[RuleCard], template: list[RuleCard],
                  cap: int) -> PolicyVersion | None:
    """The kernel's checkable draft of setup's `cards` at the answered cap (`_post_draft`), or None when the kernel
    refuses them as invalid (422, which names no card: the kernel logs why), or when the API refuses them first for a
    card that would change starting a verification (`ChangesAlwaysOn`, the check the kernel refuses them with). The
    `template` cards refused are the owner's error to see."""
    try:
        return checkable(await _post_draft(owner, desk_id, cards, cap))
    except KernelFailed as refused:
        if refused.code != "invalid" or cards == template:
            raise
        logger.warning("the kernel refused setup's cards as invalid")
        return None
    except ChangesAlwaysOn as refused:
        if cards == template:
            raise
        logger.warning("setup's cards would change starting a verification: %s", ", ".join(refused.card_ids))
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
            return await _posted(owner, desk_id, cards, template, answers.auto_money_cap_cents)

        version = await draft_cards(model, recorder(engine, owner, CARD_DRAFT_ROUTE), business_type, answers,
                                    await _rule_tools(owner, desk_id), post)
    else:
        version = await _posted(owner, desk_id, cards, template, answers.auto_money_cap_cents)
    if (version is None or version.status == "rejected") and cards != template:
        cards = await _store_cards(engine, owner, interview_id, template, replace_stored=bool(cards))
        version = checkable(await _post_draft(owner, desk_id, cards, answers.auto_money_cap_cents))
    await _drafted(engine, owner, interview_id, version.version, "rules")
    return rules_draft(version, version_cap(version))


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
    enabled = {row["tool"] for row in await owner.ro.rows("tools", desk_id=desk_id, status="enabled")}
    tools = {who: sorted(given & enabled) for who, given in SITUATION_TOOLS_BY_WHO.items()}
    rules_text = json.dumps([card.model_dump(mode="json", exclude={"card_id", "person_id", "agent_key_id",
                                                                   "is_default"}) for card in cards])
    message = _user("\n\n".join([SITUATIONS_HEAD.format(business_type=interview.business_type),
                                 wrap(RULES_TAG, rules_text), wrap(PRICES_TAG, json.dumps(prices)),
                                 wrap(TOOLS_TAG, json.dumps(tools)),
                                 wrap(ANSWERS_TAG, interview.answers.model_dump_json(exclude_defaults=True))]))

    def usable(drafted: DraftedSituations) -> str | None:
        if any((draft.tool == "native.quote" or draft.tool in MONEY_TOOLS) and draft.item_id not in prices
               for draft in drafted.situations):
            return SITUATION_PRICE_REQUIRED
        if any(draft.expected != "refuse" and draft.tool not in tools[draft.who] for draft in drafted.situations):
            return SITUATION_CALLER_TOOL_REQUIRED
        return None

    drafted = await ask_model(model, recorder(engine, owner, SITUATIONS_ROUTE), SITUATIONS_SYSTEM, [message],
                              DraftedSituations, max_tokens=SITUATIONS_MAX_TOKENS, route=SITUATIONS_ROUTE,
                              effort="medium", check=usable)
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
    legal stand-in price the Desk lacks is left out."""
    largest = _largest(prices)
    built = []
    for number, spec in enumerate(SAFETY_PROBES, 1):
        item_id, amount = (largest if largest is not None else (None, None))
        if spec.stand_in == "over_mandate" and amount is not None:
            amount = max(amount, (spec.mandate_cents or 0) + 1)
        elif spec.stand_in == "over_money_limit":
            # Just past the lowest limit a link meets (the link limit when answered, else the cap), so a rule that
            # allows more than it shows as allowed: the next round $10, or a cent past it at the platform's ceiling.
            limit = min(answers.auto_money_cap_cents, answers.payment_link_auto_max_cents
                        if answers.payment_link_auto_max_cents is not None else answers.auto_money_cap_cents)
            amount = (limit // 1_000 + 1) * 1_000
            if amount > AUTO_MONEY_HARD_CAP_CENTS:
                amount = limit + 1
            if amount > AUTO_MONEY_HARD_CAP_CENTS:
                continue
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
    listed = await owner.ro.rows("price_items", desk_id=desk_id, order_by=("item_id",))
    prices = {row["item_id"]: row["unit_cents"] for row in listed}
    titles = {row["item_id"]: row["title"] for row in listed}
    largest = _largest(prices)
    title = titles[largest[0]] if largest is not None else ""
    name = interview.answers.owner_display_name
    built = safety_probes(interview.answers, prices)
    started = monotonic()
    results = await _run_probes(owner, desk_id, interview.draft_version, [probe for _, probe in built])
    seconds = round(monotonic() - started, 1)
    rows = [SafetyRow(label=spec.label,
                      tries=spec.tries.format(owner_intro=f"Hi, it's {name or 'the owner'}. ",
                                              charge_item=title, payment_item=f" for {title}" if title else ""),
                      result=result,
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
        active = version_from_row(row)
        await tell_cancelled_links(owner, engine, desk_id, active)
        return active
    if row is None or row["status"] != "proved":
        raise ApiProblem(409, "conflict")
    try:
        active = await owner.kernel.call("POST /policy/confirm", PolicyConfirmRequest(
            desk_id=desk_id, version=interview.draft_version))
    except KernelFailed as refused:
        if refused.code != "conflict":
            raise
        version = checkable(await _post_draft(owner, desk_id, interview.draft_cards,
                                              interview.answers.auto_money_cap_cents))
        await _drafted(engine, owner, interview_id, version.version, "rules")
        raise RulesChangedSinceDraft(rules_draft(version, version_cap(version))) from None
    await _update(engine, owner, interview_id, lambda found: setattr(found, "step", "preview"))
    await tell_cancelled_links(owner, engine, desk_id, active)
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
