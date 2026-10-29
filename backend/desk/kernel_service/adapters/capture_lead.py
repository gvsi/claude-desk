"""`native.capture_lead`: the visitor's name, contact and note, saved for the owner to follow up.

Every argument is the visitor's own text: the owner reads it quoted, the reviewer as untrusted
data. `execute` writes a `leads` row whose note carries the contact the visitor gave, and alerts
the owner per the Desk's notification defaults; the alert is read only from the Demo inbox, so
the result's `inbox` stays empty. A lead is no fact: there is nothing for a card to render, and
Claude sees only that it was saved.
"""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from desk.contracts import NormalizedAction, ResourceRef, ToolProfile
from desk.db.models import Lead
from desk.kernel_service import demo_inbox, render
from desk.kernel_service.adapters import register
from desk.kernel_service.adapters.base import AdapterResult, ExecCtx, Normalized, NormalizeCtx, quoted
from desk.kernel_service.repo import new_id


class CaptureLeadArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: str = Field(min_length=1, max_length=80)
    contact: str | None = Field(None, max_length=120)
    note: str | None = Field(None, max_length=200)


PROFILE = ToolProfile(
    tool="native.capture_lead", source="native", effects=["change"], reversible=True,
    adapter="desk.kernel_service.adapters.capture_lead", resource_kind="desk",
    description_confirmed=(
        "Saves the visitor's name, how to reach them and a short note, for the owner to follow up. Use it when "
        "the visitor wants the business to get back to them, and pass only what the visitor gave you."),
    input_schema=CaptureLeadArgs.model_json_schema(), status="enabled")


def lead_note(args: CaptureLeadArgs) -> str | None:
    """The note as the owner reads it: the visitor's note, then ` · ` and the contact they gave."""
    return " · ".join(part for part in (args.note, args.contact) if part) or None


def model_view(lead_id: str) -> dict[str, Any]:
    return {"lead_id": lead_id, "saved": True}


class CaptureLeadAdapter:
    profile = PROFILE
    Args = CaptureLeadArgs
    free_text_fields = frozenset({"name", "contact", "note"})
    model_view_keys = frozenset({"lead_id", "saved"})

    async def normalize(self, nctx: NormalizeCtx, args: CaptureLeadArgs) -> Normalized:
        return Normalized(resource=ResourceRef(kind="desk", id=nctx.desk_row.desk_id, owner_person_id=None))

    async def execute(self, xctx: ExecCtx, action: NormalizedAction, args: CaptureLeadArgs) -> AdapterResult:
        ctx = xctx.ctx
        lead_id = new_id("lead")
        ctx.db.add(Lead(lead_id=lead_id, copy_id=action.copy_id, desk_id=action.desk_id,
                        session_id=xctx.session_row.session_id, display_name=args.name, note=lead_note(args),
                        created_at=ctx.clock.now()))
        await ctx.db.flush()
        await demo_inbox.alert_owner(ctx, action.desk_id, "lead", render.owner_preview("lead"),
                                     f"From the visitor: {quoted(args.name, args.contact, args.note)}.")
        return AdapterResult(model_view=model_view(lead_id))

    async def reconcile(self, xctx: ExecCtx, action: NormalizedAction) -> AdapterResult | None:
        """None: the lead and its alert are written in the transaction that marks the action
        `succeeded`, so an action still `unknown` wrote neither."""
        return None


ADAPTER = register(CaptureLeadAdapter())
