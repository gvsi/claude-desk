"""The API's HTTP shapes (Plan 02a, "Read models" and "Errors"): what its routes take and answer with.

Every error answer is an `ApiError`; `error_responses` documents them in the OpenAPI document.
"""

from collections.abc import Callable
from typing import Annotated, Any, Literal

from fastapi.routing import APIRoute
from pydantic import AwareDatetime, BaseModel, Field

from desk.contracts import HoursWindow
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
