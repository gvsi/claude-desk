"""The golden Desk the decide table runs on, and the steps a row takes before its call.

`golden_desk(k)` travels to Tuesday 2026-11-03 10:00 business time and makes a fresh Turner copy,
naming its seed entries by role: item `drain` (price P), slots `wk` (a weekday 10:00 slot) and
`sat` (a Saturday slot), people `dana` and `bob`, Dana's invoice and, from Plan 01c, her $250
charge. It needs no Desk writes, so it runs from Plan 01a. `custom=True` (Plan 01b) replaces the
price list and calendar with the seed's rows plus test items and slots (`CUSTOM_ITEMS`,
`CUSTOM_SLOTS`). On the real kernel the roles are read from `kernel_ro`; on the contract stub they
are stand-ins of the same shape.

A row of `golden/decide.yaml` (`Row`, `load_rows`) names its cards or the seed's, its caller, its
call and the decision it expects. The helpers here run what a row needs first: the caller's
session (`open_caller`, which verifies Dana or Bob through their own Demo inbox entries or mints
a demo agent), any quote its call names (`make_quote`), and its cards as the Desk's whole rule
set (`confirm_cards`). Nothing here imports kernel code.
"""

import re
import secrets
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal, get_args
from zoneinfo import ZoneInfo

import yaml
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, ValidationError, model_validator

from desk.contracts import (
    CopyCreated,
    Decision,
    DemoAgentIssued,
    DemoInboxEntry,
    HoursWindow,
    PolicyVersion,
    Review,
    RuleCard,
    SessionState,
    ToolName,
)
from evals.fakes import HttpError, Json, Refusal, Reply, Sleep, Text
from evals.oracles import expiry_lines
from evals.tier1.args import (
    book_args,
    charge_mandate_args,
    find_slots_args,
    payment_link_args,
    quote_args,
    refund_args,
    release_document_args,
    schema_mismatches,
)
from evals.tier1.harness import KERNEL_PLANS, PLANS, AgentTurns, Auth, Expect, KernelHarness, check_expect_paths
from evals.tier1.stub import STUB_SLUG

GOLDEN_DIR = Path(__file__).resolve().parent / "golden"

# Time and the seed ("Turner seed")

TIMEZONE = "America/Los_Angeles"   # the Turner seed's business time zone
_TZ = ZoneInfo(TIMEZONE)
START = datetime(2026, 11, 3, 10, 0, tzinfo=_TZ)   # Tuesday 10:00 business time, when a golden copy is made
P = 18_000   # the seed's drain clearing price, in cents: the table's P
CONTACTS = {"dana": "dana@example.com", "bob": "bob@example.com"}   # the seed's contacts on record
# The seed's price list, as the stub's stand-in for its kernel_ro rows.
STAND_IN_PRICES = [
    {"item_id": "deposit", "title": "Service call deposit", "unit_cents": 2_000},
    {"item_id": "drain", "title": "Drain clearing", "unit_cents": P},
    {"item_id": "heater", "title": "Water heater flush", "unit_cents": 15_000},
    {"item_id": "leak", "title": "Leak repair", "unit_cents": 25_000},
    {"item_id": "pipe", "title": "Pipe repair (starting price)", "unit_cents": 10_000},
    {"item_id": "short-notice", "title": "Short-notice fee", "unit_cents": 5_000},
]
SEED_ITEMS = tuple(row["item_id"] for row in STAND_IN_PRICES)
SEED_TITLES = {row["item_id"]: row["title"] for row in STAND_IN_PRICES}   # the item text a quote card names
QUOTE_LIFE = timedelta(hours=72)   # a quote stays available for 72 hours after it is made (Plan 01a)
SEED_SLOT_MINUTES = 120


@dataclass(frozen=True)
class Slot:
    slot_id: str
    starts_at: datetime


def _slot(local: datetime) -> Slot:
    """A slot by its local start, with the seed's id form `S-<yyyymmdd>-<hhmm>`."""
    return Slot(local.strftime("S-%Y%m%d-%H%M"), local)


# The seed's slots by role: a weekday 10:00 slot and a Saturday slot, in the week after START.
SEED_SLOTS = {
    "wk": _slot(datetime(2026, 11, 4, 10, 0, tzinfo=_TZ)),    # Wednesday
    "sat": _slot(datetime(2026, 11, 7, 9, 0, tzinfo=_TZ)),    # Saturday
}

# What `custom=True` adds (Plan 01b): items priced as named, and slots by role around the hours
# rows' edges (a Mon-Fri 08:00-17:00 window, whose end is exclusive).
CUSTOM_ITEMS = {"v20": 2_000, "v25": 2_500, "v80": 8_000, "v120": 12_000, "v800": 80_000}
CUSTOM_SLOTS = {
    "tue-0800": _slot(datetime(2026, 11, 10, 8, 0, tzinfo=_TZ)),     # also a seed slot, kept once
    "tue-1659": _slot(datetime(2026, 11, 10, 16, 59, tzinfo=_TZ)),
    "tue-1700": _slot(datetime(2026, 11, 10, 17, 0, tzinfo=_TZ)),
    "sun22": _slot(datetime(2026, 11, 8, 22, 0, tzinfo=_TZ)),        # Sunday night
}
CUSTOM_SLOT_MINUTES = 60

# Each tool's resource kind ("Model-visible tools"), for setup probes.
RESOURCE_KINDS = {
    "native.quote": "desk", "native.find_slots": "desk", "native.book": "slot", "native.release_document": "document",
    "native.payment_link": "quote", "native.charge_mandate": "quote", "native.capture_lead": "desk",
    "native.request_callback": "desk", "native.start_verification": "desk", "payments.list_charges": "charge",
    "payments.create_refund": "charge", "native.fetch_website": "desk", "native.read_memory": "desk", "native.web_search": "desk",
}

REVIEWER_MODEL = "claude-sonnet-5-5"
# The reviewer's passing reply: full marks, no manipulation, allow.
REVIEW_PASS: dict[str, Any] = Review(within_charter_bp=10_000, manipulation_bp=0, recommendation="allow").model_dump()
STUB_CODE = "000000"   # the code a stub case sends: the stub's inbox holds generated text, not a code


# The golden Desk

@dataclass
class GoldenDesk:
    """A fresh Turner copy's first Desk, with its seed entries by role."""

    copy: CopyCreated
    desk_id: str
    slug: str
    prices: dict[str, int]      # item_id -> unit cents, the seed's (CUSTOM_ITEMS join them when custom)
    slots: dict[str, Slot]      # the seed's slots by role ("wk", "sat")
    people: dict[str, str]      # "dana", "bob" -> person_id
    documents: dict[str, str]   # "dana-invoice" -> document_id
    charges: dict[str, str]     # "dana-250" -> charge_id, from Plan 01c

    @property
    def owner(self) -> Auth:
        return Auth.owner(self.copy)

    def slot(self, role: str) -> Slot:
        """A slot by role: the seed's, or a custom one (on the Desk's calendar only when custom)."""
        return self.slots[role] if role in self.slots else CUSTOM_SLOTS[role]


async def golden_desk(k: KernelHarness, custom: bool = False) -> GoldenDesk:
    """A fresh Turner copy made at START, its seed entries named by role; `custom` (Plan 01b) adds
    CUSTOM_ITEMS and CUSTOM_SLOTS to its price list and calendar."""
    k.clock.travel(START)
    desk = await desk_of(k, await k.new_copy())
    if custom:
        await _customize(k, desk)
    return desk


async def desk_of(k: KernelHarness, copy: CopyCreated) -> GoldenDesk:
    """A copy made since `golden_desk` travelled to START, its seed entries named by role: a second
    copy made this way has the same seed slot ids as the first, and the clock never runs back."""
    return await _read_seed(k, copy) if k.is_real else _stand_in(copy)


async def _read_seed(k: KernelHarness, copy: CopyCreated) -> GoldenDesk:
    records, copy_id, desk_id = k.records, copy.copy_id, copy.desk_ids[0]

    async def rows(view: str) -> list[dict[str, Any]]:
        return [row for row in await getattr(records, view)(copy_id) if row["desk_id"] == desk_id]

    desks = await rows("desks")
    assert len(desks) == 1, f"kernel_ro.desks has {len(desks)} rows for the copy's Desk"
    [business] = [row for row in await records.businesses(copy_id) if row["business_id"] == desks[0]["business_id"]]
    assert business["timezone"] == TIMEZONE, business
    prices = {row["item_id"]: row["unit_cents"] for row in await rows("price_items")}
    assert prices.get("drain") == P, f"the table's P is the seed's drain price, {P} cents: {prices}"
    people = {row["display_name"].split()[0].lower(): row["person_id"] for row in await rows("people")}
    assert {"dana", "bob"} <= people.keys(), people
    documents = await rows("documents")
    invoices = [row["document_id"] for row in documents if row["record_owner_person_id"] == people["dana"]]
    assert len(invoices) == 1, f"the seed gives Dana one document, not {invoices}"
    charges = {}
    if k.landed("01c"):
        charges["dana-250"] = charge_id(await rows("facts"), people["dana"], 25_000, "Leak repair")
    slots = seed_slots(await rows("calendar_slots"))
    return GoldenDesk(
        copy=copy, desk_id=desk_id, slug=desks[0]["slug"], prices=prices, slots=slots, people=people,
        documents={"dana-invoice": invoices[0]}, charges=charges,
    )


def _stand_in(copy: CopyCreated) -> GoldenDesk:
    return GoldenDesk(
        copy=copy, desk_id=copy.desk_ids[0], slug=STUB_SLUG,
        prices={row["item_id"]: row["unit_cents"] for row in STAND_IN_PRICES}, slots=dict(SEED_SLOTS),
        people={"dana": "stub-person-dana", "bob": "stub-person-bob"},
        documents={"dana-invoice": "stub-document-dana-invoice"}, charges={"dana-250": "stub-charge-dana-250"},
    )


async def _customize(k: KernelHarness, desk: GoldenDesk) -> None:
    """Replace the price list and calendar with the seed's rows plus the custom ones."""
    if k.is_real:
        copy_id = desk.copy.copy_id
        seed_prices = [row for row in await k.records.price_items(copy_id) if row["desk_id"] == desk.desk_id]
        seed_calendar = [row for row in await k.records.calendar_slots(copy_id) if row["desk_id"] == desk.desk_id]
    else:
        seed_prices = STAND_IN_PRICES
        seed_calendar = [{"slot_id": slot.slot_id, "starts_at": slot.starts_at, "minutes": SEED_SLOT_MINUTES}
                         for slot in SEED_SLOTS.values()]
    updated = Expect(fields={"desk_id": desk.desk_id})
    await k.call("PUT /desks/{id}/prices", path={"id": desk.desk_id}, body={"price_items": custom_prices(seed_prices)},
                 auth=desk.owner, expect=updated)
    await k.call("PUT /desks/{id}/calendar", path={"id": desk.desk_id},
                 body={"calendar_slots": custom_calendar(seed_calendar)}, auth=desk.owner, expect=updated)
    desk.prices.update(CUSTOM_ITEMS)


# Callers

CallerName = Literal["visitor", "dana", "bob", "agent", "agent-no-mandate"]


@dataclass
class Caller:
    """A session that calls tools: its state (kept current) and the credential its calls carry."""

    name: str
    state: SessionState
    auth: Auth

    def turn(self) -> None:
        """An agent's next A2A turn: a fresh signed nonce naming its session. A token needs none."""
        if isinstance(self.auth, AgentTurns):
            self.auth.new_turn(session_id=self.state.session_id)


async def open_caller(k: KernelHarness, desk: GoldenDesk, name: CallerName) -> Caller:
    """A row's caller: an unverified visitor, Dana or Bob verified, or a demo agent with or without its mandate."""
    if name == "visitor":
        return await visitor(k, desk)
    if name in ("dana", "bob"):
        return await verified(k, desk, name)
    if name in ("agent", "agent-no-mandate"):
        return await agent(k, desk, mandate=name == "agent")
    raise ValueError(f"unknown caller {name!r}")


async def visitor(k: KernelHarness, desk: GoldenDesk) -> Caller:
    created = await k.call(
        "POST /sessions",
        body={"desk_slug": desk.slug, "kind": "visitor"},
        auth=Auth.none(),
        expect=Expect(fields={"state.kind": "visitor", "state.verified": False, "state.mode": "ai"}),
    )
    return Caller("visitor", created.state, Auth.session(created))


async def verified(k: KernelHarness, desk: GoldenDesk, person: Literal["dana", "bob"]) -> Caller:
    """A visitor verified as `person` (Plan 01b), with the code from the session's own Demo inbox."""
    caller = await visitor(k, desk)
    caller.name, session_id = person, caller.state.session_id
    await k.call("POST /verify/start", body={"session_id": session_id, "contact": CONTACTS[person]}, auth=caller.auth)
    inbox = await k.call(
        "GET /demo_inbox?session_id=",
        query={"session_id": session_id},
        auth=caller.auth,
        expect=Expect(fields={"0.kind": "verification_code"}),
    )
    caller.state = await k.call(
        "POST /verify/check",
        body={"session_id": session_id, "code": code_from_inbox(inbox) if k.is_real else STUB_CODE},
        auth=caller.auth,
        expect=Expect(fields={"session_id": session_id, "verified": True, "assurance": "demo_code"}),
    )
    if k.is_real:
        assert (await session_row(k.records, desk, caller))["person_id"] == desk.people[person]
    return caller


async def agent(k: KernelHarness, desk: GoldenDesk, *, mandate: bool) -> Caller:
    """A demo agent's session (Plan 01c): `POST /agents/demo`'s key, with its mandate or the key alone."""
    _, caller = await demo_agent(k, desk, mandate=mandate)
    return caller


async def demo_agent(k: KernelHarness, desk: GoldenDesk, *, mandate: bool = True) -> tuple[DemoAgentIssued, Caller]:
    """A fresh demo agent the owner mints (`POST /agents/demo`), and its session, opened with its
    mandate or the key alone; the issued key lets a case sign turns the agent's own runner wouldn't."""
    issued = await k.call("POST /agents/demo", body={"desk_id": desk.desk_id}, auth=desk.owner)
    auth = Auth.agent(issued, desk.slug, k.clock)
    body: dict[str, Any] = {"desk_slug": desk.slug, "kind": "agent"}
    if mandate:
        body["mandate"] = issued.mandate.model_dump(mode="json")
    created = await k.call(
        "POST /sessions", body=body, auth=auth, expect=Expect(fields={"state.kind": "agent", "session_token": None})
    )
    return issued, Caller("agent" if mandate else "agent-no-mandate", created.state, auth)


async def session_row(records: Any, desk: GoldenDesk, caller: Caller) -> dict[str, Any]:
    """The caller's `kernel_ro.sessions` row."""
    rows = [row for row in await records.sessions(desk.copy.copy_id) if row["session_id"] == caller.state.session_id]
    assert len(rows) == 1, f"kernel_ro.sessions has {len(rows)} rows for {caller.state.session_id}"
    return rows[0]


def quote_expiries(made_from: datetime, made_until: datetime, language: str | None) -> list[str]:
    """The expiry lines a quote card may show for a quote made between `made_from` and `made_until`
    on the case's clock: QUOTE_LIFE later, read in the business's time zone (`expiry_lines`), in
    `language`, or in both when the case pins none. Worked out from the case's own clock, never
    from what the kernel stored, so a renderer can't vouch for its own date."""
    return expiry_lines(made_from + QUOTE_LIFE, made_until + QUOTE_LIFE, [language] if language else ("en", "es"),
                        zone=_TZ)


# Calls

async def decide(k: KernelHarness, caller: Caller, tool: str, args: dict[str, Any], *, expect: Expect) -> Decision:
    """`POST /decide` for one call, at the caller's current generation, under a fresh call id."""
    call = {"call_id": f"golden-{secrets.token_hex(6)}", "tool": tool, "args": args}
    body = {"session_id": caller.state.session_id, "generation": caller.state.generation, "call": call}
    return await k.call("POST /decide", body=body, auth=caller.auth, expect=expect)


async def make_quote(k: KernelHarness, desk: GoldenDesk, session: Caller, item: str) -> str:
    """A quote for one `item` in the caller's session, at list price: decided, approved by the owner
    if held, and executed. Returns its quote id."""
    return await _quoted(k, desk, session, item, "quote_id", f"stub-quote-{item}")


async def make_quote_fact(k: KernelHarness, desk: GoldenDesk, session: Caller, item: str) -> str:
    """The same quote as `make_quote`, returning the fact id its adapter names (`model_view.fact_id`),
    the id a reply clause cites."""
    return await _quoted(k, desk, session, item, "fact_id", f"quote:stub-quote-{item}")


async def _quoted(k: KernelHarness, desk: GoldenDesk, session: Caller, item: str, key: str, stand_in: str) -> str:
    """Make the quote and return `key` from its `model_view` (on the stub, `stand_in`)."""
    session.turn()
    decision = await decide(
        k, session, "native.quote", quote_args(item), expect=Expect(fields={"outcome": {"$in": ["allow", "hold"]}})
    )
    if decision.outcome == "allow":
        result = await k.call(
            "POST /execute",
            body={"decision_id": decision.decision_id, "session_id": session.state.session_id,
                  "generation": session.state.generation},
            auth=session.auth,
            expect=Expect(fields={"state": "succeeded"}),
        )
    else:
        answered = await k.call(
            "POST /approvals/{decision_id}/answer",
            path={"decision_id": decision.decision_id},
            body={"answer": "allow_once"},
            auth=desk.owner,
            expect=Expect(fields={"decision.state": "executed", "execution.state": "succeeded"}),
        )
        result = answered.execution
    if not k.is_real:
        return stand_in
    value = result.model_view.get(key)
    assert isinstance(value, str), f"the quote's model_view has no {key}: {result.model_view}"
    return value


async def active_version(k: KernelHarness, desk: GoldenDesk) -> int:
    """The Desk's active policy version (the seed activates version 1)."""
    if not k.is_real:
        return 1
    active = [row["version"] for row in await k.records.policy_versions(desk.copy.copy_id)
              if row["desk_id"] == desk.desk_id and row["status"] == "active"]
    assert len(active) == 1, f"the Desk has {len(active)} active policy versions"
    return active[0]


async def draft_cards(k: KernelHarness, desk: GoldenDesk, cards: list[RuleCard]) -> PolicyVersion:
    """The owner's draft of exactly `cards` over the active version, proved."""
    parent = await active_version(k, desk)
    return await k.call(
        "POST /policy/draft",
        body={"desk_id": desk.desk_id, "cards": [card.model_dump(mode="json") for card in cards],
              "expected_parent": parent},
        auth=desk.owner,
        expect=Expect(fields={"desk_id": desk.desk_id, "parent_version": parent, "status": "proved"}),
    )


async def confirm_cards(k: KernelHarness, desk: GoldenDesk, cards: list[RuleCard]) -> PolicyVersion:
    """Make exactly `cards` (and the compiler's default asks) the Desk's rules: draft, prove, confirm."""
    draft = await draft_cards(k, desk, cards)
    return await k.call(
        "POST /policy/confirm",
        body={"desk_id": desk.desk_id, "version": draft.version},
        auth=desk.owner,
        expect=Expect(fields={"desk_id": desk.desk_id, "version": draft.version, "status": "active"}),
    )


async def check_args_schema(k: KernelHarness, caller: Caller, tool: str, args: dict[str, Any]) -> None:
    """Fail when the call's built args name keys the tool's published `input_schema` doesn't, or
    leave out one it requires: `args.py` against the landed adapters, before a refusal for bad
    arguments could pass as a policy decision."""
    context = await k.call("GET /context/{session_id}?desk_id=", path={"session_id": caller.state.session_id},
                           auth=caller.auth)
    profiles = {profile.tool: profile for profile in context.tools_declared}
    if k.is_real and tool in profiles:
        mismatches = schema_mismatches(args, profiles[tool].input_schema)
        assert not mismatches, f"evals/tier1/args.py builds {tool} args its input_schema doesn't take: {mismatches}"


# Rows of golden/decide.yaml

_ROW = ConfigDict(extra="forbid")
_STATES = {"allow": "allowed", "hold": "held", "refuse": "refused"}   # what /decide leaves ("Decision lifecycle")
_CHECKS = ("status", "reviewer_calls", "strikes", "default_ask")       # expect keys that aren't Decision paths
# The field a tool's args are built from; a tool outside this table has no adapter, and the row gives its args.
_ARGS_FROM = {
    "native.quote": "item", "native.find_slots": None, "native.book": "slot", "native.release_document": "document",
    "native.payment_link": "quote", "native.charge_mandate": "quote", "payments.create_refund": "charge",
}
_NAMES = ("item", "slot", "document", "quote", "charge", "args")


class CardSpec(BaseModel):
    """A rule card in a row: `who` defaults to anyone, and a person card names `person`."""

    model_config = _ROW
    card_id: str
    mode: Literal["auto", "ask", "never"]
    applies_to: str
    who: Literal["anyone", "verified", "record_owner", "person"] = "anyone"
    person: Literal["dana", "bob"] | None = None
    max_amount_cents: StrictInt | None = None
    max_discount_bp: StrictInt = 0
    hours: HoursWindow | None = None
    review: StrictBool = False

    @model_validator(mode="after")
    def _is_a_card(self) -> "CardSpec":
        if (self.who == "person") != (self.person is not None):
            raise ValueError("a person card names its person, and only a person card does")
        self._card("person-id")   # RuleCard's own rules, at load
        return self

    def card(self, desk: GoldenDesk) -> RuleCard:
        return self._card(desk.people[self.person] if self.person else None)

    def _card(self, person_id: str | None) -> RuleCard:
        return RuleCard(
            card_id=self.card_id, applies_to=self.applies_to, mode=self.mode, who=self.who,
            person_id=person_id if self.who == "person" else None, max_amount_cents=self.max_amount_cents,
            max_discount_bp=self.max_discount_bp, hours=self.hours, review=self.review,
            reason="A rule from the golden decide table.",
        )


class CallSpec(BaseModel):
    """A row's call: the tool and what its args point at, by role."""

    model_config = _ROW
    tool: str
    item: str | None = None                    # native.quote: the item, at requested_discount_bp
    requested_discount_bp: StrictInt | None = None
    slot: str | None = None                    # native.book: a slot role
    document: Literal["dana-invoice"] | None = None
    quote: str | None = None                   # native.payment_link, native.charge_mandate: the item quoted first
    charge: Literal["dana-250"] | None = None  # payments.create_refund
    args: dict[str, Any] | None = None         # only for a tool no adapter has

    @model_validator(mode="after")
    def _names_what_the_tool_takes(self) -> "CallSpec":
        given = {name for name in _NAMES if getattr(self, name) is not None}
        if self.tool in _ARGS_FROM:
            needed = {_ARGS_FROM[self.tool]} - {None}
            if given != needed:
                raise ValueError(f"a {self.tool} call names {sorted(needed) or 'nothing'}, not {sorted(given)}")
        elif self.tool in get_args(ToolName):
            raise ValueError(f"no row builds {self.tool} args yet; add it to golden_desk")
        elif given != {"args"}:
            raise ValueError(f"{self.tool} has no adapter, so the call gives its args, and only them")
        if self.requested_discount_bp is not None and self.tool != "native.quote":
            raise ValueError("only a quote requests a discount")
        for item in (self.item, self.quote):
            if item is not None and item not in SEED_ITEMS and item not in CUSTOM_ITEMS:
                raise ValueError(f"unknown item {item!r}")
        if self.slot is not None and self.slot not in SEED_SLOTS and self.slot not in CUSTOM_SLOTS:
            raise ValueError(f"unknown slot role {self.slot!r}")
        return self

    @property
    def needs_custom(self) -> bool:
        """Whether the call names a custom item or slot, so its Desk is made with `custom=True`."""
        return self.item in CUSTOM_ITEMS or self.quote in CUSTOM_ITEMS or self.slot in CUSTOM_SLOTS

    def static_args(self, desk: GoldenDesk) -> dict[str, Any]:
        """The call's args, for a call that needs no quote first."""
        if self.tool == "native.quote":
            return quote_args(self.item, requested_discount_bp=self.requested_discount_bp)
        if self.tool == "native.find_slots":
            return find_slots_args()
        if self.tool == "native.book":
            return book_args(desk.slot(self.slot).slot_id)
        if self.tool == "native.release_document":
            return release_document_args(desk.documents[self.document])
        if self.tool == "payments.create_refund":
            return refund_args(desk.charges[self.charge])
        if self.args is not None:
            return dict(self.args)
        raise ValueError(f"a {self.tool} call gets its quote first: use call_args")


async def call_args(k: KernelHarness, desk: GoldenDesk, caller: Caller, spec: CallSpec) -> dict[str, Any]:
    """The call's args; a payment link or mandate charge first gets the caller a quote for its item."""
    if spec.quote is None:
        return spec.static_args(desk)
    quote_id = await make_quote(k, desk, caller, spec.quote)
    return payment_link_args(quote_id) if spec.tool == "native.payment_link" else charge_mandate_args(quote_id)


@dataclass(frozen=True)
class Checks:
    """What a row checks beyond the Decision, on the real kernel only."""

    reviewer_calls: int | None = None   # reviewer calls the case made: one wherever the row scripts a reply
    strikes: int | None = None          # the caller's session strikes afterwards
    default_ask: str | None = None      # a tool the confirmed version holds a default ask card for


class Row(BaseModel):
    """One row of the decide table (`golden/decide.yaml` says what each key means)."""

    model_config = _ROW
    id: str
    requires: list[str] = Field(min_length=1)
    cards: list[CardSpec] | None = None
    seed: Literal["active", "answering-off"] | None = None
    caller: CallerName = "visitor"
    call: CallSpec
    raw_args: dict[str, Any] | None = None
    reviewer: Any = None
    expect: dict[str, Any]

    @model_validator(mode="after")
    def _holds_together(self) -> "Row":
        if unknown := [plan for plan in self.requires if plan not in PLANS]:
            raise ValueError(f"requires names unknown plans {unknown}; the plans are {list(PLANS)}")
        kernel = [KERNEL_PLANS.index(plan) for plan in self.requires if plan in KERNEL_PLANS]
        if not kernel or max(kernel) < KERNEL_PLANS.index(self.needs):
            raise ValueError(f"the row needs plan {self.needs} (its caller, call or seed), so it requires it")
        if (self.cards is None) == (self.seed is None):
            raise ValueError("a row runs on its cards or on the seed's, not both or neither")
        if self.reviewer is not None:
            reviewer_reply(self.reviewer)
        if self.expect.get("outcome") not in _STATES:
            raise ValueError(f"expect states the outcome, one of {list(_STATES)}")
        if type(self.expect.get("status", 200)) is not int:
            raise ValueError("status is an HTTP status")
        _ = self.checks   # its types, at load
        check_expect_paths("POST /decide", self.decision_expect())
        return self

    @property
    def needs(self) -> str:
        """The last kernel plan the row's setup needs: verification, Desk writes and the Answering
        switch are Plan 01b's; demo agents and seeded charges Plan 01c's."""
        if self.caller.startswith("agent") or self.call.charge is not None:
            return "01c"
        if self.caller in ("dana", "bob") or self.call.needs_custom or self.seed == "answering-off":
            return "01b"
        return "01a"

    @property
    def outcome(self) -> str:
        return self.expect["outcome"]

    def decision_expect(self) -> Expect:
        """The Decision the call must get: the row's paths, and on a 200 the state its outcome leaves."""
        status = self.expect.get("status", 200)
        fields = {path: value for path, value in self.expect.items() if path not in _CHECKS}
        if status == 200:
            fields.setdefault("state", _STATES[fields["outcome"]])
        return Expect(status=status, fields=fields)

    @property
    def checks(self) -> Checks:
        values = {key: self.expect[key] for key in ("reviewer_calls", "strikes", "default_ask") if key in self.expect}
        for key in ("reviewer_calls", "strikes"):
            if key in values and (type(values[key]) is not int or values[key] < 0):
                raise ValueError(f"{key} is a count")
        if "default_ask" in values and values["default_ask"] not in get_args(ToolName):
            raise ValueError("default_ask names a tool")
        if self.reviewer is not None and reviewer_reply(self.reviewer)[1]:
            # The hold comes from the reviewer's answer, never from skipping it: one call, used.
            if values.setdefault("reviewer_calls", 1) != 1:
                raise ValueError("a scripted reviewer reply is exactly one reviewer call; {if_called} allows any")
        return Checks(**values)


def load_rows(path: Path = GOLDEN_DIR / "decide.yaml") -> list[Row]:
    """The table's rows; a malformed row or a repeated id raises ValueError, so collection fails."""
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, list):
        raise ValueError(f"{path.name} is a list of rows")
    rows = []
    for n, item in enumerate(data):
        try:
            rows.append(Row.model_validate(item))
        except ValidationError as error:
            name = item.get("id") if isinstance(item, dict) else None
            raise ValueError(f"{path.name} row {n} ({name}): {error}") from None
    if repeated := sorted(row_id for row_id, n in Counter(row.id for row in rows).items() if n > 1):
        raise ValueError(f"{path.name} repeats the row ids {repeated}")
    return rows


def reviewer_reply(spec: Any) -> tuple[Reply, bool]:
    """The fake reviewer reply a row names, and whether the row needs exactly one call.

    `pass` and `refusal`; `{json: fields}` written over pass as given, so a float or a string
    reaches the kernel as sent; `{sleep: seconds}`, then pass; `{http_error: status}`;
    `{text: ...}`; `{if_called: <reply>}` answers any number of calls, none included."""
    if spec == "pass":
        return Json(REVIEW_PASS), True
    if spec == "refusal":
        return Refusal(), True
    if isinstance(spec, dict) and len(spec) == 1:
        [(kind, value)] = spec.items()
        if kind == "json" and isinstance(value, dict):
            return Json({**REVIEW_PASS, **value}), True
        if kind == "sleep" and type(value) in (int, float) and value > 0:
            return Sleep(value, Json(REVIEW_PASS)), True
        if kind == "http_error" and type(value) is int:
            return HttpError(value), True
        if kind == "text" and isinstance(value, str):
            return Text(value), True
        if kind == "if_called" and not (isinstance(value, dict) and "if_called" in value):
            reply, _ = reviewer_reply(value)
            return reply, False
    raise ValueError(
        f"a reviewer is pass, refusal, {{json: fields}}, {{sleep: s}}, {{http_error: status}}, {{text: ...}} "
        f"or {{if_called: <one of those>}}, not {spec!r}"
    )


# Reading the seed

_CODE = re.compile(r"(?<![0-9])[0-9]{6}(?![0-9])")   # ASCII digits, as the kernel writes codes


def code_from_inbox(entries: list[DemoInboxEntry]) -> str:
    """The code in a session's own Demo inbox: one `verification_code` entry holding one 6-digit
    code. A failure says how many entries and codes it found, never what they are, so a broken
    inbox can be investigated from the run's output."""
    codes = [_CODE.findall(entry.body) for entry in entries if entry.kind == "verification_code"]
    if len(codes) != 1 or len(codes[0]) != 1:
        held = ", ".join(str(len(found)) for found in codes) or "none"
        raise AssertionError(
            f"expected one verification_code entry holding one code in the session's Demo inbox, found "
            f"{len(entries)} entries, {len(codes)} of them verification codes, holding {held}"
        )
    return codes[0][0]


def seed_slots(rows: list[dict[str, Any]]) -> dict[str, Slot]:
    """The seed's slots by role, found in the Desk's `kernel_ro.calendar_slots` rows by start time."""
    slots = {}
    for role, wanted in SEED_SLOTS.items():
        found = [row for row in rows if row["starts_at"] == wanted.starts_at]
        if len(found) != 1:
            raise AssertionError(f"the seed has no single slot {role!r} at {wanted.starts_at.isoformat()}: {found}")
        slots[role] = Slot(found[0]["slot_id"], found[0]["starts_at"])
    return slots


def charge_id(facts: list[dict[str, Any]], person_id: str, amount_cents: int, title: str) -> str:
    """The id of one of a person's seeded charges, from the copy's `kernel_ro.facts`: the `charge:`
    fact readable by that person whose total is `amount_cents` (or, holding only a title, `title`)."""

    def matches(claim: dict[str, Any]) -> bool:
        money = claim.get("kind") == "money" and claim.get("value") == amount_cents
        return money or (claim.get("key") == "title" and claim.get("value") == title)

    found = [
        fact["fact_id"].removeprefix("charge:") for fact in facts
        if fact["kind"] == "charge" and fact["fact_id"].startswith("charge:")
        and f"person:{person_id}" in fact["readers"] and any(matches(claim) for claim in fact["claims"])
    ]
    if len(found) != 1:
        raise AssertionError(f"expected one seeded charge of {amount_cents} cents for {person_id}, found {found}")
    return found[0]


def custom_prices(seed_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The price list `custom=True` puts (it replaces the part): the seed's items and the custom ones."""
    seed = [{"item_id": row["item_id"], "title": row["title"], "unit_cents": row["unit_cents"]} for row in seed_rows]
    custom = [{"item_id": item, "title": f"Test item {item}", "unit_cents": cents}
              for item, cents in CUSTOM_ITEMS.items()]
    return seed + custom


def custom_calendar(seed_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The calendar `custom=True` puts (it replaces the part): the seed's slots and the custom ones,
    one row per slot id. A custom id the seed already has must be the same start, and keeps the
    seed's row."""
    slots = {row["slot_id"]: {"slot_id": row["slot_id"], "starts_at": row["starts_at"].isoformat(),
                              "minutes": row["minutes"]} for row in seed_rows}
    starts = {row["slot_id"]: row["starts_at"] for row in seed_rows}
    for slot in CUSTOM_SLOTS.values():
        if slot.slot_id in starts:
            if starts[slot.slot_id] != slot.starts_at:
                raise AssertionError(
                    f"the seed's {slot.slot_id} starts at {starts[slot.slot_id]}, not {slot.starts_at}"
                )
            continue
        slots[slot.slot_id] = {"slot_id": slot.slot_id, "starts_at": slot.starts_at.isoformat(),
                               "minutes": CUSTOM_SLOT_MINUTES}
    return list(slots.values())
