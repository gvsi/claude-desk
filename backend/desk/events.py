"""SSE events the API publishes to a session, and the A2A response.

Each event is stored in app.run_events with a per-session seq sent as the SSE id. Each
signed event carries the fields its signature covers (the session ID comes from the
stream), so it verifies from its own payload.
"""

from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, Field

from desk.contracts import DecisionState, RenderedBlock


class EvWriting(BaseModel):
    type: Literal["writing"]

class EvMessage(BaseModel):               # a checked reply, delivered through deliver()
    type: Literal["message"]
    message_id: str
    generation: int
    author: Literal["claude", "owner", "desk"]   # "desk" for payment_confirmed and link_cancelled
    language: Literal["en", "es"]
    handoff: bool                         # the reply shows the handoff clause
                                          # a final failure that keeps only cards is a reply, not a handoff
    blocks: list[RenderedBlock]
    visitor_plain: str                    # the reply receipt
    ledger_seq: int
    signature: str

class EvTurnEnd(BaseModel):               # every turn end, silent ones included
    type: Literal["turn_end"]

class EvReceipt(BaseModel):               # an action's outcome, or a held action's signed approval before its outcome
    type: Literal["receipt"]
    decision_id: str
    state: DecisionState
    visitor_plain: str
    ledger_seq: int
    signature: str

class EvHeld(BaseModel):
    type: Literal["held"]
    decision_id: str
    state: DecisionState
    visitor_plain: str
    ledger_seq: int
    signature: str

class EvResolved(BaseModel):
    type: Literal["resolved"]
    decision_id: str
    state: DecisionState
    visitor_plain: str
    ledger_seq: int
    signature: str

class EvOwnerJoined(BaseModel):
    type: Literal["owner_joined"]
    name: str                             # the business's owner_display_name

class EvOwnerTyping(BaseModel):           # presence after a take-over; carries no free text
    type: Literal["owner_typing"]
    name: str                             # the business's owner_display_name, as in EvOwnerJoined
    until: AwareDatetime                  # the dots show until then, or until the owner's say replaces them

class EvOwnerLeft(BaseModel):
    type: Literal["owner_left"]
    # Only presence, never the pending work's text. Omitted when idle for existing stream readers.
    resuming: bool = Field(default=False, exclude_if=lambda value: not value)

class EvDemoInbox(BaseModel):             # code-free; the panel fetches entry bodies through the kernel
    type: Literal["demo_inbox"]
    entry_id: str
    to: str
    preview: str

class EvError(BaseModel):                 # the client shows a static build-time string per code
    type: Literal["error"]
    code: Literal["kernel_unavailable", "session", "rate_limited", "internal"]

SseEvent = Annotated[
    EvWriting | EvMessage | EvTurnEnd | EvReceipt | EvHeld | EvResolved | EvOwnerJoined | EvOwnerTyping
    | EvOwnerLeft | EvDemoInbox | EvError,
    Field(discriminator="type"),
]

class A2AResponse(BaseModel):             # the answer to each A2ARequest
    session_id: str
    disclosure: Literal["ai"]             # every A2A response says it comes from an AI
    blocks: list[RenderedBlock]
    receipts: list[Annotated[EvReceipt | EvHeld | EvResolved, Field(discriminator="type")]]
