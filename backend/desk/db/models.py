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
from typing import Any

from pydantic import TypeAdapter
from sqlalchemy import BigInteger, Boolean, DateTime, Integer, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator

from desk import contracts as c

NOW = text("now()")
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
    """An integer column that refuses bools and floats instead of letting Postgres round them."""

    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Any) -> Any:
        if value is None or type(value) is int:
            return value
        raise TypeError(f"expected an int, got {type(value).__name__}")


class Cents(_StrictInteger):
    """Money in USD cents."""

    impl = BigInteger


class BasisPoints(_StrictInteger):
    """A percentage in basis points (0-10_000)."""

    impl = Integer


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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class VerificationChallenge(Base):
    __tablename__ = "verification_challenges"
    __table_args__ = {"schema": "kernel"}
    challenge_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    code_hash: Mapped[str] = mapped_column(Text)


class AgentKey(Base):
    __tablename__ = "agent_keys"
    __table_args__ = {"schema": "kernel"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    agent_key_id: Mapped[str] = mapped_column(Text, primary_key=True)


class AgentNonce(Base):
    __tablename__ = "agent_nonces"
    __table_args__ = {"schema": "kernel"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    agent_key_id: Mapped[str] = mapped_column(Text, primary_key=True)
    nonce: Mapped[str] = mapped_column(Text, primary_key=True)


class DemoWalletKey(Base):
    __tablename__ = "demo_wallet_keys"
    __table_args__ = {"schema": "kernel"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    key_id: Mapped[str] = mapped_column(Text, primary_key=True)


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


class MandateReservation(Base):
    __tablename__ = "mandate_reservations"
    __table_args__ = {"schema": "kernel"}
    reservation_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)


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
    pending_definition_text: Mapped[str | None] = mapped_column(Text)
    pending_sha256: Mapped[str | None] = mapped_column(Text)


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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)


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
    visitor_plain: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ledger_seq: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)


class Approval(Base):
    __tablename__ = "approvals"
    __table_args__ = {"schema": "kernel"}
    approval_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    decision_id: Mapped[str] = mapped_column(Text)
    answer: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Execution(Base):
    __tablename__ = "executions"
    __table_args__ = {"schema": "kernel"}
    action_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)


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


class DocumentLink(Base):
    __tablename__ = "document_links"
    __table_args__ = {"schema": "kernel"}
    link_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)


class PaymentLink(Base):
    __tablename__ = "payment_links"
    __table_args__ = {"schema": "kernel"}
    link_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str] = mapped_column(Text)
    session_id: Mapped[str | None] = mapped_column(Text)
    quote_id: Mapped[str | None] = mapped_column(Text)
    amount_cents: Mapped[int] = mapped_column(Cents)
    state: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Handoff(Base):
    __tablename__ = "handoffs"
    __table_args__ = {"schema": "kernel"}
    handoff_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str] = mapped_column(Text)
    session_id: Mapped[str | None] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text)
    callback_window: Mapped[str | None] = mapped_column(Text)    # ISO 8601 "<start>/<end>", or None
    status: Mapped[str] = mapped_column(Text, server_default=text("'open'"))


class NotificationPref(Base):
    __tablename__ = "notification_prefs"
    __table_args__ = {"schema": "kernel"}
    desk_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    now: Mapped[list[str]] = mapped_column(ContractJSON(list[str]), server_default=EMPTY_LIST)
    briefing: Mapped[list[str]] = mapped_column(ContractJSON(list[str]), server_default=EMPTY_LIST)


class DemoInboxEntry(Base):
    __tablename__ = "demo_inbox"
    __table_args__ = {"schema": "kernel"}
    entry_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)


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

class Message(Base):
    __tablename__ = "messages"
    __table_args__ = {"schema": "app"}
    n: Mapped[int] = mapped_column(BigInteger, primary_key=True)   # the transcript cursor
    message_id: Mapped[str] = mapped_column(Text)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str | None] = mapped_column(Text)
    session_id: Mapped[str | None] = mapped_column(Text)
    blocks: Mapped[Any | None] = mapped_column(JSONB)
    language: Mapped[str | None] = mapped_column(Text)
    owner_translation: Mapped[str | None] = mapped_column(Text)
    visibility: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)


class RunEvent(Base):
    __tablename__ = "run_events"
    __table_args__ = {"schema": "app"}
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str | None] = mapped_column(Text)
    session_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)


class SetupInterview(Base):
    __tablename__ = "setup_interviews"
    __table_args__ = {"schema": "app"}
    interview_id: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)


class A2ATurn(Base):
    """One agent turn's answer. Nonces are agent-chosen, so the key includes the key and session."""

    __tablename__ = "a2a_turns"
    __table_args__ = {"schema": "app"}
    agent_key_id: Mapped[str] = mapped_column(Text, primary_key=True)
    session_id: Mapped[str] = mapped_column(Text, primary_key=True)
    nonce: Mapped[str] = mapped_column(Text, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    desk_id: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=text("'running'"))
    response: Mapped[Any | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)


class ModelCall(Base):
    """One API model call's usage; never its content."""

    __tablename__ = "model_calls"
    __table_args__ = {"schema": "app"}
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    copy_id: Mapped[str] = mapped_column(Text)
    session_id: Mapped[str | None] = mapped_column(Text)
    route: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(Text)
    input_tokens: Mapped[int] = mapped_column(Integer)
    cached_tokens: Mapped[int] = mapped_column(Integer)
    output_tokens: Mapped[int] = mapped_column(Integer)
    latency_ms: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=NOW)


# mockpay.*: the mock payments server (role desk_mockpay); keys are unique per copy

class Checkout(Base):
    __tablename__ = "checkouts"
    __table_args__ = {"schema": "mockpay"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    checkout_id: Mapped[str] = mapped_column(Text, primary_key=True)


class Charge(Base):
    __tablename__ = "charges"
    __table_args__ = {"schema": "mockpay"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    charge_id: Mapped[str] = mapped_column(Text, primary_key=True)


class Refund(Base):
    __tablename__ = "refunds"
    __table_args__ = {"schema": "mockpay"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    refund_id: Mapped[str] = mapped_column(Text, primary_key=True)


class ToolDefinition(Base):
    __tablename__ = "tool_definitions"
    __table_args__ = {"schema": "mockpay"}
    copy_id: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(Text, primary_key=True)
