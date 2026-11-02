"""SQLAlchemy models for the tables migration 0001_core creates.

Each table has its key, `copy_id` and the columns the `kernel_ro` views and the database tests
name; Plans 01a-01c and 02 add the rest in their own migrations and map them here, column for
column (`test_all_tables_exist` checks). JSON columns that hold a shared contract validate
against it on write and parse into it on read, and money and basis-point columns accept only
real integers, as the contracts' `StrictInt` does: a float or a malformed contract never reaches
the database.

IDs that the kernel generates are random, so they key their table alone; IDs that seeds or
owners supply repeat across Desks and copies, so their keys include the Desk (slots, facts,
price items, knowledge items, tools) or the copy (agent keys, mock payments rows).
"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, TypeAdapter
from sqlalchemy import BigInteger, Boolean, DateTime, Integer, Text, text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator

from desk import contracts as c
from desk.events import A2AResponse
from desk.kernel_api import ToolPin

NOW = text("now()")
FALSE = text("false")
EMPTY_OBJECT = text("'{}'::jsonb")
EMPTY_LIST = text("'[]'::jsonb")
OWNER_ONLY = text("""'["owner"]'::jsonb""")   # a missing label is owner-only


class ContractJSON(TypeDecorator):
    """JSONB holding a shared contract: validated on write, parsed into the contract on read."""

    impl = JSONB
    cache_ok = True

    def __init__(self, contract: Any):
        super().__init__(none_as_null=True)
        self.contract = contract
        self._adapter = TypeAdapter(contract)

    def process_bind_param(self, value: Any, dialect: Any) -> Any:
        if value is None:
            return None
        return self._adapter.dump_python(self._adapter.validate_python(value), mode="json")

    def process_result_value(self, value: Any, dialect: Any) -> Any:
        if value is None:
            return None
        return self._adapter.validate_python(value)


class _StrictInteger(TypeDecorator):
    """An integer column that refuses bools and floats instead of letting Postgres round them.

    SQLAlchemy reads `cache_ok` from each concrete class, so every subclass sets it again.
    """

    def process_bind_param(self, value: Any, dialect: Any) -> Any:
        if value is None or type(value) is int:
            return value
        raise TypeError(f"expected an int, got {type(value).__name__}")


class Cents(_StrictInteger):
    """Money in USD cents."""

    impl = BigInteger
    cache_ok = True


class BasisPoints(_StrictInteger):
    """A percentage in basis points (0-10_000)."""

    impl = Integer
    cache_ok = True


class Base(DeclarativeBase):
    pass


# kernel.*: the kernel process (role desk_kernel) only

class Copy(Base):
    __tablename__ = "copies"
    __table_args__ = {"schema": "kernel"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)


class Business(Base):
    __tablename__ = "businesses"
    __table_args__ = {"schema": "kernel"}
    business_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    owner_display_name: Mapped[str] = mapped_column(Text)
    timezone: Mapped[str] = mapped_column(Text)
    brand: Mapped[dict[str, str]] = mapped_column(ContractJSON(dict[str, str]), server_default=text("'{}'::jsonb"))


class Desk(Base):
    __tablename__ = "desks"
    __table_args__ = {"schema": "kernel"}
    desk_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    business_id: Mapped[str] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    slug: Mapped[str] = mapped_column(Text)
    hours: Mapped[list[c.HoursWindow]] = mapped_column(ContractJSON(list[c.HoursWindow]), server_default=EMPTY_LIST)
    answering: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Private setup notes; never included in kernel_ro.desks.
    simulated_memory: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))


class Person(Base):
    __tablename__ = "people"
    __table_args__ = {"schema": "kernel"}
    person_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str] = mapped_column(Text)
    display_name: Mapped[str] = mapped_column(Text)
    masked_contact: Mapped[str] = mapped_column(Text)
    notes: Mapped[str] = mapped_column(Text, server_default=text("''"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)
    ref: Mapped[str] = mapped_column(Text)                   # the seed's handle, unique per Desk
    contact: Mapped[str] = mapped_column(Text)               # on record; verification codes go only here; never in a view
    contact_norm: Mapped[str] = mapped_column(Text)          # normalized for lookup; never in a view
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))   # on record for no one once set


class Lead(Base):
    __tablename__ = "leads"
    __table_args__ = {"schema": "kernel"}
    lead_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str] = mapped_column(Text)
    session_id: Mapped[str | None] = mapped_column(Text)
    display_name: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)


class ActorSession(Base):
    """A visitor, agent or owner session (`ActorKind`); `secret_hash` is the token's hash."""

    __tablename__ = "sessions"
    __table_args__ = {"schema": "kernel"}
    session_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str | None] = mapped_column(Text)        # None for owner sessions, which belong to the copy
    kind: Mapped[str] = mapped_column(Text)
    secret_hash: Mapped[str | None] = mapped_column(Text)    # None for agent sessions
    verified: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    assurance: Mapped[str] = mapped_column(Text, server_default=text("'none'"))
    person_id: Mapped[str | None] = mapped_column(Text)
    agent_key_id: Mapped[str | None] = mapped_column(Text)
    mandate_id: Mapped[str | None] = mapped_column(Text)
    last_language: Mapped[str | None] = mapped_column(Text)
    mode: Mapped[str] = mapped_column(Text, server_default=text("'ai'"))
    generation: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    strikes: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    preview: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))   # the owner trying the Desk as a customer
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))   # visitor sessions close after 24 h idle


class VerificationChallenge(Base):
    """A demo code sent to a person on record; never in a view. At most one is live per person
    and per session (01b_1_verification)."""

    __tablename__ = "verification_challenges"
    __table_args__ = {"schema": "kernel"}
    challenge_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    code_hash: Mapped[str] = mapped_column(Text)             # sha256 of canonical JSON {challenge_id, code}
    desk_id: Mapped[str] = mapped_column(Text)
    session_id: Mapped[str] = mapped_column(Text)            # the session that asked; only it may check the code
    person_id: Mapped[str] = mapped_column(Text)             # the person on record the code went to
    status: Mapped[str] = mapped_column(Text)                # live, consumed, cancelled, expired, failed
    failed_at: Mapped[list[datetime]] = mapped_column(ARRAY(DateTime(timezone=True)),
                                                      server_default=text("'{}'"))   # one per wrong code
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AgentKey(Base):
    """A visiting agent's public key; the private half went once to the agent's runner."""

    __tablename__ = "agent_keys"
    __table_args__ = {"schema": "kernel"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    agent_key_id: Mapped[str] = mapped_column(Text, primary_key=True)   # first 16 hex of sha256(public key)
    desk_id: Mapped[str] = mapped_column(Text)                          # the Desk it was minted for
    public_key_hex: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(Text)                           # "demo"
    minted_by: Mapped[str] = mapped_column(Text)                        # the minting session's ID, or "owner"
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AgentNonce(Base):
    """One signed A2A turn: its nonce, bound to one session and one body hash."""

    __tablename__ = "agent_nonces"
    __table_args__ = {"schema": "kernel"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    agent_key_id: Mapped[str] = mapped_column(Text, primary_key=True)
    nonce: Mapped[str] = mapped_column(Text, primary_key=True)
    session_id: Mapped[str] = mapped_column(Text)
    body_sha256: Mapped[str] = mapped_column(Text)
    first_used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    check_replies: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    spent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DemoWalletKey(Base):
    """The copy's demo wallet, the trusted issuer of its mandates (one per copy)."""

    __tablename__ = "demo_wallet_keys"
    __table_args__ = {"schema": "kernel"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    key_id: Mapped[str] = mapped_column(Text, primary_key=True)
    public_key_hex: Mapped[str] = mapped_column(Text)
    private_key_hex: Mapped[str] = mapped_column(Text)


class Mandate(Base):
    __tablename__ = "mandates"
    __table_args__ = {"schema": "kernel"}
    mandate_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str] = mapped_column(Text)
    agent_key_id: Mapped[str] = mapped_column(Text)
    on_behalf_of: Mapped[str | None] = mapped_column(Text)
    per_charge_cents: Mapped[int] = mapped_column(Cents)
    total_cents: Mapped[int] = mapped_column(Cents)
    committed_cents: Mapped[int] = mapped_column(Cents, server_default=text("0"))
    reserved_cents: Mapped[int] = mapped_column(Cents, server_default=text("0"))
    expires_at: Mapped[str] = mapped_column(Text)            # the signed SignedTime text
    session_id: Mapped[str] = mapped_column(Text)            # the agent session it opened
    issuer: Mapped[str] = mapped_column(Text)                # "demo-wallet"
    nonce: Mapped[str] = mapped_column(Text)                 # unique per copy; never in a view
    envelope: Mapped[c.Mandate] = mapped_column(ContractJSON(c.Mandate))   # the signed envelope as presented


class MandateReservation(Base):
    """What one agent money action holds on its mandate (01c_5_mandate_reservations): `reserved`
    until its outcome is known, then `committed` or `released`."""

    __tablename__ = "mandate_reservations"
    __table_args__ = {"schema": "kernel"}
    reservation_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    mandate_id: Mapped[str] = mapped_column(Text)
    action_id: Mapped[str] = mapped_column(Text)             # unique: the action that holds it
    amount_cents: Mapped[int] = mapped_column(Cents)
    state: Mapped[str] = mapped_column(Text)                 # reserved, committed, released
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Tool(Base):
    __tablename__ = "tools"
    __table_args__ = {"schema": "kernel"}
    desk_id: Mapped[str] = mapped_column(Text, primary_key=True)
    tool: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(Text)
    effects: Mapped[list[str]] = mapped_column(ContractJSON(list[c.Effect]))
    reversible: Mapped[bool] = mapped_column(Boolean)
    status: Mapped[str] = mapped_column(Text)
    description_confirmed: Mapped[str] = mapped_column(Text)
    # an MCP tool's pinned definition hash; a native tool's adapter profile_sha256, the hash /tools/confirm names
    definition_sha256: Mapped[str | None] = mapped_column(Text)
    pending_definition_text: Mapped[str | None] = mapped_column(Text)
    pending_sha256: Mapped[str | None] = mapped_column(Text)
    profile: Mapped[c.ToolProfile | None] = mapped_column(ContractJSON(c.ToolProfile))
    profile_sha256: Mapped[str | None] = mapped_column(Text)   # the profile without status, review or pending fields
    review_reason: Mapped[str | None] = mapped_column(Text)    # only while needs_review: new, changed or delisted


class PolicyVersion(Base):
    __tablename__ = "policy_versions"
    __table_args__ = {"schema": "kernel"}
    desk_id: Mapped[str] = mapped_column(Text, primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    parent_version: Mapped[int | None] = mapped_column(Integer)
    cards: Mapped[list[c.RuleCard]] = mapped_column(ContractJSON(list[c.RuleCard]))
    status: Mapped[str] = mapped_column(Text)
    proof: Mapped[c.ProofReport | None] = mapped_column(ContractJSON(c.ProofReport))
    cedar_sha256: Mapped[str] = mapped_column(Text)
    schema_sha256: Mapped[str] = mapped_column(Text)
    baseline_sha256: Mapped[str] = mapped_column(Text)
    profiles_sha256: Mapped[str] = mapped_column(Text)
    invariants_sha256: Mapped[str] = mapped_column(Text)
    review_thresholds_version: Mapped[int] = mapped_column(Integer)
    # the money cap this version is compiled and proved at; the active version's is the Desk's cap
    auto_money_cap_cents: Mapped[int] = mapped_column(Cents, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)
    cards_sha256: Mapped[str | None] = mapped_column(Text)
    draft_key_sha256: Mapped[str | None] = mapped_column(Text)        # what makes /policy/draft idempotent
    cedar: Mapped[dict[str, str] | None] = mapped_column(ContractJSON(dict[str, str]))   # {F, A, H, A0} Cedar texts
    schema_json: Mapped[str | None] = mapped_column(Text)             # the Desk's Cedar schema, as loaded
    preset: Mapped[str | None] = mapped_column(Text)                  # the preset or seed it came from, if any
    # the tools a /tools/confirm draft turns on, each at the hash it was proved with; empty otherwise
    enables: Mapped[list[ToolPin]] = mapped_column(ContractJSON(list[ToolPin]), server_default=EMPTY_LIST,
                                                   default=list)


class Action(Base):
    __tablename__ = "actions"
    __table_args__ = {"schema": "kernel"}
    action_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str] = mapped_column(Text)
    session_id: Mapped[str] = mapped_column(Text)
    generation: Mapped[int] = mapped_column(Integer)
    tool: Mapped[str] = mapped_column(Text)
    effects: Mapped[list[str]] = mapped_column(ContractJSON(list[c.Effect]))
    resource_kind: Mapped[str] = mapped_column(Text)
    list_cents: Mapped[int | None] = mapped_column(Cents)
    discount_bp: Mapped[int | None] = mapped_column(BasisPoints)
    amount_cents: Mapped[int | None] = mapped_column(Cents)
    recipient: Mapped[str | None] = mapped_column(Text)
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)
    args_json: Mapped[dict[str, Any]] = mapped_column(JSONB)         # adapter-normalized args; never in a view
    args_sha256: Mapped[str] = mapped_column(Text)
    profile_sha256: Mapped[str] = mapped_column(Text)
    resource: Mapped[c.ResourceRef] = mapped_column(ContractJSON(c.ResourceRef))


class Decision(Base):
    __tablename__ = "decisions"
    __table_args__ = {"schema": "kernel"}
    decision_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str] = mapped_column(Text)
    session_id: Mapped[str] = mapped_column(Text)
    generation: Mapped[int] = mapped_column(Integer)
    call_id: Mapped[str] = mapped_column(Text)
    call_sha256: Mapped[str] = mapped_column(Text)
    tool: Mapped[str] = mapped_column(Text)                  # as proposed; a step-1 refusal may name no real tool
    effects: Mapped[list[str]] = mapped_column(ContractJSON(list[c.Effect]), server_default=EMPTY_LIST)
    outcome: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text)
    answers: Mapped[list[str]] = mapped_column(ContractJSON(list[c.ApprovalAnswer]), server_default=EMPTY_LIST)
    policy_version: Mapped[int] = mapped_column(Integer)
    card_ids: Mapped[list[str]] = mapped_column(ContractJSON(list[str]), server_default=EMPTY_LIST)
    review: Mapped[c.Review | None] = mapped_column(ContractJSON(c.Review))
    reason_plain: Mapped[str] = mapped_column(Text)
    # why it was refused at execution, or that a booking closed it while held (`cancelled`), for the owner alone
    # (`decide.set_state`); None in every other state
    owner_plain: Mapped[str | None] = mapped_column(Text)
    visitor_plain: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ledger_seq: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)
    action_id: Mapped[str | None] = mapped_column(Text)      # None for a step-1 refusal
    policy_ids: Mapped[list[str]] = mapped_column(ContractJSON(list[str]), server_default=EMPTY_LIST)
    signature: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # whether the asker could be given allow_person when it was decided (a verified person or an
    # agent key); a hold's answers follow the active money cap, never a later change of standing
    allow_person_eligible: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))


class Approval(Base):
    __tablename__ = "approvals"
    __table_args__ = {"schema": "kernel"}
    approval_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    decision_id: Mapped[str] = mapped_column(Text)
    answer: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    nonce: Mapped[str | None] = mapped_column(Text)          # never in a view
    binding_sha256: Mapped[str | None] = mapped_column(Text)
    policy_version: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Execution(Base):
    """An action's execution: the intent row commits before any side effect."""

    __tablename__ = "executions"
    __table_args__ = {"schema": "kernel"}
    action_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    decision_id: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text)                 # intent, succeeded, failed, unknown
    result: Mapped[c.ExecResult | None] = mapped_column(ContractJSON(c.ExecResult))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # the rules version and money cap T1's re-check ran under, which every later entry names;
    # both null only on a row written before they were recorded
    policy_version: Mapped[int | None] = mapped_column(Integer)
    auto_money_cap_cents: Mapped[int | None] = mapped_column(BigInteger)


class Fact(Base):
    __tablename__ = "facts"
    __table_args__ = {"schema": "kernel"}
    desk_id: Mapped[str] = mapped_column(Text, primary_key=True)
    fact_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text)
    claims: Mapped[list[c.Claim]] = mapped_column(ContractJSON(list[c.Claim]))
    readers: Mapped[list[str]] = mapped_column(ContractJSON(list[str]), server_default=OWNER_ONLY)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    session_id: Mapped[str | None] = mapped_column(Text)
    action_id: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str | None] = mapped_column(Text)         # Fact.source: kernel or owner
    record_owner: Mapped[str | None] = mapped_column(Text)   # Label.record_owner
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class KnowledgeItem(Base):
    __tablename__ = "knowledge_items"
    __table_args__ = {"schema": "kernel"}
    desk_id: Mapped[str] = mapped_column(Text, primary_key=True)
    item_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text)
    readers: Mapped[list[str]] = mapped_column(ContractJSON(list[str]), server_default=OWNER_ONLY)
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))   # first added (01b_5_knowledge)


class PriceItem(Base):
    __tablename__ = "price_items"
    __table_args__ = {"schema": "kernel"}
    desk_id: Mapped[str] = mapped_column(Text, primary_key=True)
    item_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    unit_cents: Mapped[int] = mapped_column(Cents)


class Quote(Base):
    __tablename__ = "quotes"
    __table_args__ = {"schema": "kernel"}
    quote_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str] = mapped_column(Text)
    session_id: Mapped[str | None] = mapped_column(Text)
    items: Mapped[Any] = mapped_column(JSONB)
    list_cents: Mapped[int] = mapped_column(Cents)
    discount_bp: Mapped[int] = mapped_column(BasisPoints)
    amount_cents: Mapped[int] = mapped_column(Cents)
    status: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    action_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CalendarSlot(Base):
    __tablename__ = "calendar_slots"
    __table_args__ = {"schema": "kernel"}
    desk_id: Mapped[str] = mapped_column(Text, primary_key=True)
    slot_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    minutes: Mapped[int] = mapped_column(Integer)


class Booking(Base):
    __tablename__ = "bookings"
    __table_args__ = {"schema": "kernel"}
    booking_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str] = mapped_column(Text)
    slot_id: Mapped[str] = mapped_column(Text)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    person_id: Mapped[str | None] = mapped_column(Text)
    lead_id: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text)
    action_id: Mapped[str | None] = mapped_column(Text)
    session_id: Mapped[str | None] = mapped_column(Text)


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = {"schema": "kernel"}
    document_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    record_owner_person_id: Mapped[str | None] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text)                  # never in a view
    canary: Mapped[str] = mapped_column(Text)                # never in a view
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)
    ref: Mapped[str | None] = mapped_column(Text)            # the seed's handle


class DocumentLink(Base):
    """A document released to its verified record owner, opened once by its token within a day;
    never in a view (01b_6_document_links)."""

    __tablename__ = "document_links"
    __table_args__ = {"schema": "kernel"}
    link_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str] = mapped_column(Text)
    document_id: Mapped[str] = mapped_column(Text)
    session_id: Mapped[str] = mapped_column(Text)            # the session that asked for it
    person_id: Mapped[str] = mapped_column(Text)             # the verified record owner it was released to
    token: Mapped[str] = mapped_column(Text)                 # unique; the link's one credential, only ever here
    token_sha256: Mapped[str] = mapped_column(Text)          # unique; what the copy resolver looks the link up by
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))   # opened
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))     # its Desk or person gone


class PaymentLink(Base):
    """A quote's single-use link to the mock checkout; the rest of its columns arrive in
    01c_2_payment_links, and why and by which version it was cancelled in 01c_3_link_cancellation.
    Its token and the token's hash are never in a view."""

    __tablename__ = "payment_links"
    __table_args__ = {"schema": "kernel"}
    link_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str] = mapped_column(Text)
    session_id: Mapped[str | None] = mapped_column(Text)
    quote_id: Mapped[str | None] = mapped_column(Text)
    amount_cents: Mapped[int] = mapped_column(Cents)
    state: Mapped[str] = mapped_column(Text)                 # PaymentLinkState
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    action_id: Mapped[str] = mapped_column(Text)             # unique: the action that issued it
    title: Mapped[str] = mapped_column(Text)                 # from the quote's items, never from a provider
    token: Mapped[str] = mapped_column(Text)                 # unique; the link's one credential, only ever here
    token_sha256: Mapped[str] = mapped_column(Text)          # unique; what the copy resolver looks up
    provider_checkout_id: Mapped[str] = mapped_column(Text)
    customer_id: Mapped[str] = mapped_column(Text)           # person:<id> when verified, else session:<id>
    mandate_id: Mapped[str | None] = mapped_column(Text)     # an agent link's mandate
    completion_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    cancel_reason: Mapped[str | None] = mapped_column(Text)  # rules_changed, person_removed, mandate_expired, amount_mismatch
    cancelled_by_version: Mapped[int | None] = mapped_column(Integer)   # the rules version whose activation moved it


class Handoff(Base):
    """A conversation handed to the owner, `open` until the owner marks it `done`: one the handoff
    card opened, or a callback a visitor asked for (`native.request_callback`, 01b_2_handoffs),
    which first closes the session's open ones. A row's kind never changes. The kernel keeps one
    open handoff per session, of either kind, under the session row, and the table holds the rule
    too (`handoffs_one_open_per_session`, kernel_one_open_handoff), whose revision left one open in
    each session that rows from before held several in: the others are `superseded`, each naming
    the handoff kept in `superseded_by`, so none reads as closed by the owner. A call-back in the
    owner's own preview inserts its row already `done`, with no closing entry or alert, so it leaves
    no Needs-you item; its fact still backs the preview's card and its row stays for
    reconciliation."""

    __tablename__ = "handoffs"
    __table_args__ = {"schema": "kernel"}
    handoff_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str] = mapped_column(Text)
    session_id: Mapped[str | None] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text)
    callback_window: Mapped[str | None] = mapped_column(Text)    # ISO 8601 "<start>/<end>", or None
    status: Mapped[str] = mapped_column(Text, server_default=text("'open'"))   # "open", "done" or "superseded"
    kind: Mapped[str] = mapped_column(Text)                      # "callback" or "card"; the kernel names it
    action_id: Mapped[str] = mapped_column(Text)                 # a call-back's action; a card's own handoff_id
    window_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))   # null without a window
    window_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))   # null on rows from before
    superseded_by: Mapped[str | None] = mapped_column(Text)      # the handoff kept in its place, when superseded


class NotificationPref(Base):
    __tablename__ = "notification_prefs"
    __table_args__ = {"schema": "kernel"}
    desk_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    now: Mapped[list[str]] = mapped_column(ContractJSON(list[str]), server_default=EMPTY_LIST)
    briefing: Mapped[list[str]] = mapped_column(ContractJSON(list[str]), server_default=EMPTY_LIST)


class DemoInboxEntry(Base):
    """A simulated delivery (codes, owner alerts, head checkpoints); never in a view or in app.*."""

    __tablename__ = "demo_inbox"
    __table_args__ = {"schema": "kernel"}
    entry_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str] = mapped_column(Text)
    to: Mapped[str] = mapped_column(Text)                    # "owner", or the masked contact on record
    person_id: Mapped[str | None] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text)                  # DemoInboxEntry.kind
    body: Mapped[str] = mapped_column(Text)                  # may hold a code
    preview: Mapped[str] = mapped_column(Text)               # code-free kernel template
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    decision_id: Mapped[str | None] = mapped_column(Text)    # only on an owner alert: the held decision's own id
    challenge_id: Mapped[str | None] = mapped_column(Text)   # only on a code: the challenge it was sent for


class LedgerHead(Base):
    __tablename__ = "ledger_heads"
    __table_args__ = {"schema": "kernel"}
    desk_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    seq: Mapped[int] = mapped_column(BigInteger)
    head: Mapped[str] = mapped_column(Text)


class LedgerEntry(Base):
    __tablename__ = "ledger_entries"
    __table_args__ = {"schema": "kernel"}
    desk_id: Mapped[str] = mapped_column(Text, primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    prev_hash: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)            # the exact signed RFC 3339 text
    event: Mapped[c.LedgerEvent] = mapped_column(ContractJSON(c.LedgerEvent))
    hash: Mapped[str] = mapped_column(Text)
    signature: Mapped[str] = mapped_column(Text)
    key_id: Mapped[str] = mapped_column(Text)
    envelope_jcs: Mapped[str] = mapped_column(Text)          # the exact hashed envelope


# app.*: the API process (role desk_api)

class ActionUpdateMetadata(BaseModel):
    """An action update's association for summaries, separate from its frozen model text."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    state: str
    result_fact_ids: list[str]


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = {"schema": "app"}
    n: Mapped[int] = mapped_column(BigInteger, primary_key=True)   # the transcript cursor
    message_id: Mapped[str] = mapped_column(Text)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str | None] = mapped_column(Text)
    session_id: Mapped[str | None] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text)
    author: Mapped[str] = mapped_column(Text)
    text: Mapped[str | None] = mapped_column(Text)                 # untrusted
    blocks: Mapped[list[c.RenderedBlock] | ActionUpdateMetadata | None] = mapped_column(
        ContractJSON(list[c.RenderedBlock] | ActionUpdateMetadata))
    language: Mapped[str | None] = mapped_column(Text)
    owner_translation: Mapped[str | None] = mapped_column(Text)
    visibility: Mapped[str] = mapped_column(Text)
    wake: Mapped[bool] = mapped_column(Boolean, server_default=FALSE)
    model_context: Mapped[int | None] = mapped_column(Integer)
    model_seq: Mapped[int | None] = mapped_column(Integer)         # unique per session
    model_content: Mapped[Any | None] = mapped_column(JSONB(none_as_null=True))   # frozen
    # The kernel's message_id or decision_id; a note may use business_local_time:{timezone}|{local_now}.
    ref_id: Mapped[str | None] = mapped_column(Text)
    call_id: Mapped[str | None] = mapped_column(Text)              # the tool_use id of Claude's delivered reply
    event_seq: Mapped[int | None] = mapped_column(BigInteger)      # the run_events.seq a delivered or status row published
    generation: Mapped[int | None] = mapped_column(Integer)        # an assistant row's calls' session generation
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)
    replay_id: Mapped[str | None] = mapped_column(Text)            # recorded history: the copy's replayed night


class ConversationRead(Base):
    """The owner's read marker on one conversation (migration api_conversation_reads): the transcript cursor they have
    seen, which only moves forward. One owner per copy, so it is keyed by the copy and the session."""

    __tablename__ = "conversation_reads"
    __table_args__ = {"schema": "app"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    session_id: Mapped[str] = mapped_column(Text, primary_key=True)
    desk_id: Mapped[str] = mapped_column(Text)
    read_through_n: Mapped[int] = mapped_column(BigInteger)        # an app.messages.n of the session
    read_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)   # when it last moved
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)


class RunEvent(Base):
    __tablename__ = "run_events"
    __table_args__ = {"schema": "app"}
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str | None] = mapped_column(Text)
    session_id: Mapped[str | None] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text)                        # sse, control, metric
    seq: Mapped[int | None] = mapped_column(BigInteger)            # sse only: the SSE id, gapless per session
    type: Mapped[str] = mapped_column(Text)
    payload: Mapped[Any] = mapped_column(JSONB)
    handled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))   # control only
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)
    replay_id: Mapped[str | None] = mapped_column(Text)            # recorded history: the copy's replayed night


class SetupInterview(Base):
    __tablename__ = "setup_interviews"
    __table_args__ = {"schema": "app"}
    interview_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str | None] = mapped_column(Text)
    business_type: Mapped[str | None] = mapped_column(Text)
    step: Mapped[str] = mapped_column(Text, server_default=text("'questions'"))
    consent: Mapped[bool | None] = mapped_column(Boolean)          # null until asked
    answers: Mapped[Any] = mapped_column(JSONB, server_default=EMPTY_OBJECT)
    transcript: Mapped[Any] = mapped_column(JSONB, server_default=EMPTY_LIST)
    draft_cards: Mapped[Any] = mapped_column(JSONB, server_default=EMPTY_LIST)
    draft_version: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)
    # A start's client key (migration api_idempotency): unique per copy, with its body's hash, the answer it failed
    # with, if it did, and the copy's newest kernel created_at when it asked for the Desk (1970-01-01 UTC if none
    # existed). A repeat answers 409 `key_spent` from the failure's presence. The Desk-list guard also reads
    # `"kernel": "failed"` from start_error: a definite refusal with no kept Desk ID claims no Desk.
    # Every start sends a key now; a row written without a key, before it was required, leaves all four null.
    idempotency_key: Mapped[str | None] = mapped_column(Text)
    request_sha256: Mapped[str | None] = mapped_column(Text)
    start_error: Mapped[Any | None] = mapped_column(JSONB(none_as_null=True))
    desk_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class A2AError(BaseModel):
    """An A2A error answer's body (Plan 02b, "Errors"): what went wrong, and that the answer comes from an AI."""

    model_config = ConfigDict(extra="forbid")

    code: str
    disclosure: Literal["ai"]


class A2ATurn(Base):
    """One agent turn's answer: its `A2AResponse`, or its `A2AError` with the error's status. Nonces are agent-chosen,
    so the key includes the key and session."""

    __tablename__ = "a2a_turns"
    __table_args__ = {"schema": "app"}
    agent_key_id: Mapped[str] = mapped_column(Text, primary_key=True)
    session_id: Mapped[str] = mapped_column(Text, primary_key=True)
    nonce: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=text("'running'"))
    http_status: Mapped[int | None] = mapped_column(Integer)
    # the stored answer, replayed to a resent request; it always carries the AI disclosure
    response: Mapped[A2AResponse | A2AError | None] = mapped_column(ContractJSON(A2AResponse | A2AError))
    through_seq: Mapped[int | None] = mapped_column(BigInteger)    # the last run_events.seq the answer covers
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)


class ModelCall(Base):
    """One API model call's usage; never its content. `created_at` is the call's finish, set by the writer."""

    __tablename__ = "model_calls"
    __table_args__ = {"schema": "app"}
    model_call_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    session_id: Mapped[str | None] = mapped_column(Text)
    route: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(Text)
    input_tokens: Mapped[int] = mapped_column(Integer)
    cached_tokens: Mapped[int] = mapped_column(Integer)            # cache reads
    cache_write_tokens: Mapped[int] = mapped_column(Integer)
    output_tokens: Mapped[int] = mapped_column(Integer)
    latency_ms: Mapped[int] = mapped_column(Integer)
    stop_reason: Mapped[str] = mapped_column(Text)                 # "error" for a failed call
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))   # the call's finish; no default stands in


# mockpay.*: the mock payments server (role desk_mockpay); keys are unique per copy, and so are
# idempotency keys (migration 01c_0_mockpay). A `voided` row holds only its key: it settles a key the
# kernel never used, so a later request with it fails.

class Checkout(Base):
    __tablename__ = "checkouts"
    __table_args__ = {"schema": "mockpay"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    checkout_id: Mapped[str] = mapped_column(Text, primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(Text)
    amount_cents: Mapped[int | None] = mapped_column(Cents)
    title: Mapped[str | None] = mapped_column(Text)
    customer_id: Mapped[str | None] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text)                  # open, succeeded, cancelled, voided
    charge_id: Mapped[str | None] = mapped_column(Text)       # once succeeded


class Charge(Base):
    __tablename__ = "charges"
    __table_args__ = {"schema": "mockpay"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    charge_id: Mapped[str] = mapped_column(Text, primary_key=True)
    owner_person_id: Mapped[str | None] = mapped_column(Text)   # for a `person:<id>` customer
    customer_id: Mapped[str | None] = mapped_column(Text)
    amount_cents: Mapped[int | None] = mapped_column(Cents)
    description: Mapped[str | None] = mapped_column(Text)
    idempotency_key: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text)                  # succeeded, voided
    refunded_cents: Mapped[int] = mapped_column(Cents, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)


class Refund(Base):
    __tablename__ = "refunds"
    __table_args__ = {"schema": "mockpay"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    refund_id: Mapped[str] = mapped_column(Text, primary_key=True)
    charge_id: Mapped[str | None] = mapped_column(Text)
    amount_cents: Mapped[int | None] = mapped_column(Cents)
    idempotency_key: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text)                  # succeeded, voided


class ToolDefinition(Base):
    __tablename__ = "tool_definitions"
    __table_args__ = {"schema": "mockpay"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(Text, primary_key=True)
    definition: Mapped[dict[str, Any]] = mapped_column(JSONB)   # the MCP tool entry, as listed
