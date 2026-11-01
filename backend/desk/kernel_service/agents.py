"""Signed visiting agents: their keys, signatures, nonces and mandates, and the demo agents.

**Keys and signatures** ("Rust module surface"). Agent, mandate and demo-wallet signatures are
Ed25519 over the UTF-8 of `canonical_json(json.dumps(obj))` (RFC 8785), in lowercase hex, made
with Python `cryptography`; the kernel's own `Signer` signs none of them. An `agent_key_id` is the
first 16 hex of the sha256 of the 32-byte public key. The kernel stores only an agent key's public
half (`kernel.agent_keys`, which has no column for the private one): the private half goes once to
the agent's runner, in `DemoAgentIssued`. Each copy has one demo wallet, the only trusted mandate
issuer there; the kernel holds its key, which signs nothing but that copy's demo mandates. Neither
key is a business credential.

**Agent calls** ("Agent sessions"). Every kernel call for an agent session carries
`X-Agent-Key-Id`, `X-Agent-Ts`, `X-Agent-Nonce`, `X-Agent-Sig` and `X-Agent-Body-Sha256` (the
sha256 of the raw A2A body the signature covers), never a session token. `verify_agent_auth`
checks, in order: the headers' form; the key, in the copy of the Desk the call is for; the
signature over `{desk_slug, ts, nonce, body_sha256}` with that Desk's slug; `ts` within
`AGENT_TS_SKEW_S` of the kernel's clock; the key the session was opened with (or, opening one, the
Desk the key was minted for); then the nonce, which lasts one A2A turn (Plan 01c, Task 6):

- unseen: the first signed call by any route binds it to its session and body hash (`POST
  /sessions` creates the session and binds the nonce in one transaction);
- bound, with the same session and body hash: accepted, until the turn ends; a resent `POST
  /sessions` with the same body hash returns the session the nonce opened, creating nothing;
- bound or spent, with another session or body hash: 401;
- the turn ends (spent) at a verdict with `ok`, an immediate-handoff violation (`canary`,
  `unsupported_language`, `session_paused`: those outside `desk.rewrites.REWRITABLE`), a blocked
  `/check_reply` the API sent with `final: true`, or the turn's second `/check_reply` (`end_turn`),
  or `NONCE_TTL_S` after its first use;
- spent: the same call again is 409 `replayed`, but a resent `POST /sessions` still returns the
  bound session (ledgered `agent_auth {resent_opening: true}`).

Every refusal is an `AgentAuthError`: 401 `auth`, or 409 `replayed`, ledgered as `agent_auth
{route, reason, agent_key_id}` on the Desk the request named, never a signature, nonce or key.

**Mandates.** An agent's `POST /sessions` may present a mandate. `verify_mandate` takes it only
when this copy's demo wallet signed exactly what it says, for this agent key and this Desk, and it
hasn't expired; storing it refuses a mandate whose nonce opened a session before, so a mandate
opens one session. What it may still spend, and the reservations its money actions hold, are
`mandates`'.

**Lock order.** An agent call locks its nonce row first (`FOR UPDATE`, in auth), before its
session row and everything after it in the kernel's order (session, decision, execution, active
policy version, payment link, mandate, ledger head). Minting locks the copy's wallet row after the minting
session's row and before the ledger head.

**Demo agents** (`POST /agents/demo`): the owner of the copy or a session on the Desk mints one,
at most `DEMO_AGENTS_PER_COPY_PER_HOUR` per copy (then 429 `rate_limited`, ledgered
`rate_limit`): a fresh key, `source="demo"`, and a mandate from the copy's demo wallet ($20 a
charge, $100 in all, for an hour; the "Agent demo" row of the Turner seed).
"""

import hashlib
import hmac
import json
import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import get_args
from functools import partial

import desk_kernel
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from fastapi import APIRouter, Request
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from desk.contracts import (AUTO_MONEY_HARD_CAP_CENTS, AgentAuth, DemoAgentIssued, LedgerEvent, Mandate, ReplyVerdict,
                            Violation)
from desk.db.models import AgentKey, AgentNonce, DemoWalletKey, Desk
from desk.db.models import Mandate as MandateRow
from desk.kernel_api import DemoAgentRequest
from desk.kernel_service import auth, ledger
from desk.kernel_service.auth import AuthError, Named, SessionRow
from desk.kernel_service.clock import signed_time
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure, new_id, route_template
from desk.rewrites import REWRITABLE

AGENT_TS_SKEW_S = 300                    # a signature's timestamp is good this long either side of the kernel's clock
NONCE_TTL_S = 300                        # a turn ends this long after its nonce's first use
DEMO_AGENTS_PER_COPY_PER_HOUR = 10
DEMO_WALLET = "demo-wallet"              # the issuer a demo mandate names
DEMO_ON_BEHALF_OF = "Demo visitor"
DEMO_PER_CHARGE_CENTS = 2_000            # the "Agent demo" row: $20 a charge, $100 in all, for an hour
DEMO_TOTAL_CENTS = 10_000
DEMO_MANDATE_TTL = timedelta(hours=1)
# the violations that hand off at once: every kind but those a rewrite can fix (desk.rewrites)
IMMEDIATE_HANDOFFS = frozenset(get_args(Violation.model_fields["kind"].annotation)) - REWRITABLE
TURN_CHECKS = 2                          # a turn's second reply check ends it

KEY_ID = re.compile(r"[0-9a-f]{16}")
NONCE = re.compile(r"[A-Za-z0-9_-]{16,128}")
SIGNATURE = re.compile(r"[0-9a-f]{128}")
SHA256 = re.compile(r"[0-9a-f]{64}")

REASONS = frozenset({
    "unsigned", "malformed", "unknown_key", "bad_signature", "stale_timestamp", "wrong_key", "wrong_desk",
    "nonce_reused", "replayed", "mandate_issuer", "mandate_signature", "mandate_key",
    "mandate_audience", "mandate_expired", "mandate_limits", "mandate_reused",
})


class AgentAuthError(AuthError):
    """A refused agent signature, key, nonce or mandate: 401 `auth` (409 `replayed` for a spent
    turn's own call), ledgered `agent_auth {route, reason, agent_key_id}` on `named`'s Desk."""

    kind = "agent_auth"
    reasons = REASONS

    def __init__(self, reason: str, *, route: str, named: Named | None, agent_key_id: str | None = None,
                 status: int = 401, code: str = "auth"):
        extra = {"agent_key_id": ledger.safe_ref(agent_key_id)} if agent_key_id is not None else None
        super().__init__(status, code, reason, route=route, named=named, extra=extra)


# ---- Keys and signatures --------------------------------------------------------------------------

def canonical_bytes(obj: dict) -> bytes:
    return desk_kernel.canonical_json(json.dumps(obj)).encode()


def key_id_of(public_key_hex: str) -> str:
    return hashlib.sha256(bytes.fromhex(public_key_hex)).hexdigest()[:16]


def new_keypair() -> tuple[str, str]:
    """A fresh Ed25519 key: (private, public), each 32 bytes in lowercase hex."""
    private = Ed25519PrivateKey.generate()
    return private.private_bytes_raw().hex(), private.public_key().public_bytes_raw().hex()


def sign_canonical(private_key_hex: str, obj: dict) -> str:
    return Ed25519PrivateKey.from_private_bytes(bytes.fromhex(private_key_hex)).sign(canonical_bytes(obj)).hex()


def verify_canonical(public_key_hex: str, obj: dict, sig_hex: str) -> bool:
    """Whether `sig_hex` is the key's signature over `obj`; a malformed key or signature is not."""
    try:
        key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key_hex))
        key.verify(bytes.fromhex(sig_hex), canonical_bytes(obj))
    except (InvalidSignature, ValueError, TypeError):
        return False
    return True


def parse_signed_time(text: str) -> datetime | None:
    """The moment a `SignedTime` names; None for text of its form that names no moment ("month 13")."""
    try:
        return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC)
    except ValueError:
        return None


# ---- Agent calls ----------------------------------------------------------------------------------

@dataclass(frozen=True)
class SignedCall:
    """The signature headers of one agent call, well formed."""

    auth: AgentAuth
    body_sha256: str


@dataclass(frozen=True)
class Turn:
    """The nonce a verified call belongs to, for `end_turn` (kept on `request.state.agent_turn`)."""

    copy_id: str
    agent_key_id: str
    nonce: str


def signed_call(request: Request, *, route: str, named: Named | None) -> SignedCall:
    """The call's signature headers, or `AgentAuthError` (`unsigned` without them, `malformed`
    when any is missing or out of form)."""
    headers = request.headers
    key_id = headers.get(auth.AGENT_KEY_HEADER)
    if not auth.agent_signed(request):
        raise AgentAuthError("unsigned", route=route, named=named)
    try:
        call = AgentAuth(agent_key_id=headers[auth.AGENT_KEY_HEADER], ts=headers[auth.AGENT_TS_HEADER],
                         nonce=headers[auth.AGENT_NONCE_HEADER], sig=headers[auth.AGENT_SIG_HEADER])
        body_sha256 = headers[auth.AGENT_BODY_HEADER]
    except (KeyError, ValidationError):
        raise AgentAuthError("malformed", route=route, named=named, agent_key_id=key_id) from None
    if not (KEY_ID.fullmatch(call.agent_key_id) and NONCE.fullmatch(call.nonce) and SIGNATURE.fullmatch(call.sig)
            and SHA256.fullmatch(body_sha256) and parse_signed_time(call.ts) is not None):
        raise AgentAuthError("malformed", route=route, named=named, agent_key_id=key_id)
    return SignedCall(auth=call, body_sha256=body_sha256)


async def verify_agent_auth(ctx: KernelCtx, desk_slug: str, call: SignedCall, session_id: str, *, route: str,
                            named: Named, session_key_id: str | None = None, desk_id: str | None = None) -> str:
    """Checks one agent call in the copy bound to `ctx` and binds or checks its nonce. A call for
    an existing session names it (`session_id`) and the key it was opened with (`session_key_id`);
    an opening request names the Desk it opens on (`desk_id`) and the ID its new session would
    get. Returns the session the nonce is bound to: `session_id`, unless an opening request is
    resent, when it is the session the nonce opened. Raises `AgentAuthError`."""
    auth_ = call.auth
    refuse = partial(AgentAuthError, route=route, named=named, agent_key_id=auth_.agent_key_id)
    key = (await ctx.db.scalars(ctx.repo.scoped(
        select(AgentKey).where(AgentKey.agent_key_id == auth_.agent_key_id)))).one_or_none()
    if key is None:
        raise refuse("unknown_key")
    signed = {"desk_slug": desk_slug, "ts": auth_.ts, "nonce": auth_.nonce, "body_sha256": call.body_sha256}
    if not verify_canonical(key.public_key_hex, signed, auth_.sig):
        raise refuse("bad_signature")
    now = ctx.clock.now()
    signed_at = parse_signed_time(auth_.ts)
    if signed_at is None or abs((now - signed_at).total_seconds()) > AGENT_TS_SKEW_S:
        raise refuse("stale_timestamp")
    opening = session_key_id is None
    if opening and key.desk_id != desk_id:
        raise refuse("wrong_desk")
    if not opening and not hmac.compare_digest(session_key_id, auth_.agent_key_id):
        raise refuse("wrong_key")                      # a valid signature naming another agent's session

    fresh = (await ctx.db.execute(pg_insert(AgentNonce).values(
        copy_id=ctx.copy_id, agent_key_id=auth_.agent_key_id, nonce=auth_.nonce, session_id=session_id,
        body_sha256=call.body_sha256, first_used_at=now, check_replies=0,
    ).on_conflict_do_nothing().returning(AgentNonce.nonce))).first()
    if fresh is not None:
        return session_id
    nonce = await _nonce_row(ctx, auth_.agent_key_id, auth_.nonce)
    if not hmac.compare_digest(nonce.body_sha256, call.body_sha256):
        raise refuse("nonce_reused")
    if opening:
        return nonce.session_id                        # a resent opening request, bound or spent
    if nonce.session_id != session_id:
        raise refuse("nonce_reused")
    if turn_ended(nonce, now):
        raise refuse("replayed", status=409, code="replayed")
    return session_id


def turn_ended(nonce: AgentNonce, now: datetime) -> bool:
    return nonce.spent_at is not None or now - nonce.first_used_at >= timedelta(seconds=NONCE_TTL_S)


async def _nonce_row(ctx: KernelCtx, agent_key_id: str, nonce: str) -> AgentNonce:
    return (await ctx.db.scalars(ctx.repo.scoped(select(AgentNonce).where(
        AgentNonce.agent_key_id == agent_key_id, AgentNonce.nonce == nonce).with_for_update()))).one()


async def authenticate(ctx: KernelCtx, request: Request, row: SessionRow, *, route: str, named: Named) -> None:
    """The signature check of a call for the agent session `row` (`auth.authenticate_session`, which
    `/decide`, `GET /decisions/{id}` and `auth.require_session` reach): signed by the key the
    session was opened with, over its Desk's slug, in a turn that hasn't ended. Remembers the turn
    on the request for `end_turn`."""
    call = signed_call(request, route=route, named=named)
    slug = (await ctx.db.scalars(ctx.repo.scoped(select(Desk.slug).where(Desk.desk_id == row.desk_id)))).one()
    await verify_agent_auth(ctx, slug, call, row.session_id, route=route, named=named,
                            session_key_id=row.agent_key_id or "")
    request.state.agent_turn = Turn(copy_id=row.copy_id, agent_key_id=call.auth.agent_key_id, nonce=call.auth.nonce)


async def end_turn(ctx: KernelCtx, request: Request, verdict: ReplyVerdict, *, final: bool = False) -> None:
    """After an agent session's reply check: counts the check against its turn's nonce and ends
    the turn at a verdict the API shows: a passing one, an immediate handoff (a violation no
    rewrite can fix, outside `desk.rewrites.REWRITABLE`), a blocked check the API sent as final
    (`final`: `CheckReplyRequest.final` sent true, so its handoff is shown and nothing rewrites
    it), or the turn's second check. A check sent without `final` ends it only as before, so the
    API's rewrite on the same nonce still runs until it says which attempt is its last."""
    turn: Turn | None = getattr(request.state, "agent_turn", None)
    if turn is None:
        return
    nonce = await _nonce_row(ctx, turn.agent_key_id, turn.nonce)
    nonce.check_replies += 1
    immediate = any(violation.kind in IMMEDIATE_HANDOFFS for violation in verdict.violations)
    if (verdict.ok or immediate or final or nonce.check_replies >= TURN_CHECKS) and nonce.spent_at is None:
        nonce.spent_at = ctx.clock.now()
    await ctx.db.flush()


async def open_session(ctx: KernelCtx, request: Request, desk: Desk, mandate: Mandate | None) -> SessionRow:
    """An agent's `POST /sessions` on `desk` (its copy bound to `ctx`): the signature, the nonce
    and the mandate, then a new agent session bound to the signing key, its mandate stored, in the
    caller's transaction. A resent opening request returns the session its nonce opened, creating
    nothing and storing no mandate."""
    route = route_template(request)
    named = Named(copy_id=desk.copy_id, desk_id=desk.desk_id)
    if auth.SESSION_HEADER in request.headers or auth.OWNER_HEADER in request.headers:
        raise AuthError(401, "auth", "bad_token", route=route, named=named)   # a call carries one credential
    call = signed_call(request, route=route, named=named)
    key_id = call.auth.agent_key_id
    session_id = auth.new_session_id()
    bound = await verify_agent_auth(ctx, desk.slug, call, session_id, route=route, named=named, desk_id=desk.desk_id)
    if desk.deleted_at is not None:
        raise AuthError(409, "closed", "closed", route=route, named=named)
    if bound != session_id:
        row = (await ctx.db.scalars(ctx.repo.scoped(
            select(SessionRow).where(SessionRow.session_id == bound)))).one_or_none()
        if row is None or row.kind != "agent" or row.desk_id != desk.desk_id or row.agent_key_id != key_id:
            raise AgentAuthError("nonce_reused", route=route, named=named, agent_key_id=key_id)
        await ledger.append(ctx, copy_id=desk.copy_id, desk_id=desk.desk_id, event=LedgerEvent(
            kind="agent_auth", origin="kernel", session_id=row.session_id,
            summary={"agent_key_id": key_id, "resent_opening": True}))
        return row
    mandate_id = None
    if mandate is not None:
        await verify_mandate(ctx, desk.desk_id, key_id, mandate, route=route, named=named)
        mandate_id = await _store_mandate(ctx, desk, session_id, mandate, route=route, named=named)
    now = ctx.clock.now()
    row = SessionRow(session_id=session_id, copy_id=desk.copy_id, desk_id=desk.desk_id, kind="agent",
                     secret_hash=None, verified=False, assurance="none", agent_key_id=key_id, mandate_id=mandate_id,
                     mode="ai", generation=0, strikes=0, preview=False, created_at=now, last_seen_at=now)
    ctx.db.add(row)
    await ctx.db.flush()
    await ledger.append(ctx, copy_id=desk.copy_id, desk_id=desk.desk_id, event=LedgerEvent(
        kind="session", origin="kernel", session_id=session_id,
        summary={"session_id": session_id, "kind": "agent", "agent_key_id": key_id, "mandate_id": mandate_id}))
    return row


def mandate_fields(mandate: Mandate) -> dict:
    """What the issuer signs: every field of the mandate but its signature."""
    return mandate.model_dump(mode="json", exclude={"sig"})


async def verify_mandate(ctx: KernelCtx, desk_id: str, agent_key_id: str, mandate: Mandate, *, route: str,
                         named: Named) -> None:
    """Refuses (`AgentAuthError`) a mandate this copy's demo wallet didn't sign as it stands, or one
    for another agent key or Desk, expired, or outside its own limits. A reused nonce is refused
    when it is stored."""
    refuse = partial(AgentAuthError, route=route, named=named, agent_key_id=agent_key_id)
    wallet = (await ctx.db.scalars(ctx.repo.scoped(select(DemoWalletKey)))).one_or_none()
    if mandate.issuer != DEMO_WALLET or wallet is None:
        raise refuse("mandate_issuer")
    if not verify_canonical(wallet.public_key_hex, mandate_fields(mandate), mandate.sig):
        raise refuse("mandate_signature")
    if not hmac.compare_digest(mandate.agent_key_id, agent_key_id):
        raise refuse("mandate_key")
    if mandate.desk_id != desk_id:
        raise refuse("mandate_audience")
    expires_at = parse_signed_time(mandate.expires_at)
    if expires_at is None or expires_at <= ctx.clock.now():      # a time that names no moment never comes
        raise refuse("mandate_expired")
    if not 1 <= mandate.per_charge_cents <= min(mandate.total_cents, AUTO_MONEY_HARD_CAP_CENTS):
        raise refuse("mandate_limits")


async def _store_mandate(ctx: KernelCtx, desk: Desk, session_id: str, mandate: Mandate, *, route: str,
                         named: Named) -> str:
    stored = (await ctx.db.execute(pg_insert(MandateRow).values(
        mandate_id=mandate.mandate_id, copy_id=desk.copy_id, desk_id=desk.desk_id, session_id=session_id,
        issuer=mandate.issuer, agent_key_id=mandate.agent_key_id, on_behalf_of=mandate.on_behalf_of,
        per_charge_cents=mandate.per_charge_cents, total_cents=mandate.total_cents, committed_cents=0,
        reserved_cents=0, expires_at=mandate.expires_at, nonce=mandate.nonce, envelope=mandate,
    ).on_conflict_do_nothing().returning(MandateRow.mandate_id))).first()
    if stored is None:                                  # its nonce (or ID) opened a session before
        raise AgentAuthError("mandate_reused", route=route, named=named, agent_key_id=mandate.agent_key_id)
    return mandate.mandate_id


# ---- Demo agents ----------------------------------------------------------------------------------

async def _wallet(ctx: KernelCtx) -> DemoWalletKey:
    """The copy's demo wallet, made on first use, locked for the rest of the transaction (the
    copy's mint lock)."""
    stmt = ctx.repo.scoped(select(DemoWalletKey).with_for_update())
    wallet = (await ctx.db.scalars(stmt)).one_or_none()
    if wallet is None:
        private_hex, public_hex = new_keypair()
        await ctx.db.execute(pg_insert(DemoWalletKey).values(
            copy_id=ctx.copy_id, key_id=key_id_of(public_hex), public_key_hex=public_hex, private_key_hex=private_hex,
        ).on_conflict_do_nothing())
        wallet = (await ctx.db.scalars(stmt)).one()
    return wallet


async def _ledger_rate_limit(ctx: KernelCtx, *, copy_id: str, desk_id: str, session_id: str | None,
                             route: str) -> None:
    ctx.bind(copy_id)
    await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id, event=LedgerEvent(
        kind="rate_limit", origin="kernel", session_id=session_id,
        summary={"route": route, "limit": "demo_agents_per_copy_per_hour", "max": DEMO_AGENTS_PER_COPY_PER_HOUR}))


async def issue_demo_agent(ctx: KernelCtx, desk_id: str, minted_by: str, *, route: str) -> DemoAgentIssued:
    """A new demo agent for the Desk, minted by the owner (`minted_by="owner"`) or the session
    whose ID it is, in the caller's transaction: its key (only the public half kept) and a mandate
    from the copy's demo wallet. Over the hourly limit: 429 `rate_limited`, ledgered."""
    wallet = await _wallet(ctx)
    now = ctx.clock.now()
    session_id = None if minted_by == "owner" else minted_by
    minted = (await ctx.db.scalars(ctx.repo.scoped(select(func.count(AgentKey.agent_key_id)).where(
        AgentKey.source == "demo", AgentKey.created_at > now - timedelta(hours=1))))).one()
    if minted >= DEMO_AGENTS_PER_COPY_PER_HOUR:
        raise KernelFailure(429, "rate_limited", "demo_agents", persist=partial(
            _ledger_rate_limit, copy_id=ctx.copy_id, desk_id=desk_id, session_id=session_id, route=route))
    private_hex, public_hex = new_keypair()
    key_id = key_id_of(public_hex)
    ctx.db.add(AgentKey(copy_id=ctx.copy_id, agent_key_id=key_id, desk_id=desk_id, public_key_hex=public_hex,
                        source="demo", minted_by=minted_by, created_at=now))
    unsigned = Mandate(mandate_id=new_id("mandate"), issuer=DEMO_WALLET, agent_key_id=key_id, desk_id=desk_id,
                       on_behalf_of=DEMO_ON_BEHALF_OF, allowed_effects=["charge"],
                       per_charge_cents=DEMO_PER_CHARGE_CENTS, total_cents=DEMO_TOTAL_CENTS, currency="usd",
                       expires_at=signed_time(now + DEMO_MANDATE_TTL), nonce=secrets.token_urlsafe(16), sig="")
    # the wallet signs exactly what `verify_mandate` checks: every field but the signature
    mandate = unsigned.model_copy(update={"sig": sign_canonical(wallet.private_key_hex, mandate_fields(unsigned))})
    await ctx.db.flush()
    await ledger.append(ctx, copy_id=ctx.copy_id, desk_id=desk_id, event=LedgerEvent(
        kind="agent_auth", origin="kernel", session_id=session_id,
        summary={"agent_key_id": key_id, "mandate_id": mandate.mandate_id,
                 "minted_by": "owner" if session_id is None else "session"}))
    return DemoAgentIssued(agent_key_id=key_id, agent_private_key_hex=private_hex, mandate=mandate)


async def minted_sessions(ctx: KernelCtx, session_id: str) -> list[str]:
    """The agent sessions opened with keys the session `session_id` minted, oldest first: whose
    verification codes `GET /demo_inbox?session_id=` shows that session (Plan 01b's handler)."""
    keys = (await ctx.db.scalars(ctx.repo.scoped(select(AgentKey.agent_key_id).where(
        AgentKey.minted_by == session_id)))).all()
    if not keys:
        return []
    return list((await ctx.db.scalars(ctx.repo.scoped(select(SessionRow.session_id).where(
        SessionRow.kind == "agent", SessionRow.agent_key_id.in_(keys)).order_by(
        SessionRow.created_at, SessionRow.session_id)))).all())


router = APIRouter()


@router.post("/agents/demo", response_model=DemoAgentIssued)
async def post_demo_agent(body: DemoAgentRequest, ctx: Ctx, request: Request) -> DemoAgentIssued:
    """Mints a demo agent: by the owner of the Desk's copy, or by a visitor session on that Desk
    (with its own token). Another Desk is 404 and a deleted one 409 `closed`, ledgered."""
    route = route_template(request)
    owner, session = auth.OWNER_HEADER in request.headers, auth.SESSION_HEADER in request.headers
    if auth.agent_signed(request) or owner == session:
        raise AuthError(401, "auth", "bad_token", route=route)
    if owner:
        owner_ctx = await auth.require_owner(ctx, request, desk_id=body.desk_id)
        desk = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == body.desk_id)))).one()
        if desk.deleted_at is not None:
            raise AuthError(409, "closed", "closed", route=route, named=Named(copy_id=owner_ctx.copy_id,
                                                                             desk_id=desk.desk_id))
        minted_by = "owner"
    else:
        row = await auth.require_session_token(ctx, request)
        if row.desk_id != body.desk_id:
            raise AuthError(404, "not_found", "wrong_copy", route=route,
                            named=Named(copy_id=row.copy_id, desk_id=row.desk_id, session_id=row.session_id))
        await auth.require_desk(ctx, request, row, row.desk_id)
        minted_by = row.session_id
    return await issue_demo_agent(ctx, body.desk_id, minted_by, route=route)
