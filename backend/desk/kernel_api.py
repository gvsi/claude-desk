"""Request and response models of the kernel HTTP API v2 (127.0.0.1:8701).

Each model is a body from the master plan's "Kernel HTTP API v2" table. No request
carries a principal, person, level or assurance: the kernel builds identity from its
own tables and the tokens or signatures it checks.
"""

from datetime import UTC, timedelta
from typing import Annotated, Literal, Self, get_args

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictInt, StringConstraints, model_validator

from desk.contracts import (
    AUTO_MONEY_HARD_CAP_CENTS,
    ActorKind,
    AnyToolName,
    BusinessTool,
    ApprovalAnswer,
    Brand,
    BrandPalette,
    ApprovalResult,
    BusinessSeed,
    CalendarSlot,
    Claim,
    CopyCreated,
    Decision,
    DemoAgentIssued,
    DemoInboxEntry,
    DeskSeed,
    ExecResult,
    Fact,
    HoursWindow,
    InboxNotice,
    KnowledgeItem,
    LedgerEntry,
    LedgerEvent,
    LedgerPage,
    Mandate,
    NotificationDefaults,
    OwnerMessageResult,
    PaymentLinkState,
    PolicyVersion,
    PriceItem,
    Probe,
    ProbeResult,
    RenderedBlock,
    ReplyDraft,
    ReplyVerdict,
    RuleCard,
    SeedDocument,
    SessionCreated,
    SessionMode,
    SessionState,
    SignedTime,
    ToolCall,
    ToolName,
    ToolProfile,
)

Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]   # lowercase hex

# Requests. A PUT /desks/{id}/{part} body is the DeskSeed subset holding only that part,
# keyed by its DeskSeed field name, except business (the BusinessSeed fields but
# existing_business_id), people (upserts and removals) and answering ({on}).

class KernelRequest(BaseModel):
    """A request body: an unknown field, such as an identity the API must not send, is refused, not dropped."""

    model_config = ConfigDict(extra="forbid")

class CreateCopyRequest(KernelRequest):       # POST /copies; the API checks the passcode first
    replay_night: bool = False                # the kernel replays the recorded night only when asked

class CreateDeskRequest(KernelRequest):       # POST /desks (activates the ask_first preset)
    business: BusinessSeed
    desk: DeskSeed

class DeskBusinessRequest(KernelRequest):     # PUT /desks/{id}/business
    name: str
    owner_display_name: str
    timezone: str
    brand: Brand = {}
    brand_palette: BrandPalette | None = None   # a pick: the kernel stores its key and BRAND_PALETTE's colours, so
                                                # brand stays {}; "none" is the pick of no colours; None writes brand
                                                # as before ({} stores nothing, which reads as the default pick)

    @model_validator(mode="after")
    def _one_source_of_colours(self) -> Self:
        if self.brand_palette is not None and self.brand:
            raise ValueError("a palette pick takes its colours from BRAND_PALETTE, so brand stays empty")
        return self

class DeskCharterRequest(KernelRequest):      # PUT /desks/{id}/charter
    charter: list[Claim]

class MemoryItem(BaseModel):
    """An untrusted simulated owner note, shared by the write contract and memory reader."""

    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)

    id: str = Field(pattern=r"^[a-z][a-z-]{0,59}$")
    title: str = Field(min_length=1, max_length=200)
    topics: list[Annotated[str, StringConstraints(min_length=1, max_length=60)]] = Field(max_length=10)
    text: str = Field(min_length=1, max_length=2000)

class DeskMemoryRequest(KernelRequest):       # PUT /desks/{id}/memory
    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)

    about: str = Field(min_length=1, max_length=500)
    items: list[MemoryItem] = Field(max_length=20)

    @model_validator(mode="after")
    def _unique_ids(self) -> Self:
        if len({item.id for item in self.items}) != len(self.items):
            raise ValueError("memory item ids must be unique")
        return self

class DeskHoursRequest(KernelRequest):        # PUT /desks/{id}/hours (the kernel rewrites fact "charter:hours")
    hours: list[HoursWindow]

class DeskPricesRequest(KernelRequest):       # PUT /desks/{id}/prices
    price_items: list[PriceItem]

class DeskCalendarRequest(KernelRequest):     # PUT /desks/{id}/calendar
    calendar_slots: list[CalendarSlot]

class PersonUpsert(KernelRequest):            # upserted by ref
    ref: str
    display_name: str
    contact: str | None                   # None keeps the contact on record; a masked contact is rejected by the kernel
    notes: str = ""

class DeskPeopleRequest(KernelRequest):       # PUT /desks/{id}/people
    upsert: list[PersonUpsert] = []
    remove: list[str] = []                # SeedPerson refs

class DeskNotificationsRequest(KernelRequest):   # PUT /desks/{id}/notifications
    notifications: NotificationDefaults

class DeskAnsweringRequest(KernelRequest):    # PUT /desks/{id}/answering; off leaves only lead capture and callback
    on: bool

class DocumentUploadRequest(KernelRequest):   # POST /documents (the kernel adds a canary)
    desk_id: str
    document: SeedDocument

class CreateSessionRequest(KernelRequest):    # POST /sessions; agents authenticate by signature alone
    desk_slug: str
    kind: Literal["visitor", "agent"]
    mandate: Mandate | None = None
    preview: bool = False                 # the owner tries the Desk as a customer before Answering is on: needs a valid
                                          # X-Owner-Session for the slug's copy (else 401 auth); ledgered, owner-only

    @model_validator(mode="after")
    def _previews_are_visitors(self) -> Self:
        if self.preview and self.kind == "agent":
            raise ValueError("a preview is a visitor session")   # 422 invalid
        return self

class ModeRequest(KernelRequest):             # POST /sessions/{id}/mode (bumps generation; resumes a paused session)
    mode: SessionMode
    generation: int

TURN_TEXT_CHARS = 2000

class TurnRequest(KernelRequest):             # POST /sessions/{session_id}/turn, once at turn start before /context
    generation: int
    text: str = Field(max_length=TURN_TEXT_CHARS)   # the newest visitor or agent message, untrusted text: read only
                                                    # to detect its language, never stored, logged or ledgered
    desk_id: str | None = None            # required iff the caller is an owner session

class VerifyStartRequest(KernelRequest):      # POST /verify/start
    session_id: str
    contact: str                          # as typed; codes go only to the contact on record

class VerifyCheckRequest(KernelRequest):      # POST /verify/check
    session_id: str
    code: str

class DecideRequest(KernelRequest):           # POST /decide; idempotent on (session_id, generation, call_id)
    session_id: str
    generation: int
    call: ToolCall
    desk_id: str | None = None            # required iff the caller is an owner session

class ExecuteRequest(KernelRequest):          # POST /execute: exactly one of generation and approval_id
    decision_id: str
    session_id: str
    generation: int | None = None         # executes an allow at this generation
    approval_id: str | None = None        # only reconciles an unknown approved execution

    @model_validator(mode="after")
    def _one_form(self) -> Self:
        if (self.generation is None) == (self.approval_id is None):
            raise ValueError("name exactly one of generation and approval_id")
        return self

class CancelRequest(KernelRequest):           # POST /decisions/{decision_id}/cancel
    session_id: str

class AnswerRequest(KernelRequest):           # POST /approvals/{decision_id}/answer
    answer: ApprovalAnswer

class CheckReplyRequest(KernelRequest):       # POST /check_reply
    draft: ReplyDraft
    final: bool = True                    # false: a first attempt the API rewrites if every violation is rewritable
                                          # (desk.rewrites), so its handoff clause opens no owner handoff then

class OwnerMessageRequest(KernelRequest):     # POST /owner/messages (the kernel ledgers both kinds)
    session_id: str
    text: str                             # untrusted text
    kind: Literal["say", "whisper"]

class PolicyDraftRequest(KernelRequest):      # POST /policy/draft (compiled, linted, proved; idempotent)
    desk_id: str
    cards: list[RuleCard]
    expected_parent: int | None
    auto_money_cap_cents: StrictInt | None = Field(None, ge=0, le=AUTO_MONEY_HARD_CAP_CENTS)   # the draft's money cap; None keeps the
                                          # active version's ("Money cap")

class PolicyProbeRequest(KernelRequest):      # POST /policy/{version}/probe (nothing activates)
    desk_id: str
    probes: list[Probe]

class PolicyConfirmRequest(KernelRequest):    # POST /policy/confirm
    desk_id: str
    version: int

class ToolsConnectRequest(KernelRequest):     # POST /tools/connect
    desk_id: str
    server: Literal["mock_payments"]

class ToolPin(BaseModel):                  # a tool and the hash the owner reviewed: an MCP tool's listed definition_sha256,
    model_config = ConfigDict(extra="forbid")   # a native tool's adapter profile_sha256

    tool: AnyToolName
    definition_sha256: Sha256Hex

def each_tool_once(tools: list[ToolPin]) -> list[ToolPin]:
    """The batch rule /tools/confirm and the owner API's body share: a batch names each tool once."""
    if len({pin.tool for pin in tools}) != len(tools):
        raise ValueError("a batch names each tool once")
    return tools

class ToolsConfirmRequest(KernelRequest):     # POST /tools/confirm: a whole connector in one batch, one tool a list of one
    desk_id: str
    tools: list[ToolPin] = Field(min_length=1, max_length=len(get_args(ToolName)) + 8)
    enable: bool                          # true drafts one rules version enabling them all; false disables them all at once

    @model_validator(mode="after")
    def _each_tool_once(self) -> Self:
        each_tool_once(self.tools)
        return self

class ToolsSimulateChangeRequest(KernelRequest):   # POST /tools/simulate_change (demo)
    desk_id: str
    tool: ToolName

class KnowledgeRequest(KernelRequest):        # POST /knowledge
    desk_id: str
    item: KnowledgeItem

class PaymentLinkActionRequest(KernelRequest):   # POST /payment_links/{token}/complete and /cancel: {}
    pass

class DemoAgentRequest(KernelRequest):        # POST /agents/demo (rate limited)
    desk_id: str

class LedgerAppendRequest(KernelRequest):     # POST /ledger/append: origin "api"; kinds session, rate_limit, agent_auth only
    desk_id: str
    event: LedgerEvent

    @model_validator(mode="after")
    def _api_events_only(self) -> Self:
        if self.event.origin != "api" or self.event.kind not in ("session", "rate_limit", "agent_auth"):
            raise ValueError("the API appends only its own session, rate_limit and agent_auth events")
        return self

KERNEL_REQUESTS: tuple[type[BaseModel], ...] = (
    CreateCopyRequest, CreateDeskRequest, DeskBusinessRequest, DeskCharterRequest, DeskMemoryRequest, DeskHoursRequest,
    DeskPricesRequest, DeskCalendarRequest, DeskPeopleRequest, DeskNotificationsRequest,
    DeskAnsweringRequest, DocumentUploadRequest, CreateSessionRequest, ModeRequest, TurnRequest, VerifyStartRequest,
    VerifyCheckRequest, DecideRequest, ExecuteRequest, CancelRequest, AnswerRequest, CheckReplyRequest,
    OwnerMessageRequest, PolicyDraftRequest, PolicyProbeRequest, PolicyConfirmRequest,
    ToolsConnectRequest, ToolsConfirmRequest, ToolsSimulateChangeRequest, KnowledgeRequest,
    PaymentLinkActionRequest, DemoAgentRequest, LedgerAppendRequest,
)

# Responses not already in the contracts.

class DeskCreated(BaseModel):             # POST /desks
    desk_id: str
    slug: str

class DeskUpdated(BaseModel):             # PUT /desks/{id}/{part}; POST /handoffs/{id}/done
    desk_id: str
    updated_at: AwareDatetime

class DocumentCreated(BaseModel):         # POST /documents
    document_id: str

class VerifyStarted(BaseModel):           # POST /verify/start
    message: str                          # uniform kernel en/es template, whether or not the contact is on record
    inbox: list[InboxNotice]

class WhoAmI(BaseModel):                  # GET /whoami: the API's only source for the copy, session and generation
    kind: ActorKind
    copy_id: str
    desk_id: str | None
    desk_ids: list[str]
    session: SessionState | None

class ContextClock(BaseModel):            # public kernel time, with no data label
    as_of_utc: SignedTime
    local_now: str                        # ISO 8601 with the business's offset, to the minute
    local_date: str                       # YYYY-MM-DD in the business's time zone
    weekday: Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    timezone: str                        # the business's IANA time zone

class SessionContext(BaseModel):          # GET /context/{session_id}; facts and knowledge filtered by labels
    clock: ContextClock
    tools: list[ToolProfile]              # the profiles this session may call now
    tools_declared: list[ToolProfile]     # every profile a session of its kind could ever be given
    facts: list[Fact]
    knowledge: list[KnowledgeItem]

class TurnStarted(BaseModel):             # POST /sessions/{session_id}/turn
    language: Literal["en", "es"]         # the session's language after the call: the message's when the kernel
                                          # could tell it, else the one the session had

class ToolConfirmed(BaseModel):           # POST /tools/confirm
    profiles: list[ToolProfile]           # the batch's tools as they stand now, in the request's order
    draft: PolicyVersion | None           # enabling drafts one version to prove; disabling and a no-op draft nothing

class PaymentLinkView(BaseModel):         # GET /payment_links/{token}, for the mock checkout
    title: str
    amount_cents: int
    state: PaymentLinkState
    language: Literal["en", "es"]
    business_name: str                    # the link's Desk's public business name, as PublicDesk serves it
    customer_name: str | None             # display only, never read back: the verified customer's first name and last
                                          # initial ("Dana W."), from the person on record at view time, only while the
                                          # link is live (issued, unexpired) and was made in a visitor session verified
                                          # as that person; None otherwise (agents, unverified sessions, removed people)
    cancel_reason: Literal["rules_changed"] | None = None   # rules_changed: a rule change cancelled it; else None

class PaymentLinkStateResult(BaseModel):  # POST /payment_links/{token}/complete and /cancel
    state: PaymentLinkState
    session_id: str
    verdict: ReplyVerdict | None          # the payment_confirmed verdict on paid; None on cancel

class LinkCancelled(BaseModel):           # GET /policy/{version}/cancelled_links: a link that version's activation cancelled
    link_id: str
    session_id: str
    verdict: ReplyVerdict                 # one link_cancelled block, signed at the session's current generation when read

class OpenStatus(BaseModel):              # PublicDesk's header line: computed from charter:hours on the kernel's clock
    open: bool
    until: AwareDatetime | None           # open: the end of the union of overlapping or touching windows; None if open
                                          # through the next 7 local days (up to 169 hours)
    opens_at: AwareDatetime | None        # closed: the start of the next window, always within 7 local days
    text: str                             # kernel en/es template in the business's time zone (?lang=), shown verbatim
    as_of: AwareDatetime                  # the kernel's clock
    refresh_at: AwareDatetime             # when text may next change: the earliest of the boundary, the next local
                                          # midnight and as_of + 25 h; the web refetches once at refresh_at - as_of

    @model_validator(mode="after")
    def _times_in_order(self) -> Self:
        boundary, other = (self.until, self.opens_at) if self.open else (self.opens_at, self.until)
        if other is not None:
            raise ValueError("an open status names only until, a closed one only opens_at")
        if not self.open and boundary is None:
            raise ValueError("a closed status names when it opens: without hours there is no status at all")
        # as instants in UTC: two times sharing a ZoneInfo compare and subtract by wall clock, ignoring a repeated hour's fold
        as_of, refresh_at = self.as_of.astimezone(UTC), self.refresh_at.astimezone(UTC)
        boundary = boundary.astimezone(UTC) if boundary is not None else None
        if boundary is not None and boundary <= as_of:
            raise ValueError("the boundary is after as_of: windows end exclusive")
        if refresh_at <= as_of:
            raise ValueError("refresh_at is after as_of")
        if refresh_at > as_of + timedelta(hours=25):   # a fall-back day lasts 25 hours, so most next midnights fit
            raise ValueError("refresh_at is at most 25 hours after as_of")
        if boundary is not None and refresh_at > boundary:
            raise ValueError("refresh_at is at or before the boundary")
        return self

# What happens when an agent with no standing of its own asks for an ability on the Agent Card, by the active version's
# cards for anyone (`compiler.outcome_for`): an auto card allows it, a never card refuses it, else it asks first.
AgentOutcome = Literal["allowed", "asks_first", "never"]

class AgentAbility(RenderedBlock):        # one Agent Card block: the kernel's prose for an ability, with its outcome
    outcome: AgentOutcome | None          # None with no active version or one that can't be read: no outcome is claimed
    outcome_text: str | None              # the kernel's fixed words for `outcome` in ?lang= (they name no one); None with it

    @model_validator(mode="after")
    def _words_with_the_outcome(self) -> Self:
        if (self.outcome is None) != (self.outcome_text is None):
            raise ValueError("an ability's outcome and its words come together")
        return self

class PublicDesk(BaseModel):              # GET /public/{desk_slug}: public-labelled fields only, kernel-rendered (?lang=)
    business_name: str
    desk_name: str
    owner_display_name: str
    brand: dict[str, str]
    charter: list[RenderedBlock]
    agent_card: list[AgentAbility]
    open_status: OpenStatus | None = None   # None without charter:hours or with no windows in it, or when computing it fails
    starters: list[str] = []               # the Desk's seed-only starter questions, rendered in ?lang=; [] when it has none

class Health(BaseModel):                  # GET /health (selftest result cached at startup)
    version: str
    proof_mode: Literal["symcc", "bounded"]
    dev_signing_key: bool
    public_key_hex: str
    key_id: str
    unproved_seeds: list[str]

ERROR_DETAIL_KEY_PATTERN = r"^[A-Za-z0-9_.:-]{1,120}$"
ERROR_RULE_ID_PATTERN = r"^[a-z0-9_.]{1,64}$"
ErrorDetailKey = Annotated[str, StringConstraints(pattern=ERROR_DETAIL_KEY_PATTERN)]
ErrorRuleId = Annotated[str, StringConstraints(pattern=ERROR_RULE_ID_PATTERN)]


class KernelError(BaseModel):             # the body of every non-2xx kernel answer
    code: Literal["auth", "not_found", "closed", "stale_generation", "mode_owner", "mode_paused", "replayed",
                  "conflict", "invalid", "rate_limited", "seed_unproved", "internal"]   # rate_limited: 429 (POST /agents/demo)
    # Refused public policy or card field keys and rule IDs, never values. propertyNames also closes
    # unmatched keys in JSON Schema, beyond patternProperties.
    detail: dict[ErrorDetailKey, list[ErrorRuleId]] | None = Field(
        default=None, json_schema_extra={"propertyNames": {"pattern": ERROR_DETAIL_KEY_PATTERN}})

KERNEL_RESPONSES: tuple[type[BaseModel], ...] = (
    DeskCreated, DeskUpdated, DocumentCreated, VerifyStarted, WhoAmI, SessionContext, TurnStarted, ToolConfirmed,
    PaymentLinkView, PaymentLinkStateResult, LinkCancelled, PublicDesk, Health, KernelError,
)

# Every row of the kernel API table: (request model, response model). None only for a bodiless
# request, the document bytes and 204. tests/test_contracts.py compares the keys with the plan's table.
KERNEL_ROUTES: dict[str, tuple[type[BaseModel] | None, type | None]] = {
    "POST /copies": (CreateCopyRequest, CopyCreated),
    "POST /desks": (CreateDeskRequest, DeskCreated),
    "PUT /desks/{id}/business": (DeskBusinessRequest, DeskUpdated),
    "PUT /desks/{id}/charter": (DeskCharterRequest, DeskUpdated),
    "PUT /desks/{id}/memory": (DeskMemoryRequest, DeskUpdated),
    "PUT /desks/{id}/hours": (DeskHoursRequest, DeskUpdated),
    "PUT /desks/{id}/prices": (DeskPricesRequest, DeskUpdated),
    "PUT /desks/{id}/calendar": (DeskCalendarRequest, DeskUpdated),
    "PUT /desks/{id}/people": (DeskPeopleRequest, DeskUpdated),
    "PUT /desks/{id}/notifications": (DeskNotificationsRequest, DeskUpdated),
    "PUT /desks/{id}/answering": (DeskAnsweringRequest, DeskUpdated),
    "DELETE /desks/{id}": (None, None),
    "POST /documents": (DocumentUploadRequest, DocumentCreated),
    "GET /document_links/{token}": (None, None),
    "GET /public/{desk_slug}": (None, PublicDesk),
    "POST /sessions": (CreateSessionRequest, SessionCreated),
    "GET /whoami": (None, WhoAmI),
    "POST /sessions/{id}/mode": (ModeRequest, SessionState),
    "POST /verify/start": (VerifyStartRequest, VerifyStarted),
    "POST /verify/check": (VerifyCheckRequest, SessionState),
    "GET /demo_inbox?session_id=": (None, list[DemoInboxEntry]),
    "GET /demo_inbox": (None, list[DemoInboxEntry]),
    "GET /context/{session_id}?desk_id=": (None, SessionContext),
    "POST /sessions/{session_id}/turn": (TurnRequest, TurnStarted),
    "POST /decide": (DecideRequest, Decision),
    "GET /decisions/{id}": (None, Decision),
    "GET /decisions/by_call?session_id=&generation=&call_id=": (None, Decision),
    "POST /execute": (ExecuteRequest, ExecResult),
    "POST /decisions/{decision_id}/cancel": (CancelRequest, Decision),
    "POST /approvals/{decision_id}/answer": (AnswerRequest, ApprovalResult),
    "POST /check_reply": (CheckReplyRequest, ReplyVerdict),
    "POST /owner/messages": (OwnerMessageRequest, OwnerMessageResult),
    "POST /policy/draft": (PolicyDraftRequest, PolicyVersion),
    "POST /policy/{version}/probe": (PolicyProbeRequest, list[ProbeResult]),
    "POST /policy/confirm": (PolicyConfirmRequest, PolicyVersion),
    "GET /policy/{version}/cancelled_links?desk_id=": (None, list[LinkCancelled]),
    "POST /tools/connect": (ToolsConnectRequest, list[ToolProfile]),
    "POST /tools/confirm": (ToolsConfirmRequest, ToolConfirmed),
    "POST /tools/simulate_change": (ToolsSimulateChangeRequest, ToolProfile),
    "POST /knowledge": (KnowledgeRequest, KnowledgeItem),
    "POST /handoffs/{id}/done": (None, DeskUpdated),   # status open -> done, ledgered desk_data
    "GET /payment_links/{token}": (None, PaymentLinkView),
    "POST /payment_links/{token}/complete": (PaymentLinkActionRequest, PaymentLinkStateResult),
    "POST /payment_links/{token}/cancel": (PaymentLinkActionRequest, PaymentLinkStateResult),
    "POST /agents/demo": (DemoAgentRequest, DemoAgentIssued),
    "POST /ledger/append": (LedgerAppendRequest, LedgerEntry),
    "GET /ledger/{desk_id}?verify=true": (None, LedgerPage),
    "GET /health": (None, Health),
}


class BusinessToolsRequest(KernelRequest):
    tools: list[BusinessTool] = Field(max_length=8)


KERNEL_REQUESTS += (BusinessToolsRequest,)
KERNEL_ROUTES["PUT /desks/{id}/business_tools"] = (BusinessToolsRequest, DeskUpdated)
