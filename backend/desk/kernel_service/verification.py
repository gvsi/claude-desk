"""Verification: a demo code sent only to the contact on record (`POST /verify/start`, `/verify/check`).

A visitor types a contact into the verify card. Whatever they type, the answer is the same
message (`verify_started`), so nobody learns from it whether a contact is on record. Only when a
person on record has that contact does the kernel make a challenge: a fresh six-digit code from
the CSPRNG, kept only as `sha256(canonical_json({challenge_id, code}))`, and written as text into
one Demo inbox entry addressed to the masked contact on record. The code never reaches a ledger
summary, a log line, a `kernel_ro` view, the API's answer or Claude. A contact not on record is
kept as a lead note for the owner instead.

A challenge lives ten minutes and takes five wrong codes. One is live per person, across every
session, and one per session: a new start cancels both. A person gets at most five challenges and
ten wrong codes in any hour; past either limit, starts and checks for them are refused alike and
the owner gets one alert an hour. The visitor types the code back, and only the session that
asked may use it: a right code binds the session to that person (one person per session,
assurance `demo_code`), and the facts the session already holds become theirs too
(`labels.relabel_on_verify`). A session that already names a person without being verified as
them is refused (`already_bound`), and the challenge stays live.

Every start and check writes a `verify` ledger entry `{outcome, challenge_id?}` in the same
transaction as what it changed. A check that fails commits its attempt and entry first, then
answers one uniform 422 `invalid` whatever the reason (`VerifyFailed`). Both routes lock the
session row, then the person's row, then the challenge, in that order, so concurrent requests
can't overrun a limit or leave two live codes.
"""

import hashlib
import hmac
import json
import re
import secrets
from collections.abc import Iterable
from datetime import datetime, timedelta

import desk_kernel
from fastapi import APIRouter, Request
from sqlalchemy import select

from desk.contracts import LedgerEvent, SessionState
from desk.db.models import Business, Desk, Lead, Person, VerificationChallenge
from desk.db.models import DemoInboxEntry as DemoInboxRow
from desk.kernel_api import VerifyCheckRequest, VerifyStarted, VerifyStartRequest
from desk.kernel_service import auth, demo_inbox, labels, ledger, render
from desk.kernel_service.auth import AuthError, Named, SessionRow
from desk.kernel_service.desks import mask_contact, normalize_contact
from desk.kernel_service.repo import Ctx, KernelCtx, KernelFailure, new_id, route_template
from desk.kernel_service.sessions import session_state, verified

CODE_TTL = timedelta(minutes=10)
MAX_ATTEMPTS = 5                          # wrong codes a challenge takes; the fifth fails it
MAX_CHALLENGES_PER_HOUR = 5               # per person on record, across sessions
MAX_FAILURES_PER_HOUR = 10                # per person on record, across their challenges, in a rolling hour
LIMIT_WINDOW = timedelta(hours=1)
MAX_CONTACT = 120                         # a longer contact is never on record; a lead note keeps this much
LEAD_NAME = "Visitor"
CODE_FORMAT = re.compile(r"[0-9]{6}")

LOCKOUT_BODIES = {   # owner-only, in English, with the masked contact on record
    "rate_limited": "Someone asked for too many codes for {contact} in the last hour, so no more are sent to that "
                    "contact for up to an hour.",
    "locked": "Someone entered too many wrong codes for {contact} in the last hour, so verification for that "
              "contact is paused for up to an hour.",
}


class VerifyFailed(KernelFailure):
    """A check that verified nobody: one 422 `invalid` for every reason, after the attempt and its
    ledger entry have committed. `reason` (internal) is the outcome, never the code."""

    def __init__(self, outcome: str):
        super().__init__(422, "invalid", f"verify_failed:{outcome}")


def new_code() -> str:
    """Six digits from the CSPRNG, leading zeros kept."""
    return f"{secrets.randbelow(1_000_000):06d}"


def code_hash(challenge_id: str, code: str) -> str:
    """The stored form of a challenge's code: keyed by its challenge, so a hash says nothing about
    another challenge with the same code."""
    keyed = desk_kernel.canonical_json(json.dumps({"challenge_id": challenge_id, "code": code}))
    return hashlib.sha256(keyed.encode()).hexdigest()


def code_matches(challenge: VerificationChallenge, code: str) -> bool:
    """Whether `code` (as typed, surrounding spaces ignored) is the challenge's, compared in constant
    time; anything that isn't six ASCII digits is a wrong code."""
    code = code.strip()
    if not CODE_FORMAT.fullmatch(code):
        return False
    return hmac.compare_digest(challenge.code_hash, code_hash(challenge.challenge_id, code))


def lookup_key(contact: str) -> str:
    """The `contact_norm` a typed contact is looked up by, or "" (on record for nobody) when it is
    too long, doesn't normalize or holds what Postgres can't compare."""
    if len(contact) > MAX_CONTACT or "\0" in contact:
        return ""
    norm = normalize_contact(contact)
    try:
        norm.encode()
    except UnicodeEncodeError:
        return ""
    return norm


def as_typed(contact: str) -> str:
    """A typed contact as a lead note keeps it: trimmed to `MAX_CONTACT` characters, with what
    Postgres can't store (NUL, lone surrogates) replaced."""
    trimmed = contact.strip()[:MAX_CONTACT].replace("\0", "�")
    return trimmed.encode("utf-8", "replace").decode()


# ---- Locks, in order: the session, then people, then challenges -----------------------------------

async def locked_session(ctx: KernelCtx, session_id: str) -> SessionRow:
    """The session's row, locked `FOR UPDATE` until the transaction ends and read afresh."""
    return (await ctx.db.scalars(ctx.repo.scoped(
        select(SessionRow).where(SessionRow.session_id == session_id).with_for_update()
        .execution_options(populate_existing=True)))).one()


async def _lock_people(ctx: KernelCtx, person_ids: Iterable[str | None]) -> None:
    """Locks the people's rows, in ID order so two requests never wait on each other."""
    ids = sorted({person_id for person_id in person_ids if person_id is not None})
    if ids:
        await ctx.db.execute(ctx.repo.scoped(
            select(Person.person_id).where(Person.person_id.in_(ids)).order_by(Person.person_id).with_for_update()))


async def _still_on_record(ctx: KernelCtx, person: Person, key: str) -> Person | None:
    """The person a start found by `key`, read afresh once this transaction has locked their row:
    None if the owner changed their contact or removed them while the start waited for the lock,
    so a code goes only to the contact on record now."""
    return (await ctx.db.scalars(ctx.repo.scoped(select(Person).where(
        Person.person_id == person.person_id, Person.contact_norm == key, Person.removed_at.is_(None))
        .execution_options(populate_existing=True)))).one_or_none()


async def _live(ctx: KernelCtx, *, session_id: str | None = None, person_id: str | None = None,
                lock: bool = False) -> list[VerificationChallenge]:
    """The live challenges of a session or of a person, locked `FOR UPDATE` when `lock` is set
    (once the people they belong to are locked)."""
    stmt = select(VerificationChallenge).where(VerificationChallenge.status == "live")
    if session_id is not None:
        stmt = stmt.where(VerificationChallenge.session_id == session_id)
    if person_id is not None:
        stmt = stmt.where(VerificationChallenge.person_id == person_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return list((await ctx.db.scalars(ctx.repo.scoped(stmt.order_by(VerificationChallenge.challenge_id)))).all())


async def _cancel(ctx: KernelCtx, challenges: Iterable[VerificationChallenge], now: datetime) -> None:
    """Live challenges a new start replaces: `cancelled`, or `expired` if their time had run out."""
    for challenge in challenges:
        challenge.status = "expired" if challenge.expires_at <= now else "cancelled"
    await ctx.db.flush()                  # before a new live challenge takes their place


# ---- Limits -----------------------------------------------------------------------------------------

async def _challenges_in_hour(ctx: KernelCtx, person_id: str, now: datetime) -> int:
    rows = await ctx.db.scalars(ctx.repo.scoped(select(VerificationChallenge.challenge_id).where(
        VerificationChallenge.person_id == person_id, VerificationChallenge.created_at > now - LIMIT_WINDOW)))
    return len(rows.all())


async def _failures_in_hour(ctx: KernelCtx, person_id: str, now: datetime) -> int:
    """The person's wrong codes in the rolling hour, across their challenges. A code is wrong only
    while its challenge lives, so only challenges that expired within the hour can hold one."""
    rows = await ctx.db.scalars(ctx.repo.scoped(select(VerificationChallenge.failed_at).where(
        VerificationChallenge.person_id == person_id, VerificationChallenge.expires_at > now - LIMIT_WINDOW)))
    return sum(failed > now - LIMIT_WINDOW for failed_at in rows for failed in failed_at)


async def _over_a_limit(ctx: KernelCtx, person_id: str, now: datetime) -> str | None:
    """`rate_limited` when the person has had five challenges this hour, else `locked` after ten
    wrong codes, else None."""
    if await _challenges_in_hour(ctx, person_id, now) >= MAX_CHALLENGES_PER_HOUR:
        return "rate_limited"
    if await _failures_in_hour(ctx, person_id, now) >= MAX_FAILURES_PER_HOUR:
        return "locked"
    return None


async def _lockout_alert(ctx: KernelCtx, session: SessionRow, person: Person, outcome: str, now: datetime) -> None:
    """Tells the owner a contact's verification is paused, whatever `notification_prefs.now` says,
    at most once an hour per person. The alert names the masked contact, never a code."""
    preview = render.owner_preview("lockout")
    recent = await ctx.db.scalars(ctx.repo.scoped(select(DemoInboxRow.entry_id).where(
        DemoInboxRow.person_id == person.person_id, DemoInboxRow.kind == "alert", DemoInboxRow.preview == preview,
        DemoInboxRow.created_at > now - LIMIT_WINDOW).limit(1)))
    if recent.first() is not None:
        return
    await demo_inbox.deliver(ctx, copy_id=session.copy_id, desk_id=session.desk_id, to="owner",
                             person_id=person.person_id, kind="alert", preview=preview,
                             body=LOCKOUT_BODIES[outcome].format(contact=mask_contact(person.contact)))


# ---- Start and check --------------------------------------------------------------------------------

async def _ledger(ctx: KernelCtx, session: SessionRow, outcome: str, challenge_id: str | None = None) -> None:
    summary = {"outcome": outcome} | ({"challenge_id": challenge_id} if challenge_id is not None else {})
    await ledger.append(ctx, copy_id=session.copy_id, desk_id=session.desk_id,
                        event=LedgerEvent(kind="verify", origin="kernel", session_id=session.session_id,
                                          summary=summary))


async def _business_name(ctx: KernelCtx, desk_id: str) -> str:
    return (await ctx.db.scalars(ctx.repo.scoped(select(Business.name).join(
        Desk, Desk.business_id == Business.business_id).where(Desk.desk_id == desk_id)))).one()


async def start(ctx: KernelCtx, session_row: SessionRow, contact: str) -> VerifyStarted:
    """Starts verifying the session as whoever is on record with `contact`, in the caller's
    transaction (never committing). The answer is the same whether or not anyone is: only a
    `started` challenge's code notice differs, and it is never shown to Claude."""
    session = await locked_session(ctx, session_row.session_id)
    lang = render.language(session.last_language)
    if verified(session.kind, session.assurance, session.person_id):
        await _ledger(ctx, session, "already_verified")
        return VerifyStarted(message=render.status("verify_already", lang), inbox=[])
    message = render.status("verify_started", lang)
    now = ctx.clock.now()
    key = lookup_key(contact)
    person = None
    if key:
        person = (await ctx.db.scalars(ctx.repo.scoped(select(Person).where(
            Person.desk_id == session.desk_id, Person.contact_norm == key, Person.removed_at.is_(None))))).one_or_none()
    own = await _live(ctx, session_id=session.session_id)
    await _lock_people(ctx, [*(challenge.person_id for challenge in own), person.person_id if person else None])
    if person is not None:
        person = await _still_on_record(ctx, person, key)
    await _cancel(ctx, await _live(ctx, session_id=session.session_id, lock=True), now)
    if person is None:
        ctx.db.add(Lead(lead_id=new_id("lead"), copy_id=session.copy_id, desk_id=session.desk_id,
                        session_id=session.session_id, display_name=LEAD_NAME,
                        note=f"Asked to verify as {as_typed(contact)}", created_at=now))
        await ctx.db.flush()
        await _ledger(ctx, session, "not_on_record")
        return VerifyStarted(message=message, inbox=[])
    if (limited := await _over_a_limit(ctx, person.person_id, now)) is not None:
        await _lockout_alert(ctx, session, person, limited, now)
        await _ledger(ctx, session, limited)
        return VerifyStarted(message=message, inbox=[])
    await _cancel(ctx, await _live(ctx, person_id=person.person_id, lock=True), now)
    challenge_id, code = new_id("challenge"), new_code()
    ctx.db.add(VerificationChallenge(
        challenge_id=challenge_id, copy_id=session.copy_id, desk_id=session.desk_id, session_id=session.session_id,
        person_id=person.person_id, code_hash=code_hash(challenge_id, code), status="live", failed_at=[],
        expires_at=now + CODE_TTL, created_at=now))
    await ctx.db.flush()
    business = await _business_name(ctx, session.desk_id)
    notice = await demo_inbox.deliver(
        ctx, copy_id=session.copy_id, desk_id=session.desk_id, to=mask_contact(person.contact),
        person_id=person.person_id, kind="verification_code",
        body=render.status("inbox_code_body", lang, business=business, code=code),
        preview=render.status("inbox_code_preview", lang), challenge_id=challenge_id)
    await _ledger(ctx, session, "started", challenge_id)
    return VerifyStarted(message=message, inbox=[notice])


async def _refused(ctx: KernelCtx, session: SessionRow, outcome: str, challenge_id: str | None = None) -> VerifyFailed:
    """A check that verified nobody: its attempt and `verify` entry committed, then one 422."""
    await _ledger(ctx, session, outcome, challenge_id)
    await ctx.db.commit()
    return VerifyFailed(outcome)


async def check(ctx: KernelCtx, session_row: SessionRow, code: str) -> SessionState:
    """Checks `code` against the session's live challenge. A right one binds the session to the
    challenge's person (`demo_code`) and relabels the facts it already holds, in this transaction;
    anything else commits the attempt and raises `VerifyFailed`."""
    session = await locked_session(ctx, session_row.session_id)
    if verified(session.kind, session.assurance, session.person_id):
        await _ledger(ctx, session, "already_verified")
        return session_state(session)
    now = ctx.clock.now()
    own = await _live(ctx, session_id=session.session_id)
    await _lock_people(ctx, (challenge.person_id for challenge in own))
    live = await _live(ctx, session_id=session.session_id, lock=True)
    if not live:
        raise await _refused(ctx, session, "no_challenge")
    [challenge] = live
    if challenge.expires_at <= now:
        challenge.status = "expired"
        raise await _refused(ctx, session, "no_challenge", challenge.challenge_id)
    person = (await ctx.db.scalars(ctx.repo.scoped(select(Person).where(
        Person.person_id == challenge.person_id)))).one()
    if await _failures_in_hour(ctx, person.person_id, now) >= MAX_FAILURES_PER_HOUR:
        await _lockout_alert(ctx, session, person, "locked", now)
        raise await _refused(ctx, session, "locked", challenge.challenge_id)
    if not code_matches(challenge, code):
        challenge.failed_at = [*challenge.failed_at, now]
        if len(challenge.failed_at) >= MAX_ATTEMPTS:
            challenge.status = "failed"
        raise await _refused(ctx, session, "wrong_code", challenge.challenge_id)
    if session.person_id is not None:
        # a session names one person: one bound to someone else is refused like any failed check,
        # and the challenge stays live
        raise await _refused(ctx, session, "already_bound", challenge.challenge_id)
    challenge.status = "consumed"
    session.person_id, session.assurance, session.verified = person.person_id, "demo_code", True
    await ctx.db.flush()
    await labels.relabel_on_verify(ctx, session, person.person_id)
    await _ledger(ctx, session, "verified", challenge.challenge_id)
    return session_state(session)


router = APIRouter()


async def _route_session(ctx: KernelCtx, request: Request, session_id: str) -> SessionRow:
    """The visitor session a verify route names, once its token, state and Desk pass, locked. The
    session's state and its Desk are checked again on the held row, read afresh, so a Desk deleted
    or a session closed while the route waited for the row answers 409 `closed`, ledgered, as it
    would had it come first: a start makes no challenge and sends no code, a check verifies no one.
    A Desk's deletion closes its visitor sessions too, so `require_open` refuses first; the Desk's
    own recheck is defence in depth behind it."""
    row = await auth.require_session(ctx, request, session_id)
    await auth.require_desk(ctx, request, row, row.desk_id)
    locked = await locked_session(ctx, row.session_id)
    auth.require_open(ctx, request, locked)
    await auth.require_desk(ctx, request, locked, locked.desk_id)
    return locked


@router.post("/verify/start", response_model=VerifyStarted)
async def post_verify_start(body: VerifyStartRequest, ctx: Ctx, request: Request) -> VerifyStarted:
    """A session in the owner's hands may still verify; a paused one may not start (409 `mode_paused`)."""
    row = await _route_session(ctx, request, body.session_id)
    if row.mode == "paused":
        raise AuthError(409, "mode_paused", "mode_paused", route=route_template(request),
                        named=Named(copy_id=row.copy_id, desk_id=row.desk_id, session_id=row.session_id))
    return await start(ctx, row, body.contact)


@router.post("/verify/check", response_model=SessionState)
async def post_verify_check(body: VerifyCheckRequest, ctx: Ctx, request: Request) -> SessionState:
    """200 with the session's state, or 422 `invalid`, the same for every code that doesn't verify."""
    return await check(ctx, await _route_session(ctx, request, body.session_id), body.code)
