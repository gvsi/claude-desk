"""Shared contracts v2 between the kernel and API processes.

The models below are the master plan's "Shared contracts v2" block, verbatim and in its
order (each class is defined before it is used). Field comments are part of the contract.
"""

from collections.abc import Collection, Iterable, Mapping
from datetime import datetime, time
from typing import Annotated, Literal, Self, get_args

from pydantic import (AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, StrictInt, StringConstraints,
                      model_validator)

# Identity and sessions: built by the kernel from its own tables; never accepted over HTTP.
ActorKind = Literal["visitor", "agent", "owner"]
Assurance = Literal["none", "demo_code", "owner_session"]   # "demo_code" = simulated verification
SessionMode = Literal["ai", "owner", "paused"]               # "owner": the owner took over; "paused": the breaker tripped

class Principal(BaseModel):               # kernel-internal; never crosses HTTP
    kind: ActorKind
    session_id: str
    copy_id: str
    desk_id: str
    person_id: str | None = None          # set only by /verify/check (one person per session)
    agent_key_id: str | None = None       # agents, from a verified AgentAuth
    assurance: Assurance = "none"
    mandate_id: str | None = None         # agents with a verified mandate

class SessionState(BaseModel):            # all the API may know about a session
    session_id: str                       # 128-bit CSPRNG, URL-safe
    kind: ActorKind
    verified: bool
    assurance: Assurance
    mode: SessionMode
    generation: int                       # bumped on take-over and hand-back; stale work is refused

class SessionCreated(BaseModel):          # POST /sessions; the token is shown once
    state: SessionState
    session_token: str | None             # 256-bit CSPRNG, stored only as its hash (secret_hash); None for agent sessions

# A signed timestamp: RFC 3339 UTC with microseconds and "Z"; signatures cover the literal string
SignedTime = Annotated[str, StringConstraints(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$")]

class AgentAuth(BaseModel):               # headers X-Agent-Key-Id, X-Agent-Ts, X-Agent-Nonce, X-Agent-Sig; verified by the kernel
    agent_key_id: str
    ts: SignedTime                        # signed as the exact header text; parsed only to check it is within 5 minutes
    nonce: str                            # stored; bound to one session and one body hash
    sig: str                              # Ed25519 over canonical JSON {desk_slug, ts, nonce, body_sha256}
                                          # body_sha256 = lowercase hex sha256 of the raw A2A request body bytes

# Claims, labels and notices (used by seeds, decisions and facts)
class Label(BaseModel):
    readers: list[str] = ["owner"]        # "public" | "owner" | "person:<id>" | "session:<id>"; missing label = owner-only
    record_owner: str | None = None

class Claim(BaseModel):
    key: str                              # "total", "starts_at", "title", "contact"; never "hours" (DeskSeed.hours)
    kind: Literal["money", "percent_bp", "datetime", "text", "ref"]
    value: StrictInt | str                # money in USD cents; percent in bp; datetime ISO 8601 with offset

    @model_validator(mode="after")
    def _value_matches_kind(self) -> Self:
        if self.key == "hours":
            raise ValueError('a claim is never "hours"; hours live in DeskSeed.hours')
        if self.kind in ("money", "percent_bp"):
            if not isinstance(self.value, int):
                raise ValueError(f"a {self.kind} claim is an integer")
            if self.kind == "percent_bp" and not 0 <= self.value <= 10_000:
                raise ValueError("a percent_bp claim is 0-10000 basis points")
        elif not isinstance(self.value, str):
            raise ValueError(f"a {self.kind} claim is a string")
        elif self.kind == "datetime":
            try:
                parsed = datetime.fromisoformat(self.value)
            except ValueError:
                raise ValueError("a datetime claim is ISO 8601") from None
            if parsed.tzinfo is None:
                raise ValueError("a datetime claim carries its offset")
        return self

class InboxNotice(BaseModel):             # code-free; safe for SSE and app.*, never for Claude's context
    entry_id: str
    to: str                               # masked contact on record, or "owner"
    preview: str                          # kernel template, never a code

# Desks and seeds: POST /copies seeds Turner Plumbing through the same path as POST /desks.
class SeedPerson(BaseModel):              # a contact on record; the kernel assigns ids
    ref: str                              # seed-local handle, stable across PUTs ("dana")
    display_name: str
    contact: str                          # email or phone on record; verification codes go only here
    notes: str = ""

class SeedDocument(BaseModel):
    ref: str
    title: str
    body: str                             # the kernel adds a fresh canary to every document
    record_owner_ref: str | None = None   # a SeedPerson.ref; None = owner-only

ITEM_ID_PATTERN = r"^[a-z0-9-]{1,40}$"
SLOT_ID_PATTERN = r"^S-[0-9]{8}-[0-9]{4}$"   # ASCII digits, as in SignedTime

class PriceItem(BaseModel):
    item_id: str = Field(pattern=ITEM_ID_PATTERN)
    title: str
    unit_cents: StrictInt = Field(ge=0, le=1_000_000)

class CalendarSlot(BaseModel):
    slot_id: str = Field(pattern=SLOT_ID_PATTERN)   # S-<yyyymmdd>-<hhmm>, the start in business time
    starts_at: AwareDatetime
    minutes: int

class NotificationDefaults(BaseModel):    # alerts are delivered to the owner's Demo inbox
    now: list[str]                        # event kinds that alert at once ("approval", "callback", "breaker")
    briefing: list[str]

# A Desk's brand colours, picked from a fixed palette: the owner picks a key and the kernel stores it with this
# table's colours, never colours of the request's, so every pick keeps the public page's header readable
# (the web palette tests hold each primary to 4.5:1 under both header text tokens).
BrandPalette = Literal["none", "teal", "clay", "navy", "forest", "plum", "rust", "slate"]   # in display order
DEFAULT_BRAND_PALETTE: BrandPalette = "teal"            # what a business that stored no brand reads as
BRAND_PALETTE: dict[BrandPalette, dict[str, str]] = {   # the one table: the header's field and the rule under it
    "none": {},                                         # no colours: the web draws its neutral header
    "teal": {"primary": "#1F4E4A", "accent": "#B87333"},
    "clay": {"primary": "#773624", "accent": "#D97757"},
    "navy": {"primary": "#1F3A5C", "accent": "#C9A24B"},
    "forest": {"primary": "#28452B", "accent": "#B5A05E"},
    "plum": {"primary": "#4A2D4D", "accent": "#C98FA3"},
    "rust": {"primary": "#6B2F22", "accent": "#D9A578"},
    "slate": {"primary": "#33383F", "accent": "#8FA4B8"},
}
BRAND_PALETTE_UNLISTED = "a brand's palette is one of BRAND_PALETTE's keys"

def _listed_palette(brand: dict[str, str]) -> dict[str, str]:
    if "palette" in brand and brand["palette"] not in BRAND_PALETTE:
        raise ValueError(BRAND_PALETTE_UNLISTED)
    return brand

# A business's brand: the public page's colors, and a `palette` key when they are a pick from BRAND_PALETTE
Brand = Annotated[dict[str, str], AfterValidator(_listed_palette)]

def stored_brand(brand: Mapping[str, str], palette: BrandPalette | None = None) -> dict[str, str]:
    """The brand a business write stores: a pick, `palette` or else the `palette` key `brand` carries (a brand passed
    back as it was read), as its key and BRAND_PALETTE's colours, whatever colours `brand` holds; without a pick,
    `brand` as sent. A key outside the table raises ValueError."""
    key = palette if palette is not None else brand.get("palette")
    if key is None:
        return dict(brand)
    if key not in BRAND_PALETTE:
        raise ValueError(BRAND_PALETTE_UNLISTED)
    return {"palette": key, **BRAND_PALETTE[key]}

def effective_brand(stored: Mapping[str, str]) -> dict[str, str]:
    """The brand a read serves (the public page, the owner's business read) for a stored one: a pick's key and
    BRAND_PALETTE's colours as they are now ("none": the key alone); free-form colours from before the palette, as
    stored; and the default pick, teal, for a business that stored no colours, or a key the table no longer has."""
    key = stored.get("palette")
    if key is None and ("primary" in stored or "accent" in stored):
        return dict(stored)
    if key not in BRAND_PALETTE:
        key = DEFAULT_BRAND_PALETTE
    return {"palette": key, **BRAND_PALETTE[key]}

# The owner's display name setup gives an owner who gave no name. The kernel's visitor lines and Claude's prompt
# name the business instead of an owner with this name ("Let me check with Turner Plumbing."; `shown_owner`).
OWNER_NAME_FALLBACK = "Owner"


def shown_owner(owner_display_name: str, business_name: str) -> str:
    """The name the kernel's visitor lines ("Checked against {owner}'s rules", "Let me check with {owner}.") and
    Claude's prompt give the owner: the business's name when the owner's name is the one setup gives an owner who
    gave none (`OWNER_NAME_FALLBACK`), else the owner's name as it is. A business with no name keeps the fallback."""
    return business_name if owner_display_name == OWNER_NAME_FALLBACK and business_name else owner_display_name


class BusinessSeed(BaseModel):
    name: str
    owner_display_name: str               # "Mike Turner"; the handoff clause, visitor status lines and owner_joined render it
                                          # (the kernel's lines name the business instead of `OWNER_NAME_FALLBACK`)
    timezone: str                         # IANA; Cedar's local_dow and local_minute use it
    brand: Brand = {}                     # public-page colors; the kernel stores a `palette` pick as `stored_brand` makes it
    existing_business_id: str | None = None   # add a Desk to a business in this copy

class HoursWindow(BaseModel):
    days: list[Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]] = Field(min_length=1)
    start: time
    end: time                             # exclusive, after start, in the business's time zone; 00:00 is midnight, the end of
                                          # the day (minute 1440); past midnight = two windows (fri 22:00–00:00, sat 00:00–02:00)

    @model_validator(mode="after")
    def _one_local_span(self) -> Self:
        if self.start.tzinfo is not None or self.end.tzinfo is not None:
            raise ValueError("hours are local to the business's time zone, without an offset")
        if self.end <= self.start and self.end != time(0):
            raise ValueError("end is after start, or 00:00 for midnight; a window past midnight is two windows")
        return self

AUTO_MONEY_HARD_CAP_CENTS = 1_000_000     # $10,000: the platform ceiling, the most any version's money cap or auto card may allow per action,
                                          # the same as the per-payment limit (`PriceItem.unit_cents`, `NormalizedAction.amount_cents`,
                                          # the baseline's `money_has_amount`); Plan 01b raises it from Plan 01a's 50_000 and moves it
                                          # here ("Money cap")
# Why `RuleCard` refuses an auto money card: read by the rules chat too, which names it for a business money card the
# card alone can't recognise.
AUTO_MONEY_NEEDS_LIMIT = f"an auto money card needs max_amount_cents of at most {AUTO_MONEY_HARD_CAP_CENTS}"

class DeskSeed(BaseModel):
    name: str                             # "Main line"
    charter: list[Claim]                  # service area, policies, contact: charter facts labelled ["public"], rendered only, never computed from
    auto_money_cap_cents: StrictInt = Field(0, ge=0, le=AUTO_MONEY_HARD_CAP_CENTS)   # the money cap of the Desk's first rules version only
                                          # (Plan 01b): the most an auto rule takes or pays out per action without asking; 0 = every charge
                                          # and payout asks; afterwards the Desk's cap is its active version's; owner-only, never a public
                                          # claim; POST /desks takes only 0 ("Money cap")
    hours: list[HoursWindow]              # the kernel writes fact "charter:hours" from these (again on PUT hours); the hours clause formats
                                          # the windows in the reply's language, and callback windows are computed from them
    price_items: list[PriceItem]
    calendar_slots: list[CalendarSlot]
    people: list[SeedPerson]
    documents: list[SeedDocument]
    notifications: NotificationDefaults
    connections: list[Literal["mock_payments"]] = []   # connected and confirmed with the seed's profiles by POST /copies (the Turner seed);
                                          # POST /desks rejects a non-empty list (422 invalid), and new Desks connect through /tools/connect

# Tools
Effect = Literal["read", "private_data", "change", "charge", "pay_out", "send_message"]
ToolName = Literal["native.quote", "native.find_slots", "native.book", "native.release_document",
                   "native.payment_link", "native.charge_mandate", "native.capture_lead",
                   "native.request_callback", "native.start_verification",
                   "native.fetch_website", "native.read_memory", "native.web_search",
                   "payments.list_charges", "payments.create_refund"]
MONEY_TOOLS: frozenset[str] = frozenset({"native.payment_link", "native.charge_mandate", "payments.create_refund"})
MONEY_EFFECTS: frozenset[str] = frozenset({"charge", "pay_out"})   # the effects that take or pay out money: the one set
                                          # every money check reads, for cards (`moves_money`) and tools (`money_tool`)
MCP_TOOLS: frozenset[str] = frozenset({"payments.list_charges", "payments.create_refund"})   # pinned by definition hash

class ToolProfile(BaseModel):
    tool: "AnyToolName"
    source: Literal["native", "mcp", "business"]
    effects: list[Effect]
    reversible: bool
    adapter: str                          # trusted code that normalizes args and resolves resources; no adapter, no tool
    resource_kind: Literal["quote", "slot", "booking", "document", "charge", "desk"]
    description_confirmed: str            # the owner-confirmed text Claude sees, never the server's description
    input_schema: dict                    # the adapter's JSON Schema of the args it accepts (additionalProperties: false), never the server's
    definition_sha256: str | None = None  # MCP: sha256 of canonical_json_any(every field of the parsed tools/list entry, client
                                          # list cache off; fields the SDK drops reach no one); re-listed before every execution.
                                          # A native tool's owner view carries its adapter profile's profile_sha256, the hash
                                          # /tools/confirm names for it; Claude's view of a native tool has none
    pending_definition_text: str | None = None   # a drifted tools/list entry, shown to the owner as quoted untrusted text
    pending_sha256: str | None = None     # its hash; the owner's confirm must name it
    status: Literal["enabled", "needs_review", "disabled"]
    review_reason: Literal["new", "changed", "delisted"] | None = None   # set only while needs_review: a connect not yet
                                          # confirmed, a changed definition (pending_sha256 set), a tool its server stopped listing
    business: "BusinessToolDef | None" = None

class ToolCall(BaseModel):                # what Claude proposed (untrusted)
    call_id: str
    tool: str                             # unknown, or not given to this session → refuse
    args: dict

class ResourceRef(BaseModel):
    kind: Literal["quote", "slot", "booking", "document", "charge", "desk"]
    id: str
    owner_person_id: str | None           # looked up by the kernel, never read from args

class NormalizedAction(BaseModel):        # immutable; decisions, approvals and executions bind to it
    action_id: str
    copy_id: str
    desk_id: str
    session_id: str
    generation: int
    tool: "AnyToolName"
    effects: list[Effect]
    args_sha256: str                      # sha256 of canonical_json(adapter-normalized args)
    profile_sha256: str
    resource: ResourceRef                 # kind "desk" when the tool acts on no specific record
    list_cents: int | None                # from the Desk's price list (quotes, links, charges); a refund's from the charge record
    discount_bp: int | None               # requested_discount_bp from the args (untrusted), 0..10_000
    amount_cents: int | None              # list_cents - list_cents * discount_bp // 10_000; a refund is the charge's full amount; 0..1_000_000
    recipient: Literal["owner", "verified_contact"] | None
    starts_at: AwareDatetime | None

# Review (Decisions layer): reviewer scores in basis points, not calibrated probabilities; integers keep Cedar comparisons plain
class ReviewThresholds(BaseModel):        # one row of review_thresholds.py (per effect, versioned)
    min_within_charter_bp: int = Field(ge=0, le=10_000)
    max_manipulation_bp: int = Field(ge=0, le=10_000)

class Review(BaseModel):                  # Sonnet 5.5 structured output; a validation failure = absent
    within_charter_bp: StrictInt = Field(ge=0, le=10_000)
    manipulation_bp: StrictInt = Field(ge=0, le=10_000)
    recommendation: Literal["allow", "hold", "block"]   # anything but "allow" turns an allow into a hold; "block" also adds a strike

# Decisions
Outcome = Literal["allow", "hold", "refuse"]
DecisionState = Literal["allowed", "held", "refused", "approved", "denied", "expired", "cancelled",
                        "executed", "failed", "unknown", "refused_at_execution"]
ApprovalAnswer = Literal["allow_once", "deny_once", "allow_person", "deny_always"]

class Decision(BaseModel):
    decision_id: str
    session_id: str
    call_id: str
    action: NormalizedAction | None       # None only for a step-1 refusal before normalization
    outcome: Outcome
    state: DecisionState
    policy_version: int
    policy_ids: list[str]
    card_ids: list[str]
    review: Review | None = None
    reason_plain: str                     # owner-facing kernel template from the action and deciding cards; the call's free text quoted, labelled "Claude's note"
    owner_plain: str | None = None        # owner-facing kernel template: why an approved or allowed action didn't run (`refused_at_execution`), or a held request a booking closed (`cancelled`); None otherwise.
                                          # Owner-authenticated reads only (GET /decisions/{id}, the approval answer); None on every answer to a session or
                                          # agent. Fixed templates in the owner's language, never free text; like reason_plain, the signature doesn't cover it
    visitor_plain: str                    # visitor-facing kernel template (en/es); no amounts, dates or limits
    answers: list[ApprovalAnswer] = []    # held only; allow_person only where "Decision lifecycle" allows it
    expires_at: AwareDatetime             # allow: 60 s; hold: 24 h; evaluated lazily by the kernel
    # `inbox` is filled only on the `/decide` answer that created the alerts; every read returns `[]`
    inbox: list[InboxNotice] = []         # owner alerts this decision created (holds, breaker pauses); code-free
    ledger_seq: int                       # each state change writes a ledger entry and re-signs the decision
    signature: str                        # Ed25519 over b"desk-decision-v1\0" + sha256(canonical_json {decision_id, session_id, state, visitor_plain, ledger_seq})

# Rules
_RULE_TARGETS = frozenset(get_args(ToolName)) | {f"effect:{effect}" for effect in get_args(Effect)}

class RuleCard(BaseModel):                # Claude drafts, code compiles, the owner reads
    card_id: str
    applies_to: str                       # a tool ("native.book") or an effect ("effect:charge")
    mode: Literal["auto", "ask", "never"]
    who: Literal["anyone", "verified", "record_owner", "person", "agent"]
    person_id: str | None = None          # required iff who == "person"
    agent_key_id: str | None = None       # required iff who == "agent"
    max_amount_cents: StrictInt | None = Field(None, ge=0)   # auto only; required and <= AUTO_MONEY_HARD_CAP_CENTS when applies_to is in MONEY_TOOLS or effect:charge|pay_out;
                                          # a card alone cannot know a business tool's effects: callers supply those money tools;
                                          # the kernel also holds it to its version's auto_money_cap_cents ("Money cap")
    max_discount_bp: StrictInt = Field(0, ge=0, le=10_000)   # auto only; a larger requested discount asks
    hours: HoursWindow | None = None      # auto only
    review: bool = False                  # auto only: gate on the reviewer, thresholds from review_thresholds.py
    is_default: bool = False              # compiler-emitted "ask" (who="anyone") unless cards for anyone cover the tool; ranks below every card
    reason: str                           # one owner-facing sentence

    @model_validator(mode="after")
    def _limits_only_on_auto(self) -> Self:
        if self.applies_to not in _RULE_TARGETS and not is_business_tool(self.applies_to):
            raise ValueError('applies_to names a tool or an effect ("effect:charge")')
        limited = self.max_amount_cents is not None or self.max_discount_bp != 0 or self.hours is not None
        if self.mode != "auto" and (self.review or limited):
            raise ValueError("review and limits apply only to auto cards")
        if self.mode == "auto" and moves_money(self) and (
            self.max_amount_cents is None or self.max_amount_cents > AUTO_MONEY_HARD_CAP_CENTS
        ):
            raise ValueError(AUTO_MONEY_NEEDS_LIMIT)
        if (self.who == "person") != (self.person_id is not None):
            raise ValueError('person_id is required iff who == "person"')
        if (self.who == "agent") != (self.agent_key_id is not None):
            raise ValueError('agent_key_id is required iff who == "agent"')
        if self.is_default and (self.mode != "ask" or self.who != "anyone"):
            raise ValueError('a default card is the compiler\'s "ask" card for anyone')
        return self

def moves_money(card: RuleCard, money_tools: Collection[str] = frozenset()) -> bool:
    """Does the card take or pay out money: on a money tool, or on an effect in `MONEY_EFFECTS`.
    Defined here alone: `RuleCard` holds an auto money card to an amount with it, and the money cap
    (`desk.money_cap`) and the kernel's compiler read it too. A card alone cannot know a business
    tool's effects: callers with the Desk's profiles supply `money_tools`; RuleCard's own validator
    calls this without that set."""
    return (card.applies_to in MONEY_TOOLS or card.applies_to in money_tools
            or card.applies_to in {f"effect:{effect}" for effect in MONEY_EFFECTS})

def money_tool(tool: str, effects: Iterable[str]) -> bool:
    """Does a tool with these effects take or pay out money: a money tool, or one with an effect in
    `MONEY_EFFECTS`. Defined here alone: the kernel's compiler requires and caps the amount of every
    auto permit on such a tool with it, and the reference generator, the bounded check and decide
    read it too."""
    return tool in MONEY_TOOLS or not MONEY_EFFECTS.isdisjoint(effects)

def money_tools_of(tools: Iterable[tuple[str, Iterable[str]]]) -> frozenset[str]:
    """Names of tools that take or pay out money, from (tool, effects) pairs of any source or status.
    Kernel profile callers and the API's rules and setup reads share this definition; the API
    projects pairs from its read view without needing full profiles."""
    return frozenset(tool for tool, effects in tools if money_tool(tool, effects))

class ProofCheck(BaseModel):
    name: str                             # see "Proof obligations"
    ok: bool
    counterexample_plain: str | None = None   # in the owner's words
    counterexample_raw: dict | None = None

class ProofReport(BaseModel):
    ok: bool
    method: Literal["symcc", "bounded"]   # "bounded" is shown as "checked on N cases", never "proven", and never activates
    cases: int | None = None
    timed_out: bool = False               # exit 2 or timeout: the owner sees "Rules can't be checked right now", no counterexample
    checks: list[ProofCheck]

class PolicyVersion(BaseModel):
    desk_id: str
    version: int
    parent_version: int | None
    cards: list[RuleCard]                 # owner cards plus the compiler's default ask cards
    cedar_sha256: str
    schema_sha256: str
    baseline_sha256: str
    profiles_sha256: str                  # sha256(canonical_json) of the profiles this version enables (enabled ones plus its draft's), by tool,
                                          # each with its definition_sha256, no status or pending fields
    invariants_sha256: str                # the invariant files, the check list and the desk-prove version
    review_thresholds_version: int
    auto_money_cap_cents: int = Field(0, ge=0, le=AUTO_MONEY_HARD_CAP_CENTS)  # this version's money cap, compiled and proved at; the active version's is the Desk's cap (Plan 01b)
    status: Literal["draft", "proved", "rejected", "active", "superseded"]
    proof: ProofReport | None = None

class Probe(BaseModel):                   # a setup safety probe: a hypothetical caller and resource; nothing is resolved or executed
    actor: ActorKind
    who: Literal["anyone", "verified", "record_owner", "person", "agent"]   # the caller's standing, as in RuleCard
    subject_id: str | None = None         # the person_id or agent_key_id when who is "person" or "agent"
    agent_mandate_remaining_cents: StrictInt | None = None   # agent probes only
    call: ToolCall                        # args are normalized; the resource and price are the stand-ins below
    resource_kind: Literal["quote", "slot", "booking", "document", "charge", "desk"]
    resource_owner: Literal["caller", "other", "none"] = "none"
    amount_cents: StrictInt | None = None   # stand-in price for money tools
    starts_at: AwareDatetime | None = None  # slot and booking probes; None = the kernel's now

    @model_validator(mode="after")
    def _subject_when_scoped(self) -> Self:
        if (self.who in ("person", "agent")) != (self.subject_id is not None):
            raise ValueError('subject_id is required iff who is "person" or "agent"')
        return self

class ProbeResult(BaseModel):
    probe: Probe
    outcome: Outcome                      # with review absent
    depends_on_review: bool               # the pre phase returned needs_review: auto if the reviewer agrees
    card_ids: list[str]
    reason_plain: str

# Approvals
class Approval(BaseModel):                # the kernel's record is the token; single use
    approval_id: str
    decision_id: str
    answer: ApprovalAnswer
    nonce: str                            # random per approval
    binding_sha256: str                   # sha256(canonical_json {copy_id, desk_id, session_id, action_id, args_sha256, profile_sha256, nonce})
    policy_version: int                   # recorded; execution re-decides against the current version
    expires_at: AwareDatetime
    consumed_at: AwareDatetime | None = None

# Facts and knowledge
class Fact(BaseModel):
    fact_id: str                          # "quote:Q-1042", "booking:B-77", "charter:hours", "owner:S-3"
    kind: Literal["quote", "booking", "payment_link", "document", "charter", "knowledge", "owner_statement",
                  "charge", "refund", "handoff", "slots"]
    status: Literal["available", "proposed", "committed", "expired"]
    source: Literal["kernel", "owner"]    # only adapters and authenticated owner input create facts
    claims: list[Claim]
    label: Label
    expires_at: AwareDatetime | None = None

KnowledgeSource = Literal["website", "upload", "setup", "memory_import", "web_search"]


class KnowledgeItem(BaseModel):           # untrusted text; never policy
    item_id: str
    source: KnowledgeSource
    title: str
    text: str
    label: Label                          # owner-only until the owner marks it public

class DemoInboxEntry(BaseModel):          # only from GET /demo_inbox; never stored in app.*
    entry_id: str
    to: str
    kind: Literal["verification_code", "alert", "head_checkpoint"]
    body: str                             # may contain a code
    created_at: AwareDatetime
    decision_id: str | None = None        # only on the owner's alert for a held request: that decision's own id
    title: str | None = None              # only on the owner's own alerts: the alert's fixed preview line, never a code

class ExecResult(BaseModel):
    action_id: str
    state: Literal["succeeded", "failed", "unknown"]   # "unknown" is reconciled, never retried blindly
    facts: list[Fact]
    model_view: dict                      # adapter-validated, label-filtered summary for Claude; never raw tool output
    inbox: list[InboxNotice] = []         # for the Demo inbox panel; never shown to Claude

class ApprovalResult(BaseModel):
    decision: Decision
    execution: ExecResult | None          # allow_once / allow_person execute inside the answer call
    card_diff: list[RuleCard] | None      # allow_person / deny_always: cards the owner proves (/policy/draft) and confirms
    approved: Decision | None = None     # signed approved state: "{owner} approved this" for an answer that runs
                                         # None for a denial, or an approval the rules recheck refuses (refused_at_execution)

# Replies: typed clauses plus guarded prose
ClauseTemplate = Literal["quote", "booking_options", "booking_confirmed", "payment_link", "document_link",
                         "hours", "policy", "contact", "handoff", "verify_prompt", "owner_said",
                         "charges", "refund_issued", "charge_confirmed", "callback_confirmed", "payment_confirmed",
                         "link_cancelled"]   # link_cancelled: Plan 01c ("Payment links")

class Clause(BaseModel):                  # rendered by code from a fact, in the reply's language
    template: ClauseTemplate
    fact_id: str | None = None

class ReplyDraft(BaseModel):              # send_reply input: Claude's schema has prose and clauses only (never owner_said,
                                          # payment_confirmed or link_cancelled, which only the kernel issues), the API fills the rest;
                                          # end_turn text becomes prose with no clauses
    session_id: str
    generation: int
    prose: str
    clauses: list[Clause] = []

class Violation(BaseModel):
    kind: Literal["number_in_prose", "promise_word", "soft_promise", "unknown_fact", "unentitled_fact",
                  "stale_fact", "canary", "unsupported_language", "uncertain_language", "check_unavailable", "session_paused"]
    span: str
    fact_ids: list[str] = []
    rule_id: str

class CardOption(BaseModel):              # a choice on a booking_options card
    option_id: str                        # the slot_id
    label: str

class RenderedBlock(BaseModel):           # every field is kernel-rendered and covered by blocks_sha256
    kind: Literal["prose", "card"]
    template: ClauseTemplate | None = None
    text: str                             # the whole block as plain text
    fact_id: str | None = None
    title: str | None = None              # card data, filled per template ("Clauses" row)
    lines: list[str] = []
    href: str | None = None               # payment_link, document_link: the proxied path (/pay/{token}, /api/d/{token}), the only
                                          # place a link token reaches a visitor; tokens never go in fact claims
    options: list[CardOption] = []

class ReplyVerdict(BaseModel):
    ok: bool
    language: Literal["en", "es"]         # the blocks' language: detected, else the fallback ("Language" row)
    blocks: list[RenderedBlock]           # exactly what may be shown; a failed check of Claude's draft keeps its checked cards,
                                          # then any drafted handoff, when only its prose failed (desk.rewrites.PROSE_ONLY),
                                          # else gives the handoff clause, but none on a first attempt the API rewrites (CheckReplyRequest.final false,
                                          # every violation rewritable); a blocked owner say none
    violations: list[Violation]
    message_id: str
    generation: int                       # the session generation it was checked at; deliver() drops it once stale
    visitor_plain: str                    # the reply receipt (kernel template)
    ledger_seq: int
    signature: str                        # Ed25519 over b"desk-verdict-v1\0" + sha256(canonical_json {session_id, generation, message_id, blocks_sha256, visitor_plain, ledger_seq})
                                          # blocks_sha256 = sha256(canonical_json(blocks))

class ReplayedEvent(BaseModel):           # one moment of the recorded night as POST /copies replayed it into the copy
    session_id: str                       # the copy's own session, closed at generation 0
    shown_at: SignedTime                  # not signed: the ledger entry's summary.replayed.at is the signed record of the time
    kind: Literal["visitor_message", "reply", "receipt"]
    text: str | None                      # visitor_message only: the persona's words (untrusted text)
    verdict: ReplyVerdict | None          # reply: a full signed ReplyVerdict
    decision: Decision | None             # receipt: a full signed Decision, in its final state
    author: Literal["claude", "desk"] = "claude"   # reply only; other kinds retain the default

    @model_validator(mode="after")
    def _author_matches_kind(self) -> Self:
        if self.kind != "reply" and self.author != "claude":
            raise ValueError("only a replayed reply may be authored by the Desk")
        return self

class SeededChat(BaseModel):
    session_id: str
    visitor_line: str                     # the visitor's own words (untrusted text)
    decision: Decision                   # the signed held decision

class CopyCreated(BaseModel):             # POST /copies; the owner token is the copy credential
    copy_id: str
    desk_ids: list[str]
    owner_session: SessionState
    owner_token: str                      # 256-bit CSPRNG, stored hashed, sent as X-Owner-Session
    seeded_chat: SeededChat | None = None  # None when the copy seeds no held request
    replayed_messages: list[ReplayedEvent] = []   # in shown order; empty without a replay
    replay_id: str | None = None          # the recording id the replayed kernel rows carry; None without a replay

class OwnerMessageResult(BaseModel):
    message_id: str
    verdict: ReplyVerdict | None          # say: one owner_said block, signed; whisper: None
    ledger_seq: int

# Payments (mocked) and visiting agents
PaymentLinkState = Literal["issued", "paid", "expired", "cancelled", "unknown"]

class Mandate(BaseModel):                 # signed delegation envelope
    mandate_id: str
    issuer: str                           # must be a trusted issuer key held by the kernel ("demo-wallet")
    agent_key_id: str                     # must equal the session's AgentAuth key
    desk_id: str                          # audience
    on_behalf_of: str | None = None       # display only; grants nothing
    allowed_effects: list[Literal["charge"]]   # a visitor's mandate never authorizes pay_out
    per_charge_cents: StrictInt
    total_cents: StrictInt                # cumulative; the kernel reserves, commits and releases under FOR UPDATE
    currency: Literal["usd"]
    expires_at: SignedTime                # signed as the literal string
    nonce: str
    sig: str                              # issuer's Ed25519 signature over the canonical JSON of the fields above

class A2ARequest(BaseModel):              # body of POST /api/a2a/{desk_slug}; AgentAuth travels in its headers
    desk_slug: str
    session_id: str | None = None         # None opens a session, bound by the kernel to the signing key
    message: str                          # untrusted text
    mandate: Mandate | None = None        # checked when the session opens
    verify_code: str | None = None        # from the agent's human after start_verification; the API sends it to /verify/check,
                                          # never into Claude's context

class DemoAgentIssued(BaseModel):         # POST /agents/demo: a simulated third party
    agent_key_id: str
    agent_private_key_hex: str            # returned once to the agent's runner; the agent signs its own requests
    mandate: Mandate                      # demo-wallet signed ("Turner seed")

# Ledger
class LedgerEvent(BaseModel):
    kind: Literal["session", "auth", "verify", "decide", "review", "breaker", "approval", "execute",
                  "payment", "document_link", "reply", "policy", "tool_pin", "takeover", "whisper",
                  "rate_limit", "agent_auth", "head_checkpoint", "desk_data", "web_search", "business_tools"]
    origin: Literal["kernel", "api"]      # "api" events are recorded as reported, not as verified
    session_id: str | None = None
    ref_id: str | None = None
    summary: dict                         # never secrets, codes, contacts or document bodies

class LedgerEntry(BaseModel):
    copy_id: str
    desk_id: str
    seq: int
    prev_hash: str                        # 64 hex; the genesis entry uses 64 zeros
    created_at: str                       # RFC 3339 UTC with microseconds and "Z": "2026-10-30T17:04:05.123456Z"
    event: LedgerEvent
    hash: str                             # sha256 of canonical_json {copy_id, desk_id, seq, prev_hash, created_at, event}, nulls explicit
    signature: str                        # Ed25519 over b"desk-ledger-v1\0" + the 32-byte hash
    key_id: str

class LedgerPage(BaseModel):
    entries: list[LedgerEntry]
    head: str
    chain_ok: bool
    first_bad_seq: int | None
    public_key_hex: str
    key_id: str

# Business tools: configurations of kernel-owned blocks, never executable owner input.
BusinessToolName = Annotated[str, StringConstraints(pattern=r"^desk\.[a-z][a-z0-9-]{0,39}$")]
AnyToolName = ToolName | BusinessToolName


def is_business_tool(tool: str) -> bool:
    import re
    return re.fullmatch(r"desk\.[a-z][a-z0-9-]{0,39}", tool) is not None


class IntakeConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    block: Literal["intake"]
    questions: list[Annotated[str, Field(max_length=120)]] = Field(min_length=1, max_length=5)


class TypedBookingConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    block: Literal["typed_booking"]
    appointment_type: str = Field(max_length=60)
    minutes: StrictInt = Field(ge=15, le=60)


class PurposePaymentConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    block: Literal["purpose_payment"]
    purpose: str = Field(max_length=60)
    amount_cents: StrictInt = Field(ge=0, le=1_000_000)


class UrgentConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    block: Literal["urgent"]
    urgent_when: str = Field(max_length=300)


BlockConfig = Annotated[IntakeConfig | TypedBookingConfig | PurposePaymentConfig | UrgentConfig,
                        Field(discriminator="block")]


class BusinessToolDef(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    title: str = Field(max_length=60)
    description: str = Field(max_length=300)
    config: BlockConfig


class BusinessTool(BusinessToolDef):
    tool: BusinessToolName


ToolProfile.model_rebuild()
NormalizedAction.model_rebuild()
