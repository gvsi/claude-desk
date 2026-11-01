"""`native.charge_mandate`: a visiting agent pays one of its session's quotes within its signed mandate.

The call names a quote by its ID and nothing else, bare or as its fact ID (`quote:<id>`:
`base.fact_ref`); `normalize` resolves it as `native.payment_link` does
(`payment_link.payable_quote`: on this Desk, this session's own, readable by the session,
available and unexpired, and unpaid), so the amount is the quote's, which the kernel priced, and the
effect is `charge`. A quote is paid once: a second charge of it is refused at step 1 with
`quote_paid` ledgered (`quote_paying` while another payment of it is unsettled). Only an
agent session holding a mandate is given the tool, and `/decide` bounds the charge by what the
mandate has left (`mandate_remaining_cents`, read by the baseline).

- `prepare`, with the intent row: `mandates.reserve` holds the amount on the session's mandate under
  its row lock; a mandate that can't cover it now (`MandateExhausted`) refuses the call at execution,
  with nothing sent. The approved path reserves too: the owner's answer runs `prepare` as well.
- `execute`, once the intent has committed: the quote's row taken `FOR UPDATE` and checked again
  (`payable_quote` with `lock`, held across the provider call, so a link's completion of the same
  quote waits for this charge and then finds it paid): a quote paid or being paid since the re-check
  fails with that reason, before anything is sent. Then the provider's charge (idempotency key: the
  action's ID; customer `agent:<agent_key_id>`; the quote's title as its description), then the
  quote `paid`, the reservation committed and a `charge:<charge_id>` fact (the quote's title and
  total, and the charge's ID; readable by the owner and the session) for the `charge_confirmed`
  card, all in one transaction. A
  provider refusal, or a request that never reached it, is `failed`; a timeout or any other outcome
  is `unknown`, and the reservation stays `reserved`, counted against the mandate.
- `on_failed`: the reservation released.
- `reconcile`, for an unknown charge: the charge this action already recorded, else the provider
  settles the key (`void`): a charge made under it is committed and recorded as above, its quote's
  row taken `NOWAIT` (a payment of it in progress leaves the action `unknown` for the next read); a
  key nothing used is voided, so a request still in flight fails, and the action `failed` (then
  `on_failed`).

Claude sees the fact, the title and the amount. Nothing the provider says becomes a title.
"""

import logging
import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from desk.contracts import Claim, Fact, NormalizedAction, ResourceRef, ToolProfile
from desk.db.models import ActorSession
from desk.db.models import Fact as FactRow
from desk.kernel_service import labels, mandates, payments
from desk.kernel_service.adapters import register
from desk.kernel_service.adapters.base import (AdapterFailure, AdapterRefusal, AdapterResult, AdapterUnknown, ExecCtx,
                                               Normalized, NormalizeCtx, fact_ref)
from desk.kernel_service.adapters.payment_link import NO_SUCH_QUOTE, payable_quote, stored_quote
from desk.kernel_service.adapters.quote import items_text
from desk.kernel_service.repo import KernelCtx

log = logging.getLogger(__name__)

PROVIDER_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")      # a charge ID a fact ID can name


class ChargeMandateArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    quote_id: str = Field(max_length=64)


PROFILE = ToolProfile(
    tool="native.charge_mandate", source="native", effects=["charge"], reversible=False,
    adapter="desk.kernel_service.adapters.charge_mandate", resource_kind="quote",
    description_confirmed=(
        "Charges one of this conversation's quotes to the visiting agent's signed mandate, by the quote_id in your "
        "context. The total is the quote's, at a test provider where no money moves, and only within the mandate's "
        "limits. The charge appears in a card; never repeat the amount in your own words."),
    input_schema=ChargeMandateArgs.model_json_schema(), status="enabled")


def model_view(fact: Fact) -> dict[str, Any]:
    """What Claude sees of a charge: the fact to cite, its title and amount."""
    found = {claim.key: claim.value for claim in fact.claims}
    return {"fact_id": fact.fact_id, "title": found["title"], "amount_cents": found["total"]}


def _agent_key(session_row: ActorSession) -> str:
    """The charge's customer: the agent the session is bound to; any other session fails closed."""
    if session_row.kind != "agent" or not session_row.agent_key_id or session_row.mandate_id is None:
        raise AdapterFailure("not_an_agent_with_a_mandate")
    return f"agent:{session_row.agent_key_id}"


async def _charged(ctx: KernelCtx, session_row: ActorSession, action: NormalizedAction, charge_id: str,
                   title: str) -> AdapterResult:
    """The charge recorded, in the caller's transaction: the quote `paid` (`payments.mark_quote_paid`,
    under the row the caller holds), the reservation committed and its fact written
    (`payments.write_charge_fact`). An ID no fact can name leaves the action unknown."""
    if not PROVIDER_ID.fullmatch(charge_id):
        log.error("charge_mandate_unknown reason=unreadable_charge_id action_id=%s", action.action_id)
        raise AdapterUnknown("unreadable_charge_id")
    await payments.mark_quote_paid(ctx, action.resource.id, paid_by=action.action_id)
    await mandates.commit(ctx, action.action_id)
    fact = await payments.write_charge_fact(ctx, action.copy_id, action.desk_id, Fact(
        fact_id=f"charge:{charge_id}", kind="charge", status="committed", source="kernel",
        claims=[Claim(key="title", kind="text", value=title),
                Claim(key="total", kind="money", value=action.amount_cents),
                Claim(key="ref", kind="ref", value=charge_id)],
        label=labels.new_fact_label(session_row)), session_id=session_row.session_id, action_id=action.action_id)
    return AdapterResult(facts=[fact], model_view=model_view(fact))


async def _recorded(ctx: KernelCtx, action: NormalizedAction) -> AdapterResult | None:
    """The charge this action already recorded, if it recorded one, as its result."""
    row = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == action.desk_id, FactRow.action_id == action.action_id,
        FactRow.kind == "charge")))).one_or_none()
    if row is None:
        return None
    fact = labels.fact_of(row)
    return AdapterResult(facts=[fact], model_view=model_view(fact))


class ChargeMandateAdapter:
    profile = PROFILE
    Args = ChargeMandateArgs
    free_text_fields: frozenset[str] = frozenset()
    model_view_keys = frozenset({"fact_id", "title", "amount_cents"})
    releases_private_data = False         # the agent's charge for its own quote, labelled for its session too

    async def normalize(self, nctx: NormalizeCtx, args: ChargeMandateArgs) -> Normalized:
        principal = nctx.principal
        if principal.kind != "agent" or principal.mandate_id is None:
            raise AdapterRefusal("not_an_agent_with_a_mandate")
        found = await payable_quote(nctx.ctx, nctx.desk_row.desk_id, fact_ref(args.quote_id, "quote"),
                                    principal.session_id)
        if isinstance(found, str):
            raise AdapterRefusal(found)
        quote, _ = found
        return Normalized(resource=ResourceRef(kind="quote", id=quote.quote_id, owner_person_id=None),
                          amount_cents=quote.amount_cents)

    async def prepare(self, xctx: ExecCtx, action: NormalizedAction) -> None:
        """The amount reserved on the session's mandate, with the intent row."""
        mandate_id = xctx.session_row.mandate_id
        if xctx.session_row.kind != "agent" or mandate_id is None:
            raise AdapterRefusal("not_an_agent_with_a_mandate")
        try:
            await mandates.reserve(xctx.ctx, mandate_id, action.action_id, action.amount_cents,
                                   desk_id=action.desk_id)
        except mandates.MandateExhausted:
            raise AdapterRefusal("mandate_exhausted") from None

    async def execute(self, xctx: ExecCtx, action: NormalizedAction, args: ChargeMandateArgs) -> AdapterResult:
        """The provider's charge for the quote the action resolved (see the module docstring)."""
        ctx, session_row = xctx.ctx, xctx.session_row
        customer_id = _agent_key(session_row)
        found = await payable_quote(ctx, action.desk_id, action.resource.id, session_row.session_id, lock=True,
                                    action_id=action.action_id)
        if isinstance(found, str) and found != NO_SUCH_QUOTE:
            raise AdapterFailure(found)                      # paid, or being paid, since the re-check
        if isinstance(found, str) or found[0].amount_cents != action.amount_cents:
            raise AdapterFailure("quote_changed")
        title = items_text(found[0].items)
        try:
            charge_id = await payments.provider(ctx).charge(idempotency_key=action.action_id,
                                                            amount_cents=action.amount_cents,
                                                            customer_id=customer_id, description=title)
        except payments.ProviderError:
            raise AdapterFailure("provider_refused") from None
        except payments.ProviderTimeout:
            raise AdapterUnknown("provider_unknown") from None
        return await _charged(ctx, session_row, action, charge_id, title)

    async def on_failed(self, xctx: ExecCtx, action: NormalizedAction) -> None:
        """Nothing was charged: the reservation released."""
        await mandates.release(xctx.ctx, action.action_id)

    async def reconcile(self, xctx: ExecCtx, action: NormalizedAction) -> AdapterResult | None:
        """What became of an unknown charge, settled at the provider (see the module docstring)."""
        ctx = xctx.ctx
        if (recorded := await _recorded(ctx, action)) is not None:
            return recorded
        try:
            settled = await payments.provider(ctx).void("charge", action.action_id)
        except (payments.ProviderError, payments.ProviderTimeout):
            raise AdapterUnknown("provider_unknown") from None
        if settled.state == "voided":
            return None                                   # nothing was charged, and nothing late can be
        found = await stored_quote(ctx, action.desk_id, action.resource.id)
        if found is None:
            log.error("charge_mandate_unknown reason=no_quote action_id=%s", action.action_id)
            raise AdapterUnknown("no_quote")
        try:
            await payments.lock_quote_nowait(ctx, found[0].quote_id)
        except payments.QuoteBusy:
            raise AdapterUnknown("quote_busy") from None      # a payment of it is running: the next read
        return await _charged(ctx, xctx.session_row, action, settled.object_id, items_text(found[0].items))


ADAPTER = register(ChargeMandateAdapter())
