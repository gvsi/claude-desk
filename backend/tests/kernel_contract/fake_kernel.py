"""FakeKernel: the kernel HTTP API v2 in this process, for the API's tests (never in an image).

`fake_kernel_app(state)` is an ASGI app that answers the master plan's "Kernel HTTP API v2" routes the
API uses, with the behavior Plan 02a relies on: a Rivera Plumbing copy, sessions with hashed tokens,
"Session state responses" in order, decisions, executions, approvals, reply checks and the ledger.
tests/kernel_contract/test_contract.py runs the same tests against it and the real kernel, so the
API's tests can't lean on a behavior the kernel doesn't have. Later tasks add routes here, each with a
contract test, before the task that first uses them.

- State lives in memory (`FakeKernelState`); before each answer, the rows that changed are written to
  `fake_kernel_ro` (ro_tables), which the API reads in place of `kernel_ro`.
- Signatures are `"fake:" + sha256 hex` of the fields the kernel signs. Times come from `state.now`.
- Every non-2xx body is a `KernelError`; a body that isn't the route's request model is 422 `invalid`;
  every answer is checked against the route's response model before it leaves.
- Knobs for tests: `fail`, `drop_response`, `set_mode`, `script`, `violation`, `verify`, and `calls`
  (with `called(route)`); `now` drives expiry and the 24-hour idle close. A `"timeout"` or `"connect"`
  failure is raised as httpx's own exception, which reaches the client through `httpx.ASGITransport`.
- Not modelled: Cedar, the reviewer, the breaker's strikes (`set_mode` pauses), `auth` ledger entries
  for refused calls, owner reads of decisions (Task 9), agents, verification routes and payments (Plans
  01b, 01c and 02b add them).
"""

import hashlib
import json
import re
import secrets
import string
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, get_args
from zoneinfo import ZoneInfo

import httpx
from pydantic import BaseModel, TypeAdapter, ValidationError
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route, Router

from desk.contracts import (
    AUTO_MONEY_HARD_CAP_CENTS,
    ITEM_ID_PATTERN,
    MONEY_TOOLS,
    SLOT_ID_PATTERN,
    ApprovalResult,
    CalendarSlot,
    CardOption,
    Claim,
    Clause,
    CopyCreated,
    Decision,
    ExecResult,
    Fact,
    HoursWindow,
    InboxNotice,
    Label,
    LedgerEntry,
    LedgerEvent,
    LedgerPage,
    NormalizedAction,
    PriceItem,
    RenderedBlock,
    ReplyVerdict,
    ResourceRef,
    RuleCard,
    SessionCreated,
    SessionState,
    ToolCall,
    ToolName,
    ToolProfile,
    Violation,
)
from desk.kernel_api import (
    KERNEL_ROUTES,
    AnswerRequest,
    CancelRequest,
    CheckReplyRequest,
    CreateSessionRequest,
    DecideRequest,
    ExecuteRequest,
    Health,
    KernelError,
    LedgerAppendRequest,
    PublicDesk,
    SessionContext,
    WhoAmI,
)
from tests.kernel_contract.ro_tables import FakeRO

IDLE_LIMIT = timedelta(hours=24)        # a visitor or agent session closes after this long idle
GENESIS = "0" * 64
KEY_ID = "fake-kernel"
PUBLIC_KEY_HEX = "00" * 32           # no real key: fake signatures verify against nothing

class Refusal(Exception):
    """A non-2xx answer: its status and `KernelError.code`."""

    def __init__(self, status: int, code: str):
        super().__init__(f"{status} {code}")
        self.status, self.code = status, code


def sha256_hex(value: str | bytes) -> str:
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def canonical(value: Any) -> str:
    """Sorted keys, no spaces: what the fake hashes and signs (the kernel uses RFC 8785)."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def fake_signature(fields: dict) -> str:
    return "fake:" + sha256_hex(canonical(fields))


def new_id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(5)}"


# The master plan's "Rivera seed", with Plan 01a's specifics.
RIVERA_TZ = ZoneInfo("America/Los_Angeles")
RIVERA_HOURS = [HoursWindow(days=["mon", "tue", "wed", "thu", "fri"], start=time(8), end=time(18)),
                HoursWindow(days=["sat"], start=time(9), end=time(13))]
SLOT_HOURS = {0: (8, 10, 12, 14, 16), 1: (8, 10, 12, 14, 16), 2: (8, 10, 12, 14, 16), 3: (8, 10, 12, 14, 16),
              4: (8, 10, 12, 14, 16), 5: (9, 11)}   # by weekday(), Monday 0; 120-minute slots
RIVERA_PRICES = [PriceItem(item_id="deposit", title="Service call deposit", unit_cents=2000),
                 PriceItem(item_id="drain", title="Drain clearing", unit_cents=18000),
                 PriceItem(item_id="heater", title="Water heater flush", unit_cents=15000),
                 PriceItem(item_id="leak", title="Leak repair", unit_cents=25000)]
RIVERA_PEOPLE = [("dana", "Dana Whitfield", "dana@example.com"), ("bob", "Bob Okafor", "bob@example.com")]
RIVERA_DOCUMENTS = [("dana-invoice", "Invoice, drain clearing", "dana"),
                    ("bob-warranty", "Warranty, water heater flush", "bob")]
RIVERA_CHARTER = [Claim(key="contact", kind="text", value="(510) 555-0142"),
                  Claim(key="policy:service_area", kind="text",
                        value="We work in Oakland, Berkeley, Alameda and Emeryville."),
                  Claim(key="policy:first_visit", kind="text",
                        value="The service call deposit is credited to the repair if you go ahead."),
                  Claim(key="policy:arrival", kind="text", value="Maria texts before she arrives.")]
NOTIFICATIONS = {"now": ["approval", "emergency", "breaker", "lockout"], "briefing": ["lead", "callback", "booking"]}


def _card(card_id: str, applies_to: str, mode: str, who: str, reason: str, **limits) -> RuleCard:
    return RuleCard(card_id=card_id, applies_to=applies_to, mode=mode, who=who, reason=reason, **limits)


RIVERA_CARDS = [
    *(_card(f"preset-{tool.split('.')[1]}", tool, "auto", "anyone", reason) for tool, reason in (
        ("native.find_slots", "Showing open times is always fine."),
        ("native.capture_lead", "Taking down a customer's details is always fine."),
        ("native.request_callback", "Asking you to call someone back is always fine."),
        ("native.start_verification", "Sending a code to the contact on record is always fine."),
        ("native.fetch_website", "Reading your website during setup is always fine."),
        ("native.read_memory", "Reading your notes during setup is always fine."))),
    _card("rv-quote", "native.quote", "auto", "anyone", "Quotes from your price list, at list price."),
    _card("rv-book-wk", "native.book", "auto", "anyone", "Weekday bookings in opening hours, checked by the reviewer.",
          hours=RIVERA_HOURS[0], review=True),
    _card("rv-book-sat", "native.book", "auto", "anyone", "Saturday morning bookings, checked by the reviewer.",
          hours=RIVERA_HOURS[1], review=True),
    _card("rv-docs", "native.release_document", "auto", "record_owner",
          "Customers get their own documents after confirming it's them."),
    *(RuleCard(card_id=f"default-{tool}", applies_to=tool, mode="ask", who="anyone", is_default=True,
               reason="Anything your rules don't cover waits for you.")
      for tool in ("native.release_document", "native.payment_link", "native.charge_mandate",
                   "payments.list_charges", "payments.create_refund")),
]


def _closed(properties: dict, required: tuple[str, ...] = ()) -> dict:
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


TEXT = {"type": "string", "minLength": 1}
QUOTE_ITEM = _closed({"item_id": {"type": "string", "pattern": ITEM_ID_PATTERN},
                      "qty": {"type": "integer", "minimum": 1, "maximum": 10}}, ("item_id", "qty"))
INPUT_SCHEMAS = {
    "native.quote": _closed({"items": {"type": "array", "minItems": 1, "maxItems": 5, "items": QUOTE_ITEM},
                             "requested_discount_bp": {"type": "integer", "minimum": 0, "maximum": 10_000},
                             "note": {"type": ["string", "null"], "maxLength": 200}}, ("items",)),
    "native.find_slots": _closed({"from_date": {"type": ["string", "null"], "format": "date"},
                                  "days": {"type": "integer", "minimum": 1, "maximum": 14}}),
    "native.book": _closed({"slot_id": {"type": "string", "pattern": SLOT_ID_PATTERN}}, ("slot_id",)),
    "native.release_document": _closed({"document_id": {**TEXT, "maxLength": 64}}, ("document_id",)),
    "native.payment_link": _closed({"quote_id": TEXT}, ("quote_id",)),
    "native.capture_lead": _closed({"name": {**TEXT, "maxLength": 80},
                                    "contact": {"type": ["string", "null"], "maxLength": 120},
                                    "note": {"type": ["string", "null"], "maxLength": 200}}, ("name",)),
    "native.request_callback": _closed({"name": {**TEXT, "maxLength": 80}, "contact": {**TEXT, "maxLength": 120},
                                        "reason": {**TEXT, "maxLength": 200}}, ("name", "contact", "reason")),
    "native.start_verification": _closed({"contact": {**TEXT, "maxLength": 120}}, ("contact",)),
    "payments.list_charges": _closed({}),
    "payments.create_refund": _closed({"charge_id": TEXT}, ("charge_id",)),
}
# tool: (effects, reversible, resource kind, what Claude is told)
TOOL_FACTS = {
    "native.quote": (["change"], True, "desk",
                     "Quote services from the business's price list; prices appear in a card."),
    "native.find_slots": (["read"], True, "desk", "List open appointment times; times appear in a card."),
    "native.book": (["change"], True, "slot", "Book an open appointment time by its slot id."),
    "native.release_document": (["private_data", "send_message"], False, "document",
                                "Send a verified customer a link to their own document."),
    "native.payment_link": (["charge"], False, "quote", "Create a payment link for a quote."),
    "native.capture_lead": (["change"], True, "desk", "Save a customer's name and how to reach them."),
    "native.request_callback": (["change"], True, "desk", "Ask the owner to call the customer back."),
    "native.start_verification": (["send_message"], True, "desk",
                                  "Send a code to the contact the business has on record."),
    "payments.list_charges": (["private_data"], True, "charge", "List the verified customer's own charges."),
    "payments.create_refund": (["pay_out", "private_data"], False, "charge",
                               "Refund one of the verified customer's charges in full."),
}
# The ten tools a visitor could ever be given, and those an unverified or a verified visitor has now.
VISITOR_DECLARED = tuple(TOOL_FACTS)
UNVERIFIED_TOOLS = ("native.quote", "native.find_slots", "native.book", "native.payment_link",
                    "native.capture_lead", "native.request_callback", "native.start_verification")
VERIFIED_TOOLS = ("native.quote", "native.find_slots", "native.book", "native.payment_link", "native.capture_lead",
                  "native.request_callback", "native.release_document", "payments.list_charges",
                  "payments.create_refund")
ANSWERING_OFF_TOOLS = ("native.capture_lead", "native.request_callback")


TOOL_NAMES = frozenset(get_args(ToolName))
ALLOW_FOR = timedelta(seconds=60)       # an allow must execute within this
HOLD_FOR = timedelta(hours=24)          # a hold waits this long for the owner
# Visitor-facing status lines (the kernel's are en/es templates): no amounts, dates or limits.
STATUS_TEXT = {
    "allowed": "That's within the business's rules.",
    "held": "I've asked {owner} to look at this.",
    "refused": "That isn't something I can do here.",
    "approved": "{owner} approved this.",
    "denied": "{owner} said no to this.",
    "expired": "This request has expired.",
    "cancelled": "You cancelled this request.",
    "executed": "Done.",
    "failed": "That didn't go through.",
    "unknown": "I'm still checking whether that went through.",
    "refused_at_execution": "The rules changed, so this didn't go ahead.",
}
HELD_ANSWERS = ("allow_once", "allow_person", "deny_once", "deny_always")


def tool_profile(tool: str) -> ToolProfile:
    effects, reversible, resource_kind, description = TOOL_FACTS[tool]
    source = "mcp" if tool.startswith("payments.") else "native"
    return ToolProfile(tool=tool, source=source, effects=effects, reversible=reversible, adapter=f"fake.{tool}",
                       resource_kind=resource_kind, description_confirmed=description,
                       input_schema=INPUT_SCHEMAS[tool],
                       definition_sha256=sha256_hex(tool) if source == "mcp" else None, status="enabled")


def signed_time(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def mask_contact(contact: str) -> str:
    name, _, domain = contact.partition("@")
    return f"{name[0]}•••@{domain}"


def rivera_slots(now: datetime) -> list[CalendarSlot]:
    """Two-hour slots in the opening hours for the 14 days after `now`, in business time."""
    today = now.astimezone(RIVERA_TZ).date()
    slots = []
    for offset in range(1, 15):
        day = today + timedelta(days=offset)
        for hour in SLOT_HOURS.get(day.weekday(), ()):
            starts_at = datetime.combine(day, time(hour), tzinfo=RIVERA_TZ)
            slots.append(CalendarSlot(slot_id=f"S-{day:%Y%m%d}-{hour:02d}00", starts_at=starts_at, minutes=120))
    return slots


def in_hours(moment: datetime, windows: list[HoursWindow]) -> HoursWindow | None:
    """The opening-hours window `moment` (in business time) falls in, if any."""
    local = moment.astimezone(RIVERA_TZ)
    day = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")[local.weekday()]
    for window in windows:
        end = window.end if window.end != time(0) else time.max
        if day in window.days and window.start <= local.time() < end:
            return window
    return None


_JSON_TYPES = {"object": dict, "array": list, "string": str, "null": type(None)}


def matches(schema: dict, value: Any) -> bool:
    """Whether `value` fits one of the closed input schemas above (the subset of JSON Schema they use).
    Integers are strict: `"1"`, `1.0` and `true` are not integers."""
    kinds = schema.get("type", [])
    kinds = [kinds] if isinstance(kinds, str) else kinds
    if not any(type(value) is int if kind == "integer" else isinstance(value, _JSON_TYPES[kind]) for kind in kinds):
        return False
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        if set(value) - set(properties) or set(schema.get("required", ())) - set(value):
            return False
        return all(matches(properties[name], item) for name, item in value.items())
    if isinstance(value, list):
        return (schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", len(value))
                and all(matches(schema["items"], item) for item in value))
    if isinstance(value, str):
        if not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", len(value)):
            return False
        if "pattern" in schema and re.fullmatch(schema["pattern"], value) is None:
            return False
        if schema.get("format") == "date":
            try:
                date.fromisoformat(value)
            except ValueError:
                return False
        return True
    if type(value) is int:
        return schema.get("minimum", value) <= value <= schema.get("maximum", value)
    return True


# Replies ---------------------------------------------------------------------------------------------
# Which fact kind each clause template renders (the kernel's "Clause rendering"); owner_said and
# payment_confirmed are the kernel's own, and handoff and verify_prompt cite no fact.
TEMPLATE_KINDS = {"quote": "quote", "booking_options": "slots", "booking_confirmed": "booking",
                  "payment_link": "payment_link", "document_link": "document", "hours": "charter", "policy": "charter",
                  "contact": "charter", "charges": "charge", "refund_issued": "refund", "charge_confirmed": "charge",
                  "callback_confirmed": "handoff"}
KERNEL_ONLY_TEMPLATES = ("owner_said", "payment_confirmed")
FACTLESS_TEMPLATES = ("handoff", "verify_prompt")
OTHER_LANGUAGE_WORDS = {"bonjour", "merci", "je", "vous", "nous", "olá", "obrigado", "você", "ciao", "grazie",
                        "danke"}
SPANISH_WORDS = {"hola", "gracias", "puedo", "usted", "ayudar", "ayudarle", "con", "para", "buenos", "buenas", "días",
                 "tardes", "quiero", "necesito", "cuánto", "cuando", "está", "estoy"}
REPLY_TEXT = {"en": {"handoff": "Let me check with {owner}.", "checked": "Checked before it was shown.",
                     "handed_off": "Handed to {owner}.", "verify": "Enter the code sent to the contact on record.",
                     "hours": "Opening hours"},
              "es": {"handoff": "Déjame consultarlo con {owner}.", "checked": "Revisado antes de mostrarse.",
                     "handed_off": "Pasado a {owner}.", "verify": "Escribe el código enviado al contacto registrado.",
                     "hours": "Horario"}}
NUMBER_RULES = (("digit", re.compile(r"\d")), ("currency", re.compile(r"[$€£¥¢]")), ("percent", re.compile(r"%")))


def detect_language(prose: str) -> str:
    """`en`, `es`, `other` (prose opening "Bonjour", or in another language) or `none` (no words)."""
    words = re.findall(r"[^\W\d_]+", prose.lower())
    if not words:
        return "none"
    if words[0] == "bonjour" or set(words) & OTHER_LANGUAGE_WORDS:
        return "other"
    if set(words) & SPANISH_WORDS or any(mark in prose for mark in "ñ¿¡"):
        return "es"
    return "en"


def scan_prose(prose: str, canaries: list[str]) -> list[Violation]:
    """Digits, money signs and percent signs in prose, and document canaries (whose text no span repeats)."""
    text = unicodedata.normalize("NFKC", prose).replace("\u200b", "").replace("\u00ad", "")
    violations = []
    for rule_id, pattern in NUMBER_RULES:
        found = pattern.search(text)
        if found:
            violations.append(Violation(kind="number_in_prose", span=text[found.start():found.start() + 40],
                                        rule_id=rule_id))
    if any(canary in text for canary in canaries):
        violations.append(Violation(kind="canary", span="", rule_id="canary"))
    return violations


def money(cents: int) -> str:
    return f"${cents / 100:,.2f}"


@dataclass
class FakeCall:
    """One request the fake received: its `KERNEL_ROUTES` key, path, query, headers (lowercase names)
    and JSON body."""

    route: str
    path: str
    query: dict[str, str]
    headers: dict[str, str]
    body: Any


@dataclass
class Session:
    session_id: str
    copy_id: str
    desk_id: str | None
    kind: str
    secret_hash: str | None
    created_at: datetime
    last_seen: datetime
    verified: bool = False
    assurance: str = "none"
    person_id: str | None = None
    mode: str = "ai"
    generation: int = 0
    strikes: int = 0
    preview: bool = False
    last_language: str | None = None
    closed_at: datetime | None = None

    def state(self) -> SessionState:
        return SessionState(session_id=self.session_id, kind=self.kind, verified=self.verified,
                            assurance=self.assurance, mode=self.mode, generation=self.generation)

    def ro_row(self) -> dict:
        return {"session_id": self.session_id, "copy_id": self.copy_id, "desk_id": self.desk_id, "kind": self.kind,
                "verified": self.verified, "assurance": self.assurance, "person_id": self.person_id,
                "agent_key_id": None, "mandate_id": None, "last_language": self.last_language, "mode": self.mode,
                "generation": self.generation, "strikes": self.strikes, "preview": self.preview,
                "created_at": self.created_at, "closed_at": self.closed_at}


@dataclass
class Copy:
    copy_id: str
    owner_session_id: str
    desk_ids: list[str] = field(default_factory=list)


@dataclass
class Person:
    person_id: str
    ref: str
    display_name: str
    contact: str


@dataclass
class Document:
    document_id: str
    title: str
    record_owner_person_id: str | None
    canary: str


@dataclass
class Desk:
    desk_id: str
    copy_id: str
    business_id: str
    business_name: str
    owner_display_name: str
    brand: dict[str, str]
    name: str
    slug: str
    hours: list[HoursWindow]
    created_at: datetime
    answering: bool = True
    people: dict[str, Person] = field(default_factory=dict)          # by person_id
    documents: dict[str, Document] = field(default_factory=dict)     # by document_id
    prices: dict[str, PriceItem] = field(default_factory=dict)
    slots: dict[str, CalendarSlot] = field(default_factory=dict)
    facts: dict[str, Fact] = field(default_factory=dict)
    tools: dict[str, ToolProfile] = field(default_factory=dict)
    cards: list[RuleCard] = field(default_factory=list)
    policy_version: int = 1
    ledger: list[LedgerEntry] = field(default_factory=list)
    booked: set[str] = field(default_factory=set)                     # slot_ids with a confirmed booking

    def person(self, ref: str) -> Person:
        return next(person for person in self.people.values() if person.ref == ref)


@dataclass
class DecisionRecord:
    decision: Decision
    copy_id: str
    desk_id: str
    generation: int
    call_sha256: str
    tool: str                                   # the called name, cut to 64 characters
    created_at: datetime
    result: ExecResult | None = None


@dataclass
class Script:
    """A test's override for one tool: the outcome at /decide and the result at execution."""

    outcome: str | None = None
    exec_state: str = "succeeded"
    model_view: dict | None = None
    facts: list[Fact] | None = None


class FakeKernelState:
    """The fake kernel's memory, and the knobs tests turn."""

    def __init__(self, *, ro: FakeRO | None = None, now: datetime | None = None):
        self.now: datetime = now or datetime.now(UTC)
        self.calls: list[FakeCall] = []
        self._ro = ro
        self._dirty: dict[str, dict[tuple, dict]] = {}
        self.copies: dict[str, Copy] = {}
        self.desks: dict[str, Desk] = {}
        self.sessions: dict[str, Session] = {}
        self.decisions: dict[str, DecisionRecord] = {}
        self._by_call: dict[tuple[str, int, str], str] = {}   # (session_id, generation, call_id) -> decision_id
        self._token_hashes: dict[str, str] = {}        # sha256(token) -> session_id
        self._failures: dict[str, list] = {}           # route -> [kind, times left or None]
        self._drops: dict[str, int] = {}
        self._scripts: dict[str, Script] = {}
        self._forced: list[str] = []                   # violation kinds the next reply checks carry
        self._args: dict[str, dict] = {}                # action_id -> the call's args, as the action row binds them

    # Knobs ---------------------------------------------------------------------------------------

    def fail(self, route: str, kind: str | None, *, times: int | None = None) -> None:
        """Fail the route's next `times` calls (every call when None) with `"timeout"`, `"connect"` (no
        answer), `"500"` or `"422"`, before anything changes; `kind=None` heals it."""
        if kind not in (None, "timeout", "connect", "500", "422"):
            raise ValueError(f"unknown failure {kind!r}")
        for key in route_keys(route):
            if kind is None:
                self._failures.pop(key, None)
            else:
                self._failures[key] = [kind, times]

    def drop_response(self, route: str, *, times: int = 1) -> None:
        """The route's next `times` calls change state and commit, then time out instead of answering."""
        for key in route_keys(route):
            self._drops[key] = times

    def set_mode(self, session_id: str, mode: str) -> SessionState:
        """Take over (`owner`), hand back or resume (`ai`): generation + 1, ledgered `takeover` or `breaker`, as
        the owner's mode route does. `paused` is the breaker's third strike: strikes 3, generation unchanged."""
        session = self.sessions[session_id]
        if mode not in ("ai", "owner", "paused"):
            raise ValueError(f"unknown mode {mode!r}")
        if mode != session.mode:
            desk = self.desks[session.desk_id]
            if mode == "paused":
                session.strikes = 3
                self.append(desk, "breaker", {"paused": True}, session_id=session_id)
            else:
                resumed, session.strikes = session.mode == "paused", 0
                session.generation += 1
                self.append(desk, "breaker" if resumed and mode == "ai" else "takeover",
                            {"resumed": True} if resumed and mode == "ai" else
                            {"from": session.mode, "to": mode, "generation": session.generation},
                            session_id=session_id)
            session.mode = mode
            self._put_session(session)
            self.flush()
        return session.state()

    def verify(self, session_id: str, person_ref: str) -> SessionState:
        """Verify the session as a seeded person (`"dana"`, `"bob"`), as a correct `/verify/check` code does:
        assurance `demo_code`, generation unchanged, and `person:<id>` added to the session's facts."""
        session = self.sessions[session_id]
        desk = self.desks[session.desk_id]
        person = desk.person(person_ref)
        session.verified, session.assurance, session.person_id = True, "demo_code", person.person_id
        for fact in list(desk.facts.values()):
            readers = fact.label.readers
            if f"session:{session_id}" in readers and f"person:{person.person_id}" not in readers:
                label = Label(readers=[*readers, f"person:{person.person_id}"], record_owner=person.person_id)
                self._put_fact(desk, fact.model_copy(update={"label": label}))
        self.append(desk, "verify", {"session_id": session_id, "verified": True}, session_id=session_id)
        self._put_session(session)
        self.flush()
        return session.state()

    def script(self, tool: str, outcome: str | None = None, exec_state: str = "succeeded",
               model_view: dict | None = None, facts: list[Fact] | None = None) -> None:
        """Override the tool from now on: `outcome` (`allow`, `hold`, `refuse`; None keeps the seed's rule) for a
        call that normalizes, and the execution's state, `model_view` and facts (None keeps the tool's own)."""
        if outcome not in (None, "allow", "hold", "refuse") or exec_state not in ("succeeded", "failed", "unknown"):
            raise ValueError("unknown outcome or execution state")
        self._scripts[tool] = Script(outcome, exec_state, model_view, facts)

    def violation(self, kind: str, *, times: int = 1) -> None:
        """The next `times` reply checks carry a `kind` violation (any `Violation.kind`, `canary` included)."""
        Violation(kind=kind, span="", rule_id="fake")           # refuses an unknown kind
        self._forced.extend([kind] * times)

    def called(self, route: str) -> list[FakeCall]:
        keys = route_keys(route)
        return [call for call in self.calls if call.route in keys]

    def _take_failure(self, key: str) -> str | None:
        failure = self._failures.get(key)
        if failure is None:
            return None
        kind, left = failure
        if left is not None:
            if left <= 1:
                del self._failures[key]
            else:
                failure[1] = left - 1
        return kind

    def _take_drop(self, key: str) -> bool:
        left = self._drops.get(key, 0)
        if left <= 0:
            return False
        self._drops[key] = left - 1
        return True

    # Mirror --------------------------------------------------------------------------------------

    def _put(self, view: str, key: tuple, row: dict) -> None:
        self._dirty.setdefault(view, {})[key] = row

    def flush(self) -> None:
        """Write every row that changed to fake_kernel_ro (when the state has one)."""
        dirty, self._dirty = self._dirty, {}
        if self._ro is not None and dirty:
            self._ro.write({view: list(rows.values()) for view, rows in dirty.items()})

    def _put_session(self, session: Session) -> None:
        self._put("sessions", (session.session_id,), session.ro_row())

    def _put_fact(self, desk: Desk, fact: Fact) -> None:
        desk.facts[fact.fact_id] = fact
        self._put("facts", (desk.desk_id, fact.fact_id), {
            "fact_id": fact.fact_id, "copy_id": desk.copy_id, "desk_id": desk.desk_id, "kind": fact.kind,
            "status": fact.status, "claims": [claim.model_dump(mode="json") for claim in fact.claims],
            "readers": list(fact.label.readers), "expires_at": fact.expires_at})

    def _put_desk(self, desk: Desk) -> None:
        self._put("desks", (desk.desk_id,), {
            "desk_id": desk.desk_id, "copy_id": desk.copy_id, "business_id": desk.business_id, "name": desk.name,
            "slug": desk.slug, "hours": [window.model_dump(mode="json") for window in desk.hours],
            "answering": desk.answering, "created_at": desk.created_at})

    def _put_policy(self, desk: Desk) -> None:
        cards = [card.model_dump(mode="json") for card in desk.cards]
        self._put("policy_versions", (desk.desk_id, desk.policy_version), {
            "copy_id": desk.copy_id, "desk_id": desk.desk_id, "version": desk.policy_version, "parent_version": None,
            "cards": cards, "status": "active",
            "proof": {"ok": True, "method": "symcc", "cases": None, "timed_out": False, "checks": []},
            "cedar_sha256": sha256_hex(canonical(cards)), "schema_sha256": sha256_hex("schema"),
            "baseline_sha256": sha256_hex("baseline"),
            "profiles_sha256": sha256_hex(canonical(sorted(desk.tools))), "invariants_sha256": sha256_hex("invariants"),
            "review_thresholds_version": 1, "created_at": desk.created_at})

    def append(self, desk: Desk, kind: str, summary: dict, *, origin: str = "kernel", session_id: str | None = None,
               ref_id: str | None = None) -> LedgerEntry:
        """Append a hashed, chained entry to the Desk's ledger, signed the fake way."""
        event = LedgerEvent(kind=kind, origin=origin, session_id=session_id, ref_id=ref_id, summary=summary)
        envelope = {"copy_id": desk.copy_id, "desk_id": desk.desk_id, "seq": len(desk.ledger) + 1,
                    "prev_hash": desk.ledger[-1].hash if desk.ledger else GENESIS, "created_at": signed_time(self.now),
                    "event": event.model_dump(mode="json")}
        digest = sha256_hex(canonical(envelope))
        entry = LedgerEntry(**{**envelope, "event": event}, hash=digest, key_id=KEY_ID,
                            signature="fake:" + sha256_hex(b"desk-ledger-v1\0" + bytes.fromhex(digest)))
        desk.ledger.append(entry)
        self._put("ledger_entries", (desk.desk_id, entry.seq), {
            **envelope, "hash": entry.hash, "signature": entry.signature, "key_id": entry.key_id})
        return entry

    # The Rivera seed -----------------------------------------------------------------------------

    def _seed_rivera(self, copy_id: str) -> Desk:
        suffix = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(6))
        desk = Desk(desk_id=new_id("desk"), copy_id=copy_id, business_id=new_id("biz"), business_name="Rivera Plumbing",
                    owner_display_name="Maria Rivera", brand={"primary": "#1F4E4A", "accent": "#B87333"},
                    name="Main line", slug=f"rivera-plumbing-{suffix}", hours=list(RIVERA_HOURS), created_at=self.now)
        self.desks[desk.desk_id] = desk
        ids = {"copy_id": copy_id, "desk_id": desk.desk_id}
        self._put("businesses", (desk.business_id,), {
            "business_id": desk.business_id, "copy_id": copy_id, "name": desk.business_name,
            "owner_display_name": desk.owner_display_name, "timezone": RIVERA_TZ.key, "brand": desk.brand})
        self._put_desk(desk)
        for ref, display_name, contact in RIVERA_PEOPLE:
            person = Person(person_id=new_id("person"), ref=ref, display_name=display_name, contact=contact)
            desk.people[person.person_id] = person
            self._put("people", (person.person_id,), {
                "person_id": person.person_id, **ids, "display_name": display_name,
                "masked_contact": mask_contact(contact), "notes": "", "created_at": self.now})
        for ref, title, owner_ref in RIVERA_DOCUMENTS:
            owner = desk.person(owner_ref)
            document = Document(document_id=new_id("doc"), title=title, record_owner_person_id=owner.person_id,
                                canary="cdk-" + secrets.token_hex(8))
            desk.documents[document.document_id] = document
            self._put("documents", (document.document_id,), {
                "document_id": document.document_id, **ids, "title": title,
                "record_owner_person_id": owner.person_id, "created_at": self.now})
            self._put_fact(desk, Fact(fact_id=f"document:{document.document_id}", kind="document", status="available",
                                      source="kernel", claims=[Claim(key="title", kind="text", value=title)],
                                      label=Label(readers=["owner", f"person:{owner.person_id}"],
                                                  record_owner=owner.person_id)))
        for item in RIVERA_PRICES:
            desk.prices[item.item_id] = item
            self._put("price_items", (desk.desk_id, item.item_id), {**item.model_dump(), **ids})
        for slot in rivera_slots(self.now):
            desk.slots[slot.slot_id] = slot
            self._put("calendar_slots", (desk.desk_id, slot.slot_id), {**slot.model_dump(), **ids})
        self._put("notification_prefs", (desk.desk_id,), {**ids, **NOTIFICATIONS})
        for tool in VISITOR_DECLARED:
            profile = desk.tools[tool] = tool_profile(tool)
            self._put("tools", (desk.desk_id, tool), {
                **ids, "tool": tool, "source": profile.source, "effects": profile.effects,
                "reversible": profile.reversible, "status": profile.status,
                "description_confirmed": profile.description_confirmed, "definition_sha256": profile.definition_sha256,
                "pending_definition_text": None, "pending_sha256": None})
        desk.cards = list(RIVERA_CARDS)
        self._put_policy(desk)
        for claim in RIVERA_CHARTER:
            self._put_fact(desk, Fact(fact_id=f"charter:{claim.key}", kind="charter", status="available",
                                      source="kernel", claims=[claim], label=Label(readers=["public"])))
        windows = canonical([window.model_dump(mode="json") for window in desk.hours])
        self._put_fact(desk, Fact(fact_id="charter:hours", kind="charter", status="available", source="kernel",
                                  claims=[Claim(key="windows", kind="text", value=windows)],
                                  label=Label(readers=["public"])))
        self.append(desk, "desk_data", {"part": "desk", "created": True})
        return desk

    def _seed_held_request(self, desk: Desk) -> Decision:
        """A seeded visitor's quote for drain clearing at 15% off, decided like any call: a signed hold."""
        session, _ = self._new_session(desk.copy_id, desk.desk_id, "visitor")   # its token is discarded
        self.append(desk, "session", {"session_id": session.session_id, "kind": "visitor", "preview": False},
                    session_id=session.session_id)
        call = ToolCall(call_id="seed-held-quote", tool="native.quote",
                        args={"items": [{"item_id": "drain", "qty": 1}], "requested_discount_bp": 1500})
        action = self._normalize(session, desk, call)
        outcome, card_ids = self._rule(session, desk, action)
        digest = sha256_hex(canonical({"desk_id": None, "tool": call.tool, "args": call.args}))
        return self._new_decision(session, desk, call, digest, action, outcome, card_ids)

    # Sessions ------------------------------------------------------------------------------------

    def _new_session(self, copy_id: str, desk_id: str | None, kind: str, **fields) -> tuple[Session, str]:
        token = secrets.token_urlsafe(32)
        session = Session(session_id=secrets.token_urlsafe(16), copy_id=copy_id, desk_id=desk_id, kind=kind,
                          secret_hash=sha256_hex(token), created_at=self.now, last_seen=self.now, **fields)
        self.sessions[session.session_id] = session
        self._token_hashes[session.secret_hash] = session.session_id
        self._put_session(session)
        return session, token

    def _by_token(self, token: str | None) -> Session | None:
        if not token:
            return None
        session_id = self._token_hashes.get(sha256_hex(token))
        return self.sessions.get(session_id) if session_id else None

    def owner_of(self, request: Request) -> tuple[Copy, Session]:
        """The copy and owner session that `X-Owner-Session` names, else 401."""
        session = self._by_token(request.headers.get("x-owner-session"))
        if session is None or session.kind != "owner":
            raise Refusal(401, "auth")
        return self.copies[session.copy_id], session

    def visitor_of(self, request: Request) -> Session:
        """The visitor or agent session `X-Session-Token` names, else 401."""
        session = self._by_token(request.headers.get("x-session-token"))
        if session is None or session.kind == "owner":
            raise Refusal(401, "auth")
        return session

    def session_call(self, request: Request, session_id: str, desk_id: str | None = None) -> tuple[Session, Desk]:
        """The first three "Session state responses" rows for a call naming `session_id`: the session token must
        hash to it (401); an owner names its own session and a `desk_id` of its copy (else 404); closed is 409."""
        if request.headers.get("x-owner-session") is not None:
            copy, owner = self.owner_of(request)
            if desk_id is None:
                raise Refusal(422, "invalid")
            if desk_id not in copy.desk_ids or session_id != owner.session_id:
                raise Refusal(404, "not_found")
            return owner, self.desks[desk_id]
        session = self.visitor_of(request)
        if session.session_id != session_id:
            raise Refusal(401, "auth")
        if desk_id is not None:
            raise Refusal(422, "invalid")       # desk_id is for owner sessions only
        self._check_open(session)
        return session, self.desks[session.desk_id]

    def _check_open(self, session: Session) -> None:
        if session.closed_at is None and session.kind != "owner" and self.now - session.last_seen > IDLE_LIMIT:
            session.closed_at = session.last_seen + IDLE_LIMIT
            self._put_session(session)
        if session.closed_at is not None:
            raise Refusal(409, "closed")
        session.last_seen = self.now

    @staticmethod
    def _check_generation(session: Session, generation: int) -> None:
        if generation != session.generation:
            raise Refusal(409, "stale_generation")

    @staticmethod
    def _query(request: Request, name: str) -> str:
        value = request.query_params.get(name)
        if not value:
            raise Refusal(422, "invalid")
        return value

    # Routes --------------------------------------------------------------------------------------

    def health(self, request: Request, body: Any) -> Health:
        return Health(version="fake", proof_mode="symcc", dev_signing_key=True, public_key_hex=PUBLIC_KEY_HEX,
                      key_id=KEY_ID, unproved_seeds=[])

    def create_copy(self, request: Request, body: Any) -> CopyCreated:
        copy_id = new_id("copy")
        desk = self._seed_rivera(copy_id)
        owner, owner_token = self._new_session(copy_id, None, "owner", verified=True, assurance="owner_session")
        copy = Copy(copy_id=copy_id, owner_session_id=owner.session_id, desk_ids=[desk.desk_id])
        self.copies[copy_id] = copy
        self._seed_held_request(desk)
        return CopyCreated(copy_id=copy_id, desk_ids=copy.desk_ids, owner_session=owner.state(),
                           owner_token=owner_token)

    def public_desk(self, request: Request, body: Any) -> PublicDesk:
        """Public-labelled fields only: names, brand, and the hours, contact and policy charter facts."""
        desk = next((desk for desk in self.desks.values() if desk.slug == request.path_params["desk_slug"]), None)
        if desk is None:
            raise Refusal(404, "not_found")
        language = "es" if request.query_params.get("lang") == "es" else "en"
        charter = []
        for fact in desk.facts.values():
            if fact.kind != "charter" or "public" not in fact.label.readers:
                continue
            template = {"charter:hours": "hours", "charter:contact": "contact"}.get(fact.fact_id, "policy")
            charter.append(self._render(desk, template, fact, language))
        return PublicDesk(business_name=desk.business_name, desk_name=desk.name,
                          owner_display_name=desk.owner_display_name, brand=dict(desk.brand), charter=charter,
                          agent_card=[])

    def create_session(self, request: Request, body: CreateSessionRequest) -> SessionCreated:
        desk = next((desk for desk in self.desks.values() if desk.slug == body.desk_slug), None)
        if desk is None:
            raise Refusal(404, "not_found")
        if body.kind == "agent":
            raise Refusal(401, "auth")       # agent signatures arrive with Plan 01c
        if body.preview:
            owner = self._by_token(request.headers.get("x-owner-session"))
            if owner is None or owner.kind != "owner" or owner.copy_id != desk.copy_id:
                raise Refusal(401, "auth")
        session, token = self._new_session(desk.copy_id, desk.desk_id, "visitor", preview=body.preview)
        self.append(desk, "session", {"session_id": session.session_id, "kind": "visitor", "preview": body.preview},
                    session_id=session.session_id)
        return SessionCreated(state=session.state(), session_token=token)

    def whoami(self, request: Request, body: Any) -> WhoAmI:
        owner_token = request.headers.get("x-owner-session")
        session = self._by_token(owner_token or request.headers.get("x-session-token"))
        if session is None or (session.kind == "owner") != bool(owner_token):
            raise Refusal(401, "auth")
        named = request.query_params.get("session_id")
        if named is not None and named != session.session_id:
            raise Refusal(401, "auth")
        copy = self.copies[session.copy_id]
        if session.kind == "owner":
            return WhoAmI(kind="owner", copy_id=copy.copy_id, desk_id=None, desk_ids=list(copy.desk_ids),
                          session=session.state())
        return WhoAmI(kind=session.kind, copy_id=copy.copy_id, desk_id=session.desk_id,
                      desk_ids=[session.desk_id], session=session.state())

    # Decisions -----------------------------------------------------------------------------------

    def tools_given(self, session: Session, desk: Desk) -> tuple[str, ...]:
        """The tools this session may call now ("Model-visible tools"); owner setup tools arrive with Plan 01c."""
        if session.kind == "owner":
            return ()
        if not desk.answering and not session.preview:
            given = ANSWERING_OFF_TOOLS
        else:
            given = VERIFIED_TOOLS if session.verified else UNVERIFIED_TOOLS
        return tuple(tool for tool in given if tool in desk.tools and desk.tools[tool].status == "enabled")

    def context(self, request: Request, body: Any) -> SessionContext:
        """The session's tools now, every tool its kind could be given, and the facts its labels let it read;
        mode owner and paused still answer."""
        session, desk = self.session_call(request, request.path_params["session_id"],
                                          request.query_params.get("desk_id"))
        declared = () if session.kind == "owner" else VISITOR_DECLARED
        return SessionContext(
            tools=[desk.tools[tool] for tool in self.tools_given(session, desk)],
            tools_declared=[desk.tools[tool] for tool in declared if tool in desk.tools],
            facts=[fact for fact in desk.facts.values() if self._current(fact) and self._readable(session, fact)],
            knowledge=[])

    def decide(self, request: Request, body: DecideRequest) -> Decision:
        session, desk = self.session_call(request, body.session_id, body.desk_id)
        self._check_generation(session, body.generation)
        if session.mode == "owner":
            raise Refusal(409, "mode_owner")
        call = body.call
        digest = sha256_hex(canonical({"desk_id": body.desk_id, "tool": call.tool, "args": call.args}))
        known = self._by_call.get((session.session_id, body.generation, call.call_id))
        if known is not None:
            record = self.decisions[known]
            if record.call_sha256 != digest:
                raise Refusal(409, "conflict")
            return self._refresh(record)
        if session.mode == "paused":
            return self._new_decision(session, desk, call, digest, None, "refuse", [], why="paused")
        if call.tool not in TOOL_NAMES:
            return self._new_decision(session, desk, call, digest, None, "refuse", [], why="unknown_tool")
        if call.tool not in self.tools_given(session, desk):
            return self._new_decision(session, desk, call, digest, None, "refuse", [], why="not_given")
        if not matches(desk.tools[call.tool].input_schema, call.args):
            return self._new_decision(session, desk, call, digest, None, "refuse", [], why="invalid_args")
        action = self._normalize(session, desk, call)
        if action is None:
            return self._new_decision(session, desk, call, digest, None, "refuse", [], why="adapter_refused")
        outcome, card_ids = self._rule(session, desk, action)
        script = self._scripts.get(call.tool)
        if script is not None and script.outcome is not None:
            outcome = script.outcome
        return self._new_decision(session, desk, call, digest, action, outcome, card_ids)

    def _normalize(self, session: Session, desk: Desk, call: ToolCall) -> NormalizedAction | None:
        """The adapter's step: resolve the resource and compute amounts from the Desk's records, never from
        args; None refuses."""
        tool, args = call.tool, call.args
        resource = ResourceRef(kind="desk", id=desk.desk_id, owner_person_id=None)
        list_cents = discount_bp = amount_cents = recipient = starts_at = None
        if tool == "native.quote":
            if any(item["item_id"] not in desk.prices for item in args["items"]):
                return None
            list_cents = sum(desk.prices[item["item_id"]].unit_cents * item["qty"] for item in args["items"])
            if list_cents > 1_000_000:
                return None
            discount_bp = args.get("requested_discount_bp", 0)
            amount_cents = list_cents - list_cents * discount_bp // 10_000
        elif tool == "native.book":
            slot = desk.slots.get(args["slot_id"])
            if slot is None or slot.starts_at <= self.now:
                return None
            resource, starts_at = ResourceRef(kind="slot", id=slot.slot_id, owner_person_id=None), slot.starts_at
        elif tool == "native.release_document":
            document = desk.documents.get(args["document_id"])
            if document is None:
                return None
            resource = ResourceRef(kind="document", id=document.document_id,
                                   owner_person_id=document.record_owner_person_id)
            recipient = "verified_contact"
        elif tool == "native.start_verification":
            recipient = "verified_contact"
        elif tool == "payments.list_charges":
            resource = ResourceRef(kind="charge", id=f"person:{session.person_id}", owner_person_id=session.person_id)
        elif tool in ("native.payment_link", "payments.create_refund"):
            return None                         # quotes to pay and charges to refund arrive with Plan 01c
        profile = desk.tools[tool]
        return NormalizedAction(
            action_id=new_id("act"), copy_id=desk.copy_id, desk_id=desk.desk_id, session_id=session.session_id,
            generation=session.generation, tool=tool, effects=profile.effects,
            args_sha256=sha256_hex(canonical(args)), profile_sha256=sha256_hex(profile.model_dump_json()),
            resource=resource, list_cents=list_cents, discount_bp=discount_bp, amount_cents=amount_cents,
            recipient=recipient, starts_at=starts_at)

    def _rule(self, session: Session, desk: Desk, action: NormalizedAction) -> tuple[str, list[str]]:
        """The Rivera cards' outcome for a normalized call (the kernel evaluates Cedar)."""
        tool = action.tool
        if tool == "native.quote":
            return ("hold" if action.discount_bp else "allow"), ["rv-quote"]
        if tool == "native.book":
            window = in_hours(action.starts_at, desk.hours)
            if window is None:
                return "hold", ["rv-book-wk"]
            return "allow", ["rv-book-sat" if window.days == ["sat"] else "rv-book-wk"]
        if tool == "native.release_document":
            if session.person_id is not None and session.person_id == action.resource.owner_person_id:
                return "allow", ["rv-docs"]
            return "refuse", []                 # the baseline: private data only to its verified record owner
        preset = f"preset-{tool.split('.')[1]}"
        if any(card.card_id == preset for card in desk.cards):
            return "allow", [preset]
        return "hold", [f"default-{tool}"]

    def _new_decision(self, session: Session, desk: Desk, call: ToolCall, digest: str,
                      action: NormalizedAction | None, outcome: str, card_ids: list[str], *,
                      why: str | None = None) -> Decision:
        state = {"allow": "allowed", "hold": "held", "refuse": "refused"}[outcome]
        decision_id = new_id("dec")
        tool = call.tool[:64]
        summary = {"decision_id": decision_id, "action_id": action.action_id if action else None, "tool": tool,
                   "outcome": outcome, "card_ids": card_ids, "policy_version": desk.policy_version, "reviewed": False}
        if why is not None:
            summary["reason"] = why
        entry = self.append(desk, "decide", summary, session_id=session.session_id, ref_id=decision_id)
        expires_at = self.now + {"allow": ALLOW_FOR, "hold": HOLD_FOR, "refuse": timedelta(0)}[outcome]
        answers, inbox = [], []
        if outcome == "hold":
            money = action.tool in MONEY_TOOLS and (action.amount_cents or 0) > AUTO_MONEY_HARD_CAP_CENTS
            answers = [answer for answer in HELD_ANSWERS
                       if answer != "allow_person" or (session.person_id is not None and not money)]
            inbox = [InboxNotice(entry_id=new_id("inbox"), to="owner", preview="A request is waiting for you.")]
        tier = {"allow": "A", "hold": "H", "refuse": "B"}[outcome]
        decision = self._signed(Decision(
            decision_id=decision_id, session_id=session.session_id, call_id=call.call_id, action=action,
            outcome=outcome, state=state, policy_version=desk.policy_version,
            policy_ids=[f"{tier}.{card_id}" for card_id in card_ids], card_ids=card_ids,
            reason_plain=self._reason(session, desk, call, action, card_ids),
            visitor_plain=STATUS_TEXT[state].format(owner=desk.owner_display_name), answers=answers,
            expires_at=expires_at, inbox=inbox, ledger_seq=entry.seq, signature=""))
        record = DecisionRecord(decision=decision, copy_id=desk.copy_id, desk_id=desk.desk_id,
                                generation=session.generation, call_sha256=digest, tool=tool, created_at=self.now)
        self.decisions[decision_id] = record
        self._by_call[(session.session_id, session.generation, call.call_id)] = decision_id
        self._put_decision(record)
        if action is not None:
            self._args[action.action_id] = call.args
            self._put("actions", (action.action_id,), {
                **action.model_dump(include={"action_id", "copy_id", "desk_id", "session_id", "generation", "tool",
                                             "effects", "list_cents", "discount_bp", "amount_cents", "recipient",
                                             "starts_at"}),
                "resource_kind": action.resource.kind, "created_at": self.now})
        return decision

    @staticmethod
    def _reason(session: Session, desk: Desk, call: ToolCall, action: NormalizedAction | None,
                card_ids: list[str]) -> str:
        """The owner-facing reason: who asked for what, the deciding card's reason, free text quoted."""
        who = next((person.display_name for person in desk.people.values() if person.person_id == session.person_id),
                   "A visitor")
        reason = f"{who} asked to use {call.tool[:64]}."
        cards = [card.reason for card in desk.cards if card.card_id in card_ids]
        if cards:
            reason += " " + cards[0]
        note = call.args.get("note") if action is not None else None
        if isinstance(note, str) and note:
            reason += f" From the visitor: “{note[:200]}”"
        return reason

    @staticmethod
    def _signed(decision: Decision) -> Decision:
        fields = decision.model_dump(mode="json", include={"decision_id", "session_id", "state", "visitor_plain",
                                                           "ledger_seq"})
        return decision.model_copy(update={"signature": fake_signature(fields)})

    def _put_decision(self, record: DecisionRecord) -> None:
        decision = record.decision
        self._put("decisions", (decision.decision_id,), {
            "decision_id": decision.decision_id, "copy_id": record.copy_id, "desk_id": record.desk_id,
            "session_id": decision.session_id, "tool": record.tool,
            "effects": decision.action.effects if decision.action else [], "outcome": decision.outcome,
            "state": decision.state, "answers": list(decision.answers), "policy_version": decision.policy_version,
            "card_ids": decision.card_ids, "review": None, "reason_plain": decision.reason_plain,
            "visitor_plain": decision.visitor_plain, "expires_at": decision.expires_at,
            "ledger_seq": decision.ledger_seq, "created_at": record.created_at})

    def _transition(self, record: DecisionRecord, state: str, kind: str = "decide", **summary) -> Decision:
        """Move a decision to `state`: ledgered, re-signed, mirrored."""
        desk = self.desks[record.desk_id]
        decision = record.decision
        entry = self.append(desk, kind, {"decision_id": decision.decision_id, "state": state, **summary},
                            session_id=decision.session_id, ref_id=decision.decision_id)
        record.decision = self._signed(decision.model_copy(update={
            "state": state, "visitor_plain": STATUS_TEXT[state].format(owner=desk.owner_display_name),
            "ledger_seq": entry.seq, "answers": decision.answers if state == "held" else []}))
        self._put_decision(record)
        return record.decision

    def _refresh(self, record: DecisionRecord) -> Decision:
        """Lazy expiry: an allow lasts 60 s, a hold 24 h."""
        decision = record.decision
        if decision.state in ("allowed", "held") and record.result is None and self.now > decision.expires_at:
            return self._transition(record, "expired")
        return decision

    def _own_decision(self, request: Request, session_id: str | None,
                      decision_id: str) -> tuple[Session, DecisionRecord]:
        """The session `X-Session-Token` names (and `session_id`, when given) and its own decision: 401, then 404
        for another session's or an unknown decision, then 409 if the session is closed."""
        session = self.visitor_of(request)
        if session_id is not None and session_id != session.session_id:
            raise Refusal(401, "auth")
        record = self.decisions.get(decision_id)
        if record is None or record.decision.session_id != session.session_id:
            raise Refusal(404, "not_found")
        self._check_open(session)
        return session, record

    def read_decision(self, request: Request, body: Any) -> Decision:
        _, record = self._own_decision(request, None, request.path_params["id"])
        return self._refresh(record)

    def execute(self, request: Request, body: ExecuteRequest) -> ExecResult:
        session, record = self._own_decision(request, body.session_id, body.decision_id)
        if body.generation is not None:
            if body.generation != session.generation:
                if record.decision.state == "allowed" and record.result is None:
                    self._transition(record, "expired", fenced=True)
                raise Refusal(409, "stale_generation")
            if session.mode == "owner":
                raise Refusal(409, "mode_owner")
            if session.mode == "paused":
                raise Refusal(409, "mode_paused")
        decision = self._refresh(record)
        if record.result is not None:
            self.append(self.desks[record.desk_id], "execute", {"decision_id": decision.decision_id, "repeat": True},
                        session_id=session.session_id, ref_id=decision.decision_id)
            return record.result
        if body.approval_id is not None or decision.state != "allowed":
            raise Refusal(409, "conflict")
        if record.generation != session.generation:      # taken over (and maybe handed back) since the allow
            self._transition(record, "expired", fenced=True)
            raise Refusal(409, "stale_generation")
        return self._run(record, session)

    def _run(self, record: DecisionRecord, session: Session) -> ExecResult:
        """Execute the decision's action as `session` (the held session for an approval)."""
        desk, action = self.desks[record.desk_id], record.decision.action
        script = self._scripts.get(action.tool)
        exec_state = script.exec_state if script is not None else "succeeded"
        facts, model_view = self._effects(session, desk, action) if exec_state == "succeeded" else ([], {})
        if model_view is None:                              # the tool's own failure (a slot taken meanwhile)
            exec_state, facts, model_view = "failed", [], {}
        if script is not None:
            if script.facts is not None:
                facts = list(script.facts)
                for fact in facts:
                    self._put_fact(desk, fact)
            if script.model_view is not None:
                model_view = script.model_view
        record.result = ExecResult(action_id=action.action_id, state=exec_state, facts=facts, model_view=model_view)
        self._transition(record, {"succeeded": "executed", "failed": "failed", "unknown": "unknown"}[exec_state],
                         kind="execute")
        return record.result

    def _label(self, session: Session) -> Label:
        """What a fact created in this session may be read by ("Labels")."""
        readers = ["owner", f"session:{session.session_id}"]
        if session.person_id is not None:
            readers.append(f"person:{session.person_id}")
        return Label(readers=readers, record_owner=session.person_id)

    def _effects(self, session: Session, desk: Desk, action: NormalizedAction) -> tuple[list[Fact], dict | None]:
        """The tool's side effects: rows, facts labelled for the session, and Claude's `model_view`."""
        args = self._args[action.action_id]
        ids, label = {"copy_id": desk.copy_id, "desk_id": desk.desk_id}, self._label(session)
        tool, facts, view = action.tool, [], {}
        if tool == "native.quote":
            quote_id = new_id("quote")
            items = [{"item_id": item["item_id"], "title": desk.prices[item["item_id"]].title, "qty": item["qty"]}
                     for item in args["items"]]
            expires_at = self.now + timedelta(hours=72)
            self._put("quotes", (quote_id,), {
                "quote_id": quote_id, **ids, "session_id": session.session_id, "items": items,
                "list_cents": action.list_cents, "discount_bp": action.discount_bp,
                "amount_cents": action.amount_cents, "status": "available", "expires_at": expires_at})
            facts.append(Fact(fact_id=f"quote:{quote_id}", kind="quote", status="available", source="kernel",
                              label=label, expires_at=expires_at, claims=[
                                  Claim(key="items", kind="text",
                                        value=", ".join(f"{item['title']} × {item['qty']}" for item in items)),
                                  Claim(key="list", kind="money", value=action.list_cents),
                                  Claim(key="total", kind="money", value=action.amount_cents),
                                  Claim(key="discount", kind="percent_bp", value=action.discount_bp),
                                  Claim(key="expires", kind="datetime", value=expires_at.isoformat())]))
            view = {"fact_id": facts[0].fact_id, "quote_id": quote_id, "items": items, "status": "available"}
        elif tool == "native.book":
            slot = desk.slots[action.resource.id]
            if slot.slot_id in desk.booked:
                return [], None
            desk.booked.add(slot.slot_id)
            booking_id = new_id("booking")
            self._put("bookings", (booking_id,), {
                "booking_id": booking_id, **ids, "slot_id": slot.slot_id, "starts_at": slot.starts_at,
                "person_id": session.person_id, "lead_id": None, "status": "confirmed"})
            facts.append(Fact(fact_id=f"booking:{booking_id}", kind="booking", status="committed", source="kernel",
                              label=label, claims=[
                                  Claim(key="starts_at", kind="datetime", value=slot.starts_at.isoformat()),
                                  Claim(key="minutes", kind="text", value=str(slot.minutes)),
                                  Claim(key="booking", kind="ref", value=booking_id)]))
            view = {"fact_id": facts[0].fact_id, "booking_id": booking_id, "status": "confirmed"}
        elif tool == "native.find_slots":
            open_slots = sorted((slot for slot in desk.slots.values()
                                 if slot.starts_at > self.now and slot.slot_id not in desk.booked),
                                key=lambda slot: slot.starts_at)[:6]
            fact_id = f"slots:{new_id('slots')}"
            facts.append(Fact(fact_id=fact_id, kind="slots", status="available", source="kernel", label=label,
                              expires_at=self.now + timedelta(minutes=30),
                              claims=[claim for slot in open_slots for claim in (
                                  Claim(key="slot", kind="ref", value=slot.slot_id),
                                  Claim(key="starts_at", kind="datetime", value=slot.starts_at.isoformat()))]))
            view = {"fact_id": fact_id, "slots": [
                {"slot_id": slot.slot_id, "starts_at_local": slot.starts_at.astimezone(RIVERA_TZ).isoformat()}
                for slot in open_slots]}
        elif tool == "native.capture_lead":
            lead_id = new_id("lead")
            self._put("leads", (lead_id,), {"lead_id": lead_id, **ids, "session_id": session.session_id,
                                            "display_name": args["name"], "note": args.get("note"),
                                            "created_at": self.now})
            view = {"lead_id": lead_id, "saved": True}
        elif tool == "native.request_callback":
            handoff_id = new_id("handoff")
            self._put("handoffs", (handoff_id,), {
                "handoff_id": handoff_id, **ids, "session_id": session.session_id,
                "reason": f"{args['name']} · {args['contact']} · {args['reason']}", "callback_window": None,
                "status": "open"})
            facts.append(Fact(fact_id=f"handoff:{handoff_id}", kind="handoff", status="committed", source="kernel",
                              label=label, claims=[Claim(key="handoff", kind="ref", value=handoff_id)]))
            view = {"fact_id": facts[0].fact_id, "handoff_id": handoff_id}
        elif tool == "native.start_verification":
            view = {"status": "requested"}
        elif tool == "native.release_document":
            document = desk.documents[action.resource.id]
            link_id = new_id("link")
            facts.append(Fact(fact_id=f"document_link:{link_id}", kind="document", status="available",
                              source="kernel", expires_at=self.now + timedelta(hours=24),
                              label=Label(readers=["owner", f"person:{document.record_owner_person_id}"],
                                          record_owner=document.record_owner_person_id),
                              claims=[Claim(key="title", kind="text", value=document.title),
                                      Claim(key="ref", kind="ref", value=link_id)]))
            view = {"fact_id": facts[0].fact_id, "title": document.title, "link_ready": True}
        elif tool == "payments.list_charges":
            view = {"charges": []}
        for fact in facts:
            self._put_fact(desk, fact)
        return facts, view

    def cancel(self, request: Request, body: CancelRequest) -> Decision:
        """The visitor withdraws its own held request."""
        _, record = self._own_decision(request, body.session_id, request.path_params["decision_id"])
        if self._refresh(record).state != "held":
            raise Refusal(409, "conflict")
        return self._transition(record, "cancelled")

    def answer(self, request: Request, body: AnswerRequest) -> ApprovalResult:
        """The owner's answer to a held decision; an allow runs it at once as the held session."""
        copy, _ = self.owner_of(request)
        record = self.decisions.get(request.path_params["decision_id"])
        if record is None or record.copy_id != copy.copy_id:
            raise Refusal(404, "not_found")
        desk, decision = self.desks[record.desk_id], self._refresh(record)
        if decision.state != "held":
            self.append(desk, "approval", {"decision_id": decision.decision_id, "refused": decision.state},
                        session_id=decision.session_id, ref_id=decision.decision_id)
            raise Refusal(409, "conflict")
        if body.answer not in decision.answers:
            raise Refusal(422, "invalid")
        approval_id = new_id("approval")
        self._put("approvals", (approval_id,), {
            "approval_id": approval_id, "copy_id": record.copy_id, "decision_id": decision.decision_id,
            "answer": body.answer, "expires_at": decision.expires_at, "consumed_at": self.now})
        session, action = self.sessions[decision.session_id], decision.action
        execution, card_diff = None, None
        if body.answer in ("allow_once", "allow_person"):
            self._transition(record, "approved", kind="approval", answer=body.answer, approval_id=approval_id)
            execution = self._run(record, session)
            if body.answer == "allow_person":
                name = next(person.display_name for person in desk.people.values()
                            if person.person_id == session.person_id)
                card_diff = [RuleCard(card_id=f"person-{session.person_id}-{action.tool}", applies_to=action.tool,
                                      mode="auto", who="person", person_id=session.person_id,
                                      max_amount_cents=action.amount_cents, max_discount_bp=action.discount_bp or 0,
                                      reason=f"Allowed for {name} after you approved a request like this.")]
        else:
            self._transition(record, "denied", kind="approval", answer=body.answer, approval_id=approval_id)
            if body.answer == "deny_always":
                who = {"who": "person", "person_id": session.person_id} if session.person_id else {"who": "anyone"}
                card_diff = [RuleCard(card_id=f"never-{session.person_id or 'anyone'}-{action.tool}",
                                      applies_to=action.tool, mode="never", reason="You said never for this.", **who)]
        return ApprovalResult(decision=record.decision, execution=execution, card_diff=card_diff)

    def check_reply(self, request: Request, body: CheckReplyRequest) -> ReplyVerdict:
        """Check Claude's draft; only what passes is in the blocks, and a failure is the handoff alone."""
        draft = body.draft
        session, desk = self.session_call(request, draft.session_id)
        self._check_generation(session, draft.generation)
        if session.mode == "owner":
            raise Refusal(409, "mode_owner")
        language = session.last_language or "en"
        if session.mode == "paused":
            return self._verdict(session, desk, language, [],
                                 [Violation(kind="session_paused", span="", rule_id="session.paused")], [])
        detected = detect_language(draft.prose)
        violations = []
        if detected == "other":
            violations.append(Violation(kind="unsupported_language", span=draft.prose[:40], rule_id="language"))
        elif detected in ("en", "es"):
            language = session.last_language = detected
            self._put_session(session)
        violations += scan_prose(draft.prose, [document.canary for document in desk.documents.values()])
        if self._forced:
            kind = self._forced.pop(0)
            violations.append(Violation(kind=kind, span="" if kind == "canary" else draft.prose[:40],
                                        rule_id=f"fake.{kind}"))
        cards = []
        for clause in draft.clauses:
            card = self._clause(session, desk, clause, language, violations)
            if card is not None:
                cards.append(card)
        prose = [RenderedBlock(kind="prose", text=draft.prose)] if draft.prose else []
        return self._verdict(session, desk, language, prose + cards, violations,
                             [clause.fact_id for clause in draft.clauses if clause.fact_id])

    def _readers(self, session: Session) -> set[str]:
        if session.kind == "owner":
            return {"owner", "public"}
        readers = {"public", f"session:{session.session_id}"}
        if session.person_id is not None:
            readers.add(f"person:{session.person_id}")
        return readers

    def _readable(self, session: Session, fact: Fact) -> bool:
        return bool(set(fact.label.readers) & self._readers(session))

    def _current(self, fact: Fact) -> bool:
        return fact.status != "expired" and (fact.expires_at is None or fact.expires_at > self.now)

    def _clause(self, session: Session, desk: Desk, clause: Clause, language: str,
                violations: list[Violation]) -> RenderedBlock | None:
        """The clause's card, or None after adding the violation it earns."""
        def refuse(kind: str, rule_id: str) -> None:
            violations.append(Violation(kind=kind, span=clause.template, fact_ids=[clause.fact_id or ""][:1],
                                        rule_id=rule_id))

        template = clause.template
        if template in KERNEL_ONLY_TEMPLATES:
            return refuse("unknown_fact", "kernel_only_template")
        if template in FACTLESS_TEMPLATES:
            if clause.fact_id is not None:
                return refuse("unknown_fact", "template_mismatch")
            key = "handoff" if template == "handoff" else "verify"
            text = REPLY_TEXT[language][key].format(owner=desk.owner_display_name)
            return RenderedBlock(kind="card", template=template, text=text, title=text)
        fact = desk.facts.get(clause.fact_id or "")
        if fact is None:
            return refuse("unknown_fact", "unknown_fact")
        named = {"hours": fact.fact_id == "charter:hours", "contact": fact.fact_id == "charter:contact",
                 "policy": fact.fact_id.startswith("charter:policy:")}
        if fact.kind != TEMPLATE_KINDS.get(template) or not named.get(template, True):
            return refuse("unknown_fact", "template_mismatch")
        if not self._current(fact):
            return refuse("stale_fact", "stale_fact")
        if not self._readable(session, fact):
            return refuse("unentitled_fact", "unentitled_fact")
        return self._render(desk, template, fact, language)

    def _render(self, desk: Desk, template: str, fact: Fact, language: str) -> RenderedBlock:
        """A card from the fact's claims (the kernel renders en/es templates; the fake keeps it plain)."""
        claims = {claim.key: claim.value for claim in fact.claims}
        title, lines, options, href = None, [], [], None
        if template == "quote":
            title, lines = money(claims["total"]), [claims["items"]]
        elif template == "booking_options":
            options = [CardOption(option_id=slot_id, label=datetime.fromisoformat(starts_at).strftime("%a %d %b %H:%M"))
                       for slot_id, starts_at in zip(
                           [c.value for c in fact.claims if c.key == "slot"],
                           [c.value for c in fact.claims if c.key == "starts_at"])]
            title = "Open times" if language == "en" else "Horas libres"
        elif template == "booking_confirmed":
            title = datetime.fromisoformat(claims["starts_at"]).strftime("%a %d %b %H:%M")
        elif template == "hours":
            title = REPLY_TEXT[language]["hours"]
            lines = [f"{', '.join(window.days)} {window.start:%H:%M}-{window.end:%H:%M}" for window in desk.hours]
        elif template == "document_link":
            title, href = claims["title"], f"/api/d/fake-{claims['ref']}"
        elif template == "callback_confirmed":
            title = f"{desk.owner_display_name} will call you back."
        else:
            title = str(next(iter(claims.values())))
        text = "\n".join([title, *lines, *(option.label for option in options)])
        return RenderedBlock(kind="card", template=template, text=text, fact_id=fact.fact_id, title=title, lines=lines,
                             href=href, options=options)

    def _verdict(self, session: Session, desk: Desk, language: str, blocks: list[RenderedBlock],
                 violations: list[Violation], fact_ids: list[str]) -> ReplyVerdict:
        """Step 7: the handoff alone unless ok, ledgered as `reply`, signed over the six fields."""
        ok = not violations
        if not ok:
            text = REPLY_TEXT[language]["handoff"].format(owner=desk.owner_display_name)
            blocks = [RenderedBlock(kind="card", template="handoff", text=text, title=text)]
        message_id = new_id("msg")
        entry = self.append(desk, "reply", {
            "message_id": message_id, "author": "claude", "ok": ok, "language": language,
            "violations": [violation.kind for violation in violations],
            "rule_ids": [violation.rule_id for violation in violations], "fact_ids": fact_ids},
            session_id=session.session_id, ref_id=message_id)
        visitor_plain = REPLY_TEXT[language]["checked" if ok else "handed_off"].format(owner=desk.owner_display_name)
        blocks_sha256 = sha256_hex(canonical([block.model_dump(mode="json") for block in blocks]))
        return ReplyVerdict(
            ok=ok, language=language, blocks=blocks, violations=violations, message_id=message_id,
            generation=session.generation, visitor_plain=visitor_plain, ledger_seq=entry.seq,
            signature=fake_signature({"session_id": session.session_id, "generation": session.generation,
                                      "message_id": message_id, "blocks_sha256": blocks_sha256,
                                      "visitor_plain": visitor_plain, "ledger_seq": entry.seq}))

    # Ledger --------------------------------------------------------------------------------------

    def ledger_append(self, request: Request, body: LedgerAppendRequest) -> LedgerEntry:
        """An API-origin `session`, `rate_limit` or `agent_auth` entry (the body model refuses other kinds) on the
        caller's own Desk, naming no session but the caller's."""
        if request.headers.get("x-owner-session") is not None:
            copy, caller = self.owner_of(request)
            if body.desk_id not in copy.desk_ids:
                raise Refusal(404, "not_found")
        else:
            caller = self.visitor_of(request)
            if body.desk_id != caller.desk_id:
                raise Refusal(404, "not_found")
            self._check_open(caller)
        if body.event.session_id is not None and body.event.session_id != caller.session_id:
            raise Refusal(404, "not_found")
        event = body.event
        return self.append(self.desks[body.desk_id], event.kind, event.summary, origin="api",
                           session_id=event.session_id, ref_id=event.ref_id)

    def ledger_page(self, request: Request, body: Any) -> LedgerPage:
        copy, _ = self.owner_of(request)
        desk_id = request.path_params["desk_id"]
        if desk_id not in copy.desk_ids:
            raise Refusal(404, "not_found")
        entries = list(self.desks[desk_id].ledger)
        return LedgerPage(entries=entries, head=entries[-1].hash if entries else GENESIS, chain_ok=True,
                          first_bad_seq=None, public_key_hex=PUBLIC_KEY_HEX, key_id=KEY_ID)

    def decision_by_call(self, request: Request, body: Any) -> Decision:
        session_id = self._query(request, "session_id")
        try:
            generation = int(self._query(request, "generation"))
        except ValueError:
            raise Refusal(422, "invalid") from None
        if request.headers.get("x-owner-session") is not None:
            _, owner = self.owner_of(request)
            if session_id != owner.session_id:          # an owner names its own session
                raise Refusal(404, "not_found")
        else:
            self.session_call(request, session_id)
        known = self._by_call.get((session_id, generation, self._query(request, "call_id")))
        if known is None:
            raise Refusal(404, "not_found")
        return self._refresh(self.decisions[known])


# Routing -----------------------------------------------------------------------------------------

def _route_path(key: str) -> tuple[str, str]:
    method, _, target = key.partition(" ")
    return method, target.partition("?")[0]


def route_keys(name: str) -> set[str]:
    """The `KERNEL_ROUTES` keys `name` names: a key ("POST /decide"), its method and path without the
    query ("GET /decisions/by_call") or its path alone ("/decide")."""
    keys = set()
    for key in KERNEL_ROUTES:
        method, path = _route_path(key)
        if name in (key, f"{method} {path}", path):
            keys.add(key)
    if not keys:
        raise ValueError(f"{name!r} names no kernel route")
    return keys


# The routes this fake answers, by KERNEL_ROUTES key, with the state method that answers each.
FAKE_ROUTES: dict[str, str] = {
    "GET /health": "health",
    "POST /copies": "create_copy",
    "GET /public/{desk_slug}": "public_desk",
    "POST /sessions": "create_session",
    "GET /whoami": "whoami",
    "GET /context/{session_id}?desk_id=": "context",
    "POST /decide": "decide",
    "GET /decisions/by_call?session_id=&generation=&call_id=": "decision_by_call",
    "GET /decisions/{id}": "read_decision",
    "POST /execute": "execute",
    "POST /decisions/{decision_id}/cancel": "cancel",
    "POST /approvals/{decision_id}/answer": "answer",
    "POST /check_reply": "check_reply",
    "POST /ledger/append": "ledger_append",
    "GET /ledger/{desk_id}?verify=true": "ledger_page",
}


def _error(status: int, code: str) -> Response:
    return Response(KernelError(code=code).model_dump_json(), status_code=status, media_type="application/json")


def _endpoint(state: FakeKernelState, key: str, handler: Callable[[Request, Any], Any]):
    request_model, response_type = KERNEL_ROUTES[key]
    response_adapter = TypeAdapter(response_type) if response_type is not None else None

    async def endpoint(request: Request) -> Response:
        raw = await request.body()
        try:
            body_json = json.loads(raw) if raw else None
        except ValueError:
            body_json = raw.decode(errors="replace")
        state.calls.append(FakeCall(route=key, path=request.url.path, query=dict(request.query_params),
                                    headers=dict(request.headers), body=body_json))
        failure = state._take_failure(key)
        if failure == "timeout":
            raise httpx.ReadTimeout("the fake kernel timed out")
        if failure == "connect":
            raise httpx.ConnectError("the fake kernel refused the connection")
        if failure is not None:
            return _error(int(failure), "internal" if failure == "500" else "invalid")
        try:
            body = _parse(request_model, raw)
            result = handler(request, body)
        except Refusal as refusal:
            result = refusal
        finally:
            state.flush()
        if state._take_drop(key):
            raise httpx.ReadTimeout("the fake kernel committed, then timed out")
        if isinstance(result, Refusal):
            return _error(result.status, result.code)
        if response_adapter is None:
            return Response(status_code=204)
        payload = response_adapter.dump_json(response_adapter.validate_python(result))
        return Response(payload, media_type="application/json")

    return endpoint


def _parse(request_model: type[BaseModel] | None, raw: bytes) -> BaseModel | None:
    if request_model is None:
        if raw:
            raise Refusal(422, "invalid")
        return None
    try:
        return request_model.model_validate_json(raw or b"{}")
    except ValidationError:
        raise Refusal(422, "invalid") from None


async def _not_found(scope, receive, send) -> None:
    await _error(404, "not_found")(scope, receive, send)


def fake_kernel_app(state: FakeKernelState) -> Router:
    """The fake kernel as an ASGI app over `state`."""
    routes = []
    for key, method_name in FAKE_ROUTES.items():
        method, path = _route_path(key)
        routes.append(Route(path, _endpoint(state, key, getattr(state, method_name)), methods=[method]))
    return Router(routes=routes, default=_not_found)
