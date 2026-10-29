"""The API's HTTP shapes (Plan 02a, "Read models" and "Errors"): what its routes take and answer with.

Every error answer is an `ApiError`; `error_responses` documents them in the OpenAPI document.
"""

from collections.abc import Callable
from typing import Annotated, Any, Literal

from fastapi.routing import APIRoute
from pydantic import AwareDatetime, BaseModel, Field

from desk.contracts import HoursWindow, SessionState
from desk.events import EvHeld, EvMessage, EvReceipt, EvResolved
from desk.kernel_api import Health


class ApiError(BaseModel):
    """Every error answer: `error` names what went wrong; `code` is the kernel's, when `error` is "kernel";
    `retry_after` is the seconds to wait, on a 429. Fields that don't apply are left out."""

    error: str
    code: str | None = None
    retry_after: int | None = None


def error_responses(*statuses: int) -> dict[int | str, dict[str, Any]]:
    """The OpenAPI entries for a route's error answers, each an `ApiError`."""
    return {status: {"model": ApiError} for status in statuses}


def operation_ids(router: str) -> Callable[[APIRoute], str]:
    """OpenAPI operation IDs `<router>_<name>`, for a router's `generate_unique_id_function`."""
    return lambda route: f"{router}_{route.name}"


class DeskSummary(BaseModel):
    desk_id: str
    slug: str
    name: str
    business_name: str
    hours: list[HoursWindow]
    answering: bool


class CopyOut(BaseModel):
    """The owner's copy: what `POST /api/owner/copies`, `start_over` and `me` answer with."""

    copy_id: str
    desks: list[DeskSummary]


class HealthOut(BaseModel):
    """`GET /api/health`: 200 with the kernel's health, or 503 with `ok` false and no kernel field."""

    ok: bool
    kernel: Health | None


class TranscriptItem(BaseModel):
    """One transcript entry as the visitor sees it: their own words, or an event the API delivered."""

    n: int                                # app.messages.n, the `after` cursor
    kind: Literal["visitor_text", "agent_text", "delivered", "status", "whisper"]
    created_at: AwareDatetime
    text: str | None                      # the author's own words; None for delivered and status items
    event: Annotated[EvMessage | EvReceipt | EvHeld | EvResolved, Field(discriminator="type")] | None


class OwnerTranscriptItem(TranscriptItem):
    """The owner's view adds the AI-written translation and triage, which never reach a visitor."""

    owner_translation: str | None
    triage: str | None


# The visitor's chat (Task 7) ---------------------------------------------------------------------------------


class VisitorSession(BaseModel):
    """`POST /api/public/desks/{slug}/sessions`: the session the visitor cookie now holds, and whether it is the one
    the cookie already held (a returning visitor) or a new one."""

    state: SessionState
    resumed: bool


class VisitorTranscript(BaseModel):
    """`GET /api/public/desks/{slug}/session`: the session's state, its transcript as the visitor sees it, and the
    highest event `seq` read in the same snapshot, which the event stream continues after."""

    state: SessionState
    items: list[TranscriptItem]
    last_seq: int


class MessageAccepted(BaseModel):
    """202: the visitor's message is stored; Claude's answer arrives on the event stream."""

    message_id: str


class CancelAccepted(BaseModel):
    """202: the held request is withdrawn; its outcome arrives on the event stream as `resolved`."""

    decision_id: str


class AgentCardSigning(BaseModel):
    """How an agent signs each request: the headers it sends and the payload its Ed25519 signature covers."""

    headers: list[str]
    payload_fields: list[str]
    canonical: Literal["RFC 8785"]
    algorithm: Literal["Ed25519"]
    encoding: Literal["lowercase hex"]
    ts_window_s: int


class AgentCardOut(BaseModel):
    """`GET /api/public/desks/{slug}/agent_card`: built by code from `PUBLIC_ORIGIN` and the slug, with no model
    text; what agents may do here, and the AI disclosure, are the kernel's `PublicDesk.agent_card`."""

    endpoint: str
    signing: AgentCardSigning
    example_request: str
