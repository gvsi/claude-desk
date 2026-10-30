"""What one tier 2 run leaves to be judged: the run artifact.

The runner fills it after each run: what the visitor typed and saw (timed SSE events and A2A
answers, each answer with the signed messages behind it, all kept both as the contract reads them
and exactly as received or stored, the JSON the signatures and comparisons are judged on), what the simulated
owner did, the copy's records read after the run (`Records.snapshot`, every `kernel_ro` view), each
decision of the copy as the owner reads it (for its normalized action), the owner's Demo inbox, the
markers the seed holds or the run planted, and usage. `verdict.py` judges it; nothing here judges.
"""

from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictInt, StrictStr

from desk.contracts import ApprovalAnswer, Decision, DemoInboxEntry, RenderedBlock
from desk.events import EvHeld, EvMessage, EvReceipt, EvResolved, SseEvent
from evals.oracles import Marker
from evals.tier2.schema import Provider

_STRICT = ConfigDict(extra="forbid")

A2AReceipt = Annotated[EvReceipt | EvHeld | EvResolved, Field(discriminator="type")]


class TimedEvent(BaseModel):
    """An SSE event as the visitor's stream delivered it, with when the runner received it: as the
    contract reads it (`event`, which drops a field the contract doesn't define) and exactly as sent
    (`raw`), which its signature is checked on."""

    model_config = _STRICT
    at: AwareDatetime
    event: SseEvent
    raw: dict[str, Any]


class A2AAnswer(BaseModel):
    """An A2A answer as received: an `A2AResponse`, or the 422 `{code, disclosure}` for a code the Desk
    turned down, which names no session. `disclosure` is kept as sent (None when missing), so the
    verdict sees an answer that doesn't say it comes from an AI instead of the runner failing to read it."""

    model_config = ConfigDict(extra="allow")
    session_id: StrictStr | None = None
    disclosure: StrictStr | None = None
    blocks: list[RenderedBlock] = []
    receipts: list[A2AReceipt] = []


class StoredMessage(BaseModel):
    """A checked reply behind an A2A answer, as the session's stream stored it (`app.run_events`): as the
    contract reads it (`event`) and exactly as stored (`raw`), which its signature and the answer's
    blocks are checked against."""

    model_config = _STRICT
    event: EvMessage
    raw: dict[str, Any]


class A2AExchange(BaseModel):
    """An agent's A2A answer for one turn, with its HTTP status, when the runner received it, and the
    signed messages behind it. The API builds an answer from what it stored in the session's stream
    (`app.run_events`) after its previous answer's `through_seq`, up to its own (`app.a2a_turns`), so
    `messages` are the checked replies stored in exactly that span, in order: the evidence that the
    kernel's reply check passed every block the answer shows. `response` is the answer as the contract
    reads it, `raw` exactly as received, whose blocks are compared with the messages' as stored."""

    model_config = _STRICT
    at: AwareDatetime
    status: StrictInt = 200
    response: A2AAnswer
    raw: dict[str, Any]
    messages: list[StoredMessage] = []


class Turn(BaseModel):
    """One visitor turn: what the visitor sent, then what came back before the next turn."""

    model_config = _STRICT
    session_id: StrictStr
    visitor_text: str                         # the simulated visitor's message, as sent
    events: list[TimedEvent] = []             # the visitor's stream (a visitor session)
    a2a: A2AExchange | None = None            # the A2A answer (an agent session)


class OwnerAction(BaseModel):
    """Something the simulated owner did during the run."""

    model_config = _STRICT
    at: AwareDatetime
    kind: Literal["answer", "whisper", "add_document", "add_knowledge", "set_answering", "simulate_tool_change",
                  "complete_payment_link"]
    ref: StrictStr | None = None              # the decision, document, tool or link it acted on
    answer: ApprovalAnswer | None = None      # for an answer
    text: str | None = None                   # a whisper's or knowledge item's text


class RunSetup(BaseModel):
    """What the runner set up for the scenario: the seed person the visitor is verified as (from the
    start or when asked), and the markers it planted."""

    model_config = _STRICT
    verified_ref: StrictStr | None = None     # the scenario's verify_as or verify_on_prompt, as a seed ref
    verified_person_id: StrictStr | None = None   # that person's id in this copy
    planted_markers: list[Marker] = []


class FetchedDocument(BaseModel):
    """Document bytes the visitor fetched through a document link, as text."""

    model_config = _STRICT
    document_id: StrictStr | None = None
    text: str


class Providers(BaseModel):
    """Where each part's model calls went. The kernel's checks always use the Claude API."""

    model_config = _STRICT
    api: Provider
    simulator: Provider
    kernel_checks: Literal["anthropic"]


class RunArtifact(BaseModel):
    """Everything one run of one scenario left for the verdict and the report."""

    model_config = _STRICT
    scenario_id: StrictStr
    rep: StrictInt = Field(ge=1)
    pass_id: StrictStr
    copy_id: StrictStr
    desk_ids: list[StrictStr] = Field(min_length=1)
    session_ids: list[StrictStr] = Field(min_length=1)   # the run's own sessions, visitor or agent
    turns: list[Turn]
    owner_actions: list[OwnerAction] = []
    setup: RunSetup
    markers: list[Marker]                     # the seed's (documents and people, read as data) plus planted ones
    documents_fetched: list[FetchedDocument] = []
    records: dict[str, list[dict[str, Any]]]  # the copy's `Records.snapshot`: every kernel_ro view's rows
    decisions_full: dict[str, Decision]       # every decision in records.decisions, read through owner_decision
    owner_inbox: list[DemoInboxEntry]         # the owner's Demo inbox after the run, codes included
    public_key_hex: StrictStr                 # the kernel's signing key (`GET /health`)
    usage: list[dict[str, Any]] = []          # the API's model_calls rows and the kernel's check usage
    simulator_usage: list[dict[str, Any]] = []
    served_models: dict[str, list[str]] = {}  # by part (api, simulator, kernel_checks): the model ids that served it
    providers: Providers


__all__ = [
    "A2AAnswer", "A2AExchange", "FetchedDocument", "OwnerAction", "Providers", "RunArtifact", "RunSetup",
    "StoredMessage", "TimedEvent", "Turn",
]
