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
  their Claude memory (`native.read_memory`), reads the named website (`native.fetch_website`) and runs up to three
  keyword web searches (`native.web_search`) on yes. Decisions finish sequentially before concurrent executions;
  both phases share `HOMEWORK_BUDGET_S` (35 seconds), and a search's execution waits up to
  `WEB_SEARCH_EXECUTE_TIMEOUT_S` (32 seconds), past the kernel's own 30 s search deadline. On no it skips every
  read. `_after_consent` appends the consultant
  opening and first fact question; the labels and reply are saved together. Web search content reaches only that
  opening's understanding call. A website the owner names later after no is kept as text. The owner's display
  stream gets each read's start, then each read's label in the same order, then the opening's text; none of it is
  state.
- **Answer** (`answer`): one structured model call over the business type, the question asked, the answers so far
  and the wrapped memory, website, current question's earlier owner answers and Claude replies, and owner's answer,
  answered in that question's own model (`SETUP_TURNS`). With one ask, the exchange starts after it; with follow-ups,
  it starts at this topic's first ask, keeping every question and answer in view. Its patch merges into the answers.
  Each limit (the quote, discount and payment link limits, the documents rule, the money cap and the refunds rule,
  which is the money question's: refunds are money going out) is
  a field only of its own question's model, whose message leaves the memory and website out, and code drops it from
  any other turn's patch too, so no other turn, and nothing the website or memory says, can set it. A limit question's model has no
  fact either (its turn reads none of the facts so far), and code drops a fact from a limit turn's patch too, but for
  the quote question's pricing text and price items, named from the owner's answer alone (the turn reads neither):
  code replaces the pricing text and updates or adds price items by title, never removing one. Some fields (pricing,
  intake, urgent, after_hours, hours and a website named) are only on the questions that ask for them
  (`FIELD_TURNS`), and code drops one from any other turn's patch too, so each turn's schema stays small enough to
  compile. A fact question clears the hours or the prices only by its flag, since an empty list leaves them as they
  are. A new website is read only with consent; a new owner or business
  name goes to the kernel (`PUT /desks/{id}/business`). Once the last question is answered, the interview moves on to
  step `tools`: settle the cards, append Claude's closing plan, then finish. Only a failed or empty closing plan
  after its retry gets the fixed transition line instead. When the owner typed their own contact on the contact
  question, setup first asks, with code's two choices, whether to add them as a test client (`TEST_CLIENT_OFFER`).
  Code reads a yes or a no with no model turn: only a yes puts them on record as a client with that contact
  (`PUT /desks/{id}/people`), and either moves on to step `tools`. Any other answer, such as a request for another
  job or a question, goes to setup's consultant in one planning call (`_consult_on_offer`): Claude replies, and a job
  it adds or an app it names reopens the plan on its card before step `tools`; closing it again settles the cards,
  appends a second closing plan, finishes again and asks the offer again. With nothing new to show, or Claude
  unavailable, the offer is asked again at once.

- **Change something** (`reopen`): from a step after the questions (`tools` through `preview`; never once live,
  when changes are made in the owner app), the owner's message takes the interview back to `questions` as its next
  turn, answered on the contact question behind a code ask the owner isn't shown. A change that belongs to another
  topic is asked there next, a limit on its own question with code's choices (`_next_ask`, on that turn alone), and
  so is each fact the turn gave that the contact question can't record off its topic, in turn (`_held_off_topic`,
  `Entry.asks_after`). A drop of a job or connector the owner accepted shows its card again for them to decide (and
  "Use your suggestions" settles it as their no), unless the same call adds a job of its kind, which replaces it
  (`_record_plan`); a Stripe connection taken away has its payment tools switched off (`publish_plan`). The turn
  drops the rules draft, so the rules, situations and safety check are drafted again on the way forward; the confirm
  then waits for the safety check to run again, and proving work that read the interview before a reopen never
  writes after it (`Interview.reopens`). The safety check, the confirm and going live never run alongside a change in
  this process (`_transition`). Each send carries an idempotency key, kept on the owner's message.

`run_turn` runs consent, answers and card decisions with one guard and one background task per interview. After
admission it stores staged entries with a fresh pending run ID. Any pending entry makes the interview busy. The
request waits for this commit, then up to `TURN_WAIT_S` (25 seconds): 200 with the landed state, an error if the task
fails in time, or 202 with the stored busy state. Consent doesn't wait: it answers 202 with the busy state once it is
stored. Cancelling the request leaves the task working on its own connections. Any turn while busy returns that state without running or counting on the limits.
The task commits its changes and clears or removes staged entries together within `TURN_RUN_TIMEOUT_S` (110
seconds: consent's reads, Claude's whole understanding call, then ten seconds to finish and five for a retry). An
optional `after` hook runs outside that deadline, with no transaction open and its own
`TURN_AFTER_TIMEOUT_S` bound (30 seconds); its failures are logged by type only and return the landed state.
Failure, deadline or shutdown before the final commit removes only entries marked by that run. Shutdown after
the final commit ends the task without rollback. Removing a pending answer immediately
after Claude's consent question also reopens consent. GET and every turn recover all pending entries older than
`TURN_ABANDONED_S` (130 seconds) when this process holds no run for the interview.

Each setup tool call is an owner call on the new Desk (`decide_setup_tool`, `execute_setup_tool`, composed by
`run_setup_tool`): the tool must be in the owner's `/context`,
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
import hashlib
import inspect
import json
import logging
import re
import secrets
import unicodedata
from collections.abc import AsyncIterator, Awaitable, Callable, Collection, Iterable, Iterator, Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from functools import partial
from time import monotonic
from typing import Any, Literal, TypeVar, cast, get_args
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from psycopg.errors import LockNotAvailable
from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy import Interval, delete, func, literal, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import OperationalError
from sqlalchemy.sql import Executable
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from desk.api.deps import ApiProblem, OwnerCtx
from desk.api.idempotency import Admissions, body_sha256
from desk.api.owner_streaming import current as current_display, failure as display_failure
from desk.api.turn_runs import TurnRuns
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
    ANSWER_RETRY,
    ANSWERS_SO_FAR_TAG,
    ANSWERS_TAG,
    CAPABILITIES,
    CARD_DRAFT_SYSTEM,
    CARD_ERROR_LINE,
    CARD_ERRORS,
    CARDS_REFUSED,
    CLEARABLE,
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
    FIELD_TURNS,
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
    SETUP_PLAN_NOT_CONNECTED,
    SETUP_PLAN_NO_AMOUNT,
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
    TIME_FRAME_UNACCOUNTED,
    TOOLS_TAG,
    WEB_SEARCH_TAG,
    BlockConfig,
    BusinessType,
    Choice,
    ConnectorProposal,
    ConnectorKey,
    DraftedRules,
    DraftedSituations,
    DraftOutput,
    HoursAnswer,
    JobDraft,
    JobProposal,
    MemoryDraft,
    PlannedOutcome,
    PriceAnswer,
    ProposalCard,
    SetupNextStep,
    SetupCardAnswer,
    PurposePaymentProposalConfig,
    QuestionKey,
    RuleCardDraft,
    SETUP_POLICY_CLAIMS,
    SetupAnswers,
    SetupPatch,
    SetupStart,
    SetupTurn,
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
    SetupProposalIn,
    SetupPublicHours,
    SetupPublicLine,
    SetupPublicLineError,
    SetupPublicLines,
    SetupPublicPrices,
    SetupQuestion,
    SetupStartIn,
    SetupState,
    SetupStep,
    SetupTools,
    Situation,
    SituationResult,
    TestClientQuestion,
    ToolRow,
    WentLive,
)
from desk.api.setup_templates import SAFETY_PROBES, SafetyProbe, template_cards
from desk.api.versions import (
    ChangesAlwaysOn,
    active_row,
    checkable,
    confirm_tools,
    connect_payments,
    post_draft,
    rules_draft,
    tool_rows,
    version_cap,
    version_from_row,
)
from desk import contracts
from desk.calendar import WEEK, calendar_slots, minute_of_day
from desk.contracts import (
    AUTO_MONEY_HARD_CAP_CENTS,
    MCP_TOOLS,
    MONEY_TOOLS,
    BusinessSeed,
    CalendarSlot,
    Claim,
    Decision,
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
    money_tool,
)
from desk.db.models import SetupInterview
from desk.kernel_api import (
    BusinessToolsRequest,
    CreateDeskRequest,
    DecideRequest,
    DeskAnsweringRequest,
    DeskBusinessRequest,
    DeskCalendarRequest,
    DeskCharterRequest,
    DeskHoursRequest,
    DeskMemoryRequest,
    DeskNotificationsRequest,
    DeskPeopleRequest,
    DeskPricesRequest,
    ExecuteRequest,
    MemoryItem,
    PersonUpsert,
    PolicyConfirmRequest,
    PolicyProbeRequest,
    SessionContext,
    ToolPin,
    ToolsConfirmRequest,
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
TURN_FINISH_S = 10           # the understanding call ends this long before the run's deadline, for the turn to save
UNDERSTAND_RETRY_MIN_S = 5   # the least time left worth the understanding call's one retry
# A consent turn's deadlines nest, each outlasting what it waits for. A search's `POST /execute` waits 2 s past the
# kernel's 30 s search deadline (`decisions.WEB_SEARCH_TIMEOUT_S`, which this process can't import), so the kernel's
# fail-closed answer arrives first. All the reads share one budget, `HOMEWORK_DECIDE_S` more, for the owner's context
# and the decisions that come before them. The run then keeps the whole understanding call and its finish and retry
# time, and stays below abandonment, including during a deploy's overlap.
WEB_SEARCH_EXECUTE_TIMEOUT_S = 32
HOMEWORK_DECIDE_S = 3        # the owner's context and the decisions, before the reads start
HOMEWORK_BUDGET_S = WEB_SEARCH_EXECUTE_TIMEOUT_S + HOMEWORK_DECIDE_S
TURN_WAIT_S = 25             # the request's wait; the run keeps going after a 202 or a disconnect
TURN_RUN_TIMEOUT_S = HOMEWORK_BUDGET_S + UNDERSTAND_TIMEOUT_S + TURN_FINISH_S + UNDERSTAND_RETRY_MIN_S   # 110 s
TURN_AFTER_TIMEOUT_S = 30    # post-commit work cannot fail or undo the landed turn
TURN_ROLLBACK_TIMEOUT_S = 10  # cleanup also ends before another process may recover the row
# Recover only when this process holds no run, and only once a run and its cleanup have ended, with
# `TURN_CLOCK_SLACK_S` to spare for the clocks of a deploy's two tasks and the database's (`updated_at` is the
# database's time): 130 s. The web's polling (`SETUP_WORK_GIVE_UP_MS` in web/src/setup/useSetupWork.ts) must outlast it.
TURN_CLOCK_SLACK_S = 10
TURN_ABANDONED_S = TURN_RUN_TIMEOUT_S + TURN_ROLLBACK_TIMEOUT_S + TURN_CLOCK_SLACK_S
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
WEB_SEARCH_LABEL = "Searched the web: {query}"
WEB_SEARCH_FAILED_LABEL = "Couldn't search the web just now"
QUESTIONS_DONE = "That's everything I need to ask. Next, the tools your Desk can use."
PAYMENT_LINE = ("I'll ask you before any payment. You can set an amount I handle on my own, "
                "now or later in Rules.")
AMOUNT_FIRST_LINE = "I need the amount first. Add it on the card above."
# The test-client offer, asked at the plan's end (`_offer_test_client`), its two choices, and Claude's line after a yes.
# Owner-facing words, kept together for copy review.
TEST_CLIENT_OFFER = ("Want to try your Desk the way a client would? I can add you as a test client, with your own "
                     "contact, so you can check verification and private answers yourself.")
TEST_CLIENT_YES = "Add me as a test client"
TEST_CLIENT_NO = "Not now"
TEST_CLIENT_ADDED = "Done: you're a test client on your Desk, with the contact you gave me."
TEST_CLIENT: TestClientQuestion = "test_client"   # the offer's question, which code alone asks
TEST_CLIENT_REF = "test-client"                   # the owner's ref among the Desk's people, as a test client
# The words and phrases code reads in a typed answer to the test-client offer (`_reads_yes`), in English and Spanish:
# a "no" one wins over any "yes" one. A yes or a no is read only from a short plain answer; anything longer, or with a
# request or a condition, goes to setup's consultant (`_consult_on_offer`). That leans on purpose: a plain answer sent
# there costs one model call and the offer again, while a request read as a yes or a no is dropped without a word.
TEST_CLIENT_MAX_WORDS = 8          # words in an answer, besides the offer's own (`TEST_CLIENT_NAMED`)
TEST_CLIENT_WORD = re.compile(r"[^\W_]+(?:'[^\W_]+)*")
TEST_CLIENT_TYPED_YES = ("yes", "yeah", "yep", "yup", "sure", "ok", "okay", "go ahead", "please do", "do it", "add me",
                         "sounds good", "sí", "si", "vale", "claro", "dale", "añádeme", "agrégame")
TEST_CLIENT_TYPED_NO = ("no", "not", "don't", "dont", "nope", "not now", "later", "skip", "no gracias")
# The offer's own words in an answer ("as a test client", "como cliente de prueba"), which the word limit leaves out.
TEST_CLIENT_NAMED = re.compile(r"\b(?:as\s+)?(?:(?:a|the|my)\s+)?test\s+clients?\b"
                               r"|\b(?:como\s+)?cliente\s+de\s+prueba\b", re.IGNORECASE)
# A typed answer that asks something, or gives a yes only on a condition, which is never a yes or a no: a question mark,
# a question's opening word, or "if" ("si" in Spanish, unless it stands alone as a yes, "Si" or "Si, …").
TEST_CLIENT_UNCLEAR = re.compile(r"[?¿]|^\W*(?:what|how|why|does|can|is|will|qué|cómo|por qué)\b"
                                 r"|^\W*do\s+(?:you|i|we|they|he|she|this|that)\b|\bif\b", re.IGNORECASE)
TEST_CLIENT_SI = re.compile(r"\bsi\b", re.IGNORECASE)
TEST_CLIENT_SI_ALONE = re.compile(r"^\W*si\s*(?:$|[,.!])", re.IGNORECASE)
# A typed answer that also asks for something besides the offer, which is never a yes or a no: adding or setting up
# anything but the owner, their contact or the test client (not after "don't" or "not"); a job (not a "good job");
# connecting, changing or removing something (not after "don't", or "don't want to"); "también", or "also" and another
# word; or one of the Desk's own jobs (deposits, payments, retainers, invoices, bookings, charging) or configuring.
TEST_CLIENT_REQUEST = re.compile(
    r"(?<!n't\s)(?<!not\s)\b(?:add|adding|añade|añadir|agrega|agregar|set\s+up|create|crea|crear|configura"
    r"|configurar)\b"
    r"(?!\s+(?:me|myself|us|it|that|this|anything|my\s+(?:email|number|phone|contact)"
    r"|mi\s+(?:correo|número|teléfono|contacto)|(?:(?:a|the|my)\s+)?test\s+clients?)\b)"
    r"|(?<!good\s)(?<!great\s)(?<!nice\s)\bjobs?\b"
    r"|(?<!n't\s)(?<!n't\swant\sto\s)(?<!not\swant\sto\s)"
    r"\b(?:connect\w*|conecta\w*|change[sd]?|changing|cambia\w*|remove|quita\w*|elimina\w*|trabajos?)\b"
    r"|\b(?:también|tambien)\b|\balso\s+(?!like|try|check)\w"
    r"|\b(?:deposits?|payments?|retainers?|invoices?|bookings?|depósitos?|pagos?|reservas?|cobr\w*)\b|\bconfigure\b",
    re.IGNORECASE)
# Any yes or no code reads (`TEST_CLIENT_TYPED_YES`, `TEST_CLIENT_TYPED_NO`) opening an answer, perhaps with "please" or
# "thanks", that goes on with "and", "but", "y" or "pero": more follows, unless it only ends politely ("No, but thanks",
# "Sí, y gracias", "Not now, but maybe later").
_TYPED_ANSWERS = "|".join(r"\s+".join(map(re.escape, phrase.split()))
                          for phrase in sorted(TEST_CLIENT_TYPED_YES + TEST_CLIENT_TYPED_NO, key=len, reverse=True))
TEST_CLIENT_CONJOINED = re.compile(
    rf"^\W*(?:{_TYPED_ANSWERS})\b(?:\W+(?:please|thanks|thank\s+you|gracias|por\s+favor))?\W+(?:and|but|y|pero)\b"
    r"(?!\W*(?:thanks|thank\s+you|gracias|maybe\s+later|later|más\s+tarde)\b\W*$)", re.IGNORECASE)

# Each limit is taken only on the turn answering its own question (`LIMIT_QUESTIONS`), whose message carries the
# owner's answer with no memory or website beside it and whose model alone has the field; a patch that carries it on
# any other turn has it dropped and logged (by these labels, never its value), so no other turn's answer, and nothing
# the memory or the website says, can set it.
LIMIT_LABELS = {"quote_auto_max_cents": "a quote limit", "discount_auto_max_bp": "a discount limit",
                "payment_link_auto_max_cents": "a payment link limit", "documents": "a documents rule",
                "auto_money_cap_cents": "a money cap", "refunds": "a refunds rule"}

Record = Callable[[ModelResponse], Awaitable[None]]
Output = TypeVar("Output", bound=BaseModel)
# What closes a planning turn with nothing left to ask (`_advance_ask`): `close_setup`, or the test-client offer again
# after an answer to it that reopened the plan (`_consult_on_offer`).
Close = Callable[[OwnerCtx, AsyncEngine, ModelClient, "Interview"], Awaitable[None]]


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
    verification and a conversation the Desk handed to the owner (the handoff card's) alert at once, and a trade Desk
    also alerts at once for a call-back request, which is how an emergency reaches it."""
    trade = business_type == "trade"
    now = ["approval", "breaker", "lockout", "handoff"] + (["callback"] if trade else [])
    return NotificationDefaults(now=now, briefing=["lead", "booking"] if trade else ["lead", "callback", "booking"])


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
    question: Literal["consent"] | SetupQuestion | None = None
    read: Literal["memory", "website", "web_search"] | None = None
    content: str | None = None
    website: str | None = None
    search_queries: list[str] | None = None
    choices: list[Choice] = []
    card: ProposalCard | None = None
    covered: list[QuestionKey] = []
    suggested: SuggestedFacts | None = None
    planned: list[ProposalCard] = []
    dropped: list[str] = []
    cards: bool | None = None
    pending: str | None = None
    held_policy_keys: list[str] | None = None   # latest charter write's snapshot; [] clears an earlier hold
    connected_apps: list[ConnectorKey] | None = None
    owner_fields: list[str] = []  # Fact fields this owner turn set or explicitly cleared.
    owner_decided: bool = False
    connector_connect_attempted: bool = False
    # On the owner's answer to the test-client offer: "yes" once their yes is saved, "added" once they're on record.
    test_client: Literal["yes", "added"] | None = None
    # On the owner's message that reopened the questions from a later step ("Change something", `reopen`): the send's
    # idempotency key and its body's hash, which a repeat must match.
    reopen_key: str | None = None
    reopen_sha256: str | None = None
    # On a question code asks for a fact a change gave off its own question (`_held_off_topic`): the other such facts'
    # questions, asked in turn after it, before the questions close.
    asks_after: list[QuestionKey] = []


class ConnectedApp(BaseModel):
    """An accepted app in the transcript; simulation grants no business capability."""

    app: ConnectorKey
    simulated: bool


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
    def owner_fields(self) -> set[str]:
        """Owner fact decisions survive empty values and reloads through transcript metadata."""
        return {name for entry in self.transcript if entry.role == "owner" for name in entry.owner_fields}

    @property
    def shows_cards(self) -> bool:
        return any(entry.role == "owner" and entry.cards is True for entry in self.transcript)

    @property
    def busy(self) -> bool:
        """A stored transcript entry explicitly marks a pending background run."""
        return any(entry.pending is not None for entry in self.transcript)

    @property
    def reopens(self) -> int:
        """How many times "Change something" took the interview back to its questions (`reopen`), landed or running:
        work that read the interview before one must not write after it."""
        return sum(entry.reopen_key is not None for entry in self.transcript)

    @property
    def reopening(self) -> bool:
        """Whether the turn running now is the change that reopened the questions: its owner's message, staged and
        still pending, carries the send's key."""
        return any(entry.pending is not None and entry.reopen_key is not None for entry in self.transcript)

    @property
    def connected_apps(self) -> list[ConnectorKey]:
        """The simulated apps kept with the owner's opening description, absent on older interviews."""
        if not self.transcript:
            return []
        return self.transcript[0].connected_apps or []

    @property
    def question(self) -> SetupQuestion | None:
        """The question waiting for an answer: the last one asked, from consent until the questions step ends. The
        test-client offer (`TEST_CLIENT`) is the last, once the plan is closed."""
        if self.step != "questions" or self.consent is None or self.busy:
            return None
        asked = self.latest_ask
        return asked.question if asked is not None and asked.question in (*QUESTION_KEYS, TEST_CLIENT) else None

    @property
    def offering(self) -> bool:
        """Whether the plan is closed and only the test-client offer waits (`_offer_test_client`)."""
        asked = self.latest_ask
        return self.step == "questions" and asked is not None and asked.question == TEST_CLIENT

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
    def connected(self) -> list[ConnectedApp]:
        """Derive connections from current accepted cards whose connection succeeded."""
        cards = {card.proposal_id: card for card in self.planned}
        cards.update((entry.card.proposal_id, entry.card) for entry in self.transcript if entry.card)
        apps = dict.fromkeys(card.connector.app for card in cards.values()
                             if card.state == "accepted" and card.connector is not None
                             and card.connector.connected
                             and card.superseded_by is None and card.proposal_id not in self.dropped)
        return [ConnectedApp(app=app, simulated=app != "stripe") for app in apps]

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
    def held_policy_keys(self) -> list[str]:
        return next((entry.held_policy_keys for entry in reversed(self.transcript)
                     if entry.held_policy_keys is not None), [])

    def hold_policies(self, keys: list[str]) -> None:
        """Persist the latest charter outcome with the interview's other transcript metadata."""
        self.transcript[-1].held_policy_keys = list(keys)

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
                                                                 (name in {"choices", "covered", "planned", "dropped", "cards", "owner_fields",
                                                                           "owner_decided", "asks_after",
                                                                           "connector_connect_attempted"}
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
        if not interview.business_tools_enabled:
            _clear_configs(interview)
        await _save(conn, interview)


_RUNNING: set[str] = set()       # the interviews with a consent or an answer running in this process
# The interviews with a safety check, a confirm or a go-live running in this process, and how many of each.
_TRANSITIONS: dict[str, int] = {}


@contextlib.contextmanager
def _turn(interview_id: str) -> Iterator[None]:
    """Hold the interview's one running consent or answer in this process: another sent meanwhile is 409 `conflict` at
    once, before any model call or read (one in another process is caught when it saves, by `_commit`). So is one sent
    while a safety check, a confirm or a go-live runs (`_transition`): a change can't reopen the questions under
    them."""
    if interview_id in _RUNNING or interview_id in _TRANSITIONS:
        raise ApiProblem(409, "conflict")
    _RUNNING.add(interview_id)
    try:
        yield
    finally:
        _RUNNING.discard(interview_id)


@contextlib.contextmanager
def _transition(interview_id: str) -> Iterator[None]:
    """Hold a safety check, a confirm or a go-live from before its first read to after its last write: 409 `conflict`
    at once while a turn runs on the interview in this process (a reopen, say), and a turn sent meanwhile is 409 too
    (`_turn`). Transitions don't hold one another; each checks the draft version it read when it writes."""
    if interview_id in _RUNNING:
        raise ApiProblem(409, "conflict")
    _TRANSITIONS[interview_id] = _TRANSITIONS.get(interview_id, 0) + 1
    try:
        yield
    finally:
        left = _TRANSITIONS.pop(interview_id) - 1
        if left:
            _TRANSITIONS[interview_id] = left


def _clear_configs(interview: Interview) -> None:
    accepted_payments = {card.proposal_id for card in interview.planned
                         if card.state == "accepted" and card.job is not None and card.job.job == "payment"}
    for entry in interview.transcript:
        for card in [*entry.planned, *([entry.card] if entry.card is not None else [])]:
            if card.job is not None:
                card.job.config = None
                if card.job.job == "payment" and (card.state == "accepted" or card.proposal_id in accepted_payments):
                    card.state = "declined"


def setup_state(interview: Interview, slug: str, *, cards: bool = False,
                 business_tools_enabled: bool = False) -> SetupState:
    """The interview as the owner sees it. Its messages leave out the transcript's first entry, the owner's own
    description (`start` puts it there), which the owner isn't shown back; the stored transcript, which later turns
    read, keeps it. Card messages appear only when requested by a client that can render them."""
    def visible(entry: Entry) -> ProposalCard | None:
        card = entry.card.model_copy(deep=True) if entry.card is not None else None
        if card is not None and card.job is not None and not business_tools_enabled:
            card.job.config = None
            if card.job.job == "payment" and card.state == "accepted":
                card.state = "declined"
        return card

    return SetupState(interview_id=interview.interview_id, desk_id=interview.desk_id, slug=slug, step=interview.step,
                      consent=interview.consent, question=interview.question, busy=interview.busy,
                      pending_card=interview.pending_card,
                      held_policy_keys=interview.held_policy_keys,
                      messages=[SetupMessage(role=entry.role, text=entry.text, choices=entry.choices, card=visible(entry))
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
                    retry_min_s: float = 0, check_retry: str = DRAFT_RETRY) -> Output | None:
    """A structured setup answer as `output` that `check` (if given, awaited when it answers an awaitable) finds
    nothing wrong with. A finished answer (`end_turn`) that doesn't fit, or that `check` lists problems with, gets one
    retry with them (`check`'s under `check_retry`); None when the retry doesn't fit either. 503 `model_unavailable`
    when the model gives no answer at
    all, one that stopped before it finished (any other stop reason, `max_tokens` say) whatever its text, or none
    within `timeout_s` (`SETUP_TIMEOUT_S` unless the caller gives another): each call's usage is recorded first, a
    timed-out one as failed."""
    messages = list(messages)
    # An owner display shows the reply (or Rules' answer) of only the run's first call; its retry resets it.
    display = current_display.get()
    field = "reply" if "reply" in output.model_fields else "answer" if "answer" in output.model_fields else None
    shows = display is not None and field is not None and display.take()
    for attempt in (1, 2):
        bound = timeout_s() if callable(timeout_s) else SETUP_TIMEOUT_S if timeout_s is None else timeout_s
        if bound <= 0 or (attempt == 2 and bound < retry_min_s):
            return None
        on_text = display.begin(field) if shows else None
        request = ModelRequest(route=route, system=[{"type": "text", "text": system}], messages=list(messages),
                               model=CONVERSATION_MODEL, effort=effort, max_tokens=max_tokens, output_schema=output,
                               timeout_s=bound, on_text=on_text)
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
            retry = check_retry.format(errors=problems)
        logger.info("a %s answer didn't fit %s (attempt %d)", route, output.__name__, attempt)
        answered = text if text is not None else parsed.model_dump_json()
        messages += [{"role": "assistant", "content": [{"type": "text", "text": answered}]}, _user(retry)]
    return None


async def structured(model: ModelClient, record: Record, system: str, messages: list[dict],
                     output: type[Output], max_tokens: int,
                     problems: Callable[[Output], list[str]] | None = None, **bounds: Any) -> Output:
    """The setup route's answer as `output`. An answer that doesn't fit, or that `problems` lists problems with (then
    under `ANSWER_RETRY`), gets one retry, with its errors, within `bounds` (`ask_model`'s `timeout_s` and
    `retry_min_s`); then, or when the model gives no answer at all, 503 `model_unavailable`."""
    if problems is not None:
        bounds["check_retry"] = ANSWER_RETRY
    answer = await _ask_drafts(model, record, system, messages, output, problems=problems, max_tokens=max_tokens,
                               **bounds)
    if answer is None:
        raise ApiProblem(503, "model_unavailable")
    return answer


async def _ask_drafts(model: ModelClient, record: Record, system: str, messages: list[dict],
                      output: type[Output], problems: Callable[[Output], list[str]] | None = None,
                      **kwargs) -> Output | None:
    """Retry dropped proposals, or what `problems` lists, once; a partial second answer remains usable, including on
    an unavailable retry."""
    last = None

    def check(parsed: Output) -> str | None:
        nonlocal last
        first = last is None
        last = parsed
        errors = parsed._draft_errors if isinstance(parsed, DraftOutput) else []
        if first and problems is not None:
            errors = [*errors, *problems(parsed)]
        return "\n".join(errors) if first and errors else None

    try:
        answer = await ask_model(model, record, system, messages, output, check=check, **kwargs)
        return answer if answer is not None else last
    except ApiProblem:
        if last is not None:
            return last
        raise


# Setup tools -------------------------------------------------------------------------------------------------------


async def run_setup_tool(owner: OwnerCtx, desk_id: str, tool: str, args: dict, *,
                         timeout_s: float | None = None) -> ExecResult | None:
    """Run an owner setup tool on `desk_id` as the owner: only a tool in the owner's `/context` for the Desk, then
    `/decide`, and `/execute` on an allow. None when it isn't given, is held or refused, or the kernel refuses or
    can't be reached: nothing ran that the kernel didn't allow, and setup goes on. `timeout_s` overrides only
    execution's transport deadline; context and decision calls retain the client's default."""
    decision = await decide_setup_tool(owner, desk_id, tool, args)
    if decision is None or decision == "not_given":
        return None
    return await execute_setup_tool(owner, tool, decision, timeout_s=timeout_s)


async def decide_setup_tool(owner: OwnerCtx, desk_id: str, tool: str, args: dict, *,
                            context: SessionContext | None = None) -> Decision | Literal["not_given"] | None:
    """Obtain an allow without executing; distinguish a tool not given from a failed or refused read."""
    session_id, generation = owner.owner_session_id, owner.owner_generation
    try:
        if context is None:
            context = await owner.kernel.call("GET /context/{session_id}?desk_id=", path={"session_id": session_id},
                                              query={"desk_id": desk_id})
        if tool not in {profile.tool for profile in context.tools}:
            logger.info("the setup tool %s isn't given on this Desk", tool)
            return "not_given"
        call = ToolCall(call_id="setup-" + secrets.token_hex(12), tool=tool, args=args)
        decision = await owner.kernel.call("POST /decide", DecideRequest(session_id=session_id, generation=generation,
                                                                         call=call, desk_id=desk_id))
        if decision.outcome != "allow":
            logger.info("the setup tool %s was decided %s", tool, decision.outcome)
            return None
        return decision
    except KernelFailed as failure:
        logger.warning("the setup tool %s was refused (%s)", tool, failure.code)
    except KernelUnavailable:
        logger.warning("the setup tool %s couldn't reach the kernel", tool)
    return None


async def execute_setup_tool(owner: OwnerCtx, tool: str, decision: Decision, *,
                             timeout_s: float | None = None) -> ExecResult | None:
    """Execute an allowed setup decision; the kernel rechecks the baseline at execution as usual."""
    if decision.outcome != "allow":
        return None
    try:
        return await owner.kernel.call("POST /execute", ExecuteRequest(decision_id=decision.decision_id,
                                                                       session_id=owner.owner_session_id,
                                                                       generation=owner.owner_generation),
                                       timeout_s=timeout_s)
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


def _memory_entry(result: ExecResult | None) -> Entry:
    if result is None or result.state != "succeeded":
        return Entry(role="tool_label", text=MEMORY_FAILED_LABEL, read="memory")
    return Entry(role="tool_label", text=MEMORY_LABEL, read="memory", content=_memory_text(result.model_view))


async def _read_website(owner: OwnerCtx, desk_id: str, url: str, host: str) -> Entry:
    result = await run_setup_tool(owner, desk_id, "native.fetch_website", {"url": url})
    return _website_entry(result, url=url, host=host)


def _website_entry(result: ExecResult | None, *, url: str, host: str) -> Entry:
    if result is None or result.state != "succeeded":
        return Entry(role="tool_label", text=WEBSITE_FAILED_LABEL.format(host=host), read="website", website=url)
    view = result.model_view
    content = "\n".join(part for part in (view.get("title"), view.get("text")) if isinstance(part, str))
    pages = view.get("pages")
    label = (WEBSITE_PAGES_LABEL.format(host=host, pages=pages)
             if type(pages) is int and pages > 1 else WEBSITE_LABEL.format(host=host))
    return Entry(role="tool_label", text=label, read="website", content=content[:READ_TEXT_MAX], website=url)


def _web_search_entry(result: ExecResult | None, *, query: str) -> Entry:
    """Keep the search's plain result lines as untrusted homework for the understanding call alone."""
    if result is None or result.state != "succeeded":
        return Entry(role="tool_label", text=WEB_SEARCH_FAILED_LABEL, read="web_search")
    results = result.model_view.get("results")
    lines = [item[key] for item in (results if isinstance(results, list) else []) if isinstance(item, dict)
             for key in ("title", "url", "snippet") if isinstance(item.get(key), str)]
    return Entry(role="tool_label", text=WEB_SEARCH_LABEL.format(query=query[:80]), read="web_search",
                 content="\n".join(lines)[:READ_TEXT_MAX])


async def _homework(owner: OwnerCtx, interview: Interview) -> list[Entry]:
    """Decide all reads before executing together; both phases share one budget and keep display order.

    The owner's display, when one is open, gets a `reading` for each read once the reads start (memory, the website,
    then each search given on this Desk, in saved order), then each read's `label` in that same order, as soon as it
    and every read before it are in. A label is the text its saved entry holds; a failed search whose label the
    transcript keeps only once repeats that text. None of it is state."""
    display = current_display.get()
    desk_id = interview.desk_id
    reads: list[tuple[str, dict, Callable[[ExecResult | None], Entry], float | None]] = [
        ("native.read_memory", {"query": MEMORY_QUERY}, _memory_entry, None)]
    shown_as: list[tuple[str, str | None]] = [("memory", None)]           # each read as the display names it
    site = website_url(interview.transcript[0].website)
    if site is not None:
        url, host = site
        reads.append(("native.fetch_website", {"url": url}, partial(_website_entry, url=url, host=host), None))
        shown_as.append(("website", host))
    queries = (interview.transcript[0].search_queries or [])[:3]
    reads.extend(("native.web_search", {"query": query}, partial(_web_search_entry, query=query),
                  WEB_SEARCH_EXECUTE_TIMEOUT_S)
                 for query in queries)
    shown_as.extend(("web_search", None) for _ in queries)
    tasks: dict[int, asyncio.Task[ExecResult | None]] = {}
    not_given: set[int] = set()
    shown: list[int] | None = None                     # the reads the display shows, once they have started
    labelled = 0

    def outcome(index: int) -> ExecResult | None:
        return tasks[index].result() if index in tasks and not tasks[index].cancelled() else None

    def show_reading() -> None:
        nonlocal shown
        if shown is not None:
            return
        shown = [index for index, (tool, _, _, _) in enumerate(reads)
                 if not (tool == "native.web_search" and index in not_given)]
        if display is not None:
            for index in shown:
                display.reading(*shown_as[index])

    def show_labels() -> None:
        nonlocal labelled
        while display is not None and shown is not None and labelled < len(shown):
            index = shown[labelled]
            if index in tasks and not tasks[index].done():
                return
            display.label(shown_as[index][0], reads[index][2](outcome(index)).text)
            labelled += 1

    try:
        async with asyncio.timeout(HOMEWORK_BUDGET_S):
            context = await owner.kernel.call("GET /context/{session_id}?desk_id=",
                                              path={"session_id": owner.owner_session_id}, query={"desk_id": desk_id})
            given = {profile.tool for profile in context.tools}
            not_given = {index for index, (tool, _, _, _) in enumerate(reads) if tool not in given}
            allowed = []
            for index, (tool, args, _, timeout_s) in enumerate(reads):
                decision = await decide_setup_tool(owner, desk_id, tool, args, context=context)
                if decision == "not_given":
                    not_given.add(index)
                elif decision is not None:
                    allowed.append((index, tool, decision, timeout_s))
            # /decide takes an exclusive session lock; /execute holds a shared lock through the read.
            # Finish every decision first so a long search cannot block a later decision's short timeout.
            for index, tool, decision, timeout_s in allowed:
                tasks[index] = asyncio.create_task(execute_setup_tool(owner, tool, decision, timeout_s=timeout_s))
            show_reading()
            show_labels()
            for task in tasks.values():                # in saved order: each label once it and those before are in
                await asyncio.wait({task})
                show_labels()
            if tasks:
                await asyncio.gather(*tasks.values())
    except TimeoutError:
        pass
    except (KernelFailed, KernelUnavailable):
        logger.warning("the setup homework couldn't read the owner's context")
    finally:
        for task in tasks.values():
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks.values(), return_exceptions=True)
    show_reading()                                     # reads cut short before they started still show, then fail
    show_labels()
    entries = []
    search_failed = False
    for index, (tool, _, entry, _) in enumerate(reads):
        if tool == "native.web_search" and index in not_given:
            continue
        result = entry(tasks[index].result() if index in tasks and not tasks[index].cancelled() else None)
        if result.read == "web_search" and result.text == WEB_SEARCH_FAILED_LABEL:
            if search_failed:
                continue
            search_failed = True
        entries.append(result)
    return entries


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
                          connected_apps=described.connected_apps,
                          search_queries=described.search_queries or None),
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
                         cards: bool = False, business_tools_enabled: bool = False) -> SetupState | None:
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
    return setup_state(interview, await _slug(owner, interview.desk_id), cards=cards,
                       business_tools_enabled=business_tools_enabled)


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
                admit: Callable[[], Awaitable[None]], cards: bool = False,
                business_tools_enabled: bool = False) -> SetupState:
    """Read the owner's description, make the Desk with Answering off, and ask for consent, once `admit` (the route's
    limits) lets the start through. A repeat of the client's key is answered before `admit` counts it; otherwise the
    interview's row is written first, under the key's lock, and the start's outcome saved to it, its failure too
    (module docstring). A request another process admitted meanwhile is answered as a repeat."""
    key = body.idempotency_key
    async with ADMISSIONS.admitting(owner.copy_id, key):
        repeat = await repeated_start(owner, engine, body, cards=cards,
                                      business_tools_enabled=business_tools_enabled)
        if repeat is not None:
            return repeat
        await admit()
        interview_id = await _claim(engine, owner.copy_id, key, start_sha256(body))
    if interview_id is None:                        # another process took the key since this one looked
        repeat = await repeated_start(owner, engine, body, cards=cards,
                                      business_tools_enabled=business_tools_enabled)
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
    return setup_state(interview, slug, cards=cards, business_tools_enabled=business_tools_enabled)


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


async def read(owner: OwnerCtx, engine: AsyncEngine, interview_id: str, *, runs: TurnRuns, cards: bool = False,
               business_tools_enabled: bool = False) -> SetupState:
    interview = await _recover_turn(owner, engine, interview_id, runs)
    interview.business_tools_enabled = business_tools_enabled
    return setup_state(interview, await _slug(owner, interview.desk_id), cards=cards,
                       business_tools_enabled=interview.business_tools_enabled)


def _empty_payment_config(title: str) -> PurposePaymentProposalConfig | None:
    purpose = " ".join(title.split())[:60]
    if not purpose:
        return None
    return PurposePaymentProposalConfig(block="purpose_payment", purpose=purpose, amount_cents=None)


def _check_decision(interview: Interview, proposal_id: str, decision: SetupProposalIn, *,
                    configs: bool = True) -> tuple[ProposalCard, SetupProposalIn, BlockConfig | None]:
    """Validate a waiting-card decision without changing the card or transcript."""
    if interview.step != "questions":
        raise ApiProblem(409, "conflict")
    card = next((entry.card for entry in reversed(interview.transcript)
                 if entry.card is not None and entry.card.proposal_id == proposal_id), None)
    if card is None and not any(item.proposal_id == proposal_id for item in interview.planned):
        raise ApiProblem(404, "not_found")
    if interview.pending_card != proposal_id:
        raise ApiProblem(409, "conflict")
    # Revalidate even model_construct/assignment input before mutating any part of the card.
    try:
        decision = SetupProposalIn.model_validate(decision.model_dump(exclude_unset=True))
    except ValidationError:
        raise ApiProblem(422, "invalid") from None
    if card.job is None and (decision.title is not None or decision.autonomy is not None):
        raise ApiProblem(422, "invalid")
    config = card.job.config if card.job is not None and configs else None
    if configs and card.job is not None and card.job.job == "payment" and config is None:
        config = _empty_payment_config(card.job.title)
    if (decision.accept and card.job is not None and card.job.job == "payment"
            and (not isinstance(config, PurposePaymentProposalConfig)
                 or (decision.amount_cents if decision.amount_cents is not None
                     else config.amount_cents or 0) < 1)):
        raise ApiProblem(422, "amount_required")
    if decision.amount_cents is not None and not isinstance(config, PurposePaymentProposalConfig):
        raise ApiProblem(422, "invalid")
    return card, decision, config


def apply_decision(interview: Interview, proposal_id: str, decision: SetupProposalIn) -> None:
    """Validate an answer and change only the waiting card, without I/O or transcript additions."""
    card, decision, config = _check_decision(interview, proposal_id, decision, configs=interview.business_tools_enabled)
    card.state = "accepted" if decision.accept else "declined"
    if card.connector is not None:
        card.connector.connected = decision.accept and card.connector.app != "stripe"
    if decision.amount_cents is not None:
        config.amount_cents = decision.amount_cents
    if card.job is not None:
        if card.job.config is None:
            card.job.config = config
        if decision.title is not None:
            card.job.title = decision.title
        if decision.autonomy is not None:
            card.job.autonomy = decision.autonomy


async def decide_proposal(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient,
                          interview_id: str, proposal_id: str, decision: SetupProposalIn, *,
                          runs: TurnRuns, ro_schema: str, admit: Callable[[], Awaitable[None]],
                          cards: bool = False, business_tools_enabled: bool = False) -> SetupState:
    """Answer the pending card through the shared runner, without retaining its temporary owner marker."""
    connect = False

    def check(interview: Interview) -> None:
        interview.business_tools_enabled = business_tools_enabled
        _check_decision(interview, proposal_id, decision, configs=business_tools_enabled)

    async def turn(ctx: OwnerCtx, interview: Interview, staged: list[Entry]) -> None:
        nonlocal connect
        interview.business_tools_enabled = business_tools_enabled
        if not business_tools_enabled:
            _clear_configs(interview)
        apply_decision(interview, proposal_id, decision)
        entry = next(entry for entry in reversed(interview.transcript)
                     if entry.card is not None and entry.card.proposal_id == proposal_id)
        entry.owner_decided = True
        await card_turn(ctx, engine, model, interview, proposal_id)
        connect = _claim_connector_connect(interview, None if interview.step == "tools" else proposal_id)

    async def after(ctx: OwnerCtx, interview: Interview) -> None:
        if connect:
            await _connect_accepted_connector(ctx, engine, interview)
        if interview.step == "tools":
            await publish_plan(ctx, engine, interview)

    return await run_turn(owner, engine, model, interview_id, runs=runs, ro_schema=ro_schema, admit=admit,
                          check=check, stage=lambda interview: [Entry(role="owner", text="")], turn=turn,
                          keep_staged=False, after=after,
                          render=partial(setup_state, cards=cards, business_tools_enabled=business_tools_enabled))



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
        elif entry.read == "web_search" and entry.content:
            parts.append(wrap(WEB_SEARCH_TAG, entry.content))
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


def _owner_sourced_suggestions(suggested: SuggestedFacts, text: str) -> SuggestedFacts:
    """Search may inform the plan, but suggested facts need evidence from the owner's sources.

    Only explicitly supported fields survive. Construct from that allowlist so a future field is omitted
    until it has its own provenance check, including when the model supplies a subclass with extra fields.
    """
    folded = text.casefold()
    kept = {
        "service_area": suggested.service_area if suggested.service_area.casefold() in folded else "",
        "hours": suggested.hours if owner_supports("hours", suggested.hours, text) else [],
        "public_contact": suggested.public_contact if owner_supports(
            "public_contact", suggested.public_contact, text) else "",
        "price_items": [item for item in suggested.price_items if owner_supports("price_items", [item], text)],
        "after_hours": "",
    }
    filtered = SuggestedFacts.model_construct(**kept)
    # model_construct fills schema defaults too; unreviewed future defaults must not become facts.
    for name in filtered.__dict__.keys() - kept.keys():
        delattr(filtered, name)
    filtered_values = filtered.model_dump()
    for name, value in suggested.model_dump().items():
        if name not in kept or value != filtered_values[name]:
            logger.info("dropped setup suggestion: %s", name)
    return filtered


async def _after_consent(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview: Interview,
                         entries: list[Entry]) -> None:
    """Append the consultant opening and its first fact question; the caller owns persistence."""
    def time_left() -> float:
        if interview.turn_deadline is None:
            return UNDERSTAND_TIMEOUT_S
        return min(UNDERSTAND_TIMEOUT_S,
                   interview.turn_deadline - asyncio.get_running_loop().time() - TURN_FINISH_S)

    try:
        answer = await _ask_drafts(model, recorder(engine, owner), SETUP_UNDERSTAND_SYSTEM,
                                 [_understanding_message(interview, entries)], SetupUnderstanding,
                                 # Fifteen seconds left on the turn: ten to finish, five for a retry.
                                 max_tokens=UNDERSTAND_MAX_TOKENS, effort="medium", timeout_s=time_left,
                                 retry_min_s=UNDERSTAND_RETRY_MIN_S)
    except ApiProblem as failed:
        if failed.status != 503 or failed.error != "model_unavailable":
            raise
        answer = None
    if answer is None:
        logger.warning("the setup understanding was unavailable; asking the first question")
        interview.transcript.append(_ask(interview, "what_you_do"))
        return
    # Match exactly the sources included in the understanding message, excluding this run's staged entries.
    sources = [entry for entry in entries if entry.pending is None or entry.pending != _run_id(interview)]
    if any(entry.read == "web_search" and entry.content for entry in sources):
        owner_text = "\n".join([_history(interview)[0].text, *[
            entry.content for entry in sources if entry.read in {"memory", "website"} and entry.content]])
        answer.suggested = _owner_sourced_suggestions(answer.suggested, owner_text)
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
    owner_decided = {entry.card.proposal_id for entry in transcript if entry.card and entry.owner_decided}
    planned = [shown.get(card.proposal_id, card) for entry in transcript for card in entry.planned]
    dropped = {proposal_id for entry in transcript for proposal_id in entry.dropped}
    # The one real Stripe attempt runs after Claude's reply; once it's claimed, an accepted Stripe card still not
    # connected failed, so Claude must not call it connected.
    attempted = any(entry.connector_connect_attempted for entry in interview.transcript)
    items = []
    for card in planned:
        status = (card.state if card.state != "proposed" else
                  "dropped" if card.proposal_id in dropped else
                  "shown" if card.proposal_id in shown else "planned")
        if card.state == "changed":
            status = f"changed (replaced by {card.superseded_by})"
        if (attempted and card.state == "accepted" and card.connector is not None
                and card.connector.app == "stripe" and not card.connector.connected):
            status = SETUP_PLAN_NOT_CONNECTED
        if card.state == "declined" and card.proposal_id not in owner_decided and _unpriced_payment(card.job):
            status = SETUP_PLAN_NO_AMOUNT
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
                   keep_staged: bool = True, wait: bool = True,
                   after: Callable[[OwnerCtx, Interview], Awaitable[None]] | None = None,
                   render: Callable[[Interview, str], SetupState] = setup_state) -> SetupState:
    """Store staged entries, run a detached owner turn, and return its landed or busy state.

    `stage` only produces entries; consent alone may also set `interview.consent`. Every other change (answers,
    card state, step) belongs in `turn`, so rollback needs no in-memory undo and works after a process dies.
    Hand the guard to the task immediately after admission, without an await in between. Request cancellation
    never cancels the run; wait for its busy commit, then up to `TURN_WAIT_S` for its final state (`wait=False`
    answers the busy state as soon as it is stored).
    `keep_staged=False` removes temporary markers on success. The run deadline covers detached connection
    acquisition through the final commit.
    `after` keeps the guard, without a transaction open, under its own `TURN_AFTER_TIMEOUT_S` bound; its failure
    is logged by type only and returns the landed state. Shutdown cancellation after commit propagates without
    rolling back the turn. The owner's display gets `done` once a committed turn has also run `after`, closed its
    connections and released the guard; an error is sent after the rollback.
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
        interview.turn_deadline = asyncio.get_running_loop().time() + TURN_RUN_TIMEOUT_S
        display = current_display.get()
        assert display is not None and display.run is not None
        run_id = display.run
        busy = None
        committed = False
        try:
            async with contextlib.AsyncExitStack() as stack:
                async with asyncio.timeout_at(interview.turn_deadline):
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
                    busy = _stored(interview)  # _commit may clear disabled card configs before saving.
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
            answered = ApiProblem(503, "model_unavailable") if isinstance(failed, TimeoutError) else failed
            display.finish("error", {"run": run_id, "error": display_failure(answered)["error"]})
            if answered is not failed:
                raise answered from None
            raise
        finally:
            guard.close()
            busy_stored.set()                 # a failed busy commit wakes the request to receive its error
            if committed:
                # Only now is the turn's work done and the interview free: a refetch reads the final state, and
                # the next answer is taken.
                display.finish("done", {"run": run_id})

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
    if not wait:
        return pending
    done, _ = await asyncio.wait({task}, timeout=TURN_WAIT_S)
    if done:
        return task.result()
    return pending


async def consent(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview_id: str, allow: bool, *,
                  runs: TurnRuns, ro_schema: str, admit: Callable[[], Awaitable[None]],
                  cards: bool = False, business_tools_enabled: bool = False) -> SetupState:
    """Run consent and its reads through the shared turn runner, answering the busy state once it is stored; no
    reads run after no."""
    def check(interview: Interview) -> None:
        interview.business_tools_enabled = business_tools_enabled
        if interview.consent is not None or interview.step != "questions":
            raise ApiProblem(409, "conflict")

    def stage(interview: Interview) -> list[Entry]:
        interview.consent = allow
        return [Entry(role="owner", text=CONSENT_ANSWERS[allow], cards=cards)]

    async def turn(ctx: OwnerCtx, interview: Interview, staged: list[Entry]) -> None:
        entries = await _homework(ctx, interview) if allow else []
        interview.transcript += entries
        interview.business_tools_enabled = business_tools_enabled
        await _after_consent(ctx, engine, model, interview, entries)

    return await run_turn(owner, engine, model, interview_id, runs=runs, ro_schema=ro_schema, admit=admit,
                          check=check, stage=stage, turn=turn, wait=False,
                          render=partial(setup_state, cards=cards, business_tools_enabled=business_tools_enabled))


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
    so_far = interview.answers.model_dump_json(exclude_defaults=True, exclude={"suggested_fields"})
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


def _singular(word: str) -> str:
    """A word of four or more letters in one form for its singular and regular plural, so "class" and "classes" or
    "case" and "cases" match: one ending in "ss" as it is, else without a plural "es" after s, x, z, ch or sh, a
    plural "s", or a final "e" after s, z or ch."""
    if len(word) < 4 or word.endswith("ss"):
        return word
    if re.search(r"(?:s|x|z|ch|sh)es$", word):
        return word[:-2]
    if word.endswith("s"):
        return word[:-1]
    return word[:-1] if re.search(r"(?:s|z|ch)e$", word) else word


def _title(title: str) -> str:
    """A price title's key: case, spacing and regular plurals ignored, as `owner_supports` backs titles."""
    return re.sub(r"[^\W\d_]{4,}", lambda match: _singular(match.group()), " ".join(title.split()).casefold())


def _priced(listed: list[dict], named: list[PriceAnswer], key: QuestionKey) -> list[dict]:
    """The price list with the prices a limit turn named (`LIMIT_TURN_FACTS`): each updates the price of the item
    listed with the same title (`_title`), else is added at the end; no item is removed. A new item past the list's
    `PRICE_ITEMS_MAX` is dropped and logged."""
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


# The parts of a public contact (`PUBLIC_CONTACT_FORMAT`): emails and URLs with a scheme or www., then bare domains (a
# hostname whose last label is letters), then phone numbers in what's left. Label words around them don't count.
_CONTACT_ADDRESS = re.compile(r"(?:https?://|www\.)[^\s<>\"']+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_CONTACT_DOMAIN = re.compile(r"(?<![\w@.-])(?:[^\W_](?:[\w-]*[^\W_])?\.)+[^\W\d_]{2,63}(?![\w-]|\.[^\W_])"
                             r"(?:/[^\s<>\"']*)?")
_CONTACT_PHONE = re.compile(r"(?<!\w)\+?\d[\d\s().\-\u2010-\u2015\u2212]*\d(?!\w)")
# The labels a public contact may carry: `PUBLIC_CONTACT_FORMAT`'s list (a test keeps the two in step), their Spanish
# equivalents, an extension's "ext" and the words that join parts. Their words are never the owner's to type.
_CONTACT_LABELS = (
    "Call us at", "Call", "Call or text", "Text us at", "Text", "Email us at", "Email", "Phone", "Tel", "Mobile",
    "Office", "Website", "Web", "Ll\u00e1manos al", "Escr\u00edbenos a", "Tel\u00e9fono", "Correo",
    "Llama al", "M\u00f3vil", "Celular", "Oficina", "Sitio web", "P\u00e1gina web", "Correo electr\u00f3nico",
    "ext", "Ask for", "Site", "or", "and", "o", "y",
)
_CONTACT_LABEL_WORDS = frozenset(re.findall(r"\w+", " ".join(_CONTACT_LABELS).casefold()))


def _contact_parts(text: str) -> tuple[set[str], list[str]]:
    """The addresses in `text` (emails, URLs and bare domains, in lower case and without a scheme, www. or a trailing
    slash) and its phone numbers' digits (at least 7)."""
    addresses = set()

    def take(match: re.Match[str]) -> str:
        found = match.group().rstrip(".,;:!?)]}")
        addresses.add(re.sub(r"^(?:https?://)?(?:www\.)?", "", found).rstrip("/"))
        return " "

    rest = _CONTACT_DOMAIN.sub(take, _CONTACT_ADDRESS.sub(take, text.casefold()))
    phones = [re.sub(r"\D", "", match.group()) for match in _CONTACT_PHONE.finditer(rest)]
    return addresses, [digits for digits in phones if len(digits) >= 7]


def _contact_words(text: str) -> set[str]:
    """Words beyond recognized contact parts and their labels (`_CONTACT_LABELS`)."""
    rest = _CONTACT_DOMAIN.sub(" ", _CONTACT_ADDRESS.sub(" ", text.casefold()))
    rest = _CONTACT_PHONE.sub(lambda match: " " if len(re.sub(r"\D", "", match.group())) >= 7 else match.group(), rest)
    return set(re.findall(r"\w+", rest)) - _CONTACT_LABEL_WORDS


def owner_supports(field: Literal["public_contact", "price_items", "hours"],
                   value: str | list[PriceAnswer] | list[HoursAnswer], owner_text: str, *,
                   stated: bool = False) -> bool:
    """Whether the owner's typed text contains every structured value, independent of model or read text. A contact
    needs every part in it (`_contact_parts`): each address whole, and each phone's last 10 digits (all of them when
    it has fewer) in one number the owner typed, plus any words beyond labels and separators. A contact with no part
    needs its whole text. With `stated`, prices need a dollar sign, every title word of four or more letters and at
    least one of three or more, ignoring regular plurals on both sides; hours need a meridiem, a clock time or a range
    in order, never unrelated bare counts."""
    if not value:
        return True
    folded = owner_text.casefold()
    if field == "public_contact":
        contact = cast(str, value).casefold()
        addresses, phones = _contact_parts(contact)
        if addresses or phones:
            owner_addresses, owner_phones = _contact_parts(owner_text)
            return addresses <= owner_addresses and all(
                any(digits[-10:] in typed for typed in owner_phones) for digits in phones
            ) and _contact_words(contact) <= set(re.findall(r"\w+", folded))
        return contact in folded
    if field == "price_items":
        title_text = re.sub(r"[^\W\d_]{4,}", lambda match: _singular(match.group()), folded)
        sign = r"\$\s?" if stated else r"\$?"
        amounts = {int(Decimal(re.sub(r"[$,\s]", "", match.group(0))) * 100)
                   for match in re.finditer(rf"(?<![\w.]){sign}\d+(?:,\d{{3}})*(?:\.\d{{1,2}})?(?!\w|\.\d|,\d)",
                                            owner_text)}

        def named(title: str) -> bool:
            # Short words such as "per", "for" or "fee" may be the model's; the longer ones must be the owner's.
            words = {word: _singular(word) in title_text for word in re.findall(r"[^\W\d_]{3,}", title.casefold())}
            return any(words.values()) and all(found for word, found in words.items() if len(word) >= 4)

        return all(item.unit_cents in amounts and (not stated or named(item.title))
                   for item in cast(list[PriceAnswer], value))

    def has_time(clock: str, text: str, *, explicit: bool = False) -> bool:
        hour, minute = map(int, clock.split(":"))
        period = "am" if hour < 12 else "pm"
        minutes = r"(?::00)?" if minute == 0 else f":{minute:02d}"
        clock_forms = rf"(?:{re.escape(clock)}|(?:{hour}|{hour % 12 or 12}){minutes})"
        matching_period = rf"{period[0]}\.?m\.?"
        no_period = r"(?!\s*[ap]\.?m\.?(?!\w))"
        if explicit:
            clock_forms = rf"(?:{re.escape(clock)}|{hour % 12 or 12}:{minute:02d})"
            time = rf"(?:{hour % 12 or 12}{minutes}\s*{matching_period}|{clock_forms}{no_period})"
        else:
            time = rf"{clock_forms}(?:\s*{matching_period}|{no_period})"
        return re.search(rf"(?<![\w:]){time}(?![\w:]|\.\d)", text) is not None

    # A range ("9 to 5", "9 till 5", "between 9 and 5", "de 9 a 5", "8.30-5.30") backs a window only in order: its
    # start before the separator and its end after it. Dotted minutes count only inside a range, never as prices.
    endpoint = r"(\d{1,2}(?:[:.]\d{2})?(?:\s*[ap]\.?m\.?)?)"
    ranges = [tuple(re.sub(r"(?<=\d)\.(?=\d)", ":", part) for part in match.groups()) for pattern in (
        rf"(?<![\w:.$-]){endpoint}\s*(?:(?:to|until|till|['’]?til)\b|[-–—])\s*{endpoint}",
        rf"\bbetween\s+{endpoint}\s+and\s+{endpoint}", rf"\bde\s+{endpoint}\s+a\s+{endpoint}",
    ) for match in re.finditer(rf"{pattern}(?![\w:]|[-–—]\w|\.\d)", folded)]
    return all((has_time(window.start, folded, explicit=stated) and has_time(window.end, folded, explicit=stated))
               or any(has_time(window.start, start) and has_time(window.end, end) for start, end in ranges)
               for window in cast(list[HoursAnswer], value))


# Each fact a turn can set, with its home question, the one that asks the owner for it: there a turn's value is the
# owner's (`_on_topic`), and the quote question's for a fact it records (`LIMIT_TURN_FACTS`). Other turns may have the
# field too (`FIELD_TURNS`) and read the website and memory, so there it follows the off-topic rules: free text is
# held until the owner confirms it, and a structured value counts only when that answer states it or only removes
# some of the owner's own (`_backed_off_topic`). Neither replaces nor refills the owner's own value. Names are handled
# on their own (`merged`, `_rename`).
FACT_HOMES: dict[str, QuestionKey] = {
    "summary": "what_you_do", "pricing": "what_you_do", "intake": "what_you_do",
    "service_area": "hours_and_area", "hours": "hours_and_area",
    "public_contact": "contact_and_after_hours", "after_hours": "contact_and_after_hours",
    "urgent": "contact_and_after_hours", "price_items": "quote_limit",
}


def _on_topic(name: str, key: QuestionKey) -> bool:
    """Whether fact `name` is on topic on the turn answering `key`: on its home question (`FACT_HOMES`), and on the
    quote question for a fact that question records (`LIMIT_TURN_FACTS`)."""
    return FACT_HOMES.get(name) == key or LIMIT_TURN_FACTS.get(name) == key


def _fact_patch_fields(patch: SetupPatch, key: QuestionKey) -> list[str]:
    """Only fact fields this question is allowed to merge, including explicit empty lists: never a field only other
    questions' turns have (`FIELD_TURNS`, read at each call), which `merged` drops, so it never counts as given."""
    return [name for name, value in patch
            if name in SetupPatch.model_fields and name not in LIMIT_QUESTIONS
            and value is not None and not (isinstance(value, str) and not value.strip())
            and (name not in FIELD_TURNS or key in FIELD_TURNS[name])
            and (key not in LIMIT_QUESTIONS.values() or LIMIT_TURN_FACTS.get(name) == key)]


def _only_removes_hours(before: SetupAnswers, named: list[HoursAnswer]) -> bool:
    """A strict subset of the stored owner days and windows, with every retained time unchanged."""
    if "hours" in before.suggested_fields:
        return False
    stored = {(day, window.start, window.end) for window in before.hours for day in window.days}
    remaining = {(day, window.start, window.end) for answer in named for window in [answer.window()]
                 for day in window.days}
    return remaining < stored


# The words that name each day in an owner's answer, in English or Spanish, singular or plural ("weekdays" and
# "weekends" name theirs, and a daily expression all seven): a day added to the owner's hours off their home question
# is named in that answer.
_DAILY = re.compile(r"(?<!\w)(?:daily|every\s+day|7\s+days\s+a\s+week|seven\s+days\s+a\s+week|todos\s+los\s+d[ií]as"
                    r"|a\s+diario)(?!\w)")
_DAY_NAMES: dict[str, tuple[str, ...]] = {
    "mon": ("monday", "mon", "lunes", "weekday", "entre semana"),
    "tue": ("tuesday", "tue", "tues", "martes", "weekday", "entre semana"),
    "wed": ("wednesday", "wed", "miércoles", "miercoles", "weekday", "entre semana"),
    "thu": ("thursday", "thu", "thur", "thurs", "jueves", "weekday", "entre semana"),
    "fri": ("friday", "fri", "viernes", "weekday", "entre semana"),
    "sat": ("saturday", "sat", "sábado", "sabado", "weekend", "fin de semana", "fines de semana"),
    "sun": ("sunday", "sun", "domingo", "weekend", "fin de semana", "fines de semana"),
}


def _names_day(day: str, text: str) -> bool:
    folded = text.casefold()
    return (_DAILY.search(folded) is not None
            or any(re.search(rf"(?<!\w){re.escape(word)}s?(?!\w)", folded) for word in _DAY_NAMES[day]))


def _backed_off_topic(patch: SetupPatch, key: QuestionKey, said: str, before: SetupAnswers | None = None) -> set[str]:
    """The facts this turn gave off their topic (`_on_topic`) that the owner's own words this turn (`said`) back: a
    list they said to clear (`CLEARABLE`), a removal from stored owner hours, or a structured value `owner_supports`
    finds in `said`. Price patches merge by title: unchanged owner items need no new backing, but every retained
    suggested item does. Hours replace the stored list whole, so only a pure addition to the owner's hours, keeping
    every stored day and time, is checked on its new windows alone, each on a day that answer names. Such a turn reads
    the website and memory, so prices and times need explicit syntax. Free text is never backed off its topic."""
    backed = set()
    for name in _fact_patch_fields(patch, key):
        if name not in FACT_HOMES or _on_topic(name, key):
            continue
        value = getattr(patch, name)
        days_named = True
        if name == "hours" and value and before is not None and name not in before.suggested_fields:
            # Each window as one (day, start, end) per day, so days grouped with the same hours compare one by one.
            stored = {(day, window.start, window.end) for window in before.hours for day in window.days}
            patched = {(day, window.start, window.end): answer for answer in value for window in [answer.window()]
                       for day in window.days}
            added = [(day, answer) for (day, *times), answer in patched.items() if (day, *times) not in stored]
            if added and stored <= set(patched):
                # A pure addition: only its new days need stating, as only new or changed prices do.
                value = [HoursAnswer(days=[day], start=answer.start, end=answer.end) for day, answer in added]
                days_named = all(_names_day(day, said) for day, _ in added)
        if name == "price_items" and value and before is not None:
            if name in before.suggested_fields:
                # A held list stays held until every retained item is backed, not just this turn's correction.
                value = [PriceAnswer.model_validate(item)
                         for item in _priced(before.model_dump()[name], value, key)]
            else:
                listed = {_title(item.title): item.unit_cents for item in before.price_items}
                changed = [item for item in value if listed.get(_title(item.title)) != item.unit_cents]
                value = changed or value
        if ((name in CLEARABLE and value == [])
                or (name == "hours" and before is not None and _only_removes_hours(before, patch.hours or []))
                or (name in {"public_contact", "price_items", "hours"} and days_named
                    and owner_supports(name, value, said, stated=True))):
            backed.add(name)
    return backed


def _owner_patch_fields(patch: SetupPatch, key: QuestionKey, before: SetupAnswers,
                        after: SetupAnswers, owner_text: str, *, backed: Collection[str] = frozenset()) -> list[str]:
    """Keep explicit clears, topic-matched prose, owner-supported structured facts and the off-topic facts this
    turn's own words back (`backed`) as owner answers. Prose held before and re-emitted unchanged stays held unless
    the owner's own words contain it."""
    fields = []
    folded = " ".join(owner_text.split()).casefold()
    for name in _fact_patch_fields(patch, key):
        value = getattr(patch, name)
        if name not in FACT_HOMES or name in backed or (value == [] and getattr(after, name) == []):
            fields.append(name)
            continue
        if not _on_topic(name, key):
            continue
        if (name not in {"public_contact", "price_items", "hours"}
                and name in before.suggested_fields and getattr(before, name) == getattr(after, name)
                and " ".join(str(value).split()).casefold() not in folded):
            continue
        # A partial quote patch cannot take ownership of held items it never named.
        if name == "price_items" and name in before.suggested_fields:
            named = {_title(item.title) for item in value}
            if any(_title(item.title) not in named for item in after.price_items):
                continue
        if name in {"public_contact", "price_items", "hours"} and not owner_supports(name, value, owner_text):
            continue
        fields.append(name)
    return fields


def merged(answers: SetupAnswers, patch: SetupPatch, key: QuestionKey, *,
           owner_fields: Collection[str] = frozenset(), backed: Collection[str] = frozenset()) -> SetupAnswers:
    """`answers` with what the patch sets (a blank text sets nothing). Each limit is taken only on the turn answering
    its own question (`LIMIT_QUESTIONS`), a fact in `FIELD_TURNS` only on the turns it lists, and any other fact only
    on a turn answering a question that owns no limit, but for the explicit facts in `LIMIT_TURN_FACTS`: the quote
    question replaces pricing text and only updates or adds price items (`_priced`). Off-topic price patches also
    update or add by title, except explicit clears. Anything else is dropped and logged (by its label or field name,
    never its value). An off-topic fact replaces the stored one when the owner's own words this turn back it
    (`backed`, from `_backed_off_topic`); any other cannot replace owner facts, nor refill a fact the owner set or
    cleared (`owner_fields`). Names are reduced as the Desk takes them."""
    values = answers.model_dump()
    limit_turn = key in LIMIT_QUESTIONS.values()
    for name, value in patch:
        if name not in SetupPatch.model_fields:
            continue
        if value is None or (isinstance(value, str) and not value.strip()):
            continue
        if name in LIMIT_QUESTIONS and key != LIMIT_QUESTIONS[name]:
            logger.warning("a setup turn answering %s carried %s; it was dropped", key, LIMIT_LABELS[name])
            continue
        if name in FIELD_TURNS and key not in FIELD_TURNS[name]:
            logger.warning("a setup turn answering %s carried %s; it was dropped", key, name)
            continue
        if limit_turn and name not in LIMIT_QUESTIONS:
            if LIMIT_TURN_FACTS.get(name) == key:
                values[name] = _priced(values[name], value, key) if name == "price_items" else value
            else:
                logger.warning("a setup turn answering %s carried %s; it was dropped", key, name)
            continue
        if name == "hours":
            value = [window.window() for window in value]
        elif name == "owner_display_name":
            value = reduce_name(value) or None
        elif name == "business_name":
            value = " ".join(value.split()) or None
        if (name in FACT_HOMES and not _on_topic(name, key) and name not in backed
                and (name in owner_fields or (getattr(answers, name) and name not in answers.suggested_fields))):
            if value != getattr(answers, name):
                logger.warning("setup dropped off-topic field %s", name)
            continue
        if value is not None:
            values[name] = _priced(values[name], value, key) if name == "price_items" and value else value
    return SetupAnswers.model_validate(values)


def _held_off_topic(before: SetupAnswers, after: SetupAnswers, patch: SetupPatch,
                    key: QuestionKey) -> list[QuestionKey]:
    """The questions that record the facts this turn's patch would change on them (`FACT_HOMES`), but which `merged`
    kept off the answers on question `key`, as off its topic: each one once, in the patch's order."""
    homes = []
    for name in _fact_patch_fields(patch, key):
        home = FACT_HOMES.get(name)
        if home is None or home in homes or _on_topic(name, key) or getattr(after, name) != getattr(before, name):
            continue
        there = merged(before, SetupPatch.model_validate({name: getattr(patch, name)}), home)
        if getattr(there, name) != getattr(before, name):
            homes.append(home)
    return homes


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
    payment_config = _empty_payment_config(draft.title) if draft.job == "payment" else None
    if draft.job == "payment" and payment_config is None:
        logger.warning("setup dropped a payment job with an empty purpose")
        return None
    fields = draft.model_dump(mode="json")
    if draft.job == "payment" and fields["config"] is None:
        fields["config"] = payment_config.model_dump(mode="json")
    if fields["config"] is not None and fields["config"]["block"] == "purpose_payment":
        fields["config"]["amount_cents"] = None
    if not interview.business_tools_enabled:
        fields["config"] = None
    return ProposalCard(proposal_id=new_proposal_id(), kind="job", state="proposed",
                        job=JobProposal(**fields, can_do_today=CAPABILITIES[draft.job]), connector=None)


def _next_ask(interview: Interview, source, available: list[ProposalCard]) -> QuestionKey | ProposalCard | None:
    """Honor one fitting ask, otherwise ordinary topics first, then the hidden plan in order. On the turn of the change
    that reopened the questions (`reopen`) alone, a topic covered before can be asked again when Claude names it, but
    for the one being answered, so a change reaches the question that records it; the turns after it ask none again."""
    unshown = [card for card in available if card.proposal_id not in interview.dropped] if interview.shows_cards else []
    proposed = source.next if source is not None else None
    if proposed is not None:
        answering = interview.latest_ask.question if interview.latest_ask is not None else None
        if proposed.kind == "topic" and (proposed.topic not in interview.covered
                                         or (interview.reopening and proposed.topic != answering)):
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
        wrap(ANSWERS_SO_FAR_TAG, interview.answers.model_dump_json(exclude={"suggested_fields"})),
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


# A "?" asks only where it ends a sentence: before a space, the end, or a closing quote or bracket. It still asks
# when Markdown emphasis closes right after it ("**When are you open?**"). One inside a link or mid-word
# ("example/?ref=desk") asks nothing, so it leaves the topic's question to be asked.
_ENDS_A_QUESTION = re.compile(r"\?[*_]*(?=\s|$|[\"'\u201d\u2019)\]])")


def _asks(text: str) -> bool:
    return _ENDS_A_QUESTION.search(text) is not None


def _code_next(interview: Interview, answering: QuestionKey | None = None) -> QuestionKey | None:
    """The topic code asks next by default (`_next_ask` without the model's proposal), taking `answering` as covered."""
    return next((key for key in QUESTION_KEYS
                 if key not in interview.covered and key != answering and key not in OPT_IN_TOPICS), None)


# A time frame or time threshold the owner states ("we reply within one business day", "a deadline in the next week").
# A customer line keeps it word for word where the kernel's public-text check allows, or the turn's reply names the
# change and points to What customers will read (`SETUP_TURN_SYSTEM`). Code checks only that each one is kept or
# named, never what the kernel would accept.
_COUNT_EN = (r"(?:\d+(?:\s*(?:to|or)\s*\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|"
             r"twenty|thirty|forty\s?eight|seventy\s?two|a\s+few|a\s+couple(?:\s+of)?|few|several)")
_UNIT_EN = r"(?:(?:business|working|work|calendar)\s+)?(?:minute|hour|day|week|month)s?"
_COUNT_ES = (r"(?:\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta|"
             r"cuarenta\s+y\s+ocho|setenta\s+y\s+dos|unos\s+pocos|unas\s+pocas|pocos|pocas|unos|unas)")
_UNIT_ES = r"(?:minutos?|horas?|d[ií]as?|semanas?|mes(?:es)?)(?:\s+(?:h[aá]bil(?:es)?|laborables?))?"
# A weekday only as a deadline ("by Friday"): "Monday to Friday" is the hours.
_WEEKDAY_EN = r"(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|the\s+weekend)"
_WEEKDAY_ES = r"(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|fin\s+de\s+semana)"
OWNER_TIME_FRAME = re.compile(
    rf"(?<!\w)(?:{_COUNT_EN}\s+{_UNIT_EN}"
    r"|\d+\s*(?:hrs?|h|mins?)"
    # "a" or "an" counts only after a deadline's or a threshold's words: "$150 an hour" and "once a week" are none
    rf"|(?:within|in|under|after|inside(?:\s+of)?|at\s+least)\s+an?\s+{_UNIT_EN}"
    r"|an?\s+(?:minute|hour|day|week|month)(?:'s|s)?\s+(?:notice|ahead|in\s+advance|beforehand)"
    r"|(?:the\s+)?(?:next|same|following)\s+(?:(?:business|working)\s+)?(?:day|week|month|morning)"
    r"|within\s+the\s+(?:hour|day|week|month)"
    r"|end\s+of\s+(?:the\s+)?(?:(?:business|working)\s+)?(?:day|week|month)"
    rf"|(?:by|before|until|no\s+later\s+than)\s+(?:(?:this|next)\s+)?{_WEEKDAY_EN}"
    r"|this\s+(?:week|month)|today|tonight|tomorrow"
    rf"|{_COUNT_ES}\s+{_UNIT_ES}"
    r"|(?:el\s+)?mismo\s+d[ií]a|(?:la\s+)?pr[oó]xima\s+semana|(?:el\s+)?pr[oó]ximo\s+mes"
    r"|(?:el\s+)?(?:siguiente|pr[oó]ximo)\s+d[ií]a(?:\s+h[aá]bil)?|d[ií]a\s+(?:h[aá]bil\s+)?siguiente"
    r"|dentro\s+de\s+la\s+(?:hora|semana)"
    rf"|(?:antes\s+del?|para\s+el|hasta\s+el)\s+{_WEEKDAY_ES}"
    r"|esta\s+semana|hoy|(?<!la\s)mañana)(?!\w)")
# Hours ("7 days a week", "24 hours a day", "open 24h", "de 9h a 18h", "Monday until Friday", "del lunes hasta el
# viernes") and how long a visit lasts (never "the last 30 days"), which no customer line holds as a time frame.
_NOT_TIME_FRAMES = re.compile(
    r"(?<!\w)(?:\w+\s+(?:hours?|days?)\s+a\s+(?:day|week)|24/7|open\s+24\s*(?:h|hrs?|hours?)"
    r"|\d+\s*h(?:\s+(?:a|al|to|until|till|hasta))?\s+\d+\s*h"
    rf"|{_WEEKDAY_EN}\s+(?:to|through|thru|until|till)\s+{_WEEKDAY_EN}"
    rf"|(?:de|del)\s+{_WEEKDAY_ES}\s+(?:a|al|hasta(?:\s+el)?)\s+{_WEEKDAY_ES}"
    r"|(?<!the\s)(?<!past\s)last(?:s|ing)?\s+(?:for\s+)?(?:about\s+|around\s+|up\s+to\s+)?"
    r"(?:a\s+few|a\s+couple(?:\s+of)?|\S+)\s+(?:(?:business|working)\s+)?"
    r"(?:minute|min|hour|hr|day|week|month)s?)(?!\w)")
TIME_FRAME_LINES = ("summary", "pricing", "intake", "urgent", "after_hours")
# A reply names a change only beside the pointer the rule for customer lines asks for, never by saying the words back.
LINES_POINTER = "what customers will read"


def _plain(text: str) -> str:
    return " ".join(text.casefold().replace("-", " ").replace("\u2019", "'").split())


def owner_time_frames(text: str) -> list[str]:
    """The time frames the owner's answer states, each once, lowercased without a leading article."""
    spans = OWNER_TIME_FRAME.findall(_NOT_TIME_FRAMES.sub(" ", _plain(text)))
    return list(dict.fromkeys(re.sub(r"^(?:the|el|la) ", "", span) for span in spans))


def _says(text: str, span: str) -> bool:
    return re.search(rf"(?<!\w){re.escape(span)}(?!\w)", _plain(text)) is not None


def owner_time_frame_errors(text: str, turn: SetupTurn, stored: Mapping[str, str] | None = None) -> list[str]:
    """The answer turn's retry line when it drafts a customer line and a time frame from the owner's answer `text` is
    in none of its customer lines nor the `stored` ones (by field) it leaves as they are, nor named in its reply as a
    change (with the pointer to What customers will read). A turn that drafts none has nothing to check."""
    drafted = {name: line for name in TIME_FRAME_LINES
               if isinstance(line := getattr(turn, name, None), str) and line.strip()}
    if not drafted:
        return []
    kept = [line for name, line in (stored or {}).items() if name not in drafted]
    lines, named = [*drafted.values(), *kept], LINES_POINTER in _plain(turn.reply)
    missing = [span for span in owner_time_frames(text)
               if not any(_says(line, span) for line in lines) and not (named and _says(turn.reply, span))]
    if not missing:
        return []
    logger.info("a setup turn left %d of the owner's time frames out of its lines and reply", len(missing))
    return [TIME_FRAME_UNACCOUNTED]


def _turn_time_left(interview: Interview) -> float:
    """An answer turn's model call's bound: `SETUP_TIMEOUT_S`, or less when the run's deadline is nearer, keeping
    `TURN_FINISH_S` for the turn to save, so a late retry is skipped and the first answer stands."""
    if interview.turn_deadline is None:
        return SETUP_TIMEOUT_S
    return min(SETUP_TIMEOUT_S, interview.turn_deadline - asyncio.get_running_loop().time() - TURN_FINISH_S)


def _hold_unless_kept(interview: Interview, answering: QuestionKey | None = None) -> None:
    """Show none of this turn's first reply on the owner's display when it could be hidden before it is saved: it
    reads untrusted text, and the topic code asks next by default is a limit question (`_TurnReplies.before`)."""
    display = current_display.get()
    if display is not None and answering not in LIMIT_CHOICES and _code_next(interview, answering) in LIMIT_CHOICES:
        display.hold()


def _unshow(text: str) -> None:
    """Take a reply that won't be saved as it is off the owner's display, if it is the one showing."""
    display = current_display.get()
    if display is not None:
        display.withdraw(text)


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
                    _unshow(reply.text)        # text already streamed clears at once (a reset), before anything else
                    # Keep coverage and hidden plan metadata; empty messages are omitted from the view.
                    reply.text = ""

    def answered(self, interview: Interview) -> bool:
        """Whether a reply of this answer already in the transcript says something; one `before` blanked doesn't."""
        return any(reply.text.strip() and any(entry is reply for entry in interview.transcript)
                   for reply, _ in self.entries)


async def _ensure_answerable(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview: Interview, *,
                             since: int, replies: _TurnReplies, key: QuestionKey | None = None,
                             follow_up=None) -> None:
    """Before saving, leave a fresh question, a waiting card, or a closed interview (the test-client offer may wait)."""
    if interview.step != "questions" or interview.pending_card is not None or interview.offering:
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
        await close_setup(owner, engine, model, interview, answered=replies.answered(interview))


async def _advance(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview: Interview,
                   source, reply: Entry, *, closing_call: bool = False, replies: _TurnReplies | None = None,
                   close: Close | None = None) -> None:
    """Choose the final ask before deciding which of this answer's replies can be stored beside it."""
    replies = replies if replies is not None else _TurnReplies()
    replies.track(reply)
    await _advance_ask(owner, engine, model, interview, source, reply, replies, closing_call=closing_call, close=close)
    asked = interview.latest_ask
    replies.before(asked.question if interview.step == "questions" and asked is not None else None)


async def _advance_ask(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview: Interview,
                       source, reply: Entry, replies: _TurnReplies, *, closing_call: bool = False,
                       close: Close | None = None) -> None:
    """Append exactly one ask or close: `close_setup`, unless the caller gives what closes instead (`close`).
    Metadata lives on this turn's Claude entry, never on a card."""
    if source is not None:
        interview.cover(source.skip)
    available = _record_plan(interview, source, reply)
    if interview.shows_cards and source is not None and source.next.kind == "connector":
        app = source.next.connector
        existing = [*interview.planned, *(entry.card for entry in interview.transcript if entry.card)]
        if app in get_args(ConnectorKey) and not any(card.connector and card.connector.app == app for card in existing):
            why = source.question.replace("**", "").replace("__", "").strip()[:200]   # the card shows plain text
            card = ProposalCard(proposal_id=new_proposal_id(), kind="connector", state="proposed", job=None,
                                connector=ConnectorProposal(app=app, label=CONNECTOR_LABELS[app], why=why,
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
            await _advance_ask(owner, engine, model, interview, following, entry, replies, closing_call=True,
                               close=close)
            return
        if close is not None:
            await close(owner, engine, model, interview)
        else:
            await close_setup(owner, engine, model, interview, answered=replies.answered(interview))


def _show_card(interview: Interview, card: ProposalCard) -> None:
    interview.transcript.append(Entry(role="claude", text="", card=card.model_copy(deep=True)))
    payment = bool((card.job and card.job.job == "payment") or
                   (card.connector and card.connector.app == "stripe"))
    if (payment and card.state in {"proposed", "accepted"} and not interview.answers.auto_money_cap_cents
            and not any(entry.role == "claude" and entry.text == PAYMENT_LINE for entry in interview.transcript)):
        interview.transcript.append(Entry(role="claude", text=PAYMENT_LINE))


def _record_plan(interview: Interview, source, reply: Entry) -> list[ProposalCard]:
    """Record additions and valid drops even on a follow-up; return only items available before this turn.

    Once "Change something" reopened the questions, the plan can also change what the owner accepted, through the
    cards that record it, and only by the plan's own `drop` (a job's kind is no identity: an owner can have several
    jobs of one kind, and a job added without a drop sits beside them). A drop naming an accepted job that the same
    call adds a job of its kind for is replaced by that job (`changed`), which waits for the owner's decision. A drop
    naming any other accepted job or connector changes it to a fresh copy of its card, which waits for the owner's
    decision and is available at once: a job the owner took isn't removed on Claude's word alone."""
    available = interview.unshown
    if source is not None:
        available_ids = {card.proposal_id for card in available}
        reply.dropped = list(dict.fromkeys(proposal_id for proposal_id in source.drop if proposal_id in available_ids))
        reply.planned = [card for draft in source.add_jobs if (card := _planned_job(interview, draft)) is not None]
        if interview.reopens:
            replacements = list(reply.planned)
            for proposal_id in dict.fromkeys(source.drop):
                kept = next((card for card in _accepted_cards(interview) if card.proposal_id == proposal_id), None)
                if kept is None:
                    continue
                added = next((card for card in replacements
                              if kept.job is not None and card.job is not None and card.job.job == kept.job.job), None)
                if added is not None:
                    replacements.remove(added)
                    _supersede(interview, kept.proposal_id, added.proposal_id)
                    continue
                again = kept.model_copy(deep=True, update={"proposal_id": new_proposal_id(), "state": "proposed"})
                if again.connector is not None:
                    again.connector.connected = False
                _supersede(interview, kept.proposal_id, again.proposal_id)
                reply.dropped.append(kept.proposal_id)        # so settling the copy is the owner's no (`settle_plan`)
                reply.planned.append(again)
                available.append(again)
    return available


def _accepted_cards(interview: Interview) -> list[ProposalCard]:
    """The plan's jobs and connectors the owner has: each card's current copy, accepted."""
    return [card for card in interview.planned if card.state == "accepted"]


def _supersede(interview: Interview, proposal_id: str, replacement: str) -> None:
    """Change every copy of card `proposal_id`, planned or shown, to a reference to card `replacement`."""
    for entry in interview.transcript:
        for card in [*entry.planned, *([entry.card] if entry.card is not None else [])]:
            if card.proposal_id == proposal_id:
                card.state = "changed"
                card.superseded_by = replacement


def _decide_typed(interview: Interview, proposal_id: str, accept: bool) -> bool:
    """Use the same validation as a card click; an unpriced payment still needs its amount."""
    try:
        apply_decision(interview, proposal_id, SetupProposalIn(accept=accept))
    except ApiProblem as failed:
        if failed.error == "amount_required":
            return False
        raise
    # The owner's own decision either way, as a click is (a typed no isn't code settling the card).
    entry = next(entry for entry in reversed(interview.transcript)
                 if entry.card is not None and entry.card.proposal_id == proposal_id)
    entry.owner_decided = True
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
    _hold_unless_kept(interview)
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
        if following.decision == "none":
            return
        if not _decide_typed(interview, proposal_id, following.decision == "accept"):
            _unshow(interview.transcript.pop().text)
            interview.transcript.append(Entry(role="claude", text=AMOUNT_FIRST_LINE))
            return
    await _advance(owner, engine, model, interview, following, reply)


async def answer(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview_id: str, question: SetupQuestion | None,
                 text: str, *, runs: TurnRuns, ro_schema: str, admit: Callable[[], Awaitable[None]],
                 card: str | None = None, cards: bool = False, business_tools_enabled: bool = False) -> SetupState:
    """Run a question or typed card answer through the shared turn runner; busy repeats do no work."""
    if (question is None) == (card is None):
        raise ApiProblem(422, "invalid_request")

    connect = False

    def check(interview: Interview) -> None:
        interview.business_tools_enabled = business_tools_enabled
        if card is not None:
            if card != interview.pending_card:
                raise ApiProblem(409, "conflict")
        elif interview.question is None or interview.question != question:
            raise ApiProblem(409, "conflict")

    def stage(interview: Interview) -> list[Entry]:
        return [Entry(role="owner", text=text)]

    async def run(ctx: OwnerCtx, interview: Interview, staged: list[Entry]) -> None:
        nonlocal connect
        interview.business_tools_enabled = business_tools_enabled
        if card is not None:
            if not interview.business_tools_enabled:
                _clear_configs(interview)
            await card_turn(ctx, engine, model, interview, card, text=text)
            connect = _claim_connector_connect(interview, None if interview.step == "tools" else card)
            return
        if question == TEST_CLIENT:
            await _answer_test_client(ctx, engine, model, interview, staged[0])
            if interview.step == "tools":
                connect = _claim_connector_connect(interview)
            return
        said, = staged
        await _question_turn(ctx, engine, model, interview, question, text, said)
        if interview.step == "tools":
            connect = _claim_connector_connect(interview)

    async def after(ctx: OwnerCtx, interview: Interview) -> None:
        if question == TEST_CLIENT:
            await _put_test_client(ctx, engine, interview)
        if connect:
            await _connect_accepted_connector(ctx, engine, interview)
        if interview.step == "tools":
            await publish_plan(ctx, engine, interview)

    return await run_turn(owner, engine, model, interview_id, runs=runs, ro_schema=ro_schema, admit=admit,
                          check=check, stage=stage, turn=run, after=after,
                          render=partial(setup_state, cards=cards, business_tools_enabled=business_tools_enabled))


async def _question_turn(ctx: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview: Interview,
                         key: QuestionKey, text: str, said: Entry) -> None:
    """The owner's answer `text` (stored as `said`, this run's staged entry) to question `key`, in its own turn
    model: the patch merged into the answers, Claude's reply, and the next ask or the close."""
    since = len(interview.transcript)
    desk_id = interview.desk_id
    # The questions still to ask for facts a change gave off their own questions, waiting on the one answered.
    waiting = list(interview.latest_ask.asks_after) if interview.latest_ask is not None else []
    _hold_unless_kept(interview, key)
    stored_lines = {name: line for name in TIME_FRAME_LINES
                    if isinstance(line := getattr(interview.answers, name, None), str)}
    turn = await structured(model, recorder(engine, ctx), SETUP_TURN_SYSTEM,
                            [_turn_message(interview, key, text, run_id=said.pending)], SETUP_TURNS[key], TURN_MAX_TOKENS,
                            problems=lambda drafted: owner_time_frame_errors(text, drafted, stored_lines),
                            timeout_s=lambda: _turn_time_left(interview), retry_min_s=UNDERSTAND_RETRY_MIN_S)
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
    site = website_url(getattr(turn, "website", ""))  # the contact question's model has none (`FIELD_TURNS`)
    if site is not None and site[0] not in interview.tried_websites():
        if interview.consent:
            entries.append(await _read_website(ctx, desk_id, *site))
        else:
            said.website = site[0]                   # kept as text: nothing is read without consent
    await _rename(ctx, desk_id, patch)
    backed = _backed_off_topic(patch, key, text, interview.answers)
    updated = merged(interview.answers, patch, key, owner_fields=interview.owner_fields, backed=backed)
    owner_text = "\n".join(entry.text for entry in interview.transcript if entry.role == "owner")
    said.owner_fields = _owner_patch_fields(patch, key, interview.answers, updated, owner_text, backed=backed)
    for name in _fact_patch_fields(patch, key):
        if name not in FACT_HOMES:
            continue
        if name in said.owner_fields:
            updated.suggested_fields = [field for field in updated.suggested_fields if field != name]
        elif getattr(interview.answers, name) == getattr(updated, name):
            continue
        elif name not in updated.suggested_fields:
            updated.suggested_fields.append(name)
    # Once "Change something" reopened the questions, a change to a fact this question doesn't record, which
    # `merged` kept out of the answers (free text is never taken off its topic), is asked on the question that records
    # it, right after Claude's reply: the owner's words then land there instead of being dropped. Each such question
    # is asked in turn, the rest waiting on the one asked (`asks_after`), and the questions close only after the last.
    held = _held_off_topic(interview.answers, updated, patch, key) if interview.reopens else []
    homes = [home for home in dict.fromkeys([*held, *waiting]) if home != key]
    # The change's own turn may also name a topic covered before (a limit, say), which `_next_ask` would ask: it
    # waits after the facts' questions, asked in code's words, rather than being lost to them.
    proposed = getattr(turn, "next", None)
    if (held and interview.reopening and proposed is not None and proposed.kind == "topic"
            and proposed.topic in interview.covered and proposed.topic != key and proposed.topic not in homes):
        homes.append(proposed.topic)
    interview.answers = updated
    interview.transcript += entries
    if held or (turn.step_done and homes):
        if turn.step_done:
            interview.cover([key])
        if not any(entry is reply for entry in interview.transcript):
            interview.transcript.append(reply)
        # A limit question's turn has no plan of its own (its planning call is `_next_step`, skipped here).
        _record_plan(interview, turn if key not in LIMIT_CHOICES else None, reply)
        asked = _ask(interview, homes[0])
        asked.asks_after = homes[1:]
        replies.before(asked.question)
        interview.transcript.append(asked)
    elif turn.step_done:
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
    asked = interview.latest_ask
    if homes and not held and not turn.step_done and asked is not None and asked.question == key:
        asked.asks_after = homes             # a follow-up on this question: the rest still wait on it


# "Change something": the chat again, from a later step ------------------------------------------------------------

# The steps "Change something" reopens the chat from. A live Desk is changed in the owner app instead.
REOPEN_STEPS: tuple[SetupStep, ...] = ("tools", "rules", "situations", "safety_check", "preview")
# The question the owner's change answers: a fact question that reads the answers so far, the plan and the memory and
# website, and whose turn records hours, the contact, what happens after hours and what's urgent. A change that
# belongs to another topic (a limit, say) is asked there next: Claude names it, and code asks it again
# (`_next_ask`), a limit in code's own words with its choices, so a limit still comes only from its own question.
REOPEN_TOPIC: QuestionKey = "contact_and_after_hours"


def reopen_sha256(text: str) -> str:
    """The sha256 of a reopen's canonical body, its key left out: what a repeat with the key must match."""
    return body_sha256({"text": text})


def _reopened_by(interview: Interview, key: str) -> Entry | None:
    return next((entry for entry in interview.transcript if entry.reopen_key == key), None)


async def reopen(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview_id: str, text: str, key: str, *,
                 runs: TurnRuns, ro_schema: str, admit: Callable[[], Awaitable[None]],
                 cards: bool = False, business_tools_enabled: bool = False) -> SetupState:
    """"Change something": back to the questions from a later step (`REOPEN_STEPS`), with `text` as the owner's next
    turn, run through the shared turn runner as an answer is. The turn moves the interview to `questions`, drops the
    rules draft (its cards and version; the situations and the safety check were tried against it), then answers the
    owner on `REOPEN_TOPIC`, behind a code ask the owner isn't shown. Nothing changes until the turn lands: a failed
    or abandoned turn removes the owner's message and leaves the interview at its step.

    Idempotent per send by `key`, kept on the owner's message with its body's hash: a repeat answers the interview as
    it stands, and the same key with other text is 409 `conflict`. Another send is 409 `conflict` while a turn runs,
    at the questions step and once the Desk is live."""
    request_sha256 = reopen_sha256(text)
    render = partial(setup_state, cards=cards, business_tools_enabled=business_tools_enabled)
    interview = await _recover_turn(owner, engine, interview_id, runs)
    first = _reopened_by(interview, key)
    if first is not None:
        if first.reopen_sha256 != request_sha256:
            raise ApiProblem(409, "conflict")
        interview.business_tools_enabled = business_tools_enabled
        return render(interview, await _slug(owner, owner.desk(interview.desk_id)))
    if interview.busy or interview_id in _RUNNING or interview_id in _TRANSITIONS:
        raise ApiProblem(409, "conflict")
    connect = False

    def check(interview: Interview) -> None:
        interview.business_tools_enabled = business_tools_enabled
        if interview.step not in REOPEN_STEPS or _reopened_by(interview, key) is not None:
            raise ApiProblem(409, "conflict")

    def stage(interview: Interview) -> list[Entry]:
        return [Entry(role="owner", text=text, reopen_key=key, reopen_sha256=request_sha256)]

    async def turn(ctx: OwnerCtx, interview: Interview, staged: list[Entry]) -> None:
        nonlocal connect
        interview.business_tools_enabled = business_tools_enabled
        said, = staged
        interview.step = "questions"
        interview.draft_cards, interview.draft_version = [], None
        # The question the change answers, before the owner's words; its empty text shows nothing.
        at = next(index for index, entry in enumerate(interview.transcript) if entry is said)
        interview.transcript.insert(at, Entry(role="claude", text="", question=REOPEN_TOPIC))
        await _question_turn(ctx, engine, model, interview, REOPEN_TOPIC, text, said)
        if interview.step == "tools":
            connect = _claim_connector_connect(interview)

    async def after(ctx: OwnerCtx, interview: Interview) -> None:
        if connect:
            await _connect_accepted_connector(ctx, engine, interview)
        if interview.step == "tools":
            await publish_plan(ctx, engine, interview)

    return await run_turn(owner, engine, model, interview_id, runs=runs, ro_schema=ro_schema, admit=admit,
                          check=check, stage=stage, turn=turn, after=after, render=render)


# Finish ------------------------------------------------------------------------------------------------------

def _unpriced_payment(job: JobProposal | None) -> bool:
    return (job is not None and job.job == "payment"
            and (not isinstance(job.config, PurposePaymentProposalConfig) or (job.config.amount_cents or 0) < 1))


def settle_plan(interview: Interview) -> None:
    """Settle the remaining plan and emit each never-shown card once, without I/O. A card shown again because the plan
    dropped what the owner had accepted (`_record_plan`) settles as declined: the owner asked to drop it, so Claude's
    suggestions never take it back."""
    # Changed cards and their superseded_by links stay intact; only proposed replacements can settle.
    pending = interview.pending_card
    dropped = interview.dropped
    asked_to_drop = {card.superseded_by for entry in interview.transcript
                     for card in [*entry.planned, *([entry.card] if entry.card is not None else [])]
                     if card.proposal_id in dropped and card.superseded_by is not None}

    def settled(card: ProposalCard) -> str:
        return "declined" if _unpriced_payment(card.job) or card.proposal_id in asked_to_drop else "accepted"

    for card in interview.unshown:
        card.state = settled(card)
        _show_card(interview, card)
    if pending is not None:
        card = next(entry.card for entry in reversed(interview.transcript)
                    if entry.card is not None and entry.card.proposal_id == pending)
        card.state = settled(card)
    # Stored interviews may contain earlier acceptances that bypassed the amount check. Code voids such a yes, so it is
    # no longer the owner's decision: the setup plan says the job was left out for want of an amount (`_setup_plan`).
    # Which yeses code voids is read from each card's latest shown copy, as `_setup_plan` reads it, so an older copy
    # can't clear a newer decision on the same card.
    latest = {entry.card.proposal_id: entry.card for entry in interview.transcript if entry.card is not None}
    voided = {proposal_id for proposal_id, card in latest.items()
              if card.state == "accepted" and _unpriced_payment(card.job)}
    for entry in interview.transcript:
        for card in [*entry.planned, *([entry.card] if entry.card is not None else [])]:
            if card.state == "accepted" and _unpriced_payment(card.job):
                card.state = "declined"
            if card.state == "accepted" and card.connector is not None and card.connector.app != "stripe":
                card.connector.connected = True
    for entry in interview.transcript:
        if entry.card is not None and entry.card.proposal_id in voided:
            entry.owner_decided = False


async def close_setup(owner, engine, model, interview: Interview, *, answered: bool = False) -> None:
    """Settle cards, end with the closing plan (or a fixed line without one), then finish, and offer to add the owner as
    a test client when they typed their own contact (`_offer_test_client`): setup then waits on that answer.

    The closing call's own reply comes before the plan unless `answered`: a reply of this run already answered the
    owner (`_TurnReplies.answered`), so it would say the same again. A run shows only its first call's text, so a
    closing reply left out this way was never on the owner's display.

    While the offer waits, the plan is closed already: closing again ("Use your suggestions") moves on to the Tools
    step without another plan and writes nothing. A plan an answer to the offer reopened (`_consult_on_offer`) closes
    as the first time did: settling its cards and finishing again change only what its new jobs add, and the offer is
    asked again. The caller owns persistence and after_finish.
    """
    if interview.offering:
        interview.step = "tools"
        return
    for entry in interview.transcript:
        entry.asks_after = []                # closing ("Use your suggestions", say) asks no fact a change left
    settle_plan(interview)
    plan = ""
    for attempt in range(2):
        closing = await _next_step(owner, engine, model, interview, closing=True)
        if closing is None:
            break
        plan = closing.plan.strip()
        if plan or attempt == 1:
            if closing.reply.strip() and not answered:
                interview.transcript.append(Entry(role="claude", text=closing.reply.strip()))
            if plan:
                interview.transcript.append(Entry(role="claude", text=plan))
            break
        if not answered:                      # else this call never showed: the display holds the earlier reply
            _unshow(closing.reply)            # asked again for a plan: this reply isn't kept
    if not plan:
        interview.transcript.append(Entry(role="claude", text=QUESTIONS_DONE))
    finish(interview)
    _offer_test_client(interview)


def accepted_jobs(interview: Interview) -> list[JobProposal]:
    return [card.job for card in interview.planned
            if card.state == "accepted" and card.job is not None and not _unpriced_payment(card.job)]


def owner_job_answers(interview: Interview) -> list[dict[str, object]]:
    """Only explicit card decisions supply job data to rules drafting."""
    answers = []
    for entry in interview.transcript:
        card = entry.card
        if (not entry.owner_decided or card is None or card.state != "accepted" or card.job is None
                or _unpriced_payment(card.job)):
            continue
        job = card.job
        answer = {"job": job.job, "title": job.title, "autonomy": job.autonomy}
        if isinstance(job.config, PurposePaymentProposalConfig) and job.config.amount_cents is not None:
            answer["amount_cents"] = job.config.amount_cents
        answers.append(answer)
    return answers


def finish(interview: Interview) -> None:
    """Project the settled plan and cover unanswered topics at safe defaults, without I/O."""
    remaining = set(QUESTION_KEYS) - interview.covered
    suggested = interview.suggested
    if suggested is not None:
        # A suggestion fills a fact still empty and never the owner's when a question that asks for it went unanswered,
        # merged as the first such question's turn takes it (some facts are fields only of certain turns,
        # `FIELD_TURNS`). Only a fact has a topic, so a limit a stored suggestion somehow carried never fills.
        fills = {name: value for name, value in suggested
                 if any(_on_topic(name, key) for key in remaining) and name not in interview.owner_fields
                 and value and not getattr(interview.answers, name)}
        suggested_fields = interview.answers.suggested_fields + sorted(fills)
        for name, value in fills.items():
            key = next(key for key in QUESTION_KEYS if key in remaining and _on_topic(name, key))
            interview.answers = merged(interview.answers, SetupPatch.model_validate({name: value}), key)
        interview.answers.suggested_fields = list(dict.fromkeys(suggested_fields))
    interview.cover(remaining)
    included = []
    used = 0
    seen = set()
    skipped = 0
    for job in accepted_jobs(interview):
        if not job.can_do_today:
            continue
        how = " ".join(job.how.split())
        if how in seen or re.search(r"\d|\bfree\b", how, re.IGNORECASE):
            skipped += 1
            continue
        seen.add(how)
        needed = len(how) + bool(included)
        if how and used + needed <= 1500:
            included.append(how)
            used += needed
    if skipped:
        logger.warning("setup skipped %d job descriptions", skipped)
    interview.answers.how_we_help = "\n".join(included) or None
    interview.step = "tools"


# The test client -------------------------------------------------------------------------------------------------

# A phone number as the kernel keeps one on record: digits, brackets, dots, dashes and a leading "+", with single spaces
# only before a digit or a bracket, so a number never runs on into the words or hours after it.
_TYPED_PHONE = re.compile(r"(?<![\w+(])\+?\(?\d(?:[\d().-]|\s(?=[\d(]))*\d(?!\w)")
# A phone's last group of one or two digits after a longer group, which is the start of something else ("… 0142 9").
_TRAILING_GROUP = re.compile(r"(.*\d{3})[\s(]+\d{1,2}")
# Hours and times, which are never part of a phone: a range ("9-5", "9 to 5", "8.00-17.00", "9am-5pm", "9 a 5"), a
# time ("9am", "17:00") and "24/7".
_HOUR = r"(?:[01]?\d|2[0-4])(?:[:.][0-5]\d)?(?:\s*[ap]\.?m\b\.?)?"
_TIMES = re.compile(rf"(?<![\w.+-])(?:{_HOUR}\s*(?:-|–|—|\bto\b|\buntil\b|\btill\b|\ba\b|\bhasta\b)\s*{_HOUR}"
                    r"|24\s*/\s*7|(?:[01]?\d|2[0-4])(?:[:.][0-5]\d)?\s*[ap]\.?m\b\.?|(?:[01]?\d|2[0-4]):[0-5]\d)"
                    r"(?![\w-]|[.:]\d)", re.IGNORECASE)
CONTACT_ON_RECORD_MAX = 120        # the most characters the kernel keeps for a contact on record
# A contact answer's sentences end at ".", ";", "!", "?" or a new line (a dot inside an address doesn't end one).
_SENTENCE_END = re.compile(r"[;!?\n]|\.(?=\s|$)")
# The words just before a contact, in its clause, that tell whose it is: one the owner rejects, one they mark as their
# own, and one of another person's (by role; a name is checked against the owner's own, `_contact_names`).
_REJECTED = re.compile(r"\b(?:not|don't|do not|no longer|old|instead of|no|ya no|antiguo|antigua|en vez de)\b")
_OWNERS = re.compile(r"\b(?:my own|my email|my e-mail|my phone|my number|my cell|my mobile|me at|me on|reach me|"
                     r"mine is|email me|call me|text me|mi correo|mi teléfono|mi telefono|mi número|mi numero|"
                     r"mi celular|el mío|el mio)\b")
_SOMEONE_ELSE = re.compile(r"\b(?:assistant|partner|colleague|co-?worker|receptionist|secretary|manager|wife|husband|"
                           r"daughter|brother|sister|team|staff|employee|asistente|socio|socia|secretari[ao]|"
                           r"recepcionista|espos[ao]|marido|hij[ao]|herman[ao]|equipo|gerente)\b")
# A name just before a contact ("Ana at …", "Mike: …"), a possessive name ("Ana's email is …"), and the capitalized
# words that are never a person's name.
_NAMED = re.compile(r"([^\W\d_][^\W\d_'-]*)\s*(?::|-|–|\bat\b|\bon\b|\bal\b|\ben\b|\bis\b|\bes\b)?\s*$")
_POSSESSIVE = re.compile(r"([^\W\d_][^\W\d_-]*)'s\b")
_NOT_NAMES = _CONTACT_LABEL_WORDS | frozenset({
    "my", "me", "contact", "contacts", "customers", "clients", "reach", "use", "write", "message", "us", "our", "the",
    "for", "please", "bookings", "booking", "sales", "orders", "support", "info", "hello", "emergencies", "emergency",
    "urgent", "after", "hours", "business", "ask", "just", "then", "otherwise", "also", "contacto", "clientes",
    "cliente", "escríbeme", "llámame", "llama", "escribe", "reservas", "urgencias", "para", "por", "favor", "mi",
})


@dataclass
class _Contact:
    """A contact the owner typed, with what its clauses said about it across their answers."""

    value: str
    email: bool
    rejected: bool = False
    someone_elses: bool = False
    marked: bool = False


def _contact_names(interview: Interview) -> tuple[frozenset[str], frozenset[str]]:
    """The owner's name's words, and the words that are no other person's name: labels and the business's name."""
    def words(text: str | None) -> frozenset[str]:
        return frozenset(re.findall(r"[^\W\d_]+", (text or "").casefold()))
    return words(interview.answers.owner_display_name), _NOT_NAMES | words(interview.answers.business_name)


def _contacts_in(text: str) -> list[tuple[int, int, str, bool]]:
    """Each email address and phone number in `text`, in order: (start, end, as written, whether an email). A phone is
    one number of 7 to 15 digits, outside any web address and without the hours or times beside it."""
    found = []
    for match in _CONTACT_ADDRESS.finditer(text):
        address = match.group().rstrip(".,;:!?)]}")
        if "@" in address and "/" not in address and len(address) <= CONTACT_ON_RECORD_MAX:
            found.append((match.start(), match.start() + len(address), address, True))

    def blank(match: re.Match[str]) -> str:
        return " " * len(match.group())

    rest = _TIMES.sub(blank, _CONTACT_DOMAIN.sub(blank, _CONTACT_ADDRESS.sub(blank, text)))
    for match in _TYPED_PHONE.finditer(rest):
        phone = match.group()
        if (shorter := _TRAILING_GROUP.fullmatch(phone)) is not None:
            phone = shorter.group(1)
        phone = phone.rstrip(" (.-")
        if 7 <= len(re.sub(r"\D", "", phone)) <= 15:
            found.append((match.start(), match.start() + len(phone), phone, False))
    return sorted(found)


def _whose(words: str, owner_words: frozenset[str], not_names: frozenset[str]) -> str | None:
    """What the words before a contact say about whose it is, by the marker closest to it: "owner" for the owner's own
    ("my email", "reach me", "mi correo", their own name in front or as a possessive …), "rejected" for one they reject
    ("not", "no longer", "old", "instead of", "ya no" …), "other" for another person's (a role such as "my assistant",
    or another name in front, "Ana at …", "Ana: …", or as a possessive, "Ana's email is …"); None when they say
    nothing of it."""
    folded = words.casefold()
    closest: dict[str, int] = {}

    def note(kind: str, at: int) -> None:
        closest[kind] = max(closest.get(kind, -1), at)

    for pattern, kind in ((_REJECTED, "rejected"), (_OWNERS, "owner"), (_SOMEONE_ELSE, "other")):
        for match in pattern.finditer(folded):
            note(kind, match.end())
    names = [(match.group(1), match.end()) for match in _POSSESSIVE.finditer(words)]
    if (named := _NAMED.search(words)) is not None:
        names.append((named.group(1), named.end()))
    for name, at in names:
        if not name[0].isupper():
            continue
        if name.casefold() in owner_words:
            note("owner", at)
        elif name.casefold() not in not_names:
            note("other", at)
    return max(closest, key=lambda kind: closest[kind]) if closest else None


def _owner_contact(interview: Interview) -> str | None:
    """The contact the owner gave as theirs, from their own answers to the contact question
    (`contact_and_after_hours`): never the public contact the turn's model wrote, which the website or memory may have
    suggested, and never one typed on another question. Of every email and phone they typed there (`_contacts_in`),
    one they reject or give as another person's (`_whose`) never counts, and that carries on to every contact after it
    in its sentence ("Do not use a@… or b@…", "my assistant Ana at 510-… or ana@…") until the owner marks one as their
    own. Of the rest, those they mark as their own come first: the one email among them, else the one phone. Two
    emails, or two phones with no email, that nothing tells apart make no contact, so no offer."""
    owner_words, not_names = _contact_names(interview)
    contacts: dict[str, _Contact] = {}
    asked: str | None = None
    for entry in interview.transcript:
        if entry.role == "claude" and (entry.question is not None or entry.card is not None):
            asked = entry.question
            continue
        if entry.role != "owner" or asked != "contact_and_after_hours":
            continue
        text = entry.text.replace("\u2019", "'")
        sentence_ends = [match.end() for match in _SENTENCE_END.finditer(text)]
        sentence, carried, previous = -1, None, 0
        for start, end, value, email in _contacts_in(text):
            begins = max([0, *(stop for stop in sentence_ends if stop <= start)])
            if begins != sentence:
                sentence, carried, previous = begins, None, begins
            said = _whose(text[previous:start], owner_words, not_names)
            previous = end
            if said is not None:
                carried = None if said == "owner" else said
            key = value.casefold() if email else re.sub(r"\D", "", value)
            contact = contacts.setdefault(key, _Contact(value=value, email=email))
            contact.value = value
            if carried == "rejected":
                contact.rejected = True
            elif carried == "other":
                contact.someone_elses = True
            elif said == "owner":
                contact.marked = True
    kept = [contact for contact in contacts.values() if not contact.rejected and not contact.someone_elses]
    pool = [contact for contact in kept if contact.marked] or kept
    emails = [contact.value for contact in pool if contact.email]
    phones = [contact.value for contact in pool if not contact.email]
    if emails:
        return emails[0] if len(emails) == 1 else None
    return phones[0] if len(phones) == 1 else None


def _ask_test_client(interview: Interview) -> None:
    """The test-client offer, with code's two choices, as the question setup waits on."""
    interview.transcript.append(Entry(role="claude", text=TEST_CLIENT_OFFER, question=TEST_CLIENT, choices=[
        Choice(text=TEST_CLIENT_YES, recommended=True), Choice(text=TEST_CLIENT_NO, recommended=False)]))
    interview.step = "questions"


def _offer_test_client(interview: Interview) -> None:
    """Once the plan is closed, offer to put the owner on record as a test client, only when they typed their own
    contact (`_owner_contact`) and haven't answered the offer with a yes or a no (`_test_client_answered`): an answer
    that was neither can reopen the plan (`_consult_on_offer`), and closing it again asks once more. Setup then waits
    on the answer (`_answer_test_client`) before its Tools step."""
    if _owner_contact(interview) is None or _test_client_answered(interview):
        return
    _ask_test_client(interview)


def _test_client_answered(interview: Interview) -> bool:
    """Whether the owner answered the test-client offer with a yes or a no (`_reads_yes`): an owner line typed while
    the offer was the question waiting, whatever came after it."""
    asked = None
    for entry in interview.transcript:
        if entry.role == "claude" and (entry.question is not None or entry.card is not None):
            asked = entry.question
        elif entry.role == "owner" and asked == TEST_CLIENT and _reads_yes(entry.text) is not None:
            return True
    return False


def _reads_yes(text: str) -> bool | None:
    """The owner's answer to the test-client offer, read word by word by code alone. A yes or a no is read only from a
    short plain answer; anything longer, or with a request or a condition, is neither, and goes to setup's consultant.
    None when it has more than `TEST_CLIENT_MAX_WORDS` words, leaving out the offer's own (`TEST_CLIENT_NAMED`, so
    "Sure, go ahead and add me as a test client" is short); asks something or says yes only on a condition
    (`TEST_CLIENT_UNCLEAR`, so "What does add me as a test client mean?" and "What happens if I say yes?" are
    neither); asks for something besides the offer (`TEST_CLIENT_REQUEST`, so "Sí, cambia el horario" and "Not now,
    connect Google Calendar first" are neither); or goes on after its yes or no (`TEST_CLIENT_CONJOINED`, so "Yes
    please, and take retainer payments" is neither, but "No, but thanks" is a no). Else False when it has a "no" word
    or phrase (`TEST_CLIENT_TYPED_NO`, so "Not now" and "don't add me" are no); else True when it has a "yes" one
    (`TEST_CLIENT_TYPED_YES`, so "Add me as a test client" and "Sure, go ahead" are yes); else None."""
    plain = text.replace("\u2019", "'")
    words = TEST_CLIENT_WORD.findall(plain.casefold())
    counted = TEST_CLIENT_WORD.findall(TEST_CLIENT_NAMED.sub(" ", plain))
    if (len(counted) > TEST_CLIENT_MAX_WORDS or TEST_CLIENT_UNCLEAR.search(plain) or TEST_CLIENT_REQUEST.search(plain)
            or TEST_CLIENT_CONJOINED.match(plain)
            or (TEST_CLIENT_SI.search(plain) and not TEST_CLIENT_SI_ALONE.match(plain))):
        return None
    said = " {} ".format(" ".join(words))
    if any(f" {phrase} " in said for phrase in TEST_CLIENT_TYPED_NO):
        return False
    if any(f" {phrase} " in said for phrase in TEST_CLIENT_TYPED_YES):
        return True
    return None


async def _answer_test_client(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview: Interview,
                              said: Entry) -> None:
    """The owner's answer to the test-client offer (`said`), read by code (`_reads_yes`). A yes or a no makes no model
    call and moves setup on to its Tools step; anything else goes to setup's consultant (`_consult_on_offer`). A yes,
    with a contact the owner typed (`_owner_contact`), is marked on their answer, which the turn saves before anyone
    is put on record (`_put_test_client`, after the save); a no writes nothing and adds no line."""
    answer = _reads_yes(said.text)
    if answer is None:
        await _consult_on_offer(owner, engine, model, interview)
        return
    if answer and _owner_contact(interview) is not None:
        said.test_client = "yes"
    interview.step = "tools"


async def _consult_on_offer(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview: Interview) -> None:
    """An answer to the test-client offer that is neither a yes nor a no, such as a request for another job or a
    question, goes to setup's consultant in one planning call (`_next_step`, which reads the owner's words as their
    answer), and Claude's reply is kept. What the call adds to or drops from the plan is recorded as on any planning
    turn (`_advance`). When it leaves something new to show (a job it added, which the next planning call shows, or an
    app it names), the plan reopens on that card before the Tools step; deciding the last card, or "Use your
    suggestions", closes it again (`close_setup`), which asks the offer again. With nothing new to show, or with
    Claude unavailable, the offer is asked again at once. A client without cards keeps no job the call adds: no card
    could show it, and the plan won't close again to settle it."""
    following = await _next_step(owner, engine, model, interview)
    if following is None:
        _ask_test_client(interview)
        return
    if not interview.shows_cards:
        following = following.model_copy(update={"add_jobs": []})
    reply = Entry(role="claude", text=following.reply.strip())
    interview.transcript.append(reply)
    await _advance(owner, engine, model, interview, following, reply, close=_offer_again)


async def _offer_again(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview: Interview) -> None:
    """Close a planning turn on the test-client offer with nothing new to show: the plan stays closed as it was, and
    the offer is asked again."""
    _ask_test_client(interview)


def _record_test_client(interview: Interview) -> bool:
    """Mark the owner's saved yes as done, with `TEST_CLIENT_ADDED` right after it; False when no yes waits on it."""
    entries = interview.transcript
    index = next((index for index in range(len(entries) - 1, -1, -1) if entries[index].test_client == "yes"), None)
    if index is None:
        return False
    entries[index].test_client = "added"
    entries.insert(index + 1, Entry(role="claude", text=TEST_CLIENT_ADDED))
    return True


async def _put_test_client(owner: OwnerCtx, engine: AsyncEngine, interview: Interview) -> None:
    """After the owner's yes to the test-client offer is saved, put them on record as a client
    (`PUT /desks/{id}/people`, ref `TEST_CLIENT_REF`, which makes a repeat the same person), in their display name and
    with the contact they typed (`_owner_contact`), then save `TEST_CLIENT_ADDED` (`_record_test_client`), retrying
    once on a conflict. It is a person on record and nothing else: no limit, rule, fact, document or public line.
    Nothing runs once the yes is marked done, and a failure never stops setup: it is logged by type, never with the
    contact, and Claude says nothing."""
    contact = _owner_contact(interview)
    if contact is None or not any(entry.test_client == "yes" for entry in interview.transcript):
        return
    try:
        desk_id = owner.desk(interview.desk_id)
        business = await _business(owner, desk_id)
        await owner.kernel.call("PUT /desks/{id}/people", DeskPeopleRequest(upsert=[PersonUpsert(
            ref=TEST_CLIENT_REF, display_name=business["owner_display_name"], contact=contact)]),
            path={"id": desk_id})
    except Exception as failed:
        logger.warning("setup couldn't add the owner as a test client (%s)", type(failed).__name__)
        return
    for attempt in range(2):
        try:
            current = await _read(engine, owner, interview.interview_id)
            seen = _stored(current)
            current.business_tools_enabled = interview.business_tools_enabled
            if not _record_test_client(current):
                return
            await _commit(engine, owner, current, seen)
        except Exception as failed:
            if isinstance(failed, ApiProblem) and failed.status == 409 and failed.error == "conflict" and attempt == 0:
                continue
            logger.warning("setup couldn't save that the owner is a test client (%s)", type(failed).__name__)
            return
        _record_test_client(interview)
        return


async def _put_business_tools(owner: OwnerCtx, desk_id: str, accepted_jobs: list[JobProposal]) -> None:
    """Publish accepted configurations as one batch for the owner's tool review. When the kernel refuses the batch
    and names some of its tools, publish it once more without them; any other refusal is raised. An empty batch goes
    out only while the Desk has business tools from before (a change that dropped every job): it takes them away."""
    tools = []
    used = set()
    configured = [job for job in accepted_jobs if job.config is not None]
    if len(configured) > 8:
        logger.warning("%s accepted setup jobs with configurations were left out of the business tools batch",
                       len(configured) - 8)
    for job in configured[:8]:
        slug = item_slug(job.title)
        slug = re.sub(r"^[^a-z]+", "", slug) or job.config.block.replace("_", "-")
        slug = slug[:40].rstrip("-")
        name, number = slug, 2
        while name in used:
            suffix = f"-{number}"
            name = slug[:40 - len(suffix)].rstrip("-") + suffix
            number += 1
        used.add(name)
        tools.append({"tool": f"desk.{name}", "title": job.title[:60],
                      "description": " ".join(job.how.split())[:300],
                      "config": job.config.model_dump(mode="json")})
    if not tools and all(row["status"] == "disabled"
                         for row in await owner.ro.rows("tools", desk_id=desk_id, source="business")):
        return
    try:
        await owner.kernel.call("PUT /desks/{id}/business_tools",
                                BusinessToolsRequest.model_validate({"tools": tools}), path={"id": desk_id})
    except KernelFailed as failed:
        # A refusal's detail is keyed "<tool>.<field>", and a tool's name has dots of its own.
        refused = {tool["tool"] for tool in tools if failed.status == 422
                   and any(key.startswith(tool["tool"] + ".") for key in failed.detail or {})}
        if not refused or len(refused) == len(tools):
            raise
        logger.warning("%s setup business tools were refused; retrying without them", len(refused))
        kept = [tool for tool in tools if tool["tool"] not in refused]
        await owner.kernel.call("PUT /desks/{id}/business_tools",
                                BusinessToolsRequest.model_validate({"tools": kept}), path={"id": desk_id})


def _claim_connector_connect(interview: Interview, proposal_id: str | None = None) -> bool:
    """Reserve one real Stripe attempt before committing; other accepted apps are simulated."""
    if any(entry.connector_connect_attempted for entry in interview.transcript):
        return False
    seen = set()
    for entry in reversed(interview.transcript):
        card = entry.card
        if card is None or card.proposal_id in seen:
            continue
        seen.add(card.proposal_id)
        if ((proposal_id is None or card.proposal_id == proposal_id) and card.state == "accepted"
                and card.connector is not None and card.connector.app == "stripe"
                and card.superseded_by is None and card.proposal_id not in interview.dropped):
            entry.connector_connect_attempted = True
            return True
    return False


def _mark_stripe_connected(interview: Interview, proposal_ids: set[str]) -> None:
    for entry in interview.transcript:
        for card in [*entry.planned, *([entry.card] if entry.card is not None else [])]:
            if (card.proposal_id in proposal_ids and card.state == "accepted"
                    and card.connector is not None and card.connector.app == "stripe"):
                card.connector.connected = True


async def _connect_accepted_connector(owner: OwnerCtx, engine: AsyncEngine, interview: Interview) -> None:
    """Connect after the decision commit; failures leave the Tools step's Connect available."""
    try:
        await connect_payments(owner, owner.desk(interview.desk_id))
    except Exception as failed:
        logger.warning("a setup payments connection failed (%s)", type(failed).__name__)
        return
    for attempt in range(2):
        try:
            current = await _read(engine, owner, interview.interview_id)
            seen = _stored(current)
            current.business_tools_enabled = interview.business_tools_enabled
            cards = {card.proposal_id: card for card in current.planned}
            cards.update((entry.card.proposal_id, entry.card) for entry in current.transcript if entry.card)
            accepted = {card.proposal_id for card in cards.values()
                        if card.state == "accepted" and card.connector is not None
                        and card.connector.app == "stripe" and card.superseded_by is None
                        and card.proposal_id not in current.dropped}
            _mark_stripe_connected(current, accepted)
            await _commit(engine, owner, current, seen)
        except Exception as failed:
            if isinstance(failed, ApiProblem) and failed.status == 409 and failed.error == "conflict" and attempt == 0:
                continue
            logger.warning("a setup payments connection result couldn't be saved (%s)", type(failed).__name__)
            return
        _mark_stripe_connected(interview, accepted)
        return


def _removed_payments(interview: Interview) -> set[str]:
    """The Stripe cards the owner had connected that a change took away (`changed`, with no Stripe card accepted now):
    their payment tools are still on in the kernel until switched off (`_switch_off_payments`), which marks them no
    longer connected."""
    cards = {card.proposal_id: card for card in interview.planned}
    cards.update((entry.card.proposal_id, entry.card) for entry in interview.transcript if entry.card is not None)
    stripe = [card for card in cards.values() if card.connector is not None and card.connector.app == "stripe"]
    if any(card.state == "accepted" for card in stripe):
        return set()
    return {card.proposal_id for card in stripe if card.state == "changed" and card.connector.connected}


def _unmark_connected(interview: Interview, proposal_ids: set[str]) -> None:
    for entry in interview.transcript:
        for card in [*entry.planned, *([entry.card] if entry.card is not None else [])]:
            if card.proposal_id in proposal_ids and card.connector is not None:
                card.connector.connected = False


async def _switch_off_payments(owner: OwnerCtx, engine: AsyncEngine, interview: Interview) -> None:
    """Switch off the payment tools of a Stripe connection a change took away (`_removed_payments`), as the owner's
    review does (`POST /tools/confirm` with `enable=False`), then mark its cards no longer connected, so it happens
    once. A failure is raised: the Tools step's read tries again (`setup_tools`)."""
    removed = _removed_payments(interview)
    if not removed:
        return
    desk_id = owner.desk(interview.desk_id)
    on = [row for row in await owner.ro.rows("tools", desk_id=desk_id, order_by=("tool",))
          if row["tool"] in MCP_TOOLS and row["status"] != "disabled"]
    if owner.ro.conn.in_transaction():
        await owner.ro.conn.rollback()       # no read stays open while the kernel is asked
    if on:
        await confirm_tools(owner, ToolsConfirmRequest(desk_id=desk_id, enable=False, tools=[
            ToolPin(tool=row["tool"], definition_sha256=row["definition_sha256"]) for row in on]))
    for attempt in range(2):
        current = await _read(engine, owner, interview.interview_id)
        seen = _stored(current)
        current.business_tools_enabled = interview.business_tools_enabled
        _unmark_connected(current, removed)
        try:
            await _commit(engine, owner, current, seen)
        except ApiProblem as failed:
            if failed.status != 409 or failed.error != "conflict":
                raise
            if attempt == 0:
                continue
            # The tools are off; the mark waits for the next read, which finds none on and only writes it.
            logger.warning("setup couldn't mark removed payments switched off (conflict)")
            return
        break
    _unmark_connected(interview, removed)


async def publish_plan(owner: OwnerCtx, engine: AsyncEngine, interview: Interview) -> None:
    """Publish setup's settled plan after the commit that closed it: switch off the payment tools of a Stripe
    connection a change took away (a failure is logged, and the Tools step's read tries again), then write the
    business tools (`after_finish`)."""
    try:
        await _switch_off_payments(owner, engine, interview)
    except Exception as failed:
        logger.warning("setup couldn't switch off removed payment tools (%s); the Tools step tries again",
                       type(failed).__name__)
    await after_finish(owner, interview)


async def after_finish(owner: OwnerCtx, interview: Interview) -> None:
    """Apply enabled business tools after the setup commit, without a database lock."""
    if not interview.business_tools_enabled:
        return
    try:
        desk_id = owner.desk(interview.desk_id)
        await _put_business_tools(owner, desk_id, accepted_jobs(interview))
    except KernelFailed as failed:
        if failed.status == 404:
            logger.warning("setup business tools aren't available (404); keeping words only")
        elif failed.status == 422:
            logger.warning("the setup business tools batch was refused (%s); keeping words only", failed.code)
        else:
            logger.warning("a setup business tools write failed (%s %s)", failed.status, failed.code)
    except Exception as failed:
        logger.warning("a setup business tools write failed (%s)", type(failed).__name__)


async def use_suggestions(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview_id: str, *,
                           runs: TurnRuns, ro_schema: str, admit: Callable[[], Awaitable[None]],
                           cards: bool = False, business_tools_enabled: bool = False) -> SetupState:
    """Finish questions through the shared runner, retaining the signed owner button label."""
    connect = False

    def check(interview: Interview) -> None:
        interview.business_tools_enabled = business_tools_enabled
        if interview.step != "questions" or interview.consent is None:
            raise ApiProblem(409, "conflict")

    async def turn(ctx: OwnerCtx, interview: Interview, staged: list[Entry]) -> None:
        nonlocal connect
        interview.business_tools_enabled = business_tools_enabled
        if not business_tools_enabled:
            _clear_configs(interview)
        await close_setup(ctx, engine, model, interview)
        # With the test-client offer waiting, the Tools step and its post-finish work wait for its answer (`answer`).
        if interview.step == "tools":
            connect = _claim_connector_connect(interview)

    async def after(ctx: OwnerCtx, interview: Interview) -> None:
        if connect:
            await _connect_accepted_connector(ctx, engine, interview)
        if interview.step == "tools":
            await publish_plan(ctx, engine, interview)

    return await run_turn(owner, engine, model, interview_id, runs=runs, ro_schema=ro_schema, admit=admit,
                          check=check, stage=lambda interview: [Entry(role="owner", text="Use your suggestions")],
                          turn=turn, after=after,
                          render=partial(setup_state, cards=cards, business_tools_enabled=business_tools_enabled))


# Setup, part 2 (Task 7): the Desk's parts, rule cards, situations, the safety check and going live -----------------

RULE_STEPS: tuple[SetupStep, ...] = ("tools", "rules", "situations", "safety_check")
STEP_ORDER: tuple[SetupStep, ...] = ("questions", "tools", "rules", "situations", "safety_check", "preview", "live")
CARD_DRAFT_ROUTE, SITUATIONS_ROUTE = "card_draft", "situations"
CARD_DRAFT_MAX_TOKENS = 4096
SITUATIONS_MAX_TOKENS = 4096
ITEM_ID_MAX = 40
# The Ask me first preset's utility cards: in every setup draft, so slots, leads, callbacks, verification and the
# setup reads never fall to a default ask. Setup drafts no card of its own on these tools.
UTILITY_CARDS: tuple[RuleCard, ...] = tuple(PRESETS["ask_first"])
UTILITY_TOOLS = frozenset(card.applies_to for card in UTILITY_CARDS)
EFFECT_TARGETS = tuple(f"effect:{effect}" for effect in get_args(Effect))
MONEY_TARGETS = MONEY_TOOLS | {f"effect:{effect}" for effect in contracts.MONEY_EFFECTS}
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


async def interview_scope(owner: OwnerCtx, engine: AsyncEngine, interview_id: str) -> tuple[str, int]:
    """The Desk of the copy's interview `interview_id` (404 for any other), and how many times "Change something"
    reopened its questions (`Interview.reopens`): what its proving work is kept by."""
    async with engine.connect() as conn:
        interview = await _load(conn, owner.copy_id, interview_id)
    return owner.desk(interview.desk_id), interview.reopens


def _require_step(interview: Interview, steps: tuple[SetupStep, ...], *, drafted: bool = False) -> None:
    """409 `conflict` unless the interview is at one of `steps` (and, with `drafted`, has a rules draft)."""
    if interview.busy or interview.step not in steps or (drafted and interview.draft_version is None):
        raise ApiProblem(409, "conflict")


def _later(step: SetupStep, than: SetupStep) -> SetupStep:
    return max(step, than, key=STEP_ORDER.index)


async def _update(engine: AsyncEngine, owner: OwnerCtx, interview_id: str,
                  change: Callable[[Interview], None], *, reopens: int | None = None,
                  version: int | None = None, steps: tuple[SetupStep, ...] | None = None) -> Interview:
    """Apply `change` to the interview under its row lock and save it, in one transaction. With `reopens` (what the
    work read), 409 `conflict` with nothing saved once "Change something" has reopened the questions since: what the
    work drafted or tried was about the answers before. So too with `version` (the rules draft the work read) once the
    draft is another, and with `steps` once the interview has left them."""
    async with engine.connect() as conn, conn.begin():
        interview = await _load(conn, owner.copy_id, interview_id, lock=True)
        if ((reopens is not None and interview.reopens != reopens)
                or (version is not None and interview.draft_version != version)
                or (steps is not None and interview.step not in steps)):
            raise ApiProblem(409, "conflict")
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


PUBLIC_LINE_KEYS = {
    "summary": "policy:about",
    "public_contact": "contact",
    "pricing": "policy:pricing",
    "intake": "policy:intake",
    "after_hours": "policy:after_hours",
    "urgent": "policy:urgent",
    "service_area": "policy:service_area",
    "how_we_help": "policy:how_we_help",
}
PUBLIC_PARTS_REPAIR_TIMEOUT_S = DEFAULT_TIMEOUT_S


class PublicLineProblem(Exception):
    def __init__(self, error: Literal["line_refused", "not_editable", "not_suggested"], *, key: str | None = None,
                 reason: list[str] | None = None):
        super().__init__(error)
        self.answer = SetupPublicLineError(error=error, key=key, reason=reason)


def _public_refusal_detail(failure: KernelFailed) -> dict[str, list[str]]:
    detail = failure.detail or {}
    if not isinstance(detail, dict) or any(
        not isinstance(key, str) or not isinstance(reasons, list)
        or any(not isinstance(code, str) for code in reasons)
        for key, reasons in detail.items()
    ):
        return {}
    return detail


def _line_refused(failure: KernelFailed, edited_key: str | None = None) -> PublicLineProblem:
    # Only known claim keys and machine reason codes leave this boundary; never claim text.
    detail = _public_refusal_detail(failure)
    if "charter" not in detail:
        keys = list(PUBLIC_LINE_KEYS.values())
        if edited_key in keys:
            keys = [edited_key, *[key for key in keys if key != edited_key]]
        for key in keys:
            if key in detail:
                reasons = [code for code in detail[key] if re.fullmatch(r"[a-z][a-z0-9_.]{0,79}", code)]
                return PublicLineProblem("line_refused", key=key, reason=reasons)
    return PublicLineProblem("line_refused")


def _public_lines(interview: Interview) -> SetupPublicLines:
    """The board's projection of the stored answers. A line the kernel held at the latest charter write, the
    contact included, keeps its stored words and source, marked `held`; the revision covers that mark too."""
    answers, held = interview.answers, set(interview.held_policy_keys)
    public = SetupPublicLines(revision="", lines=[
        SetupPublicLine(key=key, text=value.strip(),
                        source="suggested" if field in answers.suggested_fields else "owner",
                        editable=field != "how_we_help", held=key in held)
        for field, key in PUBLIC_LINE_KEYS.items() if (value := getattr(answers, field)) and value.strip()
    ], hours=SetupPublicHours(source="suggested" if "hours" in answers.suggested_fields else "owner",
                             windows=answers.hours) if answers.hours else None,
       prices=SetupPublicPrices(source="suggested" if "price_items" in answers.suggested_fields else "owner",
                                items=[item.model_dump() for item in price_items(answers.price_items)])
       if answers.price_items else None)
    canonical = json.dumps(public.model_dump(mode="json", exclude={"revision"}), sort_keys=True,
                           separators=(",", ":"))
    public.revision = hashlib.sha256(canonical.encode()).hexdigest()[:16]
    return public


async def _public_lines_interview(owner: OwnerCtx, engine: AsyncEngine, interview_id: str) -> Interview:
    interview = await _read(engine, owner, interview_id)
    if interview.step not in ("rules", "situations") or interview.busy:
        raise ApiProblem(409, "conflict")
    return interview


async def public_lines(owner: OwnerCtx, engine: AsyncEngine, interview_id: str) -> SetupPublicLines:
    await _read(engine, owner, interview_id)  # ownership before exposing the process's turn guard
    with _turn(interview_id):
        interview = await _public_lines_interview(owner, engine, interview_id)
        return _public_lines(interview)


async def _put_public_parts(owner: OwnerCtx, desk_id: str, parts: SeedParts, held: list[str], *,
                           selected: frozenset[str], sent: set[str] | None = None,
                           edited_key: str | None = None) -> None:
    """Writes the `selected` parts of `parts` (`seed_parts`, which holds back every suggested field). The charter
    leaves out the `held` keys (`held_policy_keys`), so a line the kernel held never blocks another write, and is
    written strictly (`_put_charter` without `drop_refused`): an owner's edit is never dropped to save the rest."""
    charter = [claim for claim in parts.charter if claim.key not in held]
    for attempt in range(2) if "charter" in selected else ():
        try:
            if sent is not None:
                sent.add("charter")
            await _put_charter(owner, desk_id, charter, drop_refused=False)
            break
        except KernelFailed as failure:
            if failure.status != 422:
                raise
            if sent is not None:
                sent.discard("charter")  # A definite refusal has applied nothing, including on the retry.
            refused = _line_refused(failure, edited_key)
            logger.warning("setup public parts refused (key=%s)", refused.answer.key)
            if attempt == 0 and set(_public_refusal_detail(failure)) == {"policy:how_we_help"}:
                # This claim is code-owned; editable lines must always be corrected by the owner.
                charter = [claim for claim in charter if claim.key != "policy:how_we_help"]
                continue
            raise refused from None
    path = {"id": desk_id}
    writes = []
    if "hours" in selected:
        writes.append(("hours", "hours", DeskHoursRequest(hours=parts.hours)))
    if "calendar" in selected:
        writes.append(("calendar", "hours", DeskCalendarRequest(calendar_slots=parts.calendar)))
    if "prices" in selected:
        writes.append(("prices", "prices", DeskPricesRequest(price_items=parts.prices)))
    for part, key, body in writes:
        try:
            if sent is not None:
                sent.add(part)
            await owner.kernel.call(f"PUT /desks/{{id}}/{part}", body, path=path)
        except KernelFailed as failure:
            if failure.status != 422:
                raise
            logger.warning("setup public parts refused (key=%s)", key)
            raise PublicLineProblem("line_refused", key=key) from None


async def put_public_line(owner: OwnerCtx, engine: AsyncEngine, interview_id: str, key: str, text: str,
                          now: datetime, *, setup_policy_claims_enabled: bool = True) -> SetupPublicLines:
    await _read(engine, owner, interview_id)
    with _turn(interview_id):
        interview = await _public_lines_interview(owner, engine, interview_id)
        seen = _stored(interview)
        fields = {key: field for field, key in PUBLIC_LINE_KEYS.items()}
        if key not in fields:
            raise ApiProblem(422, "invalid")
        field = fields[key]
        if field == "how_we_help":
            raise PublicLineProblem("not_editable", key=key)
        try:
            interview.answers = SetupAnswers.model_validate({
                **interview.answers.model_dump(), field: text.strip(),
                "suggested_fields": [name for name in interview.answers.suggested_fields if name != field],
            })
        except ValidationError:
            raise ApiProblem(422, "invalid") from None
        # A rewording clears its hold only when it is published in its place (or nothing is saved): with policies
        # switched off, a policy line is never sent, so the kernel hasn't checked it and it stays held.
        if key in interview.held_policy_keys and (key == "contact" or setup_policy_claims_enabled):
            interview.hold_policies([held for held in interview.held_policy_keys if held != key])
        return await _commit_public_lines(owner, engine, interview, seen, now, key=key,
                                          setup_policy_claims_enabled=setup_policy_claims_enabled)


async def delete_public_line(owner: OwnerCtx, engine: AsyncEngine, interview_id: str, key: str,
                            now: datetime, *, setup_policy_claims_enabled: bool = True) -> SetupPublicLines:
    await _read(engine, owner, interview_id)
    with _turn(interview_id):
        interview = await _public_lines_interview(owner, engine, interview_id)
        seen = _stored(interview)
        fields = {key: field for field, key in PUBLIC_LINE_KEYS.items()} | {"hours": "hours", "prices": "price_items"}
        if key not in fields:
            raise ApiProblem(422, "invalid")
        field = fields[key]
        if field == "how_we_help":
            raise PublicLineProblem("not_editable", key=key)
        if field not in interview.answers.suggested_fields:
            raise PublicLineProblem("not_suggested", key=key)
        interview.answers = interview.answers.model_copy(update={
            field: [] if field in ("hours", "price_items") else "",
            "suggested_fields": [name for name in interview.answers.suggested_fields if name != field],
        })
        return await _commit_public_lines(owner, engine, interview, seen, now, key=key,
                                          republish=frozenset({key}) if key in ("hours", "prices") else frozenset(),
                                          setup_policy_claims_enabled=setup_policy_claims_enabled)


async def delete_public_price(owner: OwnerCtx, engine: AsyncEngine, interview_id: str, item_id: str,
                              now: datetime, *, title: str, unit_cents: int,
                              setup_policy_claims_enabled: bool = True) -> SetupPublicLines:
    await _read(engine, owner, interview_id)
    with _turn(interview_id):
        interview = await _public_lines_interview(owner, engine, interview_id)
        seen = _stored(interview)
        items = price_items(interview.answers.price_items)
        item = next((item for item in items if item.item_id == item_id), None)
        if item is None or item.title != title or item.unit_cents != unit_cents:
            raise ApiProblem(409, "conflict")
        if "price_items" not in interview.answers.suggested_fields:
            raise PublicLineProblem("not_suggested", key="prices")
        remaining = [price for price, item in zip(interview.answers.price_items, items) if item.item_id != item_id]
        interview.answers = interview.answers.model_copy(update={
            "price_items": remaining,
            "suggested_fields": [field for field in interview.answers.suggested_fields
                                 if field != "price_items" or remaining],
        })
        return await _commit_public_lines(owner, engine, interview, seen, now, key="prices",
                                          republish=frozenset({"prices"}),
                                          setup_policy_claims_enabled=setup_policy_claims_enabled)


async def _commit_public_lines(owner: OwnerCtx, engine: AsyncEngine, interview: Interview, seen: dict,
                               now: datetime, *, key: str | None = None, republish: frozenset[str] = frozenset(),
                               setup_policy_claims_enabled: bool = True) -> SetupPublicLines:
    timezone = (await _business(owner, interview.desk_id))["timezone"]
    today = now.astimezone(ZoneInfo(timezone)).date()

    def published(answers: SetupAnswers) -> SeedParts:
        return seed_parts(answers, timezone, business_type=interview.business_type, today=today,
                          publish_policies=setup_policy_claims_enabled)

    before, after = published(SetupAnswers.model_validate(seen["answers"])), published(interview.answers)
    changed = frozenset(part for part in ("hours", "prices") if getattr(before, part) != getattr(after, part))
    selected = frozenset({"charter"} | republish
                         | ({"hours", "calendar"} if "hours" in changed or "hours" in republish else set())
                         | ({"prices"} if "prices" in changed else set()))
    sent: set[str] = set()

    async def repair() -> None:
        try:
            async with asyncio.timeout(PUBLIC_PARTS_REPAIR_TIMEOUT_S * (1 + len(sent))):
                stored = await _read(engine, owner, interview.interview_id)
                await _put_public_parts(owner, stored.desk_id, published(stored.answers), stored.held_policy_keys,
                                        selected=frozenset(sent), edited_key=key)
        except Exception as restore_failed:
            logger.error("setup public parts restore failed (%s, key=%s)", type(restore_failed).__name__, key)
        else:
            logger.warning("setup public parts restored from stored answers (key=%s)", key)

    async def settle() -> SetupPublicLines:
        try:
            await _put_public_parts(owner, interview.desk_id, after, interview.held_policy_keys, selected=selected,
                                    sent=sent, edited_key=key)
        except Exception:
            if sent:
                await repair()
            raise
        try:
            await _commit(engine, owner, interview, seen)
        except Exception as failed:
            logger.warning("setup public lines save failed (%s)", type(failed).__name__)
            await repair()
            raise ApiProblem(409, "conflict") from None
        return _public_lines(interview)

    task = asyncio.create_task(settle())
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # Keep the caller's _turn and owner context open until publication, save and repair settle.
        # Repeated disconnect/shutdown cancellation must not release either resource early.
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not task.cancelled():
            task.exception()  # consume a settlement failure even when the request can no longer answer
        raise


async def confirm_public_lines(owner: OwnerCtx, engine: AsyncEngine, interview_id: str, now: datetime, *,
                                keys: list[str], revision: str,
                                setup_policy_claims_enabled: bool = True) -> SetupPublicLines:
    await _read(engine, owner, interview_id)
    with _turn(interview_id):
        interview = await _public_lines_interview(owner, engine, interview_id)
        seen = _stored(interview)
        public = _public_lines(interview)
        listed = {line.key for line in public.lines}
        listed.update(key for key in ("hours", "prices") if getattr(public, key) is not None)
        if not keys or not revision.strip():
            raise ApiProblem(422, "invalid")
        if revision != public.revision:                 # a stale view first: a key it named may have gone since
            raise ApiProblem(409, "conflict")
        if not set(keys) <= listed:
            raise ApiProblem(422, "invalid")
        if held := [line.key for line in public.lines if line.key in keys and line.key in interview.held_policy_keys]:
            raise PublicLineProblem("line_refused", key=held[0])   # only a rewording can publish a held line
        confirmed = {field for field, key in PUBLIC_LINE_KEYS.items() if key in keys}
        confirmed.update(field for key, field in (("hours", "hours"), ("prices", "price_items")) if key in keys)
        republish = frozenset(part for field, part in (("hours", "hours"), ("price_items", "prices"))
                              if field in confirmed and field in interview.answers.suggested_fields)
        interview.answers = interview.answers.model_copy(update={
            "suggested_fields": [field for field in interview.answers.suggested_fields if field not in confirmed],
        })
        return await _commit_public_lines(owner, engine, interview, seen, now, republish=republish,
                                          setup_policy_claims_enabled=setup_policy_claims_enabled)


def seed_parts(answers: SetupAnswers, timezone: str, *, business_type: BusinessType, today: date,
               publish_policies: bool = True) -> SeedParts:
    """The Desk's parts from the answers: the public charter (the contact and the business's policies, or the
    contact alone when policies are switched off), the hours, the price list, the calendar and the notification
    defaults. Nothing listed in `suggested_fields` is published: it stays in the owner's answers until the owner
    confirms it, so suggested hours open no calendar slots either."""
    held = set(answers.suggested_fields)
    claim_fields = [("public_contact", "contact")]
    if publish_policies:
        claim_fields.extend(SETUP_POLICY_CLAIMS.items())
    charter = [Claim(key=key, kind="text", value=value.strip())
               for field, key in claim_fields
               if field not in held and (value := getattr(answers, field)) and value.strip()]
    hours = [] if "hours" in held else list(answers.hours)
    prices = [] if "price_items" in held else price_items(answers.price_items)
    return SeedParts(charter=charter, hours=hours, prices=prices,
                     calendar=calendar_slots(hours, timezone, today),
                     notifications=default_notifications(business_type))


CHARTER_CAPS = frozenset({"policy_count_limit", "policy_text_limit"})
POLICY_RETRIES = 2


async def _put_charter(owner: OwnerCtx, desk_id: str, charter: list[Claim], *,
                       drop_refused: bool = True) -> list[str]:
    """Writes the charter, holding back what the kernel's public-text checks refuse, and returns the held keys in
    the order they were dropped once a write succeeds.

    A refusal (422 `invalid` naming keys) drops claims and the charter is sent again without them; nothing is ever
    re-sent unchanged. The public contact is held like a policy line. The kernel checks the contact before any
    policy line, so a refusal naming only the contact drops it without using up a policy retry. The first other
    refusal drops just the claims it names; a cap refusal, one naming no claim sent, or a second one drops every
    `policy:` claim left and any other claim it names. A cap refusal is one whose `charter` entry names a cap,
    whatever other keys (such as the contact) come with it. That is at most four writes when the contact is refused
    on its own and three otherwise. A refusal with nothing left to drop, a third, or any other failure propagates.
    Each drop is logged by key and rule ids, never text.

    Without `drop_refused` (the owner's own edit of a public line) the write is strict: the first refusal propagates
    and nothing is dropped or sent again, so the owner hears what the kernel refused and recorded.
    """
    held: list[str] = []
    policy_refusals = 0
    while True:
        try:
            await owner.kernel.call("PUT /desks/{id}/charter", DeskCharterRequest(charter=charter),
                                    path={"id": desk_id})
            return held
        except KernelFailed as refused:
            if not drop_refused or refused.status != 422 or refused.code != "invalid" or not refused.detail:
                raise
            named = {claim.key: refused.detail[claim.key] for claim in charter if claim.key in refused.detail}
            capped = not CHARTER_CAPS.isdisjoint(refused.detail.get("charter", ()))
            if refused.detail.keys() == {"contact"} and named:
                dropped = named
            elif policy_refusals < POLICY_RETRIES:
                targeted = policy_refusals == 0 and named and not capped
                dropped = named if targeted else {claim.key: refused.detail.get(claim.key, []) for claim in charter
                                                  if claim.key.startswith("policy:") or claim.key in named}
                policy_refusals += 1
            else:
                raise
            if not dropped:
                raise
            logger.warning("setup dropped refused charter claims: %s", dropped)
            held.extend(dropped)
            charter = [claim for claim in charter if claim.key not in dropped]


async def _put_parts(owner: OwnerCtx, desk_id: str, parts: SeedParts) -> list[str]:
    path = {"id": desk_id}
    held = await _put_charter(owner, desk_id, parts.charter)
    await owner.kernel.call("PUT /desks/{id}/hours", DeskHoursRequest(hours=parts.hours), path=path)
    await owner.kernel.call("PUT /desks/{id}/prices", DeskPricesRequest(price_items=parts.prices), path=path)
    await owner.kernel.call("PUT /desks/{id}/calendar", DeskCalendarRequest(calendar_slots=parts.calendar), path=path)
    await owner.kernel.call("PUT /desks/{id}/notifications",
                            DeskNotificationsRequest(notifications=parts.notifications), path=path)
    return held


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


def _money_targets(tools: list[dict]) -> frozenset[str]:
    """Money tools offered by this Desk, and effect targets that cover them."""
    return MONEY_TARGETS | frozenset(target for tool in tools if money_tool(tool["tool"], tool["effects"])
                                     for target in _covering(tool["tool"], tools))


def _past_a_limit(card: RuleCard, tools: list[dict], answers: SetupAnswers) -> str | None:
    """The answered limit an auto card goes past, by the tool it names or an effect the tool has, or None: a quote's
    amount (which it must set) and discount past the answered quote and discount limits, a document going out unless
    verified owners get their own, or a money tool's amount past the lower of the answered link limit and the money
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
    if card.applies_to in _money_targets(tools) and (
            card.max_amount_cents is None or card.max_amount_cents > link_limit):
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
        elif card.applies_to in _money_targets(tools) and (card.max_amount_cents or 0) > cap:
            problems.append(CARD_ERROR_LINE.format(index=index, problem=CARD_ERRORS["above_cap"]))
        elif (past := _past_a_limit(card, tools, answers)) is not None:
            problems.append(CARD_ERROR_LINE.format(index=index, problem=CARD_ERRORS[past]))
    return "\n".join(problems) or None


def _card(index: int, draft: RuleCardDraft) -> RuleCard:
    return RuleCard(card_id=f"card-{index + 1}", applies_to=draft.applies_to, mode=draft.mode, who=draft.who,
                    max_amount_cents=draft.max_amount_cents, max_discount_bp=draft.max_discount_bp,
                    hours=draft.hours.window() if draft.hours is not None else None, review=draft.review,
                    reason=draft.reason.strip())


def owner_rule_answers(answers: SetupAnswers) -> SetupAnswers:
    """One projection for rule inputs: suggested facts are unanswered, and summaries confer no job authority."""
    return SetupAnswers.model_validate({"summary": "", **answers.model_dump(
        exclude={"suggested_fields", "how_we_help", *answers.suggested_fields})})


async def draft_cards(model: ModelClient, record: Record, business_type: BusinessType, answers: SetupAnswers,
                      tools: list[dict],
                      post: Callable[[list[RuleCard]], Awaitable[PolicyVersion | None]], *,
                      jobs: list[dict[str, object]] | None = None) -> PolicyVersion | None:
    """Claude's rule cards from the answers (route `card_draft`), ids `card-1`…, for the `tools` offered (every
    enabled tool but the utility cards' ones, as `{tool, effects}`) or an effect, as `post` drafts them on the kernel.
    A draft code can't use (no card, a target not offered, a card the contract refuses, a card against the owner's
    "never" answer on documents or refunds, money going out on its own, or an auto card past an answered limit: the
    money cap, the quote, discount and payment link limits, or the documents rule), or one `post` answers None for (the
    kernel refused the set as invalid, which names no card), gets one retry with what is wrong: the one retry every
    draft gets, whichever found it. The version `post` drafted, or None when the retry can't be used either: the caller
    drafts the template cards."""
    answers = owner_rule_answers(answers)
    cap = answers.auto_money_cap_cents
    owner_answers = answers.model_dump(mode="json", exclude_defaults=True)
    if jobs:
        owner_answers["accepted_jobs"] = jobs
    message = _user("\n\n".join([card_draft_head(business_type, cap), wrap(TOOLS_TAG, json.dumps(tools)),
                                 wrap(ANSWERS_TAG, json.dumps(owner_answers))]))
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
                       replace_stored: bool = False, reopens: int | None = None) -> list[RuleCard]:
    """Store setup's cards for its rules draft and return the cards stored: those already there when another request
    stored them first, unless `replace_stored`."""
    def keep(interview: Interview) -> None:
        if replace_stored or not interview.draft_cards:
            interview.draft_cards = list(cards)

    return (await _update(engine, owner, interview_id, keep, reopens=reopens)).draft_cards


async def _drafted(engine: AsyncEngine, owner: OwnerCtx, interview_id: str, version: int, step: SetupStep, *,
                   reopens: int | None = None) -> None:
    def note(interview: Interview) -> None:
        # A new version after reopening has not been tried, even if the preceding draft reached the safety check.
        interview.step = step if interview.reopens and interview.draft_version != version else _later(interview.step, step)
        interview.draft_version = version

    await _update(engine, owner, interview_id, note, reopens=reopens)


async def rules(owner: OwnerCtx, engine: AsyncEngine, model: ModelClient, interview_id: str,
                now: datetime, *, setup_policy_claims_enabled: bool = True) -> RulesDraft:
    """The new Desk's parts and its first rules draft. The first time, the parts go to the kernel, then Claude
    drafts the cards, each set stored before the kernel drafts it; a set the kernel refuses as invalid gets Claude's
    one retry (`draft_cards`). Any later request re-posts the stored cards and never drafts again. A proof that is
    rejected, Claude's cards that can't be used after the retry, or stored cards the kernel refuses as invalid fall
    back once to the template cards, stored in their place; the kernel refusing the template is the owner's error."""
    async with engine.connect() as conn:
        interview = await _load(conn, owner.copy_id, interview_id)
    desk_id = owner.desk(interview.desk_id)
    _require_step(interview, RULE_STEPS)
    reopens = interview.reopens
    answers, business_type = owner_rule_answers(interview.answers), interview.business_type
    cards = interview.draft_cards
    template = template_cards(business_type, answers)
    version: PolicyVersion | None
    if not cards:
        timezone = (await _business(owner, desk_id))["timezone"]
        today = now.astimezone(ZoneInfo(timezone)).date()
        held = await _put_parts(owner, desk_id, seed_parts(interview.answers, timezone, business_type=business_type,
                                                         today=today, publish_policies=setup_policy_claims_enabled))
        await _update(engine, owner, interview_id, lambda current: current.hold_policies(held), reopens=reopens)

        async def post(drafted: list[RuleCard]) -> PolicyVersion | None:
            nonlocal cards                      # the first set keeps cards another request stored first
            cards = await _store_cards(engine, owner, interview_id, drafted, replace_stored=bool(cards),
                                       reopens=reopens)
            return await _posted(owner, desk_id, cards, template, answers.auto_money_cap_cents)

        version = await draft_cards(model, recorder(engine, owner, CARD_DRAFT_ROUTE), business_type, answers,
                                    await _rule_tools(owner, desk_id), post, jobs=owner_job_answers(interview))
    else:
        version = await _posted(owner, desk_id, cards, template, answers.auto_money_cap_cents)
    if (version is None or version.status == "rejected") and cards != template:
        cards = await _store_cards(engine, owner, interview_id, template, replace_stored=bool(cards), reopens=reopens)
        version = checkable(await _post_draft(owner, desk_id, cards, answers.auto_money_cap_cents))
    await _drafted(engine, owner, interview_id, version.version, "rules", reopens=reopens)
    return rules_draft(version, version_cap(version))


# Situations and the safety check -----------------------------------------------------------------------------------


def _local(moment: datetime, zone: ZoneInfo) -> datetime:
    return moment.astimezone(zone)


def _open_at(moment: datetime, hours: list[HoursWindow]) -> HoursWindow | None:
    """The window `moment` (local) falls in, if any (a window's end is exclusive; 00:00 is midnight)."""
    minute = minute_of_day(moment.time())
    for window in hours:
        if (WEEK[moment.weekday()] in window.days
                and minute_of_day(window.start) <= minute < (minute_of_day(window.end) or 1440)):
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
    ends = [minute_of_day(window.end) or 1440 for window in hours if WEEK[day.weekday()] in window.days]
    moment = datetime.combine(day, time(0), zone) + timedelta(minutes=max(ends))
    for _ in range(len(hours) * 7):                      # a window that continues past it moves it on
        window = _open_at(moment, hours)
        if window is None:
            break
        moment = datetime.combine(moment.date(), time(0), zone) + timedelta(minutes=minute_of_day(window.end) or 1440)
    return moment


def next_opening(hours: list[HoursWindow], timezone: str, now: datetime) -> datetime | None:
    """The start of the first window on the next day that has hours, in the business's time zone (None without
    hours): when a booking situation that isn't after hours happens, so it doesn't depend on the clock it is run."""
    zone = ZoneInfo(timezone)
    day = _next_day_with_hours(hours, _local(now, zone).date())
    if day is None:
        return None
    start = min(minute_of_day(window.start) for window in hours if WEEK[day.weekday()] in window.days)
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
    answers = owner_rule_answers(interview.answers)
    enabled = {row["tool"] for row in await owner.ro.rows("tools", desk_id=desk_id, status="enabled")}
    tools = {who: sorted(given & enabled) for who, given in SITUATION_TOOLS_BY_WHO.items()}
    rules_text = json.dumps([card.model_dump(mode="json", exclude={"card_id", "person_id", "agent_key_id",
                                                                   "is_default"}) for card in cards])
    message = _user("\n\n".join([SITUATIONS_HEAD.format(business_type=interview.business_type),
                                 wrap(RULES_TAG, rules_text), wrap(PRICES_TAG, json.dumps(prices)),
                                 wrap(TOOLS_TAG, json.dumps(tools)),
                                 wrap(ANSWERS_TAG, answers.model_dump_json(exclude_defaults=True))]))

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
    built = [situation(number, draft, prices, answers.hours, timezone, now)
             for number, draft in enumerate(drafted.situations, 1)]
    results = await _run_probes(owner, desk_id, version, [each.probe for each in built])
    await _update(engine, owner, interview_id, lambda found: setattr(found, "step", _later(found.step, "situations")),
                  reopens=interview.reopens)
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
    row is blocked only by an outcome that stops it and never when it depends on the reviewer. Held against a change
    (`_transition`), it marks the safety check run only for the draft it tried: 409 `conflict` once the rules were
    drafted again meanwhile, whose own check is still to run."""
    with _transition(interview_id):
        interview = await _read(engine, owner, interview_id)
        desk_id = owner.desk(interview.desk_id)
        _require_step(interview, RULE_STEPS, drafted=True)
        listed = await owner.ro.rows("price_items", desk_id=desk_id, order_by=("item_id",))
        prices = {row["item_id"]: row["unit_cents"] for row in listed}
        name = interview.answers.owner_display_name
        built = safety_probes(owner_rule_answers(interview.answers), prices)
        started = monotonic()
        results = await _run_probes(owner, desk_id, interview.draft_version, [probe for _, probe in built])
        seconds = round(monotonic() - started, 1)
        rows = [SafetyRow(label=spec.label,
                          tries=spec.tries.format(owner_intro=f"Hi, it's {name or 'the owner'}. "),
                          result=result,
                          blocked=result.outcome in spec.blocked_by and not result.depends_on_review)
                for (spec, _), result in zip(built, results, strict=True)]
        await _update(engine, owner, interview_id,
                      lambda found: setattr(found, "step", _later(found.step, "safety_check")),
                      reopens=interview.reopens, version=interview.draft_version)
    return SafetyCheck(rows=rows, blocked=sum(row.blocked for row in rows), total=len(rows), seconds=seconds)


# Confirming and going live -----------------------------------------------------------------------------------------


async def confirm(owner: OwnerCtx, engine: AsyncEngine, interview_id: str) -> PolicyVersion:
    """Activate the rules draft, with Answering still off (step `preview`). When the kernel finds the rules changed
    since the draft (409), the same cards are drafted again on the rules now in force, and the new draft is raised
    (`RulesChangedSinceDraft`) for the owner to confirm instead. A draft the kernel already activated (a confirm
    whose answer was lost) moves setup on without activating anything again; any other draft that isn't proved is
    409 `conflict`. Once "Change something" has reopened the questions, the rules are confirmed only after the safety
    check has run again on their new draft (step `safety_check`), else 409 `conflict`. Held against a change
    (`_transition`), it checks the step, the draft and the reopens before the kernel call and again as it writes."""
    with _transition(interview_id):
        interview = await _read(engine, owner, interview_id)
        desk_id = owner.desk(interview.desk_id)
        steps = ("safety_check", "preview") if interview.reopens else RULE_STEPS
        _require_step(interview, steps, drafted=True)
        reopens, drafted = interview.reopens, interview.draft_version

        async def confirmed() -> None:
            await _update(engine, owner, interview_id, lambda found: setattr(found, "step", "preview"),
                          reopens=reopens, version=drafted, steps=steps)

        row = await owner.ro.one("policy_versions", desk_id=desk_id, version=drafted)
        if row is not None and row["status"] == "active":     # a Desk has one active version: this draft is in force
            await confirmed()
            active = version_from_row(row)
            await tell_cancelled_links(owner, engine, desk_id, active)
            return active
        if row is None or row["status"] != "proved":
            raise ApiProblem(409, "conflict")
        try:
            active = await owner.kernel.call("POST /policy/confirm", PolicyConfirmRequest(
                desk_id=desk_id, version=drafted))
        except KernelFailed as refused:
            if refused.code != "conflict":
                raise
            version = checkable(await _post_draft(owner, desk_id, interview.draft_cards,
                                                  owner_rule_answers(interview.answers).auto_money_cap_cents))
            await _drafted(engine, owner, interview_id, version.version, "rules", reopens=reopens)
            raise RulesChangedSinceDraft(rules_draft(version, version_cap(version))) from None
        await confirmed()
    await tell_cancelled_links(owner, engine, desk_id, active)
    return active


async def go_live(owner: OwnerCtx, engine: AsyncEngine, interview_id: str, public_origin: str) -> WentLive:
    """Turn Answering on once the rules are confirmed (step `preview`, else 409 `conflict`): the Desk answers the
    public at its address (step `live`). Held against a change (`_transition`); one that still lands meanwhile (from
    another process) is 409 `conflict`, and Answering goes off again, so the Desk never answers on the rules before it."""
    with _transition(interview_id):
        interview = await _read(engine, owner, interview_id)
        desk_id = owner.desk(interview.desk_id)
        _require_step(interview, ("preview",))
        await owner.kernel.call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=True), path={"id": desk_id})
        try:
            await _update(engine, owner, interview_id, lambda found: setattr(found, "step", "live"),
                          reopens=interview.reopens, version=interview.draft_version, steps=("preview",))
        except ApiProblem:
            await owner.kernel.call("PUT /desks/{id}/answering", DeskAnsweringRequest(on=False), path={"id": desk_id})
            raise
    slug = await _slug(owner, desk_id)
    return WentLive(public_url=f"{public_origin}/d/{slug}", slug=slug)


# Tools -------------------------------------------------------------------------------------------------------------


async def setup_tools(owner: OwnerCtx, engine: AsyncEngine, interview_id: str, *,
                      business_tools_enabled: bool = False) -> SetupTools:
    """The new Desk's tools as the kernel lists them, each with the active rules' cards that cover it, and the mock
    payments server while it isn't connected. Payment tools a change took away but that publishing the plan couldn't
    switch off are switched off first (`_switch_off_payments`); a failure there is this read's error."""
    async with engine.connect() as conn:
        interview = await _load(conn, owner.copy_id, interview_id)
    desk_id = owner.desk(interview.desk_id)
    if interview.step != "questions" and _removed_payments(interview):
        interview.business_tools_enabled = business_tools_enabled
        await _switch_off_payments(owner, engine, interview)    # its first try failed: tried again, or the read fails
    if (business_tools_enabled and interview.step != "questions"
            and any(job.config is not None for job in accepted_jobs(interview))
            and not await owner.ro.rows("tools", desk_id=desk_id, source="business")):
        interview.business_tools_enabled = business_tools_enabled
        # End the read's transaction before waiting on the kernel; the reads below set the copy again on their own.
        if owner.ro.conn.in_transaction():
            await owner.ro.conn.rollback()
        await after_finish(owner, interview)
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
