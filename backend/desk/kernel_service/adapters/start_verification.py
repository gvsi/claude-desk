"""`native.start_verification`: `/verify/start` for an unverified session, as a tool Claude calls.

The call names the contact the visitor typed, which is the visitor's own text. `execute` runs
`verification.start` in the execution's transaction, so its `verify` ledger entry, its challenge
and its Demo inbox entry commit with the action or not at all. The code goes only to the contact
on record, and Claude learns nothing either way: every outcome (a code sent, no one on record, a
limit reached) succeeds with the same `model_view` and no fact. Only the result's `inbox`, which
the Demo inbox panel reads and Claude never sees, holds the code notice, and only when a code
was sent. A verified session isn't given the tool, so its call is refused at step 1.
"""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from desk.contracts import NormalizedAction, ResourceRef, ToolProfile
from desk.kernel_service.adapters import register
from desk.kernel_service.adapters.base import AdapterResult, ExecCtx, Normalized, NormalizeCtx


class StartVerificationArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    contact: str = Field(min_length=1, max_length=120)


PROFILE = ToolProfile(
    tool="native.start_verification", source="native", effects=["send_message"], reversible=False,
    adapter="desk.kernel_service.adapters.start_verification", resource_kind="desk",
    description_confirmed=(
        "Sends a one-time code to the contact the business has on record, so the visitor can confirm who they "
        "are. Pass the email or phone number the visitor gave. The result is the same whether or not that "
        "contact is on record, so never say whether it is; the visitor enters the code in the verify card."),
    input_schema=StartVerificationArgs.model_json_schema(), status="enabled")


def model_view() -> dict[str, Any]:
    """What Claude sees of any start: that one was asked for, never what came of it."""
    return {"status": "requested"}


class StartVerificationAdapter:
    profile = PROFILE
    Args = StartVerificationArgs
    free_text_fields = frozenset({"contact"})
    model_view_keys = frozenset({"status"})
    releases_private_data = False         # the code goes to the contact on record; the session learns nothing
    locks_session = True                  # `verification.start` locks the session row FOR UPDATE

    async def normalize(self, nctx: NormalizeCtx, args: StartVerificationArgs) -> Normalized:
        return Normalized(resource=ResourceRef(kind="desk", id=nctx.desk_row.desk_id, owner_person_id=None),
                          recipient="verified_contact")

    async def execute(self, xctx: ExecCtx, action: NormalizedAction, args: StartVerificationArgs) -> AdapterResult:
        # imported here: verification imports desks, which imports the adapters package
        from desk.kernel_service import verification

        started = await verification.start(xctx.ctx, xctx.session_row, args.contact)
        return AdapterResult(model_view=model_view(), inbox=list(started.inbox))

    async def reconcile(self, xctx: ExecCtx, action: NormalizedAction) -> AdapterResult | None:
        """None: the challenge, its Demo inbox entry and its `verify` entry are written in the
        transaction that marks the action `succeeded`, so an action still `unknown` wrote none."""
        return None


ADAPTER = register(StartVerificationAdapter())
