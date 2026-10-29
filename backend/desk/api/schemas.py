"""The API's read models (Plan 02a, "Read models"): what its routes answer with.

The transcript items come first; Task 3 and later tasks add the rest of the table here.
"""

from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, Field

from desk.events import EvHeld, EvMessage, EvReceipt, EvResolved


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
