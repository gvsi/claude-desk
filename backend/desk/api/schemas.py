"""The API's HTTP shapes (Plan 02a, "Read models" and "Errors"): what its routes take and answer with.

Every error answer is an `ApiError`; `error_responses` documents them in the OpenAPI document.
"""

from collections.abc import Callable
from datetime import date as LocalDate
from typing import Annotated, Any, Literal

from fastapi.routing import APIRoute
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from desk.contracts import (
    ActorKind,
    ApprovalAnswer,
    Assurance,
    Decision,
    DecisionState,
    HoursWindow,
    RuleCard,
    SessionMode,
    SessionState,
)
from desk.events import EvHeld, EvMessage, EvReceipt, EvResolved
from desk.kernel_api import Health


class ApiError(BaseModel):
    """Every error answer: `error` names what went wrong; `code` is the kernel's, when `error` is "kernel";
    `retry_after` is the seconds to wait, on a 429. Fields that don't apply are left out."""

    error: str
    code: str | None = None
    retry_after: int | None = None


def error_responses(*statuses: int) -> dict[int | str, dict[str, Any]]:
    """The OpenAPI entries for a route's error answers, each an `ApiError`."""
    return {status: {"model": ApiError} for status in statuses}


def operation_ids(router: str) -> Callable[[APIRoute], str]:
    """OpenAPI operation IDs `<router>_<name>`, for a router's `generate_unique_id_function`."""
    return lambda route: f"{router}_{route.name}"


class DeskSummary(BaseModel):
    desk_id: str
    slug: str
    name: str
    business_name: str
    hours: list[HoursWindow]
    answering: bool


class CopyOut(BaseModel):
    """The owner's copy: what `POST /api/owner/copies`, `start_over` and `me` answer with."""

    copy_id: str
    desks: list[DeskSummary]


class HealthOut(BaseModel):
    """`GET /api/health`: 200 with the kernel's health, or 503 with `ok` false and no kernel field."""

    ok: bool
    kernel: Health | None


class TranscriptItem(BaseModel):
    """One transcript entry as the visitor sees it: their own words, or an event the API delivered."""

    n: int                                # app.messages.n, the `after` cursor
    kind: Literal["visitor_text", "agent_text", "delivered", "status", "whisper"]
    created_at: AwareDatetime
    text: str | None                      # the author's own words; None for delivered and status items
    event: Annotated[EvMessage | EvReceipt | EvHeld | EvResolved, Field(discriminator="type")] | None


class OwnerTranscriptItem(TranscriptItem):
    """The owner's view adds the AI-written translation and triage, which never reach a visitor."""

    owner_translation: str | None
    triage: str | None


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
    desks: list[DeskSummary]


class AnsweringIn(BaseModel):
    """`PUT /api/owner/desks/{desk_id}/answering`: the Answering switch. Off, visitors can only leave their details
    or ask for a callback."""

    model_config = ConfigDict(extra="forbid")

    on: bool


class NeedsYouSession(BaseModel):
    """Who a held request or a callback request came from. `display_name` is the verified person's, else the name
    the session's lead gave (untrusted text), else None."""

    session_id: str
    kind: ActorKind
    display_name: str | None
    verified: bool
    assurance: Assurance


class Handoff(BaseModel):
    """An open callback request (`kernel_ro.handoffs`). `reason` is "<name> · <contact> · <reason>" as the visitor
    typed them (untrusted text); `callback_window` is "<start>/<end>" in ISO 8601, or None without one."""

    handoff_id: str
    session_id: str
    reason: str
    callback_window: str | None
    status: Literal["open", "done"]


class NeedsYouItem(BaseModel):
    """`GET /api/owner/desks/{desk_id}/needs_you`: a held request (`decision`, as the kernel signed it when read, which
    applies expiry, with `held_by`, the reason of the rule card that held it, and `held_at`, when it was decided) or
    an open callback request (`handoff`), never both; who it came from, and the last thing they wrote (untrusted)."""

    decision: Decision | None
    held_by: str | None
    held_at: AwareDatetime | None
    handoff: Handoff | None
    session: NeedsYouSession
    from_the_visitor: str | None

    @model_validator(mode="after")
    def _one_of(self) -> "NeedsYouItem":
        if (self.decision is None) == (self.handoff is None):
            raise ValueError("an item is a held request or a callback request")
        if self.decision is None and (self.held_by is not None or self.held_at is not None):
            raise ValueError("only a held request has held_by and held_at")
        if self.decision is not None and self.held_at is None:
            raise ValueError("a held request has held_at")
        return self


class ConversationSummary(BaseModel):
    """A conversation on the Desk: who it is with (`display_name` as `NeedsYouSession`'s), who has it (`mode`), when
    anything last happened in it, how its requests stand (decisions by state), and whether it is the owner's own
    preview."""

    session_id: str
    kind: ActorKind
    display_name: str | None
    verified: bool
    mode: SessionMode
    last_activity: AwareDatetime
    outcome_counts: dict[DecisionState, int]
    owner_preview: bool


class OwnerTranscript(BaseModel):
    """`GET /api/owner/conversations/{session_id}?after=n`: the session's state and its transcript after the cursor, as
    the owner sees it (agent text, whispers, translations and triage included; model, note and context rows never)."""

    state: SessionState
    items: list[OwnerTranscriptItem]


class BriefingItem(BaseModel):
    """One thing that happened since last night. `ref_id` is what it links to: the attempt's `ref_id` for `blocked`,
    the decision for a booking, the `lead_id`, the session for an answer. `line` is the kernel's owner text for a
    refusal or a booking, a lead's note (untrusted, as the visitor or Claude wrote it), else None."""

    kind: Literal["blocked", "booking", "lead", "answer"]
    at: AwareDatetime
    session_id: str | None
    display_name: str | None
    ref_id: str
    line: str | None


class BriefingNewest(BaseModel):
    """The newest blocked attempt, booking, and lead or answer (the lead when both share a time); None when none."""

    blocked: BriefingItem | None
    booking: BriefingItem | None
    lead_or_answer: BriefingItem | None


class Briefing(BaseModel):
    """"Since last night": from 18:00 yesterday in the business's time zone (`since`) to now. `total` is the length of
    the full list (`BriefingList`)."""

    since: AwareDatetime
    conversations: int
    bookings: int
    leads: int
    blocked: int
    total: int
    newest: BriefingNewest


class BriefingList(BaseModel):
    """`GET /api/owner/desks/{desk_id}/briefing`: every item since last night, newest first."""

    since: AwareDatetime
    items: list[BriefingItem]


class WeekDay(BaseModel):
    date: LocalDate                        # a local date in the business's time zone
    conversations: int
    bookings: int
    stopped: int


class ThisWeek(BaseModel):
    """"Last 7 days": the seven local dates ending today, in `timezone`. Totals run from 00:00 on `start` to now;
    `booked_cents` adds, for each booking, the newest quote of its conversation made at or before it that no earlier
    booking took (none: 0); `handled + stepped_in == conversations`; `days` holds all seven, oldest first, the last
    one `end`."""

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


class Today(BaseModel):
    """`GET /api/owner/desks/{desk_id}/today`, computed from the rows on each read. `live` holds the conversations with
    activity in the last 5 minutes."""

    greeting_name: str
    needs_you_count: int
    live: list[ConversationSummary]
    briefing: Briefing
    this_week: ThisWeek


class Attempt(BaseModel):
    """An attempt the checkpoint stopped (`GET /api/owner/desks/{desk_id}/safety`): a refused decision (`ref_id` its
    `decision_id`) or a reply of Claude's it blocked (`ref_id` the reply entry's `seq`, as text). `reason_plain` is the
    kernel's owner text for a decision, or a line the API composes for a reply; `origin` is the ledger entry's;
    `ledger_seq` is the entry to show it with. `triage` is AI-written, when there is one."""

    ref_id: str
    kind: Literal["refused", "held", "reply_blocked"]
    reason_plain: str
    card_ids: list[str]
    origin: Literal["kernel", "api"]
    created_at: AwareDatetime
    triage: str | None
    ledger_seq: int
