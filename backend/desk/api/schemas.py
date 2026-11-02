"""The API's HTTP shapes (Plan 02a, "Read models" and "Errors"): what its routes take and answer with.

Every error answer is an `ApiError`; `error_responses` documents them in the OpenAPI document.
"""

import re
from collections.abc import Callable
from datetime import date as LocalDate
from functools import cache
from typing import Annotated, Any, Literal, Self
from zoneinfo import available_timezones

from fastapi.routing import APIRoute
from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StringConstraints,
    field_validator,
    model_validator,
)

from desk.api.idempotency import IdempotencyKey
from desk.api.prompts import (
    CARD_ID_MAX_LENGTH,
    CARD_REASON_MAX_LENGTH,
    OWNER_CARDS_MAX,
    Choice,
    Autonomy,
    Cents,
    ProposalCard,
    PlannedOutcome,
    DemoTask,
    DemoTaskSet,
    QuestionKey,
    SituationWho,
    Triage,
)
from desk.contracts import (
    ToolName,
    BusinessToolDef,
    AUTO_MONEY_HARD_CAP_CENTS,
    ActorKind,
    ApprovalAnswer,
    Assurance,
    Clause,
    Decision,
    DecisionState,
    HoursWindow,
    KnowledgeItem,
    KnowledgeSource,
    Outcome,
    PaymentLinkState,
    PolicyVersion,
    Probe,
    ProbeResult,
    ProofReport,
    RenderedBlock,
    RuleCard,
    SeedDocument,
    SessionMode,
    SessionState,
    Violation,
)
from desk.events import EvHeld, EvMessage, EvOwnerJoined, EvOwnerLeft, EvReceipt, EvResolved
from desk.kernel_api import Health, ToolPin, ToolsConfirmRequest, each_tool_once
from desk.presets import PresetName


class ApiError(BaseModel):
    """Every error answer: `error` names what went wrong; `code` is the kernel's, when `error` is "kernel";
    `retry_after` is the seconds to wait before sending again: on a 429, and on a 409 `in_progress` that names one.
    Fields that don't apply are left out."""

    error: str
    code: str | None = None
    retry_after: int | None = None


def error_responses(*statuses: int) -> dict[int | str, dict[str, Any]]:
    """The OpenAPI entries for a route's error answers, each an `ApiError`."""
    return {status: {"model": ApiError} for status in statuses}


def operation_ids(router: str) -> Callable[[APIRoute], str]:
    """OpenAPI operation IDs `<router>_<name>`, for a router's `generate_unique_id_function`."""
    return lambda route: f"{router}_{route.name}"


# Setup's steps (Plan 02b): an interview runs from `questions` to `live`, its go-live step, where it is finished.
UnfinishedSetupStep = Literal["questions", "tools", "rules", "situations", "safety_check", "preview"]
SetupStep = Literal[UnfinishedSetupStep, "live"]


class DeskSetup(BaseModel):
    """A Desk's setup interview that hasn't gone live: its ID (`GET /api/owner/setup/{id}`) and the step it is at.
    Setup finishes at its go-live step (step `live`); an interview whose rules are confirmed but that hasn't gone live
    (`preview`) is still unfinished, since going live is setup's last step."""

    interview_id: str
    step: UnfinishedSetupStep


class DeskSummary(BaseModel):
    """One of the copy's Desks. `setup` is its setup interview while that isn't finished, so the owner can go back
    into it; null once its setup interview went live (setup's go-live step) and for a Desk made outside setup.
    `answering` is separate: the Answering switch can turn a Desk on before its setup finishes, and it still lists its
    setup."""

    desk_id: str
    slug: str
    name: str
    business_name: str
    hours: list[HoursWindow]
    answering: bool
    setup: DeskSetup | None


class CopyOut(BaseModel):
    """The owner's copy: what `POST /api/owner/copies`, `start_over` and `me` answer with."""

    copy_id: str
    desks: list[DeskSummary]


class HealthOut(BaseModel):
    """`GET /api/health`: 200 with the kernel's health, or 503 with `ok` false and no kernel field."""

    ok: bool
    kernel: Health | None


TranscriptKind = Literal["visitor_text", "agent_text", "delivered", "status", "whisper", "owner_joined", "owner_left"]


class TranscriptItem(BaseModel):
    """One transcript entry as the visitor sees it: their own words, or an event the API delivered or emitted.

    `owner_joined` and `owner_left` (Plan 02b) are where the owner took the conversation over and handed it back, each
    with the event the visitor's stream got then (`EvOwnerJoined` names the owner as the kernel had them), at that
    moment; a resume after a breaker pause has none. A client that doesn't know a kind skips the item."""

    n: int                                # app.messages.n, the `after` cursor
    kind: TranscriptKind
    created_at: AwareDatetime
    text: str | None                      # the author's own words; None for the items that carry an event
    event: Annotated[EvMessage | EvReceipt | EvHeld | EvResolved | EvOwnerJoined | EvOwnerLeft,
                     Field(discriminator="type")] | None


class CheckedDraft(BaseModel):
    """A reply of Claude's exactly as it was sent to the kernel's reply check: its prose and its clauses."""

    prose: str
    clauses: list[Clause]


class StoppedDraft(BaseModel):
    """A reply of Claude's the kernel's reply check stopped (Plan 02b): the draft as the check had it, and each
    violation the check found, with the span of the draft it matched (a canary's is "document text", never the canary),
    the facts it concerns and the rule that matched. It is the owner's alone: no visitor read or event, no model
    context, no reply check, no job and no log line carries it."""

    draft: CheckedDraft
    violations: list[Violation]


class OwnerTranscriptItem(TranscriptItem):
    """The owner's view adds the AI-written translation and triage (Plan 02b), which never reach a visitor, and each
    draft of Claude's the reply check stopped.
    `owner_plain` is always present: the owner-only reason for this exact execution refusal, or null.

    `cursor` is where the item stands for `after`: its own `n`, or later once a translation or triage was written onto
    it, when the item comes again with the same `n` (replace it) and the later cursor (advance `after` to the largest
    one read). Items come in transcript order (`n`), each once per read.

    A `stopped_draft` item (Plan 02b) stands where the check stopped the draft, before the rewrite or the handoff that
    followed: its `stopped_draft` holds the draft and why it was stopped, and it has no `text` or `event`. Every other
    item's `stopped_draft` is null."""

    kind: Literal[TranscriptKind, "stopped_draft"]
    cursor: int
    owner_translation: str | None
    triage: Triage | None
    stopped_draft: StoppedDraft | None
    owner_plain: str | None = Field(description=(
        "Owner-only execution refusal reason for this exact status, fetched with the owner's credential; "
        "never part of the stored or signed visitor event."))


# The visitor's chat (Task 7) ---------------------------------------------------------------------------------


class VisitorSession(BaseModel):
    """`POST /api/public/desks/{slug}/sessions`: the session the visitor cookie now holds, and whether it is the one
    the cookie already held (a returning visitor) or a new one."""

    state: SessionState
    resumed: bool


class VisitorTranscript(BaseModel):
    """`GET /api/public/desks/{slug}/session`: the session's state, its transcript as the visitor sees it, and the
    highest event `seq` read in the same snapshot, which the event stream continues after."""

    state: SessionState
    items: list[TranscriptItem]
    last_seq: int


class MessageAccepted(BaseModel):
    """202: the visitor's message is stored; Claude's answer arrives on the event stream."""

    message_id: str


class CancelAccepted(BaseModel):
    """202: the held request is withdrawn; its outcome arrives on the event stream as `resolved`."""

    decision_id: str


class VerifyChecked(BaseModel):
    """`POST /api/public/desks/{slug}/verify/check`: the session as the kernel has it once the code was right, verified
    as the contact on record (assurance `demo_code`)."""

    state: SessionState


class AgentCardSigning(BaseModel):
    """How an agent signs each request: the headers it sends and the payload its Ed25519 signature covers."""

    headers: list[str]
    payload_fields: list[str]
    canonical: Literal["RFC 8785"]
    algorithm: Literal["Ed25519"]
    encoding: Literal["lowercase hex"]
    ts_window_s: int


class AgentCardOut(BaseModel):
    """`GET /api/public/desks/{slug}/agent_card`: built by code from `PUBLIC_ORIGIN` and the slug, with no model
    text; what agents may do here, and the AI disclosure, are the kernel's `PublicDesk.agent_card`."""

    endpoint: str
    signing: AgentCardSigning
    example_request: str


class AgentRunStarted(BaseModel):
    """202: the built-in agent is on its way; poll `GET .../send_agent/{run_id}` for its run (Plan 02b)."""

    run_id: str


class AgentTasks(BaseModel):
    """Which words the built-in agent's tasks take on the Desk (plan 09, C2): `rivera` on the copy's own Desk, else
    the business type setup stored for it (`other` without one). Tasks are listed in page order; the payment tasks
    need an enabled agent payment tool. Keys, never words: the page holds every word."""

    task_set: DemoTaskSet
    tasks: list[DemoTask]


class AgentTurn(BaseModel):
    """One side of an exchange in a built-in agent's run: the agent's request (`n`-th), or the Desk's answer to it,
    with the blocks and signed statuses the kernel checked and the Desk showed the agent.

    An agent turn's `text` is the message the agent sent the Desk in that request, exactly as signed and sent (at most
    2,000 characters, the agent's send limit), shown to the visitor who launched it as a visitor's own message is
    (owner decision, 2026-11-01). The agent's model writes it from a fixed task line that code picks from signed
    templates, keyed by the Desk's setup business type, with no owner or visitor text, and the Desk's kernel-checked
    replies alone, and the kernel doesn't check it. It is untrusted plain text, the agent's words and never the
    Desk's: the page shows it quoted and labelled as the agent's. A Desk turn's `text` is null; the Desk's replies stay the kernel-checked
    blocks and statuses."""

    author: Literal["agent", "desk"]
    n: int                                # the exchange: the agent's n-th request and the Desk's answer to it
    text: str | None
    blocks: list[RenderedBlock]
    receipts: list[Annotated[EvReceipt | EvHeld | EvResolved, Field(discriminator="type")]]


class DemoAgentRun(BaseModel):
    """`GET /api/public/desks/{slug}/send_agent/{run_id}`: a built-in agent's run as its launcher's panel shows it,
    kept in the process's memory for an hour (Plan 02b)."""

    run_id: str
    launcher_session_id: str
    slug: str
    task: DemoTask
    state: Literal["running", "done", "failed"]
    turns: list[AgentTurn]


# How a demo visitor's run ended: its brief done (`finished`), the owner stopped it, the chat's session closed or its
# stream ended (`chat_ended`), a cap (`limit`: ten messages, twelve model calls or fifteen minutes), the owner who took
# the chat over stayed quiet (`owner_silent`), today's model budget (`budget`), or a model or HTTP failure (`failed`).
DemoVisitorEnded = Literal["finished", "stopped_by_owner", "chat_ended", "limit", "owner_silent", "budget", "failed"]


class DemoVisitorRun(BaseModel):
    """A demo visitor's run: an AI that plays a customer in a visitor chat on the owner's own Desk
    (`demo_visitors.py`), kept in the process's memory for an hour. `first_name` is its persona's, fixed text;
    `session_id` is its visitor session, None until it is open; `messages_sent` counts the messages it sent the Desk;
    `ended` says how a run that is no longer `running` ended (`done`: finished, limit or owner_silent; `stopped`:
    stopped_by_owner or chat_ended; `failed`: budget or failed)."""

    run_id: str
    desk_id: str
    first_name: str
    session_id: str | None
    state: Literal["running", "done", "stopped", "failed"]
    messages_sent: int
    ended: DemoVisitorEnded | None


class DemoVisitorStarted(BaseModel):
    """202 from `POST /api/owner/desks/{desk_id}/demo_visitor`: the demo visitor's run and its open visitor session,
    on `desk_id`. While one runs in the copy, starting another answers that one, so `desk_id` can be another of the
    copy's Desks. Poll `GET /api/owner/desks/{desk_id}/demo_visitor` for how it stands."""

    run_id: str
    desk_id: str
    session_id: str


# The owner's answers (Task 8) ------------------------------------------------------------------------------------


class ApprovalAnswerIn(BaseModel):
    """`POST /api/owner/approvals/{decision_id}/answer`: one of the four answers to a held request."""

    model_config = ConfigDict(extra="forbid")

    answer: ApprovalAnswer


class ApprovalAnswerOut(BaseModel):
    """The answered request as the kernel signed it, how its execution went (an allow runs inside the answer; None
    for a denial or a request the rules no longer allow), and the rule cards an `allow_person` or `deny_always`
    answer drafts, which the owner proves and confirms through the rules routes (Plan 02b)."""

    decision: Decision
    execution_state: Literal["succeeded", "failed", "unknown"] | None      # the kernel's `ExecResult.state`
    card_diff: list[RuleCard] | None


class AlreadyResolved(BaseModel):
    """409: the request was no longer waiting for an answer (answered before, expired or cancelled); `decision` is
    how it stands now, as the kernel signed it."""

    error: Literal["already_resolved"] = "already_resolved"
    decision: Decision


# The owner's reads (Task 9) --------------------------------------------------------------------------------------


class BusinessOut(BaseModel):
    """`GET /api/owner/desks`: one of the copy's businesses, with its Desks (the Desk switcher)."""

    business_id: str
    name: str
    owner_display_name: str
    timezone: str                         # IANA name: Today's windows are in it
    brand: dict[str, str]                 # as the public page serves it (`effective_brand`): teal when none is stored
    desks: list[DeskSummary]


class AnsweringIn(BaseModel):
    """`PUT /api/owner/desks/{desk_id}/answering`: the Answering switch. Off, visitors can only leave their details
    or ask for a callback."""

    model_config = ConfigDict(extra="forbid")

    on: bool


class NeedsYouSession(BaseModel):
    """Who a held request or a callback request came from. `display_name` is the verified person's, else the name
    the session's lead gave (untrusted text), else a demo visitor's persona's first name, else None. `demo_visitor`
    is true for a demo visitor's chat (`owner_reads.demo_visitors`), so Needs you never passes it off as a real
    customer's."""

    session_id: str
    kind: ActorKind
    display_name: str | None
    verified: bool
    assurance: Assurance
    demo_visitor: bool = False              # an AI the owner started plays the customer (`owner_reads.demo_visitors`)


class Handoff(BaseModel):
    """A conversation handed to the owner (`kernel_ro.handoffs`), of one of two kinds:

    - `callback`: a visitor's call-back request. `reason` is "<name> · <contact> · <reason>" as the visitor typed them
      (untrusted text); `callback_window` is "<start>/<end>" in ISO 8601, or None without one.
    - `card`: the handoff card the session saw (a passed reply citing it, or a blocked final draft or one no rewrite
      fixes). `reason` is the kernel's own template ("The Desk handed this to you."), and `callback_window` is None:
      no call back was promised.

    A null window alone can't tell them apart; `kind` does, and a row's kind never changes. A card handoff opens
    none in the owner's preview, while a held request awaits the owner, or while the session has an open handoff. A
    call-back request closes the session's open card handoff (it reads `done` from then on) and opens its own
    `callback` row with a new ID."""

    handoff_id: str
    session_id: str
    reason: str
    callback_window: str | None
    status: Literal["open", "done"]
    kind: Literal["callback", "card"]


class NeedsYouItem(BaseModel):
    """`GET /api/owner/desks/{desk_id}/needs_you`: a held request (`decision`, as the kernel signed it when read, which
    applies expiry, with `held_by`, the reason of the rule card that held it, and `held_at`, when it was decided) or
    an open handoff (`handoff`: a call-back request or the handoff card's), never both; who it came from; what they
    wrote last (`from_the_visitor`: their previous and last messages, each a one-line glimpse of at most 200
    characters, joined with " · "; their own untrusted words); and, on a handoff only, the conversation's newest
    AI-written triage summary (`claude_summary`: what the person asked for and what the Desk did, for the owner alone,
    shown as "Claude's note on what the Desk stopped: {summary}" and never quoted as the visitor's), else None. A held
    request asks the owner for a decision, so neither it nor a handoff in a session with one awaiting the owner carries
    AI-written text: a visitor could steer a summary to sway an approval."""

    decision: Decision | None
    held_by: str | None
    held_at: AwareDatetime | None
    handoff: Handoff | None
    session: NeedsYouSession
    from_the_visitor: str | None
    claude_summary: str | None

    @model_validator(mode="after")
    def _one_of(self) -> "NeedsYouItem":
        if (self.decision is None) == (self.handoff is None):
            raise ValueError("an item is a held request or a callback request")
        if self.decision is None and (self.held_by is not None or self.held_at is not None):
            raise ValueError("only a held request has held_by and held_at")
        if self.decision is not None and self.held_at is None:
            raise ValueError("a held request has held_at")
        return self


RefusalCause = Literal[
    "owner_rule", "not_verified", "not_their_record", "recipient", "no_such_slot", "unknown_item", "over_quote_ceiling",
    "quote_unpayable", "no_such_charge", "not_refundable", "no_such_document", "no_amount",
    "tool_not_available", "incomplete_request", "paused", "no_rules", "rules_unchecked", "agent_pay_out",
    "agent_limit", "other_copy", "no_rule",
]


class ConversationSummary(BaseModel):
    """A conversation on the Desk: who it is with (`display_name` as `NeedsYouSession`'s), who has it (`mode`), when
    anything last happened in it, how its requests stand (decisions by state), and whether it is the owner's own
    preview. `latest_visitor_text` is the newest message the visitor typed, untrusted text shown as typed, with its
    whitespace runs collapsed to single spaces and trimmed, and cut to 199 characters and "…" when longer than 200;
    never Claude's words. It is null for an agent's conversation, the owner's preview and a visitor who hasn't
    written yet. `latest_outcome` is the newest decisive event, derived from stored events, never task names, prose
    or positive counts; otherwise null. An agent's is an executed booking/mandate charge with its matching shown,
    checked done card and executed receipt in the same turn, or a Desk-authored payment confirmation; an actual
    refusal at decide/execution gives `turned_down`, and a later hold or handoff clears success. A visitor's (never
    the owner's preview) comes from the kernel's decisions, payment links and handoffs alone, timed by their ledger
    entries: an executed quote (`quoted`), booking (`visit_booked`), lead (`lead_captured`) or document release
    (`document_sent`), a payment link paid (`deposit_paid`), a refusal at decide/execution (`turned_down`), the
    owner declining a held request (`owner_declined`), or a call-back the owner marked done (`called_back`); a later
    request still held, expired or cancelled, or a handoff card opening, clears it to null.

    An agent's outcome carries the facts behind it, read from the kernel's rows, never from anyone's words:
    `latest_outcome_starts_at`, the booking's start (`visit_booked`, from the booking decision's action);
    `latest_outcome_cents`, the amount paid (`deposit_paid`: a mandate charge's action amount, or, for a Desk-authored
    payment confirmation, its payment link's); and `latest_outcome_cause`, why its request was refused at decide
    (`turned_down`, the closed code `BriefingItem.cause` uses; null for a refusal at execution). Each is null when its
    outcome isn't the newest, when the fact can't be read, and for a visitor's conversation or the owner's preview.

    `demo_visitor` is true for a demo visitor's chat (an AI the owner started to play a customer,
    `owner_reads.demo_visitors`), listed as soon as it opens; with no verified or lead name, its `display_name` is its
    persona's first name; and `demo_visitor_run_id` names the run that opened it, None for a mark written before
    runs were recorded there."""

    session_id: str
    kind: ActorKind
    display_name: str | None
    verified: bool
    mode: SessionMode
    last_activity: AwareDatetime
    outcome_counts: dict[DecisionState, int]
    owner_preview: bool
    latest_visitor_text: str | None
    latest_outcome: Literal["visit_booked", "deposit_paid", "turned_down", "quoted", "lead_captured",
                            "owner_declined", "called_back", "document_sent"] | None
    replayed: bool = False                  # recorded history written into the copy (`owner_reads.history_sessions`)
    latest_outcome_starts_at: AwareDatetime | None = None
    latest_outcome_cents: int | None = None
    latest_outcome_cause: RefusalCause | None = None
    demo_visitor: bool = False              # an AI the owner started plays the customer (`owner_reads.demo_visitors`)
    demo_visitor_run_id: str | None = None  # the demo visitor run that opened the chat, when its mark names one


class OwnerTranscript(BaseModel):
    """`GET /api/owner/conversations/{session_id}?after=n`: the session's state and its transcript after the cursor, as
    the owner sees it (agent text, whispers, translations and triage included; model, note and context rows never).
    `typing_until` is when the visitor's typing dots stop, while the visitor is typing, else null (Plan 02b): presence,
    kept in the API's memory and shown to the owner alone."""

    state: SessionState
    items: list[OwnerTranscriptItem]
    typing_until: AwareDatetime | None
    replayed: bool = False                  # recorded history: no one adds to it and the owner can't take it over
    demo_visitor: bool = False              # a demo visitor's chat: an AI the owner started plays the customer
    demo_visitor_run_id: str | None = None  # the demo visitor run that opened it (`GET …/demo_visitor/{run_id}`)


# The owner in a conversation (Plan 02b) ----------------------------------------------------------------------------


class GenerationIn(BaseModel):
    """`POST /api/owner/conversations/{session_id}/{takeover,handback,resume,typing}`: the session's generation as the
    owner last read it; a change made at a generation the session has since left is refused."""

    model_config = ConfigDict(extra="forbid")

    generation: Annotated[int, Field(ge=0)]


class OwnerMessageIn(BaseModel):
    """`POST /api/owner/conversations/{session_id}/messages`: the owner's words, said to the visitor once the owner has
    taken the conversation over (`say`), or a private note for Claude (`whisper`)."""

    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, StringConstraints(min_length=1, max_length=2000)]
    kind: Literal["say", "whisper"]


class BriefingItem(BaseModel):
    """One thing that happened since last night. `ref_id` is what it links to: the refused decision for `turned_down`,
    the decision for a booking, the `lead_id`, the session for an answer. `line` is the kernel's owner text for a
    refusal or a booking, a lead's note (untrusted, as the visitor or Claude wrote it), else None. `cause` is required
    and nullable: the refused request's closed cause code for `turned_down`, null for other kinds and unmapped
    refusals. Stopped drafts stay on Safety and out of the briefing. `demo_visitor` is true for a thing in a demo
    visitor's chat (`owner_reads.demo_visitors`), whose `display_name` is then its persona's first name when the chat
    gave no name of its own."""

    kind: Literal["turned_down", "booking", "lead", "answer"]
    at: AwareDatetime
    session_id: str | None
    display_name: str | None
    ref_id: str
    line: str | None
    cause: RefusalCause | None
    demo_visitor: bool = False              # an AI the owner started plays the customer (`owner_reads.demo_visitors`)


class BriefingNewest(BaseModel):
    """The newest refused request, booking, and lead or answer (the lead when both share a time); None when none."""

    turned_down: BriefingItem | None
    booking: BriefingItem | None
    lead_or_answer: BriefingItem | None


class Briefing(BaseModel):
    """"Since last night": from 18:00 yesterday in the business's time zone (`since`) to now. `answers` counts the
    list's `answer` items, the conversations Claude answered alone; `total` is the length of the full list
    (`BriefingList`)."""

    since: AwareDatetime
    conversations: int
    bookings: int
    leads: int
    turned_down: int
    answers: int
    total: int
    newest: BriefingNewest


class BriefingList(BaseModel):
    """`GET /api/owner/desks/{desk_id}/briefing`: every item since last night, newest first."""

    since: AwareDatetime
    items: list[BriefingItem]


class WeekDay(BaseModel):
    """One date of "Last 7 days", counted as `ThisWeek` counts: `stopped` counts refused requests that day
    (owner decision, 2026-10-31). Claude's stopped drafts are listed on Safety but not counted."""

    date: LocalDate                        # a local date in the business's time zone
    conversations: int
    bookings: int
    stopped: int


class ThisWeek(BaseModel):
    """"Last 7 days": the seven local dates ending today, in `timezone`. Totals run from 00:00 on `start` to now;
    `booked_cents` adds, for each booking, the newest quote of its conversation made at or before it that no earlier
    booking took (none: 0); `handled + stepped_in == conversations`; `days` holds all seven, oldest first, the last
    one `end`. `stopped` counts refused requests from visitors and agents (owner decision, 2026-10-31).
    Safety lists Claude's stopped drafts too, without counting them; the briefing omits them."""

    timezone: str
    start: LocalDate
    end: LocalDate
    bookings: int
    booked_cents: int
    conversations: int
    handled: int
    stepped_in: int
    stopped: int
    days: list[WeekDay]


class RecordedHistory(BaseModel):
    """Which of Today's sections count recorded history: the night the kernel replayed into the copy when it was made
    (Plan 01d), which the owner's screens label "Includes recorded history". A replay holds only finished things, so
    `needs_you` stays false; it keeps the shape the web reads."""

    needs_you: bool
    briefing: bool
    this_week: bool


class Today(BaseModel):
    """`GET /api/owner/desks/{desk_id}/today`, computed from the rows on each read. `live` holds the conversations with
    activity in the last 5 minutes; `recorded_history` says which sections count replayed rows."""

    greeting_name: str
    needs_you_count: int
    live: list[ConversationSummary]
    briefing: Briefing
    this_week: ThisWeek
    recorded_history: RecordedHistory


class Attempt(BaseModel):
    """A Safety entry (`GET /api/owner/desks/{desk_id}/safety`): a refused decision (`ref_id` its
    `decision_id`) or a reply of Claude's it blocked (`ref_id` the reply entry's `seq`, as text). `reason_plain` is the
    kernel's owner text for a decision, or a line the API composes for a reply; `origin` is the ledger entry's;
    `ledger_seq` is the entry to show it with. `triage` is AI-written, when there is one (Plan 02b). `cause` is a
    closed code for a refused request, from the decision's `policy_ids`, its ledger summary's `reason`/`check`
    and the session's verified state;
    the web holds its words. It is null for held requests, stopped drafts and unmapped refusals."""

    ref_id: str
    kind: Literal["refused", "held", "reply_blocked"]
    reason_plain: str
    card_ids: list[str]
    origin: Literal["kernel", "api"]
    created_at: AwareDatetime
    triage: Triage | None
    ledger_seq: int
    cause: RefusalCause | None

    @model_validator(mode="after")
    def _cause_requires_refusal(self) -> "Attempt":
        if self.cause is not None and self.kind != "refused":
            raise ValueError("Only refused requests can have a cause")
        return self


# The mock checkout (Plan 02b) ------------------------------------------------------------------------------------


class PaymentConflict(BaseModel):
    """409 from the checkout's complete or cancel: the link is no longer `issued`. `state` is how it reads now and
    `cancel_reason` why it was cancelled, `rules_changed` when a rule change cancelled it, so the checkout page can say
    so (master plan, "Payment links")."""

    error: Literal["kernel"] = "kernel"
    code: Literal["conflict"] = "conflict"
    state: PaymentLinkState
    cancel_reason: Literal["rules_changed"] | None


# Setup (Plan 02b) --------------------------------------------------------------------------------------------------

# Plan 01a's owner name pattern, which the kernel checks every owner name against: ^[A-Za-zÀ-ÿ' -]{1,40}$
OWNER_NAME_CHARS = "A-Za-zÀ-ÿ' -"
OWNER_NAME_PATTERN = rf"^[{OWNER_NAME_CHARS}]{{1,40}}$"
# What setup can wait on: a topic (`QuestionKey`), then, once the plan is closed, whether to add the owner as a test
# client (`setup.TEST_CLIENT_OFFER`). Code asks that one and reads a yes or a no with no model turn (anything else goes
# to setup's consultant as the owner's answer), so it is no topic and no structured output names it.
TestClientQuestion = Literal["test_client"]
SetupQuestion = Literal[QuestionKey, TestClientQuestion]


@cache
def _time_zones() -> frozenset[str]:
    return frozenset(available_timezones())


class SetupStartIn(BaseModel):
    """`POST /api/owner/setup`: the owner's own words about the business, the business's time zone (an IANA name)
    and, if they give it, the name customers should see for them, which wins over one taken from the words. A name
    the owner types is used as typed (extra spaces aside), so it must fit the kernel's owner name pattern (letters,
    spaces, apostrophes and hyphens, up to 40), else 422 before Claude is asked. The `idempotency_key`, one per click
    and required (422 without one), makes a repeat answer the interview the first made instead of making another."""

    model_config = ConfigDict(extra="forbid")

    description: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1500)]
    timezone: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    owner_display_name: Annotated[str, StringConstraints(strip_whitespace=True,
                                                         pattern=OWNER_NAME_PATTERN)] | None = None
    idempotency_key: IdempotencyKey

    @field_validator("timezone")
    @classmethod
    def _known_zone(cls, value: str) -> str:
        if value not in _time_zones():
            raise ValueError("timezone is an IANA time zone name")
        return value


class SetupConsentIn(BaseModel):
    """`POST /api/owner/setup/{id}/consent`: whether Claude may read the owner's Claude memory and website."""

    model_config = ConfigDict(extra="forbid")

    allow: bool


class SetupAnswerIn(BaseModel):
    """`POST /api/owner/setup/{id}/answer`: the owner's text and exactly one waiting question or card id.
    Naming the ask prevents a repeated answer from answering the next one."""

    model_config = ConfigDict(extra="forbid")

    question: SetupQuestion | None = None
    card: str | None = None
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]

    @model_validator(mode="after")
    def one_ask(self) -> "SetupAnswerIn":
        if (self.question is None) == (self.card is None):
            raise ValueError("exactly one of question and card is required")
        return self


class SetupProposalIn(BaseModel):
    """The owner's decision on a setup proposal, with optional changes when accepting it."""

    model_config = ConfigDict(extra="forbid")

    accept: bool
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60,
                                            pattern=r"^[^\n\r]*$")] | None = None
    amount_cents: Cents | None = None
    autonomy: Autonomy | None = None

    @field_validator("title", mode="before")
    @classmethod
    def one_line_title(cls, value: object) -> object:
        if isinstance(value, str) and ("\n" in value or "\r" in value):
            raise ValueError("proposal title must be one line")
        return value

    @model_validator(mode="after")
    def accepting_changes(self) -> "SetupProposalIn":
        changes = self.model_fields_set - {"accept"}
        if changes and (not self.accept or any(getattr(self, name) is None for name in changes)):
            raise ValueError("proposal changes require accepting and a value")
        return self


class SetupReopenIn(BaseModel):
    """`POST /api/owner/setup/{id}/reopen`: "Change something", the owner's message to Claude from a step after the
    questions, which takes setup back to its chat. The `idempotency_key`, one per send and required (422 without one),
    makes a repeat answer the interview as the first left it instead of sending the message twice."""

    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    idempotency_key: IdempotencyKey


class SetupSuggestionsIn(BaseModel):
    """Finish setup questions with the current suggestions; no additional answers are supplied."""

    model_config = ConfigDict(extra="forbid")


class SetupMessage(BaseModel):
    """One line of the setup conversation, owner-facing: Claude's, the owner's, or an inline label for a read of the
    owner's memory or website (`tool_label`). Choices belong only to a Claude question with choices; a card belongs
    only to a card message, with role `claude` and empty text. `owner_decided` marks a card the owner decided
    themselves, by a click or a typed answer; a card setup settled for them (as "Use your suggestions" does) stays
    false. Read-only: it only says what happened."""

    role: Literal["claude", "owner", "tool_label"]
    text: str
    choices: list[Choice] = []
    card: ProposalCard | None = None
    owner_decided: bool = False


class SetupPublicLine(BaseModel):
    """A nonblank setup charter line and whether the owner has confirmed its text. `held` marks a line the kernel's
    public-text checks held back (the setup state's `held_policy_keys`, the contact included): its stored words stay
    off the charter until the owner rewords it."""

    key: str
    text: str
    source: Literal["owner", "suggested"]
    editable: bool
    held: bool


class SetupPublicHours(BaseModel):
    source: Literal["owner", "suggested"]
    windows: list[HoursWindow]


class SetupPublicPriceItem(BaseModel):
    item_id: str
    title: str
    unit_cents: int


class SetupPublicPrices(BaseModel):
    source: Literal["owner", "suggested"]
    items: list[SetupPublicPriceItem]


class SetupPublicLines(BaseModel):
    revision: str
    lines: list[SetupPublicLine]
    hours: SetupPublicHours | None
    prices: SetupPublicPrices | None


class SetupPublicLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1500)]


class SetupPublicLineError(BaseModel):
    error: Literal["line_refused", "not_editable", "not_suggested"]
    key: str | None = None
    reason: list[str] | None = None


class SetupPublicLinesConfirmIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keys: Annotated[list[str], Field(min_length=1)]
    revision: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class SetupState(BaseModel):
    """A setup interview as it stands: its Desk, made at the start with Answering off, the step it is at, whether the
    owner let Claude read their memory and website (None until asked), the question waiting for an answer (None
    before consent, while busy and after the last one; `test_client` while the test-client offer at the plan's end
    waits), whether an owner turn is pending (`busy`), and the conversation so far. Its messages start at Claude's
    consent question: the owner's opening description isn't shown back to them."""

    interview_id: str
    desk_id: str
    slug: str
    step: SetupStep
    consent: bool | None
    question: SetupQuestion | None
    pending_card: str | None = None
    busy: bool = False
    held_policy_keys: list[str] = Field(description="Charter claim keys, such as a policy line or the public contact, "
                                       "withheld by the kernel's public-text checks; empty when nothing was held at "
                                       "the latest charter write.")
    messages: list[SetupMessage]


# Setup's rules (Plan 02b, Task 7) ------------------------------------------------------------------------------


class CoveringCard(BaseModel):
    """A card of the active rules that covers a tool: its own (`shared` false), or one on an effect the tool has, which
    every tool with that effect shares. A default card is the compiler's ask for a tool no card for anyone covers."""

    card_id: str
    mode: Literal["auto", "ask", "never"]
    reason: str
    shared: bool


class ToolRow(BaseModel):
    """A tool of the Desk as the kernel lists it (`kernel_ro.tools`): its effects, whether it can be undone, its
    status (`needs_review` until the owner confirms a connected tool), the description Claude sees and, for a
    connected tool, the hash of the definition it is pinned to and a changed definition waiting for review; and the
    active rules' cards that cover it, default asks included, in card order (Plan 02b, Task 9)."""

    tool: str
    source: Literal["native", "mcp", "business"]
    effects: list[str]
    reversible: bool
    status: Literal["enabled", "needs_review", "disabled"]
    description_confirmed: str
    definition_sha256: str | None
    pending_definition_text: str | None   # a changed definition, untrusted text to show as quoted
    pending_sha256: str | None
    cards: list[CoveringCard]
    business: BusinessToolDef | None = None


class SetupTools(BaseModel):
    """`GET /api/owner/setup/{id}/tools`: the new Desk's tools, and the connection it can still add (the
    mock payments server, until it is connected)."""

    tools: list[ToolRow]
    connectable: list[Literal["mock_payments"]]


class CardDiff(BaseModel):
    """How a draft's cards differ from the active version's, by `card_id`, default cards left out; `changed` pairs
    each card before and after."""

    added: list[RuleCard]
    removed: list[RuleCard]
    changed: list[tuple[RuleCard, RuleCard]]


class RulesSummary(BaseModel):
    """A draft's cards in the owner's words: each card's reason, by what it does (once each)."""

    on_its_own: list[str]
    asks_you: list[str]
    never: list[str]


class RulesDraft(BaseModel):
    """A rules version the kernel compiled and proved, for the owner to read and confirm: its owner cards (default
    asks left out), how they differ from the active version's (None in setup), the money cap its money cards are held
    to, the kernel's proof, and a summary."""

    version: int
    cards: list[RuleCard]
    diff: CardDiff | None
    auto_money_cap_cents: int
    proof: ProofReport
    summary: RulesSummary


class RulesChanged(BaseModel):
    """409 from a confirm: the rules changed after the draft was made, so the same cards were drafted again on the
    rules now in force, and `draft` is the new version to read and confirm."""

    error: Literal["rules_changed_since_draft"] = "rules_changed_since_draft"
    draft: RulesDraft


class ProvingRetry(BaseModel):
    """The request to send again, unchanged: its path and its JSON body (None when it has none)."""

    path: str
    body: dict[str, Any] | None


class ProvingPending(BaseModel):
    """202: the rules are still being drafted or checked. Send `retry` again in a few seconds: it picks up the same
    work, or its answer once done."""

    retry: ProvingRetry


class Situation(BaseModel):
    """A situation Claude wrote to try against the drafted rules: who brings it, the probe code built for it (a
    hypothetical caller and request, run nowhere) and what the owner's answers say should happen."""

    title: str                            # Claude's words, from the owner's answers (owner-facing)
    who: SituationWho
    probe: Probe
    expected: PlannedOutcome


class SituationResult(BaseModel):
    """What the drafted rules do with a situation (`result`, the kernel's), and whether that matches what was
    planned: a plan of `allow_if_reviewed` matches a result that depends on the reviewer, decided by an auto rule
    with `review`; any other plan matches the same outcome when it doesn't depend on the reviewer."""

    situation: Situation
    result: ProbeResult
    matches: bool


class SafetyRow(BaseModel):
    """One thing a bad actor would try (`label`, and `tries`, what they'd say), the kernel's verdict on it against
    the drafted rules (its outcome and `reason_plain`, shown verbatim), and whether it was stopped: refused, or held
    for the owner where that stops it, and never when it depends on the reviewer agreeing."""

    label: str
    tries: str
    result: ProbeResult
    blocked: bool


class SafetyCheck(BaseModel):
    """`POST /api/owner/policy/setup/{id}/safety_check`: what a bad actor would try against the drafted rules,
    run nowhere. `total` counts the rows tried (one lacking a stand-in price is left out), `blocked` those stopped, and
    `seconds` how long the kernel took."""

    rows: list[SafetyRow]
    blocked: int
    total: int
    seconds: float


class WentLive(BaseModel):
    """The Desk answers the public now, at `public_url`."""

    public_url: str
    slug: str


# Desk management, people and reports (Plan 02b, Task 8) ------------------------------------------------------------


class PersonOnRecord(BaseModel):
    """Someone on record on the Desk. Verification codes go only to their contact, which leaves the kernel masked."""

    person_id: str
    display_name: str
    masked_contact: str


class Lead(BaseModel):
    """Details a visitor left: the name and note as they typed them (untrusted text, either may be missing)."""

    lead_id: str
    display_name: str | None
    note: str | None
    created_at: AwareDatetime
    replayed: bool = False                  # recorded history: left in a session written into the copy, not a live one
    demo_visitor: bool = False              # left in a demo visitor's chat (`owner_reads.demo_visitors`)


class PeopleOut(BaseModel):
    """`GET /api/owner/desks/{desk_id}/people`: the people on record, in the order they were added, and the leads,
    newest first."""

    people: list[PersonOnRecord]
    leads: list[Lead]


class Reports(BaseModel):
    """`GET /api/owner/desks/{desk_id}/reports?days=n`: the last `n` local dates in the business's time zone, today
    included, counted as Today's "Last 7 days" is. `bookings` are the bookings made; `paid_cents` the money paid,
    through payment links and agents' spending limits; `handled_by_claude` and `needed_you` split the conversations
    into those Claude handled alone and those the owner stepped into. `recorded_history` is true when any of these
    counts includes the night the kernel replayed into the copy (as `RecordedHistory` is for Today)."""

    bookings: int
    paid_cents: int
    handled_by_claude: int
    needed_you: int
    recorded_history: bool


# Rules after setup (Plan 02b, Task 9) ------------------------------------------------------------------------------


class RulesView(BaseModel):
    """`GET /api/owner/desks/{desk_id}/rules`: the active rules version, each tool of the Desk with the cards that
    cover it, and the preset the active owner cards are, if they are exactly one (else None: there is no "custom"
    state)."""

    active: PolicyVersion
    tools: list[ToolRow]
    preset: PresetName | None


# The reason the kernel writes on the card an "allow for this person" approval drafts (Plan 01a, `card_id`
# `person-{person or agent key}-{tool}`): it quotes the person's display name, which has no bound.
KERNEL_PERSON_REASON = re.compile(r"Allowed for .+ after you approved a request like this\.", re.DOTALL)


def kernel_person_card(card: RuleCard) -> bool:
    """Whether the card is one the kernel drafts for one person or agent key from an approval (an answer's
    `card_diff`): its ID and reason as the kernel writes them, for the person or agent key it names."""
    scope = {"person": card.person_id, "agent": card.agent_key_id}.get(card.who)
    return (scope is not None and card.card_id == f"person-{scope}-{card.applies_to}"
            and KERNEL_PERSON_REASON.fullmatch(card.reason) is not None)


def _bounded_card(card: RuleCard) -> RuleCard:
    """A card the owner's app sends, within the bounds Claude writes cards to in a rules chat (`prompts.ChatCard`),
    save the reason of a card the kernel drafted for one person or agent key (`kernel_person_card`), which quotes
    their name however long it is."""
    if len(card.card_id) > CARD_ID_MAX_LENGTH:
        raise ValueError(f"a card_id is at most {CARD_ID_MAX_LENGTH} characters")
    if len(card.reason) > CARD_REASON_MAX_LENGTH and not kernel_person_card(card):
        raise ValueError(f"a reason is at most {CARD_REASON_MAX_LENGTH} characters")
    return card


OwnerCard = Annotated[RuleCard, AfterValidator(_bounded_card)]


class DraftCardsIn(BaseModel):
    """`POST /api/owner/policy/{desk_id}/draft`: the owner cards as they should stand, on the version they were read
    from (the kernel answers 409 `conflict` once another is active). At most 60 cards (default asks need not be
    sent: the kernel adds its own), each `card_id` at most 128 characters and each `reason` at most 200, as a rules
    chat writes them; beyond any of these, 422 `invalid`. A card the kernel drafted for one person or agent from an
    approval keeps its reason as the kernel wrote it, however long the name it quotes."""

    model_config = ConfigDict(extra="forbid")

    cards: list[OwnerCard] = Field(max_length=OWNER_CARDS_MAX)
    expected_parent: int


class DraftAddIn(BaseModel):
    """`POST /api/owner/policy/{desk_id}/draft`: cards to add to the active owner cards, such as an approval's
    `card_diff`; a card with the ID of an active one takes its place. Each card is bounded as `DraftCardsIn`'s are,
    and so is the Desk's count of owner cards once these are added: beyond any bound, 422 `invalid`."""

    model_config = ConfigDict(extra="forbid")

    add: list[OwnerCard] = Field(min_length=1, max_length=OWNER_CARDS_MAX)


class ToolsConfirmIn(BaseModel):
    """The shared batch review body; the checked Desk ID comes from the route."""

    model_config = ConfigDict(extra="forbid")

    tools: Annotated[list[ToolPin], ToolsConfirmRequest.model_fields["tools"]]
    enable: bool

    @model_validator(mode="after")
    def _each_tool_once(self) -> Self:
        each_tool_once(self.tools)
        return self


class ConfirmRulesIn(BaseModel):
    """`POST /api/owner/policy/{desk_id}/confirm`: the drafted version the owner read and confirms."""

    model_config = ConfigDict(extra="forbid")

    version: int


class MoneyCapIn(BaseModel):
    """`POST /api/owner/policy/{desk_id}/money_cap`: the money cap to draft the active rules at, the most an auto rule
    may take or pay out in one action without asking, in cents: from 0 (every payment asks) to the $10,000 platform
    ceiling. Above the ceiling, 422 `above_platform_ceiling`; anything but a whole number of cents from 0, 422
    `invalid`."""

    model_config = ConfigDict(extra="forbid")

    auto_money_cap_cents: StrictInt = Field(ge=0, json_schema_extra={"maximum": AUTO_MONEY_HARD_CAP_CENTS})


class AboveMoneyCap(BaseModel):
    """422 from a drafting route: a new or changed card would take or pay out more on its own than the Desk's money
    cap, `cap_cents` (0 when unset), so nothing was drafted ("That's above your limit of $X. Raise the limit
    first.")."""

    error: Literal["above_money_cap"] = "above_money_cap"
    cap_cents: int


class ChangesAlwaysOn(BaseModel):
    """422 from a drafting route: the cards named in `card_ids`, in the draft's order, would change starting a
    verification, which is always on (codes go only to the contact on record, under the built-in rule), so nothing
    was drafted."""

    error: Literal["changes_always_on"] = "changes_always_on"
    card_ids: list[str]


class RuleChatIn(BaseModel):
    """`POST /api/owner/policy/{desk_id}/chat`: what the owner asks Claude about the rules, in their own words."""

    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]


class RuleChatOut(BaseModel):
    """Claude's reply to the owner (AI-written, owner-facing) and, when they asked for a change, the draft the kernel
    compiled and proved; None for a question, with nothing drafted."""

    answer: str
    draft: RulesDraft | None


class PresetIn(BaseModel):
    """`POST /api/owner/policy/{desk_id}/preset`: "Ask me first for everything" (`ask_first`) or "Recommended rules"
    (`auto`)."""

    model_config = ConfigDict(extra="forbid")

    preset: PresetName


class Suggestion(BaseModel):
    """A rule the owner's own approvals suggest: they approved `count` requests of `tool` in the last 30 days and no
    auto card covers it, so `card` would let Claude handle them. `text` is the owner-facing line; on a money tool the
    card allows no more than the largest amount approved, and never more than the money cap."""

    tool: str
    count: int
    text: str
    card: RuleCard


class SimulateChangeIn(BaseModel):
    """`POST /api/owner/desks/{desk_id}/tools/simulate_change`: the connected tool whose definition the demo changes."""

    model_config = ConfigDict(extra="forbid")

    tool: ToolName


class KnowledgeRow(BaseModel):
    """An owner-only read of `kernel_ro.knowledge_items`. `title` and `text` are null exactly when the view
    masks them for a kernel-forced owner-only item. `created_at` is when it was first added, null for legacy rows
    without a timestamp. Every field is always sent."""

    item_id: str
    title: str | None
    text: str | None
    readers: list[str]
    source: KnowledgeSource
    created_at: AwareDatetime | None


class KnowledgeIn(BaseModel):
    """`POST /api/owner/desks/{desk_id}/knowledge`: something the owner tells Claude about the business (untrusted
    text, never policy), owner-only (`Label(readers=["owner"])`) or public (`Label(readers=["public"])`); posting an
    item again under its `item_id` replaces it, so marking one public is posting it with the public label."""

    model_config = ConfigDict(extra="forbid")

    item: KnowledgeItem


class DocumentIn(BaseModel):
    """`POST /api/owner/desks/{desk_id}/documents`: a document for the Desk, the owner's alone or a customer's on
    record (`record_owner_ref`), released only through the kernel's single-use links."""

    model_config = ConfigDict(extra="forbid")

    document: SeedDocument


class ToolDecisionRow(BaseModel):
    """One decision on a tool, as its page lists it: whose session asked (`display_name` as `NeedsYouSession`'s,
    untrusted when a visitor typed it), the outcome and where the request stands, the kernel's owner text, when it was
    decided and its ledger entry. `replayed` is true for a decision from the night the kernel replayed into the copy
    (recorded history), and for one whose ledger entry can't be read, which is never shown as live."""

    decision_id: str
    session_id: str
    display_name: str | None
    outcome: Outcome
    state: DecisionState
    reason_plain: str
    owner_plain: str | None = Field(description=(
        "Owner-only kernel reason for an execution refusal, fetched with the owner's credential; null otherwise."))
    created_at: AwareDatetime
    ledger_seq: int
    replayed: bool


class ToolDecisions(BaseModel):
    """`GET /api/owner/desks/{desk_id}/tools/{tool}/decisions`: a page of the tool's decisions on the Desk, newest
    first; `next_before` is the cursor for the next page, None on the last."""

    items: list[ToolDecisionRow]
    next_before: str | None
