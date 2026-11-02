"""FakeKernel: the kernel HTTP API v2 in this process, for the API's tests (never in an image).

`fake_kernel_app(state)` is an ASGI app that answers the master plan's "Kernel HTTP API v2" routes the
API uses, with the behavior Plan 02a relies on: a Turner Plumbing copy, sessions with hashed tokens,
"Session state responses" in order, decisions, executions, approvals, reply checks and the ledger.
tests/kernel_contract/test_contract.py runs the same tests against it and the real kernel, so the
API's tests can't lean on a behavior the kernel doesn't have. Later tasks add routes here, each with a
contract test, before the task that first uses them.

- State lives in memory (`FakeKernelState`); before each answer, the rows that changed are written to
  `fake_kernel_ro` (ro_tables), which the API reads in place of `kernel_ro`.
- Signatures are `"fake:" + sha256 hex` of the fields the kernel signs. Times come from `state.now`.
- Every non-2xx body is a `KernelError`; a body that isn't the route's request model is 422 `invalid`;
  every answer is checked against the route's response model before it leaves.
- Knobs for tests: `fail`, `drop_response`, `set_mode`, `script`, `violation`, `soft_checks`, `verify`, `never`,
  `lower_link_limit`, `reconcile`, `in_flight` (with `finish`), `owner_verdict` (an owner's say, as
  `POST /owner/messages` answers it) and `calls` (with `called(route)`); `now` drives expiry and the 24-hour idle
  close. A `"timeout"` or `"connect"` failure is raised as httpx's own exception, which reaches the client through
  `httpx.ASGITransport`.
- The owner in a conversation (Plans 01a and 01b): `POST /sessions/{id}/mode` takes over, hands back or resumes a
  session of the owner's copy at its current generation, by Plan 01a's mode table (only the breaker pauses), through
  `set_mode`. `POST /owner/messages` takes a say or a whisper in any mode: a say is looked at for document canaries
  only, and a clean one is an `owner_statement` fact and one `owner_said` card of the text verbatim, signed at the
  session's generation; a whisper is ledgered with its length alone.
- The handoff card's owner handoff (#96): a verdict of Claude's that shows the handoff card and that the session
  will see opens a `handoffs` row of kind `card` for the session (open, no call-back window, the kernel's reason):
  a reply that passed citing the card, or a blocked draft when its check is `final` (`CheckReplyRequest.final`) or
  any violation is outside `desk.rewrites.REWRITABLE` (a non-final draft blocked only for those is the API's to
  rewrite, never shown). It opens none for the owner's preview session, while the session has a held request
  awaiting the owner, or while it has an open handoff of either kind (one per session); otherwise it alerts the
  owner (event kind `handoff`, when the Desk's preferences alert it at once; no decision) with who is waiting, and
  ledgers it `desk_data` on the session. An owner's say opens none, nor does a replayed night's blocked draft. A
  non-final draft blocked only for rewritable kinds gets no blocks at all (still signed, its violations kept). A
  shown draft blocked only for its prose, with no card at all (none to keep, no drafted handoff) and no checker
  outage, asks first: the kernel's call-back offer, as prose, when the session's tools offer a call back and it has
  no open handoff, and no handoff card, so it opens none. A
  call-back request first closes the session's open handoffs, the card's or an earlier call-back's, as the
  owner's mark of done does (`done`, a call-back's fact expired, `desk_data` naming it with `replaced_by`, the
  call-back's new id), then opens its own of kind `callback` under that id; a row's kind never changes, so a stale
  mark of done on a closed one is 409. A booking, native or typed, closes the session's open handoffs of kind `card`
  as the owner's mark of done does, each ledgered `desk_data` naming it with `closed_by: "booking"`; a call-back
  stays open. A booking also makes the session's earlier held quotes with a discount stale: the next read of one
  cancels it, as lazy expiry does, and the owner's reads of it carry the owner's line for a request a booking closed.
  `POST /handoffs/{id}/done` closes either kind. A reply entry records `final`.
- The recorded night (Plan 01d): `record_night(*sessions)` is the recording `POST /copies` replays into a copy that
  asks (`replay_night: true`): each session closed at generation 0 with no person, its rows at the recorded moments,
  every ledger entry it writes appended now and marked `summary.replayed` with its moment and the recording, and the
  copy's answer carrying the events in shown order (`replayed_messages`, kept in `replayed_nights` too) and its
  `replay_id`. With none recorded a copy that asks is live; `without_seeded_night()` makes any request that
  carries `replay_night`, true or false, 422 `invalid`, as a kernel whose request model lacks the field answers it.
- The turn's language (GitHub issue #121): `POST /sessions/{session_id}/turn` takes a turn's newest visitor or agent
  message (at most 2,000 characters, else 422 `invalid`) and keeps the language `detect_language` finds in it as the
  session's `last_language`, which the turn's status lines and verdicts then speak; the one on record stays when it
  finds neither English nor Spanish. The text is read for that alone, never kept, mirrored or ledgered.
- Verification (Plan 01b): `/verify/start` sends a fresh code only to a contact on record (a Demo inbox entry
  and its code-free notice) and answers every contact with one message; `/verify/check` takes the session's live
  challenge's code within ten minutes and five attempts, else 422 `invalid`; a session reads only the code entries
  of the challenges it, or a demo agent it minted (Plan 01c), started. Codes are kept in memory, never mirrored.
- Single-use links (Plans 01b and 01c): `native.release_document` and `native.payment_link` mint a random token
  that only the link card's `href` carries (`/api/d/{token}`, `/pay/{token}`), never a fact, `model_view` or ledger
  summary. A document link serves its bytes once within a day. A payment link, for the session's own current quote at
  its amount under the seed's `rv-link` card, is read, completed (a `charge` fact and the kernel's `payment_confirmed`
  verdict) or cancelled by its token alone; anything but `issued` is 409 `conflict`. Tokens are kept in memory,
  never mirrored. `PaymentLinkView` serves the contract's fields: the Desk's business name, the verified customer
  by first name and last initial while the link is issued, and `cancel_reason` `rules_changed` for a link a rule
  change cancelled. Policy activation rechecks open auto-allowed links, and the owner's
  `GET /policy/{version}/cancelled_links` lists that activation's cancellations with fresh `link_cancelled` verdicts
  for open sessions. The fake has no reviewer, so the review-gated `rv-link` card allows a link outright.
- Signed agents (Plan 01c; master "Agent sessions"): `POST /agents/demo` mints a demo agent for the owner or a
  visitor session of the Desk (an Ed25519 key, `agent_key_id` the first 16 hex of its public key's sha256, and a
  mandate the copy's demo wallet signs: $20 a charge, $100 in all, for an hour), ten per copy an hour, then 429
  `rate_limited`. Every call for an agent session carries the four `AgentAuth` headers and `X-Agent-Body-Sha256`,
  never a token: the signature is checked over `{desk_slug, ts, nonce, body_sha256}` (canonical JSON, `ts` within 5
  minutes), the key must be the one bound to the session at creation, and a failure is 401, ledgered `agent_auth
  {route, reason, agent_key_id}` with the kernel's reason.
  A nonce is bound at its first use to one session and body hash and lasts one A2A turn: it is spent by a passing
  verdict, an immediate-handoff violation (any kind outside `desk.rewrites.REWRITABLE`), a blocked check sent with
  `final: true`, the second reply check or 5 minutes, after which the same request is 409
  `replayed`; another body or session under it is 401. An opening `POST /sessions` whose nonce is bound or spent
  with the same body hash returns the bound session and creates nothing. An agent session is never given refunds,
  and gets `native.payment_link` and `native.charge_mandate` only with a verified mandate; a mandate charge is
  allowed iff its amount is within the mandate's remaining (`min(per charge, total - committed - reserved)`), else
  refused, and is reserved and committed at execution (`refused_at_execution` when the room went meanwhile), writing
  a `charge` fact rendered `charge_confirmed`. Keys stay in memory; the mirror has the sessions' `agent_key_id` and
  `mandate_id` and the mandates' amounts.
- The owner's Desks and setup (Plans 01b and 01c): `POST /desks` makes a Desk in the owner's copy through the same
  seed path as the Turner copy (native tools only, the `ask_first` preset's auto cards active), and
  `PUT /desks/{id}/business` renames its business; each refuses an owner name outside Plan 01a's pattern or an
  unknown time zone. `PUT /desks/{id}/people` (Plan 01b) upserts and removes people by `ref`, refusing a contact that
  looks masked (422). `DELETE /desks/{id}` (Plan 01b) closes the Desk's sessions; then its public page is 404, the
  owner's `/whoami` no longer lists it, and opening a session on it or an owner route naming it answers 409 `closed`;
  its ledger stays. A preview (`POST /sessions` with `preview: true`) needs the owner of the slug's copy; its
  call-back writes its handoff already `done`, keeping its fact but leaving no Needs-you item. An owner
  session is given the setup tools alone, on any Desk of its copy, and executes its own setup decisions:
  `native.read_memory` answers from the Desk's stored simulated memory (only the Turner seed falls back to
  `MEMORY_ITEMS`; other unwritten Desks read nothing) and `native.fetch_website` reads any
  `.example` site as `WEBSITE_TEXT` (the fetch guard refuses every other address, so the call fails), each storing
  owner-only knowledge; `/context` serves the knowledge a session's labels read.
- Setup's rules (Plans 01a, 01b and 01c): `PUT /desks/{id}/charter`, `hours`, `prices`, `calendar` and
  `notifications` replace their part (rows a part drops leave the mirror). `POST /policy/draft` compiles the owner's
  cards against the active version (else 409), refusing a set with a card that could change starting a verification
  (Plan 01b, 422 `invalid`: `changes_always_on`), into a new version with the compiler's default asks, proved unless
  the `proof` knob says otherwise (rejected, timed out, or bounded and left `draft`), idempotent on its parent, cards
  and enabled tools but for a timed-out rejection, which proves again; `POST /policy/confirm` activates only a proved
  draft whose parent is still active (else 409); `POST /policy/{version}/probe` decides each `Probe` through the
  fake's card rules below, changing nothing. `POST /tools/connect` pins the mock payments tools `needs_review`, and
  `POST /tools/simulate_change` (the owner's demo action) drifts a connected one back to `needs_review` (a disabled
  one stays disabled) with its changed definition pending. `POST /documents` adds a document through the seed path's
  writer and `POST /knowledge` upserts an owner-only or public knowledge item (Plan 01b). The `gate` knob holds a
  route's calls until a test lets them through, as a slow proof does. The fake's rules are cards read plainly (a
  `never` refuses, an `auto` card whose limits hold allows, an `ask` card or anything uncovered holds), not Cedar: no
  specificity order between overlapping cards but a purpose payment's (the compiler's, which the contract suite
  checks), and an effect card covers a tool by any one of its effects.
- Refused calls (the baseline's "every attempt logged"): a call refused because its session is closed or its Desk
  deleted is ledgered `auth {route, reason: "closed"}` on that Desk, naming the session it acted for (none for an
  owner route or a new session), as the kernel's `auth.AuthError` does; a refused agent signature is ledgered as
  above. A call naming no Desk or session of the copy has no ledger to go on.
- Not modelled: Cedar, the reviewer, the breaker's strikes (`set_mode` pauses), the `auth` entries of other refusals
  (a bad token, another copy's session, a stale generation, a mode), verification's hourly limits and lockouts,
  voided document links, the mock payments provider and its reconciliation, refunds, an agent payment link's
  reservation on its mandate, and a mandate charge's reserve and commit as two steps (it commits at once, so a
  scripted `exec_state="unknown"` charge keeps no reservation).
"""

import asyncio
import hashlib
import hmac
import itertools
import json
import re
import secrets
import string
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Literal, get_args
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat
from pydantic import BaseModel, TypeAdapter, ValidationError
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route, Router

from desk.public_amenity import offers_amenity
from desk.public_person import future_person_direction
from desk.public_contact import valid_public_contact
from desk.contracts import (
    AUTO_MONEY_HARD_CAP_CENTS,
    BRAND_PALETTE,
    ITEM_ID_PATTERN,
    MCP_TOOLS,
    MONEY_TOOLS,
    SLOT_ID_PATTERN,
    ApprovalResult,
    BusinessSeed,
    CalendarSlot,
    CardOption,
    Claim,
    Clause,
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
    Label,
    LedgerEntry,
    LedgerEvent,
    LedgerPage,
    Mandate,
    NormalizedAction,
    NotificationDefaults,
    OwnerMessageResult,
    PolicyVersion,
    PriceItem,
    Probe,
    ProbeResult,
    ProofCheck,
    ProofReport,
    RenderedBlock,
    ReplayedEvent,
    ReplyDraft,
    ReplyVerdict,
    ResourceRef,
    RuleCard,
    SeedDocument,
    SeedPerson,
    SeededChat,
    SessionCreated,
    SessionState,
    ToolCall,
    ToolName,
    ToolProfile,
    Violation,
    money_tool,
    money_tools_of,
    effective_brand,
    moves_money,
    stored_brand,
)
from desk.kernel_api import (
    KERNEL_ROUTES,
    TURN_TEXT_CHARS,
    AnswerRequest,
    CancelRequest,
    CheckReplyRequest,
    ContextClock,
    CreateCopyRequest,
    CreateDeskRequest,
    CreateSessionRequest,
    DecideRequest,
    DemoAgentRequest,
    DeskAnsweringRequest,
    DeskBusinessRequest,
    DeskCalendarRequest,
    DeskCharterRequest,
    DeskCreated,
    DeskHoursRequest,
    DeskMemoryRequest,
    DeskNotificationsRequest,
    DeskPeopleRequest,
    DeskPricesRequest,
    DeskUpdated,
    DocumentCreated,
    DocumentUploadRequest,
    ExecuteRequest,
    Health,
    KernelError,
    KnowledgeRequest,
    LedgerAppendRequest,
    LinkCancelled,
    ModeRequest,
    OpenStatus,
    OwnerMessageRequest,
    PaymentLinkStateResult,
    PaymentLinkView,
    PolicyConfirmRequest,
    PolicyDraftRequest,
    PolicyProbeRequest,
    PublicDesk,
    SessionContext,
    ToolsConnectRequest,
    ToolsConfirmRequest,
    ToolConfirmed,
    ToolPin,
    ToolsSimulateChangeRequest,
    TurnRequest,
    TurnStarted,
    VerifyCheckRequest,
    VerifyStarted,
    VerifyStartRequest,
    WhoAmI,
)
from desk.presets import PRESETS
from desk.next_steps import NEXT_STEPS, next_steps
from desk.rewrites import PROSE_ONLY, REWRITABLE
from tests.kernel_contract.ro_tables import FakeRO

IDLE_LIMIT = timedelta(hours=24)        # a visitor or agent session closes after this long idle
GENESIS = "0" * 64
KEY_ID = "fake-kernel"
PUBLIC_KEY_HEX = "00" * 32           # no real key: fake signatures verify against nothing
_DECISION_ORDER = itertools.count()   # the order decisions are made in, for times `now` doesn't tell apart

class Refusal(Exception):
    """A non-2xx answer: its status and `KernelError.code`."""

    def __init__(self, status: int, code: str, detail: dict[str, list[str]] | None = None):
        super().__init__(f"{status} {code}")
        self.status, self.code = status, code
        self.detail = detail


class AdapterCheckRefused(Exception):
    """A normalization refusal whose fixed adapter check is ledgered by decide."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def sha256_hex(value: str | bytes) -> str:
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def canonical(value: Any) -> str:
    """Sorted keys, no spaces: what the fake hashes and signs (the kernel uses RFC 8785)."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def fake_signature(fields: dict) -> str:
    return "fake:" + sha256_hex(canonical(fields))


def new_id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(5)}"


# The master plan's "Turner seed", with Plan 01a's specifics.
RIVERA_TZ = ZoneInfo("America/Los_Angeles")
RIVERA_HOURS = [HoursWindow(days=["mon", "tue", "wed", "thu", "fri"], start=time(8), end=time(18)),
                HoursWindow(days=["sat"], start=time(9), end=time(13))]
SLOT_HOURS = {0: (8, 10, 12, 14, 16), 1: (8, 10, 12, 14, 16), 2: (8, 10, 12, 14, 16), 3: (8, 10, 12, 14, 16),
              4: (8, 10, 12, 14, 16), 5: (9, 11)}   # by weekday(), Monday 0; 120-minute slots
RIVERA_PRICES = [PriceItem(item_id="deposit", title="Service call deposit", unit_cents=2000),
                 PriceItem(item_id="drain", title="Drain clearing", unit_cents=18000),
                 PriceItem(item_id="heater", title="Water heater flush", unit_cents=15000),
                 PriceItem(item_id="leak", title="Leak repair", unit_cents=25000),
                 PriceItem(item_id="pipe", title="Pipe repair (starting price)", unit_cents=10000),
                 PriceItem(item_id="short-notice", title="Short-notice fee", unit_cents=5000)]
RIVERA_KNOWLEDGE = [
    KnowledgeItem(item_id="kn-website", source="website",
                  title="Your website, turner-plumbing.example, read during setup",
                  text="Turner Plumbing is Mike Turner's home plumbing business: drain clearing, leak repair and "
                       "water heater flushes. We work in Oakland, Berkeley, Alameda and Emeryville.",
                  label=Label(readers=["public"])),
    KnowledgeItem(item_id="kn-price-list", source="setup", title="Price list, from your answers in setup",
                  text="The price list Mike gave in setup covers the service call deposit, drain clearing, a "
                       "water heater flush, leak repair, pipe repair (starting price) and a short-notice fee. "
                       "The short-notice fee is added to an urgent visit that Mike fits in at short notice. Each price is given in a quote from this list.",
                  label=Label(readers=["public"])),
]
RIVERA_PEOPLE = [("dana", "Dana Whitfield", "dana@example.com"), ("bob", "Bob Okafor", "bob@example.com")]
RIVERA_DOCUMENTS = [  # (ref, title, record owner, body): the kernel ends each body with a fresh canary
    ("dana-invoice", "Invoice, drain clearing", "dana",
     "Turner Plumbing\nInvoice, drain clearing\nBilled to Dana Whitfield\nDrain clearing: $180.00\n"),
    ("bob-warranty", "Warranty, water heater flush", "bob",
     "Turner Plumbing\nWarranty, water heater flush\nIssued to Bob Okafor\nCovers the flush for a year.\n")]
RIVERA_CHARTER = [Claim(key="contact", kind="text", value="(510) 555-0142"),
                  Claim(key="policy:service_area", kind="text",
                        value="We work in Oakland, Berkeley, Alameda and Emeryville."),
                  Claim(key="policy:first_visit", kind="text",
                        value="The service call deposit is credited to the repair if you go ahead."),
                  Claim(key="policy:arrival", kind="text", value="Mike texts before he arrives.")]
RIVERA_STARTERS = {
    "en": ["How much is drain clearing?", "Can someone come Tuesday?", "Do you work in Alameda?"],
    "es": ["¿Cuánto cuesta destapar un desagüe?", "¿Puede venir alguien el martes?", "¿Trabajan en Alameda?"],
}
STARTER_KEY = "starter:"   # a seed-only question's claim key is `starter:<n>:<lang>`, its fact `charter:<key>`


def is_starter_fact(fact_id: str) -> bool:
    """A seed-only starter question's fact: out of Claude's context, kept by a charter replace, never an owner's."""
    return fact_id.startswith(f"charter:{STARTER_KEY}")


NOTIFICATIONS = {"now": ["approval", "callback", "breaker", "lockout", "handoff"],
                 "briefing": ["lead", "booking"]}
# The seed's simulated notes, matching fixtures/memory.json (not read from another Desk).
MEMORY_ITEMS = DeskMemoryRequest.model_validate({"about": "Simulated Turner notes.", "items": [
    {"id": "business", "title": "Business", "topics": ["business", "name", "owner", "company"],
     "text": "Mike Turner owns Turner Plumbing in Oakland, California, and answers its phone himself between jobs."},
    {"id": "trade", "title": "Trade", "topics": ["trade", "services", "work", "plumbing"],
     "text": "Turner Plumbing does home plumbing: drain clearing, leak repair and water heater flushes."},
    {"id": "service-area", "title": "Service area", "topics": ["area", "cities", "where"],
     "text": "Turner Plumbing works in Oakland, Berkeley, Alameda and Emeryville."},
    {"id": "hours", "title": "Hours", "topics": ["hours", "open", "opening", "schedule", "when"],
     "text": "Open Monday to Friday, 8 am to 6 pm, and Saturday, 9 am to 1 pm. Closed on Sundays."},
    {"id": "website", "title": "Website", "topics": ["website", "site", "web", "online"],
     "text": "The business's website is https://turner-plumbing.example."}]})
OWNER_NAME = re.compile(r"[A-Za-zÀ-ÿ' -]{1,40}")   # Plan 01a's owner_display_name pattern
# A fetched page (the kernel's fetch guard reads the real one): here any `.example` site reads as this, and any
# other address is refused.
WEBSITE_TEXT = "{host}: leak repair, drain clearing and water heaters. Call us any weekday."
RIVERA_MONEY_CAP_CENTS = 50_000   # the money cap of the seed's rules ($500, `DeskSeed.auto_money_cap_cents`)


def _card(card_id: str, applies_to: str, mode: str, who: str, reason: str, **limits) -> RuleCard:
    return RuleCard(card_id=card_id, applies_to=applies_to, mode=mode, who=who, reason=reason, **limits)


# `PRESETS["ask_first"]` (Plan 01a): auto cards for anyone on the utility and setup tools; the rest asks.
ASK_FIRST_CARDS = list(PRESETS["ask_first"])
RIVERA_CARDS = [
    *ASK_FIRST_CARDS,
    _card("rv-quote", "native.quote", "auto", "anyone", "Quotes from your price list, at list price."),
    _card("rv-book-wk", "native.book", "auto", "anyone", "Weekday bookings in opening hours, checked by the reviewer.",
          hours=RIVERA_HOURS[0], review=True),
    _card("rv-book-sat", "native.book", "auto", "anyone", "Saturday morning bookings, checked by the reviewer.",
          hours=RIVERA_HOURS[1], review=True),
    _card("rv-docs", "native.release_document", "auto", "record_owner",
          "Customers get their own documents after confirming it's them."),
    _card("rv-link", "native.payment_link", "auto", "anyone", "Payment links for quotes up to $300, checked by the "
          "reviewer.", max_amount_cents=30_000, review=True),
    _card("rv-mandate", "native.charge_mandate", "auto", "anyone",
          "Agents can pay up to $20 from their spending limit.", max_amount_cents=2_000),
    _card("rv-urgent", "desk.emergency-callback", "auto", "anyone",
          "Anyone can ask for an urgent callback, which alerts you at once."),
    *(RuleCard(card_id=f"default-{tool}", applies_to=tool, mode="ask", who="anyone", is_default=True,
               reason="Anything your rules don't cover waits for you.")
      for tool in ("native.release_document", "payments.list_charges", "payments.create_refund")),
]

# The seed's urgent business tool (the kernel's `seed.RIVERA_BUSINESS_TOOLS`): every copy has it enabled, turned on
# by the seed's rules version, so `rv-urgent` allows it for anyone given the native callback.
RIVERA_BUSINESS_TOOLS = [
    {"tool": "desk.emergency-callback", "title": "Emergency callback",
     "description": "Asks Mike to call back urgently about an emergency.",
     "config": {"block": "urgent", "urgent_when": "A burst or leaking pipe, flooding, a sewage backup, or no water"}},
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
    "native.book": _closed({"slot_id": {"type": "string", "pattern": SLOT_ID_PATTERN},
                             "note": {"type": ["string", "null"], "maxLength": 200,
                                      "description": "Optional details for the owner only."}}, ("slot_id",)),
    "native.release_document": _closed({"document_id": {**TEXT, "maxLength": 64}}, ("document_id",)),
    "native.payment_link": _closed({"quote_id": TEXT}, ("quote_id",)),
    "native.charge_mandate": _closed({"quote_id": TEXT}, ("quote_id",)),
    "native.capture_lead": _closed({"name": {**TEXT, "maxLength": 80},
                                    "contact": {"type": ["string", "null"], "maxLength": 120},
                                    "note": {"type": ["string", "null"], "maxLength": 200}}, ("name",)),
    "native.request_callback": _closed({"name": {**TEXT, "maxLength": 80}, "contact": {**TEXT, "maxLength": 120},
                                        "reason": {**TEXT, "maxLength": 200}}, ("name", "contact", "reason")),
    "native.start_verification": _closed({"contact": {**TEXT, "maxLength": 120}}, ("contact",)),
    "payments.list_charges": _closed({}),
    "payments.create_refund": _closed({"charge_id": TEXT}, ("charge_id",)),
    "native.fetch_website": _closed({"url": {**TEXT, "maxLength": 2048}}, ("url",)),
    "native.read_memory": _closed({"query": {**TEXT, "maxLength": 200}}, ("query",)),
    "native.web_search": _closed({"query": {**TEXT, "maxLength": 200}}, ("query",)),
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
    "native.charge_mandate": (["charge"], False, "quote", "Charge a quote to the agent's spending limit."),
    "native.capture_lead": (["change"], True, "desk", "Save a customer's name and how to reach them."),
    "native.request_callback": (["change"], True, "desk", "Ask the owner to call the customer back."),
    "native.start_verification": (["send_message"], True, "desk",
                                  "Send a code to the contact the business has on record."),
    "payments.list_charges": (["private_data"], True, "charge", "List the verified customer's own charges."),
    "payments.create_refund": (["pay_out", "private_data"], False, "charge",
                               "Refund one of the verified customer's charges in full."),
    "native.fetch_website": (["read"], True, "desk", "Read the business's website during setup."),
    "native.read_memory": (["read"], True, "desk", "Search the owner's Claude memory during setup."),
    "native.web_search": (["read"], True, "desk", "Search the web to learn how businesses like this one work."),
}
# The mock payments server's simulated change (Plan 01c): appended to the tool's description for the copy.
SIMULATED_CHANGE = "Refunds may be sent to any card the caller names."
TOOL_LABELS = {"payments.list_charges": "Payment history", "payments.create_refund": "Refunds"}
# The owner's setup tools (Plan 01c): given to owner sessions only, and the only tools an owner session has.
OWNER_TOOLS = ("native.fetch_website", "native.read_memory", "native.web_search")
# The ten tools a visitor could ever be given, and those an unverified or a verified visitor has now.
VISITOR_DECLARED = tuple(tool for tool in TOOL_FACTS if tool not in ("native.charge_mandate", *OWNER_TOOLS))
# An agent is never given refunds; it gets the mandate charge and payment links only with a verified mandate.
AGENT_DECLARED = tuple(tool for tool in TOOL_FACTS if tool not in ("payments.create_refund", *OWNER_TOOLS))
MANDATE_TOOLS = ("native.payment_link", "native.charge_mandate")
UNVERIFIED_TOOLS = ("native.quote", "native.find_slots", "native.book", "native.payment_link",
                    "native.capture_lead", "native.request_callback", "native.start_verification")
VERIFIED_TOOLS = ("native.quote", "native.find_slots", "native.book", "native.payment_link", "native.capture_lead",
                  "native.request_callback", "native.release_document", "payments.list_charges",
                  "payments.create_refund")
ANSWERING_OFF_TOOLS = ("native.capture_lead", "native.request_callback")


TOOL_NAMES = frozenset(get_args(ToolName))
ALLOW_FOR = timedelta(seconds=60)       # an allow must execute within this
HOLD_FOR = timedelta(hours=24)          # a hold waits this long for the owner
# Visitor-facing status lines, the kernel's own (its `render.en.STATUS` and `render.es.STATUS`, Plan 01a): no amounts,
# dates or limits, in the session's last language.
STATUS_TEXT = {
    "en": {"allowed": "Checked against {owner}'s rules", "held": "Waiting for {owner} to approve",
           "refused": "Not something I can do here", "approved": "{owner} approved this",
           "denied": "{owner} decided not to go ahead", "expired": "This request timed out", "cancelled": "Cancelled",
           "executed": "Done", "failed": "That didn't go through", "unknown": "Still confirming this",
           "refused_at_execution": "The rules changed, so this didn't go ahead"},
    "es": {"allowed": "Revisado con las reglas de {owner}", "held": "Esperando la aprobación de {owner}",
           "refused": "No es algo que pueda hacer aquí", "approved": "{owner} lo aprobó",
           "denied": "{owner} decidió no seguir adelante", "expired": "Esta solicitud venció", "cancelled": "Cancelado",
           "executed": "Hecho", "failed": "No se pudo completar", "unknown": "Todavía lo estamos confirmando",
           "refused_at_execution": "Las reglas cambiaron, así que no se hizo"},
}
# Owner-only refusal lines for the fake's two refusal paths: a changed policy and exhausted mandate.
# The owner has no language setting yet, so these stay English whatever the session's language.
OWNER_REFUSAL_TEXT = {
    "rules_changed": "Your rules changed before this ran, so it wasn't done.",
    "fallback": "This couldn't run, so it wasn't done.",
}
# The owner-only line for a held request the visitor's own booking closed (the kernel's
# `render.en.OWNER_STATUS["cancelled_by_booking"]`); a visitor's own cancel has none.
OWNER_BOOKING_CLOSED_TEXT = "The visitor booked before you answered, so this request closed."
# What a visitor's or an agent's executed action did, by tool (the kernel's `render.en.EXECUTED` and
# `render.es.EXECUTED`, Plans 01b and 01c), in place of the generic executed line.
EXECUTED_TEXT = {
    "en": {"native.quote": "Quoted from {owner}'s price list",
           "native.find_slots": "Times read from {owner}'s calendar",
           "native.book": "Booked on {owner}'s calendar", "native.capture_lead": "Details saved for {owner}",
           "native.request_callback": "Callback request saved for {owner}",
           "native.start_verification": "Verification started",
           "native.release_document": "Document shared from {owner}'s records",
           "native.payment_link": "Payment link made for this quote",
           "payments.list_charges": "Charges read from {owner}'s payments",
           "payments.create_refund": "Refunded to the original payment",
           "native.charge_mandate": "Charged within the limit of your mandate"},
    "es": {"native.quote": "Cotizado con la lista de precios de {owner}",
           "native.find_slots": "Horarios tomados del calendario de {owner}",
           "native.book": "Reservado en el calendario de {owner}",
           "native.capture_lead": "Datos guardados para {owner}",
           "native.request_callback": "Solicitud de llamada guardada para {owner}",
           "native.start_verification": "Verificación iniciada",
           "native.release_document": "Documento compartido desde los registros de {owner}",
           "native.payment_link": "Enlace de pago creado para esta cotización",
           "payments.list_charges": "Cargos tomados de los pagos de {owner}",
           "payments.create_refund": "Reembolsado al pago original",
           "native.charge_mandate": "Cobrado dentro del límite de tu mandato"},
}


def status_line(state: str, *, tool: str, session_kind: str, language: str | None, owner: str, business=None) -> str:
    """A decision's status line in `state` (the kernel's `decide.status_line`): once a visitor's or an agent's action
    has run, what was done; otherwise, or for the owner's own setup action, the state's line; in Spanish when the
    session last spoke it, else in English."""
    language = "es" if language == "es" else "en"
    if state == "executed" and session_kind != "owner" and business is not None:
        from desk.kernel_service.render import executed_status
        return executed_status(tool, language, owner=owner, business=business)
    if state == "executed" and session_kind != "owner" and tool in EXECUTED_TEXT[language]:
        return EXECUTED_TEXT[language][tool].format(owner=owner)
    return STATUS_TEXT[language][state].format(owner=owner)


HELD_ANSWERS = ("allow_once", "allow_person", "deny_once", "deny_always")
# Rules drafts (Plan 01a): the master's proof obligations, what a failing one says, and the compiler's default ask.
PROOF_CHECKS = ("never_errors", "baseline_auto", "baseline_approvable", "auto_within_cards", "review_only_narrows",
                "hold_within_cards", "money_needs_card")
BOUNDED_CASES = 1_200
COUNTEREXAMPLE = "A visitor could get something done without asking you that your cards don't allow."
DEFAULT_REASON = "Anything your rules don't cover waits for you."
# Verification is always on (Plan 01b): no owner card may change starting one. The tools of the always-on baseline,
# and the presets' own card for each (auto, for anyone, on the tool), which every preset and the Turner seed carry.
ALWAYS_ON_TOOLS = ("native.start_verification",)
ALWAYS_ON_CARDS = tuple(card for card in PRESETS["ask_first"] if card.applies_to in ALWAYS_ON_TOOLS)


def _specificity(card: RuleCard) -> tuple[int, int]:
    """`(who is a person or an agent, applies_to is a tool)`, compared in that order, as the compiler ranks cards."""
    return int(card.who in ("person", "agent")), int(not card.applies_to.startswith("effect:"))


def changes_always_on(card: RuleCard) -> bool:
    """Whether `card` could change a tool of the always-on baseline, which `POST /policy/draft` refuses as 422
    `invalid` (the kernel's compiler, Plan 01b; mirrored here in test code, never in the API's): a card on the tool
    other than the presets' own for it (every field but its reason the same), or a card on one of the tool's effects
    that isn't an `auto` card ranked below the presets' card. An `ask` or `never` effect card would hold or refuse
    the tool, and an `auto` one for a person or an agent would outrank the presets' card with its own gates."""
    effect = card.applies_to.removeprefix("effect:") if card.applies_to.startswith("effect:") else None
    for tool in ALWAYS_ON_TOOLS:
        shipped = [each for each in ALWAYS_ON_CARDS if each.applies_to == tool]
        if card.applies_to == tool:
            if not any(card.model_copy(update={"reason": each.reason}) == each for each in shipped):
                return True
        elif effect in TOOL_FACTS[tool][0] and (card.mode != "auto" or not shipped
                                                 or any(_specificity(card) >= _specificity(each) for each in shipped)):
            return True
    return False


def proof_report(*, ok: bool = True, method: str = "symcc", timed_out: bool = False) -> ProofReport:
    """A draft's proof: every obligation holding; `ok=False` fails `auto_within_cards` with a plain counterexample;
    `timed_out` is a rejection with no counterexample; `bounded` is "checked on N cases", never "proven"."""
    if timed_out:
        return ProofReport(ok=False, method="symcc", timed_out=True, checks=[])
    if method == "bounded":
        return ProofReport(ok=True, method="bounded", cases=BOUNDED_CASES,
                           checks=[ProofCheck(name=name, ok=True) for name in PROOF_CHECKS])
    failing = None if ok else "auto_within_cards"
    return ProofReport(ok=ok, method="symcc", checks=[
        ProofCheck(name=name, ok=name != failing, counterexample_plain=COUNTEREXAMPLE if name == failing else None)
        for name in PROOF_CHECKS])


def tool_profile(tool: str) -> ToolProfile:
    effects, reversible, resource_kind, description = TOOL_FACTS[tool]
    source = "mcp" if tool.startswith("payments.") else "native"
    return ToolProfile(tool=tool, source=source, effects=effects, reversible=reversible, adapter=f"fake.{tool}",
                       resource_kind=resource_kind, description_confirmed=description,
                       input_schema=INPUT_SCHEMAS[tool],
                       definition_sha256=sha256_hex(tool), status="enabled")


def signed_time(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def slugify(name: str) -> str:
    """A slug's readable part: ASCII lowercase letters and digits, other runs as one "-", at most 40 ("desk" if
    nothing is left)."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name).strip("-")[:40].strip("-") or "desk"


def mask_contact(contact: str) -> str:
    name, _, domain = contact.partition("@")
    return f"{name[0]}•••@{domain}"


def normalize_contact(contact: str) -> str:
    """An email trimmed and lowercased, else a phone number's ASCII digits ("" when none: no one's contact)."""
    text = contact.strip().lower()
    return text if "@" in text else "".join(char for char in text if char in string.digits)


KNOWLEDGE_MAX_BYTES = 100 * 1024        # a knowledge item's text
DOCUMENT_MAX_BYTES = 200 * 1024         # an uploaded document's body
CODE_TTL = timedelta(minutes=10)        # a verification challenge's life
LINK_TTL = timedelta(hours=24)          # a document or payment link's life
PAYMENT_CONFIRMED = {"en": "Payment received", "es": "Pago recibido"}   # the payment_confirmed card's title
MAX_ATTEMPTS = 5                        # wrong codes a challenge takes before it fails
# The kernel's verification templates (Plan 01b), by language.
VERIFY_TEXT = {
    "en": {"started": "If that contact is on record, a code is on its way. Enter it below to confirm it's you.",
           "already": "You're already confirmed in this chat.", "preview": "New verification code",
           "body": "Your {business} code is {code}. It expires in ten minutes. If you didn't ask for it, ignore this "
                   "message."},
    "es": {"started": "Si ese contacto está registrado, te enviamos un código. Escríbelo abajo para confirmar que "
                      "eres tú.",
           "already": "Ya confirmaste quién eres en este chat.", "preview": "Nuevo código de verificación",
           "body": "Tu código de {business} es {code}. Vence en diez minutos. Si no lo pediste, ignora este mensaje."},
}


# The public page (Plans 01a, 01b and 01c): the charter in the page's order, the open-now line and the Agent Card,
# in the kernel's words (its `render.en` and `render.es`).
CHARTER_TEMPLATES = (("hours", "charter:hours"), ("contact", "charter:contact"), ("policy", "charter:policy:"))
OPEN_STATUS_DAYS = 7                    # the open-now line looks this many local days ahead
REFRESH_WITHIN = timedelta(hours=25)    # the latest the line is asked for again
WEEKDAYS = {"en": ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"),
            "es": ("lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo")}
AGENT_TOOLS = {
    "en": {"native.quote": "get a quote from the price list", "native.find_slots": "find open times",
           "native.book": "book a visit", "native.payment_link": "get a payment link for a quote",
           "native.charge_mandate": "pay for a quote within the limit of a signed mandate",
           "native.capture_lead": "leave contact details", "native.request_callback": "ask for a callback",
           "native.start_verification": "verify a customer with a code sent to their contact on record",
           "native.release_document": "receive a verified customer's own documents",
           "payments.list_charges": "list a verified customer's own charges"},
    "es": {"native.quote": "pedir una cotización de la lista de precios", "native.find_slots": "buscar horarios libres",
           "native.book": "reservar una visita", "native.payment_link": "pedir un enlace de pago para una cotización",
           "native.charge_mandate": "pagar una cotización dentro del límite de un mandato firmado",
           "native.capture_lead": "dejar datos de contacto",
           "native.request_callback": "pedir que te devuelvan la llamada",
           "native.start_verification": "verificar a un cliente con un código enviado a su contacto registrado",
           "native.release_document": "recibir los documentos propios de un cliente verificado",
           "payments.list_charges": "ver los cargos propios de un cliente verificado"},
}
AGENT_CARD = {
    "en": ("Visiting agents can talk to {business} here too. Answers come from Claude, an AI, working within "
           "{owner}'s rules, unless a message is marked as {owner}'s own.",
           "What an agent can do here: {tools}.",
           "Send each request to POST /api/a2a/{slug} on this site; {slug} is this Desk's slug.",
           "Sign every request with Ed25519 and send the headers X-Agent-Key-Id, X-Agent-Ts, X-Agent-Nonce and "
           "X-Agent-Sig. The signature covers the RFC 8785 canonical JSON of desk_slug, ts, nonce and body_sha256, the "
           "lowercase hex SHA-256 of the raw request body.",
           "A signature counts for 5 minutes either side of its timestamp, and each nonce covers one turn of the "
           "conversation.",
           "Agent keys only say which agent is asking. They are not business credentials: they can't change {owner}'s "
           "rules or show anyone's private data, and money moves only as those rules and a signed mandate allow."),
    "es": ("Los agentes también pueden hablar aquí con {business}. Las respuestas vienen de Claude, una IA, que sigue "
           "las reglas de {owner}, salvo los mensajes marcados como de {owner}.",
           "Lo que un agente puede hacer aquí: {tools}.",
           "Envía cada solicitud a POST /api/a2a/{slug} en este sitio; {slug} es el identificador de este Desk.",
           "Firma cada solicitud con Ed25519 y envía los encabezados X-Agent-Key-Id, X-Agent-Ts, X-Agent-Nonce y "
           "X-Agent-Sig. La firma cubre el JSON canónico RFC 8785 de desk_slug, ts, nonce y body_sha256, el SHA-256 en "
           "hexadecimal minúscula del cuerpo exacto de la solicitud.",
           "Una firma vale 5 minutos antes o después de su marca de tiempo, y cada nonce cubre un turno de la "
           "conversación.",
           "Las claves de agente solo dicen qué agente pregunta. No son credenciales del negocio: no cambian las "
           "reglas de {owner} ni muestran datos privados de nadie, y el dinero solo se mueve como lo permiten esas "
           "reglas y un mandato firmado."),
}
AGENT_CARD_NO_TOOLS = {"en": "nothing for now", "es": "nada por ahora"}


def listing(parts: list[str], language: str) -> str:
    """"a", "a and b", "a, b and c" ("y" in Spanish)."""
    last = " and " if language == "en" else " y "
    return parts[0] if len(parts) == 1 else f"{', '.join(parts[:-1])}{last}{parts[-1]}"


def agent_card(language: str, *, business: str, owner: str, slug: str, tools: set[str]) -> list[RenderedBlock]:
    """The Agent Card in `language`: the kernel's prose blocks, naming what an agent may ask for there by the labels of
    `tools`, in the card's order."""
    labels = [label for tool, label in AGENT_TOOLS[language].items() if tool in tools]
    listed = listing(labels, language) if labels else AGENT_CARD_NO_TOOLS[language]
    return [RenderedBlock(kind="prose", text=line.format(business=business, owner=owner, slug=slug, tools=listed))
            for line in AGENT_CARD[language]]


def open_window(hours: list[HoursWindow], tz: ZoneInfo, now: datetime) -> tuple[bool, datetime | None, datetime] | None:
    """Whether the business is open at `now` by its weekly `hours` in `tz` (an end of 00:00 is the end of the day),
    the next instant within 7 local days that changes it (None when none does), and when the line is asked for again:
    the earliest of that boundary, the next local midnight and 25 hours on. None without windows. Clock changes are
    read as the wall clock gives them (the kernel finds each instant they skip or repeat)."""
    if not hours:
        return None
    local_now = now.astimezone(tz)
    week_on = local_now + timedelta(days=OPEN_STATUS_DAYS)
    is_open = in_hours(now, hours, tz) is not None
    candidates = set()
    day = local_now.date() - timedelta(days=1)
    while day <= week_on.date() + timedelta(days=1):
        for window in hours:
            if ("mon", "tue", "wed", "thu", "fri", "sat", "sun")[day.weekday()] in window.days:
                candidates.add(datetime.combine(day, window.start, tz))
                candidates.add(datetime.combine(day + timedelta(days=1), time(0), tz) if window.end == time(0)
                               else datetime.combine(day, window.end, tz))
        day += timedelta(days=1)
    boundary = next((instant for instant in sorted(candidates) if now < instant <= week_on
                     and (in_hours(instant, hours, tz) is not None) != is_open), None)
    midnight = datetime.combine(local_now.date() + timedelta(days=1), time(0), tz)
    return is_open, boundary, min(instant for instant in (boundary, midnight, now + REFRESH_WITHIN) if instant)


def _clock(moment: datetime, language: str) -> str:
    """"2:00 pm" in English, "14:00" in Spanish."""
    if language == "en":
        return f"{moment.hour % 12 or 12}:{moment.minute:02d} {'am' if moment.hour < 12 else 'pm'}"
    return f"{moment.hour}:{moment.minute:02d}"


def _day(moment: datetime, as_of: datetime, language: str) -> str:
    """`moment`'s date as `as_of` reads it: today, tomorrow, the weekday ("next" for a week on)."""
    ahead, weekday = (moment.date() - as_of.date()).days, WEEKDAYS[language][moment.weekday()]
    if language == "en":
        return "today" if ahead == 0 else "tomorrow" if ahead == 1 else f"next {weekday}" if ahead == 7 else weekday
    return "hoy" if ahead == 0 else "mañana" if ahead == 1 else f"el {'próximo ' if ahead == 7 else ''}{weekday}"


def open_status_text(is_open: bool, boundary: datetime | None, as_of: datetime, language: str) -> str:
    """The kernel's open-now line ("Open now, until 6:00 pm", "Closed now. Opens tomorrow at 8:00 am"), `boundary`
    and `as_of` in the business's time zone."""
    at = (lambda moment: f"{'la' if moment.hour == 1 else 'las'} {_clock(moment, 'es')}") if language == "es" else (
        lambda moment: _clock(moment, "en"))
    if not is_open:
        day = _day(boundary, as_of, language)
        return f"Closed now. Opens {day} at {at(boundary)}" if language == "en" else (
            f"Cerrado ahora. Abre {day} a {at(boundary)}")
    if boundary is None:
        return "Open now" if language == "en" else "Abierto ahora"
    if (boundary.hour, boundary.minute) == (0, 0):
        day = _day(boundary - timedelta(days=1), as_of, language)
        until = ("midnight" if day == "today" else f"{day} at midnight") if language == "en" else (
            "la medianoche" if day == "hoy" else f"{day} a medianoche")
    else:
        day = _day(boundary, as_of, language)
        if day in ("today", "hoy"):
            until = at(boundary)
        elif language == "en":
            until = f"{at(boundary)} tomorrow" if day == "tomorrow" else f"{day} at {at(boundary)}"
        else:
            until = f"{day} a {at(boundary)}"
    return f"Open now, until {until}" if language == "en" else f"Abierto ahora, hasta {until}"


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


def in_hours(moment: datetime, windows: list[HoursWindow], tz: ZoneInfo = RIVERA_TZ) -> HoursWindow | None:
    """The opening-hours window `moment` (in business time, `tz`) falls in, if any."""
    local = moment.astimezone(tz)
    day = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")[local.weekday()]
    for window in windows:
        end = window.end if window.end != time(0) else time.max
        if day in window.days and window.start <= local.time() < end:
            return window
    return None


_JSON_TYPES = {"object": dict, "array": list, "string": str, "null": type(None)}


def storable(text: str) -> bool:
    """Mirror repo.storable: Postgres text and JSONB require valid UTF-8 without NUL."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return "\0" not in text


def matches(schema: dict, value: Any) -> bool:
    """Whether `value` fits one of the closed input schemas above (the subset of JSON Schema they use).
    Integers are strict: `"1"`, `1.0` and `true` are not integers."""
    if "anyOf" in schema:
        return any(matches(option, value) for option in schema["anyOf"])
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
KERNEL_ONLY_TEMPLATES = ("owner_said", "payment_confirmed", "link_cancelled")
FACTLESS_TEMPLATES = ("handoff", "verify_prompt")
OTHER_LANGUAGE_WORDS = {"bonjour", "merci", "je", "vous", "nous", "olá", "obrigado", "você", "ciao", "grazie",
                        "danke"}
SPANISH_WORDS = {"hola", "gracias", "puedo", "usted", "ayudar", "ayudarle", "con", "para", "buenos", "buenas", "días",
                 "tardes", "quiero", "necesito", "cuánto", "cuando", "está", "estoy", "el", "la", "los", "las",
                 "un", "una", "claro", "aquí", "soy", "es", "hay", "su", "sus", "tu", "te"}
ENGLISH_WORDS = frozenset("""
    the an and or but of to in on at for with from by about into is are was were be been being am can could will
    would should may might must have had does did this that these those there here what which who whom when where
    how why i you she it we they my your his her its our their him us them not if just only also any some all more
    very please thanks thank hello hi yes sure help need want like know get let see look call down up out off then
    now until after before than too
""".split())
# The cards the fake renders plainly, and a verdict's status lines in the kernel's own words (its `reply_checked`,
# `reply_handed_off`, `owner_said` and `owner_say_blocked` lines), and its call-back offer.
REPLY_TEXT = {"en": {"handoff": "Let me check with {owner}.", "checked": "Reply checked against {owner}'s rules",
                     "handed_off": "Passed to {owner} to answer",
                     "verify": "Enter the code sent to the contact on record.", "hours": "Opening hours",
                     "owner_said": "Written by {owner}",
                     "owner_say_blocked": "Not sent: it included text from a private document",
                     "offer_callback": "Would you like me to arrange a callback?",
                     "check_status": "This is waiting for approval; you can see where it stands in this chat."},
              "es": {"handoff": "Déjame consultarlo con {owner}.",
                     "checked": "Respuesta revisada con las reglas de {owner}",
                     "handed_off": "Pasado a {owner} para responder",
                     "verify": "Escribe el código enviado al contacto registrado.", "hours": "Horario",
                     "owner_said": "Escrito por {owner}",
                     "owner_say_blocked": "No se envió: incluía texto de un documento privado",
                     "offer_callback": "¿Quiere que solicite una llamada?",
                     "check_status": "Esto está esperando aprobación; puede consultar su estado en este chat."}}
# A session's tools offer a call back when they offer this next step (`native.request_callback`, or a business tool
# of block `urgent`), as the kernel's `reply_check.offers_call_back` reads them.
CALL_BACK_STEP = NEXT_STEPS["native.request_callback"]
# The reason of a handoff the handoff card opens (#96), the kernel's own words, never the draft's or the visitor's.
CARD_HANDOFF_REASON = "The Desk handed this to you."
OWNER_TEXT_MAX = 2000                   # an owner's say or whisper, in characters (Plan 01b)
NUMBER_RULES = (("digit", re.compile(r"\d")), ("currency", re.compile(r"[$€£¥¢]")), ("percent_sign", re.compile(r"%")))


def detect_language(prose: str) -> str:
    """A small language stub: supported markers, positive other markers, or unmarked Latin prose."""
    words = re.findall(r"[^\W\d_]+", prose.lower())
    if not words:
        return "none"
    if words[0] == "bonjour" or set(words) & OTHER_LANGUAGE_WORDS:
        return "other"
    if set(words) & SPANISH_WORDS or any(mark in prose for mark in "ñ¿¡"):
        return "es"
    if not set(words) & ENGLISH_WORDS:
        return "unmarked" if len(words) >= 4 else "none"
    return "en"


def canary_key(text: str) -> tuple[str, list[int]]:
    """`text` as canaries are matched in it (the kernel's `labels.canary_key`): each character in NFKC and case-folded,
    keeping only ASCII letters and digits, so spaces, punctuation, capitals and full-width forms hide no canary; and
    the index in `text` each kept character came from."""
    chars: list[str] = []
    origin: list[int] = []
    for index, char in enumerate(text):
        for part in unicodedata.normalize("NFKC", char).casefold():
            if part.isascii() and part.isalnum():
                chars.append(part)
                origin.append(index)
    return "".join(chars), origin


def canary_spans(text: str, canaries: dict[str, str]) -> list[tuple[str, int, int]]:
    """Each place a canary of `canaries` (each document's canary, by its ID) occurs in `text`, matched by
    `canary_key`: the document's ID, and the start and end of the characters it takes up in `text`, whatever lies
    between."""
    key, origin = canary_key(text)
    spans = []
    for document_id, canary in canaries.items():
        wanted = canary_key(canary)[0]
        start = key.find(wanted) if wanted else -1
        while start >= 0:
            spans.append((document_id, origin[start], origin[start + len(wanted) - 1] + 1))
            start = key.find(wanted, start + 1)
    return spans


def scan_prose(prose: str, canaries: dict[str, str]) -> list[Violation]:
    """Document canaries (`canaries`, each by its document's ID), however they are written (`canary_spans`): one
    `canary` violation naming their documents, listed first, with each canary blanked out before the rest is scanned,
    so no span repeats one. Then digits, money signs and percent signs in what is left."""
    text = unicodedata.normalize("NFKC", prose).replace("\u200b", "").replace("\u00ad", "")
    spans = canary_spans(text, canaries)
    chars = list(text)
    for _, start, end in spans:
        chars[start:end] = " " * (end - start)
    text = "".join(chars)
    held = {document_id for document_id, _, _ in spans}
    violations = []
    if held:
        violations.append(Violation(kind="canary", span="document text", rule_id="labels.canary",
                                    fact_ids=[f"document:{document_id}" for document_id in canaries
                                              if document_id in held]))
    for rule_id, pattern in NUMBER_RULES:
        found = pattern.search(text)
        if found:
            violations.append(Violation(kind="number_in_prose", span=text[found.start():found.start() + 40],
                                        rule_id=rule_id))
    return violations


def money(cents: int) -> str:
    return f"${cents / 100:,.2f}"


# The kernel's policy-only phrase lists (`lexicon/policy_ai_denial.txt`, `lexicon/policy_free_price.txt`),
# one entry per line, read on the accent-folded text.
POLICY_AI_DENIAL = (
    r"(?<!no\s)(?:hablaras?|vas?\s+a\s+hablar)\s+con\s+(?:una\s+persona(?:\s+real)?|un\s+(?:ser\s+)?humano)(?=\s*(?:[^\w\s-]|$)|\s+(?:y|tambien|aqui|que)\b)(?![^.!?]{0,40}\b(?:cuando|si)\s+(?:usted\s+)?(?:llam[ae]s?|visite?s?)\b|\s+por\s+telefono\b)",
    r"you(?:['’]ll|\s+will)\s+be\s+(?:talking|chatting|speaking)\s+(?:to|with)\s+an?\s+(?:real\s+)?(?:human|person)(?=\s*(?:[^\w\s-]|$)|\s+(?:and|too|here|who)\b)(?![^.!?]{0,40}\b(?:when|if|once)\s+you\s+(?:call|phone|ring|visit)\b|\s+(?:by|on\s+the|over\s+the)\s+phone\b)",
    r"you(?:\s+are|['’]re)\s+(?:chatting|talking|speaking)\s+(?:with|to)\s+an?\s+(?:(?:real|live|actual)\s+)?(?:human|person)",
    r"you(?:\s+are\s+not|['’]re\s+not|\s+aren['’]t)\s+(?:chatting|talking|speaking)\s+(?:with|to)\s+(?:a\s+(?:bot|robot|chatbot|machine)|an?\s+AI|AI)(?![\s-]*(?:generated|written|made|created|powered)\b)(?!-)",
    r"(?:this\s+is|you(?:['’]ve|\s+have)\s+reached)\s+an?\s+(?:(?:human|real|live|actual)\s+(?:receptionist|agent|assistant|person|human)|human(?=\s*(?:[^\w\s-]|$)))",
    r"I(?:\s+am|['’]m)\s+(?:a\s+(?:real|live|actual)\s+(?:person|human)|a\s+human\s+(?:receptionist|agent|assistant|representative|operator)\b|(?:a\s+)?human(?:\s+being)?(?=\s*(?:[^\w\s-]|$)|\s+(?:and|too|here|who)\b))",
    r"(?:I(?:\s+am|['’]m)\s+not|this\s+(?:is\s+not|isn['’]t))\s+(?:a\s+(?:bot|robot|chatbot|machine)|an?\s+AI|AI)(?![\s-]*(?:generated|written|made|created|powered)\b)(?!-)",
    r"(?<!no\s)esta(?:s|is|n)?\s+(?:hablando|chateando|conversando)\s+con\s+(?:una\s+persona|un\s+(?:ser\s+)?humano|una?\s+(?:agente|asistente|recepcionista)\s+human[oa])",
    r"no\s+(?:esta(?:s|is|n)?\s+(?:hablando|chateando|conversando)\s+con|soy)\s+(?:un\s+(?:bot|robot|chatbot)|una\s+(?:IA|maquina))(?!-)",
    r"(?<!no\s)soy\s+(?:una\s+persona(?:\s+(?:real|de\s+verdad))?(?=\s*(?:[^\w\s-]|$)|\s+que\b)|un(?:a)?\s+(?:recepcionista|agente|asistente)\s+human[oa]|un\s+(?:ser\s+)?humano|human[oa])",
    r"(?:esto|este\s+chat)\s+no\s+es\s+(?:un\s+(?:bot|robot|chatbot)|una\s+IA)(?!-)",
    r"(?:este\s+(?:chat|asistente)|quien\s+(?:(?:le|te|les)\s+)?(?:responde|atiende|contesta|escribe))\s+es\s+(?:una\s+persona|un\s+(?:ser\s+)?humano)",
)
POLICY_FREE_PRICE = (
    r"costs?\s+nothing",
    r"at\s+no\s+cost",
    r"no\s+cost\s+to\s+you",
    r"nothing\s+to\s+pay(?!\s+(?:until|till|before|now|today|upfront|up\s+front|in\s+advance)\b)",
    r"won['’]t\s+cost\s+you\s+anything",
    r"cuestan?\s+nada(?!\s+(?:mas|hasta|antes|por\s+adelantado|ahora|hoy)\b)",
    r"cobra(?:mos|n)?\s+nada(?!\s+(?:mas|hasta|antes|por\s+adelantado|ahora|hoy)\b)",
    r"nada\s+que\s+pagar(?!\s+(?:hasta|antes|ahora|hoy|por\s+adelantado)\b)",
)


PUBLIC_POLICY_PATTERNS = (
    ("policy.ai_denial", r"(?<!\w)(?:" + "|".join(POLICY_AI_DENIAL) + r")(?!\w)"),
    ("policy.free_price", r"(?<!\w)(?:" + "|".join(POLICY_FREE_PRICE) + r")(?!\w)"),
    ("lex.en.number", r"\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
     r"(?:twen|thir|for|four|fif|six|seven|eigh|nine)ty|half|halves|hundreds?)\b"),
    ("lex.es.number", r"\b(?:dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|mil|miles|"
     r"veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|mitad|cien)\b"),
    ("lex.en.date", r"\b(?:mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|weekends?|"
     r"same[\s-]{0,3}day|(?:in|within)[\s-]+(?:[^\W\d_]+[\s-]+){0,3}(?:minutes?|mins?|hours?|hrs?))\b"),
    ("lex.es.date", r"\b(?:lunes|martes|miercoles|jueves|viernes|sabados?|domingos?|fin(?:es)?\s+de\s+semana|ma[nñ]anas?)\b"),
    ("language", r"\b(?:gratuite?s?|offerte?s?|sans\s+frais|remises?|rabais|garantie?s?|"
     r"remboursee?s?|remboursements?|sem\s+(?:custos?|taxas?)|descontos?|garantid[oa]s?|garant(?:o|imos|em)|"
     r"senza\s+cost[oi]|scont[oi]|omaggi(?:o)?|garantit[oaie]|rimbors[oi]|"
     r"kostenlos(?:e[nmrs]?)?|umsonst|rabatt(?:e|en|s)?|garantiert(?:e[nmrs]?)?|erstattung(?:en)?)\b"),
    ("lex.en.promise", r"\b(?:(?<!feel )free(?! to\b))\b"),
    ("lex.en.promise", r"\b(?:(?<!feel )(?<!you['’]re )(?<!you are )(?<!you['’]ll be )(?<!you will be )free(?= to\b))\b"),
    ("lex.en.promise", r"\b(?:free(?=[\s-]+to[\s-]+(?:all|any(?:one|body)?|every(?:one|body)?|each|both|some|most|several|many|no|unlimited)\b))\b"),
    ("lex.en.promise", r"\b(?:free(?=[\s-]+to[\s-]+(?:the|an?|this|that|these|those|our|your|my|his|her|its|their|you|them)\b))\b"),
    ("lex.en.promise", r"\b(?:free(?=[\s-]+to[\s-]+(?:new|existing|first[\s-]?time|current|returning|regular|local)\b))\b"),
    ("lex.en.promise", r"\b(?:free(?=[\s-]+to[\s-]+(?:members?|customers?|clients?|guests?|patrons?|subscribers?|visitors?|locals|residents?)\b))\b"),
    ("lex.en.promise", r"\b(?:free(?=[\s-]+to[\s-]+(?:students?|seniors?|kids|children|famil(?:y|ies)|patients?)\b))\b"),
    ("lex.en.promise", r"\b(?:no[\s-]+costs?|complimentary|discounts?|refunds?|guarantees?|no\s+charge)\b"),
    ("lex.es.promise", r"\b(?:gratis|gratuit[oa]s?|descuentos?|garantiz\w*|reembols\w*|sin\s+costo)\b"),
    ("lex.en.booking", r"\byour\s+appointment\s+is\s+confirmed\b"),
    ("lex.es.booking", r"\btu\s+cita\s+está\s+confirmada\b"),
)


def unsupported_public_policy_language(text: str) -> bool:
    """Mirror positive other-language evidence; unmarked names and lists keep passing."""
    text = unicodedata.normalize("NFKC", text)
    letters = [char for char in text if char.isalpha()]
    non_latin = sum(not unicodedata.name(char, "").startswith("LATIN ") for char in letters)
    return non_latin > 0.3 * len(letters) or detect_language(text) == "other"


def public_commitment_reading(text: str) -> tuple[str, list[int]]:
    """Fold accents for the fake's examples, retaining original offsets for attribution."""
    chars, origin = [], []
    for index, char in enumerate(text):
        for part in unicodedata.normalize("NFKD", char):
            if unicodedata.category(part) not in ("Mn", "Me"):
                chars.append(part)
                origin.append(index)
    return "".join(chars), origin


SERVICE_AREA_BLANK = r"[\s\-‐‑]"
SERVICE_AREA_UNIT = r"(?:miles?|mi|kms?|kilomet(?:er|re)s?|kil[oó]metros?|millas?)\b"
SERVICE_AREA_CARDINAL = (
    r"(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve"
    r"|(?:thir|four|fif|six|seven|eigh|nine)teen|(?:twen|thir|for|four|fif|six|seven|eigh|nine)ty"
    r"|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince"
    r"|dieci(?:s[eé]is|siete|ocho|nueve)|veinte|veinti\w+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)")
SERVICE_AREA_AFTER_DIGITS = (
    rf"(?:(?:{SERVICE_AREA_BLANK}*[-–—]{SERVICE_AREA_BLANK}*|{SERVICE_AREA_BLANK}+(?:to|a|hasta){SERVICE_AREA_BLANK}+)"
    rf"[0-9]+(?:[.,][0-9]+)*)?{SERVICE_AREA_BLANK}*{SERVICE_AREA_UNIT}|{SERVICE_AREA_BLANK}+(?:days?{SERVICE_AREA_BLANK}+"
    rf"a{SERVICE_AREA_BLANK}+week|d[ií]as?{SERVICE_AREA_BLANK}+a{SERVICE_AREA_BLANK}+la{SERVICE_AREA_BLANK}+semana)\b")
SERVICE_AREA_YEAR_PREFIX = re.compile(r"\b(?:since|in|from|est\.|established|founded|desde|en)\s+$", re.IGNORECASE)
SERVICE_AREA_HALF_OR_HUNDRED = rf"half|(?:one{SERVICE_AREA_BLANK}+)?hundred|cien"
SERVICE_AREA_BEFORE_UNIT = rf"{SERVICE_AREA_BLANK}+(?:an?{SERVICE_AREA_BLANK}+)?{SERVICE_AREA_UNIT}"
SERVICE_AREA_DAY_WORDS = (
    r"(?:mon|tues|wednes|thurs|fri|satur|sun)days?|weekends?"
    rf"|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?|fin(?:es)?{SERVICE_AREA_BLANK}+de"
    rf"{SERVICE_AREA_BLANK}+semana|mornings|afternoons|evenings|nights|ma[nñ]anas|tardes|noches")

# ZIP ranges keep both five-digit endpoints under the same postal marker.
SERVICE_AREA_POSTAL_PREFIX = re.compile(
    r"\b(?:(?i:zip(?:\s+codes?)?|c[oó]digo\s+postal)|(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|"
    r"LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY))"
    r"\s+(?:[0-9]{5}\s*[-–—]\s*)?$")
SERVICE_AREA_ROAD_PREFIX = re.compile(r"\b(?:I-\s*|(?:Highway|Hwy)\s+)$", re.IGNORECASE)
SERVICE_AREA_ALWAYS = re.compile(r"\b24/7\b")


def allowed_service_area_hit(key: str | None, text: str, start: int, end: int, rule: str) -> bool:
    """Mirror the service-area allowance on the hit `text[start:end]`, read in that policy's own text: a
    number before a distance unit (or a range to one) or "days a week", a year, a marked ZIP code or road number, or literal "24/7"; any cardinal word, half or a hundred before a unit, "miles" as
    the unit, and weekdays, weekends and parts of the day."""
    if key not in {"policy:service_area", "charter:policy:service_area"}:
        return False
    hit, after = text[start:end], text[end:]
    if rule == "digit":
        return ((re.fullmatch(r"(?:19|20)[0-9]{2}", hit) is not None
                 and SERVICE_AREA_YEAR_PREFIX.search(text[:start]) is not None)
                or re.match(SERVICE_AREA_AFTER_DIGITS, after, re.IGNORECASE) is not None
                or (re.fullmatch(r"[0-9]{5}", hit) is not None
                    and SERVICE_AREA_POSTAL_PREFIX.search(text[:start]) is not None)
                or (hit.isascii() and hit.isdigit() and SERVICE_AREA_ROAD_PREFIX.search(text[:start]) is not None)
                or any(match.start() <= start and end <= match.end() for match in SERVICE_AREA_ALWAYS.finditer(text)))
    if rule in ("lex.en.number", "lex.es.number"):
        return (re.fullmatch(rf"miles|millas|{SERVICE_AREA_CARDINAL}", hit, re.IGNORECASE) is not None
                or (re.fullmatch(SERVICE_AREA_HALF_OR_HUNDRED, hit, re.IGNORECASE) is not None
                    and re.match(SERVICE_AREA_BEFORE_UNIT, after, re.IGNORECASE) is not None))
    if rule in ("lex.en.date", "lex.es.date"):
        return (re.fullmatch(SERVICE_AREA_DAY_WORDS, hit, re.IGNORECASE) is not None
                or (hit.casefold() in {"mañana", "manana"}
                    and re.search(r"\b(?:por|en|de)\s+la\s+$", text[:start], re.IGNORECASE) is not None))
    return False


def public_policy_rules(text: str, key: str | None = None) -> list[str]:
    """Mirror the contract's numeric and English/Spanish promise examples, not the full scan.

    The real scan imports kernel-service modules; this API test fake stays outside that boundary.
    Exhaustive lexicon behavior is covered by the real kernel's own tests.
    """
    text = unicodedata.normalize("NFKC", text)
    rules = {"percent_sign" if hit.rule_id == "percent" else hit.rule_id
             for hit in scan_prose(text, {}) if hit.rule_id != "digit"}
    for match in re.finditer(r"\d+(?:[.,:]\d+)*", text):
        if not allowed_service_area_hit(key, text, match.start(), match.end(), "digit"):
            rules.add("digit")
    if unsupported_public_policy_language(text):
        rules.add("language")
    if any(unicodedata.category(char) == "Cf" for char in text):
        rules.add("format_control")
    for rule, pattern in PUBLIC_POLICY_PATTERNS:
        reading, origin = (public_commitment_reading(text) if rule == "language" or rule.startswith("policy.")
                           else (text, list(range(len(text)))))
        if any(not ((rule == "policy.ai_denial" and future_person_direction(text, origin[match.start()]))
                    or allowed_service_area_hit(key, text, origin[match.start()], origin[match.end() - 1] + 1, rule)
                    or ((rule.endswith(".promise") or rule == "policy.free_price")
                        and offers_amenity(text, origin[match.start()], origin[match.end() - 1] + 1)))
               for match in re.finditer(pattern, reading, re.IGNORECASE)):
            rules.add(rule)
    if re.search(r"\bgrátis\b", unicodedata.normalize("NFKC", text), re.IGNORECASE):
        rules.add("language")
    return sorted(rules)


def public_policy_fields(parts: list[tuple[str | None, str]]) -> dict[str, list[str]]:
    """Attribute the contract's policy examples in the actual public or reply order."""
    fields = {key: set(public_policy_rules(value, key)) for key, value in parts if key is not None}
    ranges, pieces, offset = [], [], 0
    for key, value in parts:
        value = unicodedata.normalize("NFKC", value)
        ranges.append((key, offset, offset + len(value)))
        pieces.append(value)
        offset += len(value) + 1
    combined = "\n".join(pieces)
    if unsupported_public_policy_language(combined):
        for key in fields:
            fields[key].add("language")
    for rule, pattern in (*PUBLIC_POLICY_PATTERNS, ("language", r"\bgrátis\b")):
        reading, origin = (public_commitment_reading(combined)
                           if (rule == "language" and "grátis" not in pattern) or rule.startswith("policy.")
                           else (combined, list(range(len(combined)))))
        for match in re.finditer(pattern, reading, re.IGNORECASE):
            start, end = origin[match.start()], origin[match.end() - 1] + 1
            if rule == "policy.ai_denial" and future_person_direction(combined, start):
                continue
            # A service area's allowed number or a free amenity passes when its own card holds it ("Free parking.").
            if any(key is not None and low <= start and end <= high
                   and (allowed_service_area_hit(key, combined[low:high], start - low, end - low, rule)
                        or ((rule.endswith(".promise") or rule == "policy.free_price")
                            and offers_amenity(combined[low:high], start - low, end - low)))
                   for key, low, high in ranges):
                continue
            for key, low, high in ranges:
                if key is not None and low < end and start < high:
                    fields[key].add(rule)
    return {key: sorted(rules) for key, rules in sorted(fields.items()) if rules}


# Signed agents ---------------------------------------------------------------------------------------
AGENT_HEADERS = ("x-agent-key-id", "x-agent-ts", "x-agent-nonce", "x-agent-sig", "x-agent-body-sha256")
# The headers' forms the kernel checks before anything else (else `malformed`).
AGENT_KEY_ID = re.compile(r"[0-9a-f]{16}")
AGENT_NONCE = re.compile(r"[A-Za-z0-9_-]{16,128}")
AGENT_SIG = re.compile(r"[0-9a-f]{128}")
SHA256_HEX = re.compile(r"[0-9a-f]{64}")
SAFE_REF = re.compile(r"[A-Za-z0-9._:-]{1,64}")
SIGNED_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$")
AGENT_TS_SKEW = timedelta(minutes=5)    # an agent's `ts` is within this of the kernel's clock
NONCE_TTL = timedelta(minutes=5)        # a nonce's turn ends this long after its first use at the latest
# the violations that hand off at once: every kind but those a rewrite can fix, as the kernel's
IMMEDIATE_HANDOFF = frozenset(get_args(Violation.model_fields["kind"].annotation)) - REWRITABLE
DEMO_AGENTS_PER_COPY_PER_HOUR = 10
DEMO_WALLET = "demo-wallet"
DEMO_MANDATE = {"per_charge_cents": 2_000, "total_cents": 10_000}   # the master's "Agent demo" row
DEMO_MANDATE_LIFE = timedelta(hours=1)


def safe_ref(value: str) -> str | dict[str, Any]:
    """`value` as a ledger summary may hold it (the kernel's `ledger.safe_ref`): a plain identifier as it is, anything
    else as a marker with the first 16 hex characters of its sha256."""
    return value if SAFE_REF.fullmatch(value) else {"invalid": True, "sha256": sha256_hex(value)[:16]}


def agent_payload(desk_slug: str, ts: str, nonce: str, body_sha256: str) -> bytes:
    """What an agent signs: the canonical JSON of `{desk_slug, ts, nonce, body_sha256}` (RFC 8785 for ASCII values)."""
    return canonical({"desk_slug": desk_slug, "ts": ts, "nonce": nonce, "body_sha256": body_sha256}).encode()


def agent_signature(private_key_hex: str, desk_slug: str, ts: str, nonce: str, body_sha256: str) -> str:
    """An agent's Ed25519 signature of one A2A request, in lowercase hex (for tests that play the agent)."""
    key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(private_key_hex))
    return key.sign(agent_payload(desk_slug, ts, nonce, body_sha256)).hex()


def mandate_payload(mandate: Mandate) -> bytes:
    """What the wallet signs: the canonical JSON of the mandate's fields but its signature."""
    return canonical(mandate.model_dump(mode="json", exclude={"sig"})).encode()


def _public_hex(key: Ed25519PrivateKey) -> str:
    return key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()


def _verifies(public_key_hex: str, payload: bytes, sig_hex: str) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key_hex)).verify(bytes.fromhex(sig_hex), payload)
    except (ValueError, InvalidSignature):
        return False
    return True


def parse_signed_time(value: str) -> datetime | None:
    """A `SignedTime` as an aware datetime; None when it isn't one."""
    if not SIGNED_TIME.fullmatch(value):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC)
    except ValueError:
        return None


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
    agent_key_id: str | None = None             # an agent session's key, bound at creation
    mandate_id: str | None = None               # an agent session's verified mandate

    def state(self) -> SessionState:
        return SessionState(session_id=self.session_id, kind=self.kind, verified=self.verified,
                            assurance=self.assurance, mode=self.mode, generation=self.generation)

    def ro_row(self) -> dict:
        return {"session_id": self.session_id, "copy_id": self.copy_id, "desk_id": self.desk_id, "kind": self.kind,
                "verified": self.verified, "assurance": self.assurance, "person_id": self.person_id,
                "agent_key_id": self.agent_key_id, "mandate_id": self.mandate_id,
                "last_language": self.last_language, "mode": self.mode,
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
    created_at: datetime | None = None


@dataclass
class Document:
    document_id: str
    title: str
    record_owner_person_id: str | None
    canary: str
    body: str                                   # ends with the canary, as the kernel's do
    content_type: str | None = "text/plain; charset=utf-8"   # what the kernel serves it as (None: no header)
    disposition: str | None = None              # the kernel's Content-Disposition, if it sends one
    headers: dict[str, str] = field(default_factory=dict)   # any other headers the kernel serves it with


@dataclass
class DocumentLink:
    """A single-use link to a document: its token is only here and in the card's `href`."""

    link_id: str
    token: str
    document_id: str
    desk_id: str
    session_id: str
    expires_at: datetime
    opened_at: datetime | None = None


@dataclass
class PaymentLink:
    """A single-use payment link for a quote: its token is only here and in the card's `href`."""

    link_id: str
    token: str
    copy_id: str
    desk_id: str
    session_id: str
    quote_id: str
    action_id: str
    title: str
    amount_cents: int
    expires_at: datetime
    state: str = "issued"                       # issued, paid, expired or cancelled (no provider, so never unknown)
    cancel_reason: str | None = None            # rules_changed: a rule change cancelled it
    cancelled_by_version: int | None = None
    mandate_id: str | None = None               # purpose-payment reservation, kept while issued
    customer_person_id: str | None = None       # the person a verified visitor's session was when the link was issued

    def ro_row(self) -> dict:
        return {"link_id": self.link_id, "copy_id": self.copy_id, "desk_id": self.desk_id,
                "session_id": self.session_id, "quote_id": self.quote_id, "action_id": self.action_id,
                "amount_cents": self.amount_cents, "state": self.state, "expires_at": self.expires_at}


@dataclass
class VersionRecord:
    """A rules version the owner drafted: its cards (the owner's, then the compiler's default asks), its parent, its
    proof and status, the key a repeat of the same draft finds it by, its money cap (Plan 01b), the tools it enables
    and the profiles it was proved against (`_draft_profiles`)."""

    version: int
    parent: int | None
    cards: list[RuleCard]
    status: str                                 # draft (bounded), proved, rejected, active or superseded
    proof: ProofReport
    key: tuple
    created_at: datetime
    auto_money_cap_cents: int = 0               # the most its auto money cards take or pay out per action
    enables: tuple[ToolPin, ...] = ()
    profiles: tuple[tuple[str, str | None], ...] = ()
    enable_profiles: dict[str, str] = field(default_factory=dict)


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
    timezone: str = RIVERA_TZ.key                                     # the business's
    answering: bool = True
    deleted_at: datetime | None = None                                # `DELETE /desks/{id}`: its routes are closed
    simulated_memory: DeskMemoryRequest | None = None                 # private; never mirrored in fake_kernel_ro
    rivera_seed: bool = False                                         # set only when the original seed is created
    people: dict[str, Person] = field(default_factory=dict)          # by person_id
    documents: dict[str, Document] = field(default_factory=dict)     # by document_id
    prices: dict[str, PriceItem] = field(default_factory=dict)
    slots: dict[str, CalendarSlot] = field(default_factory=dict)
    facts: dict[str, Fact] = field(default_factory=dict)
    tools: dict[str, ToolProfile] = field(default_factory=dict)
    knowledge: dict[str, KnowledgeItem] = field(default_factory=dict)   # by item_id
    knowledge_created_at: dict[str, datetime] = field(default_factory=dict)   # first added; kept on replacement
    cards: list[RuleCard] = field(default_factory=list)
    policy_version: int = 1
    versions: dict[int, VersionRecord] = field(default_factory=dict)   # owner drafts, by version
    seed_enables: tuple[ToolPin, ...] = ()   # the tools the seed's version 1 turned on as it activated (its enables)
    auto_money_cap_cents: int = 0       # the active version's money cap: 0 for a Desk `POST /desks` makes
    notify_now: list[str] = field(default_factory=list)              # event kinds that alert at once
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
    running: bool = False                       # its execution began and hasn't ended (`in_flight`)
    order: int = field(default_factory=lambda: next(_DECISION_ORDER))   # when it was made, among equal `created_at`s


@dataclass
class Challenge:
    """A verification challenge: the code sent to `person_id`'s contact on record for `session_id`."""

    challenge_id: str
    session_id: str
    person_id: str
    code: str
    entry_id: str                               # its Demo inbox entry
    expires_at: datetime
    attempts: int = 0
    status: str = "live"                        # live, consumed, cancelled, expired or failed


@dataclass
class AgentKey:
    """A demo agent's public key; the private key went to the agent once and is kept nowhere."""

    agent_key_id: str
    copy_id: str
    desk_id: str
    public_key_hex: str
    minted_by: str                              # the minting session's ID, or "owner"
    created_at: datetime


@dataclass
class AgentNonce:
    """An agent's nonce: bound at its first use to one session and body hash, for one A2A turn."""

    session_id: str
    body_sha256: str
    first_used_at: datetime
    check_replies: int = 0
    spent_at: datetime | None = None

    def spent(self, now: datetime) -> bool:
        return self.spent_at is not None or now - self.first_used_at >= NONCE_TTL


@dataclass
class MandateRecord:
    """A verified mandate, stored when its agent's session opened, with what it has committed and reserved."""

    mandate: Mandate
    copy_id: str
    session_id: str
    committed_cents: int = 0
    reserved_cents: int = 0

    def ro_row(self) -> dict:
        mandate = self.mandate
        return {"mandate_id": mandate.mandate_id, "copy_id": self.copy_id, "desk_id": mandate.desk_id,
                "agent_key_id": mandate.agent_key_id, "on_behalf_of": mandate.on_behalf_of,
                "per_charge_cents": mandate.per_charge_cents, "total_cents": mandate.total_cents,
                "committed_cents": self.committed_cents, "reserved_cents": self.reserved_cents,
                "expires_at": mandate.expires_at}


@dataclass
class Script:
    """A test's override for one tool: the outcome at /decide and the result at execution."""

    outcome: str | None = None
    exec_state: str = "succeeded"
    model_view: dict | None = None
    facts: list[Fact] | None = None
    inbox: list[InboxNotice] | None = None


@dataclass(frozen=True)
class RecordedStep:
    """One moment of a recorded conversation, replayed at `at` (Plan 01d): the visitor's words (`said`, with `text`);
    a reply of Claude's that passed the check (`replied`, its prose in `text`); a draft the check blocked (`blocked`:
    its `reply` ledger entry alone, no event); or a tool call decided and finished (`booked`: an open slot of the
    copy's, executed; `refused`: a document an unverified visitor may not have; `denied`: a quote at a discount, held
    and denied by the owner)."""

    kind: Literal["said", "replied", "blocked", "booked", "refused", "denied"]
    at: datetime
    text: str | None = None


@dataclass(frozen=True)
class RecordedSession:
    """A recorded conversation: a visitor's or an agent's, its steps in the order they happened."""

    steps: tuple[RecordedStep, ...]
    kind: Literal["visitor", "agent"] = "visitor"


class FakeKernelState:
    """The fake kernel's memory, and the knobs tests turn."""

    def __init__(self, *, ro: FakeRO | None = None, now: datetime | None = None):
        self.now: datetime = now or datetime.now(UTC)
        self.calls: list[FakeCall] = []
        self._ro = ro
        self._dirty: dict[str, dict[tuple, dict]] = {}
        self._gone: dict[str, set[tuple]] = {}         # view -> keys of rows removed since the last flush
        self.copies: dict[str, Copy] = {}
        self.desks: dict[str, Desk] = {}
        self.sessions: dict[str, Session] = {}
        self.decisions: dict[str, DecisionRecord] = {}
        self.handoffs: dict[str, dict] = {}             # handoff_id -> its kernel_ro row
        self.inbox: list[tuple[str, DemoInboxEntry]] = []   # (copy_id, entry): the Demo inbox, oldest first
        self.challenges: dict[str, Challenge] = {}      # challenge_id -> its challenge, codes in memory only
        self.document_links: dict[str, DocumentLink] = {}   # link_id -> its link, tokens in memory only
        self.payment_links: dict[str, PaymentLink] = {}     # link_id -> its link, tokens in memory only
        self.quotes: dict[str, dict] = {}               # quote_id -> its kernel_ro row
        self.bookings: dict[str, dict] = {}             # booking_id -> its Desk, session, action and status
        self._by_call: dict[tuple[str, int, str], str] = {}   # (session_id, generation, call_id) -> decision_id
        self._token_hashes: dict[str, str] = {}        # sha256(token) -> session_id
        self._failures: dict[str, list] = {}           # route -> [kind, times left or None]
        self._drops: dict[str, int] = {}
        self._scripts: dict[str, Script] = {}
        self._forced: list[str] = []                   # violation kinds the next reply checks carry
        self._soft_checks: list[str] = []             # scripted soft-check tries, one per reply check that reaches it
        self._in_flight: dict[str, int] = {}           # tool -> executions left that find themselves running
        self._args: dict[str, dict] = {}                # action_id -> the call's args, as the action row binds them
        self.agent_keys: dict[str, AgentKey] = {}       # agent_key_id -> its public key
        self.nonces: dict[tuple[str, str], AgentNonce] = {}   # (agent_key_id, nonce) -> its binding
        self.wallets: dict[str, Ed25519PrivateKey] = {}  # copy_id -> its demo wallet's key, made on first use
        self.mandates: dict[str, MandateRecord] = {}    # mandate_id -> the verified mandate
        self.mandate_nonces: set[tuple[str, str]] = set()   # (copy_id, nonce) of the mandates sessions used
        self.minted: list[tuple[str, datetime]] = []    # (copy_id, when) of each demo agent minted
        self.replayed_nights: dict[str, tuple[str, list[ReplayedEvent]]] = {}   # copy_id -> (replay_id, its events)
        self._night: tuple[RecordedSession, ...] = ()   # what `POST /copies` replays when asked (`record_night`)
        self._replaying: tuple[str, datetime] | None = None   # (replay_id, the real time) while a replay writes
        self._no_seeded_night = False                   # `without_seeded_night`: any replay_night is 422
        self._proofs: list[list] = []                   # [ProofReport, drafts left or None]: the next drafts' proofs
        self._gates: dict[str, asyncio.Event] = {}      # route -> the event its calls wait for (`gate`)
        self._route = ""                                # the route template of the call being answered (`_refused`)

    # Knobs ---------------------------------------------------------------------------------------

    def fail(self, route: str, kind: str | None, *, times: int | None = None) -> None:
        """Fail the route's next `times` calls (every call when None) with `"timeout"`, `"connect"` (no
        answer), `"500"` (`internal`), `"422"` (`invalid`) or `"409"` (`conflict`), before anything changes;
        `kind=None` heals it."""
        if kind not in (None, "timeout", "connect", *FAILURE_CODES):
            raise ValueError(f"unknown failure {kind!r}")
        for key in route_keys(route):
            if kind is None:
                self._failures.pop(key, None)
            else:
                self._failures[key] = [kind, times]

    def record_night(self, *sessions: RecordedSession) -> None:
        """The recording `POST /copies` replays into each copy that asks (`replay_night: true`), as Plan 01d's kernel
        replays its shipped one: with none recorded, a copy that asks gets live data only."""
        if any(not session.steps or list(session.steps) != sorted(session.steps, key=lambda step: step.at)
               for session in sessions):
            raise ValueError("a recorded session has steps, in the order they happened")
        self._night = sessions

    def without_seeded_night(self) -> None:
        """The kernel predates the seeded night: its copy request has no `replay_night` and refuses unknown fields
        (`extra="forbid"`), so a body that carries it, true or false, is 422 `invalid` and nothing is created; a body
        without it makes a live copy."""
        self._no_seeded_night = True

    def drop_response(self, route: str, *, times: int = 1) -> None:
        """The route's next `times` calls change state and commit, then time out instead of answering."""
        for key in route_keys(route):
            self._drops[key] = times

    def gate(self, route: str) -> asyncio.Event:
        """Hold the route's calls, once received and recorded and before any failure or change, until the returned
        event is set: a slow proof, say. A `fail` set while a call waits applies to it."""
        event = asyncio.Event()
        for key in route_keys(route):
            self._gates[key] = event
        return event

    def proof(self, *, ok: bool = True, method: str = "symcc", timed_out: bool = False,
              times: int | None = None) -> None:
        """The proof of the next `times` drafts (every later draft's when None; `proof_report`): `ok=False` and
        `timed_out` reject the draft, and `method="bounded"` leaves it `draft`, which no confirm activates."""
        self._proofs.append([proof_report(ok=ok, method=method, timed_out=timed_out), times])

    def _next_proof(self) -> ProofReport:
        if not self._proofs:
            return proof_report()
        entry = self._proofs[0]
        report, left = entry
        if left is not None:
            if left <= 1:
                self._proofs.pop(0)
            else:
                entry[1] = left - 1
        return report

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
        self._mark_verified(session, desk, desk.person(person_ref))
        self.append(desk, "verify", {"session_id": session_id, "verified": True}, session_id=session_id)
        self.flush()
        return session.state()

    def _mark_verified(self, session: Session, desk: Desk, person: Person) -> None:
        """The session is now `person`'s (assurance `demo_code`, generation unchanged), and the facts it made so far
        are theirs too: `person:<id>` joins their readers."""
        session.verified, session.assurance, session.person_id = True, "demo_code", person.person_id
        for fact in list(desk.facts.values()):
            readers = fact.label.readers
            if f"session:{session.session_id}" in readers and f"person:{person.person_id}" not in readers:
                label = Label(readers=[*readers, f"person:{person.person_id}"], record_owner=person.person_id)
                self._put_fact(desk, fact.model_copy(update={"label": label}))
        self._put_session(session)

    def owner_verdict(self, session_id: str, text: str) -> ReplyVerdict:
        """The verdict an owner's say gets, as `POST /owner/messages` answers it (`_owner_say`), for a test that
        delivers a say without the take-over routes."""
        session = self.sessions[session_id]
        verdict = self._owner_say(session, self.desks[session.desk_id], text, new_id("msg"))
        self.flush()
        return verdict

    def script(self, tool: str, outcome: str | None = None, exec_state: str = "succeeded",
               model_view: dict | None = None, facts: list[Fact] | None = None,
               inbox: list[InboxNotice] | None = None) -> None:
        """Override the tool from now on: `outcome` (`allow`, `hold`, `refuse`; None keeps the seed's rule) for a
        call that normalizes, and the execution's state, `model_view`, facts and Demo inbox notices (None keeps the
        tool's own)."""
        if outcome not in (None, "allow", "hold", "refuse") or exec_state not in ("succeeded", "failed", "unknown"):
            raise ValueError("unknown outcome or execution state")
        self._scripts[tool] = Script(outcome, exec_state, model_view, facts, inbox)

    def never(self, desk_id: str, tool: str) -> None:
        """The owner confirms a `never` card for `tool` for anyone (a new active policy version, ledgered `policy`):
        new calls of it are refused, and approving one of its held requests fails the re-check inside the answer
        call (`refused_at_execution`, "rules changed"), as `/policy/draft` and `/policy/confirm` would leave it."""
        desk = self.desks[desk_id]
        parent = desk.policy_version
        self._supersede_active(desk)
        desk.cards = [*desk.cards, _card(f"never-{tool}", tool, "never", "anyone", "You said never for this.")]
        desk.policy_version = self._next_version(desk)
        self._put_policy(desk, parent_version=parent)
        self.append(desk, "policy", {"version": desk.policy_version, "activated": True})
        self.flush()

    def lower_link_limit(self, desk_id: str, max_amount_cents: int) -> list[str]:
        """The owner confirms `rv-link` at a lower limit (a new active policy version, ledgered `policy`), and the
        activation cancels the Desk's open auto-allowed links above it: `cancelled`, `cancel_reason` `rules_changed`,
        their facts expired, each ledgered `payment` `{link_id, state, reason, version}` after the activation's entry
        (master "Cancellation at activation"). Owner-approved links stay valid. Returns the cancelled links' IDs."""
        desk = self.desks[desk_id]
        parent = desk.policy_version
        self._supersede_active(desk)
        desk.cards = [card.model_copy(update={"max_amount_cents": max_amount_cents}) if card.card_id == "rv-link"
                      else card for card in desk.cards]
        desk.policy_version = self._next_version(desk)
        self._put_policy(desk, parent_version=parent)
        self.append(desk, "policy", {"version": desk.policy_version, "activated": True})
        cancelled = self._cancel_disallowed_links(desk)
        self.flush()
        return cancelled

    def reconcile(self, decision_id: str, exec_state: str = "succeeded") -> Decision:
        """The kernel reconciles an `unknown` execution by its idempotency key (at startup, or on a read 30 s on):
        it ran (`succeeded` → `executed`) or it didn't (`failed`); ledgered, re-signed and mirrored."""
        record = self.decisions[decision_id]
        if record.decision.state != "unknown" or exec_state not in ("succeeded", "failed"):
            raise ValueError("only an unknown execution is reconciled, as succeeded or failed")
        record.result = record.result.model_copy(update={"state": exec_state})
        decision = self._transition(record, "executed" if exec_state == "succeeded" else "failed", kind="execute",
                                    reconciled=True)
        self.flush()
        return decision

    def in_flight(self, tool: str, *, times: int = 1) -> None:
        """The tool's next `times` executions are already running when `/execute` arrives, as when another request
        began them (the kernel holds their intent row): `/execute` answers 409 `conflict`, as the kernel does for
        every call while an execution runs (it has no stored result yet), and the decision reads `allowed`, never
        expiring, until `finish` ends it."""
        if tool not in TOOL_NAMES or times < 1:
            raise ValueError("a known tool, at least once")
        self._in_flight[tool] = times

    def finish(self, decision_id: str, exec_state: str = "succeeded") -> Decision:
        """End an execution `in_flight` left running, as `succeeded`, `failed` or `unknown`: its result is stored,
        and the decision moves on (ledgered, re-signed and mirrored)."""
        record = self.decisions[decision_id]
        if not record.running or exec_state not in ("succeeded", "failed", "unknown"):
            raise ValueError("only a running execution finishes, as succeeded, failed or unknown")
        record.running = False
        self._run(record, self.sessions[record.decision.session_id], exec_state=exec_state)
        self.flush()
        return record.decision

    def _take_in_flight(self, tool: str) -> bool:
        left = self._in_flight.get(tool, 0)
        if left <= 0:
            return False
        self._in_flight[tool] = left - 1
        return True

    def _never(self, desk: Desk, tool: str) -> bool:
        return any(card.mode == "never" and card.applies_to == tool for card in desk.cards)

    def violation(self, kind: str, *, times: int = 1) -> None:
        """The next `times` reply checks carry a `kind` violation (any `Violation.kind`, `canary` included)."""
        Violation(kind=kind, span="", rule_id="fake")           # refuses an unknown kind
        self._forced.extend([kind] * times)

    def soft_checks(self, *results: str) -> None:
        """Stage the soft check's tries, one for each later reply check that reaches it (clean prose, as the kernel's
        step 5 runs it): `pass`, `flag` (`soft.promise`), `denies_ai` (`soft.denies_ai`), or a try with no verdict,
        `error`, `timeout`, `unparsable` or `refusal`, which is `check_unavailable` (`soft.unavailable`) with no
        recheck inside the check, as the kernel's one try; a first attempt blocked by it is rewritable, and the final
        check reads its own staged try. A check with nothing staged passes."""
        if any(result not in {"pass", "flag", "denies_ai", "error", "timeout", "unparsable", "refusal"}
               for result in results):
            raise ValueError("unknown soft-check result")
        self._soft_checks.extend(results)

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
        self._gone.get(view, set()).discard(key)
        self._dirty.setdefault(view, {})[key] = row

    def _drop(self, view: str, key: tuple) -> None:
        self._dirty.get(view, {}).pop(key, None)
        self._gone.setdefault(view, set()).add(key)

    def flush(self) -> None:
        """Write every row that changed to fake_kernel_ro, and remove every row that went (when the state has one)."""
        dirty, self._dirty = self._dirty, {}
        gone, self._gone = self._gone, {}
        if self._ro is not None and any(gone.values()):
            self._ro.delete({view: sorted(keys) for view, keys in gone.items() if keys})
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

    def _put_business(self, desk: Desk) -> None:
        self._put("businesses", (desk.business_id,), {
            "business_id": desk.business_id, "copy_id": desk.copy_id, "name": desk.business_name,
            "owner_display_name": desk.owner_display_name, "timezone": desk.timezone, "brand": desk.brand})

    def _put_desk(self, desk: Desk) -> None:
        self._put("desks", (desk.desk_id,), {
            "desk_id": desk.desk_id, "copy_id": desk.copy_id, "business_id": desk.business_id, "name": desk.name,
            "slug": desk.slug, "hours": [window.model_dump(mode="json") for window in desk.hours],
            "answering": desk.answering, "created_at": desk.created_at})

    def _put_policy(self, desk: Desk, *, status: str = "active", parent_version: int | None = None) -> None:
        cards = [card.model_dump(mode="json") for card in desk.cards]
        self._put("policy_versions", (desk.desk_id, desk.policy_version), {
            "copy_id": desk.copy_id, "desk_id": desk.desk_id, "version": desk.policy_version,
            "parent_version": parent_version, "cards": cards, "status": status,
            "proof": {"ok": True, "method": "symcc", "cases": None, "timed_out": False, "checks": []},
            "cedar_sha256": sha256_hex(canonical(cards)), "schema_sha256": sha256_hex("schema"),
            "baseline_sha256": sha256_hex("baseline"),
            "profiles_sha256": sha256_hex(canonical(sorted(desk.tools))), "invariants_sha256": sha256_hex("invariants"),
            "review_thresholds_version": 1, "auto_money_cap_cents": desk.auto_money_cap_cents,
            "created_at": desk.created_at})

    def _put_version(self, desk: Desk, record: VersionRecord) -> None:
        version = self._policy_version(desk, record)
        self._put("policy_versions", (desk.desk_id, record.version), {
            **version.model_dump(mode="json", include={"desk_id", "version", "cards", "status", "proof", "cedar_sha256",
                                                       "schema_sha256", "baseline_sha256", "profiles_sha256",
                                                       "invariants_sha256", "review_thresholds_version",
                                                       "auto_money_cap_cents"}),
            "copy_id": desk.copy_id, "parent_version": record.parent, "created_at": record.created_at})

    def _policy_version(self, desk: Desk, record: VersionRecord) -> PolicyVersion:
        cards = [card.model_dump(mode="json") for card in record.cards]
        return PolicyVersion(desk_id=desk.desk_id, version=record.version, parent_version=record.parent,
                             cards=record.cards, cedar_sha256=sha256_hex(canonical(cards)),
                             schema_sha256=sha256_hex("schema"), baseline_sha256=sha256_hex("baseline"),
                             profiles_sha256=sha256_hex(canonical(list(record.profiles))),
                             invariants_sha256=sha256_hex("invariants"), review_thresholds_version=1,
                             auto_money_cap_cents=record.auto_money_cap_cents, status=record.status, proof=record.proof)

    def _supersede_active(self, desk: Desk) -> None:
        """The active version's row becomes `superseded`, as an activation leaves it."""
        record = desk.versions.get(desk.policy_version)
        if record is None:
            self._put_policy(desk, status="superseded")
        else:
            record.status = "superseded"
            self._put_version(desk, record)

    @staticmethod
    def _next_version(desk: Desk) -> int:
        return max(desk.policy_version, *desk.versions) + 1 if desk.versions else desk.policy_version + 1

    def _put_tool(self, desk: Desk, profile: ToolProfile) -> None:
        desk.tools[profile.tool] = profile
        self._put("tools", (desk.desk_id, profile.tool), {
            "copy_id": desk.copy_id, "desk_id": desk.desk_id, "tool": profile.tool, "source": profile.source,
            "effects": profile.effects, "reversible": profile.reversible, "status": profile.status,
            "description_confirmed": profile.description_confirmed, "definition_sha256": profile.definition_sha256,
            "pending_definition_text": profile.pending_definition_text, "pending_sha256": profile.pending_sha256,
            "review_reason": profile.review_reason,
            "business": profile.business.model_dump(mode="json") if profile.business is not None else None})

    def append(self, desk: Desk, kind: str, summary: dict, *, origin: str = "kernel", session_id: str | None = None,
               ref_id: str | None = None) -> LedgerEntry:
        """Append a hashed, chained entry to the Desk's ledger, signed the fake way. While a replay writes, the entry
        is appended at the real time and marked `summary.replayed` with the time it happened (the clock's, moved
        back to the recorded moment) and the recording, as only the kernel's replay marks an entry (Plan 01d)."""
        appended_at = self.now
        if self._replaying is not None:
            recording, appended_at = self._replaying
            summary = {**summary, "replayed": {"at": signed_time(self.now), "recording": recording}}
        event = LedgerEvent(kind=kind, origin=origin, session_id=session_id, ref_id=ref_id, summary=summary)
        envelope = {"copy_id": desk.copy_id, "desk_id": desk.desk_id, "seq": len(desk.ledger) + 1,
                    "prev_hash": desk.ledger[-1].hash if desk.ledger else GENESIS,
                    "created_at": signed_time(appended_at), "event": event.model_dump(mode="json")}
        digest = sha256_hex(canonical(envelope))
        entry = LedgerEntry(**{**envelope, "event": event}, hash=digest, key_id=KEY_ID,
                            signature="fake:" + sha256_hex(b"desk-ledger-v1\0" + bytes.fromhex(digest)))
        desk.ledger.append(entry)
        self._put("ledger_entries", (desk.desk_id, entry.seq), {
            **envelope, "hash": entry.hash, "signature": entry.signature, "key_id": entry.key_id})
        return entry

    # The Turner seed -----------------------------------------------------------------------------

    def _seed_rivera(self, copy_id: str) -> Desk:
        business = BusinessSeed(name="Turner Plumbing", owner_display_name="Mike Turner", timezone=RIVERA_TZ.key,
                                brand={"palette": "teal", **BRAND_PALETTE["teal"]})
        seed = DeskSeed(
            name="Main line", charter=list(RIVERA_CHARTER), hours=list(RIVERA_HOURS), price_items=list(RIVERA_PRICES),
            calendar_slots=rivera_slots(self.now),
            people=[SeedPerson(ref=ref, display_name=name, contact=contact) for ref, name, contact in RIVERA_PEOPLE],
            documents=[SeedDocument(ref=ref, title=title, body=body, record_owner_ref=owner_ref)
                       for ref, title, owner_ref, body in RIVERA_DOCUMENTS],
            notifications=NotificationDefaults(**NOTIFICATIONS), connections=["mock_payments"],
            auto_money_cap_cents=RIVERA_MONEY_CAP_CENTS)
        desk = self._create_desk(copy_id, business, seed, tools=tuple(TOOL_FACTS), cards=RIVERA_CARDS)
        desk.rivera_seed = True
        for lang, questions in RIVERA_STARTERS.items():
            for n, question in enumerate(questions, start=1):
                key = f"{STARTER_KEY}{n}:{lang}"
                self._put_fact(desk, Fact(fact_id=f"charter:{key}", kind="charter", status="available",
                                          source="kernel", claims=[Claim(key=key, kind="text", value=question)],
                                          label=Label(readers=["public"])))
        for index, item in enumerate(RIVERA_KNOWLEDGE):
            # Preserve insertion order without moving the shared clock used by other fake activity.
            self._store_knowledge(desk, item.model_copy(deep=True),
                                  created_at=self.now + timedelta(microseconds=index))
        self._seed_business_tools(desk, RIVERA_BUSINESS_TOOLS)
        return desk

    def _seed_business_tools(self, desk: Desk, business_tools: list[dict]) -> None:
        """The seed's business tools as the kernel writes them: through the owner's replacement (ledgered
        `business_tools`, each "new"), then turned on by version 1 as it activates (its `enables`, the version's row
        written again over them, and a `tool_pin` "enabled" entry for each, naming version 1 and the pin)."""
        from desk.contracts import BusinessTool, BusinessToolDef
        from desk.kernel_service.adapters.blocks import profile as block_profile

        profiles = [block_profile(tool.tool, BusinessToolDef.model_validate(tool.model_dump(exclude={"tool"})))
                    for tool in map(BusinessTool.model_validate, business_tools)]
        self.append(desk, "business_tools", {"tools": [
            {"tool": profile.tool, "block": profile.business.config.block,
             "definition_sha256": profile.definition_sha256, "change": "new"} for profile in profiles]})
        for profile in profiles:
            self._put_tool(desk, profile.model_copy(update={"status": "enabled", "review_reason": None}))
        desk.seed_enables = tuple(ToolPin(tool=profile.tool, definition_sha256=profile.definition_sha256)
                                  for profile in profiles)
        self._put_policy(desk)
        for pin in desk.seed_enables:
            self.append(desk, "tool_pin", {"tool": pin.tool, "event": "enabled", "version": desk.policy_version,
                                           "definition_sha256": pin.definition_sha256})

    def _create_desk(self, copy_id: str, business: BusinessSeed, seed: DeskSeed, *, tools: tuple[str, ...],
                     cards: list[RuleCard]) -> Desk:
        """The one `DeskSeed` path (`POST /copies` and `POST /desks`): the business (or an existing one of the copy),
        the Desk, its people, documents (each body ending with a fresh canary, its fact naming only the title), prices,
        slots, notification prefs, `tools` rows, the active policy version of `cards`, the charter facts, the
        `charter:hours` fact and a `desk_data` entry."""
        if business.existing_business_id is not None:
            existing = next((desk for desk in self.desks.values() if desk.copy_id == copy_id
                             and desk.business_id == business.existing_business_id), None)
            if existing is None:
                raise Refusal(404, "not_found")
            business = BusinessSeed(name=existing.business_name, owner_display_name=existing.owner_display_name,
                                    timezone=existing.timezone, brand=existing.brand,
                                    existing_business_id=existing.business_id)
        suffix = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(6))
        desk = Desk(desk_id=new_id("desk"), copy_id=copy_id, business_id=business.existing_business_id or new_id("biz"),
                    business_name=business.name, owner_display_name=business.owner_display_name,
                    brand=stored_brand(business.brand), timezone=business.timezone, name=seed.name,
                    slug=f"{slugify(business.name)}-{suffix}", hours=list(seed.hours), created_at=self.now,
                    auto_money_cap_cents=seed.auto_money_cap_cents)
        self.desks[desk.desk_id] = desk
        ids = {"copy_id": copy_id, "desk_id": desk.desk_id}
        if business.existing_business_id is None:
            self._put_business(desk)
        self._put_desk(desk)
        for seeded in seed.people:
            person = Person(person_id=new_id("person"), ref=seeded.ref, display_name=seeded.display_name,
                            contact=seeded.contact, created_at=self.now)
            desk.people[person.person_id] = person
            self._put("people", (person.person_id,), {
                "person_id": person.person_id, **ids, "display_name": seeded.display_name,
                "masked_contact": mask_contact(seeded.contact), "notes": seeded.notes, "created_at": self.now})
        for seeded in seed.documents:
            self._add_document(desk, seeded)
        for item in seed.price_items:
            desk.prices[item.item_id] = item
            self._put("price_items", (desk.desk_id, item.item_id), {**item.model_dump(), **ids})
        for slot in seed.calendar_slots:
            desk.slots[slot.slot_id] = slot
            self._put("calendar_slots", (desk.desk_id, slot.slot_id), {**slot.model_dump(), **ids})
        desk.notify_now = list(seed.notifications.now)
        self._put("notification_prefs", (desk.desk_id,), {**ids, **seed.notifications.model_dump()})
        for tool in tools:
            self._put_tool(desk, tool_profile(tool))
        desk.cards = list(cards)
        self._put_policy(desk)
        for claim in seed.charter:
            self._put_fact(desk, Fact(fact_id=f"charter:{claim.key}", kind="charter", status="available",
                                      source="kernel", claims=[claim], label=Label(readers=["public"])))
        self._put_hours(desk)
        self.append(desk, "desk_data", {"part": "desk", "created": True})
        return desk

    def _add_document(self, desk: Desk, seeded: SeedDocument) -> Document:
        """The seed path's document writer: the body ends with a fresh canary and stays here; the `document:<id>`
        fact names only the title, readable by the owner and the record owner, if there is one."""
        owner = desk.person(seeded.record_owner_ref) if seeded.record_owner_ref is not None else None
        owner_id = owner.person_id if owner is not None else None
        canary = "cdk-" + secrets.token_hex(8)
        document = Document(document_id=new_id("doc"), title=seeded.title, record_owner_person_id=owner_id,
                            canary=canary, body=seeded.body + canary)
        desk.documents[document.document_id] = document
        self._put("documents", (document.document_id,), {
            "document_id": document.document_id, "copy_id": desk.copy_id, "desk_id": desk.desk_id,
            "title": seeded.title, "record_owner_person_id": owner_id, "created_at": self.now})
        self._put_fact(desk, Fact(fact_id=f"document:{document.document_id}", kind="document", status="available",
                                  source="kernel", claims=[Claim(key="title", kind="text", value=seeded.title)],
                                  label=Label(readers=["owner", *([f"person:{owner_id}"] if owner_id else [])],
                                              record_owner=owner_id)))
        return document

    def _put_hours(self, desk: Desk) -> None:
        windows = canonical([window.model_dump(mode="json") for window in desk.hours])
        self._put_fact(desk, Fact(fact_id="charter:hours", kind="charter", status="available", source="kernel",
                                  claims=[Claim(key="windows", kind="text", value=windows)],
                                  label=Label(readers=["public"])))

    def _seed_held_request(self, desk: Desk) -> Decision:
        """A seeded visitor's quote for drain clearing at 15% off, decided like any call: a signed hold."""
        session, _ = self._new_session(desk.copy_id, desk.desk_id, "visitor")   # its token is discarded
        self.append(desk, "session", {"session_id": session.session_id, "kind": "visitor", "preview": False},
                    session_id=session.session_id)
        call = ToolCall(call_id="seed-held-quote", tool="native.quote",
                        args={"items": [{"item_id": "drain", "qty": 1}], "requested_discount_bp": 1500})
        action = self._normalize(session, desk, call)
        outcome, card_ids, baseline = self._rule(session, desk, action)
        digest = sha256_hex(canonical({"desk_id": None, "tool": call.tool, "args": call.args}))
        return self._new_decision(session, desk, call, digest, action, outcome, card_ids, baseline=baseline)

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

    def session_call(self, request: Request, session_id: str, desk_id: str | None = None, *,
                     seen: bool = True) -> tuple[Session, Desk]:
        """The first three "Session state responses" rows for a call naming `session_id`: the session token must
        hash to it, or an agent's signature authenticate it (401); an owner names its own session and a `desk_id` of
        its copy (else 404); closed is 409. Without `seen` the call doesn't count as the session's activity
        (`_check_open`)."""
        if self._signed_by_agent(request):
            session = self._agent(request, session_id)
            if desk_id is not None:
                raise Refusal(422, "invalid")   # desk_id is for owner sessions only
            self._check_open(session, seen=seen)
            return session, self.desks[session.desk_id]
        if request.headers.get("x-owner-session") is not None:
            copy, owner = self.owner_of(request)
            if desk_id is None:
                raise Refusal(422, "invalid")
            if desk_id not in copy.desk_ids or session_id != owner.session_id:
                raise Refusal(404, "not_found")
            if self.desks[desk_id].deleted_at is not None:
                raise self._refused(self.desks[desk_id], 409, "closed", "closed", session_id=owner.session_id)
            return owner, self.desks[desk_id]
        session = self.visitor_of(request)
        if session.session_id != session_id:
            raise Refusal(401, "auth")
        if desk_id is not None:
            raise Refusal(422, "invalid")       # desk_id is for owner sessions only
        self._check_open(session, seen=seen)
        return session, self.desks[session.desk_id]

    # Agents ----------------------------------------------------------------------------------------

    @staticmethod
    def _signed_by_agent(request: Request) -> bool:
        return any(name in request.headers for name in AGENT_HEADERS)

    def _refused(self, desk: Desk | None, status: int, code: str, reason: str, *, session_id: str | None = None,
                 kind: str = "auth", **extra: Any) -> Refusal:
        """A refusal the kernel ledgers (its `auth.AuthError`): a `kind` entry `{route, reason, **extra}` naming
        `session_id` on `desk`, the Desk the call named (none when it names no Desk, as the kernel logs it instead),
        then the refusal to raise. The route is the call's template, never its path, which may hold a token."""
        if desk is not None:
            self.append(desk, kind, {"route": self._route, "reason": reason, **extra}, session_id=session_id)
        return Refusal(status, code)

    def _agent_refused(self, desk: Desk | None, reason: str, session_id: str | None = None, *,
                       key_id: str | None = None, status: int = 401, code: str = "auth") -> Refusal:
        """A refused agent signature, key, nonce or mandate (the kernel's `agents.AgentAuthError`): 401 `auth`, or 409
        `replayed` for a spent turn's own call, ledgered `agent_auth {route, reason, agent_key_id}` on the Desk it
        named, never a signature, nonce or key."""
        extra = {} if key_id is None else {"agent_key_id": safe_ref(key_id)}
        return self._refused(desk, status, code, reason, session_id=session_id, kind="agent_auth", **extra)

    def _signature(self, request: Request, desk: Desk, session_id: str | None, *,
                   session_key_id: str | None = None) -> tuple[AgentKey, str, str]:
        """The request's agent key, nonce and body hash, once its signature checks out for `desk`'s slug, in the
        kernel's order: every header present and in form (`unsigned` without any, else `malformed`), a key of the
        copy (`unknown_key`), an Ed25519 signature over `{desk_slug, ts, nonce, body_sha256}` (`bad_signature`), `ts`
        within 5 minutes (`stale_timestamp`), and the key the session was opened with (`session_key_id`, else
        `wrong_key`) or, opening one, a key minted for this Desk (`wrong_desk`); else 401, ledgered."""
        if not self._signed_by_agent(request):
            raise self._agent_refused(desk, "unsigned", session_id)
        key_id, ts, nonce, sig, body_sha256 = (request.headers.get(name) or "" for name in AGENT_HEADERS)
        if not (AGENT_KEY_ID.fullmatch(key_id) and AGENT_NONCE.fullmatch(nonce) and AGENT_SIG.fullmatch(sig)
                and SHA256_HEX.fullmatch(body_sha256) and parse_signed_time(ts) is not None):
            raise self._agent_refused(desk, "malformed", session_id, key_id=key_id or None)
        key = self.agent_keys.get(key_id)
        if key is None or key.copy_id != desk.copy_id:
            raise self._agent_refused(desk, "unknown_key", session_id, key_id=key_id)
        if not _verifies(key.public_key_hex, agent_payload(desk.slug, ts, nonce, body_sha256), sig):
            raise self._agent_refused(desk, "bad_signature", session_id, key_id=key_id)
        if abs(self.now - parse_signed_time(ts)) > AGENT_TS_SKEW:
            raise self._agent_refused(desk, "stale_timestamp", session_id, key_id=key_id)
        if session_key_id is None and key.desk_id != desk.desk_id:
            raise self._agent_refused(desk, "wrong_desk", session_id, key_id=key_id)
        if session_key_id is not None and not hmac.compare_digest(session_key_id, key.agent_key_id):
            raise self._agent_refused(desk, "wrong_key", session_id, key_id=key_id)
        return key, nonce, body_sha256

    def _agent(self, request: Request, session_id: str) -> Session:
        """The agent session `session_id`, for a request its key signed: the key must be the one bound to the session
        at creation (else 401, ledgered), and the nonce is bound to this session and body hash at its first use; once
        its turn is over the same request is 409 `replayed`, and any other use of it 401. The nonce is kept on the
        request for the reply check, which ends its turn. A signature naming a session that isn't an agent's is the
        wrong credential for it (`auth` `bad_token`); one naming no session, or the owner's, has no Desk to go on."""
        session = self.sessions.get(session_id)
        desk = self.desks.get(session.desk_id) if session is not None and session.desk_id else None
        if session is None or desk is None:
            raise Refusal(401, "auth")
        if session.kind != "agent":
            raise self._refused(desk, 401, "auth", "bad_token", session_id=session_id)
        key, nonce, body_sha256 = self._signature(request, desk, session_id,
                                                  session_key_id=session.agent_key_id or "")
        bound = self.nonces.get((key.agent_key_id, nonce))
        if bound is None:
            bound = self.nonces[(key.agent_key_id, nonce)] = AgentNonce(
                session_id=session_id, body_sha256=body_sha256, first_used_at=self.now)
        elif (bound.session_id, bound.body_sha256) != (session_id, body_sha256):
            raise self._agent_refused(desk, "nonce_reused", session_id, key_id=key.agent_key_id)
        elif bound.spent(self.now):
            raise self._agent_refused(desk, "replayed", session_id, key_id=key.agent_key_id, status=409,
                                      code="replayed")
        request.state.agent_nonce = bound
        return session

    def _end_agent_turn(self, request: Request, verdict: ReplyVerdict, *, final: bool = False) -> None:
        """A reply check ends its nonce's turn when it passes, hands off at once, was sent with `final: true` (so its
        handoff is shown and nothing rewrites it), or is the turn's second check."""
        nonce: AgentNonce = request.state.agent_nonce
        nonce.check_replies += 1
        immediate = {violation.kind for violation in verdict.violations} & IMMEDIATE_HANDOFF
        if verdict.ok or immediate or final or nonce.check_replies >= 2:
            nonce.spent_at = self.now

    def _check_mandate(self, desk: Desk, key: AgentKey, mandate: Mandate) -> None:
        """A mandate a session opens with, in the kernel's order: issued by this copy's demo wallet, which signed it as
        it stands, for this agent's key and this Desk, not expired, within its own limits and not used before; else
        401, ledgered with the reason."""
        def refused(reason: str) -> Refusal:
            return self._agent_refused(desk, reason, key_id=key.agent_key_id)

        wallet = self.wallets.get(desk.copy_id)
        if mandate.issuer != DEMO_WALLET or wallet is None:
            raise refused("mandate_issuer")
        if not _verifies(_public_hex(wallet), mandate_payload(mandate), mandate.sig):
            raise refused("mandate_signature")
        if mandate.agent_key_id != key.agent_key_id:
            raise refused("mandate_key")
        if mandate.desk_id != desk.desk_id:
            raise refused("mandate_audience")
        expires_at = parse_signed_time(mandate.expires_at)
        if expires_at is None or expires_at <= self.now:
            raise refused("mandate_expired")
        if not 1 <= mandate.per_charge_cents <= min(mandate.total_cents, AUTO_MONEY_HARD_CAP_CENTS):
            raise refused("mandate_limits")
        if (desk.copy_id, mandate.nonce) in self.mandate_nonces:
            raise refused("mandate_reused")

    def _open_agent_session(self, request: Request, body: CreateSessionRequest, desk: Desk) -> SessionCreated:
        """An agent's `POST /sessions`, by signature alone: a nonce bound or spent with the same body hash returns
        its bound session (nothing created, the mandate not used again); otherwise the mandate, if any, is checked
        and stored, and the new session is bound to the key and the nonce. A refusal is ledgered on the Desk, naming
        no session."""
        key, nonce, body_sha256 = self._signature(request, desk, None)
        if desk.deleted_at is not None:                 # a resent opening too: its session closed with the Desk
            raise self._refused(desk, 409, "closed", "closed")
        bound = self.nonces.get((key.agent_key_id, nonce))
        if bound is not None:
            session = self.sessions[bound.session_id]
            if bound.body_sha256 != body_sha256 or session.desk_id != desk.desk_id:
                raise self._agent_refused(desk, "nonce_reused", key_id=key.agent_key_id)
            if bound.spent(self.now):
                self.append(desk, "agent_auth", {"resent_opening": True}, session_id=session.session_id)
            return SessionCreated(state=session.state(), session_token=None)
        if body.mandate is not None:
            self._check_mandate(desk, key, body.mandate)
        session = Session(session_id=secrets.token_urlsafe(16), copy_id=desk.copy_id, desk_id=desk.desk_id,
                          kind="agent", secret_hash=None, created_at=self.now, last_seen=self.now,
                          agent_key_id=key.agent_key_id)
        self.sessions[session.session_id] = session
        if body.mandate is not None:
            self.mandate_nonces.add((desk.copy_id, body.mandate.nonce))
            record = self.mandates[body.mandate.mandate_id] = MandateRecord(
                mandate=body.mandate, copy_id=desk.copy_id, session_id=session.session_id)
            session.mandate_id = body.mandate.mandate_id
            self._put("mandates", (record.mandate.mandate_id,), record.ro_row())
        self.nonces[(key.agent_key_id, nonce)] = AgentNonce(session_id=session.session_id, body_sha256=body_sha256,
                                                            first_used_at=self.now)
        self._put_session(session)
        self.append(desk, "session", {"session_id": session.session_id, "kind": "agent", "preview": False,
                                      "agent_key_id": key.agent_key_id, "mandate_id": session.mandate_id},
                    session_id=session.session_id)
        return SessionCreated(state=session.state(), session_token=None)

    def _remaining(self, session: Session) -> int | None:
        """What the session's mandate may still charge at once: `min(per charge, total - committed - reserved)`;
        None (no room at all) without a mandate, once it has expired, or for another Desk."""
        record = self.mandates.get(session.mandate_id) if session.mandate_id else None
        if record is None:
            return None
        mandate = record.mandate
        expires_at = parse_signed_time(mandate.expires_at)
        if (expires_at is None or self.now >= expires_at or mandate.desk_id != session.desk_id
                or "charge" not in mandate.allowed_effects):
            return None
        return min(mandate.per_charge_cents, mandate.total_cents - record.committed_cents - record.reserved_cents)

    def _room_for(self, session: Session, action: NormalizedAction) -> bool:
        """Whether a mandate charge still fits its mandate at execution (two calls racing for the last room)."""
        remaining = self._remaining(session)
        return remaining is not None and action.amount_cents is not None and action.amount_cents <= remaining

    def _check_open(self, session: Session, *, seen: bool = True) -> None:
        """The session is open (a visitor's or an agent's closes after 24 hours idle), else 409 `closed`, ledgered
        `auth` on its Desk; then, with `seen`, it was active now. The turn route passes `seen=False`, as the kernel's
        does: starting a turn keeps no idle conversation open."""
        if session.closed_at is None and session.kind != "owner" and self.now - session.last_seen > IDLE_LIMIT:
            session.closed_at = session.last_seen + IDLE_LIMIT
            self._put_session(session)
        if session.closed_at is not None:
            raise self._refused(self.desks.get(session.desk_id or ""), 409, "closed", "closed",
                                session_id=session.session_id)
        if seen:
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

    def create_copy(self, request: Request, body: CreateCopyRequest) -> CopyCreated:
        """A Turner Plumbing copy with its seeded hold and, when it asks and a night is recorded, the night replayed
        into it (`_replay`)."""
        if self._no_seeded_night and "replay_night" in body.model_fields_set:
            raise Refusal(422, "invalid")
        copy_id = new_id("copy")
        desk = self._seed_rivera(copy_id)
        owner, owner_token = self._new_session(copy_id, None, "owner", verified=True, assurance="owner_session")
        copy = Copy(copy_id=copy_id, owner_session_id=owner.session_id, desk_ids=[desk.desk_id])
        self.copies[copy_id] = copy
        held = self._seed_held_request(desk)
        seeded_chat = SeededChat(session_id=held.session_id,
                                 visitor_line="Could you do the drain clearing at 15% off?", decision=held)
        events, replay_id = self._replay(desk) if body.replay_night and self._night else ([], None)
        if replay_id is not None:
            self.replayed_nights[copy_id] = (replay_id, events)
        return CopyCreated(copy_id=copy_id, desk_ids=copy.desk_ids, owner_session=owner.state(),
                           owner_token=owner_token, seeded_chat=seeded_chat,
                           replayed_messages=events, replay_id=replay_id)

    # The recorded night (Plan 01d) ----------------------------------------------------------------------------

    def _replay(self, desk: Desk) -> tuple[list[ReplayedEvent], str]:
        """Replay the recorded night into the new copy, as data: each session closed at generation 0 with no person
        (its token kept by no one), its rows at the moments they happened and its ledger entries marked; returns the
        events in shown order and the replay's id."""
        replay_id, real_now = new_id("night"), self.now
        self._replaying = (replay_id, real_now)
        events: list[ReplayedEvent] = []
        try:
            for recorded in self._night:
                events += self._replay_session(desk, recorded, real_now)
        finally:
            self._replaying, self.now = None, real_now
        events.sort(key=lambda event: event.shown_at)
        return events, replay_id

    def _replay_session(self, desk: Desk, recorded: RecordedSession, real_now: datetime) -> list[ReplayedEvent]:
        self.now = recorded.steps[0].at
        session, _ = self._new_session(desk.copy_id, desk.desk_id, recorded.kind)   # its token is discarded
        self.append(desk, "session", {"session_id": session.session_id, "kind": recorded.kind, "preview": False},
                    session_id=session.session_id)
        events = []
        for step in recorded.steps:
            self.now = step.at
            event = {"session_id": session.session_id, "shown_at": signed_time(step.at), "text": None,
                     "verdict": None, "decision": None}
            if step.kind == "said":
                events.append(ReplayedEvent(**event | {"kind": "visitor_message", "text": step.text}))
            elif step.kind == "replied":
                verdict = self._verdict(session, desk, "en", [RenderedBlock(kind="prose", text=step.text)], [], [])
                events.append(ReplayedEvent(**event | {"kind": "reply", "verdict": verdict}))
            elif step.kind == "blocked":
                self._verdict(session, desk, "en", [], [Violation(kind="number_in_prose", span="", rule_id="digit")],
                              [])
            else:
                decision = self._replay_decision(session, desk, step.kind, real_now)
                events.append(ReplayedEvent(**event | {"kind": "receipt", "decision": decision}))
        session.closed_at = session.last_seen = recorded.steps[-1].at
        self._put_session(session)
        return events

    def _replay_decision(self, session: Session, desk: Desk, kind: str, real_now: datetime) -> Decision:
        """A booking of the copy's first open slot, executed; a release of a document the session may not have,
        refused; or a drain clearing quoted at 15% off, held and denied by the owner: decided as any call is, at the
        recorded moment, and in its final state. A replay leaves no Demo inbox entry and no approval row."""
        if kind == "booked":
            slot = min((slot for slot in desk.slots.values() if slot.starts_at > real_now
                        and slot.slot_id not in desk.booked), key=lambda slot: slot.starts_at)
            call = ToolCall(call_id=new_id("call"), tool="native.book", args={"slot_id": slot.slot_id})
        elif kind == "refused":
            document = next(iter(desk.documents.values()))
            call = ToolCall(call_id=new_id("call"), tool="native.release_document",
                            args={"document_id": document.document_id})
        else:
            call = ToolCall(call_id=new_id("call"), tool="native.quote",
                            args={"items": [{"item_id": "drain", "qty": 1}], "requested_discount_bp": 1500})
        action = self._normalize(session, desk, call)
        outcome, card_ids, baseline = self._rule(session, desk, action)
        digest = sha256_hex(canonical({"desk_id": None, "tool": call.tool, "args": call.args}))
        inbox = len(self.inbox)
        decision = self._new_decision(session, desk, call, digest, action, outcome, card_ids, baseline=baseline)
        del self.inbox[inbox:]                          # a hold's owner alert: a replay leaves none
        record = self.decisions[decision.decision_id]
        if outcome == "allow":
            self._run(record, session)
        elif outcome == "hold":
            self._transition(record, "denied", kind="approval", answer="deny_once")
        if record.decision.state != {"booked": "executed", "refused": "refused", "denied": "denied"}[kind]:
            raise ValueError(f"a replayed {kind} step ended {record.decision.state}")
        return record.decision

    def public_desk(self, request: Request, body: Any) -> PublicDesk:
        """Public-labelled fields only, in the language asked for (`?lang=es`, else English): names, brand, the charter
        in the page's order (the hours, unless they have no windows, the contact, then the policies by fact ID), the
        Agent Card naming what an agent may ask for there now (`_agent_tools`), and the open-now line from the hours on
        the fake's clock (None without windows, or closed with no opening in the week ahead)."""
        desk = self._by_slug(request.path_params["desk_slug"])
        language = "es" if request.query_params.get("lang") == "es" else "en"
        charter = []
        for template, key in CHARTER_TEMPLATES:
            for fact_id, fact in sorted(desk.facts.items()):
                named = fact_id == key if template != "policy" else fact_id.startswith(key)
                if (named and fact.kind == "charter" and "public" in fact.label.readers and self._current(fact)
                        and (template != "hours" or desk.hours)):
                    block = self._render(desk, template, fact, language)
                    if template != "contact" or valid_public_contact(block.text):
                        charter.append(block)
        # Scan the final rendered group: filtering can bring separate promise fragments together.
        refused = {key for block in charter if block.template == "policy"
                   for key in public_policy_fields([(block.fact_id, block.text)])}
        charter = [block for block in charter if block.fact_id not in refused]
        while refused := public_policy_fields([
                (block.fact_id, block.text) for block in charter if block.template == "policy"]):
            charter = [block for block in charter if block.fact_id not in refused]
        card = agent_card(language, business=desk.business_name, owner=desk.owner_display_name, slug=desk.slug,
                          tools=self._agent_tools(desk))
        return PublicDesk(business_name=desk.business_name, desk_name=desk.name,
                          owner_display_name=desk.owner_display_name, brand=effective_brand(desk.brand), charter=charter,
                          agent_card=card, open_status=self._open_status(desk, language),
                          starters=self._starters(desk, language))

    def _starters(self, desk: Desk, language: str) -> list[str]:
        canaries = self._canaries(desk.copy_id)
        questions = []
        for n in (1, 2, 3):
            key = f"{STARTER_KEY}{n}:{language}"
            fact = desk.facts.get(f"charter:{key}")
            if (fact is None or "public" not in fact.label.readers or fact.status != "available"
                    or not self._current(fact)):
                continue
            claim = next((claim for claim in fact.claims if claim.key == key and claim.kind == "text"), None)
            if claim is not None:
                text = claim.value.strip()
                if 0 < len(text) <= 80 and not canary_spans(text, canaries):
                    questions.append(text)
        return questions

    def _agent_tools(self, desk: Desk) -> set[str]:
        """What an agent session may be given on the Desk now: its enabled tools an agent could ever be given, kept to
        lead capture and callbacks while Answering is off."""
        tools = {tool for tool in AGENT_DECLARED if tool in desk.tools and desk.tools[tool].status == "enabled"}
        return tools if desk.answering else tools & set(ANSWERING_OFF_TOOLS)

    def _open_status(self, desk: Desk, language: str) -> OpenStatus | None:
        tz = ZoneInfo(desk.timezone)
        window = open_window(desk.hours, tz, self.now)
        if window is None or (not window[0] and window[1] is None):
            return None
        is_open, boundary, refresh_at = window
        text = open_status_text(is_open, boundary.astimezone(tz) if boundary else None, self.now.astimezone(tz),
                                language)
        return OpenStatus(open=is_open, until=boundary if is_open else None, opens_at=None if is_open else boundary,
                          text=text, as_of=self.now, refresh_at=refresh_at)

    def create_session(self, request: Request, body: CreateSessionRequest) -> SessionCreated:
        """A session on the slug's Desk: an unknown slug is 404 and a deleted Desk 409 `closed` (an agent's request
        is signed first, so a refused signature is still ledgered)."""
        desk = self._by_slug(body.desk_slug, deleted=True)
        if body.kind == "agent":
            return self._open_agent_session(request, body, desk)
        if desk.deleted_at is not None:
            raise self._refused(desk, 409, "closed", "closed")
        if body.preview:
            owner = self._by_token(request.headers.get("x-owner-session"))
            if owner is None or owner.kind != "owner" or owner.copy_id != desk.copy_id:
                raise Refusal(401, "auth")
        session, token = self._new_session(desk.copy_id, desk.desk_id, "visitor", preview=body.preview)
        self.append(desk, "session", {"session_id": session.session_id, "kind": "visitor", "preview": body.preview},
                    session_id=session.session_id)
        return SessionCreated(state=session.state(), session_token=token)

    def session_mode(self, request: Request, body: ModeRequest) -> SessionState:
        """The owner's take-over, hand-back and resume (Plan 01a's mode table) of a visitor or agent session of their
        copy: a token that isn't the owner's is 401, another copy's session or an ID that names none is 404, a closed
        one 409 `closed`, a stale generation 409 `stale_generation`, and then `paused` (only the breaker pauses) or
        the owner's own session (it has no mode to set) 422 `invalid`, as the kernel checks them; a change is
        `set_mode`'s, and the current mode again changes nothing."""
        copy, _ = self.owner_of(request)
        session = self.sessions.get(request.path_params["id"])
        if session is None or session.copy_id != copy.copy_id:
            raise Refusal(404, "not_found")
        self._check_open(session)
        self._check_generation(session, body.generation)
        if body.mode == "paused" or session.kind == "owner":
            raise Refusal(422, "invalid")
        return self.set_mode(session.session_id, body.mode)

    def whoami(self, request: Request, body: Any) -> WhoAmI:
        if self._signed_by_agent(request):              # an agent names its session: `GET /whoami?session_id=`
            session = self._agent(request, request.query_params.get("session_id") or "")
            self._check_open(session)
            return WhoAmI(kind="agent", copy_id=session.copy_id, desk_id=session.desk_id,
                          desk_ids=[session.desk_id], session=session.state())
        owner_token = request.headers.get("x-owner-session")
        session = self._by_token(owner_token or request.headers.get("x-session-token"))
        if session is None or (session.kind == "owner") != bool(owner_token):
            raise Refusal(401, "auth")
        named = request.query_params.get("session_id")
        if named is not None and named != session.session_id:
            raise Refusal(401, "auth")
        if session.kind != "owner":
            self._check_open(session)        # the session a token names must be open (master, session auth)
        copy = self.copies[session.copy_id]
        if session.kind == "owner":                     # the copy's live Desks (Plan 01a): a deleted one isn't listed
            live = [desk_id for desk_id in copy.desk_ids if self.desks[desk_id].deleted_at is None]
            return WhoAmI(kind="owner", copy_id=copy.copy_id, desk_id=None, desk_ids=live, session=session.state())
        return WhoAmI(kind=session.kind, copy_id=copy.copy_id, desk_id=session.desk_id,
                      desk_ids=[session.desk_id], session=session.state())

    def turn(self, request: Request, body: TurnRequest) -> TurnStarted:
        """A turn starts (GitHub issue #121): the language `detect_language` finds in its newest visitor or agent
        message becomes the session's, or the one on record stays when it finds neither English nor Spanish (English
        for a session with none). The text is read for that alone, never kept, mirrored or ledgered, and a repeat
        detects again and changes nothing else, not even the session's activity (`seen=False`). Over the contract's
        `TURN_TEXT_CHARS` is 422 `invalid`, then the session checks: 401, 404, 409 `closed`, a stale generation 409
        `stale_generation`."""
        if len(body.text) > TURN_TEXT_CHARS:
            raise Refusal(422, "invalid")
        session, _ = self.session_call(request, request.path_params["session_id"], body.desk_id, seen=False)
        self._check_generation(session, body.generation)
        detected = detect_language(body.text)
        if detected in ("en", "es") and detected != session.last_language:
            session.last_language = detected
            self._put_session(session)
        return TurnStarted(language=session.last_language or "en")

    # Decisions -----------------------------------------------------------------------------------

    @staticmethod
    def _business_profile(desk: Desk, tool: str) -> ToolProfile | None:
        from desk.kernel_service.adapters import blocks, profile_sha256

        profile = desk.tools.get(tool)
        if (profile is None or profile.source != 'business' or profile.business is None
                or profile.business.config.block not in blocks.SUPPORTED_BLOCKS
                or profile.business.config.block not in blocks.BLOCK_ADAPTERS):
            return None
        expected = blocks.profile(tool, profile.business)
        if (profile.definition_sha256 != expected.definition_sha256
                or profile_sha256(profile) != profile_sha256(expected)):
            return None
        return profile

    def _business_block(self, desk: Desk, tool: str) -> str | None:
        """The block of a business tool `_business_profile` accepts, else None."""
        profile = self._business_profile(desk, tool)
        return profile.business.config.block if profile is not None else None

    def tools_given(self, session: Session, desk: Desk) -> tuple[str, ...]:
        """The tools this session may call now ("Model-visible tools"): an owner session has the setup tools only."""
        if session.kind == "owner":
            return tuple(tool for tool in OWNER_TOOLS if tool in desk.tools and desk.tools[tool].status == "enabled")
        if not desk.answering and not session.preview:
            given = ANSWERING_OFF_TOOLS
        else:
            given = VERIFIED_TOOLS if session.verified else UNVERIFIED_TOOLS
        if session.kind == "agent":                     # never refunds; money only with a verified mandate
            given = tuple(tool for tool in given if tool != "payments.create_refund"
                          and (tool not in MANDATE_TOOLS or session.mandate_id is not None))
            if session.mandate_id is not None and (desk.answering or session.preview):
                given += ("native.charge_mandate",)
        given += self._business_tools_given(desk, given)
        return tuple(tool for tool in given if tool in desk.tools and desk.tools[tool].status == "enabled")

    def _business_tools_given(self, desk: Desk, base_tools) -> tuple[str, ...]:
        from desk.kernel_service.adapters import blocks

        return tuple(tool for tool, profile in desk.tools.items()
                     if profile.status == 'enabled' and self._business_profile(desk, tool) is not None
                     and blocks.BLOCK_BASE[profile.business.config.block] in base_tools)

    def context(self, request: Request, body: Any) -> SessionContext:
        """The session's tools now, every tool its kind could be given, and the facts its labels let it read;
        mode owner and paused still answer."""
        session, desk = self.session_call(request, request.path_params["session_id"],
                                          request.query_params.get("desk_id"))
        declared = {"owner": OWNER_TOOLS, "agent": AGENT_DECLARED}.get(session.kind, VISITOR_DECLARED)
        if session.kind in ('visitor', 'agent'):
            declared += tuple(tool for tool, profile in desk.tools.items()
                              if profile.status == 'enabled' and self._business_profile(desk, tool) is not None)
        facts = [*self._catalog(desk), *(fact for fact in desk.facts.values() if self._current(fact))]
        try:
            local = self.now.astimezone(ZoneInfo(desk.timezone))
        except ZoneInfoNotFoundError:
            raise Refusal(500, "internal") from None
        return SessionContext(
            clock=ContextClock(as_of_utc=signed_time(self.now), local_now=local.isoformat(timespec="minutes"),
                               local_date=local.date().isoformat(),
                               weekday=("mon", "tue", "wed", "thu", "fri", "sat", "sun")[local.weekday()],
                               timezone=desk.timezone),
            tools=[desk.tools[tool] for tool in self.tools_given(session, desk)],
            tools_declared=[desk.tools[tool] for tool in declared if tool in desk.tools],
            facts=[fact for fact in facts if self._readable(session, fact)
                   and not is_starter_fact(fact.fact_id)],
            knowledge=[item for item in desk.knowledge.values()
                       if self._readers(session) & set(item.label.readers)])

    @staticmethod
    def _catalog(desk: Desk) -> list[Fact]:
        """The kernel's `catalog` fact (`context.catalog_fact`), first in a session's facts: public, one text claim
        per price item (its `item_id` and title, no price) in `item_id` order, an item named "hours" left out; built
        on each read, never stored, and none when the Desk sells nothing."""
        claims = [Claim(key=item_id, kind="text", value=desk.prices[item_id].title)
                  for item_id in sorted(desk.prices) if item_id != "hours"]
        return [Fact(fact_id="catalog", kind="charter", status="available", source="kernel", claims=claims,
                     label=Label(readers=["public"]))] if claims else []

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
            return self._refresh(record).model_copy(update={"owner_plain": None})
        if session.mode == "paused":
            return self._new_decision(session, desk, call, digest, None, "refuse", [], why="paused")
        if call.tool not in TOOL_NAMES and self._business_profile(desk, call.tool) is None:
            return self._new_decision(session, desk, call, digest, None, "refuse", [], why="unknown_tool")
        if call.tool not in self.tools_given(session, desk):
            return self._new_decision(session, desk, call, digest, None, "refuse", [], why="not_given")
        if not matches(desk.tools[call.tool].input_schema, call.args):
            return self._new_decision(session, desk, call, digest, None, "refuse", [], why="invalid_args")
        try:
            action = self._normalize(session, desk, call)
        except AdapterCheckRefused as refusal:
            return self._new_decision(session, desk, call, digest, None, "refuse", [],
                                      why="adapter_refused", check=refusal.code)
        if action is None:
            return self._new_decision(session, desk, call, digest, None, "refuse", [], why="adapter_refused")
        outcome, card_ids, baseline = self._rule(session, desk, action)
        script = self._scripts.get(call.tool)
        scripted = script is not None and script.outcome is not None
        if scripted:
            outcome, baseline = script.outcome, None
        return self._new_decision(session, desk, call, digest, action, outcome, card_ids, scripted=scripted,
                                  baseline=baseline)

    def _normalize(self, session: Session, desk: Desk, call: ToolCall) -> NormalizedAction | None:
        """The adapter's step: resolve the resource and compute amounts from the Desk's records, never from
        args; a known adapter refusal carries its check code, otherwise None refuses."""
        tool, args = call.tool, call.args
        profile = desk.tools[tool]
        block = profile.business.config.block if profile.business is not None else None
        resource = ResourceRef(kind="desk", id=desk.desk_id, owner_person_id=None)
        list_cents = discount_bp = amount_cents = recipient = starts_at = None
        if tool == "native.quote":
            if any(item["item_id"] not in desk.prices for item in args["items"]):
                raise AdapterCheckRefused("unknown_item")
            list_cents = sum(desk.prices[item["item_id"]].unit_cents * item["qty"] for item in args["items"])
            if list_cents > 1_000_000:
                raise AdapterCheckRefused("over_limit")
            discount_bp = args.get("requested_discount_bp", 0)
            amount_cents = list_cents - list_cents * discount_bp // 10_000
        elif tool == "native.book" or block == 'typed_booking':
            from desk.kernel_service.adapters.book import BookArgs
            from desk.kernel_service.labels import find_canaries
            try:
                note = BookArgs.model_validate(args).note
            except ValidationError:
                raise AdapterCheckRefused('invalid_args') from None
            if note and find_canaries(note, {document.document_id: document.canary
                    for each in self.desks.values() if each.copy_id == desk.copy_id for document in each.documents.values()}):
                raise AdapterCheckRefused('note_canary')
            slot = desk.slots.get(args["slot_id"])
            if slot is None or slot.starts_at <= self.now:
                raise AdapterCheckRefused("no_such_slot")
            resource, starts_at = ResourceRef(kind="slot", id=slot.slot_id, owner_person_id=None), slot.starts_at
        elif tool == "native.release_document":
            # named bare or by its fact ID, as Claude's context shows it (`adapters.base.fact_ref`)
            document = desk.documents.get(args["document_id"].removeprefix("document:"))
            if document is None:
                raise AdapterCheckRefused("no_such_document")
            resource = ResourceRef(kind="document", id=document.document_id,
                                   owner_person_id=document.record_owner_person_id)
            recipient = "verified_contact"
        elif tool == "native.start_verification":
            recipient = "verified_contact"
        elif tool == "payments.list_charges":
            resource = ResourceRef(kind="charge", id=f"person:{session.person_id}", owner_person_id=session.person_id)
        elif tool in ("native.payment_link", "native.charge_mandate"):
            quote_id = args["quote_id"].removeprefix("quote:")     # bare or by its fact ID, as for documents
            quote = self.quotes.get(quote_id)
            fact = desk.facts.get(f"quote:{quote_id}")
            # this conversation's own quote, unpaid: a quote is paid once (Plan 01c)
            if (quote is None or quote["desk_id"] != desk.desk_id or quote["session_id"] != session.session_id
                    or quote["status"] != "available" or fact is None or not self._current(fact)
                    or not self._readable(session, fact)):
                return None
            resource = ResourceRef(kind="quote", id=quote["quote_id"], owner_person_id=None)
            amount_cents = quote["amount_cents"]
        elif tool == "payments.create_refund":
            # The fake has no provider charge records to resolve during refund normalization.
            raise AdapterCheckRefused("no_such_charge")
        if block == 'intake':
            if len(args['answers']) != len(profile.business.config.questions):
                raise AdapterCheckRefused('answer_count')
        elif profile.source == 'business' and profile.business.config.block == 'purpose_payment':
            list_cents = amount_cents = profile.business.config.amount_cents
            discount_bp = 0
        from desk.kernel_service.adapters import profile_sha256
        return NormalizedAction(
            action_id=new_id("act"), copy_id=desk.copy_id, desk_id=desk.desk_id, session_id=session.session_id,
            generation=session.generation, tool=tool, effects=profile.effects,
            args_sha256=sha256_hex(canonical(args)),
            profile_sha256=profile_sha256(profile) if profile.source == 'business' else sha256_hex(profile.model_dump_json()),
            resource=resource, list_cents=list_cents, discount_bp=discount_bp, amount_cents=amount_cents,
            recipient=recipient, starts_at=starts_at)

    def _rule(self, session: Session, desk: Desk, action: NormalizedAction) -> tuple[str, list[str], str | None]:
        """The Turner cards' outcome for a normalized call (the kernel evaluates Cedar), the cards behind it, and for
        a refusal by the always-on baseline the `@id` of its forbid in `kernel/cedar/baseline.cedar`."""
        tool = action.tool
        if not tool.startswith('desk.') and self._never(desk, tool):
            return "refuse", [f"never-{tool}"], None
        if self._business_block(desk, tool) == 'purpose_payment':
            return self._purpose_payment_rule(session, desk, action)
        if self._business_profile(desk, tool) is not None:
            covering = [card for card in desk.cards if (
                card.applies_to == tool or card.applies_to.removeprefix('effect:') in action.effects) and (
                card.who == 'anyone' or card.who == 'verified' and session.verified
                or card.who == 'person' and card.person_id == session.person_id and session.verified
                or card.who == 'agent' and session.kind == 'agent' and card.agent_key_id == session.agent_key_id)]
            never = [card for card in covering if card.mode == 'never']
            if never:
                return 'refuse', [card.card_id for card in never], None
            asks = [card for card in covering if card.mode == 'ask' and not card.is_default]
            autos = [card for card in covering if card.mode == 'auto' and card.max_amount_cents is None
                     and (card.hours is None or in_hours(action.starts_at or self.now, [card.hours],
                                                        ZoneInfo(desk.timezone)) is not None)]
            if autos and not asks and not any(card.review for card in autos):
                return 'allow', [card.card_id for card in autos], None
            holds = asks or autos or [card for card in covering if card.mode == 'ask']
            return 'hold', [card.card_id for card in holds] or [f'default-{tool}'], None
        if tool == "native.quote":
            return ("hold" if action.discount_bp else "allow"), ["rv-quote"], None
        if tool == "native.book":
            window = in_hours(action.starts_at, desk.hours)
            if window is None:
                return "hold", ["rv-book-wk"], None
            return "allow", ["rv-book-sat" if window.days == ["sat"] else "rv-book-wk"], None
        if tool == "native.release_document":
            if session.person_id is not None and session.person_id == action.resource.owner_person_id:
                return "allow", ["rv-docs"], None
            return "refuse", [], "private_data_record_owner"     # private data only to its verified record owner
        if money_tool(tool, action.effects) and not 0 < (action.amount_cents or 0) <= AUTO_MONEY_HARD_CAP_CENTS:
            return "refuse", [], "money_has_amount"              # money always carries an amount, at most $10,000
        if tool == "native.charge_mandate" and not self._room_for(session, action):
            return "refuse", [], "agent_charge_within_mandate"   # an agent's charge stays within its mandate
        if tool in ("native.payment_link", "native.charge_mandate"):
            card = next((card for card in desk.cards if card.applies_to == tool and card.mode == "auto"), None)
            if card is not None:
                # within the card's limit and the active version's money cap, else it asks (the baseline's cap)
                within = action.amount_cents <= min(card.max_amount_cents, desk.auto_money_cap_cents)
                return ("allow" if within else "hold"), [card.card_id], None
        preset = next((card.card_id for card in desk.cards if card.applies_to == tool and card.mode == "auto"
                       and card.who == "anyone" and card.card_id.startswith("preset-")), None)
        if preset is not None:
            return "allow", [preset], None
        return "hold", [f"default-{tool}"], None

    def _purpose_payment_rule(self, session: Session, desk: Desk, action: NormalizedAction):
        if not 0 < (action.amount_cents or 0) <= AUTO_MONEY_HARD_CAP_CENTS:
            return 'refuse', [], 'money_has_amount'
        if session.kind == 'agent' and not self._room_for(session, action):
            return 'refuse', [], 'agent_charge_within_mandate'
        covering = [card for card in desk.cards if (
            card.applies_to == action.tool or card.applies_to.removeprefix('effect:') in action.effects) and (
            card.who == 'anyone' or card.who == 'verified' and session.verified
            or card.who == 'person' and card.person_id == session.person_id and session.verified
            or card.who == 'agent' and session.kind == 'agent' and card.agent_key_id == session.agent_key_id)]
        never = [card for card in covering if card.mode == 'never']
        if never:
            return 'refuse', [card.card_id for card in never], None
        asks = [card for card in covering if card.mode == 'ask' and not card.is_default]
        autos = [card for card in covering if card.mode == 'auto']
        # The compiler's precedence: an auto card decides only where no ask card at its specificity or above, and no
        # more specific auto card, covers the call; its limits, hours and review come after.
        ranked = [card for card in autos if all(_specificity(ask) < _specificity(card) for ask in asks)
                  and all(_specificity(other) <= _specificity(card) for other in autos)]
        within = [card for card in ranked
                  if card.max_amount_cents is not None and action.amount_cents <= card.max_amount_cents
                  and action.amount_cents <= desk.auto_money_cap_cents
                  and (card.hours is None or in_hours(self.now, [card.hours], ZoneInfo(desk.timezone)) is not None)]
        if within and not any(card.review for card in within):
            return 'allow', [card.card_id for card in within], None
        holds = asks or within or autos
        return 'hold', [card.card_id for card in holds] or [f'default-{action.tool}'], None

    def _new_decision(self, session: Session, desk: Desk, call: ToolCall, digest: str,
                      action: NormalizedAction | None, outcome: str, card_ids: list[str], *,
                      why: str | None = None, check: str | None = None, scripted: bool = False,
                      baseline: str | None = None) -> Decision:
        state = {"allow": "allowed", "hold": "held", "refuse": "refused"}[outcome]
        decision_id = new_id("dec")
        tool = call.tool[:64]
        # every decide entry names the rules version and its money cap, a refusal before any action too (the
        # kernel's `decide._store`)
        summary = {"decision_id": decision_id, "action_id": action.action_id if action else None, "tool": tool,
                   "outcome": outcome, "card_ids": card_ids, "policy_version": desk.policy_version,
                   "auto_money_cap_cents": min(desk.auto_money_cap_cents, AUTO_MONEY_HARD_CAP_CENTS),
                   "reviewed": False}
        if why is not None:
            summary["reason"] = why
        if check is not None:
            summary["check"] = check
        entry = self.append(desk, "decide", summary, session_id=session.session_id, ref_id=decision_id)
        expires_at = self.now + {"allow": ALLOW_FOR, "hold": HOLD_FOR, "refuse": timedelta(0)}[outcome]
        answers, inbox = [], []
        if outcome == "hold":
            # allow_person on money only within the Desk's cap (`compiler.capped`), and never with no amount, as
            # the kernel's `answers_for` offers it
            cap = min(desk.auto_money_cap_cents, AUTO_MONEY_HARD_CAP_CENTS)
            past_cap = money_tool(action.tool, action.effects) and (action.amount_cents is None
                                                                    or action.amount_cents > cap)
            # a limit hold, through an auto card's hold twin, offers no "Deny always"; a scripted hold stands for an
            # ask card's and keeps it (master "Decision lifecycle")
            limit_hold = not scripted and self._decided_by_auto_card(desk, card_ids)
            answers = [answer for answer in HELD_ANSWERS
                       if (answer != "allow_person" or (session.person_id is not None and not past_cap))
                       and (answer != "deny_always" or not limit_hold)]
            inbox = [self._alert_owner(desk, "A request needs your answer", "A request is waiting for you.",
                                       decision_id=decision_id)]
        decision = self._signed(Decision(
            decision_id=decision_id, session_id=session.session_id, call_id=call.call_id, action=action,
            outcome=outcome, state=state, policy_version=desk.policy_version,
            policy_ids=self._policy_ids(desk, outcome, card_ids, baseline=baseline, scripted=scripted),
            card_ids=card_ids,
            reason_plain=self._reason(session, desk, call, action, card_ids),
            visitor_plain=status_line(state, tool=tool, session_kind=session.kind, language=session.last_language,
                                      owner=desk.owner_display_name),
            answers=answers, expires_at=expires_at, ledger_seq=entry.seq, signature=""))
        # the alerts travel once, on this answer: the record every read answers from carries none
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
        return decision.model_copy(update={"inbox": inbox})

    @staticmethod
    def _policy_ids(desk: Desk, outcome: str, card_ids: list[str], *, baseline: str | None = None,
                    scripted: bool = False) -> list[str]:
        """The deciding policies, as the kernel's engine names them (`<set>.<@id>`, the compiler's `@id`s), sorted: a
        refusal by the baseline names its forbid, `B.<baseline>`; a `never` card's refusal its forbid, `F.never.<card>`;
        an allow its auto card's permit, `A.auto.<card>`; and a hold either an auto card's hold twin, `H.twin.<card>`
        (past the card's limits), or an ask card's permit, `H.ask.<card>` (the default asks, and the ask card a scripted
        hold stands for). A refusal before evaluation names none, as the kernel's step-1 refusals don't; a scripted
        refusal stands for a `never` card's."""
        if baseline is not None:
            return [f"B.{baseline}"]
        if outcome == "allow":
            return sorted(f"A.auto.{card_id}" for card_id in card_ids)
        if outcome == "refuse":
            return sorted(f"F.never.{card_id}" for card_id in card_ids)
        autos = set() if scripted else {card.card_id for card in desk.cards if card.mode == "auto"}
        return sorted(f"H.{'twin' if card_id in autos else 'ask'}.{card_id}" for card_id in card_ids)

    def _alert_owner(self, desk: Desk, preview: str, body: str, *, decision_id: str | None = None) -> InboxNotice:
        """An owner alert in the copy's Demo inbox ("approval" alerts at once by the seed's defaults), and its
        code-free notice. The owner reads it under its preview line, and a held request's alert names its decision,
        as the kernel's do."""
        entry = DemoInboxEntry(entry_id=new_id("inbox"), to="owner", kind="alert", body=body, created_at=self.now,
                               decision_id=decision_id, title=preview)
        self.inbox.append((desk.copy_id, entry))
        return InboxNotice(entry_id=entry.entry_id, to=entry.to, preview=preview)

    @staticmethod
    def _decided_by_auto_card(desk: Desk, card_ids: list[str]) -> bool:
        """Whether the deciding card (the first of `card_ids`) is an `auto` card: its hold is a limit hold."""
        return bool(card_ids) and any(card.card_id == card_ids[0] and card.mode == "auto" for card in desk.cards)

    @staticmethod
    def _reason(session: Session, desk: Desk, call: ToolCall, action: NormalizedAction | None,
                card_ids: list[str]) -> str:
        """The owner-facing reason: who asked for what ("Setup" for the owner's own setup session), the deciding card's
        reason, then the call's free text quoted after "Claude's note", as the real kernel labels it (Claude wrote it
        into the call, the visitor didn't)."""
        who = "Setup" if session.kind == "owner" else next(
            (person.display_name for person in desk.people.values() if person.person_id == session.person_id),
            "A visitor")
        reason = f"{who} asked to use {call.tool[:64]}."
        cards = [card.reason for card in desk.cards if card.card_id in card_ids]
        if cards:
            reason += " " + cards[0]
        note = call.args.get("note") if action is not None else None
        if isinstance(note, str) and note.strip():
            reason += f" Claude's note: “{note[:200]}”"
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
            "ledger_seq": decision.ledger_seq, "created_at": record.created_at, "policy_ids": decision.policy_ids})

    def _transition(self, record: DecisionRecord, state: str, kind: str = "decide", **summary) -> Decision:
        """Move a decision to `state`: ledgered, re-signed, mirrored. The owner's line (`owner_plain`, unsigned) is set
        for a refusal at execution and for a held request a booking closed, and cleared in every other state."""
        desk = self.desks[record.desk_id]
        decision = record.decision
        session = self.sessions[decision.session_id]
        entry = self.append(desk, kind, {"decision_id": decision.decision_id, "state": state, **summary},
                            session_id=decision.session_id, ref_id=decision.decision_id)
        line = status_line(state, tool=record.tool, session_kind=session.kind, language=session.last_language,
                           owner=desk.owner_display_name,
                           business=desk.tools[record.tool].business if record.tool in desk.tools else None)
        owner_plain = None
        if state == "refused_at_execution":
            owner_plain = OWNER_REFUSAL_TEXT[
                "rules_changed" if summary.get("reason") == "rules_changed"
                and summary.get("check") in {"tool", "profile", "pin", "policy"} else "fallback"]
        elif state == "cancelled" and summary.get("cancelled_by") == "booking":
            owner_plain = OWNER_BOOKING_CLOSED_TEXT
        record.decision = self._signed(decision.model_copy(update={
            "state": state, "visitor_plain": line, "owner_plain": owner_plain,
            "ledger_seq": entry.seq, "answers": decision.answers if state == "held" else []}))
        self._put_decision(record)
        return record.decision

    def _refresh(self, record: DecisionRecord) -> Decision:
        """Lazy expiry: an allow lasts 60 s, a hold 24 h. Then a held quote with a discount is cancelled once its own
        session has a confirmed booking decided after it, ledgered with the booking and the Desk's version and cap (the
        kernel's `decide.supersede_if_booked`)."""
        decision = record.decision
        if (decision.state in ("allowed", "held") and record.result is None and not record.running
                and self.now > decision.expires_at):
            return self._transition(record, "expired")
        booking_id = self._superseding_booking(record)
        if booking_id is not None:
            desk = self.desks[record.desk_id]
            return self._transition(record, "cancelled", action_id=decision.action.action_id, cancelled_by="booking",
                                    booking_id=booking_id, policy_version=desk.policy_version,
                                    auto_money_cap_cents=min(desk.auto_money_cap_cents, AUTO_MONEY_HARD_CAP_CENTS))
        return decision

    def _superseding_booking(self, record: DecisionRecord) -> str | None:
        """The first confirmed booking of a held discount quote's own session on its Desk whose decision came after the
        quote's: a later `created_at`, or, since `now` stands still between calls, the same one and made later."""
        decision = record.decision
        if (decision.state != "held" or record.tool != "native.quote" or decision.action is None
                or not decision.action.discount_bp):
            return None
        by_action = {made.decision.action.action_id: made for made in self.decisions.values()
                     if made.decision.action is not None}
        later = sorted((made.created_at, made.order, booking_id) for booking_id, booking in self.bookings.items()
                       if booking["desk_id"] == record.desk_id and booking["session_id"] == decision.session_id
                       and booking["status"] == "confirmed"
                       and (made := by_action.get(booking["action_id"])) is not None
                       and (made.created_at, made.order) > (record.created_at, record.order))
        return later[0][2] if later else None

    def _own_decision(self, request: Request, session_id: str | None,
                      decision_id: str) -> tuple[Session, DecisionRecord]:
        """The session `X-Session-Token` names, or an agent's signature authenticates (and `session_id`, when given),
        and its own decision: 401, then 404 for another session's or an unknown decision, then 409 if the session is
        closed. An agent names the session: `session_id`, else the decision's own. An owner names its own session, and
        the decision must be one of its own setup calls on a Desk of its copy."""
        if request.headers.get("x-owner-session") is not None:
            copy, owner = self.owner_of(request)
            if session_id is not None and session_id != owner.session_id:
                raise Refusal(404, "not_found")
            record = self.decisions.get(decision_id)
            if (record is None or record.decision.session_id != owner.session_id
                    or record.desk_id not in copy.desk_ids):
                raise Refusal(404, "not_found")
            return owner, record
        if self._signed_by_agent(request):
            record = self.decisions.get(decision_id)
            named = session_id or (record.decision.session_id if record is not None else None)
            if named is None:
                raise Refusal(404, "not_found")
            session = self._agent(request, named)
            if record is None or record.decision.session_id != session.session_id:
                raise Refusal(404, "not_found")
            self._check_open(session)
            return session, record
        session = self.visitor_of(request)
        if session_id is not None and session_id != session.session_id:
            raise Refusal(401, "auth")
        record = self.decisions.get(decision_id)
        if record is None or record.decision.session_id != session.session_id:
            raise Refusal(404, "not_found")
        self._check_open(session)
        return session, record

    def read_decision(self, request: Request, body: Any) -> Decision:
        """The decision for its own session, or for the owner of its copy (404 for any other copy's)."""
        decision_id = request.path_params["id"]
        if request.headers.get("x-owner-session") is not None:
            copy, _ = self.owner_of(request)
            record = self.decisions.get(decision_id)
            if record is None or record.copy_id != copy.copy_id:
                raise Refusal(404, "not_found")
            return self._refresh(record)
        _, record = self._own_decision(request, None, decision_id)
        return self._refresh(record).model_copy(update={"owner_plain": None})

    def execute(self, request: Request, body: ExecuteRequest) -> ExecResult:
        session, record = self._own_decision(request, body.session_id, body.decision_id)
        if body.generation is not None:
            # the body's generation, or the allow's own: one made before a take-over (and maybe a hand-back) is
            # stale whatever the body says, so the generation check answers before the mode
            if body.generation != session.generation or record.generation != session.generation:
                if record.decision.state == "allowed" and record.result is None:
                    self._transition(record, "expired", fenced=True)
                raise Refusal(409, "stale_generation")
            if session.mode == "owner":
                raise Refusal(409, "mode_owner")
            if session.mode == "paused":
                raise Refusal(409, "mode_paused")
        decision = self._refresh(record)
        if record.running:                                             # still running: no stored result yet
            raise Refusal(409, "conflict")
        if record.result is not None:
            if record.result.state not in ("succeeded", "failed"):    # its outcome isn't known yet: no stored result
                raise Refusal(409, "conflict")
            self.append(self.desks[record.desk_id], "execute", {"decision_id": decision.decision_id, "repeat": True},
                        session_id=session.session_id, ref_id=decision.decision_id)
            return record.result
        if body.approval_id is not None or decision.state != "allowed":
            raise Refusal(409, "conflict")
        if self._take_in_flight(decision.action.tool):                 # another request began it a moment ago
            record.running = True
            raise Refusal(409, "conflict")
        if decision.action.tool == "native.charge_mandate" and not self._room_for(session, decision.action):
            desk = self.desks[record.desk_id]
            check = "conditions" if desk.policy_version == decision.policy_version else "policy"
            self._transition(record, "refused_at_execution", kind="execute", reason="rules_changed", check=check)
            raise Refusal(409, "conflict")           # the reservation failed: nothing was charged
        return self._run(record, session)

    def _run(self, record: DecisionRecord, session: Session, exec_state: str | None = None) -> ExecResult:
        """Execute the decision's action as `session` (the held session for an approval; the owner for a setup
        tool, on the decision's Desk), ending in `exec_state` when given, else as the tool's script says (`succeeded`
        without one)."""
        desk, action = self.desks[record.desk_id], record.decision.action
        if action.tool.startswith('desk.'):
            from desk.kernel_service.adapters import profile_sha256
            profile = self._business_profile(desk, action.tool)
            if (profile is None or profile.status != 'enabled'
                    or profile_sha256(profile) != action.profile_sha256):
                approved = record.decision.state == 'approved'
                self._transition(record, 'refused_at_execution', kind='execute', reason='profile')
                if approved:
                    return ExecResult(action_id=action.action_id, state='failed', facts=[], model_view={})
                raise Refusal(409, 'conflict')
        if self._business_block(desk, action.tool) == 'purpose_payment':
            approved = record.decision.state == 'approved'
            if ((session.kind == 'agent' and not self._room_for(session, action))
                    or (not approved and self._rule(session, desk, action)[0] != 'allow')):
                self._transition(record, 'refused_at_execution', kind='execute', reason='rules_changed')
                if approved:
                    return ExecResult(action_id=action.action_id, state='failed', facts=[], model_view={})
                raise Refusal(409, 'conflict')
        script = self._scripts.get(action.tool)
        if exec_state is None:
            exec_state = script.exec_state if script is not None else "succeeded"
        facts, model_view, inbox = (self._effects(session, desk, action) if exec_state == "succeeded"
                                    else ([], {}, []))
        if model_view is None:                              # the tool's own failure (a slot taken meanwhile)
            exec_state, facts, model_view, inbox = "failed", [], {}, []
        if script is not None:
            if script.facts is not None:
                facts = list(script.facts)
                for fact in facts:
                    self._put_fact(desk, fact)
            if script.model_view is not None:
                model_view = script.model_view
            if script.inbox is not None:
                inbox = list(script.inbox)
        record.result = ExecResult(action_id=action.action_id, state=exec_state, facts=facts, model_view=model_view,
                                   inbox=inbox)
        self._transition(record, {"succeeded": "executed", "failed": "failed", "unknown": "unknown"}[exec_state],
                         kind="execute")
        return record.result

    def _label(self, session: Session) -> Label:
        """What a fact created in this session may be read by ("Labels")."""
        readers = ["owner", f"session:{session.session_id}"]
        if session.person_id is not None:
            readers.append(f"person:{session.person_id}")
        return Label(readers=readers, record_owner=session.person_id)

    def _effects(self, session: Session, desk: Desk,
                 action: NormalizedAction) -> tuple[list[Fact], dict | None, list[InboxNotice]]:
        """The tool's side effects: rows, facts labelled for the session, Claude's `model_view` and the Demo inbox
        notices for the visitor (a verification code's, never one that says whether the contact is on record)."""
        args = self._args[action.action_id]
        ids, label = {"copy_id": desk.copy_id, "desk_id": desk.desk_id}, self._label(session)
        tool, facts, view, inbox = action.tool, [], {}, []
        profile = desk.tools[tool]
        block = profile.business.config.block if profile.business is not None else None
        if tool == "native.quote":
            quote_id = new_id("quote")
            items = [{"item_id": item["item_id"], "title": desk.prices[item["item_id"]].title, "qty": item["qty"]}
                     for item in args["items"]]
            expires_at = self.now + timedelta(hours=72)
            self.quotes[quote_id] = {
                "quote_id": quote_id, **ids, "session_id": session.session_id, "items": items,
                "list_cents": action.list_cents, "discount_bp": action.discount_bp,
                "amount_cents": action.amount_cents, "status": "available", "expires_at": expires_at,
                "created_at": self.now}
            self._put("quotes", (quote_id,), dict(self.quotes[quote_id]))
            facts.append(Fact(fact_id=f"quote:{quote_id}", kind="quote", status="available", source="kernel",
                              label=label, expires_at=expires_at, claims=[
                                  Claim(key="items", kind="text",
                                        value=", ".join(f"{item['title']} × {item['qty']}" for item in items)),
                                  Claim(key="list", kind="money", value=action.list_cents),
                                  Claim(key="total", kind="money", value=action.amount_cents),
                                  Claim(key="discount", kind="percent_bp", value=action.discount_bp),
                                  Claim(key="expires", kind="datetime", value=expires_at.isoformat())]))
            view = {"fact_id": facts[0].fact_id, "quote_id": quote_id, "items": items, "status": "available"}
        elif tool == "native.book" or block == 'typed_booking':
            from desk.kernel_service.adapters.book import BookArgs

            note = BookArgs.model_validate(args).note
            slot = desk.slots[action.resource.id]
            if slot.slot_id in desk.booked:
                return [], None, []
            desk.booked.add(slot.slot_id)
            booking_id = new_id("booking")
            self._put("bookings", (booking_id,), {
                "booking_id": booking_id, **ids, "slot_id": slot.slot_id, "starts_at": slot.starts_at,
                "person_id": session.person_id, "lead_id": None, "status": "confirmed"})
            self.bookings[booking_id] = {"desk_id": desk.desk_id, "session_id": action.session_id,
                                         "action_id": action.action_id, "status": "confirmed"}
            self._close_card_handoffs(session, desk, closed_by="booking")
            facts.append(Fact(fact_id=f"booking:{booking_id}", kind="booking", status="committed", source="kernel",
                              label=label, claims=[
                                  Claim(key="starts_at", kind="datetime", value=slot.starts_at.isoformat()),
                                  Claim(key="minutes", kind="text", value=str(slot.minutes)),
                                  Claim(key="booking", kind="ref", value=booking_id)]))
            if block == 'typed_booking':
                config = profile.business.config
                facts[0].claims.extend([Claim(key='appointment_type', kind='text', value=config.appointment_type),
                                        Claim(key='appointment_minutes', kind='text', value=str(config.minutes))])
            if note:
                self._put_fact(desk, Fact(fact_id=f'booking_note:{booking_id}', kind='knowledge', status='committed',
                    source='kernel', label=Label(readers=['owner']), claims=[
                        Claim(key='booking', kind='ref', value=booking_id), Claim(key='note', kind='text', value=note)]))
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
        elif (self._business_block(desk, tool) == 'purpose_payment'
              and (open_link := self._open_purpose_link(session, desk, action)) is not None):
            # asked again in the session, its open link answers: no second quote, checkout or link
            facts.append(desk.facts[f'payment_link:{open_link.link_id}'])
            view = {'fact_id': facts[0].fact_id, 'title': open_link.title, 'amount_cents': open_link.amount_cents}
        elif self._business_block(desk, tool) == 'purpose_payment':
            config = desk.tools[tool].business.config
            if config.amount_cents != action.amount_cents:
                return [], None, []
            quote_id = new_id('quote')
            expires = self.now + timedelta(hours=72)
            self.quotes[quote_id] = {
                'quote_id': quote_id, **ids, 'session_id': session.session_id,
                'items': [{'item_id': tool, 'title': config.purpose, 'qty': 1, 'unit_cents': config.amount_cents}],
                'list_cents': action.list_cents, 'discount_bp': 0, 'amount_cents': action.amount_cents,
                'status': 'available', 'expires_at': expires, 'created_at': self.now}
            self._put('quotes', (quote_id,), dict(self.quotes[quote_id]))
            facts.append(Fact(fact_id=f'quote:{quote_id}', kind='quote', status='available', source='kernel',
                              label=label, expires_at=expires, claims=[
                                  Claim(key='items', kind='text', value=config.purpose),
                                  Claim(key='list', kind='money', value=action.list_cents),
                                  Claim(key='total', kind='money', value=action.amount_cents),
                                  Claim(key='discount', kind='percent_bp', value=0),
                                  Claim(key='expires', kind='datetime', value=expires.astimezone(ZoneInfo(desk.timezone)).isoformat())]))
            link = PaymentLink(link_id=new_id('link'), token=secrets.token_urlsafe(32), **ids,
                               session_id=session.session_id, quote_id=quote_id, action_id=action.action_id,
                               title=config.purpose, amount_cents=action.amount_cents, expires_at=self.now + LINK_TTL,
                               customer_person_id=session.person_id if session.kind == 'visitor' and session.verified else None,
                               mandate_id=session.mandate_id if session.kind == 'agent' else None)
            if link.mandate_id is not None:
                mandate = self.mandates[link.mandate_id]
                mandate.reserved_cents += action.amount_cents
                self._put('mandates', (link.mandate_id,), mandate.ro_row())
            self.payment_links[link.link_id] = link
            self._put('payment_links', (link.link_id,), link.ro_row())
            self.append(desk, 'payment', {'link_id': link.link_id, 'state': 'issued', 'version': desk.policy_version},
                        session_id=session.session_id)
            link_fact = Fact(fact_id=f'payment_link:{link.link_id}', kind='payment_link', status='available',
                             source='kernel', label=label, expires_at=link.expires_at, claims=[
                                 Claim(key='title', kind='text', value=config.purpose),
                                 Claim(key='total', kind='money', value=action.amount_cents),
                                 Claim(key='ref', kind='ref', value=link.link_id)])
            facts.append(link_fact)
            view = {'fact_id': link_fact.fact_id, 'title': config.purpose, 'amount_cents': action.amount_cents}
        elif tool == "native.capture_lead" or (block == 'intake' and self._business_profile(desk, tool) is not None):
            lead_id = new_id("lead")
            self._put("leads", (lead_id,), {"lead_id": lead_id, **ids, "session_id": session.session_id,
                                            "display_name": args["name"],
                                            "note": args.get('contact') if tool.startswith('desk.') else args.get("note"),
                                            "created_at": self.now})
            view = {"lead_id": lead_id, "saved": True}
            if tool.startswith('desk.'):
                claims = [Claim(key='lead_id', kind='ref', value=lead_id), Claim(key='tool', kind='ref', value=tool)]
                for index, (question, answer) in enumerate(zip(desk.tools[tool].business.config.questions,
                                                              args['answers'], strict=True)):
                    claims.extend([Claim(key=f'question:{index}', kind='text', value=question),
                                   Claim(key=f'answer:{index}', kind='text', value=answer)])
                self._put_fact(desk, Fact(fact_id=f'lead:{lead_id}', kind='knowledge', status='committed',
                                          source='kernel', claims=claims, label=Label(readers=['owner'])))
        elif ((urgent := self._business_profile(desk, tool)) is not None
              and urgent.business.config.block == 'urgent'):
            from desk.kernel_service.adapters.base import claudes_note, quoted
            from desk.kernel_service.adapters.request_callback import PREVIEW_UNSCHEDULED_TTL

            # urgent: unscheduled, so no next-open-hour window and no claims; a preview's card lasts a day
            expires = self.now + PREVIEW_UNSCHEDULED_TTL if session.preview else None
            handoff_id = new_id('handoff')
            closed = [] if session.preview else [row for row in self.handoffs.values() if row['desk_id'] == desk.desk_id
                      and row['session_id'] == session.session_id and row['status'] == 'open']
            for row in closed:
                row['status'] = 'done'
                self._put('handoffs', (row['handoff_id'],), dict(row))
                old_fact = desk.facts.get('handoff:' + row['handoff_id'])
                if old_fact is not None:
                    self._put_fact(desk, old_fact.model_copy(update={'status': 'expired'}))
            self.handoffs[handoff_id] = {
                'handoff_id': handoff_id, **ids, 'session_id': session.session_id,
                'reason': f"{args['name']} · {args['contact']} · {args['reason']}",
                'callback_window': None,
                'status': 'done' if session.preview else 'open', 'kind': 'callback'}
            self._put('handoffs', (handoff_id,), dict(self.handoffs[handoff_id]))
            callback_label = Label(readers=['owner', f'session:{session.session_id}']) if session.preview else label
            facts.append(Fact(fact_id=f'handoff:{handoff_id}', kind='handoff', status='committed', source='kernel',
                              label=callback_label, claims=[], expires_at=expires))
            view = {'fact_id': facts[0].fact_id, 'handoff_id': handoff_id}
            for row in closed:
                self.append(desk, 'desk_data', {'part': 'handoffs', 'refs': [row['handoff_id']],
                                               'replaced_by': handoff_id})
            # Urgent delivery is immediate even when no notification settings request it.
            if not session.preview:
                self.inbox.append((desk.copy_id, DemoInboxEntry(
                    entry_id=new_id('inbox'), to='owner', kind='alert', created_at=self.now,
                    title='Urgent callback requested',
                    body=f'Reported as urgent through {quoted(urgent.business.title)}. '
                         + claudes_note((args['name'], args['contact'], args['reason'])))))
        elif tool == "native.request_callback":
            # one open handoff per session: the open ones close first, the card's or an earlier call-back's
            handoff_id = new_id("handoff")
            self._close_open_handoffs(session, desk, replaced_by=handoff_id)
            self.handoffs[handoff_id] = {
                "handoff_id": handoff_id, **ids, "session_id": session.session_id,
                "reason": f"{args['name']} · {args['contact']} · {args['reason']}", "callback_window": None,
                "status": "done" if session.preview else "open", "kind": "callback"}
            self._put("handoffs", (handoff_id,), dict(self.handoffs[handoff_id]))
            facts.append(Fact(fact_id=f"handoff:{handoff_id}", kind="handoff", status="committed", source="kernel",
                              label=label, claims=[Claim(key="handoff", kind="ref", value=handoff_id)]))
            view = {"fact_id": facts[0].fact_id, "handoff_id": handoff_id}
        elif tool == "native.start_verification":
            _, inbox = self._start_challenge(session, desk, args["contact"])
            view = {"status": "requested"}
        elif tool == "native.release_document":
            document = desk.documents[action.resource.id]
            link = DocumentLink(link_id=new_id("link"), token=secrets.token_urlsafe(32),
                                document_id=document.document_id, desk_id=desk.desk_id, session_id=session.session_id,
                                expires_at=self.now + LINK_TTL)
            self.document_links[link.link_id] = link
            link_id = link.link_id
            self.append(desk, "document_link", {"link_id": link_id, "document_id": document.document_id,
                                                "issued": True}, session_id=session.session_id)
            facts.append(Fact(fact_id=f"document_link:{link_id}", kind="document", status="available",
                              source="kernel", expires_at=link.expires_at,
                              label=Label(readers=["owner", f"person:{document.record_owner_person_id}"],
                                          record_owner=document.record_owner_person_id),
                              claims=[Claim(key="title", kind="text", value=document.title),
                                      Claim(key="ref", kind="ref", value=link_id)]))
            view = {"fact_id": facts[0].fact_id, "title": document.title, "link_ready": True}
        elif tool == "native.payment_link" and (open_link := self._open_link(action.resource.id)) is not None:
            # the quote's open link answers for it: no second link (Plan 01c)
            facts.append(desk.facts[f"payment_link:{open_link.link_id}"])
            view = {"fact_id": facts[0].fact_id, "title": open_link.title, "amount_cents": open_link.amount_cents}
        elif tool == "native.payment_link":
            quote = self.quotes[action.resource.id]
            title = ", ".join(item["title"] + (f" × {item['qty']}" if item["qty"] > 1 else "")
                              for item in quote["items"])
            customer = session.person_id if session.kind == "visitor" and session.verified else None
            link = PaymentLink(link_id=new_id("link"), token=secrets.token_urlsafe(32), copy_id=desk.copy_id,
                               desk_id=desk.desk_id, session_id=session.session_id, quote_id=quote["quote_id"],
                               action_id=action.action_id, title=title, amount_cents=action.amount_cents,
                               expires_at=self.now + LINK_TTL, customer_person_id=customer)
            self.payment_links[link.link_id] = link
            self._put("payment_links", (link.link_id,), link.ro_row())
            self.append(desk, "payment", {"link_id": link.link_id, "state": "issued", "version": desk.policy_version},
                        session_id=session.session_id)
            facts.append(Fact(fact_id=f"payment_link:{link.link_id}", kind="payment_link", status="available",
                              source="kernel", label=label, expires_at=link.expires_at, claims=[
                                  Claim(key="title", kind="text", value=title),
                                  Claim(key="total", kind="money", value=link.amount_cents),
                                  Claim(key="ref", kind="ref", value=link.link_id)]))
            view = {"fact_id": facts[0].fact_id, "title": title, "amount_cents": link.amount_cents}
        elif tool == "native.charge_mandate":
            quote, record = self.quotes[action.resource.id], self.mandates[session.mandate_id]
            title = ", ".join(item["title"] + (f" × {item['qty']}" if item["qty"] > 1 else "")
                              for item in quote["items"])
            record.committed_cents += action.amount_cents     # reserved and committed at once: no provider here
            self._put("mandates", (record.mandate.mandate_id,), record.ro_row())
            self._quote_paid(quote)
            charge_id = new_id("charge")
            self.append(desk, "payment", {"charge_id": charge_id, "mandate_id": record.mandate.mandate_id,
                                          "action_id": action.action_id, "state": "charged"},
                        session_id=session.session_id)
            facts.append(Fact(fact_id=f"charge:{charge_id}", kind="charge", status="committed", source="kernel",
                              label=label, claims=[Claim(key="title", kind="text", value=title),
                                                   Claim(key="total", kind="money", value=action.amount_cents),
                                                   Claim(key="ref", kind="ref", value=charge_id)]))
            view = {"fact_id": facts[0].fact_id, "charge_id": charge_id, "status": "paid"}
        elif tool == "payments.list_charges":
            view = {"charges": []}
        elif tool == "native.web_search":
            view = {"results": [{"title": "Plumbing services", "url": "https://plumbing.example/services",
                                  "snippet": "Plumbers repair leaks and clear drains."}],
                    "simulated": False, "kind": "cited_excerpts"}
            for hit in view["results"]:
                self._store_knowledge(desk, KnowledgeItem(
                    item_id="search-" + sha256_hex(hit["url"])[:16], source="web_search",
                    title="Web search: " + hit["title"], text=hit["snippet"] or hit["title"],
                    label=Label(readers=["owner"])))
        elif tool == "native.read_memory":
            words = {word.casefold() for word in re.findall(r"\w+", args["query"])}
            memory = desk.simulated_memory if desk.simulated_memory is not None else (
                MEMORY_ITEMS if desk.rivera_seed else None)
            found = [item for item in (memory.items if memory is not None else []) if words & (
                {word.casefold() for word in re.findall(r"\w+", item.title)} |
                {topic.casefold() for topic in item.topics})]
            for item in found:
                self._store_knowledge(desk, KnowledgeItem(item_id=f"mem-{item.id}", source="memory_import",
                    title=item.title, text=item.text, label=Label(readers=["owner"])))
            view = {"items": [{"title": item.title, "text": item.text} for item in found], "simulated": True}
        elif tool == "native.fetch_website":
            host = (urlsplit(args["url"]).hostname or "")
            if urlsplit(args["url"]).scheme not in ("http", "https") or not host.endswith(".example"):
                return [], None, []                 # the fetch guard refused it (here: anything but a .example site)
            item = self._store_knowledge(desk, KnowledgeItem(
                item_id=f"website:{sha256_hex(args['url'])[:16]}", source="website", title=host,
                text=WEBSITE_TEXT.format(host=host), label=Label(readers=["owner"])))
            view = {"item_id": item.item_id, "title": item.title, "text": item.text[:8000]}
        for fact in facts:
            self._put_fact(desk, fact)
        return facts, view, inbox

    def _store_knowledge(self, desk: Desk, item: KnowledgeItem, *,
                         created_at: datetime | None = None) -> KnowledgeItem:
        """Upsert a knowledge item by its ID, mirrored and ledgered `desk_data` (no text in the entry)."""
        desk.knowledge[item.item_id] = item
        created_at = desk.knowledge_created_at.setdefault(item.item_id, self.now if created_at is None else created_at)
        self._put("knowledge_items", (desk.desk_id, item.item_id), {
            "item_id": item.item_id, "copy_id": desk.copy_id, "desk_id": desk.desk_id, "source": item.source,
            "title": item.title, "text": item.text, "readers": list(item.label.readers), "created_at": created_at})
        self.append(desk, "desk_data", {"part": "knowledge", "item_id": item.item_id, "owner_only_forced": False})
        return item

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
        approved = None
        if body.answer in ("allow_once", "allow_person") and (self._never(desk, action.tool) or (
                action.tool == "native.charge_mandate" and not self._room_for(session, action))):
            # Step 6: distinguish changed rules from changed inputs under the decision's own rules.
            check = "conditions" if desk.policy_version == decision.policy_version else "policy"
            self._transition(record, "refused_at_execution", kind="approval", answer=body.answer,
                             approval_id=approval_id, reason="rules_changed", check=check)
        elif body.answer in ("allow_once", "allow_person"):
            approved = self._transition(record, "approved", kind="approval", answer=body.answer, approval_id=approval_id)
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
        return ApprovalResult(decision=record.decision, execution=execution, card_diff=card_diff, approved=approved)

    def check_reply(self, request: Request, body: CheckReplyRequest) -> ReplyVerdict:
        """Check Claude's draft; a prose-only failure may keep checked cards. An agent's
        check may end its nonce's turn (`_end_agent_turn`)."""
        draft = body.draft
        session, desk = self.session_call(request, draft.session_id)
        self._check_generation(session, draft.generation)
        if session.mode == "owner":
            raise Refusal(409, "mode_owner")
        verdict = self._check_draft(session, desk, draft, final=body.final)
        if session.kind == "agent":
            self._end_agent_turn(request, verdict, final=body.final and "final" in body.model_fields_set)
        return verdict

    def _check_draft(self, session: Session, desk: Desk, draft: ReplyDraft, *, final: bool = True) -> ReplyVerdict:
        language = session.last_language or "en"
        if session.mode == "paused":
            return self._verdict(session, desk, language, [],
                                 [Violation(kind="session_paused", span="", rule_id="session_paused")], [],
                                 final=final)
        detected = detect_language(draft.prose)
        violations = []
        if detected == "other":
            violations.append(Violation(kind="unsupported_language", span=draft.prose[:40], rule_id="language"))
        elif detected == "unmarked":
            violations.append(Violation(kind="uncertain_language", span=draft.prose[:40], rule_id="language_uncertain"))
        elif detected in ("en", "es"):
            language = session.last_language = detected
            self._put_session(session)
        violations += scan_prose(draft.prose, self._canaries(desk.copy_id))
        if self._forced:
            kind = self._forced.pop(0)
            violations.append(Violation(kind=kind, span="" if kind == "canary" else draft.prose[:40],
                                        rule_id=f"fake.{kind}"))
        cards = []
        for clause in draft.clauses:
            card = self._clause(session, desk, clause, language, violations)
            if card is not None:
                cards.append(card)
        policies = [(card.fact_id, card.text) for card in cards if card.template == "policy"
                    and card.fact_id is not None and card.fact_id.startswith("charter:policy:")]
        if policies:
            refused = public_policy_fields([(None, draft.prose), *policies])
            fact_ids = list(dict.fromkeys(fact_id for fact_id, _ in policies if fact_id in refused))
            if fact_ids:
                violations.append(Violation(kind="unknown_fact", span="policy", rule_id="policy_combined",
                                            fact_ids=fact_ids))
        if not violations and draft.prose.strip() and self._soft_checks:
            result = self._soft_checks.pop(0)              # one try, no recheck (the kernel's `soft_promises`)
            if result != "pass":
                kind = "soft_promise" if result in {"flag", "denies_ai"} else "check_unavailable"
                rule_id = {"flag": "soft.promise", "denies_ai": "soft.denies_ai"}.get(result, "soft.unavailable")
                violations.append(Violation(kind=kind, span=draft.prose[:40], rule_id=rule_id))
        prose = [RenderedBlock(kind="prose", text=draft.prose)] if draft.prose else []
        return self._verdict(session, desk, language, prose + cards, violations,
                             [clause.fact_id for clause in draft.clauses if clause.fact_id], final=final)

    def _canaries(self, copy_id: str) -> dict[str, str]:
        """The canary of each document of the copy, on any of its Desks, by document ID in ID order (the kernel's
        `labels.copy_canaries`)."""
        documents = [document for desk in self.desks.values() if desk.copy_id == copy_id
                     for document in desk.documents.values()]
        return {document.document_id: document.canary
                for document in sorted(documents, key=lambda document: document.document_id)}

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
            violations.append(Violation(kind=kind, span=clause.template, rule_id=rule_id,
                                        fact_ids=[clause.fact_id] if clause.fact_id is not None else []))

        template = clause.template
        if template in KERNEL_ONLY_TEMPLATES:
            return refuse("unknown_fact", "kernel_only_template")
        if template in FACTLESS_TEMPLATES:
            if clause.fact_id is not None:
                return refuse("unknown_fact", "names_no_fact")
            key = "handoff" if template == "handoff" else "verify"
            text = REPLY_TEXT[language][key].format(owner=desk.owner_display_name)
            return RenderedBlock(kind="card", template=template, text=text, title=text)
        fact = desk.facts.get(clause.fact_id or "")
        if fact is None:
            return refuse("unknown_fact", "no_such_fact")
        if not self._readable(session, fact):
            return refuse("unentitled_fact", "not_a_reader")
        named = {"hours": fact.fact_id == "charter:hours", "contact": fact.fact_id == "charter:contact",
                 "policy": fact.fact_id.startswith("charter:policy:")}
        if fact.kind != TEMPLATE_KINDS.get(template) or not named.get(template, True):
            return refuse("unknown_fact", "template_mismatch")
        if not self._current(fact):
            return refuse("stale_fact", "not_current")
        block = self._render(desk, template, fact, language)
        if template == "contact" and not valid_public_contact(block.text):
            return refuse("unknown_fact", "contact_format")
        return block

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
            if 'appointment_type' in claims:
                from desk.kernel_service import render
                return render.render_clause(Clause(template=template, fact_id=fact.fact_id), fact, language,
                    render.DeskInfo(owner_display_name=desk.owner_display_name, timezone=desk.timezone))
        elif template == "hours":
            title = REPLY_TEXT[language]["hours"]
            lines = [f"{', '.join(window.days)} {window.start:%H:%M}-{window.end:%H:%M}" for window in desk.hours]
        elif template == "document_link":
            title, href = claims["title"], f"/api/d/{self.document_links[claims['ref']].token}"
        elif template == "payment_link":
            title, lines = claims["title"], [money(claims["total"])]
            href = f"/pay/{self.payment_links[claims['ref']].token}"
        elif template == "callback_confirmed":
            title = f"{desk.owner_display_name} will call you back."
        elif template == "charge_confirmed":
            title, lines = claims.get("title", "Payment"), [money(claims["total"])]
        else:
            title = str(next(iter(claims.values())))
        text = "\n".join([title, *lines, *(option.label for option in options)])
        return RenderedBlock(kind="card", template=template, text=text, fact_id=fact.fact_id, title=title, lines=lines,
                             href=href, options=options)

    def _verdict(self, session: Session, desk: Desk, language: str, blocks: list[RenderedBlock],
                 violations: list[Violation], fact_ids: list[str], *, author: str = "claude",
                 message_id: str | None = None, final: bool = True) -> ReplyVerdict:
        """Step 7: for a failure only of the prose (`desk.rewrites.PROSE_ONLY`) on a final draft while a held request
        awaits the owner (`_status_line_fits`), the checked cards then the kernel's status line as prose; else the
        checked cards, then the handoff clause when the draft has one; with no card at all, the kernel's call-back
        offer as prose when `_offers_call_back` (the owner's decision of 2026-11-01); else the handoff alone, ledgered
        and signed. An
        owner's say (`author="owner"`) that fails shows nothing at all: the owner's own words never become Claude's
        handoff. A verdict of Claude's that shows the handoff card and that the session will see (it passed citing
        the card, or it blocked a `final` draft or one with a kind a rewrite can't fix) first opens the session's
        owner handoff (`_open_card_handoff`); one the session won't see (the API rewrites it) has no blocks. The
        reply entry records `final`."""
        ok = not violations
        if not ok and author == "owner":
            blocks = []
        elif not ok:
            kept = [block for block in blocks if block.kind == "card" and block.template != "handoff"]
            text = REPLY_TEXT[language]["handoff"].format(owner=desk.owner_display_name)
            handoff = RenderedBlock(kind="card", template="handoff", text=text, title=text)
            prose_only = all(violation.kind in PROSE_ONLY for violation in violations)
            if prose_only and final and author == "claude" and self._status_line_fits(session, blocks, violations):
                blocks = kept + [RenderedBlock(kind="prose", text=REPLY_TEXT[language]["check_status"])]
            elif kept and prose_only:
                drafted = any(block.kind == "card" and block.template == "handoff" for block in blocks)
                blocks = kept + ([handoff] if drafted else [])   # a drafted handoff follows the kept cards
            elif prose_only and self._offers_call_back(session, desk, blocks, violations):
                blocks = [RenderedBlock(kind="prose", text=REPLY_TEXT[language]["offer_callback"])]   # ask first
            else:
                blocks = [handoff]
        shown = ok or final or any(violation.kind not in REWRITABLE for violation in violations)
        if author == "claude" and not shown:
            blocks = []                     # the API rewrites it: no handoff card is signed that no handoff backs
        # a replayed night holds only finished things and no Demo inbox entry (Plan 01d): its blocked drafts open none
        if (author == "claude" and shown and self._replaying is None
                and any(block.template == "handoff" for block in blocks)):
            self._open_card_handoff(session, desk)
        message_id = message_id or new_id("msg")
        entry = self.append(desk, "reply", {
            "message_id": message_id, "author": author, "ok": ok, "language": language,
            "violations": [violation.kind for violation in violations],
            "rule_ids": [violation.rule_id for violation in violations], "fact_ids": fact_ids,
            "dropped": [],                  # cards refused at signing: the fake rechecks none
            "final": final},
            session_id=session.session_id, ref_id=message_id)
        plain = ("owner_said" if ok else "owner_say_blocked") if author == "owner" else (
            "handed_off" if not shown or any(block.template == "handoff" for block in blocks) else "checked")
        visitor_plain = REPLY_TEXT[language][plain].format(owner=desk.owner_display_name)
        blocks_sha256 = sha256_hex(canonical([block.model_dump(mode="json") for block in blocks]))
        return ReplyVerdict(
            ok=ok, language=language, blocks=blocks, violations=violations, message_id=message_id,
            generation=session.generation, visitor_plain=visitor_plain, ledger_seq=entry.seq,
            signature=fake_signature({"session_id": session.session_id, "generation": session.generation,
                                      "message_id": message_id, "blocks_sha256": blocks_sha256,
                                      "visitor_plain": visitor_plain, "ledger_seq": entry.seq}))

    def _awaits_the_owner(self, session: Session) -> bool:
        """Whether the session has a held request awaiting the owner: one neither answered, cancelled nor expired."""
        return any(record.decision.session_id == session.session_id and record.decision.state == "held"
                   and record.decision.expires_at > self.now for record in self.decisions.values())

    def _status_line_fits(self, session: Session, blocks: list[RenderedBlock], violations: list[Violation]) -> bool:
        """Whether a final draft blocked only for its prose shows the kept cards then the kernel's status line, as the
        kernel's `reply_check.status_line_shown` decides: no checker outage (`check_unavailable`, which hands off), no
        handoff clause Claude drafted (which is honoured), and a held request awaiting the owner. It takes precedence
        over the call-back offer and opens no owner handoff."""
        return (not any(violation.kind == "check_unavailable" for violation in violations)
                and not any(block.kind == "card" and block.template == "handoff" for block in blocks)
                and self._awaits_the_owner(session))

    def _offers_call_back(self, session: Session, desk: Desk, blocks: list[RenderedBlock],
                          violations: list[Violation]) -> bool:
        """Whether a draft blocked only for its prose shows the kernel's call-back offer, as the kernel's
        `reply_check.call_back_offered` decides: no card at all (no checked card to keep, and no handoff clause Claude
        drafted, which is honoured), no checker outage (`check_unavailable`, which hands off), no open handoff of
        either kind on the session, and a call back among the session's tools' next steps."""
        return (not any(block.kind == "card" for block in blocks)
                and not any(violation.kind == "check_unavailable" for violation in violations)
                and self._open_handoff(session) is None
                and CALL_BACK_STEP in next_steps(desk.tools[tool] for tool in self.tools_given(session, desk)))

    def _open_card_handoff(self, session: Session, desk: Desk) -> str | None:
        """The owner's handoff for a verdict that shows the handoff card (#96), as the kernel's
        `reply_check.open_card_handoff`: none for the owner's preview session, while the session has a held request
        awaiting the owner (one not answered, cancelled or expired), or while it has an open handoff of either kind
        (an earlier card's or a call-back request); else one of kind `card`, open, with no call-back window and the
        kernel's reason, its
        owner alert (`handoff`, only when the Desk's preferences alert it at once; no decision) naming only who is
        waiting, and `desk_data {part: "handoffs", refs, kind: "card"}` on the session. Returns its ID, or None."""
        if session.preview or self._open_handoff(session) is not None:
            return None
        if self._awaits_the_owner(session):
            return None
        handoff_id = new_id("handoff")
        self.handoffs[handoff_id] = {
            "handoff_id": handoff_id, "copy_id": desk.copy_id, "desk_id": desk.desk_id,
            "session_id": session.session_id, "reason": CARD_HANDOFF_REASON, "callback_window": None,
            "status": "open", "kind": "card"}
        self._put("handoffs", (handoff_id,), dict(self.handoffs[handoff_id]))
        if "handoff" in desk.notify_now:
            person = desk.people.get(session.person_id or "") if session.verified else None
            who = person.display_name if person is not None else "A visitor"
            entry = DemoInboxEntry(entry_id=new_id("inbox"), to="owner", kind="alert", created_at=self.now,
                                   title="A conversation was handed to you",
                                   body=f"{who} is waiting in a conversation the Desk handed to you.")
            self.inbox.append((desk.copy_id, entry))
        self.append(desk, "desk_data", {"part": "handoffs", "refs": [handoff_id], "kind": "card"},
                    session_id=session.session_id)
        return handoff_id

    def _close_open_handoffs(self, session: Session, desk: Desk, *, replaced_by: str) -> None:
        """Close the session's open handoffs before a call-back opens its own (`replaced_by`), each as the owner's mark
        of done closes one: `done`, its `handoff:<id>` fact (a call-back's) expired, ledgered `desk_data` naming it
        and the call-back's handoff, so the owner's history reads it as replaced, not marked done. A row's kind
        never changes, so the owner's stale mark of done on one is 409."""
        for handoff_id, row in self.handoffs.items():
            if row["session_id"] != session.session_id or row["status"] != "open":
                continue
            row["status"] = "done"
            self._put("handoffs", (handoff_id,), dict(row))
            fact = desk.facts.get(f"handoff:{handoff_id}")
            if fact is not None:
                self._put_fact(desk, fact.model_copy(update={"status": "expired"}))
            self.append(desk, "desk_data", {"part": "handoffs", "refs": [handoff_id], "replaced_by": replaced_by})

    def _close_card_handoffs(self, session: Session, desk: Desk, *, closed_by: str) -> None:
        """Close the session's open handoffs the handoff card opened, as the owner's mark of done closes one, each
        ledgered `desk_data` naming it and what closed it (`closed_by`); a call-back stays open, since it promises the
        visitor a call."""
        for handoff_id, row in self.handoffs.items():
            if row["session_id"] != session.session_id or row["status"] != "open" or row.get("kind") != "card":
                continue
            row["status"] = "done"
            self._put("handoffs", (handoff_id,), dict(row))
            self.append(desk, "desk_data", {"part": "handoffs", "refs": [handoff_id], "closed_by": closed_by})

    def _open_handoff(self, session: Session) -> str | None:
        """The ID of the session's open handoff, of either kind; a session holds at most one."""
        return next((handoff_id for handoff_id, row in self.handoffs.items()
                     if row["session_id"] == session.session_id and row["status"] == "open"), None)

    def owner_message(self, request: Request, body: OwnerMessageRequest) -> OwnerMessageResult:
        """The owner's say or whisper into an open visitor or agent session of their copy, in any mode (Plan 01b):
        another copy's session or the owner's own is 404, a closed one 409 `closed`, and text outside 1–2000
        characters 422 `invalid`. A say is `_owner_say`'s; a whisper is ledgered `whisper` with its length, never its
        text, and makes no fact and no verdict."""
        copy, _ = self.owner_of(request)
        session = self.sessions.get(body.session_id)
        if session is None or session.copy_id != copy.copy_id or session.kind == "owner":
            raise Refusal(404, "not_found")
        self._check_open(session)
        if not 1 <= len(body.text) <= OWNER_TEXT_MAX:
            raise Refusal(422, "invalid")
        desk, message_id = self.desks[session.desk_id], new_id("msg")
        if body.kind == "whisper":
            entry = self.append(desk, "whisper", {"message_id": message_id, "chars": len(body.text)},
                                session_id=session.session_id, ref_id=message_id)
            return OwnerMessageResult(message_id=message_id, verdict=None, ledger_seq=entry.seq)
        verdict = self._owner_say(session, desk, body.text, message_id)
        return OwnerMessageResult(message_id=message_id, verdict=verdict, ledger_seq=verdict.ledger_seq)

    def _owner_say(self, session: Session, desk: Desk, text: str, message_id: str) -> ReplyVerdict:
        """An owner's say: only document canaries are looked for (the number rule doesn't apply to the owner's own
        words). Clean, it is an `owner_statement` fact `owner:<message_id>` that the owner and this session read, and a
        verdict in the session's language with one `owner_said` card holding the text verbatim; with a canary, no fact
        and no card. Ledgered `reply` by the owner either way."""
        violations = [violation for violation in scan_prose(text, self._canaries(desk.copy_id))
                      if violation.kind == "canary"]
        blocks, fact_ids = [], []
        if not violations:
            fact = Fact(fact_id=f"owner:{message_id}", kind="owner_statement", status="available", source="owner",
                        claims=[Claim(key="text", kind="text", value=text)],
                        label=Label(readers=["owner", f"session:{session.session_id}"]))
            self._put_fact(desk, fact)
            blocks = [RenderedBlock(kind="card", template="owner_said", text=text, fact_id=fact.fact_id, title=text)]
            fact_ids = [fact.fact_id]
        return self._verdict(session, desk, session.last_language or "en", blocks, violations, fact_ids,
                             author="owner", message_id=message_id)

    # The owner's Desk ----------------------------------------------------------------------------

    def _owners_desk(self, request: Request, desk_id: str) -> Desk:
        """A Desk of the copy `X-Owner-Session` names (401 without it), else 404; a deleted one is 409 `closed`,
        ledgered `auth` on it."""
        copy, _ = self.owner_of(request)
        if desk_id not in copy.desk_ids:
            raise Refusal(404, "not_found")
        desk = self.desks[desk_id]
        if desk.deleted_at is not None:
            raise self._refused(desk, 409, "closed", "closed")
        return desk

    def _by_slug(self, slug: str, *, deleted: bool = False) -> Desk:
        """The live Desk at `slug`, or a deleted one too with `deleted`, else 404 (the public page of a deleted Desk
        is gone, while opening a session on it is 409 `closed`)."""
        desk = next((desk for desk in self.desks.values()
                     if desk.slug == slug and (deleted or desk.deleted_at is None)), None)
        if desk is None:
            raise Refusal(404, "not_found")
        return desk

    def create_desk(self, request: Request, body: CreateDeskRequest) -> DeskCreated:
        """A new Desk in the owner's copy, through the seed path, with the `ask_first` preset active; its tools are
        native only, so a `connections` list is refused (422), as are an owner name outside the pattern, an
        unknown time zone and a money cap other than 0 (the presets are proved at 0; the owner raises it by a draft)."""
        copy, _ = self.owner_of(request)
        if body.desk.connections or body.desk.auto_money_cap_cents != 0:
            raise Refusal(422, "invalid")
        self._check_business(body.business.owner_display_name, body.business.timezone)
        self._refuse_policy_promises(copy.copy_id, body.desk.charter, "desk")
        native = tuple(tool for tool in TOOL_FACTS if tool_profile(tool).source == "native")
        desk = self._create_desk(copy.copy_id, body.business, body.desk, tools=native, cards=ASK_FIRST_CARDS)
        copy.desk_ids.append(desk.desk_id)
        return DeskCreated(desk_id=desk.desk_id, slug=desk.slug)

    @staticmethod
    def _check_business(owner_display_name: str, timezone: str) -> None:
        if not OWNER_NAME.fullmatch(owner_display_name):
            raise Refusal(422, "invalid")
        try:
            ZoneInfo(timezone)
        except (ValueError, KeyError):              # ZoneInfoNotFoundError is a KeyError
            raise Refusal(422, "invalid") from None

    def put_business(self, request: Request, body: DeskBusinessRequest) -> DeskUpdated:
        """The Desk's business: its name, owner name, time zone and brand, for every Desk of that business; a palette
        pick is stored as its key and the table's colours, and the ledger names the key."""
        desk = self._owners_desk(request, request.path_params["id"])
        self._check_business(body.owner_display_name, body.timezone)
        brand = stored_brand(body.brand, body.brand_palette)
        for each in self.desks.values():
            if each.business_id == desk.business_id:
                each.business_name, each.owner_display_name = body.name, body.owner_display_name
                each.timezone, each.brand = body.timezone, dict(brand)
        self._put_business(desk)
        palette = {"palette": brand["palette"]} if "palette" in brand else {}
        self.append(desk, "desk_data", {"part": "business", "refs": [], **palette})
        return DeskUpdated(desk_id=desk.desk_id, updated_at=self.now)

    def answering(self, request: Request, body: DeskAnsweringRequest) -> DeskUpdated:
        """The owner's Answering switch: off leaves visitors only lead capture and a callback."""
        desk = self._owners_desk(request, request.path_params["id"])
        desk.answering = body.on
        self._put_desk(desk)
        self.append(desk, "desk_data", {"part": "answering", "refs": []})
        return DeskUpdated(desk_id=desk.desk_id, updated_at=self.now)

    def delete_desk(self, request: Request, body: Any) -> None:
        """The owner deletes a Desk of its copy (204): its sessions close, its public page is 404, and opening a
        session on it or any owner route naming it answers 409 `closed`; its ledger stays, ending with the deletion's
        `desk_data` entry. Not modelled: voiding its document links and cancelling its live challenges."""
        desk = self._owners_desk(request, request.path_params["id"])
        desk.deleted_at = self.now
        for session in self.sessions.values():
            if session.desk_id == desk.desk_id and session.closed_at is None:
                session.closed_at = self.now
                self._put_session(session)
        self.append(desk, "desk_data", {"part": "desk", "deleted": True})

    def handoff_done(self, request: Request, body: Any) -> DeskUpdated:
        """The owner closes a handoff, a call-back request's or the handoff card's: `open` → `done` once, ledgered
        `desk_data` naming it."""
        copy, _ = self.owner_of(request)
        handoff = self.handoffs.get(request.path_params["id"])
        if handoff is None or handoff["copy_id"] != copy.copy_id:
            raise Refusal(404, "not_found")
        if handoff["status"] != "open":
            raise Refusal(409, "conflict")
        handoff["status"] = "done"
        self._put("handoffs", (handoff["handoff_id"],), dict(handoff))
        desk = self.desks[handoff["desk_id"]]
        self.append(desk, "desk_data", {"part": "handoffs", "refs": [handoff["handoff_id"]]})
        return DeskUpdated(desk_id=desk.desk_id, updated_at=self.now)

    def owner_inbox(self, request: Request, body: Any) -> list[DemoInboxEntry]:
        """The owner's Demo inbox: every entry of the copy, oldest first."""
        copy, _ = self.owner_of(request)
        return [entry for copy_id, entry in self.inbox if copy_id == copy.copy_id]

    # The Desk's parts (Plan 01b): each `PUT` replaces its part ---------------------------------------

    def _part_updated(self, desk: Desk, part: str) -> DeskUpdated:
        self.append(desk, "desk_data", {"part": part, "refs": []})
        return DeskUpdated(desk_id=desk.desk_id, updated_at=self.now)

    def _refuse_policy_promises(self, copy_id: str, charter: list[Claim], part: str,
                                desk: Desk | None = None) -> None:
        keys = [claim.key for claim in charter]
        if len(set(keys)) != len(keys):
            raise Refusal(422, "invalid")
        starters = {key: ["starter_seed_only"] for key in keys if is_starter_fact(f"charter:{key}")}
        if starters:
            raise Refusal(422, "invalid", starters)
        targets = [desk] if desk is not None else sorted(
            (row for row in self.desks.values() if row.copy_id == copy_id), key=lambda row: row.desk_id)
        contact_format = any(claim.key == "contact" and (claim.kind != "text" or not valid_public_contact(claim.value))
                             for claim in charter)
        values = {claim.key: claim.value for claim in charter
                  if claim.key.startswith("policy:") and claim.kind == "text"}
        count, total_characters = len(values), sum(map(len, values.values()))
        limit = "policy_count_limit" if count > 40 else "policy_text_limit" if total_characters > 8_000 else None
        fields = {"charter": [limit]} if limit else public_policy_fields(sorted(values.items()))
        if fields or contact_format:
            # One refusal names the contact and every refused policy; the ledger names the contact by its fact ID.
            contact = {"contact": ["contact_format"]} if contact_format else {}
            summary = {"part": part, "refused": "promise" if fields else "contact",
                       "fields": fields | ({"charter:contact": ["contact_format"]} if contact_format else {})}
            if limit:
                summary.update(keys=[safe_ref(key) for key in sorted(values)[:40]], policy_count=count,
                               total_characters=total_characters, reason=limit)
            for target in targets:
                self.append(target, "desk_data", summary)
            raise Refusal(422, "invalid", contact | fields)

    def desk_charter(self, request: Request, body: DeskCharterRequest) -> DeskUpdated:
        """The charter: each claim a public `charter:<key>` fact, in place of the ones before (`charter:hours`
        and seed-only starters stay); a key given twice or a `starter:` key is 422."""
        desk = self._owners_desk(request, request.path_params["id"])
        self._refuse_policy_promises(desk.copy_id, body.charter, "charter", desk)
        for fact_id in [fact_id for fact_id, fact in desk.facts.items()
                        if fact.kind == "charter" and fact_id != "charter:hours"
                        and not is_starter_fact(fact_id)]:
            del desk.facts[fact_id]
            self._drop("facts", (desk.desk_id, fact_id))
        for claim in body.charter:
            self._put_fact(desk, Fact(fact_id=f"charter:{claim.key}", kind="charter", status="available",
                                      source="kernel", claims=[claim], label=Label(readers=["public"])))
        return self._part_updated(desk, "charter")

    def _memory_desk(self, request: Request) -> Desk:
        if "x-session-token" in request.headers:
            raise Refusal(401, "auth")
        return self._owners_desk(request, request.path_params["id"])

    def desk_memory(self, request: Request, body: DeskMemoryRequest) -> DeskUpdated:
        desk = self._memory_desk(request)
        values = {"about": body.about, "items": " ".join(
            value for item in body.items for value in (item.id, item.title, *item.topics, item.text))}
        if not all(storable(value) for value in values.values()):
            self.append(desk, "desk_data", {"part": "memory", "refused": "invalid"})
            raise Refusal(422, "invalid")
        canaries = self._canaries(desk.copy_id)
        fields = [name for name, value in values.items() if canary_spans(value, canaries)]
        rest = " ".join(value for name, value in values.items() if name not in fields)
        if canary_spans(rest, canaries):
            fields = list(values)
        if fields:
            found = {document_id for document_id, _, _ in canary_spans(" ".join(values.values()), canaries)}
            self.append(desk, "desk_data", {"part": "memory", "refused": "canary", "fields": fields,
                                            "fact_ids": [f"document:{key}" for key in sorted(found)]})
            raise Refusal(422, "invalid")
        desk.simulated_memory = body.model_copy(deep=True)
        self.append(desk, "desk_data", {"part": "memory", "refs": [item.id for item in body.items]})
        return DeskUpdated(desk_id=desk.desk_id, updated_at=self.now)

    def desk_hours(self, request: Request, body: DeskHoursRequest) -> DeskUpdated:
        """The opening hours, and the `charter:hours` fact written again from them."""
        desk = self._owners_desk(request, request.path_params["id"])
        desk.hours = list(body.hours)
        self._put_desk(desk)
        self._put_hours(desk)
        return self._part_updated(desk, "hours")

    def desk_prices(self, request: Request, body: DeskPricesRequest) -> DeskUpdated:
        """The price list, in place of the one before; an item id given twice is 422."""
        desk = self._owners_desk(request, request.path_params["id"])
        items = {item.item_id: item for item in body.price_items}
        if len(items) != len(body.price_items):
            raise Refusal(422, "invalid")
        for item_id in set(desk.prices) - set(items):
            self._drop("price_items", (desk.desk_id, item_id))
        desk.prices = items
        for item in items.values():
            self._put("price_items", (desk.desk_id, item.item_id),
                      {**item.model_dump(), "copy_id": desk.copy_id, "desk_id": desk.desk_id})
        return self._part_updated(desk, "prices")

    def desk_calendar(self, request: Request, body: DeskCalendarRequest) -> DeskUpdated:
        """The bookable slots, in place of the ones before; a slot id given twice is 422."""
        desk = self._owners_desk(request, request.path_params["id"])
        slots = {slot.slot_id: slot for slot in body.calendar_slots}
        if len(slots) != len(body.calendar_slots):
            raise Refusal(422, "invalid")
        for slot_id in set(desk.slots) - set(slots):
            self._drop("calendar_slots", (desk.desk_id, slot_id))
        desk.slots = slots
        for slot in slots.values():
            self._put("calendar_slots", (desk.desk_id, slot.slot_id),
                      {**slot.model_dump(), "copy_id": desk.copy_id, "desk_id": desk.desk_id})
        return self._part_updated(desk, "calendar")

    def desk_people(self, request: Request, body: DeskPeopleRequest) -> DeskUpdated:
        """People on record, upserted by `ref` and removed by `ref`, all or nothing: a contact that looks masked (`•`
        or `*`), one that isn't an email or a phone number, a new person without one, a ref with `@`, an unknown ref
        to remove or a ref named twice is 422, and two people sharing a contact 409. `contact: None` keeps the contact
        on record; a removed person is off the record (their contact gets no code). Ledgered `desk_data` with the
        refs, never a contact. Not modelled: cancelling a changed or removed person's live challenge, closing the
        sessions verified as them and relabelling their documents."""
        desk = self._owners_desk(request, request.path_params["id"])
        by_ref = {person.ref: person for person in desk.people.values()}
        refs = [person.ref for person in body.upsert] + list(body.remove)
        if (len(set(refs)) != len(refs) or any("@" in ref for ref in refs)
                or any(ref not in by_ref for ref in body.remove)):
            raise Refusal(422, "invalid")
        for person in body.upsert:
            if person.contact is None and person.ref not in by_ref:
                raise Refusal(422, "invalid")
            if person.contact is not None and (any(mark in person.contact for mark in "•*")
                                               or not normalize_contact(person.contact)):
                raise Refusal(422, "invalid")
        contacts = {ref: normalize_contact(person.contact) for ref, person in by_ref.items() if ref not in body.remove}
        contacts.update({person.ref: normalize_contact(person.contact) for person in body.upsert
                         if person.contact is not None})
        if len(set(contacts.values())) != len(contacts):
            raise Refusal(409, "conflict")
        ids = {"copy_id": desk.copy_id, "desk_id": desk.desk_id}
        for ref in body.remove:
            person = by_ref[ref]
            del desk.people[person.person_id]
            self._drop("people", (person.person_id,))
        for upsert in body.upsert:
            person = by_ref.get(upsert.ref)
            if person is None:
                person = Person(person_id=new_id("person"), ref=upsert.ref, display_name=upsert.display_name,
                                contact=upsert.contact, created_at=self.now)
                desk.people[person.person_id] = person
            else:
                person.display_name = upsert.display_name
                person.contact = upsert.contact if upsert.contact is not None else person.contact
            self._put("people", (person.person_id,), {
                "person_id": person.person_id, **ids, "display_name": person.display_name,
                "masked_contact": mask_contact(person.contact), "notes": upsert.notes,
                "created_at": person.created_at or self.now})
        self.append(desk, "desk_data", {"part": "people", "refs": refs})
        return DeskUpdated(desk_id=desk.desk_id, updated_at=self.now)

    def desk_notifications(self, request: Request, body: DeskNotificationsRequest) -> DeskUpdated:
        """What alerts the owner at once and what waits for the briefing."""
        desk = self._owners_desk(request, request.path_params["id"])
        desk.notify_now = list(body.notifications.now)
        self._put("notification_prefs", (desk.desk_id,), {"copy_id": desk.copy_id, "desk_id": desk.desk_id,
                                                          **body.notifications.model_dump()})
        return self._part_updated(desk, "notifications")

    # Rules drafts, probes and confirms (Plans 01a and 01c) --------------------------------------------

    def _default_cards(self, desk: Desk, cards: list[RuleCard], enables: tuple[ToolPin, ...] = ()) -> list[RuleCard]:
        """The compiler's default asks: an `ask` card for anyone on each enabled tool that no card for anyone covers,
        by itself or through one of its effects."""
        covered = {card.applies_to for card in cards if card.who == "anyone"}
        enabling = {pin.tool for pin in enables}
        return [RuleCard(card_id=f"default-{tool}", applies_to=tool, mode="ask", who="anyone", is_default=True,
                         reason=DEFAULT_REASON)
                for tool, profile in sorted(desk.tools.items()) if (profile.status == "enabled" or tool in enabling)
                and tool not in covered and not any(f"effect:{effect}" in covered for effect in profile.effects)]

    @staticmethod
    def _draft_profiles(desk: Desk, enables: tuple[ToolPin, ...] = ()) -> tuple[tuple[str, str | None], ...]:
        """What a draft is proved against, as the kernel's `current_hashes` takes it: each tool enabled now with its
        pin, plus the draft's enables at theirs, by tool. Confirming a draft whose tools no longer match is refused."""
        pins = {tool: profile.definition_sha256 for tool, profile in desk.tools.items() if profile.status == "enabled"}
        pins.update((pin.tool, pin.definition_sha256) for pin in enables)
        return tuple(sorted(pins.items()))

    def policy_draft(self, request: Request, body: PolicyDraftRequest, *,
                     enables: tuple[ToolPin, ...] = ()) -> PolicyVersion:
        """The owner's cards compiled and proved against the active version (`expected_parent`, else 409): a new
        version with the compiler's default asks, `proved` or `rejected` (or `draft` when bounded), ledgered `policy`.
        The same cards on the same parent and tools return that version, except that a timed-out rejection proves
        again. A card id given twice, a default card among the owner's, a card that could change starting a
        verification (`changes_always_on`), or an auto money card above the draft's money cap (the one it names,
        else the active version's) is 422 `invalid`, with nothing drafted or ledgered."""
        from desk.kernel_service.adapters import profile_sha256

        desk = self._owners_desk(request, body.desk_id)
        if body.expected_parent != desk.policy_version:
            raise Refusal(409, "conflict")
        cap = desk.auto_money_cap_cents if body.auto_money_cap_cents is None else body.auto_money_cap_cents
        money_tools = money_tools_of((profile.tool, profile.effects) for profile in desk.tools.values())
        ids = [card.card_id for card in body.cards]
        if len(set(ids)) != len(ids) or any(
                card.is_default or changes_always_on(card)
                or (card.mode == "auto" and moves_money(card, money_tools)
                    and (card.max_amount_cents is None or card.max_amount_cents > cap))
                for card in body.cards):
            raise Refusal(422, "invalid")
        profiles = self._draft_profiles(desk, enables)
        key = (body.expected_parent, sha256_hex(canonical([card.model_dump(mode="json") for card in body.cards])),
               profiles, cap, tuple(sorted((pin.tool, pin.definition_sha256) for pin in enables)))
        record = next((record for record in desk.versions.values() if record.key == key), None)
        if record is not None and not (record.status == "rejected" and record.proof.timed_out):
            return self._policy_version(desk, record)
        proof = self._next_proof()
        status = "draft" if proof.method == "bounded" else "proved" if proof.ok else "rejected"
        if record is None:
            record = VersionRecord(version=self._next_version(desk), parent=body.expected_parent,
                                   cards=[*body.cards, *self._default_cards(desk, body.cards, enables)], status=status,
                                   proof=proof, key=key, created_at=self.now, auto_money_cap_cents=cap, enables=enables,
                                   profiles=profiles,
                                   enable_profiles={pin.tool: profile_sha256(desk.tools[pin.tool]) for pin in enables})
            desk.versions[record.version] = record
        else:
            record.status, record.proof = status, proof
        self._put_version(desk, record)
        self.append(desk, "policy", {"version": record.version, "status": status, "method": proof.method})
        return self._policy_version(desk, record)

    def policy_confirm(self, request: Request, body: PolicyConfirmRequest) -> PolicyVersion:
        """Activate a proved draft whose parent is still the active version, and whose enables' pins and tools are
        still those it was proved against, superseding it (ledgered `policy`), so its money cap becomes the Desk's;
        anything else is 409, ledgered as refused. An unknown version is 404."""
        desk = self._owners_desk(request, body.desk_id)
        record = desk.versions.get(body.version)
        if record is None:
            raise Refusal(404, "not_found")
        if record.status != "proved" or record.parent != desk.policy_version:
            refused = "not_proved" if record.status != "proved" else "parent_changed"
            self.append(desk, "policy", {"version": record.version, "refused": refused})
            raise Refusal(409, "conflict")
        from desk.kernel_service.adapters import profile_sha256
        if any(pin.tool in desk.tools and desk.tools[pin.tool].source == "business"
               and profile_sha256(desk.tools[pin.tool]) != record.enable_profiles.get(pin.tool)
               for pin in record.enables):
            self.append(desk, "policy", {"version": record.version, "refused": "pin_changed"})
            raise Refusal(409, "conflict")
        if any(pin.tool not in desk.tools
               or pin.definition_sha256 != self._current_tool_pin(desk.tools[pin.tool]) for pin in record.enables):
            self.append(desk, "policy", {"version": record.version, "refused": "pin_changed"})
            raise Refusal(409, "conflict")
        if self._draft_profiles(desk, record.enables) != record.profiles:
            self.append(desk, "policy", {"version": record.version, "refused": "hash_changed"})
            raise Refusal(409, "conflict")
        self._supersede_active(desk)
        for pin in record.enables:
            profile = desk.tools[pin.tool]
            self._put_tool(desk, profile.model_copy(update={
                "status": "enabled", "review_reason": None, "definition_sha256": pin.definition_sha256,
                "pending_definition_text": None, "pending_sha256": None}))
            self.append(desk, "tool_pin", {"tool": pin.tool, "event": "enabled", "version": record.version})
        desk.cards, desk.policy_version, record.status = list(record.cards), record.version, "active"
        desk.auto_money_cap_cents = record.auto_money_cap_cents
        self._put_version(desk, record)
        self.append(desk, "policy", {"version": record.version, "activated": True,
                                     "auto_money_cap_cents": record.auto_money_cap_cents})
        self._cancel_disallowed_links(desk)
        return self._policy_version(desk, record)

    def _cancel_disallowed_links(self, desk: Desk) -> list[str]:
        """Activation rechecks auto-allowed links; single-use owner approvals survive a rule change."""
        decisions = {record.decision.action.action_id: record for record in self.decisions.values()
                     if record.decision.action is not None and record.decision.outcome == "allow"}
        cancelled = []
        for link in self.payment_links.values():
            if link.desk_id != desk.desk_id or link.state != "issued" or link.action_id not in decisions:
                continue
            record = decisions[link.action_id]
            action = record.decision.action
            session = self.sessions[link.session_id]
            who, subject_id = ("agent", session.agent_key_id) if session.kind == "agent" else (
                ("person", session.person_id) if session.verified and session.person_id is not None
                else ("verified" if session.verified else "anyone", None))
            probe = Probe(actor="agent" if session.kind == "agent" else "visitor",
                          who=who, subject_id=subject_id,
                          call=ToolCall(call_id="activation", tool=action.tool, args=self._args[action.action_id]),
                          amount_cents=action.amount_cents, resource_kind=action.resource.kind,
                          starts_at=record.created_at,
                          resource_owner="caller" if session.person_id == action.resource.owner_person_id
                          and session.person_id is not None else "none",
                          agent_mandate_remaining_cents=action.amount_cents if session.kind == "agent" else None)
            # The fake has no reviewer: the link's stored allow already stands for a passing review.
            cards = [card.model_copy(update={"review": False}) for card in desk.cards]
            if (link.amount_cents > desk.auto_money_cap_cents
                    or self._probe(desk, cards, probe).outcome != "allow"):
                link.cancel_reason, link.cancelled_by_version = "rules_changed", desk.policy_version
                self._move_link(link, "cancelled", reason="rules_changed", version=desk.policy_version)
                cancelled.append(link.link_id)
        return cancelled

    def cancelled_links(self, request: Request, body: Any) -> list[LinkCancelled]:
        """Re-reads list the same cancelled links with fresh verdicts at the open session's current generation."""
        desk = self._owners_desk(request, request.query_params.get("desk_id", ""))
        version = int(request.path_params["version"])
        notices = []
        for link in sorted(self.payment_links.values(), key=lambda link: link.link_id):
            session = self.sessions[link.session_id]
            if (link.desk_id != desk.desk_id or link.state != "cancelled" or link.cancel_reason != "rules_changed"
                    or link.cancelled_by_version != version or session.closed_at is not None):
                continue
            language = session.last_language or "en"
            reason = (f"This payment link was cancelled because {desk.owner_display_name}'s rules changed. "
                      "Ask again if you still want to pay." if language == "en" else
                      f"Este enlace de pago se canceló porque cambiaron las reglas de {desk.owner_display_name}. "
                      "Pídelo de nuevo si todavía quieres pagar.")
            title, lines = money(link.amount_cents), [link.title, reason]
            block = RenderedBlock(kind="card", template="link_cancelled", text="\n".join([title, *lines]),
                                  fact_id=f"payment_link:{link.link_id}", title=title, lines=lines)
            verdict = self._verdict(session, desk, language, [block], [], [block.fact_id], author="desk")
            notices.append(LinkCancelled(link_id=link.link_id, session_id=link.session_id, verdict=verdict))
        return notices

    def policy_probe(self, request: Request, body: PolicyProbeRequest) -> list[ProbeResult]:
        """Each probe decided against the version's cards (a draft's or the active one's), one result per probe, with
        nothing resolved, executed or activated; one `policy` entry with the outcomes."""
        desk = self._owners_desk(request, body.desk_id)
        try:
            version = int(request.path_params["version"])
        except ValueError:
            raise Refusal(404, "not_found") from None
        record = desk.versions.get(version)
        if record is None and version != desk.policy_version:
            raise Refusal(404, "not_found")
        cards = record.cards if record is not None else desk.cards
        probe_desk = desk
        if record is not None and record.status not in ('active', 'superseded'):
            from desk.kernel_service.adapters import profile_sha256

            # A hypothetical overlay only: probing must never turn a stored tool on.
            tools = dict(desk.tools)
            for pin in record.enables:
                tool = pin.tool
                profile = desk.tools.get(tool)
                tools.pop(tool, None)     # a stale draft cannot borrow a newer enabled pin
                if (profile is not None and self._current_tool_pin(profile) == pin.definition_sha256
                        and record.enable_profiles.get(tool) == profile_sha256(profile)
                        and (profile.source != 'business' or self._business_profile(desk, tool) is not None)):
                    tools[tool] = profile.model_copy(update={'status': 'enabled',
                                                            'definition_sha256': pin.definition_sha256,
                                                            'pending_definition_text': None, 'pending_sha256': None})
            probe_desk = replace(desk, tools=tools)
        results = [self._probe(probe_desk, cards, probe) for probe in body.probes]
        self.append(desk, "policy", {"version": version, "probes": len(results),
                                     "outcomes": [result.outcome for result in results]})
        return results

    def _probe_tools(self, desk: Desk, probe: Probe, enables: tuple[ToolPin, ...] = ()) -> tuple[str, ...]:
        """The tools a stand-in session of the probe's caller would be given (Answering aside: a probe asks what the
        rules would do once the Desk answers)."""
        if probe.actor == "owner":
            return ()
        verified = probe.who in ("verified", "record_owner", "person")
        given = VERIFIED_TOOLS if verified else UNVERIFIED_TOOLS
        if probe.actor == "agent":
            mandate = probe.agent_mandate_remaining_cents is not None
            given = tuple(tool for tool in given if tool != "payments.create_refund"
                          and (tool not in MANDATE_TOOLS or mandate)) + (("native.charge_mandate",) if mandate else ())
        enabling = {pin.tool for pin in enables}
        given += self._business_tools_given(desk, given)
        return tuple(tool for tool in given if tool in desk.tools
                     and (desk.tools[tool].status == "enabled" or tool in enabling))

    @staticmethod
    def _scope_matches(card: RuleCard, probe: Probe, verified: bool, own: bool) -> bool:
        if card.who == "anyone":
            return True
        if card.who == "verified":
            return verified
        if card.who == "record_owner":
            return own
        subject = probe.subject_id if probe.who == card.who else None
        return subject is not None and subject in (card.person_id, card.agent_key_id)

    def _probe(self, desk: Desk, cards: list[RuleCard], probe: Probe, *,
               enables: tuple[ToolPin, ...] = ()) -> ProbeResult:
        """One probe through the fake's rules: the tool must be given and its args fit; the baseline (private data
        only to its verified record owner, no payouts for agents, an agent's charge within its mandate, an amount
        on every money tool); then a `never` card refuses, an `auto` card whose limits hold allows (a reviewed one
        holds, depending on the reviewer), and anything else asks."""
        tool = probe.call.tool[:64]
        verified = probe.who in ("verified", "record_owner", "person")
        own = verified and probe.resource_owner == "caller"
        caller = "A visiting agent" if probe.actor == "agent" else "A verified customer" if verified else "A visitor"

        def result(outcome: str, card_ids: list[str], reason: str, *, review: bool = False) -> ProbeResult:
            return ProbeResult(probe=probe, outcome=outcome, depends_on_review=review, card_ids=card_ids,
                               reason_plain=f"{caller} asked to use {tool}. {reason}")

        if tool not in self._probe_tools(desk, probe, enables) or not matches(desk.tools[tool].input_schema, probe.call.args):
            return result("refuse", [], "Claude has no such tool for them here.")
        profile = desk.tools[tool]
        if self._business_block(desk, tool) == 'purpose_payment':
            if not 0 < (probe.amount_cents or 0) <= AUTO_MONEY_HARD_CAP_CENTS:
                return result('refuse', [], 'Money moves only for a known positive amount.')
            if probe.amount_cents > desk.auto_money_cap_cents:
                return result('hold', [], 'It would ask you first.')
        discount = probe.call.args.get("requested_discount_bp", 0) if tool == "native.quote" else 0
        amount = probe.amount_cents
        if amount is not None and discount:
            amount -= amount * discount // 10_000
        if "private_data" in profile.effects and not own:
            return result("refuse", [], "Private records go only to the verified person they belong to.")
        if probe.actor == "agent" and "pay_out" in profile.effects:
            return result("refuse", [], "No money is paid out to an agent.")
        if tool in MONEY_TOOLS and amount is None:
            return result("refuse", [], "Money moves only for a known amount.")
        if probe.actor == "agent" and "charge" in profile.effects and (
                probe.agent_mandate_remaining_cents is None or amount > probe.agent_mandate_remaining_cents):
            return result("refuse", [], "An agent pays only within its spending limit.")
        covering = [card for card in cards if (card.applies_to == tool or card.applies_to.removeprefix("effect:")
                                               in profile.effects) and self._scope_matches(card, probe, verified, own)]
        never = [card for card in covering if card.mode == "never"]
        if never:
            return result("refuse", [card.card_id for card in never], never[0].reason)
        moment = probe.starts_at or self.now
        within = [card for card in covering if card.mode == "auto"
                  and (card.max_amount_cents is None or (amount is not None and amount <= card.max_amount_cents))
                  and (tool not in MONEY_TOOLS or amount <= AUTO_MONEY_HARD_CAP_CENTS)
                  and discount <= card.max_discount_bp
                  and (card.hours is None or in_hours(moment, [card.hours], ZoneInfo(desk.timezone)) is not None)]
        asks = [card for card in covering if card.mode == "ask" and not card.is_default]
        if within and not asks:
            card = within[0]
            if card.review:
                return result("hold", [card.card_id], card.reason, review=True)
            return result("allow", [card.card_id], card.reason)
        holding = asks or [card for card in covering if card.mode == "auto"] or [
            card for card in covering if card.is_default]
        card_ids = [card.card_id for card in holding] or [f"default-{tool}"]
        return result("hold", card_ids, holding[0].reason if holding else DEFAULT_REASON)

    # The owner's documents and knowledge (Plan 01b) ---------------------------------------------------

    def documents(self, request: Request, body: DocumentUploadRequest) -> DocumentCreated:
        """The owner's document, through the seed path's writer (`_add_document`), ledgered `desk_data` naming it
        (never its body). A `record_owner_ref` naming no one on record, or a body over 200 KiB, is 422 `invalid`."""
        desk = self._owners_desk(request, body.desk_id)
        seeded = body.document
        if len(seeded.body.encode()) > DOCUMENT_MAX_BYTES or (
                seeded.record_owner_ref is not None
                and not any(person.ref == seeded.record_owner_ref for person in desk.people.values())):
            raise Refusal(422, "invalid")
        document = self._add_document(desk, seeded)
        self.append(desk, "desk_data", {"part": "documents", "refs": [document.document_id]})
        return DocumentCreated(document_id=document.document_id)


    def knowledge(self, request: Request, body: KnowledgeRequest) -> KnowledgeItem:
        """The owner's knowledge item, upserted by `item_id` as given: owner-only (`["owner"]`) or public
        (`["public"]`), so re-posting it with `["public"]` marks it public; any other readers, or text over 100 KiB,
        is 422 `invalid` with nothing written. Ledgered `desk_data` naming the item, never its text."""
        desk = self._owners_desk(request, body.desk_id)
        item = body.item
        if item.label.readers not in (["owner"], ["public"]) or len(item.text.encode()) > KNOWLEDGE_MAX_BYTES:
            raise Refusal(422, "invalid")
        return self._store_knowledge(desk, item)

    # Connected tools (Plan 01c) -----------------------------------------------------------------------


    def put_business_tools(self, request: Request, body: dict) -> DeskUpdated:
        from desk.contracts import BusinessToolDef
        from desk.kernel_api import BusinessToolsRequest
        from desk.kernel_service.adapters import profile_sha256
        from desk.kernel_service.adapters.blocks import profile as block_profile
        from desk.kernel_service import reply_check
        from desk.kernel_service.business_tools import (card_refusal, config_texts, free_allow_words, hidden_fields,
                                                        public_fields)
        from desk.kernel_service.repo import storable

        desk = self._owners_desk(request, request.path_params["id"])

        def refuse(reason: str, *, detail: dict[str, list[str]] | None = None) -> None:
            self.append(desk, "business_tools", {"tools": [], "refused": reason})
            raise Refusal(422, "invalid", detail=detail)

        try:
            batch = BusinessToolsRequest.model_validate(body)
        except ValidationError:
            refuse("business_tools_invalid")
        if len({tool.tool for tool in batch.tools}) != len(batch.tools):
            refuse("business_tools_duplicate")
        if not all(storable(text) for text in config_texts(batch.model_dump(mode="json"))):
            refuse("business_tools_text")
        text = batch.model_dump_json()
        if "\x00" in text or any(document.canary in text for each in self.desks.values()
                                  if each.copy_id == desk.copy_id for document in each.documents.values()):
            refuse("business_tools_canary")
        # The kernel's card-text check: hidden characters first, then one shared scan per tool in render order.
        detail = {}
        for tool in batch.tools:
            values = public_fields(tool)
            detail.update(hidden_fields(values) or card_refusal(
                tool, reply_check.scan_public_policies(values, allow_words=free_allow_words(tool), amenities=False)))
        if detail:
            refuse("public_promise", detail=detail)
        # Build the entire batch before changing any row.
        profiles = [block_profile(tool.tool, BusinessToolDef.model_validate(tool.model_dump(exclude={"tool"})))
                    for tool in batch.tools]
        remaining = {name for name, stored in desk.tools.items() if stored.source == "business"}
        changes = []
        for profile in profiles:
            previous = desk.tools.get(profile.tool)
            change = ("new" if previous is None or previous.status == 'disabled' else "kept"
                      if previous.definition_sha256 == profile.definition_sha256
                      and profile_sha256(previous) == profile_sha256(profile) else "changed")
            if change != "kept":
                self._put_tool(desk, profile.model_copy(update={"review_reason": change}))
            remaining.discard(profile.tool)
            changes.append({"tool": profile.tool, "block": profile.business.config.block,
                            "definition_sha256": profile.definition_sha256, "change": change})
        for name in sorted(remaining):
            previous = desk.tools[name]
            self._put_tool(desk, previous.model_copy(update={"status": "disabled", "review_reason": None}))
            changes.append({"tool": name, "block": previous.business.config.block,
                            "definition_sha256": previous.definition_sha256, "change": "removed"})
        self.append(desk, "business_tools", {"tools": changes})
        return DeskUpdated(desk_id=desk.desk_id, updated_at=self.now)

    @staticmethod
    def _current_tool_pin(profile: ToolProfile) -> str | None:
        return None if profile.review_reason == "delisted" else profile.pending_sha256 or profile.definition_sha256

    def tools_confirm(self, request: Request, body: ToolsConfirmRequest) -> ToolConfirmed:
        """Review one batch atomically: disabling is immediate; enabling drafts the active cards and cap.
        The draft's pins are checked again at explicit policy confirmation."""
        desk = self._owners_desk(request, body.desk_id)

        def refuse(status: int, code: str, reason: str) -> None:
            self.append(desk, "tool_pin", {"tools": [pin.tool for pin in body.tools],
                                          "enable": body.enable, "refused": reason})
            raise Refusal(status, code)

        if not body.enable and any(pin.tool == "native.start_verification" for pin in body.tools):
            refuse(422, "invalid", "always_on")
        if any(pin.tool not in desk.tools for pin in body.tools):
            refuse(404, "not_found", "unknown_tool")
        for pin in body.tools:
            profile = desk.tools[pin.tool]
            if profile.source == "business" and self._business_profile(desk, pin.tool) is None:
                refuse(404, "not_found", "unknown_tool")
            hashes = ({self._current_tool_pin(profile)} if body.enable else
                      {profile.definition_sha256, profile.pending_sha256, self._current_tool_pin(profile)
                       if profile.source == "native" else None})
            if pin.definition_sha256 not in hashes:
                refuse(409, "conflict", "hash_changed")
        draft = None
        if body.enable:
            enables = tuple(pin for pin in body.tools if desk.tools[pin.tool].status != "enabled"
                            or desk.tools[pin.tool].definition_sha256 != pin.definition_sha256)
            if enables:
                if not desk.policy_version:
                    refuse(409, "conflict", "no_active_version")
                draft = self.policy_draft(request, PolicyDraftRequest(
                    desk_id=desk.desk_id, cards=[card for card in desk.cards if not card.is_default],
                    expected_parent=desk.policy_version, auto_money_cap_cents=desk.auto_money_cap_cents),
                    enables=enables)
        else:
            for pin in body.tools:
                profile = desk.tools[pin.tool]
                if profile.status != "disabled":
                    self._put_tool(desk, profile.model_copy(update={"status": "disabled", "review_reason": None}))
                    self.append(desk, "tool_pin", {"tool": pin.tool, "event": "disabled"})
        return ToolConfirmed(profiles=[desk.tools[pin.tool] for pin in body.tools], draft=draft)

    def tools_connect(self, request: Request, body: ToolsConnectRequest) -> list[ToolProfile]:
        """The mock payments server's tools, each pinned by its definition's hash and `needs_review` (`review_reason`
        "new") until the owner confirms it (a tool already connected is left as it is), ledgered `tool_pin`."""
        desk = self._owners_desk(request, body.desk_id)
        profiles = []
        for tool in sorted(MCP_TOOLS):
            if tool not in desk.tools:
                self._put_tool(desk, tool_profile(tool).model_copy(update={"status": "needs_review",
                                                                            "review_reason": "new"}))
            profiles.append(desk.tools[tool])
        self.append(desk, "tool_pin", {"server": body.server, "tools": [profile.tool for profile in profiles]})
        return profiles

    def tools_simulate_change(self, request: Request, body: ToolsSimulateChangeRequest) -> ToolProfile:
        """The owner's demo action: the mock payments server changes the tool's definition for this copy, and the
        re-listing finds it at once (ledgered `tool_pin`, simulated then drift): the changed definition waits as quoted
        text under its own hash, its pin unchanged. An enabled or waiting tool is `needs_review` ("changed") and the
        owner is alerted; a disabled tool stays disabled, with no alert (`mcp_pins.check_pin`). A tool the Desk doesn't
        have is 404; a native tool, which no server defines, is 422 `invalid`."""
        desk = self._owners_desk(request, body.desk_id)
        profile = desk.tools.get(body.tool)
        if profile is None:
            raise Refusal(404, "not_found")
        if profile.source != "mcp":
            raise Refusal(422, "invalid")
        listed = canonical({"name": profile.tool.removeprefix("payments."), "inputSchema": profile.input_schema,
                            "description": f"{TOOL_FACTS[profile.tool][3]} {SIMULATED_CHANGE}"})
        disabled = profile.status == "disabled"
        review = {} if disabled else {"status": "needs_review", "review_reason": "changed"}
        changed = profile.model_copy(update={**review, "pending_definition_text": listed,
                                             "pending_sha256": sha256_hex(listed)})
        self._put_tool(desk, changed)
        self.append(desk, "tool_pin", {"tool": profile.tool, "event": "simulated"})
        self.append(desk, "tool_pin", {"tool": profile.tool, "event": "drift", "status": changed.status,
                                       "definition_sha256": changed.definition_sha256,
                                       "pending_sha256": changed.pending_sha256})
        if not disabled:
            self._alert_owner(desk, "A connected tool changed",
                              f"{TOOL_LABELS[profile.tool]} changed. Review it before Claude uses it again.")
        return changed

    # Verification --------------------------------------------------------------------------------

    def _start_challenge(self, session: Session, desk: Desk, contact: str) -> tuple[str, list[InboxNotice]]:
        """`/verify/start` semantics (Plan 01b): one message whether or not the contact is on record, and a code for
        the contact on record only, in a new challenge (a Demo inbox entry and its code-free notice). Starting cancels
        the session's live challenge, so an older code can't reveal the outcome, and the person's in any session; a
        contact not on record becomes a lead note. Ledgered `verify` with the outcome, never the code or contact."""
        texts = VERIFY_TEXT[session.last_language or "en"]
        if session.verified:
            self.append(desk, "verify", {"outcome": "already_verified"}, session_id=session.session_id)
            return texts["already"], []
        wanted = normalize_contact(contact)
        person = next((person for person in desk.people.values()
                       if wanted and normalize_contact(person.contact) == wanted), None)
        for challenge in self.challenges.values():
            if challenge.status == "live" and (challenge.session_id == session.session_id or (
                    person is not None and challenge.person_id == person.person_id)):
                challenge.status = "cancelled"
        if person is None:
            lead_id = new_id("lead")
            self._put("leads", (lead_id,), {
                "lead_id": lead_id, "copy_id": desk.copy_id, "desk_id": desk.desk_id, "session_id": session.session_id,
                "display_name": "Visitor", "note": f"Asked to verify as {contact.strip()[:120]}",
                "created_at": self.now})
            self.append(desk, "verify", {"outcome": "not_on_record"}, session_id=session.session_id)
            return texts["started"], []
        code, masked = f"{secrets.randbelow(1_000_000):06d}", mask_contact(person.contact)
        entry = DemoInboxEntry(entry_id=new_id("inbox"), to=masked, kind="verification_code",
                               body=texts["body"].format(business=desk.business_name, code=code), created_at=self.now)
        self.inbox.append((desk.copy_id, entry))
        challenge = Challenge(challenge_id=new_id("challenge"), session_id=session.session_id,
                              person_id=person.person_id, code=code, entry_id=entry.entry_id,
                              expires_at=self.now + CODE_TTL)
        self.challenges[challenge.challenge_id] = challenge
        self.append(desk, "verify", {"outcome": "started", "challenge_id": challenge.challenge_id},
                    session_id=session.session_id)
        return texts["started"], [InboxNotice(entry_id=entry.entry_id, to=masked, preview=texts["preview"])]

    def verify_start(self, request: Request, body: VerifyStartRequest) -> VerifyStarted:
        """A visitor asks for a code; mode `owner` may, a paused session can't (409 `mode_paused`)."""
        session, desk = self.session_call(request, body.session_id)
        if session.mode == "paused":
            raise Refusal(409, "mode_paused")
        message, inbox = self._start_challenge(session, desk, body.contact)
        return VerifyStarted(message=message, inbox=inbox)

    def verify_check(self, request: Request, body: VerifyCheckRequest) -> SessionState:
        """The code of the session's live challenge verifies it once, as the person on record; every failure (no live
        challenge, an expired one, a wrong code, a fifth wrong code failing the challenge) is 422 `invalid` alike, after
        its `verify` entry. A verified session stays as it is."""
        session, desk = self.session_call(request, body.session_id)
        if session.verified:
            self.append(desk, "verify", {"outcome": "already_verified"}, session_id=session.session_id)
            return session.state()
        challenge = next((challenge for challenge in self.challenges.values()
                          if challenge.session_id == session.session_id and challenge.status == "live"), None)
        if challenge is not None and self.now > challenge.expires_at:
            challenge.status = "expired"
            challenge = None
        if challenge is None:
            self.append(desk, "verify", {"outcome": "no_challenge"}, session_id=session.session_id)
            raise Refusal(422, "invalid")
        if not hmac.compare_digest(body.code.encode(), challenge.code.encode()):
            challenge.attempts += 1
            if challenge.attempts >= MAX_ATTEMPTS:
                challenge.status = "failed"
            self.append(desk, "verify", {"outcome": "wrong_code", "challenge_id": challenge.challenge_id},
                        session_id=session.session_id)
            raise Refusal(422, "invalid")
        challenge.status = "consumed"
        self._mark_verified(session, desk, desk.people[challenge.person_id])
        self.append(desk, "verify", {"outcome": "verified", "challenge_id": challenge.challenge_id},
                    session_id=session.session_id)
        return session.state()

    def session_inbox(self, request: Request, body: Any) -> list[DemoInboxEntry]:
        """The session's Demo inbox: the `verification_code` entries of the challenges it started, or an agent
        session opened with a demo agent's key it minted started (the kernel's `agents.minted_sessions`), oldest
        first; never another session's code for the same person, an alert or a head checkpoint, nor the codes of an
        agent another session or the owner minted."""
        session, _ = self.session_call(request, self._query(request, "session_id"))
        minted = {key.agent_key_id for key in self.agent_keys.values() if key.minted_by == session.session_id}
        started_by = {session.session_id} | {agent.session_id for agent in self.sessions.values()
                                              if agent.kind == "agent" and agent.agent_key_id in minted}
        entries = {challenge.entry_id for challenge in self.challenges.values() if challenge.session_id in started_by}
        return [entry for copy_id, entry in self.inbox
                if copy_id == session.copy_id and entry.kind == "verification_code" and entry.entry_id in entries]

    # Single-use links ----------------------------------------------------------------------------

    def document_link(self, request: Request, body: Any) -> Response:
        """The document a link token names, once and within a day: its bytes with its content type (`text/plain`) and
        any other headers it carries, the link opened and its fact expired, ledgered `document_link`
        `{link_id, opened}`. Opened, expired or unknown → 404 `not_found` alike (a known link's refusal ledgered
        `{link_id, refused}`). The token authenticates only its own document."""
        link = next((link for link in self.document_links.values()
                     if hmac.compare_digest(link.token.encode(), request.path_params["token"].encode())), None)
        if link is None:
            raise Refusal(404, "not_found")
        desk = self.desks[link.desk_id]
        if link.opened_at is not None or self.now >= link.expires_at:
            self.append(desk, "document_link", {"link_id": link.link_id, "refused": True},
                        session_id=link.session_id)
            raise Refusal(404, "not_found")
        link.opened_at = self.now
        fact = desk.facts[f"document_link:{link.link_id}"]
        self._put_fact(desk, fact.model_copy(update={"status": "expired"}))
        self.append(desk, "document_link", {"link_id": link.link_id, "opened": True}, session_id=link.session_id)
        document = desk.documents[link.document_id]
        headers = dict(document.headers)
        if document.disposition:
            headers["Content-Disposition"] = document.disposition
        return Response(document.body.encode(), media_type=document.content_type, headers=headers)

    def _payment_link(self, request: Request) -> PaymentLink:
        """The payment link a token names (404 `not_found` for none), lazily expired a day after it was issued."""
        token = request.path_params["token"].encode()
        link = next((link for link in self.payment_links.values()
                     if hmac.compare_digest(link.token.encode(), token)), None)
        if link is None:
            raise Refusal(404, "not_found")
        if link.state == "issued" and self.now >= link.expires_at:
            self._move_link(link, "expired")
        return link

    def _move_link(self, link: PaymentLink, state: str, **summary) -> None:
        """The link leaves `issued`: its fact expires, and the move is mirrored and ledgered `payment`."""
        desk = self.desks[link.desk_id]
        if link.state == 'issued' and link.mandate_id is not None:
            mandate = self.mandates[link.mandate_id]
            mandate.reserved_cents -= link.amount_cents
            if state == 'paid':
                mandate.committed_cents += link.amount_cents
            self._put('mandates', (link.mandate_id,), mandate.ro_row())
        link.state = state
        fact = desk.facts.get(f"payment_link:{link.link_id}")
        if fact is not None:
            self._put_fact(desk, fact.model_copy(update={"status": "expired"}))
        self._put("payment_links", (link.link_id,), link.ro_row())
        self.append(desk, "payment", {"link_id": link.link_id, "state": state, **summary},
                    session_id=link.session_id)

    def _issued(self, link: PaymentLink, step: str) -> None:
        """Completing or cancelling needs an `issued` link; anything else is 409 `conflict`, ledgered."""
        if link.state != "issued":
            self.append(self.desks[link.desk_id], "payment", {"link_id": link.link_id, "step": step,
                                                              "refused": True, "state": link.state},
                        session_id=link.session_id)
            raise Refusal(409, "conflict")

    def payment_link_view(self, request: Request, body: Any) -> PaymentLinkView:
        """What the mock checkout shows, by the link's token alone, in its session's last language: the Desk's
        business name as its public page names it, the customer by first name and last initial while the link is
        issued and was made in a visitor session still verified as that person, who is still on record (else None),
        and `rules_changed` for a link a rule change cancelled."""
        link = self._payment_link(request)
        desk, session = self.desks[link.desk_id], self.sessions[link.session_id]
        person = desk.people.get(link.customer_person_id) if link.customer_person_id is not None else None
        customer = None
        if link.state == "issued" and person is not None and session.person_id == person.person_id:
            words = person.display_name.split()
            customer = (words[0] if len(words) == 1 else f"{words[0]} {words[-1][0]}.") if words else None
        rules_changed = link.state == "cancelled" and link.cancel_reason == "rules_changed"
        return PaymentLinkView(title=link.title, amount_cents=link.amount_cents, state=link.state,
                               language=session.last_language or "en", business_name=desk.business_name,
                               customer_name=customer, cancel_reason="rules_changed" if rules_changed else None)

    def _open_purpose_link(self, session: Session, desk: Desk, action: NormalizedAction) -> PaymentLink | None:
        """The session's newest open link from an earlier call of the purpose payment tool, at its purpose and
        amount, on a quote still unpaid (the kernel's open-link answer for a repeated purpose payment)."""
        config = desk.tools[action.tool].business.config
        if config.amount_cents != action.amount_cents:
            return None
        return next((link for link in reversed(self.payment_links.values())
                     if link.desk_id == desk.desk_id and link.session_id == session.session_id
                     and link.title == config.purpose and link.amount_cents == action.amount_cents
                     and self.quotes[link.quote_id]['items'][0]['item_id'] == action.tool
                     and self.quotes[link.quote_id]['status'] == 'available'
                     and self._open_link(link.quote_id) is link), None)

    def _open_link(self, quote_id: str) -> PaymentLink | None:
        """The quote's open link (issued and unexpired), if it has one."""
        return next((link for link in self.payment_links.values() if link.quote_id == quote_id
                     and link.state == "issued" and link.expires_at > self.now), None)

    def _quote_paid(self, quote: dict) -> None:
        """A quote is paid once (Plan 01c): `paid` once a mandate charge or a link's completion pays it."""
        quote["status"] = "paid"
        self._put("quotes", (quote["quote_id"],), dict(quote))

    def payment_link_complete(self, request: Request, body: Any) -> PaymentLinkStateResult:
        """The mock payment: an `issued` link is paid once (no provider in the fake), a `charge` fact goes to its
        session, and the answer carries the kernel's `payment_confirmed` verdict for that session at its current
        generation, ledgered `reply` by the Desk, in any mode (`deliver()` decides whether it is shown)."""
        link = self._payment_link(request)
        self._issued(link, "complete")
        desk, session = self.desks[link.desk_id], self.sessions[link.session_id]
        charge_id = new_id("charge")
        charge = Fact(fact_id=f"charge:{charge_id}", kind="charge", status="committed", source="kernel",
                      label=self._label(session), claims=[
                          Claim(key="total", kind="money", value=link.amount_cents),
                          Claim(key="starts_at", kind="datetime", value=self.now.isoformat()),
                          Claim(key="ref", kind="ref", value=charge_id)])
        self._put_fact(desk, charge)
        self._move_link(link, "paid")
        self._quote_paid(self.quotes[link.quote_id])
        language = session.last_language or "en"
        title, lines = PAYMENT_CONFIRMED[language], [link.title, money(link.amount_cents)]
        block = RenderedBlock(kind="card", template="payment_confirmed", text="\n".join([title, *lines]),
                              fact_id=charge.fact_id, title=title, lines=lines)
        verdict = self._verdict(session, desk, language, [block], [], [charge.fact_id], author="desk")
        return PaymentLinkStateResult(state="paid", session_id=session.session_id, verdict=verdict)

    def payment_link_cancel(self, request: Request, body: Any) -> PaymentLinkStateResult:
        """The visitor cancels an `issued` link at checkout: nothing is paid and there is no verdict."""
        link = self._payment_link(request)
        self._issued(link, "cancel")
        self._move_link(link, "cancelled")
        return PaymentLinkStateResult(state="cancelled", session_id=link.session_id, verdict=None)

    # Demo agents ---------------------------------------------------------------------------------

    def demo_agent(self, request: Request, body: DemoAgentRequest) -> DemoAgentIssued:
        """A simulated third party for the Desk: minted by its copy's owner or by a visitor session on it (404 for
        another Desk; 409 `closed` for a deleted one, whose sessions are closed too), ten per copy an hour (then 429
        `rate_limited`, ledgered `rate_limit`). Its private key is returned once and kept nowhere; its mandate is
        signed by the copy's demo wallet, made on first use. Ledgered `agent_auth` without a key."""
        if request.headers.get("x-owner-session") is not None:
            copy, _ = self.owner_of(request)
            if body.desk_id not in copy.desk_ids:
                raise Refusal(404, "not_found")
            if self.desks[body.desk_id].deleted_at is not None:
                raise self._refused(self.desks[body.desk_id], 409, "closed", "closed")
            minted_by = "owner"
        else:
            caller = self.visitor_of(request)
            if caller.desk_id != body.desk_id:
                raise Refusal(404, "not_found")
            self._check_open(caller)
            minted_by = caller.session_id
        desk = self.desks[body.desk_id]
        recent = [at for copy_id, at in self.minted if copy_id == desk.copy_id and self.now - at < timedelta(hours=1)]
        if len(recent) >= DEMO_AGENTS_PER_COPY_PER_HOUR:
            self.append(desk, "rate_limit", {"limit": "demo_agents"})
            raise Refusal(429, "rate_limited")
        private = Ed25519PrivateKey.generate()
        public_hex = _public_hex(private)
        key = AgentKey(agent_key_id=sha256_hex(bytes.fromhex(public_hex))[:16], copy_id=desk.copy_id,
                       desk_id=desk.desk_id, public_key_hex=public_hex, minted_by=minted_by, created_at=self.now)
        self.agent_keys[key.agent_key_id] = key
        wallet = self.wallets.setdefault(desk.copy_id, Ed25519PrivateKey.generate())
        unsigned = Mandate(mandate_id=new_id("mandate"), issuer=DEMO_WALLET, agent_key_id=key.agent_key_id,
                           desk_id=desk.desk_id, on_behalf_of="Demo visitor", allowed_effects=["charge"],
                           currency="usd", expires_at=signed_time(self.now + DEMO_MANDATE_LIFE),
                           nonce=secrets.token_hex(16), sig="", **DEMO_MANDATE)
        mandate = unsigned.model_copy(update={"sig": wallet.sign(mandate_payload(unsigned)).hex()})
        self.minted.append((desk.copy_id, self.now))
        self.append(desk, "agent_auth", {"agent_key_id": key.agent_key_id, "mandate_id": mandate.mandate_id,
                                         "minted_by": "owner" if minted_by == "owner" else "session"})
        private_hex = private.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption()).hex()
        return DemoAgentIssued(agent_key_id=key.agent_key_id, agent_private_key_hex=private_hex, mandate=mandate)

    # Ledger --------------------------------------------------------------------------------------

    def ledger_append(self, request: Request, body: LedgerAppendRequest) -> LedgerEntry:
        """An API-origin `session`, `rate_limit` or `agent_auth` entry (the body model refuses other kinds) on the
        caller's own Desk, naming no session but the caller's."""
        if self._signed_by_agent(request):
            caller = self._agent(request, body.event.session_id or "")
            if body.desk_id != caller.desk_id:
                raise Refusal(404, "not_found")
            self._check_open(caller)
        elif request.headers.get("x-owner-session") is not None:
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
        """The Desk's ledger, verified as the kernel verifies it: each entry's hash, link and signature."""
        copy, _ = self.owner_of(request)
        desk_id = request.path_params["desk_id"]
        if desk_id not in copy.desk_ids:
            raise Refusal(404, "not_found")
        entries = list(self.desks[desk_id].ledger)
        first_bad = first_bad_seq(entries)
        return LedgerPage(entries=entries, head=entries[-1].hash if entries else GENESIS, chain_ok=first_bad is None,
                          first_bad_seq=first_bad, public_key_hex=PUBLIC_KEY_HEX, key_id=KEY_ID)

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
        return self._refresh(self.decisions[known]).model_copy(update={"owner_plain": None})


def first_bad_seq(entries: list[LedgerEntry]) -> int | None:
    """The first entry whose hash, link to the one before or (fake) signature doesn't check out, else None."""
    prev_hash = GENESIS
    for entry in entries:
        envelope = entry.model_dump(mode="json", include={"copy_id", "desk_id", "seq", "prev_hash", "created_at",
                                                          "event"})
        digest = sha256_hex(canonical(envelope))
        signature = "fake:" + sha256_hex(b"desk-ledger-v1\0" + bytes.fromhex(digest))
        if entry.prev_hash != prev_hash or entry.hash != digest or entry.signature != signature:
            return entry.seq
        prev_hash = entry.hash
    return None


# Routing -----------------------------------------------------------------------------------------

def _route_path(key: str) -> tuple[str, str]:
    method, _, target = key.partition(" ")
    return method, target.partition("?")[0]


# The kernel's own name for a route whose path parameter it names otherwise than the contract's key.
KERNEL_TEMPLATES = {"GET /decisions/{id}": "GET /decisions/{decision_id}"}


def route_template(key: str) -> str:
    """The route a `KERNEL_ROUTES` key names, as the kernel's ledger names it (`repo.route_template`): the method and
    the path template, without the query."""
    template = " ".join(_route_path(key))
    return KERNEL_TEMPLATES.get(template, template)


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


# The answers `fail` can give in place of the route's, by status, with each one's KernelError code.
FAILURE_CODES = {"500": "internal", "422": "invalid", "409": "conflict"}

# The routes this fake answers, by KERNEL_ROUTES key, with the state method that answers each.
FAKE_ROUTES: dict[str, str] = {
    "PUT /desks/{id}/business_tools": "put_business_tools",
    "GET /health": "health",
    "POST /copies": "create_copy",
    "GET /public/{desk_slug}": "public_desk",
    "POST /sessions": "create_session",
    "POST /sessions/{id}/mode": "session_mode",
    "GET /whoami": "whoami",
    "POST /sessions/{session_id}/turn": "turn",
    "GET /context/{session_id}?desk_id=": "context",
    "POST /decide": "decide",
    "GET /decisions/by_call?session_id=&generation=&call_id=": "decision_by_call",
    "GET /decisions/{id}": "read_decision",
    "POST /execute": "execute",
    "POST /decisions/{decision_id}/cancel": "cancel",
    "POST /approvals/{decision_id}/answer": "answer",
    "POST /check_reply": "check_reply",
    "POST /owner/messages": "owner_message",
    "POST /ledger/append": "ledger_append",
    "GET /ledger/{desk_id}?verify=true": "ledger_page",
    "POST /desks": "create_desk",
    "PUT /desks/{id}/business": "put_business",
    "PUT /desks/{id}/answering": "answering",
    "PUT /desks/{id}/charter": "desk_charter",
    "PUT /desks/{id}/memory": "desk_memory",
    "PUT /desks/{id}/hours": "desk_hours",
    "PUT /desks/{id}/prices": "desk_prices",
    "PUT /desks/{id}/calendar": "desk_calendar",
    "PUT /desks/{id}/people": "desk_people",
    "PUT /desks/{id}/notifications": "desk_notifications",
    "POST /policy/draft": "policy_draft",
    "POST /policy/{version}/probe": "policy_probe",
    "POST /policy/confirm": "policy_confirm",
    "GET /policy/{version}/cancelled_links?desk_id=": "cancelled_links",
    "POST /tools/connect": "tools_connect",
    "POST /tools/confirm": "tools_confirm",
    "POST /knowledge": "knowledge",
    "POST /documents": "documents",
    "POST /tools/simulate_change": "tools_simulate_change",
    "DELETE /desks/{id}": "delete_desk",
    "POST /handoffs/{id}/done": "handoff_done",
    "GET /demo_inbox": "owner_inbox",
    "GET /demo_inbox?session_id=": "session_inbox",
    "POST /verify/start": "verify_start",
    "POST /verify/check": "verify_check",
    "GET /document_links/{token}": "document_link",
    "GET /payment_links/{token}": "payment_link_view",
    "POST /payment_links/{token}/complete": "payment_link_complete",
    "POST /payment_links/{token}/cancel": "payment_link_cancel",
    "POST /agents/demo": "demo_agent",
}


def _error(status: int, code: str, detail: dict[str, list[str]] | None = None) -> Response:
    return Response(KernelError(code=code, detail=detail).model_dump_json(exclude_none=True),
                    status_code=status, media_type="application/json")


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
        gate = state._gates.get(key)
        if gate is not None:
            await gate.wait()
        failure = state._take_failure(key)
        if failure == "timeout":
            raise httpx.ReadTimeout("the fake kernel timed out")
        if failure == "connect":
            raise httpx.ConnectError("the fake kernel refused the connection")
        if failure is not None:
            return _error(int(failure), FAILURE_CODES[failure])
        try:
            body = body_json if key == "PUT /desks/{id}/business_tools" else _parse(request_model, raw)
            state._route = route_template(key)     # handlers don't await, so no other call answers meanwhile
            result = handler(request, body)
        except Refusal as refusal:
            result = refusal
        finally:
            state.flush()
        if state._take_drop(key):
            raise httpx.ReadTimeout("the fake kernel committed, then timed out")
        if isinstance(result, Refusal):
            return _error(result.status, result.code, result.detail)
        if isinstance(result, Response):                # a document's bytes
            return result
        if response_adapter is None:
            return Response(status_code=204)
        payload = response_adapter.dump_json(result)
        response_adapter.validate_json(payload)    # as JSON: validate_python accepts any instance of the model
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


def _query_names(key: str) -> frozenset[str]:
    """The query parameters a `KERNEL_ROUTES` key names ("GET /demo_inbox?session_id=" → {"session_id"})."""
    query = key.partition("?")[2]
    return frozenset(part.partition("=")[0] for part in query.split("&") if part)


def _by_query(endpoints: list[tuple[str, Callable]]):
    """One endpoint for the routes sharing a method and path: the first, most parameters first, whose query
    parameters the request all carries (the one naming none always does)."""
    ordered = sorted(endpoints, key=lambda found: -len(_query_names(found[0])))

    async def endpoint(request: Request) -> Response:
        for key, handler in ordered:
            if _query_names(key) <= set(request.query_params):
                return await handler(request)
        return _error(404, "not_found")

    return endpoint


def fake_kernel_app(state: FakeKernelState) -> Router:
    """The fake kernel as an ASGI app over `state`. Routes sharing a method and path (the session's and the owner's
    `GET /demo_inbox`) are told apart by their query (`_by_query`)."""
    shared: dict[tuple[str, str], list[tuple[str, Callable]]] = {}
    for key, method_name in FAKE_ROUTES.items():
        shared.setdefault(_route_path(key), []).append((key, _endpoint(state, key, getattr(state, method_name))))
    routes = [Route(path, endpoints[0][1] if len(endpoints) == 1 else _by_query(endpoints), methods=[method])
              for (method, path), endpoints in shared.items()]
    return Router(routes=routes, default=_not_found)
