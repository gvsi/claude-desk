"""Payments: the kernel's client of the mock payments provider, and a payment link's life once issued.

`ProviderClient` calls the mock payments server's `/provider/*` routes for one copy (`provider(ctx)`
builds it from the kernel's settings), with the kernel's key and the copy in headers, on a fresh HTTP
client per call that reads no proxy settings from the environment (`trust_env=False`). A write waits
at most `PROVIDER_DEADLINE_S` and a charge read `READ_DEADLINE_S`, each a total deadline. Every
answer parses through a strict, closed model, money as a strict integer from 0 to $10,000.

A call raises `ProviderError` only when its request never reached the provider (no key to send, a
connection refused, a connect or pool timeout) or the provider refused it (4xx). Anything else (a
deadline passed once the request may have been sent, a reset, a 3xx or 5xx, an answer that fails
validation) is `ProviderTimeout`: the request may have landed, so its outcome is unknown and is
settled later by its idempotency key (`void`), never retried blindly. Neither carries the key, a
token or a body.

`link_rules_allow` is the check a payment link gets against a rules version other than the one its
execution re-check ran under: when it is issued after a confirm (`adapters.payment_link`), and at an
activation.

`link_view` is what the mock checkout page reads of a link (`GET /payment_links/{token}`, which the
API proxies), by its token alone: the copy is found by the token's sha256, so the resolver never sees
a token, and the token goes in no log line or ledger entry. The view names the business, and, while
the link is live, the verified customer it was made for by first name and last initial; that name is
display only, and nothing the checkout sends back is read as a name.

A link then pays once (`complete_link`, in three steps as an execution runs: a marker, the
provider's completion, and the settling of an exception), or is cancelled (`cancel_link`), expires,
or is settled at the provider when nobody knows what became of it (`reconcile_link`, on every read
and at startup). A read also cancels an open link whose quote another payment has paid, as its
completion would be refused (`reconcile_link`), so the link reads as closed. Completion rechecks the
baseline, never the rules (`recheck_link_baseline`); a rule change reaches open links when it
activates instead (`cancel_disallowed_links`, an `activation.ON_ACTIVATE` hook), and the chat hears
of each link it cancelled (`cancelled_links`). A Desk's deletion cancels its open links
(`cancel_desk_links`, a `desks.ON_DELETE` hook).

A quote is paid once, by a mandate charge or by one of its links. Each payment checks the quote under
its row lock (`lock_quote`, `FOR UPDATE`, before its link in repo.py's order) before the provider is
asked, and holds that lock across the provider call, so of two payments of one quote the second
waits and then finds it `paid` (`quote_unpayable`); the payment that lands marks it `paid` in the
transaction that records it (`mark_quote_paid`). Any other payment of the quote not yet settled (a
charge's intent, a link's completion marker, either one `unknown`, however old) keeps the quote
unpayable until settlement shows whether money moved, so a payment that let go of the row without
writing its outcome (a timeout, a crash) is never paid around.
"""

import asyncio
import hashlib
import logging
import re
from collections.abc import Awaitable
from datetime import datetime
from typing import Annotated, Any, Literal
from urllib.parse import quote

import httpx2
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictInt, ValidationError
from psycopg import errors as pg_errors
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError, SQLAlchemyError

from desk.contracts import (AUTO_MONEY_HARD_CAP_CENTS, Claim, Clause, Fact, Label, LedgerEvent, NormalizedAction,
                            RenderedBlock, ReplyVerdict)
from desk.db.models import Action as ActionRow
from desk.db.models import Approval, Business, Desk, Execution, PaymentLink, Person, Quote
from desk.db.models import Decision as DecisionRow
from desk.db.models import Fact as FactRow
from desk.db.models import Mandate as MandateRow
from desk.db.models import PolicyVersion as PolicyVersionRow
from desk.kernel_api import LinkCancelled, PaymentLinkStateResult, PaymentLinkView
from desk.kernel_service import (activation, agents, auth, decide, execute, labels, ledger, mandates, render,
                                 reply_check, repo)
from desk.kernel_service.auth import Named, SessionRow
from desk.kernel_service.decisions import Reviewed
from desk.kernel_service.render.cards import DeskInfo, claims
from desk.kernel_service.repo import KernelCtx, KernelFailure, KernelRuntime, kernel_transaction
from desk.kernel_service.sessions import principal_for, verified

log = logging.getLogger(__name__)

PROVIDER_DEADLINE_S = 2.0       # a provider write: below the API client's 6 s, with the re-check and the rest
READ_DEADLINE_S = 1.0           # a provider read at normalize, beside the reviewer's 4 s
KEY_MIN_LENGTH = 32             # the mock payments server refuses a shorter key, so none is ever sent
KEY_HEADER = "X-Mockpay-Key"
COPY_HEADER = "X-Desk-Copy"
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")           # a payment link's token: secrets.token_urlsafe(32)
PERSON = "person:"                                  # a link's customer that is a person on record
LINK_FACT = "payment_link:"                         # a link's fact: `payment_link:<link_id>`
QUOTE_PAID = "paid"                                 # a quote's status once a payment for it has landed
CHARGE_TOOL = "native.charge_mandate"               # the tool whose actions pay a quote outright
CANCEL_REASONS = ("rules_changed", "person_removed", "mandate_expired", "amount_mismatch")   # cancel_reason values


class ProviderError(Exception):
    """The request never reached the provider, or the provider refused it (4xx): nothing happened."""


class ProviderTimeout(Exception):
    """The request may have reached the provider and its outcome is unknown."""


# ---- The provider's answers -------------------------------------------------------------------------

Cents = Annotated[StrictInt, Field(ge=0, le=AUTO_MONEY_HARD_CAP_CENTS)]
ObjectId = Annotated[str, Field(min_length=1, max_length=200)]


class _Answer(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)


class CheckoutCreated(_Answer):
    checkout_id: ObjectId


class CheckoutCompleted(_Answer):
    charge_id: ObjectId
    state: Literal["succeeded"]


class CheckoutCancelled(_Answer):
    state: Literal["cancelled", "succeeded"]       # a checkout already paid stays paid, with its charge
    charge_id: ObjectId | None = None


class ChargeCreated(_Answer):
    charge_id: ObjectId


class ChargeRead(_Answer):
    charge_id: ObjectId
    owner_person_id: str | None
    amount_cents: Cents
    refunded_cents: Cents


class Voided(_Answer):
    state: Literal["exists", "voided"]
    object_id: ObjectId


class Seeded(_Answer):
    charge_ids: list[ObjectId]


class DefinitionChanged(_Answer):
    definition: dict[str, Any]


class SeedCharge(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)

    owner_person_id: str
    amount_cents: Cents
    description: str
    created_at: AwareDatetime


# ---- The client ---------------------------------------------------------------------------------------

def _never_sent(error: httpx2.HTTPError) -> bool:
    """Whether a transport error means the request never reached the provider."""
    return isinstance(error, httpx2.ConnectError | httpx2.ConnectTimeout | httpx2.PoolTimeout
                      | httpx2.UnsupportedProtocol)


class ProviderClient:
    """The mock payments provider, for one copy. `transport` is a test hook (`httpx2.MockTransport`)."""

    def __init__(self, copy_id: str, *, url: str, key: str, transport: httpx2.AsyncBaseTransport | None = None):
        self.copy_id = copy_id
        self._url = url.rstrip("/")
        self._key = key
        self._transport = transport

    def __repr__(self) -> str:                    # never the key
        return f"ProviderClient(copy_id={self.copy_id!r}, url={self._url!r})"

    async def _call[M: _Answer](self, method: str, path: str, model: type[M], body: dict[str, Any] | None = None, *,
                                deadline: float = PROVIDER_DEADLINE_S) -> M:
        """One request, its answer parsed by `model`; `ProviderError` or `ProviderTimeout` otherwise."""
        if not isinstance(self._key, str) or len(self._key) < KEY_MIN_LENGTH:
            log.warning("provider_unconfigured path=%s", path)
            raise ProviderError("no_key")
        headers = {KEY_HEADER: self._key, COPY_HEADER: self.copy_id}
        try:
            async with httpx2.AsyncClient(base_url=self._url, headers=headers, timeout=httpx2.Timeout(deadline),
                                          trust_env=False, follow_redirects=False,
                                          transport=self._transport) as http:
                response = await _within(deadline, http.request(method, path, json=body))
        except httpx2.HTTPError as error:
            if _never_sent(error):
                log.warning("provider_unreachable path=%s error=%s", path, type(error).__name__)
                raise ProviderError("unreachable") from None
            log.warning("provider_unknown path=%s error=%s", path, type(error).__name__)
            raise ProviderTimeout("transport") from None
        except TimeoutError:
            log.warning("provider_unknown path=%s error=deadline", path)
            raise ProviderTimeout("deadline") from None
        if 400 <= response.status_code < 500:
            log.warning("provider_refused path=%s status=%d", path, response.status_code)
            raise ProviderError(f"refused_{response.status_code}")
        if response.status_code != 200:
            log.warning("provider_unknown path=%s status=%d", path, response.status_code)
            raise ProviderTimeout(f"status_{response.status_code}")
        try:
            return model.model_validate_json(response.content)
        except ValidationError:
            log.warning("provider_unknown path=%s error=invalid_answer", path)
            raise ProviderTimeout("invalid_answer") from None

    async def create_checkout(self, *, idempotency_key: str, amount_cents: int, title: str, customer_id: str) -> str:
        """A checkout for `amount_cents`, once per key: its ID."""
        created = await self._call("POST", "/provider/checkouts", CheckoutCreated, {
            "idempotency_key": idempotency_key, "amount_cents": amount_cents, "title": title,
            "customer_id": customer_id})
        return created.checkout_id

    async def complete(self, checkout_id: str) -> CheckoutCompleted:
        """Pays an open checkout, once however often asked; a cancelled one is refused (409)."""
        return await self._call("POST", f"/provider/checkouts/{_segment(checkout_id)}/complete", CheckoutCompleted,
                                {})

    async def cancel(self, checkout_id: str) -> CheckoutCancelled:
        """Cancels an open checkout, atomically at the provider; a paid one says so, with its charge."""
        return await self._call("POST", f"/provider/checkouts/{_segment(checkout_id)}/cancel", CheckoutCancelled, {})

    async def charge(self, *, idempotency_key: str, amount_cents: int, customer_id: str, description: str) -> str:
        """A charge, once per key (a voided key is refused): its ID."""
        created = await self._call("POST", "/provider/charges", ChargeCreated, {
            "idempotency_key": idempotency_key, "amount_cents": amount_cents, "customer_id": customer_id,
            "description": description})
        return created.charge_id

    async def read_charge(self, charge_id: str) -> ChargeRead:
        """A charge's owner and amounts; 404 (`ProviderError`) outside the copy."""
        return await self._call("GET", f"/provider/charges/{_segment(charge_id)}", ChargeRead,
                                deadline=READ_DEADLINE_S)

    async def void(self, kind: Literal["checkout", "charge", "refund"], idempotency_key: str) -> Voided:
        """Settles an idempotency key: `exists` with the object a request made with it, or `voided`,
        after which every request with it fails."""
        return await self._call("POST", "/provider/void", Voided, {"kind": kind, "idempotency_key": idempotency_key})

    async def seed(self, charges: list[SeedCharge]) -> list[str]:
        """Past charges for the copy's people: their IDs."""
        seeded = await self._call("POST", "/provider/seed", Seeded,
                                  {"charges": [charge.model_dump(mode="json") for charge in charges]})
        return seeded.charge_ids

    async def simulate_change(self, name: str) -> dict[str, Any]:
        """The demo's changed tool definition for this copy, as the server now lists it."""
        changed = await self._call("POST", f"/provider/tool_definitions/{_segment(name)}/simulate_change",
                                   DefinitionChanged, {})
        return changed.definition


def _segment(value: str) -> str:
    """A path segment: the provider's IDs, escaped so none can reach another route."""
    return quote(value, safe="")


async def _within[T](deadline: float, call: Awaitable[T]) -> T:
    """`call`, cancelled once `deadline` seconds have passed in all (TimeoutError)."""
    async with asyncio.timeout(deadline):
        return await call


def provider(ctx: KernelCtx, copy_id: str | None = None) -> ProviderClient:
    """The provider client for `copy_id` (the bound copy by default), from the kernel's settings."""
    return ProviderClient(copy_id or ctx.copy_id, url=ctx.settings.mockpay_url, key=ctx.settings.mockpay_key)


def token_sha256(token: str) -> str:
    """What a payment link's token is looked up by before its copy is bound (`copy_of_payment_link`)."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ---- The rules a payment link is issued under ---------------------------------------------------------------

async def lock_active_version(ctx: KernelCtx, desk_id: str, *, nowait: bool = False) -> PolicyVersionRow | None:
    """The Desk's active rules version, held `FOR SHARE` until the transaction ends: the row
    `activation.confirm` holds `FOR UPDATE`, so a confirm waits for whoever holds it, and one that
    committed first is seen. A wait that ends with the row superseded finds no row (the statement's
    snapshot predates the new active one), so the lookup is asked again, each time with a fresh
    snapshot. With `nowait`, a row a confirm holds raises at once (Postgres `lock_not_available`).
    None when the Desk has no active version."""
    for _ in range(3):
        row = (await ctx.db.scalars(ctx.repo.scoped(select(PolicyVersionRow).where(
            PolicyVersionRow.desk_id == desk_id, PolicyVersionRow.status == "active")
            .with_for_update(read=True, nowait=nowait).execution_options(populate_existing=True)))).one_or_none()
        if row is not None:
            return row
    return None



async def link_rules_allow(ctx: KernelCtx, decision: DecisionRow, action: NormalizedAction,
                           version: PolicyVersionRow) -> bool:
    """Whether `version` auto-allows the link `decision` let through, as step 6 re-checks an allow,
    from these inputs only: that version's rules (`B ∪ F ∪ A`, then step 5) at its money cap; the
    stored action (its `actions` row as the caller read it, not normalized again, and no
    `tools_given`) and the decision's stored review, with no reviewer call; the principal rebuilt
    from the session's current row, with an agent's `mandate_remaining_cents` as its mandate stands
    now, counting back the link's own reservation, which it already holds (so a link that took the
    last of a mandate still passes, and one whose mandate expired doesn't); `local_dow` and
    `local_minute` from the decision's time. No mode, generation or Answering condition applies, so
    switching Answering off or a change to another tool's rules never withdraws a link the rules
    still allow. A version that won't load, or any evaluation error, is False."""
    if ctx.policies.versions.use(version):
        return False
    session_row = (await ctx.db.scalars(ctx.repo.scoped(select(SessionRow).where(
        SessionRow.session_id == decision.session_id).execution_options(populate_existing=True)))).one()
    timezone = (await ctx.db.execute(ctx.repo.scoped(select(Business.timezone).join(
        Desk, Desk.business_id == Business.business_id).where(Desk.desk_id == decision.desk_id)))).scalar_one()
    remaining = await mandates.session_remaining(ctx, session_row, decision.desk_id, own_action_id=action.action_id)
    request = decide.cedar_request(principal_for(session_row, desk_id=decision.desk_id), action, tz=timezone,
                                   now=decision.created_at, auto_money_cap_cents=activation.version_cap(version),
                                   mandate_remaining_cents=remaining)
    stored = Reviewed(review=decision.review, usage=None)

    async def review_source(pending: list) -> Reviewed:
        return stored                                     # the review the link was decided with, never a new call

    evaluation = await decide.evaluate(ctx, version, request, review_source=review_source)
    return not evaluation.errored and evaluation.outcome == "allow"


async def owner_approved(ctx: KernelCtx, decision: DecisionRow) -> bool:
    """Whether the owner approved this link: a hold with a consumed approval bound to its call. Any
    other link counts as auto-allowed, and is checked against the rules version it is issued under
    and against each version that activates while it is open."""
    if decision.outcome != "hold":
        return False
    approval = (await ctx.db.scalars(ctx.repo.scoped(select(Approval).where(
        Approval.decision_id == decision.decision_id)))).one_or_none()
    return approval is not None and approval.consumed_at is not None and approval.binding_sha256 is not None


# ---- One payment per quote ---------------------------------------------------------------------------------

class QuoteBusy(Exception):
    """Another transaction holds the quote's row, and the caller doesn't wait for it."""


async def lock_quote(ctx: KernelCtx, quote_id: str, *, skip_locked: bool = False) -> Quote | None:
    """The quote, locked `FOR UPDATE` until the transaction ends (passed over while another holds
    it, with `skip_locked`), as last committed; None when there is none, or it was passed over."""
    return (await ctx.db.scalars(ctx.repo.scoped(select(Quote).where(Quote.quote_id == quote_id).with_for_update(
        skip_locked=skip_locked).execution_options(populate_existing=True)))).one_or_none()


async def lock_quote_nowait(ctx: KernelCtx, quote_id: str) -> Quote | None:
    """`lock_quote` for a reconciliation, which mustn't wait on a payment in progress: a row another
    transaction holds raises `QuoteBusy` at once, the transaction still usable, and the next read
    tries again."""
    try:
        async with ctx.db.begin_nested():
            return (await ctx.db.scalars(ctx.repo.scoped(select(Quote).where(Quote.quote_id == quote_id)
                                                         .with_for_update(nowait=True)
                                                         .execution_options(populate_existing=True)))).one_or_none()
    except DBAPIError as error:
        if isinstance(error.orig, pg_errors.LockNotAvailable):
            raise QuoteBusy(quote_id) from None
        raise


async def quote_unpayable(ctx: KernelCtx, quote_row: Quote, *, link_id: str | None = None,
                          action_id: str | None = None) -> str | None:
    """Why no payment of the quote may start now, or None: `quote_paid` once a payment of it has
    landed (its status, or a paid link or succeeded mandate charge of it); `quote_paying` while any
    other payment of it is unresolved, whatever its age: a link of it whose completion has started
    (its marker set, still `issued`) or that is `unknown`, or a mandate charge on it whose execution
    is an `intent` or `unknown`. `link_id` and `action_id` are the caller's own link or action, left
    out, so a payment never waits on itself, and its retry or reconciliation settles it.

    Holding the quote's row across a provider call isn't enough on its own: a payment whose call
    times out, or whose process dies, lets go of the row before its outcome is written, and a
    payment waiting on the row would then find the quote unpaid. So the other payment's intent or
    marker, committed before it asked the provider, blocks the quote until settlement proves that
    money moved (the quote `paid`) or that nothing did: a charge `failed`, by its T3 or by
    reconciliation's `void`; a link back to `issued` without its marker (a provider that was never
    reached), or `expired` or `cancelled` by the provider's atomic cancel. An orphan blocks until
    reconciliation settles it (a read of its decision or of its link, or the kernel's startup).
    Startup settles only intents and markers older than `execute.ORPHAN_AFTER`, so after a crash
    and a restart within that time a stranded payment keeps its quote unpayable until its own
    decision or link is read, at most for the quote's life (`QUOTE_TTL`); a new quote isn't
    affected. That is an accepted cost of paying a quote once."""
    if quote_row.status == QUOTE_PAID:
        return "quote_paid"
    links = (await ctx.db.execute(ctx.repo.scoped(select(
        PaymentLink.link_id, PaymentLink.state, PaymentLink.completion_started_at).where(
        PaymentLink.desk_id == quote_row.desk_id, PaymentLink.quote_id == quote_row.quote_id,
        PaymentLink.state.in_(("paid", "unknown", "issued")))))).all()
    paying = False
    for found_id, state, started_at in links:
        if found_id == link_id:
            continue
        if state == "paid":
            return "quote_paid"
        paying = paying or state == "unknown" or started_at is not None
    charges = (await ctx.db.execute(ctx.repo.scoped(select(
        ActionRow.action_id, ActionRow.resource, Execution.state).join(
        Execution, Execution.action_id == ActionRow.action_id).where(
        ActionRow.desk_id == quote_row.desk_id, ActionRow.session_id == quote_row.session_id,
        ActionRow.tool == CHARGE_TOOL)))).all()
    for found_id, resource, state in charges:
        if found_id == action_id or resource.id != quote_row.quote_id:
            continue
        if state == "succeeded":
            return "quote_paid"
        paying = paying or state in ("intent", "unknown")
    return "quote_paying" if paying else None


async def mark_quote_paid(ctx: KernelCtx, quote_id: str | None, *, paid_by: str) -> None:
    """The quote `paid`, in the caller's transaction, which records a payment of it that landed
    (`paid_by`: the link or the action), under the quote's row lock (taken here unless the caller
    holds it already). A quote another payment paid first stays `paid`, and the second payment is
    recorded all the same, since its money moved; the log says so. That happens only when an
    outcome nobody knew landed after the quote was paid another way."""
    if quote_id is None:
        log.error("quote_payment_without_quote paid_by=%s", paid_by)
        return
    quote_row = await lock_quote(ctx, quote_id)
    if quote_row is None:
        log.error("quote_payment_without_quote quote_id=%s paid_by=%s", quote_id, paid_by)
        return
    if quote_row.status == QUOTE_PAID:
        log.error("quote_paid_twice quote_id=%s paid_by=%s", quote_id, paid_by)
    quote_row.status = QUOTE_PAID
    await ctx.db.flush()


async def open_link_fact(ctx: KernelCtx, quote_row: Quote) -> Fact | None:
    """The quote's open link (`issued` and unexpired; the newest, if somehow more than one), as its
    fact; None when it has none."""
    now = ctx.clock.now()
    found = (await ctx.db.execute(ctx.repo.scoped(select(PaymentLink.link_id, PaymentLink.created_at).where(
        PaymentLink.desk_id == quote_row.desk_id, PaymentLink.quote_id == quote_row.quote_id,
        PaymentLink.state == "issued", PaymentLink.expires_at > now)))).all()
    if not found:
        return None
    link_id = max(found, key=lambda row: (row.created_at, row.link_id)).link_id
    row = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == quote_row.desk_id, FactRow.fact_id == f"{LINK_FACT}{link_id}")))).one_or_none()
    return labels.fact_of(row) if row is not None else None


# ---- A link's life after it is issued -------------------------------------------------------------------
#
# Every transition is ledgered `payment` `{link_id, state, ...}` with the link's session, and leaving
# `issued` expires the link's fact, so a later citation of it is `stale_fact`. Each step locks the
# link's row `FOR UPDATE` (a read and startup reconciliation `SKIP LOCKED`, so neither waits for a
# completion), before any ledger write in its transaction.

async def _after_marker() -> None:
    """A test hook between C1 and C2 (the marker committed, nothing sent yet); does nothing. It is
    looked up by its module name on each call, so patching the attribute reaches it."""


async def _before_c3() -> None:
    """A test hook between C2's rollback and C3; does nothing."""


def _event(link: PaymentLink, **summary: Any) -> LedgerEvent:
    """A link's `payment` entry, on its session."""
    return LedgerEvent(kind="payment", origin="kernel", session_id=link.session_id, ref_id=link.link_id,
                       summary={"link_id": link.link_id, **summary})


async def _ledger(ctx: KernelCtx, link: PaymentLink, **summary: Any) -> None:
    await ledger.append(ctx, copy_id=link.copy_id, desk_id=link.desk_id, event=_event(link, **summary))


async def _bind_token(ctx: KernelCtx, token: str) -> str:
    """The token's sha256, with the request's transaction bound to the copy of the link it opens; a
    token no link has, or no token could be, is 404 `not_found`, the same for all."""
    digest = token_sha256(token) if TOKEN.fullmatch(token) else None
    copy_id = await repo.copy_of_payment_link(ctx, digest) if digest is not None else None
    if copy_id is None:
        raise KernelFailure(404, "not_found", "unknown_payment_link")
    ctx.bind(copy_id)
    return digest


async def _lock(ctx: KernelCtx, *where: Any, skip_locked: bool = False) -> PaymentLink | None:
    """The one link `where` names, locked `FOR UPDATE` (passed over while another holds it, with
    `skip_locked`), as it is now; None when there is none, or it was passed over."""
    return (await ctx.db.scalars(ctx.repo.scoped(select(PaymentLink).where(*where).with_for_update(
        skip_locked=skip_locked).execution_options(populate_existing=True)))).one_or_none()


async def _locked(ctx: KernelCtx, link_id: str) -> PaymentLink:
    """The link `link_id`, which exists (links are never deleted), locked `FOR UPDATE`."""
    link = await _lock(ctx, PaymentLink.link_id == link_id)
    if link is None:
        raise RuntimeError(f"payment link {link_id} is gone")
    return link


async def _by_token(ctx: KernelCtx, digest: str) -> PaymentLink:
    link = await _lock(ctx, PaymentLink.token_sha256 == digest)
    if link is None:
        raise KernelFailure(404, "not_found", "unknown_payment_link")
    return link


def _due(link: PaymentLink, now: datetime) -> bool:
    """Whether an issued link no completion has started has passed its expiry."""
    return link.completion_started_at is None and (link.expires_at is None or link.expires_at <= now)


def _may_settle(state: str, completion_started_at: datetime | None, now: datetime) -> bool:
    """Whether `reconcile_link` may settle a link in this state at the provider: `unknown`, or
    `issued` with a completion marker older than `execute.ORPHAN_AFTER`."""
    return state == "unknown" or (state == "issued" and completion_started_at is not None
                                  and completion_started_at <= now - execute.ORPHAN_AFTER)


async def _move(ctx: KernelCtx, link: PaymentLink, state: str, *, cancel_reason: str | None = None,
                version: int | None = None) -> None:
    """The link to `state` in the caller's transaction, unledgered: its fact expired, with why and by
    which version, when given; an agent link's reservation released once it is `expired` or
    `cancelled`, and kept while it is `unknown`. A link that ends `paid` keeps no cancellation an
    activation gave it while its outcome was unknown: the provider paid it, and the `payment` entries
    keep that activation's reason and version."""
    link.state = state
    link.updated_at = ctx.clock.now()
    if cancel_reason is not None:
        link.cancel_reason = cancel_reason
    if version is not None:
        link.cancelled_by_version = version
    if state == "paid":
        link.cancel_reason, link.cancelled_by_version = None, None
    fact = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == link.desk_id, FactRow.fact_id == f"{LINK_FACT}{link.link_id}")))).one_or_none()
    if fact is not None:
        fact.status = "expired"
    if state in ("expired", "cancelled"):
        await release_reservation(ctx, link)


async def _expire(ctx: KernelCtx, link: PaymentLink) -> None:
    await _move(ctx, link, "expired")
    await _ledger(ctx, link, state="expired", reason="expired")


async def _refused(ctx: KernelCtx, link: PaymentLink, refused: str) -> KernelFailure:
    """A completion or cancel the link isn't in a state for: ledgered and committed, as `payment`
    `{link_id, refused: true, state, reason}` (the state the link stays in, and why it was refused,
    `refused`), so no retry reads as a move, a paid link's least of all; the answer is 409
    `conflict`, the link unchanged."""
    await _ledger(ctx, link, refused=True, state=link.state, reason=refused)
    await ctx.db.commit()
    return KernelFailure(409, "conflict", f"payment_link_{refused}")


def _not_payable(link: PaymentLink, now: datetime) -> str | None:
    """Why the link can't start a completion or be cancelled now (its state, `completing` while a
    completion has started, `expired` once due), or None."""
    if link.state != "issued":
        return link.state
    if link.completion_started_at is not None:
        return "completing"
    return "expired" if _due(link, now) else None


# ---- Mandate reservations ------------------------------------------------------------------------------
#
# An agent's link holds a reservation on its mandate from the moment it is issued (taken with its
# execution's intent, `adapters.payment_link`), and the link table settles it: `paid` commits it,
# `expired` or `cancelled` releases it, and `unknown` keeps it until the link is reconciled.

async def reservation_reserved(ctx: KernelCtx, link: PaymentLink) -> bool:
    """Whether the link's reservation on its mandate is still `reserved`."""
    return await mandates.reservation_state(ctx, link.action_id) == mandates.RESERVED


async def release_reservation(ctx: KernelCtx, link: PaymentLink) -> None:
    """Releases an agent link's reservation, in the caller's transaction (`mandates.release`; a
    visitor's link holds none)."""
    await mandates.release(ctx, link.action_id)


async def commit_reservation(ctx: KernelCtx, link: PaymentLink) -> None:
    """Commits an agent link's reservation once it is paid, in the caller's transaction
    (`mandates.commit`; a visitor's link holds none)."""
    await mandates.commit(ctx, link.action_id)


# ---- The baseline a completion rechecks ------------------------------------------------------------------

async def recheck_link_baseline(ctx: KernelCtx, link: PaymentLink) -> str | None:
    """What the baseline needs when money moves (safety invariant 1), checked by C1 under the link's
    lock, and no rules: rules aren't decided again at completion, so nothing counts the link's own
    reservation against it. None when it holds, else why not, in this order:

    - `desk_closed`: the Desk is deleted;
    - `session`: the link's session isn't one of its copy and Desk;
    - `person_removed`: a link made for a verified person (`person:<id>`) whose person is off the record;
    - `mandate_expired`: an agent session's link without an unexpired mandate of that session whose
      reservation for the link is still `reserved`;
    - `amount_mismatch`: the link's amount isn't the amount the kernel recorded for the action that
      issued it (the amount its decision was made on and its checkout was given; kernel data, no
      provider read), or is above `AUTO_MONEY_HARD_CAP_CENTS`."""
    desk = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == link.desk_id)))).one_or_none()
    if desk is None or desk.deleted_at is not None:
        return "desk_closed"
    session_row = (await ctx.db.scalars(ctx.repo.scoped(select(SessionRow).where(
        SessionRow.session_id == link.session_id).execution_options(populate_existing=True)))).one_or_none()
    if session_row is None or session_row.desk_id != link.desk_id or session_row.kind not in ("visitor", "agent"):
        return "session"
    if link.customer_id.startswith(PERSON):
        on_record = (await ctx.db.execute(ctx.repo.scoped(select(Person.person_id).where(
            Person.desk_id == link.desk_id, Person.person_id == link.customer_id.removeprefix(PERSON),
            Person.removed_at.is_(None))))).first()
        if on_record is None:
            return "person_removed"
    if (session_row.kind == "agent" or link.mandate_id is not None) and not await _mandate_holds(
            ctx, link, session_row):
        return "mandate_expired"
    recorded = (await ctx.db.execute(ctx.repo.scoped(select(ActionRow.amount_cents).where(
        ActionRow.action_id == link.action_id)))).scalar_one_or_none()
    if recorded is None or link.amount_cents != recorded or link.amount_cents > AUTO_MONEY_HARD_CAP_CENTS:
        return "amount_mismatch"
    return None


async def _mandate_holds(ctx: KernelCtx, link: PaymentLink, session_row: SessionRow) -> bool:
    """Whether an agent link's mandate is the session's, unexpired, and still holds the link's
    reservation."""
    return await mandate_live(ctx, link, session_row) and await reservation_reserved(ctx, link)


async def mandate_live(ctx: KernelCtx, link: PaymentLink, session_row: SessionRow | None) -> bool:
    """Whether an agent link names its session's mandate, and that mandate hasn't expired."""
    if link.mandate_id is None or session_row is None or session_row.mandate_id != link.mandate_id:
        return False
    expires_at = (await ctx.db.execute(ctx.repo.scoped(select(MandateRow.expires_at).where(
        MandateRow.mandate_id == link.mandate_id)))).scalar_one_or_none()
    moment = agents.parse_signed_time(expires_at) if expires_at is not None else None
    return moment is not None and moment > ctx.clock.now()


# ---- Completion ------------------------------------------------------------------------------------------

async def complete_link(ctx: KernelCtx, token: str) -> PaymentLinkStateResult:
    """`POST /payment_links/{token}/complete`: pays the link once, in up to three transactions, as an
    execution runs (master plan "Payment links"):

    - C1 locks the link; it must be `issued`, unexpired, with no completion started, else 409
      `conflict`, ledgered (an issued link past its expiry becomes `expired` first). Then the
      baseline (`recheck_link_baseline`): a failure cancels the link (its `cancel_reason`) and
      answers 409 `conflict`. Then it sets the link's completion marker and commits.
    - C2 holds the session row `FOR SHARE` (so the verdict's generation holds, and nothing closes
      the session until C2 commits), then the link's quote `FOR UPDATE` (`lock_quote`, held across
      the provider call, so no other payment of the quote runs meanwhile), locks the link, and
      needs it still `issued` with this completion's marker, else 409 `conflict` with no provider
      call (an activation moved it). Then, under that session row and before the provider is asked,
      the link's session must still stand (`_session_ended`, as an execution's T2 asks
      `auth.session_stands` before its adapter acts): one that doesn't cancels the link, ledgered
      with why, and answers 409 `conflict`, with nothing sent. So does a quote that is already paid,
      or that another payment may be paying (`quote_unpayable`: the reason is ledgered, the link
      cancelled with no `cancel_reason`). Then the provider completes the checkout, and the link is
      `paid`, the quote too, with its `charge` fact and a signed `payment_confirmed` verdict,
      committed with a plain commit: it records what the provider did, which nothing after may take
      back.
    - C3 settles an exception in C2, which rolled back, only while the link is still `issued` with
      the marker: a `ProviderError` (nothing reached the provider) returns it to `issued` without
      its marker, 502 `internal`; anything else leaves it `unknown`, marker kept, for
      `reconcile_link`. A link something else moved answers as it now stands."""
    digest = await _bind_token(ctx, token)
    link = await _by_token(ctx, digest)
    now = ctx.clock.now()
    if (refused := _not_payable(link, now)) is not None:
        if refused == "expired" and link.state == "issued":
            await _expire(ctx, link)
        raise await _refused(ctx, link, refused)
    if (failed := await recheck_link_baseline(ctx, link)) is not None:
        await _move(ctx, link, "cancelled", cancel_reason=failed if failed in CANCEL_REASONS else None)
        await _ledger(ctx, link, state="cancelled", reason=failed)
        await ctx.db.commit()
        raise KernelFailure(409, "conflict", f"payment_link_baseline:{failed}")
    link.completion_started_at, link.updated_at = now, now
    link_id, session_id, marker = link.link_id, link.session_id, now
    await ctx.db.commit()                                 # C1: the marker, before anything is sent
    await _after_marker()
    try:
        outcome = await _pay(ctx, link_id, session_id, marker)
    except Exception as error:
        await ctx.db.rollback()
        await _before_c3()
        return await _settle(ctx, link_id, session_id, marker, error)
    if isinstance(outcome, KernelFailure):
        raise outcome
    return outcome


async def _pay(ctx: KernelCtx, link_id: str, session_id: str,
               marker: datetime) -> PaymentLinkStateResult | KernelFailure:
    """C2: the provider's completion and `paid`, committed. A refusal comes back as a committed
    `KernelFailure` for `complete_link` to raise."""
    session_row = (await ctx.db.scalars(ctx.repo.scoped(select(SessionRow).where(
        SessionRow.session_id == session_id).with_for_update(read=True)
        .execution_options(populate_existing=True)))).one()
    quote_id = (await ctx.db.execute(ctx.repo.scoped(select(PaymentLink.quote_id).where(
        PaymentLink.link_id == link_id)))).scalar_one()            # a link's quote never changes
    quote_row = await lock_quote(ctx, quote_id) if quote_id is not None else None   # before the link: repo.py
    link = await _locked(ctx, link_id)
    if link.state != "issued" or link.completion_started_at != marker:
        return await _refused(ctx, link, "moved")
    if (ended := await _session_ended(ctx, link)) is not None:
        # checked under the session row this step holds, so the session can't close before the
        # provider is asked; nothing is sent, and the link can never be paid now
        await _move(ctx, link, "cancelled", cancel_reason=ended if ended in CANCEL_REASONS else None)
        await _ledger(ctx, link, state="cancelled", reason=ended)
        await ctx.db.commit()
        return KernelFailure(409, "conflict", f"payment_link_session:{ended}")
    unpayable = "no_such_quote" if quote_row is None else await quote_unpayable(ctx, quote_row, link_id=link.link_id)
    if unpayable is not None:
        # checked under the quote's row, which this step holds across the provider call, so of two
        # payments of one quote only one is sent; nothing is sent for this one
        await _move(ctx, link, "cancelled")
        await _ledger(ctx, link, state="cancelled", reason=unpayable)
        await ctx.db.commit()
        return KernelFailure(409, "conflict", f"payment_link_quote:{unpayable}")
    completed = await provider(ctx).complete(link.provider_checkout_id)
    verdict = await record_paid(ctx, link, session_row, completed.charge_id, confirm=True)
    await ctx.db.commit()                                 # what the provider did, recorded: never taken back
    return PaymentLinkStateResult(state="paid", session_id=session_id, verdict=verdict)


async def _session_ended(ctx: KernelCtx, link: PaymentLink) -> str | None:
    """Why the link's session no longer stands (`auth.session_stands`, read afresh, for the person a
    link made for one names): `desk_closed` when its Desk is deleted, `person_removed` when that
    person is off the record, `session_closed` for any other close; None while it stands."""
    person = link.customer_id.removeprefix(PERSON) if link.customer_id.startswith(PERSON) else None
    named = Named(copy_id=link.copy_id, desk_id=link.desk_id, session_id=link.session_id)
    if await auth.session_stands(ctx, named, person):
        return None
    deleted = (await ctx.db.execute(ctx.repo.scoped(select(Desk.deleted_at).where(
        Desk.desk_id == link.desk_id)))).scalar_one_or_none()
    if deleted is not None:
        return "desk_closed"
    if person is not None and (await ctx.db.execute(ctx.repo.scoped(select(Person.person_id).where(
            Person.person_id == person, Person.removed_at.is_(None))))).first() is None:
        return "person_removed"
    return "session_closed"


async def _settle(ctx: KernelCtx, link_id: str, session_id: str, marker: datetime,
                  error: Exception) -> PaymentLinkStateResult:
    """C3, after `error` in C2 (see `complete_link`)."""
    link = await _locked(ctx, link_id)
    if link.state != "issued" or link.completion_started_at != marker:
        await ctx.db.commit()                             # an activation moved it; reconciliation settles it
        return PaymentLinkStateResult(state=link.state, session_id=session_id, verdict=None)
    if isinstance(error, ProviderError):
        link.completion_started_at, link.updated_at = None, ctx.clock.now()
        await _ledger(ctx, link, state="issued", reason="provider_refused")
        await ctx.db.commit()
        raise KernelFailure(502, "internal", "payment_link_provider_refused")
    log.error("payment_link_unknown link_id=%s error=%s", link_id, type(error).__name__)
    await _move(ctx, link, "unknown")
    await _ledger(ctx, link, state="unknown", reason="provider_unknown")
    await ctx.db.commit()
    return PaymentLinkStateResult(state="unknown", session_id=session_id, verdict=None)


async def locked_fact(ctx: KernelCtx, desk_id: str, fact_id: str) -> FactRow:
    """The fact's row as last committed, locked `FOR UPDATE` until the transaction ends."""
    return (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == desk_id, FactRow.fact_id == fact_id).with_for_update()
        .execution_options(populate_existing=True)))).one()


async def insert_fact(ctx: KernelCtx, row: FactRow) -> bool:
    """Inserts `row` unless a fact already has its ID, `INSERT ... ON CONFLICT DO NOTHING` (which
    waits for a writer of that ID still in flight, so two writers never collide): whether it did."""
    values = {column.key: getattr(row, column.key) for column in FactRow.__table__.columns
              if getattr(row, column.key) is not None}
    inserted = await ctx.db.execute(pg_insert(FactRow).values(**values).on_conflict_do_nothing(
        index_elements=[FactRow.desk_id, FactRow.fact_id]).returning(FactRow.fact_id))
    return inserted.first() is not None


async def write_charge_fact(ctx: KernelCtx, copy_id: str, desk_id: str, fact: Fact, *, session_id: str | None,
                            action_id: str | None) -> Fact:
    """A payment's `charge:<charge_id>` fact, written in the caller's transaction: every payment that
    settles writes its fact here (the seed's past payments are written as the copy is made, before
    anything can list them). A listing (`payments.list_charges`) shows a charge as soon as the
    provider has taken it, so it may have written the fact first, while the payment was still
    settling: when that fact is the kernel's `charge` for the same record owner, it becomes
    `fact` (its claims, status, session and action), keeping any reader it had after `fact`'s.
    Anything else under that ID (another kind, another record owner, or none) fails closed, logged
    (500 `internal`), and the payment stays unsettled for reconciliation. Returns the fact stored."""
    row = labels.fact_row(copy_id, desk_id, fact, ctx.clock.now(), session_id=session_id, action_id=action_id)
    if await insert_fact(ctx, row):
        return fact
    stored = await locked_fact(ctx, desk_id, fact.fact_id)
    owner = fact.label.record_owner
    if stored.kind != "charge" or stored.source != "kernel" or owner is None or stored.record_owner != owner:
        log.error("charge_fact_conflict fact_id=%s", fact.fact_id)
        raise KernelFailure(500, "internal", "charge_fact_conflict")
    stored.claims, stored.status, stored.expires_at = fact.claims, fact.status, fact.expires_at
    stored.session_id, stored.action_id = session_id, action_id
    stored.readers = list(dict.fromkeys([*fact.label.readers, *(stored.readers or labels.OWNER_ONLY)]))
    await ctx.db.flush()
    return labels.fact_of(stored)


async def record_paid(ctx: KernelCtx, link: PaymentLink, session_row: SessionRow, charge_id: str, *,
                      confirm: bool) -> ReplyVerdict | None:
    """The link `paid` by the provider's charge, in the caller's transaction: its quote `paid`
    (`mark_quote_paid`; the caller holds the quote's row), a `charge:<charge_id>`
    fact (the link's title and total, and its ID; readable by the owner, the link's session and,
    for a link made for a verified person, that person, its record owner), through
    `write_charge_fact`, so a listing that wrote it first gives way; the link's own fact expired, an
    agent link's reservation committed, ledgered `payment` `{link_id, state: "paid", charge_id,
    policy_version, auto_money_cap_cents}` with the rules version in force and its cap. With
    `confirm`, a completion's: the signed verdict with one `payment_confirmed` block in the
    session's last language, at its current generation (ledgered `reply`), in any session mode,
    since `deliver()` decides what is shown; a reconciliation's is None, and Claude cites the fact."""
    await mark_quote_paid(ctx, link.quote_id, paid_by=link.link_id)
    label = labels.new_fact_label(session_row)
    if link.customer_id.startswith(PERSON):
        person = link.customer_id.removeprefix(PERSON)
        label = Label(readers=list(dict.fromkeys([*label.readers, f"person:{person}"])), record_owner=person)
    fact = await write_charge_fact(ctx, link.copy_id, link.desk_id, Fact(
        fact_id=f"charge:{charge_id}", kind="charge", status="committed", source="kernel",
        claims=[Claim(key="title", kind="text", value=link.title),
                Claim(key="total", kind="money", value=link.amount_cents),
                Claim(key="ref", kind="ref", value=link.link_id)], label=label),
        session_id=link.session_id, action_id=link.action_id)
    await _move(ctx, link, "paid")
    await commit_reservation(ctx, link)
    await ctx.db.flush()
    active = await activation.active_version(ctx, link.desk_id)
    await _ledger(ctx, link, state="paid", charge_id=charge_id,
                  policy_version=active.version if active is not None else None,
                  auto_money_cap_cents=activation.version_cap(active), **({} if confirm else {"reconciled": True}))
    if not confirm:
        return None
    language = render.language(session_row.last_language)
    desk = await _desk_info(ctx, link.desk_id)
    block = render.render_clause(Clause(template="payment_confirmed", fact_id=fact.fact_id), fact, language, desk)
    return await reply_check.finalize(ctx, session_row, blocks=[block], violations=[], language=language,
                                      author="desk", fact_ids=[fact.fact_id])


# ---- Cancelling ------------------------------------------------------------------------------------------

async def cancel_link(ctx: KernelCtx, token: str) -> PaymentLinkStateResult:
    """`POST /payment_links/{token}/cancel`: an issued link no completion has started becomes
    `cancelled` (no reason: the visitor chose it), ledgered, its fact expired, an agent link's
    reservation released. Anything else is 409 `conflict`, ledgered: a link being completed waits
    for its completion, and one past its expiry becomes `expired` first. No provider call: no
    completion was ever sent for it."""
    digest = await _bind_token(ctx, token)
    link = await _by_token(ctx, digest)
    if (refused := _not_payable(link, ctx.clock.now())) is not None:
        if refused == "expired" and link.state == "issued":
            await _expire(ctx, link)
        raise await _refused(ctx, link, refused)
    await _move(ctx, link, "cancelled")
    await _ledger(ctx, link, state="cancelled", reason="cancelled")
    return PaymentLinkStateResult(state="cancelled", session_id=link.session_id, verdict=None)


# ---- Reconciliation --------------------------------------------------------------------------------------

async def reconcile_link(ctx: KernelCtx, link_id: str) -> bool:
    """Settles one link as a read finds it, in the caller's transaction, with its row locked `FOR
    UPDATE SKIP LOCKED` (a link a completion or an activation holds is left for the next read), and
    says whether it moved it; a read commits that at once (`settle_link`):

    - `issued` with no completion started and past its expiry: `expired`;
    - `issued` with no completion started, whose quote another payment has paid (a mandate charge,
      or another of its links): `cancelled`, ledgered `quote_paid` as a completion's refusal is
      (`_paid_another_way`), with nothing asked of the provider, since none was sent for it; a quote
      another payment is only paying (`quote_paying`) leaves the link open;
    - `issued` with a completion marker older than `execute.ORPHAN_AFTER`: no completion is running
      it any more, so it is `unknown`, and settled as below; a younger marker is left alone, even
      past the link's expiry, since that completion may be at the provider;
    - `unknown`: the provider cancels the checkout, atomically, and says what became of it: paid
      (`succeeded`, with its charge) is `paid`, with the charge fact and no verdict; `cancelled` is
      `cancelled` for a link an activation moved for its mandate or its rules (its `cancel_reason`),
      else `expired`; a provider that can't be reached leaves it `unknown`.

    Settling one at the provider may record its payment, which marks its quote `paid`, so for a
    link that may come to that the quote's row is taken first, `FOR UPDATE SKIP LOCKED`, before the
    link's (repo.py): a quote a payment holds leaves the link for the next read, and so does a link
    that came to need it only after it was first read."""
    now = ctx.clock.now()
    peek = (await ctx.db.execute(ctx.repo.scoped(select(
        PaymentLink.quote_id, PaymentLink.state, PaymentLink.completion_started_at).where(
        PaymentLink.link_id == link_id)))).one_or_none()
    if peek is None:
        return False
    quote_held = paid_another_way = False
    if _may_settle(peek.state, peek.completion_started_at, now):
        if peek.quote_id is not None and await lock_quote(ctx, peek.quote_id, skip_locked=True) is None:
            return False                                  # a payment of its quote holds it: the next read
        quote_held = True
    elif peek.state == "issued" and peek.completion_started_at is None and peek.quote_id is not None:
        paid_another_way = await _paid_another_way(ctx, peek.quote_id, link_id)
    link = await _lock(ctx, PaymentLink.link_id == link_id, skip_locked=True)
    if link is None:
        return False
    orphaned = False
    if link.state == "issued":
        if _due(link, now):
            await _expire(ctx, link)
            return True
        if link.completion_started_at is None and paid_another_way:
            await _move(ctx, link, "cancelled")
            await _ledger(ctx, link, state="cancelled", reason="quote_paid")
            return True
        if link.completion_started_at is None or link.completion_started_at > now - execute.ORPHAN_AFTER:
            return False
        if not quote_held:
            return False                                  # orphaned since it was read: the next read
        await _move(ctx, link, "unknown")
        await _ledger(ctx, link, state="unknown", reason="orphaned")
        orphaned = True
    if link.state != "unknown" or not quote_held:
        return orphaned
    try:
        settled = await provider(ctx).cancel(link.provider_checkout_id)
    except (ProviderError, ProviderTimeout):
        log.info("payment_link_still_unknown link_id=%s", link.link_id)
        return orphaned
    if settled.state == "succeeded":
        if settled.charge_id is None:
            log.error("payment_link_paid_without_charge link_id=%s", link.link_id)
            return orphaned
        session_row = (await ctx.db.scalars(ctx.repo.scoped(select(SessionRow).where(
            SessionRow.session_id == link.session_id)))).one()
        await record_paid(ctx, link, session_row, settled.charge_id, confirm=False)
        return True
    state = "cancelled" if link.cancel_reason is not None else "expired"
    await _move(ctx, link, state)
    moved_by = {"version": link.cancelled_by_version} if link.cancelled_by_version is not None else {}
    await _ledger(ctx, link, state=state, reason=link.cancel_reason or "expired", **moved_by, reconciled=True)
    return True


async def _paid_another_way(ctx: KernelCtx, quote_id: str, link_id: str) -> bool:
    """Whether another payment has paid the link's quote (`quote_unpayable` says `quote_paid`, which,
    once true, stays true): read first without a lock, so a read of a link whose quote is unpaid
    locks nothing it didn't, then again under the quote's row, taken `FOR UPDATE SKIP LOCKED` before
    the link's, in repo.py's order, as a completion takes them. A quote a payment holds is passed
    over, and its link left for the next read; a quote another payment is only paying
    (`quote_paying`) isn't paid."""
    seen = (await ctx.db.scalars(ctx.repo.scoped(select(Quote).where(Quote.quote_id == quote_id)))).one_or_none()
    if seen is None or await quote_unpayable(ctx, seen, link_id=link_id) != "quote_paid":
        return False
    quote_row = await lock_quote(ctx, quote_id, skip_locked=True)
    return quote_row is not None and await quote_unpayable(ctx, quote_row, link_id=link_id) == "quote_paid"


async def settle_link(ctx: KernelCtx, link_id: str) -> None:
    """`reconcile_link` as a read runs it: what it moved is committed at once with a plain commit,
    before the read goes on, since it records what already happened (an expiry, or what the
    provider's atomic cancel found: a payment or a cancelled checkout), as a decision's read commits
    its reconciliation (`execute.reconcile_orphans`). A read that fails afterwards leaves it
    standing, and the next read finds the link settled, asking the provider nothing again."""
    if await reconcile_link(ctx, link_id):
        await ctx.db.commit()


async def reconcile_links_at_startup(runtime: KernelRuntime) -> list[str]:
    """Startup reconciliation of links: every copy with an `unknown` link or an issued one whose
    completion marker is older than `execute.ORPHAN_AFTER` (`repo.unsettled_links`), each link
    settled by `reconcile_link` and committed on its own through its copy's `KernelRepo`; one that
    fails is logged and left for the next read. Returns the links it looked at."""
    found = await repo.unsettled_links(runtime, runtime.clock.now() - execute.ORPHAN_AFTER)
    by_copy: dict[str, list[str]] = {}
    for copy_id, link_id in found:
        by_copy.setdefault(copy_id, []).append(link_id)
    for copy_id, link_ids in sorted(by_copy.items()):
        try:
            async with kernel_transaction(runtime) as ctx:
                ctx.bind(copy_id)
                for link_id in link_ids:
                    try:
                        await reconcile_link(ctx, link_id)
                        await ctx.db.commit()
                    except Exception as exc:
                        repo.log_error(log, exc, "payment_link_reconcile_failed link_id=%s", link_id)
                        await ctx.db.rollback()
        except Exception as exc:
            repo.log_error(log, exc, "payment_link_startup_failed copy_id=%s", copy_id)
    return [link_id for _, link_id in found]


# ---- A rule change ---------------------------------------------------------------------------------------

async def cancel_disallowed_links(ctx: KernelCtx, desk_id: str, version: PolicyVersionRow) -> list[LedgerEvent]:
    """`activation.ON_ACTIVATE`, inside the confirm of `version`: what the activation does to the
    Desk's `issued` links, returned as `payment` events `{link_id, state, reason, version}` for
    `confirm` to ledger after its own entry. It locks every one `FOR UPDATE`, in `link_id` order,
    before the confirm writes anything (a completion holds its link's lock while it ledgers, so a
    completion step and an activation never interleave), and decides one move per link:

    - past its expiry: `expired` (reason `expired`);
    - an agent link whose mandate has expired: `cancelled`, `mandate_expired` (no chat line);
    - an auto-allowed link `link_rules_allow` says `version` no longer allows: `cancelled`,
      `rules_changed`. A link the owner approved isn't evaluated again: that approval was single-use
      and bound to its call. Switching Answering off, or a change to another tool's rules, cancels
      nothing the rules still allow.

    A cancelled link names `version` (`cancelled_by_version`), its fact is expired and an agent
    link's reservation released. A link whose completion has started may already be at the
    provider, so whatever the move it goes to `unknown` instead, with the move's reason and the
    version, and its marker and reservation kept: its C2 then refuses it with no provider call, and
    `reconcile_link` settles it with the provider's atomic cancel."""
    links = list(await ctx.db.scalars(ctx.repo.scoped(select(PaymentLink).where(
        PaymentLink.desk_id == desk_id, PaymentLink.state == "issued").order_by(PaymentLink.link_id)
        .with_for_update().execution_options(populate_existing=True))))
    events: list[LedgerEvent] = []
    for link in links:
        move = await _activation_move(ctx, link, version)
        if move is None:
            continue
        state, reason = move
        cancel_reason = reason if reason in CANCEL_REASONS else None
        if link.completion_started_at is not None:
            await _move(ctx, link, "unknown", cancel_reason=cancel_reason, version=version.version)
            state = "unknown"
        else:
            await _move(ctx, link, state, cancel_reason=cancel_reason,
                        version=version.version if state == "cancelled" else None)
        events.append(_event(link, state=state, reason=reason, version=version.version))
    return events


async def _activation_move(ctx: KernelCtx, link: PaymentLink, version: PolicyVersionRow) -> tuple[str, str] | None:
    """The move an activation of `version` makes on an issued link, `(state, reason)`, or None."""
    if link.expires_at is None or link.expires_at <= ctx.clock.now():
        return "expired", "expired"
    session_row = (await ctx.db.scalars(ctx.repo.scoped(select(SessionRow).where(
        SessionRow.session_id == link.session_id)))).one_or_none()
    agent = link.mandate_id is not None or (session_row is not None and session_row.kind == "agent")
    if agent and not await mandate_live(ctx, link, session_row):
        return "cancelled", "mandate_expired"
    decision = (await ctx.db.scalars(ctx.repo.scoped(select(DecisionRow).where(
        DecisionRow.action_id == link.action_id)))).one_or_none()
    if decision is not None and await owner_approved(ctx, decision):
        return None
    action = (await ctx.db.scalars(ctx.repo.scoped(select(ActionRow).where(
        ActionRow.action_id == link.action_id)))).one_or_none()
    if decision is None or action is None:
        return "cancelled", "rules_changed"                # nothing to check it against: fail closed
    if not await link_rules_allow(ctx, decision, decide.normalized_action(action), version):
        return "cancelled", "rules_changed"
    return None


async def _cancelled_card(ctx: KernelCtx, link: PaymentLink, session_row: SessionRow, language: render.Language,
                          desk: DeskInfo, canaries: dict[str, str]) -> RenderedBlock | None:
    """The `link_cancelled` card for `link` in its session's chat: its amount and what it was for,
    rendered from the link's own `payment_link` fact (the one named after it, whose `ref` is it)
    with the reply check's reader test: the session reads as itself and, once verified, its person
    (`labels.session_readers`), and no field the card shows holds a document canary. None when any
    of that fails, or the fact is malformed (claims that don't parse, no source, or a total or
    title the card can't show), logged: the chat gets no line rather than figures it may not read
    or that aren't the fact's, and the checkout page still says why the link was cancelled. A
    malformed fact withholds only its own link's line, never another link's. A database error
    raises, even one that is also a `KeyError` (`NoSuchColumnError`), and fails the whole read."""
    fact_id = f"{LINK_FACT}{link.link_id}"
    template = render.TEMPLATES["link_cancelled"]
    try:
        row = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == link.desk_id, FactRow.fact_id == fact_id)))).one_or_none()
        fact = labels.fact_of(row) if row is not None else None
        if fact is None:
            withheld = "no_such_fact"
        elif not labels.can_read(fact.label, labels.session_readers(session_row)):
            withheld = "not_a_reader"
        elif not template.reads(fact) or claims(fact).get("ref") != link.link_id:
            withheld = "template_mismatch"
        else:
            block = render.render_clause(Clause(template="link_cancelled", fact_id=fact_id), fact, language, desk)
            if not reply_check.carries(block, canaries):
                return block
            withheld = "canary"
    except SQLAlchemyError:
        raise                                           # the database's failure, not the fact's: fail the read
    except (KeyError, TypeError, ValidationError):
        withheld = "malformed"
    log.error("link_cancelled_withheld link_id=%s reason=%s", link.link_id, withheld)
    return None


async def cancelled_links(ctx: KernelCtx, desk_id: str, version: int) -> list[LinkCancelled]:
    """`GET /policy/{version}/cancelled_links?desk_id=`: the links `version`'s activation cancelled for
    a rule change whose session is still open, each with its chat line: a verdict with one
    `link_cancelled` card in the session's last language, rendered when read from the link's own
    fact (`_cancelled_card`; a link whose card can't be shown is left out), signed at the session's
    current generation and ledgered `reply` (naming the link's fact). Links that version moved to
    `unknown` are reconciled first, each committed at once (`settle_link`), so one the provider then
    cancels is listed too. It is idempotent per `(link_id, version)`: a repeat read lists the same
    links, each with a freshly signed verdict and its own `reply` entry, so the API can read a
    version again after a failure."""
    pending = await ctx.db.scalars(ctx.repo.scoped(select(PaymentLink.link_id).where(
        PaymentLink.desk_id == desk_id, PaymentLink.state == "unknown", PaymentLink.cancelled_by_version == version)
        .order_by(PaymentLink.link_id)))
    for link_id in list(pending):
        await settle_link(ctx, link_id)
    rows = (await ctx.db.execute(ctx.repo.scoped(select(PaymentLink, SessionRow).join(
        SessionRow, SessionRow.session_id == PaymentLink.session_id).where(
        PaymentLink.desk_id == desk_id, PaymentLink.state == "cancelled", PaymentLink.cancel_reason == "rules_changed",
        PaymentLink.cancelled_by_version == version, SessionRow.closed_at.is_(None))
        .order_by(PaymentLink.link_id).execution_options(populate_existing=True)))).all()
    desk = await _desk_info(ctx, desk_id)
    canaries = await labels.copy_canaries(ctx)
    listed = []
    for link, session_row in rows:
        language = render.language(session_row.last_language)
        if (block := await _cancelled_card(ctx, link, session_row, language, desk, canaries)) is None:
            continue
        verdict = await reply_check.finalize(ctx, session_row, blocks=[block], violations=[], language=language,
                                             author="desk", fact_ids=[f"{LINK_FACT}{link.link_id}"])
        listed.append(LinkCancelled(link_id=link.link_id, session_id=session_row.session_id, verdict=verdict))
    return listed


# ---- A deleted Desk -------------------------------------------------------------------------------------

async def _desk_links(ctx: KernelCtx, desk_id: str) -> list[PaymentLink]:
    """The Desk's issued links no completion has started, locked `FOR UPDATE` in `link_id` order."""
    return list(await ctx.db.scalars(ctx.repo.scoped(select(PaymentLink).where(
        PaymentLink.desk_id == desk_id, PaymentLink.state == "issued", PaymentLink.completion_started_at.is_(None))
        .order_by(PaymentLink.link_id).with_for_update().execution_options(populate_existing=True))))


async def lock_desk_links(ctx: KernelCtx, desk_id: str) -> None:
    """`desks.ON_DELETE`, first: the links `cancel_desk_links` will cancel, locked before the
    deletion takes its document links and their facts, as repo.py orders them. Holding them, no
    completion can start on one, so the later call finds the same links."""
    await _desk_links(ctx, desk_id)


async def cancel_desk_links(ctx: KernelCtx, desk_id: str) -> None:
    """`desks.ON_DELETE`, inside the Desk's deletion: its issued links no completion has started
    become `cancelled` (no reason), each ledgered `payment` `{link_id, state, reason: "desk_deleted"}`,
    its fact expired, an agent link's reservation released. Every link is locked, in `link_id` order,
    before the first entry is written (`lock_desk_links` already holds them). No provider call: none
    of them was ever sent. A link whose completion has started, or whose outcome is unknown, may
    already be at the provider, so it stays for its completion or reconciliation. An exception rolls
    the deletion back."""
    links = await _desk_links(ctx, desk_id)
    for link in links:
        await _move(ctx, link, "cancelled")
    for link in links:
        await _ledger(ctx, link, state="cancelled", reason="desk_deleted")


# ---- What the checkout page shows ------------------------------------------------------------------------

async def link_view(ctx: KernelCtx, token: str) -> PaymentLinkView:
    """`GET /payment_links/{token}`: the link's title, amount and state, its session's last language,
    the business's name as the link's Desk's public page serves it now (`public.header_of`: one
    holding a document canary is withheld there, and here), and `customer_name`, read in the
    request's transaction (unbound until the token's hash names a copy) once the read has settled
    the link (`settle_link`, which commits what it moved before the read goes on): an issued link
    past its expiry is `expired`, unless a completion has started. A link a rule change cancelled
    says so (`cancel_reason`). A token no link has, or no token could be, is 404 `not_found`, the
    same for all."""
    digest = await _bind_token(ctx, token)
    link_id = (await ctx.db.execute(ctx.repo.scoped(select(PaymentLink.link_id).where(
        PaymentLink.token_sha256 == digest)))).scalar_one_or_none()
    if link_id is None:
        raise KernelFailure(404, "not_found", "unknown_payment_link")
    await settle_link(ctx, link_id)
    link = (await ctx.db.scalars(ctx.repo.scoped(select(PaymentLink).where(PaymentLink.link_id == link_id)
                                                 .execution_options(populate_existing=True)))).one()
    desk, business = (await ctx.db.execute(ctx.repo.scoped(select(Desk, Business).join(
        Business, Business.business_id == Desk.business_id).where(Desk.desk_id == link.desk_id)))).one()
    session_row = (await ctx.db.scalars(ctx.repo.scoped(select(SessionRow).where(
        SessionRow.session_id == link.session_id)))).one_or_none()
    now = ctx.clock.now()
    live = link.state == "issued" and link.expires_at is not None and link.expires_at > now
    state = "expired" if link.state == "issued" and not live and link.completion_started_at is None else link.state
    name = await customer_name(ctx, link, session_row) if live and desk.deleted_at is None else None
    rules_changed = link.state == "cancelled" and link.cancel_reason == "rules_changed"
    from desk.kernel_service import public     # public reads the adapters, which import this module

    header, _ = public.header_of(desk, business, await labels.copy_canaries(ctx))
    return PaymentLinkView(title=link.title, amount_cents=link.amount_cents, state=state,
                           language=render.language(session_row.last_language if session_row is not None else None),
                           business_name=header["business_name"], customer_name=name,
                           cancel_reason="rules_changed" if rules_changed else None)


async def customer_name(ctx: KernelCtx, link: PaymentLink, session_row: SessionRow | None) -> str | None:
    """The live link's customer, by first name and last initial (`short_name`), read from the person
    on record now: only for a link made for a person (`person:<id>`) in a visitor session of its Desk
    that is verified as that same person, who is still on record. None for an agent's link, an
    unverified session's, a removed person and anything else. The caller checks the link is live."""
    person_id = link.customer_id.removeprefix(PERSON) if link.customer_id.startswith(PERSON) else None
    if (person_id is None or session_row is None or session_row.kind != "visitor"
            or session_row.desk_id != link.desk_id or session_row.person_id != person_id
            or not verified(session_row.kind, session_row.assurance, session_row.person_id)):
        return None
    display_name = (await ctx.db.execute(ctx.repo.scoped(select(Person.display_name).where(
        Person.desk_id == link.desk_id, Person.person_id == person_id,
        Person.removed_at.is_(None))))).scalar_one_or_none()
    return short_name(display_name) if display_name is not None else None


def short_name(display_name: str) -> str | None:
    """"Dana W." for "Dana Whitfield": the first word and the last word's initial; a one-word name
    as it is; None for a name with no words."""
    words = display_name.split()
    if not words:
        return None
    return words[0] if len(words) == 1 else f"{words[0]} {words[-1][0]}."


async def _desk_info(ctx: KernelCtx, desk_id: str) -> DeskInfo:
    """What a kernel card renders from the Desk's business: the owner's and business's names and the time zone."""
    business = (await ctx.db.scalars(ctx.repo.scoped(select(Business).join(
        Desk, Desk.business_id == Business.business_id).where(Desk.desk_id == desk_id)))).one()
    return DeskInfo(owner_display_name=business.owner_display_name, business_name=business.name,
                    timezone=business.timezone)
