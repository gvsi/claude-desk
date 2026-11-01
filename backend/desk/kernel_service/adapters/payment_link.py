"""`native.payment_link`: a single-use link to the mock checkout for one of the session's quotes.

The call names a quote by its ID and nothing else. `normalize` resolves it from `quotes`
(`payable_quote`): it must be on this Desk (and so in this copy), this session's own, readable by
the session (its fact's readers), `available` and unexpired, and unpaid, else the call is refused at
step 1 with the reason ledgered (`no_such_quote`, or `quote_paid` / `quote_paying`). The resource is
`ResourceRef(kind="quote")` with no record owner. The amount is the quote's, which the kernel
priced; the effect is `charge`. No argument can name an amount, a title or a customer.

`execute` runs once the intent row has committed. For an auto-allowed link (not one the owner
approved, whose single-use approval was bound to this call), it first takes the Desk's active rules
version `FOR SHARE` (`payments.lock_active_version`), the row `activation.confirm` holds `FOR
UPDATE`, and keeps it to the end of the transaction: a confirm either waits for this link, or
committed first and this sees its version. If that version isn't the one the execution re-check ran
under (`ExecCtx.recheck_version`), `payments.link_rules_allow` checks the link against it, and a
link it no longer allows fails before anything is sent (`rules_changed`). Then it takes the quote's
row `FOR UPDATE` and checks it again (`payable_quote` with `lock`): a quote paid or being paid since
the re-check fails with that reason, before anything is sent. A quote with an open link (`issued`
and unexpired: `payments.open_link_fact`) is answered with that link, so asking twice makes one
checkout and one link, and an agent's reservation for this action is released. Otherwise the checkout
(idempotency key: the action's ID; customer `person:<id>` when the session is verified, else
`session:<id>`), the `payment_links` row (`issued`, a `secrets.token_urlsafe(32)` token and its
sha256, for `LINK_TTL`) and a `payment_link:<link_id>` fact holding the title, the total and the
link's ID, readable by the readers the quote and the session share, until the link expires; ledgered
`payment` `{link_id, state: "issued", version}`, naming the version the link was checked against.
Claude sees the fact, the title and the amount; the token stays in its row, never in a fact,
`model_view`, ledger summary or log line. A provider refusal, or a request that never reached it, is
`failed`; a timeout or any other outcome is `unknown`.

An agent session's link holds money on the session's mandate: `prepare` reserves its amount with the
intent row (`mandates.reserve`, under the mandate row's lock), so a mandate that can't cover it now
refuses the call at execution, with nothing sent. The reservation then follows the link table
(`payments`: committed once paid, released once expired or cancelled, kept while unknown), and
`on_failed` releases it when no link is written. The rules a link is checked against after its
execution re-check count its own reservation back (`payments.link_rules_allow`).

`reconcile` settles an `unknown` link at the provider by its idempotency key (`void`): a key nothing
used is voided, so a request still in flight fails, and the action `failed`. A checkout that landed
is checked against the active version (no execution re-check ran in this call), its lock taken
`NOWAIT`, because reconciliation has already written to the ledger in its transaction and must not
wait on a confirm that waits on the ledger head (a confirm in progress leaves it `unknown` for the
next read), and then its quote, `NOWAIT` too (`payments.lock_quote_nowait`: a payment of it in
progress leaves it `unknown` for the next read). A link the rules no longer allow, or for a quote
that is paid, being paid or has another open link by now, has its checkout cancelled at the provider
and no link is written (a cancel that fails leaves it `unknown`); otherwise the link and its fact are
written as above, with a fresh token.

The `payment_link` card shows the link's title and amount and links to `/pay/{token}` (`href_for`)
while the link is issued and unexpired; the API proxies the checkout page's reads and writes.
"""

import logging
import secrets
from datetime import timedelta
from collections.abc import Awaitable, Callable
from typing import Any

from psycopg import errors as pg_errors
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError

from desk.contracts import Claim, Fact, Label, LedgerEvent, NormalizedAction, ResourceRef, ToolProfile
from desk.db.models import ActorSession, PaymentLink, Quote
from desk.db.models import Decision as DecisionRow
from desk.db.models import Fact as FactRow
from desk.kernel_service import desks, labels, ledger, mandates, payments, render
from desk.kernel_service.adapters import register
from desk.kernel_service.adapters.base import (AdapterFailure, AdapterRefusal, AdapterResult, AdapterUnknown, ExecCtx,
                                               Normalized, NormalizeCtx)
from desk.kernel_service.adapters.quote import items_text
from desk.kernel_service.repo import KernelCtx, new_id

log = logging.getLogger(__name__)

LINK_TTL = timedelta(hours=24)
FACT_PREFIX = "payment_link:"
NO_SUCH_QUOTE = "no_such_quote"


class PaymentLinkArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    quote_id: str = Field(max_length=64)


PROFILE = ToolProfile(
    tool="native.payment_link", source="native", effects=["charge"], reversible=False,
    adapter="desk.kernel_service.adapters.payment_link", resource_kind="quote",
    description_confirmed=(
        "Makes a payment link for one of this conversation's quotes, by the quote_id in your context. The visitor "
        "pays the quote's total at a test checkout where no money moves. The link appears in a card; never repeat "
        "the amount or the link in your own words."),
    input_schema=PaymentLinkArgs.model_json_schema(), status="enabled")


def model_view(fact: Fact) -> dict[str, Any]:
    """What Claude sees of a link: the fact to cite, its title and amount, never the token."""
    found = {claim.key: claim.value for claim in fact.claims}
    return {"fact_id": fact.fact_id, "title": found["title"], "amount_cents": found["total"]}


# ---- The quote a link is for ------------------------------------------------------------------------

async def stored_quote(ctx: KernelCtx, desk_id: str, quote_id: str) -> tuple[Quote, FactRow] | None:
    """The Desk's quote `quote_id` and its fact, in the bound copy, whatever their status."""
    if not desks.storable(quote_id):
        return None
    quote = (await ctx.db.scalars(ctx.repo.scoped(select(Quote).where(
        Quote.desk_id == desk_id, Quote.quote_id == quote_id)))).one_or_none()
    if quote is None:
        return None
    fact = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == desk_id, FactRow.fact_id == f"quote:{quote_id}")))).one_or_none()
    return (quote, fact) if fact is not None else None


async def payable_quote(ctx: KernelCtx, desk_id: str, quote_id: str, session_id: str, *, lock: bool = False,
                        action_id: str | None = None) -> tuple[Quote, FactRow] | str:
    """The quote and its fact, if a payment of it may start in this session now, else why not
    (`NO_SUCH_QUOTE`, `quote_paid` or `quote_paying`). It must be on the Desk and this session's own
    (made in it: the tool is for "one of this conversation's quotes", so a verified person's quote
    from an earlier conversation is refused before anything is made), available and unexpired, with
    a current fact the session may read, and unpaid (`payments.quote_unpayable`; `action_id` is the
    caller's own action, left out). With `lock`, the quote's row is held `FOR UPDATE` until the
    transaction ends (`payments.lock_quote`'s place in repo.py's order), as an execution's check
    before anything is sent needs it; `normalize` reads it without a lock, and the execution checks
    again under it."""
    if not desks.storable(quote_id):
        return NO_SUCH_QUOTE
    stmt = select(Quote).where(Quote.desk_id == desk_id, Quote.quote_id == quote_id)
    if lock:
        stmt = stmt.with_for_update()
    quote = (await ctx.db.scalars(ctx.repo.scoped(stmt.execution_options(populate_existing=True)))).one_or_none()
    fact = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == desk_id, FactRow.fact_id == f"quote:{quote_id}")))).one_or_none()
    if quote is None or fact is None or quote.session_id != session_id:
        return NO_SUCH_QUOTE
    session_row = (await ctx.db.scalars(ctx.repo.scoped(select(ActorSession).where(
        ActorSession.session_id == session_id)))).one()
    now = ctx.clock.now()
    live = (quote.status in ("available", payments.QUOTE_PAID) and quote.expires_at is not None
            and quote.expires_at > now and fact.status == "available"
            and (fact.expires_at is None or fact.expires_at > now))
    if not live or not labels.can_read(fact.readers, labels.session_readers(session_row)):
        return NO_SUCH_QUOTE
    unpayable = await payments.quote_unpayable(ctx, quote, action_id=action_id)
    return unpayable if unpayable is not None else (quote, fact)


# ---- Who decided it -----------------------------------------------------------------------------------

async def _decision(ctx: KernelCtx, action: NormalizedAction) -> DecisionRow:
    return (await ctx.db.scalars(ctx.repo.scoped(select(DecisionRow).where(
        DecisionRow.action_id == action.action_id)))).one()


def _customer(session_row: ActorSession) -> str:
    """The checkout's customer: the verified person, else the session."""
    person = labels.new_fact_label(session_row).record_owner
    return f"person:{person}" if person is not None else f"session:{session_row.session_id}"


# ---- Writing the link ---------------------------------------------------------------------------------

async def _issue(ctx: KernelCtx, session_row: ActorSession, action: NormalizedAction, *, quote: Quote,
                 quote_label: Label, checkout_id: str, version: int | None, approved: bool) -> Fact:
    """The link row and its fact for a checkout that exists, ledgered `payment` `{link_id, state:
    "issued", version}` (`approved: true` too for a link the owner approved), in the caller's
    transaction."""
    now = ctx.clock.now()
    token = secrets.token_urlsafe(32)
    title = items_text(quote.items)
    link = PaymentLink(link_id=new_id("paylink"), copy_id=action.copy_id, desk_id=action.desk_id,
                       session_id=session_row.session_id, quote_id=quote.quote_id, action_id=action.action_id,
                       title=title, amount_cents=action.amount_cents, state="issued", token=token,
                       token_sha256=payments.token_sha256(token), provider_checkout_id=checkout_id,
                       customer_id=_customer(session_row),
                       mandate_id=session_row.mandate_id if session_row.kind == "agent" else None,
                       expires_at=now + LINK_TTL, created_at=now, updated_at=now)
    fact = Fact(fact_id=f"{FACT_PREFIX}{link.link_id}", kind="payment_link", status="available", source="kernel",
                claims=[Claim(key="title", kind="text", value=title),
                        Claim(key="total", kind="money", value=action.amount_cents),
                        Claim(key="ref", kind="ref", value=link.link_id)],
                label=labels.combine([quote_label, labels.new_fact_label(session_row)]), expires_at=link.expires_at)
    ctx.db.add(link)
    await ctx.db.flush()                  # the link before its fact, in repo.py's lock order
    ctx.db.add(labels.fact_row(action.copy_id, action.desk_id, fact, now, session_id=session_row.session_id,
                               action_id=action.action_id))
    await ctx.db.flush()
    summary: dict[str, Any] = {"link_id": link.link_id, "state": "issued", "version": version}
    if approved:
        summary["approved"] = True
    await ledger.append(ctx, copy_id=action.copy_id, desk_id=action.desk_id, event=LedgerEvent(
        kind="payment", origin="kernel", session_id=session_row.session_id, ref_id=link.link_id, summary=summary))
    return fact


async def _issued(ctx: KernelCtx, action: NormalizedAction) -> AdapterResult | None:
    """The link this action already wrote, if it wrote one, as its result."""
    row = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == action.desk_id, FactRow.action_id == action.action_id,
        FactRow.kind == "payment_link")))).one_or_none()
    if row is None:
        return None
    fact = labels.fact_of(row)
    return AdapterResult(facts=[fact], model_view=model_view(fact))


async def execution_rules(xctx: ExecCtx, action: NormalizedAction) -> tuple[bool, int | None]:
    """Fence auto execution against activation before writing a quote or calling the provider."""
    ctx = xctx.ctx
    decision = await _decision(ctx, action)
    approved = await payments.owner_approved(ctx, decision)
    version = xctx.recheck_version
    if not approved:
        active = await payments.lock_active_version(ctx, action.desk_id)
        if active is None or (active.version != xctx.recheck_version
                              and not await payments.link_rules_allow(ctx, decision, action, active)):
            raise AdapterFailure("rules_changed")
        version = active.version
    return approved, version


async def open_link_answer(ctx: KernelCtx, action: NormalizedAction, quote_row: Quote) -> AdapterResult | None:
    """The quote's open link (`payments.open_link_fact`) as this action's result, or None when it has
    none: no second checkout or link, and nothing held for this action, since the open link holds what
    it needs. The caller holds the quote's row `FOR UPDATE`."""
    if (open_fact := await payments.open_link_fact(ctx, quote_row)) is None:
        return None
    await mandates.release(ctx, action.action_id)
    return AdapterResult(facts=[open_fact], model_view=model_view(open_fact))


async def issue_for_quote(xctx: ExecCtx, action: NormalizedAction, quote_id: str, *,
                          approved: bool, version: int | None) -> AdapterResult:
    """The shared locked quote, open-link, provider-idempotency and issue path."""
    ctx = xctx.ctx
    found = await payable_quote(ctx, action.desk_id, quote_id, xctx.session_row.session_id, lock=True,
                                action_id=action.action_id)
    if isinstance(found, str) and found != NO_SUCH_QUOTE:
        raise AdapterFailure(found)                      # paid, or being paid, since the re-check
    if isinstance(found, str) or found[0].amount_cents != action.amount_cents:
        raise AdapterFailure("quote_changed")
    quote, quote_fact = found
    if (answer := await open_link_answer(ctx, action, quote)) is not None:
        return answer
    try:
        checkout_id = await payments.provider(ctx).create_checkout(
            idempotency_key=action.action_id, amount_cents=action.amount_cents, title=items_text(quote.items),
            customer_id=_customer(xctx.session_row))
    except payments.ProviderError:
        raise AdapterFailure("provider_refused") from None
    except payments.ProviderTimeout:
        raise AdapterUnknown("provider_unknown") from None
    fact = await _issue(ctx, xctx.session_row, action, quote=quote,
                        quote_label=labels.label_of(quote_fact.readers, quote_fact.record_owner),
                        checkout_id=checkout_id, version=version, approved=approved)
    return AdapterResult(facts=[fact], model_view=model_view(fact))


async def reconcile_checkout(xctx: ExecCtx, action: NormalizedAction, *,
                             make_quote: Callable[[], Awaitable[str | None]] | None = None) -> AdapterResult | None:
    """Settle by action key, fencing rules and quote NOWAIT. A block can supply its own quote
    after a landed checkout passes the rules check; a voided checkout writes nothing."""
    ctx = xctx.ctx
    if (existing := await _issued(ctx, action)) is not None:
        return existing
    client = payments.provider(ctx)
    try:
        settled = await client.void("checkout", action.action_id)
    except (payments.ProviderError, payments.ProviderTimeout):
        raise AdapterUnknown("provider_unknown") from None
    if settled.state == "voided":
        return None                                   # nothing landed, and nothing late can
    decision = await _decision(ctx, action)
    approved = await payments.owner_approved(ctx, decision)
    version: int | None = None
    found = await stored_quote(ctx, action.desk_id, action.resource.id) if make_quote is None else None
    rules_allow = True
    if not approved:
        try:
            async with ctx.db.begin_nested():
                active = await payments.lock_active_version(ctx, action.desk_id, nowait=True)
        except DBAPIError as error:
            if isinstance(error.orig, pg_errors.LockNotAvailable):
                raise AdapterUnknown("rules_changing") from None     # a confirm is running: the next read
            raise
        if active is None or not await payments.link_rules_allow(ctx, decision, action, active):
            found = None
            rules_allow = False
        else:
            version = active.version
    if make_quote is not None and rules_allow:
        quote_id = await make_quote()
        if quote_id is not None:
            found = await stored_quote(ctx, action.desk_id, quote_id)
    if found is not None:
        # a quote paid, being paid or with another open link meanwhile takes no second link
        try:
            quote_row = await payments.lock_quote_nowait(ctx, found[0].quote_id)
        except payments.QuoteBusy:
            raise AdapterUnknown("quote_busy") from None      # a payment of it is running: the next read
        if (quote_row is None or await payments.quote_unpayable(ctx, quote_row) is not None
                or await payments.open_link_fact(ctx, quote_row) is not None):
            found = None
    if found is None:
        await _cancel_checkout(client, settled.object_id)
        return None
    quote, quote_fact = found
    fact = await _issue(ctx, xctx.session_row, action, quote=quote,
                        quote_label=labels.label_of(quote_fact.readers, quote_fact.record_owner),
                        checkout_id=settled.object_id, version=version, approved=approved)
    return AdapterResult(facts=[fact], model_view=model_view(fact))


class PaymentLinkAdapter:
    profile = PROFILE
    Args = PaymentLinkArgs
    free_text_fields: frozenset[str] = frozenset()
    model_view_keys = frozenset({"fact_id", "title", "amount_cents"})
    releases_private_data = False         # a link to pay the session's own quote, labelled for the session too

    async def normalize(self, nctx: NormalizeCtx, args: PaymentLinkArgs) -> Normalized:
        found = await payable_quote(nctx.ctx, nctx.desk_row.desk_id, args.quote_id, nctx.principal.session_id)
        if isinstance(found, str):
            raise AdapterRefusal(found)
        quote, _ = found
        return Normalized(resource=ResourceRef(kind="quote", id=quote.quote_id, owner_person_id=None),
                          amount_cents=quote.amount_cents)

    async def prepare(self, xctx: ExecCtx, action: NormalizedAction) -> None:
        """An agent session's link reserves its amount on the session's mandate, with the intent row
        (`mandates.reserve`); a mandate that can't cover it now refuses the call at execution. A
        visitor's link reserves nothing."""
        session_row = xctx.session_row
        if session_row.kind != "agent":
            return
        if session_row.mandate_id is None:
            raise AdapterRefusal("no_mandate")
        try:
            await mandates.reserve(xctx.ctx, session_row.mandate_id, action.action_id, action.amount_cents,
                                   desk_id=action.desk_id)
        except mandates.MandateExhausted:
            raise AdapterRefusal("mandate_exhausted") from None

    async def on_failed(self, xctx: ExecCtx, action: NormalizedAction) -> None:
        """No link was written: an agent link's reservation released (a visitor's holds none)."""
        await mandates.release(xctx.ctx, action.action_id)

    async def execute(self, xctx: ExecCtx, action: NormalizedAction, args: PaymentLinkArgs) -> AdapterResult:
        """The checkout and the link for the quote the action resolved (see the module docstring)."""
        approved, version = await execution_rules(xctx, action)
        return await issue_for_quote(xctx, action, action.resource.id, approved=approved, version=version)

    async def reconcile(self, xctx: ExecCtx, action: NormalizedAction) -> AdapterResult | None:
        """What became of an unknown link, settled at the provider (see the module docstring)."""
        return await reconcile_checkout(xctx, action)


async def _cancel_checkout(client: "payments.ProviderClient", checkout_id: str) -> None:
    """Cancels a checkout no link will be written for, atomically at the provider; anything but a
    cancelled checkout leaves the action unknown."""
    try:
        cancelled = await client.cancel(checkout_id)
    except (payments.ProviderError, payments.ProviderTimeout):
        raise AdapterUnknown("provider_unknown") from None
    if cancelled.state != "cancelled":
        log.error("payment_link_checkout_paid_without_link checkout_id=%s", checkout_id)
        raise AdapterUnknown("checkout_paid")


ADAPTER = register(PaymentLinkAdapter())


async def href_for(ctx: KernelCtx, fact: Fact) -> str:
    """The `payment_link` card's `href`: `/pay/{token}` for the link its fact names (its `ref`
    claim), which the API serves as the mock checkout page. A link no longer issued, or past its
    expiry, raises `NothingToShow`, so its card isn't shown, even before its fact catches up."""
    link_id = next(claim.value for claim in fact.claims if claim.key == "ref")
    token = (await ctx.db.scalars(ctx.repo.scoped(select(PaymentLink.token).where(
        PaymentLink.link_id == link_id, PaymentLink.state == "issued",
        PaymentLink.expires_at > ctx.clock.now())))).one_or_none()
    if token is None:
        raise render.NothingToShow(fact.fact_id)
    return f"/pay/{token}"


render.register_template("payment_link", {"payment_link"}, render.en.payment_link, render.es.payment_link,
                         key=FACT_PREFIX, href_for=href_for)
