"""`payments.list_charges` and `payments.create_refund`: the mock payments server's two MCP tools.

Each is a trusted adapter like any native tool's: its profile, the description Claude sees and the
input schema it accepts are the adapter's, never the server's. A Desk gets a `tools` row for one
only through a pinned connect (`mcp_pins`), which adds the hash of the listed definition
(`definition_sha256`) to this profile; `desks.create_desk` writes native rows alone. The server's
operation each tool calls is `mcp_pins.MCP_OPERATIONS`'s.

Both are for a verified person only (no verified person: refused at step 1), and every result
comes back as facts the cards render, never as the server's words. The server's answers parse
through closed, strict models (`ChargeList`, `RefundResult`), money as a whole number of cents from
0 to $10,000; anything else is an answer the kernel can't read.

`payments.list_charges` ("Listing charges") resolves to the verified person's charges
(`ResourceRef(kind="charge", id="person:<id>", owner_person_id=<id>)`) and asks the server for that
customer alone. A read moves nothing, so whatever goes wrong (the server refuses, can't be reached,
errs, or answers outside `ChargeList`) is `AdapterFailure`, with no facts. Each listed charge is a
`charge:<charge_id>` fact: a new one holds the amount, date and ID (no title: its card says
"Payment"), readable by the owner and the person; one the kernel already holds (a seeded payment, a
paid link) keeps its claims, and gains the person as a reader when they are its record owner. A
link whose payment settles after its charge was listed takes the listed fact over
(`payments.write_charge_fact`). A listed charge the kernel records for anyone else fails the read.
Claude sees each fact's ID, title, amount and date, all from the facts.

`payments.create_refund` ("Payments (mocked)") refunds one charge in full. `normalize` reads it from
the provider (`/provider/charges/{id}`, this copy's only): its owner is the resource's record owner,
so the baseline refuses anyone else's charge, and its whole amount is the action's; a charge the
provider can't show or one already partly refunded is refused at step 1. `execute` asks the server
once, under the action's ID as the idempotency key: a refusal (`isError`) or a request never sent
is `AdapterFailure`; a timeout, any other error, or an answer outside `RefundResult` or for another
charge or amount leaves the outcome unknown. A refund that landed is a `refund:<refund_id>` fact
(the amount and both IDs), labelled like the charges. `reconcile` settles an unknown refund at the
provider by its key (`void`): a refund made under it is the result; a key nothing used is voided,
so a request still in flight fails, and the action failed.
"""

import json
import logging
import re
from typing import Annotated, Any

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictInt
from sqlalchemy import select

from desk.contracts import (AUTO_MONEY_HARD_CAP_CENTS, Claim, Fact, Label, NormalizedAction, Principal, ResourceRef,
                            ToolProfile)
from desk.db.models import Fact as FactRow
from desk.kernel_service import labels, mcp_client, mcp_pins, payments
from desk.kernel_service.adapters import register
from desk.kernel_service.adapters.base import (AdapterFailure, AdapterRefusal, AdapterResult, AdapterUnknown, ExecCtx,
                                               Normalized, NormalizeCtx)
from desk.kernel_service.repo import KernelCtx
from desk.kernel_service.sessions import verified

log = logging.getLogger(__name__)

MODULE = "desk.kernel_service.adapters.payments_mcp"
PERSON = "person:"                  # a customer that is a person on record
CHARGE_FACT = "charge:"             # a charge's fact: `charge:<charge_id>`
REFUND_FACT = "refund:"             # a refund's fact: `refund:<refund_id>`


class ListChargesArgs(BaseModel):     # no arguments: the charges listed are always the verified person's own
    model_config = ConfigDict(extra="forbid", strict=True)


class CreateRefundArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    charge_id: str = Field(min_length=1, max_length=200)


LIST_CHARGES = ToolProfile(
    tool="payments.list_charges", source="mcp", effects=["private_data"], reversible=True, adapter=MODULE,
    resource_kind="charge", description_confirmed="Shows a verified customer their own past payments.",
    input_schema=ListChargesArgs.model_json_schema(), status="needs_review")

CREATE_REFUND = ToolProfile(
    tool="payments.create_refund", source="mcp", effects=["pay_out", "private_data"], reversible=False,
    adapter=MODULE, resource_kind="charge", description_confirmed="Refunds a verified customer's own payment in full.",
    input_schema=CreateRefundArgs.model_json_schema(), status="needs_review")


# ---- The server's answers -------------------------------------------------------------------------

Cents = Annotated[StrictInt, Field(ge=0, le=AUTO_MONEY_HARD_CAP_CENTS)]
PROVIDER_ID = r"^[A-Za-z0-9_-]{1,64}$"               # a provider ID a fact ID and a ledger entry can name
ProviderId = Annotated[str, Field(pattern=PROVIDER_ID)]


class _Answer(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)


class ListedCharge(_Answer):
    charge_id: ProviderId
    amount_cents: Cents
    description: Annotated[str, Field(max_length=500)]    # the server's words: read here, never kept or shown
    created_at: AwareDatetime
    refunded_cents: Cents


class ChargeList(_Answer):
    charges: Annotated[list[ListedCharge], Field(max_length=100)]


class RefundResult(_Answer):
    refund_id: ProviderId
    charge_id: ProviderId
    amount_cents: Cents


def parse[M: _Answer](structured: object, model: type[M]) -> M:
    """A tool result's structured content as `model` reads it, parsed as the JSON it arrived as, so a
    numeric string, a bool or a float is never taken for cents. ValueError when it doesn't fit."""
    if structured is None:
        raise ValueError("the result has no structured content")
    return model.model_validate_json(json.dumps(structured))


# ---- Who and what --------------------------------------------------------------------------------

def verified_person(principal: Principal) -> str | None:
    """The person the session is verified as, if any."""
    if principal.person_id is not None and verified(principal.kind, principal.assurance, principal.person_id):
        return principal.person_id
    return None


def person_label(person_id: str) -> Label:
    """A charge's or refund's label: the owner and the person it belongs to, its record owner."""
    return Label(readers=["owner", f"{PERSON}{person_id}"], record_owner=person_id)


def charge_view(fact: Fact) -> dict[str, Any]:
    """What Claude sees of a charge, all from its fact: the ID to cite, its title (None when the
    kernel has none), amount and date (None when the fact holds none)."""
    found = {claim.key: claim.value for claim in fact.claims}
    return {"fact_id": fact.fact_id, "title": found.get("title"), "amount_cents": found.get("total"),
            "created_at": found.get("starts_at")}


async def _charge_fact(ctx: KernelCtx, action: NormalizedAction, person_id: str, charge: ListedCharge) -> Fact:
    """The `charge:<charge_id>` fact for a charge the server listed for the person, in the caller's
    transaction: written when the kernel has none (the amount, date and ID, for the owner and the
    person), else the kernel's own, with the person added to its readers when they are its record
    owner. A fact the kernel records for anyone else fails the read. A payment still settling when
    the charge is listed later takes this fact over (`payments.write_charge_fact`)."""
    fact = Fact(fact_id=f"{CHARGE_FACT}{charge.charge_id}", kind="charge", status="committed", source="kernel",
                claims=[Claim(key="total", kind="money", value=charge.amount_cents),
                        Claim(key="starts_at", kind="datetime", value=charge.created_at.isoformat()),
                        Claim(key="ref", kind="ref", value=charge.charge_id)],
                label=person_label(person_id))
    row = labels.fact_row(action.copy_id, action.desk_id, fact, ctx.clock.now(), session_id=action.session_id,
                          action_id=action.action_id)
    await payments.insert_fact(ctx, row)
    stored = await payments.locked_fact(ctx, action.desk_id, fact.fact_id)
    if stored.kind != "charge" or stored.record_owner != person_id:
        log.error("listed_charge_of_another_person fact_id=%s", fact.fact_id)
        raise AdapterFailure("listed_charge_of_another_person")
    readers = list(stored.readers or labels.OWNER_ONLY)
    if f"{PERSON}{person_id}" not in readers:
        stored.readers = [*readers, f"{PERSON}{person_id}"]
    await ctx.db.flush()
    return labels.fact_of(stored)


# ---- payments.list_charges ------------------------------------------------------------------------

class ListChargesAdapter:
    profile = LIST_CHARGES
    Args = ListChargesArgs
    free_text_fields: frozenset[str] = frozenset()
    model_view_keys = frozenset({"charges"})
    releases_private_data = True          # the verified person's own charges, labelled for the person alone

    async def normalize(self, nctx: NormalizeCtx, args: ListChargesArgs) -> Normalized:
        person = verified_person(nctx.principal)
        if person is None:
            raise AdapterRefusal("not_verified")
        return Normalized(resource=ResourceRef(kind="charge", id=f"{PERSON}{person}", owner_person_id=person))

    async def execute(self, xctx: ExecCtx, action: NormalizedAction, args: ListChargesArgs) -> AdapterResult:
        """The person's charges from the server, as facts (see the module docstring)."""
        person = action.resource.owner_person_id
        if person is None or person != verified_person(xctx.principal) or action.resource.id != f"{PERSON}{person}":
            raise AdapterFailure("not_verified")
        listed = await self._listed(xctx.ctx, action.copy_id, person)
        facts = [await _charge_fact(xctx.ctx, action, person, charge) for charge in listed.charges]
        return AdapterResult(facts=facts, model_view={"charges": [charge_view(fact) for fact in facts]})

    async def _listed(self, ctx: KernelCtx, copy_id: str, person_id: str) -> ChargeList:
        """The person's charges as the server lists them; any failure is `AdapterFailure` (a read)."""
        operation = mcp_pins.MCP_OPERATIONS[self.profile.tool]
        try:
            result = await mcp_client.client(ctx.settings).call_tool(copy_id, operation,
                                                                     {"customer_id": f"{PERSON}{person_id}"})
            if result.is_error:
                raise AdapterFailure("provider_refused")
            listed = parse(result.structured_content, ChargeList)
        except AdapterFailure:
            log.warning("list_charges_failed reason=provider_refused")
            raise
        except Exception as error:      # a read moves nothing: whatever went wrong, nothing happened
            log.warning("list_charges_failed reason=%s", type(error).__name__)
            raise AdapterFailure("provider_failed") from None
        if len({charge.charge_id for charge in listed.charges}) != len(listed.charges):
            log.warning("list_charges_failed reason=listed_twice")
            raise AdapterFailure("provider_failed")
        return listed

    async def reconcile(self, xctx: ExecCtx, action: NormalizedAction) -> AdapterResult | None:
        """A read whose outcome was lost moved nothing: it failed."""
        return None


# ---- payments.create_refund -----------------------------------------------------------------------

class CreateRefundAdapter:
    profile = CREATE_REFUND
    Args = CreateRefundArgs
    free_text_fields: frozenset[str] = frozenset()
    model_view_keys = frozenset({"fact_id", "amount_cents"})
    releases_private_data = True          # a refund of the person's own charge, labelled for the person alone

    async def normalize(self, nctx: NormalizeCtx, args: CreateRefundArgs) -> Normalized:
        """The charge as the provider records it for this copy: its owner and its whole amount, never
        from the call. No verified person, a charge the provider can't show (another copy's, or no
        answer within `READ_DEADLINE_S`) or one already partly refunded is refused at step 1."""
        if verified_person(nctx.principal) is None:
            raise AdapterRefusal("not_verified")
        try:
            charge = await payments.provider(nctx.ctx).read_charge(args.charge_id)
        except (payments.ProviderError, payments.ProviderTimeout):
            raise AdapterRefusal("no_such_charge") from None
        if charge.charge_id != args.charge_id or charge.amount_cents <= 0 or charge.refunded_cents != 0:
            raise AdapterRefusal("not_refundable")
        return Normalized(resource=ResourceRef(kind="charge", id=charge.charge_id,
                                               owner_person_id=charge.owner_person_id),
                          amount_cents=charge.amount_cents)

    async def execute(self, xctx: ExecCtx, action: NormalizedAction, args: CreateRefundArgs) -> AdapterResult:
        """The refund at the server, once per action (see the module docstring)."""
        person = action.resource.owner_person_id
        if person is None or person != verified_person(xctx.principal) or not action.amount_cents:
            raise AdapterFailure("not_record_owner")
        operation = mcp_pins.MCP_OPERATIONS[self.profile.tool]
        try:
            result = await mcp_client.client(xctx.ctx.settings).call_tool(action.copy_id, operation, {
                "charge_id": action.resource.id, "amount_cents": action.amount_cents,
                "idempotency_key": action.action_id})
        except mcp_client.McpUnavailable:
            raise AdapterFailure("provider_unreachable") from None
        except mcp_client.McpTimeout:
            raise AdapterUnknown("provider_unknown") from None
        if result.is_error:
            log.warning("create_refund_failed reason=provider_refused")
            raise AdapterFailure("provider_refused")
        try:
            refund = parse(result.structured_content, RefundResult)
        except ValueError:
            log.error("create_refund_unknown reason=invalid_result")
            raise AdapterUnknown("invalid_result") from None
        if (refund.charge_id, refund.amount_cents) != (action.resource.id, action.amount_cents):
            log.error("create_refund_unknown reason=result_mismatch")
            raise AdapterUnknown("result_mismatch")
        return await _refunded(xctx.ctx, action, person, refund.refund_id)

    async def reconcile(self, xctx: ExecCtx, action: NormalizedAction) -> AdapterResult | None:
        """What became of a refund nobody knows the outcome of, settled at the provider by its
        idempotency key (`void`): a refund made under it is the result; a key nothing used is voided,
        so a request still in flight fails, and the action failed."""
        ctx = xctx.ctx
        found = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == action.desk_id, FactRow.action_id == action.action_id,
            FactRow.kind == "refund")))).one_or_none()
        if found is not None:
            return _refund_result(labels.fact_of(found))
        try:
            settled = await payments.provider(ctx).void("refund", action.action_id)
        except (payments.ProviderError, payments.ProviderTimeout):
            raise AdapterUnknown("provider_unknown") from None
        if settled.state == "voided":
            return None                                   # nothing landed, and nothing late can
        person = action.resource.owner_person_id
        if person is None or not re.fullmatch(PROVIDER_ID, settled.object_id):
            log.error("create_refund_unknown reason=unreadable_settlement")
            raise AdapterUnknown("unreadable_settlement")
        return await _refunded(ctx, action, person, settled.object_id)


def _refund_result(fact: Fact) -> AdapterResult:
    """A refund's result: its fact, and what Claude sees of it (the fact to cite and the amount)."""
    found = {claim.key: claim.value for claim in fact.claims}
    return AdapterResult(facts=[fact], model_view={"fact_id": fact.fact_id, "amount_cents": found["total"]})


async def _refunded(ctx: KernelCtx, action: NormalizedAction, person_id: str, refund_id: str) -> AdapterResult:
    """The `refund:<refund_id>` fact for the action's refund (the amount refunded, the refund's and
    the charge's IDs), readable by the owner and the person, in the caller's transaction."""
    fact = Fact(fact_id=f"{REFUND_FACT}{refund_id}", kind="refund", status="committed", source="kernel",
                claims=[Claim(key="total", kind="money", value=action.amount_cents),
                        Claim(key="ref", kind="ref", value=refund_id),
                        Claim(key="charge", kind="ref", value=action.resource.id)],
                label=person_label(person_id))
    ctx.db.add(labels.fact_row(action.copy_id, action.desk_id, fact, ctx.clock.now(), session_id=action.session_id,
                               action_id=action.action_id))
    await ctx.db.flush()
    return _refund_result(fact)


LIST_CHARGES_ADAPTER = register(ListChargesAdapter())
CREATE_REFUND_ADAPTER = register(CreateRefundAdapter())
