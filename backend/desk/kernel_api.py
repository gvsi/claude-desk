"""Request and response models of the kernel HTTP API v2 (127.0.0.1:8701).

Each model is a body from the master plan's "Kernel HTTP API v2" table. No request
carries a principal, person, level or assurance: the kernel builds identity from its
own tables and the tokens or signatures it checks.
"""

from typing import Annotated, Literal, Self

from pydantic import AwareDatetime, BaseModel, StringConstraints, model_validator

from desk.contracts import (
    ActorKind,
    ApprovalAnswer,
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
    MCP_TOOLS,
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
    ToolCall,
    ToolName,
    ToolProfile,
)

Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]   # lowercase hex

# Requests. A PUT /desks/{id}/{part} body is the DeskSeed subset holding only that part,
# keyed by its DeskSeed field name, except business (the BusinessSeed fields but
# existing_business_id), people (upserts and removals) and answering ({on}).

class CreateCopyRequest(BaseModel):       # POST /copies: {}; the API checks the passcode first
    pass

class CreateDeskRequest(BaseModel):       # POST /desks (activates the ask_first preset)
    business: BusinessSeed
    desk: DeskSeed

class DeskBusinessRequest(BaseModel):     # PUT /desks/{id}/business
    name: str
    owner_display_name: str
    timezone: str
    brand: dict[str, str] = {}

class DeskCharterRequest(BaseModel):      # PUT /desks/{id}/charter
    charter: list[Claim]

class DeskHoursRequest(BaseModel):        # PUT /desks/{id}/hours (the kernel rewrites fact "charter:hours")
    hours: list[HoursWindow]

class DeskPricesRequest(BaseModel):       # PUT /desks/{id}/prices
    price_items: list[PriceItem]

class DeskCalendarRequest(BaseModel):     # PUT /desks/{id}/calendar
    calendar_slots: list[CalendarSlot]

class PersonUpsert(BaseModel):            # upserted by ref
    ref: str
    display_name: str
    contact: str | None                   # None keeps the contact on record; a masked contact is rejected by the kernel
    notes: str = ""

class DeskPeopleRequest(BaseModel):       # PUT /desks/{id}/people
    upsert: list[PersonUpsert] = []
    remove: list[str] = []                # SeedPerson refs

class DeskNotificationsRequest(BaseModel):   # PUT /desks/{id}/notifications
    notifications: NotificationDefaults

class DeskAnsweringRequest(BaseModel):    # PUT /desks/{id}/answering; off leaves only lead capture and callback
    on: bool

class DocumentUploadRequest(BaseModel):   # POST /documents (the kernel adds a canary)
    desk_id: str
    document: SeedDocument

class CreateSessionRequest(BaseModel):    # POST /sessions; agents authenticate by signature alone
    desk_slug: str
    kind: Literal["visitor", "agent"]
    mandate: Mandate | None = None

class ModeRequest(BaseModel):             # POST /sessions/{id}/mode (bumps generation; resumes a paused session)
    mode: SessionMode
    generation: int

class VerifyStartRequest(BaseModel):      # POST /verify/start
    session_id: str
    contact: str                          # as typed; codes go only to the contact on record

class VerifyCheckRequest(BaseModel):      # POST /verify/check
    session_id: str
    code: str

class DecideRequest(BaseModel):           # POST /decide; idempotent on (session_id, generation, call_id)
    session_id: str
    generation: int
    call: ToolCall
    desk_id: str | None = None            # required iff the caller is an owner session

class ExecuteRequest(BaseModel):          # POST /execute: exactly one of generation and approval_id
    decision_id: str
    session_id: str
    generation: int | None = None         # executes an allow at this generation
    approval_id: str | None = None        # only reconciles an unknown approved execution

    @model_validator(mode="after")
    def _one_form(self) -> Self:
        if (self.generation is None) == (self.approval_id is None):
            raise ValueError("name exactly one of generation and approval_id")
        return self

class CancelRequest(BaseModel):           # POST /decisions/{decision_id}/cancel
    session_id: str

class AnswerRequest(BaseModel):           # POST /approvals/{decision_id}/answer
    answer: ApprovalAnswer

class CheckReplyRequest(BaseModel):       # POST /check_reply
    draft: ReplyDraft

class OwnerMessageRequest(BaseModel):     # POST /owner/messages (the kernel ledgers both kinds)
    session_id: str
    text: str                             # untrusted text
    kind: Literal["say", "whisper"]

class PolicyDraftRequest(BaseModel):      # POST /policy/draft (compiled, linted, proved; idempotent)
    desk_id: str
    cards: list[RuleCard]
    expected_parent: int | None

class PolicyProbeRequest(BaseModel):      # POST /policy/{version}/probe (nothing activates)
    desk_id: str
    probes: list[Probe]

class PolicyConfirmRequest(BaseModel):    # POST /policy/confirm
    desk_id: str
    version: int

class ToolsConnectRequest(BaseModel):     # POST /tools/connect
    desk_id: str
    server: Literal["mock_payments"]

class ToolsConfirmRequest(BaseModel):     # POST /tools/confirm (enabling drafts a version to prove)
    desk_id: str
    tool: ToolName
    enable: bool
    definition_sha256: Sha256Hex | None = None   # required to enable an MCP tool: the hash the owner reviewed, which must
                                                 # equal the current listing, else 409; never set for a native tool

    @model_validator(mode="after")
    def _names_the_reviewed_definition(self) -> Self:
        if self.tool not in MCP_TOOLS:
            if self.definition_sha256 is not None:
                raise ValueError("a native tool has no definition hash")
        elif self.enable and self.definition_sha256 is None:
            raise ValueError("enabling an MCP tool names the definition_sha256 the owner reviewed")
        return self

class ToolsSimulateChangeRequest(BaseModel):   # POST /tools/simulate_change (demo)
    desk_id: str
    tool: ToolName

class KnowledgeRequest(BaseModel):        # POST /knowledge
    desk_id: str
    item: KnowledgeItem

class PaymentLinkActionRequest(BaseModel):   # POST /payment_links/{token}/complete and /cancel: {}
    pass

class DemoAgentRequest(BaseModel):        # POST /agents/demo (rate limited)
    desk_id: str

class LedgerAppendRequest(BaseModel):     # POST /ledger/append: origin forced to "api"; kinds session, rate_limit, agent_auth only
    desk_id: str
    event: LedgerEvent

KERNEL_REQUESTS: tuple[type[BaseModel], ...] = (
    CreateCopyRequest, CreateDeskRequest, DeskBusinessRequest, DeskCharterRequest, DeskHoursRequest,
    DeskPricesRequest, DeskCalendarRequest, DeskPeopleRequest, DeskNotificationsRequest,
    DeskAnsweringRequest, DocumentUploadRequest, CreateSessionRequest, ModeRequest, VerifyStartRequest,
    VerifyCheckRequest, DecideRequest, ExecuteRequest, CancelRequest, AnswerRequest, CheckReplyRequest,
    OwnerMessageRequest, PolicyDraftRequest, PolicyProbeRequest, PolicyConfirmRequest,
    ToolsConnectRequest, ToolsConfirmRequest, ToolsSimulateChangeRequest, KnowledgeRequest,
    PaymentLinkActionRequest, DemoAgentRequest, LedgerAppendRequest,
)

# Responses not already in the contracts.

class DeskCreated(BaseModel):             # POST /desks
    desk_id: str
    slug: str

class DeskUpdated(BaseModel):             # PUT /desks/{id}/{part}
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

class SessionContext(BaseModel):          # GET /context/{session_id}; facts and knowledge filtered by labels
    tools: list[ToolProfile]              # the profiles this session may call now
    tools_declared: list[ToolProfile]     # every profile a session of its kind could ever be given
    facts: list[Fact]
    knowledge: list[KnowledgeItem]

class ToolConfirmed(BaseModel):           # POST /tools/confirm
    profile: ToolProfile
    draft: PolicyVersion | None           # enabling drafts a version to prove

class PaymentLinkView(BaseModel):         # GET /payment_links/{token}, for the mock checkout
    title: str
    amount_cents: int
    state: PaymentLinkState
    language: Literal["en", "es"]

class PaymentLinkStateResult(BaseModel):  # POST /payment_links/{token}/complete and /cancel
    state: PaymentLinkState
    session_id: str
    verdict: ReplyVerdict | None          # the payment_confirmed verdict on paid; None on cancel

class PublicDesk(BaseModel):              # GET /public/{desk_slug}: public-labelled fields only, kernel-rendered (?lang=)
    business_name: str
    desk_name: str
    owner_display_name: str
    brand: dict[str, str]
    charter: list[RenderedBlock]
    agent_card: list[RenderedBlock]

class Health(BaseModel):                  # GET /health (selftest result cached at startup)
    version: str
    proof_mode: Literal["symcc", "bounded"]
    dev_signing_key: bool
    public_key_hex: str
    key_id: str
    unproved_seeds: list[str]

class KernelError(BaseModel):             # the body of every non-2xx kernel answer
    code: Literal["auth", "not_found", "closed", "stale_generation", "mode_owner", "mode_paused", "replayed",
                  "conflict", "invalid", "seed_unproved", "internal"]

KERNEL_RESPONSES: tuple[type[BaseModel], ...] = (
    DeskCreated, DeskUpdated, DocumentCreated, VerifyStarted, WhoAmI, SessionContext, ToolConfirmed,
    PaymentLinkView, PaymentLinkStateResult, PublicDesk, Health, KernelError,
)

# Every row of the kernel API table: (request model, response model). None only for a bodiless
# request, the document bytes and 204.
KERNEL_ROUTES: dict[str, tuple[type[BaseModel] | None, type | None]] = {
    "POST /copies": (CreateCopyRequest, CopyCreated),
    "POST /desks": (CreateDeskRequest, DeskCreated),
    "PUT /desks/{id}/business": (DeskBusinessRequest, DeskUpdated),
    "PUT /desks/{id}/charter": (DeskCharterRequest, DeskUpdated),
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
    "POST /tools/connect": (ToolsConnectRequest, list[ToolProfile]),
    "POST /tools/confirm": (ToolsConfirmRequest, ToolConfirmed),
    "POST /tools/simulate_change": (ToolsSimulateChangeRequest, ToolProfile),
    "POST /knowledge": (KnowledgeRequest, KnowledgeItem),
    "GET /payment_links/{token}": (None, PaymentLinkView),
    "POST /payment_links/{token}/complete": (PaymentLinkActionRequest, PaymentLinkStateResult),
    "POST /payment_links/{token}/cancel": (PaymentLinkActionRequest, PaymentLinkStateResult),
    "POST /agents/demo": (DemoAgentRequest, DemoAgentIssued),
    "POST /ledger/append": (LedgerAppendRequest, LedgerEntry),
    "GET /ledger/{desk_id}?verify=true": (None, LedgerPage),
    "GET /health": (None, Health),
}
