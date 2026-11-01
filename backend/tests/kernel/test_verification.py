"""Verification: a random code sent only to the contact on record, and the Demo inbox reads.

A visitor types a contact into the verify card (`POST /verify/start`); the kernel answers the same
message whether or not the contact is on record, and only a contact on record gets a Demo inbox
entry holding a fresh six-digit code. The visitor types the code back (`POST /verify/check`), and
the session is verified as that person. Time moves on the frozen clock.
"""

import asyncio
import hashlib
import json
import logging
import re
from dataclasses import dataclass
from datetime import timedelta

import desk_kernel
import httpx
import psycopg
import pytest
from fastapi import FastAPI
from sqlalchemy import insert, select

from desk.contracts import DemoInboxEntry, Fact, InboxNotice, Label, SessionState
from desk.db.models import ActorSession, Desk, LedgerEntry, NotificationPref, Person, VerificationChallenge
from desk.db.models import DemoInboxEntry as DemoInboxRow
from desk.db.models import Fact as FactRow
from desk.db.session import COPY_SETTING, database_url, kernel_engine, libpq_url
from desk.db.tables import KERNEL_RO_VIEWS
from desk.kernel_api import VerifyStarted
from desk.kernel_service import auth, demo_inbox, ledger, verification
from desk.kernel_service.desks import mask_contact, normalize_contact

from .helpers import kernel_ctx, rows_of
from .test_adapters import Rivera, quote_args, rivera
from .test_decide import Visitor, decided, open_visitor, set_session
from .test_execute import executed

DANA_PHONE = "+15105550177"               # Dana's contact on record in these tests
STARTED_EN = "If that contact is on record, a code is on its way. Enter it below to confirm it's you."
STARTED_ES = ("Si ese contacto está registrado, te enviamos un código. Escríbelo abajo para confirmar que "
              "eres tú.")
CODE = re.compile(r"\b(\d{6})\b")


@dataclass(frozen=True)
class Copy:
    rivera: Rivera
    people: dict[str, str]                # ref -> person_id

    @property
    def copy_id(self) -> str:
        return self.rivera.copy_id

    @property
    def owner(self) -> dict[str, str]:
        return self.rivera.owner

    @property
    def slug(self) -> str:
        return self.rivera.slug


async def rivera_copy(app: FastAPI, client: httpx.AsyncClient) -> Copy:
    """A Turner Plumbing copy in which Dana's contact on record is a phone number."""
    copy = await rivera(app, client)
    async with kernel_ctx(app) as ctx:
        repo = ctx.bind(copy.copy_id)
        people = (await ctx.db.scalars(repo.scoped(select(Person)))).all()
        dana = next(person for person in people if person.ref == "dana")
        dana.contact, dana.contact_norm, dana.masked_contact = (DANA_PHONE, normalize_contact(DANA_PHONE),
                                                                mask_contact(DANA_PHONE))
        return Copy(rivera=copy, people={person.ref: person.person_id for person in people})


async def start(client: httpx.AsyncClient, visitor: Visitor, contact: str) -> httpx.Response:
    return await client.post("/verify/start", headers=visitor.headers,
                             json={"session_id": visitor.session_id, "contact": contact})


async def started(client: httpx.AsyncClient, visitor: Visitor, contact: str) -> VerifyStarted:
    response = await start(client, visitor, contact)
    assert response.status_code == 200, response.text
    return VerifyStarted.model_validate(response.json())


async def check(client: httpx.AsyncClient, visitor: Visitor, code: str) -> httpx.Response:
    return await client.post("/verify/check", headers=visitor.headers,
                             json={"session_id": visitor.session_id, "code": code})


async def session_inbox(client: httpx.AsyncClient, visitor: Visitor) -> list[DemoInboxEntry]:
    response = await client.get("/demo_inbox", params={"session_id": visitor.session_id}, headers=visitor.headers)
    assert response.status_code == 200, response.text
    return [DemoInboxEntry.model_validate(entry) for entry in response.json()]


async def entry_of(client: httpx.AsyncClient, visitor: Visitor, notice: InboxNotice) -> DemoInboxEntry:
    """The entry a notice announced, as the session reads it."""
    [entry] = [entry for entry in await session_inbox(client, visitor) if entry.entry_id == notice.entry_id]
    return entry


def code_in(entry: DemoInboxEntry) -> str:
    [code] = CODE.findall(entry.body)
    return code


async def challenges(app: FastAPI, copy: Copy) -> list[VerificationChallenge]:
    return await rows_of(app, copy.copy_id, select(VerificationChallenge).order_by(VerificationChallenge.created_at,
                                                                                  VerificationChallenge.challenge_id))


async def test_code_goes_only_to_the_contact_on_record(app, client):
    copy = await rivera_copy(app, client)
    visitor = await open_visitor(client, copy)
    answer = await started(client, visitor, "(510) 555 0177")
    assert answer.message == STARTED_EN
    [notice] = answer.inbox
    assert (notice.to, notice.preview) == (mask_contact(DANA_PHONE), "New verification code")
    [entry] = await session_inbox(client, visitor)
    assert (entry.entry_id, entry.to, entry.kind) == (notice.entry_id, mask_contact(DANA_PHONE), "verification_code")
    code = code_in(entry)
    assert entry.body == (f"Your Turner Plumbing code is {code}. It expires in ten minutes. "
                          "If you didn't ask for it, ignore this message.")
    [row] = await rows_of(app, copy.copy_id, select(DemoInboxRow).where(DemoInboxRow.entry_id == entry.entry_id))
    assert row.person_id == copy.people["dana"]
    [challenge] = await challenges(app, copy)
    assert (challenge.person_id, challenge.session_id, challenge.status) == (copy.people["dana"], visitor.session_id,
                                                                            "live")
    assert challenge.code_hash not in (code, hashlib.sha256(code.encode()).hexdigest())
    keyed = desk_kernel.canonical_json(json.dumps({"challenge_id": challenge.challenge_id, "code": code}))
    assert challenge.code_hash == hashlib.sha256(keyed.encode()).hexdigest()
    # a Spanish-speaking session reads the message and its code in Spanish
    spanish = await open_visitor(client, copy)
    await set_session(app, copy, spanish.session_id, last_language="es")
    answer = await started(client, spanish, DANA_PHONE)
    assert answer.message == STARTED_ES
    [notice] = answer.inbox
    assert notice.preview == "Nuevo código de verificación"
    code = code_in(entry := await entry_of(client, spanish, notice))
    assert entry.body == (f"Tu código de Turner Plumbing es {code}. Vence en diez minutos. "
                          "Si no lo pediste, ignora este mensaje.")


def api_rows(copy_id: str, sql: str) -> list[tuple]:
    """What the API process reads from a kernel_ro view for a copy (as desk_api)."""
    with psycopg.connect(libpq_url(database_url("API"))) as api:
        api.execute("SELECT set_config(%s, %s, true)", (COPY_SETTING, copy_id))
        return api.execute(sql).fetchall()


async def verify_entries(app: FastAPI, copy: Copy) -> list[dict]:
    """The `verify` ledger entries' summaries, in order."""
    rows = await rows_of(app, copy.copy_id, select(LedgerEntry).where(LedgerEntry.desk_id == copy.rivera.desk_id)
                         .order_by(LedgerEntry.seq))
    return [row.event.summary for row in rows if row.event.kind == "verify"]


async def test_unknown_contact_gets_the_same_reply(app, client):
    copy = await rivera_copy(app, client)
    visitor = await open_visitor(client, copy)
    padded = "+1" + " " * 110 + "5105550177"               # Dana's number, but longer than any contact on record
    for typed in ("stranger@example.com", "owner", padded):
        answer = await started(client, visitor, f"  {typed} ")
        assert answer == VerifyStarted(message=STARTED_EN, inbox=[])
    assert await session_inbox(client, visitor) == []
    assert await rows_of(app, copy.copy_id, select(DemoInboxRow).where(
        DemoInboxRow.kind == "verification_code")) == []
    assert await challenges(app, copy) == []
    notes = api_rows(copy.copy_id, "SELECT session_id, display_name, note FROM kernel_ro.leads ORDER BY note")
    assert notes == sorted([(visitor.session_id, "Visitor", f"Asked to verify as {typed}")
                            for typed in ("stranger@example.com", "owner", padded[:120])], key=lambda row: row[2])
    assert await verify_entries(app, copy) == [{"outcome": "not_on_record"}] * 3


def codes(monkeypatch, *values: int) -> None:
    """The CSPRNG draws these codes, in order."""
    draws = iter(values)
    monkeypatch.setattr(verification.secrets, "randbelow", lambda bound: next(draws))


INVALID = (422, {"code": "invalid"})


async def test_each_challenge_gets_a_fresh_code(app, client, monkeypatch):
    codes(monkeypatch, 111111, 222222)
    copy = await rivera_copy(app, client)
    visitor = await open_visitor(client, copy)
    for _ in range(2):
        await started(client, visitor, DANA_PHONE)
    assert sorted(code_in(entry) for entry in await session_inbox(client, visitor)) == ["111111", "222222"]
    response = await check(client, visitor, "111111")                 # the first code went with its challenge
    assert (response.status_code, response.json()) == INVALID
    response = await check(client, visitor, "222222")
    assert response.status_code == 200, response.text
    assert SessionState.model_validate(response.json()) == SessionState(
        session_id=visitor.session_id, kind="visitor", verified=True, assurance="demo_code", mode="ai", generation=0)
    assert [challenge.status for challenge in await challenges(app, copy)] in (["cancelled", "consumed"],
                                                                              ["consumed", "cancelled"])


async def test_new_challenge_cancels_the_old_one_across_sessions(app, client, monkeypatch):
    codes(monkeypatch, 111111, 222222)
    copy = await rivera_copy(app, client)
    first, second = await open_visitor(client, copy), await open_visitor(client, copy)
    await started(client, first, DANA_PHONE)
    await started(client, second, "(510) 555-0177")
    response = await check(client, first, "111111")                   # Dana's code from another session replaced it
    assert (response.status_code, response.json()) == INVALID
    response = await check(client, first, "222222")                   # and the new code is the second session's
    assert (response.status_code, response.json()) == INVALID
    response = await check(client, second, "222222")
    assert response.status_code == 200 and response.json()["verified"] is True
    assert {(challenge.session_id, challenge.status) for challenge in await challenges(app, copy)} == {
        (first.session_id, "cancelled"), (second.session_id, "consumed")}
    assert [summary["outcome"] for summary in await verify_entries(app, copy)] == [
        "started", "started", "no_challenge", "no_challenge", "verified"]


async def session_row(app: FastAPI, copy: Copy, visitor: Visitor) -> ActorSession:
    [row] = await rows_of(app, copy.copy_id, select(ActorSession).where(ActorSession.session_id == visitor.session_id))
    return row


async def test_one_live_challenge_per_session(app, client, monkeypatch):
    codes(monkeypatch, 111111, 222222, 333333)
    copy = await rivera_copy(app, client)
    visitor = await open_visitor(client, copy)
    await started(client, visitor, DANA_PHONE)
    await started(client, visitor, "stranger@example.com")            # not on record, and still cancels Dana's
    response = await check(client, visitor, "111111")
    assert (response.status_code, response.json()) == INVALID
    await started(client, visitor, DANA_PHONE)
    await started(client, visitor, "bob@example.com")
    response = await check(client, visitor, "222222")                 # Bob's challenge replaced Dana's
    assert (response.status_code, response.json()) == INVALID
    assert [(challenge.person_id, challenge.status) for challenge in await challenges(app, copy)
            if challenge.status == "live"] == [(copy.people["bob"], "live")]
    response = await check(client, visitor, "333333")
    assert response.status_code == 200, response.text
    assert (await session_row(app, copy, visitor)).person_id == copy.people["bob"]


async def test_correct_code_verifies_once(app, client, monkeypatch):
    codes(monkeypatch, 111111)
    copy = await rivera_copy(app, client)
    visitor, other = await open_visitor(client, copy), await open_visitor(client, copy)
    await started(client, visitor, DANA_PHONE)
    response = await check(client, other, "111111")                   # a code works only in the session that asked
    assert (response.status_code, response.json()) == INVALID
    verified = SessionState(session_id=visitor.session_id, kind="visitor", verified=True, assurance="demo_code",
                            mode="ai", generation=0)
    for _ in range(2):                                                # the second check finds it verified already
        response = await check(client, visitor, "111111")
        assert response.status_code == 200, response.text
        assert SessionState.model_validate(response.json()) == verified
    [challenge] = await challenges(app, copy)
    assert challenge.status == "consumed"
    assert api_rows(copy.copy_id, "SELECT session_id, verified, assurance, person_id FROM kernel_ro.sessions"
                                  f" WHERE session_id = '{visitor.session_id}'") == [
        (visitor.session_id, True, "demo_code", copy.people["dana"])]
    response = await client.get("/whoami", headers=visitor.headers)
    assert response.json()["session"] == verified.model_dump()
    assert [summary["outcome"] for summary in await verify_entries(app, copy)] == [
        "started", "no_challenge", "verified", "already_verified"]


async def test_wrong_codes_lock_the_challenge_after_five(app, client, frozen_clock, monkeypatch):
    codes(monkeypatch, 111111)
    copy = await rivera_copy(app, client)
    visitor, stranger = await open_visitor(client, copy), await open_visitor(client, copy)
    missing = await check(client, stranger, "111111")                # the answer a session with no challenge gets
    assert (missing.status_code, missing.json()) == INVALID
    await started(client, visitor, DANA_PHONE)
    for wrong in ("000000", "11111", "111 111", "abcdef", "١١١١١١"):    # malformed codes count as wrong ones
        frozen_clock.advance(1)
        response = await check(client, visitor, wrong)
        assert (response.status_code, response.content) == (missing.status_code, missing.content)
    [challenge] = await challenges(app, copy)
    assert challenge.status == "failed"
    assert len(challenge.failed_at) == 5 and challenge.failed_at == sorted(challenge.failed_at)
    response = await check(client, visitor, "111111")                 # the right code, too late
    assert (response.status_code, response.content) == (missing.status_code, missing.content)
    assert (await session_row(app, copy, visitor)).person_id is None
    assert [summary["outcome"] for summary in await verify_entries(app, copy)] == [
        "no_challenge", "started", *["wrong_code"] * 5, "no_challenge"]


async def test_challenge_expires_after_ten_minutes(app, client, frozen_clock, monkeypatch):
    codes(monkeypatch, 111111, 222222)
    copy = await rivera_copy(app, client)
    visitor = await open_visitor(client, copy)
    await started(client, visitor, DANA_PHONE)
    frozen_clock.advance(600)                                         # ten minutes on, the code is gone
    response = await check(client, visitor, "111111")
    assert (response.status_code, response.json()) == INVALID
    [expired] = await challenges(app, copy)
    assert expired.status == "expired"
    await started(client, visitor, DANA_PHONE)
    frozen_clock.advance(599)
    response = await check(client, visitor, "222222")
    assert response.status_code == 200 and response.json()["verified"] is True
    assert await verify_entries(app, copy) == [
        {"outcome": "started", "challenge_id": expired.challenge_id},
        {"outcome": "no_challenge", "challenge_id": expired.challenge_id},
        {"outcome": "started", "challenge_id": (await challenges(app, copy))[1].challenge_id},
        {"outcome": "verified", "challenge_id": (await challenges(app, copy))[1].challenge_id}]


async def owner_inbox(client: httpx.AsyncClient, copy: Copy) -> list[DemoInboxEntry]:
    response = await client.get("/demo_inbox", headers=copy.owner)
    assert response.status_code == 200, response.text
    return [DemoInboxEntry.model_validate(entry) for entry in response.json()]


async def lockout_alerts(client: httpx.AsyncClient, copy: Copy) -> list[DemoInboxEntry]:
    return [entry for entry in await owner_inbox(client, copy)
            if entry.kind == "alert" and entry.to == "owner" and "•••• 0177" in entry.body]


async def test_sixth_challenge_in_an_hour_is_refused(app, client, frozen_clock):
    copy = await rivera_copy(app, client)
    async with kernel_ctx(app) as ctx:                                # the owner doesn't want lockouts at once,
        repo = ctx.bind(copy.copy_id)                                 # and is told anyway
        prefs = (await ctx.db.scalars(repo.scoped(select(NotificationPref)))).one()
        prefs.now = [kind for kind in prefs.now if kind != "lockout"]
    assert api_rows(copy.copy_id, "SELECT now FROM kernel_ro.notification_prefs") == [
        (["approval", "callback", "breaker", "handoff"],)]
    visitor = await open_visitor(client, copy)
    for _ in range(5):
        await started(client, visitor, DANA_PHONE)
        frozen_clock.advance(300)
    for _ in range(2):                                                # minutes 25 and 30: the sixth and seventh
        answer = await started(client, visitor, DANA_PHONE)
        assert answer == VerifyStarted(message=STARTED_EN, inbox=[])
        frozen_clock.advance(300)
    assert len(await session_inbox(client, visitor)) == 5
    assert all(challenge.status != "live" for challenge in await challenges(app, copy))
    [alert] = await lockout_alerts(client, copy)                      # one alert an hour
    assert alert.body == ("Someone asked for too many codes for •••• 0177 in the last hour, so no more are sent to "
                          "that contact for up to an hour.")
    [row] = await rows_of(app, copy.copy_id, select(DemoInboxRow).where(DemoInboxRow.entry_id == alert.entry_id))
    assert (row.person_id, row.preview) == (copy.people["dana"], "Verification paused for a contact")
    frozen_clock.advance(1500)                                        # minute 60: the first challenge is an hour old
    answer = await started(client, visitor, DANA_PHONE)
    assert len(answer.inbox) == 1
    assert [summary["outcome"] for summary in await verify_entries(app, copy)] == [
        *["started"] * 5, "rate_limited", "rate_limited", "started"]


async def wrong_codes(client: httpx.AsyncClient, visitor: Visitor, count: int) -> None:
    for _ in range(count):
        response = await check(client, visitor, "000000")
        assert (response.status_code, response.json()) == INVALID


async def test_ten_failures_lock_the_contact_for_a_rolling_hour(app, client, frozen_clock, monkeypatch):
    codes(monkeypatch, 111111, 222222, 333333, 444444)
    copy = await rivera_copy(app, client)
    first, second, third, later = [await open_visitor(client, copy) for _ in range(4)]
    began = frozen_clock.now()

    def minute(n: int) -> None:
        frozen_clock.travel(began + timedelta(minutes=n))

    await started(client, first, DANA_PHONE)                          # minute 0
    minute(9)
    await wrong_codes(client, first, 5)
    minute(10)
    await started(client, second, DANA_PHONE)
    minute(11)
    await wrong_codes(client, second, 3)
    minute(12)
    await started(client, third, DANA_PHONE)
    minute(19)
    await wrong_codes(client, third, 2)                               # ten wrong codes for Dana this hour
    response = await check(client, third, "333333")                   # the right code, refused like a wrong one
    assert (response.status_code, response.json()) == INVALID
    assert (await session_row(app, copy, third)).person_id is None
    assert await started(client, later, DANA_PHONE) == VerifyStarted(message=STARTED_EN, inbox=[])
    minute(61)                                                        # the failures of minute 9 still count
    assert await started(client, later, DANA_PHONE) == VerifyStarted(message=STARTED_EN, inbox=[])
    [alert] = await lockout_alerts(client, copy)
    assert alert.body == ("Someone entered too many wrong codes for •••• 0177 in the last hour, so verification "
                          "for that contact is paused for up to an hour.")
    minute(70)                                                        # now only five of them are within the hour
    [notice] = (await started(client, later, DANA_PHONE)).inbox
    assert code_in(await entry_of(client, later, notice)) == "444444"
    response = await check(client, later, "444444")
    assert response.status_code == 200 and response.json()["verified"] is True
    assert [summary["outcome"] for summary in await verify_entries(app, copy)] == [
        "started", *["wrong_code"] * 5, "started", *["wrong_code"] * 3, "started", *["wrong_code"] * 2,
        "locked", "locked", "locked", "started", "verified"]


async def test_concurrent_requests_respect_the_limits(app, client):
    copy = await rivera_copy(app, client)
    visitor = await open_visitor(client, copy)
    await started(client, visitor, DANA_PHONE)
    answers = await asyncio.gather(*(check(client, visitor, "000000") for _ in range(20)))
    assert {(response.status_code, response.content) for response in answers} == {(422, b'{"code":"invalid"}')}
    [challenge] = await challenges(app, copy)
    assert (challenge.status, len(challenge.failed_at)) == ("failed", 5)
    outcomes = [summary["outcome"] for summary in await verify_entries(app, copy)]
    assert outcomes == ["started", *["wrong_code"] * 5, *["no_challenge"] * 15]
    # five sessions ask for Bob's code at once: one code stays live
    sessions = [await open_visitor(client, copy) for _ in range(5)]
    answers = await asyncio.gather(*(started(client, session, "bob@example.com") for session in sessions))
    assert {answer.message for answer in answers} == {STARTED_EN}
    bob = [challenge for challenge in await challenges(app, copy) if challenge.person_id == copy.people["bob"]]
    assert sorted(challenge.status for challenge in bob) == ["cancelled"] * 4 + ["live"]


async def verified_as_dana(client: httpx.AsyncClient, visitor: Visitor) -> None:
    """Verifies the session as Dana with the code the Demo inbox shows it."""
    [notice] = (await started(client, visitor, DANA_PHONE)).inbox
    response = await check(client, visitor, code_in(await entry_of(client, visitor, notice)))
    assert response.status_code == 200 and response.json()["verified"] is True, response.text


async def test_a_session_verifies_one_person(app, client):
    copy = await rivera_copy(app, client)
    visitor = await open_visitor(client, copy)
    await verified_as_dana(client, visitor)
    answer = await started(client, visitor, "bob@example.com")
    assert answer == VerifyStarted(message="You're already confirmed in this chat.", inbox=[])
    assert all(challenge.person_id == copy.people["dana"] for challenge in await challenges(app, copy))
    assert [entry.to for entry in await session_inbox(client, visitor)] == [mask_contact(DANA_PHONE)]
    response = await check(client, visitor, "000000")                 # nothing left to check
    assert response.status_code == 200 and response.json()["verified"] is True
    assert (await session_row(app, copy, visitor)).person_id == copy.people["dana"]
    assert [summary["outcome"] for summary in await verify_entries(app, copy)] == [
        "started", "verified", "already_verified", "already_verified"]
    await set_session(app, copy, visitor.session_id, last_language="es")
    assert (await started(client, visitor, "bob@example.com")).message == "Ya confirmaste quién eres en este chat."


async def test_a_session_bound_to_someone_else_is_refused_and_ledgered(app, client, monkeypatch):
    """A session that names a person without being verified as them (an agent session, once those
    verify) gets the one 422 for a right code, ledgered `already_bound`, and the challenge stays live."""
    codes(monkeypatch, 111111)
    copy = await rivera_copy(app, client)
    visitor = await open_visitor(client, copy)
    await started(client, visitor, DANA_PHONE)
    await set_session(app, copy, visitor.session_id, person_id=copy.people["bob"])
    response = await check(client, visitor, "111111")
    assert (response.status_code, response.json()) == INVALID
    [challenge] = await challenges(app, copy)
    assert (challenge.status, challenge.failed_at) == ("live", [])
    session = await session_row(app, copy, visitor)
    assert (session.person_id, session.assurance, session.verified) == (copy.people["bob"], "none", False)
    assert await verify_entries(app, copy) == [{"outcome": "started", "challenge_id": challenge.challenge_id},
                                               {"outcome": "already_bound", "challenge_id": challenge.challenge_id}]


async def all_three(client: httpx.AsyncClient, visitor: Visitor, headers: dict[str, str]) -> list[httpx.Response]:
    """The three session routes, called for `visitor` with `headers`."""
    body = {"session_id": visitor.session_id}
    return [await client.post("/verify/start", headers=headers, json={**body, "contact": DANA_PHONE}),
            await client.post("/verify/check", headers=headers, json={**body, "code": "000000"}),
            await client.get("/demo_inbox", params=body, headers=headers)]


async def test_verify_routes_answer_session_states(app, client, frozen_clock):
    copy, other = await rivera_copy(app, client), await rivera_copy(app, client)
    visitor, elsewhere = await open_visitor(client, copy), await open_visitor(client, other)
    for headers in ({auth.SESSION_HEADER: elsewhere.token},              # a session of another copy
                    {auth.SESSION_HEADER: visitor.token[:-1]},           # a guess
                    copy.owner, {}):                                     # the owner's token, or none
        for response in await all_three(client, visitor, headers):
            assert (response.status_code, response.json()) == (401, {"code": "auth"}), headers
    refusals = [entry.event for entry in await rows_of(app, copy.copy_id, select(LedgerEntry).where(
        LedgerEntry.desk_id == copy.rivera.desk_id).order_by(LedgerEntry.seq)) if entry.event.kind == "auth"]
    routes = ["POST /verify/start", "POST /verify/check", "GET /demo_inbox"]
    assert [(event.session_id, event.summary) for event in refusals] == [
        (visitor.session_id, {"route": route, "reason": "bad_token"}) for route in routes] * 4
    assert await challenges(app, copy) == []
    # the owner has the conversation: the visitor can still verify
    response = await client.post(f"/sessions/{visitor.session_id}/mode", json={"mode": "owner", "generation": 0},
                                 headers=copy.owner)
    assert response.status_code == 200, response.text
    await verified_as_dana(client, visitor)
    # a paused session starts nothing, and a check finds no code
    paused = await open_visitor(client, copy)
    await set_session(app, copy, paused.session_id, mode="paused")
    start_paused, check_paused, inbox_paused = await all_three(client, paused, paused.headers)
    assert (start_paused.status_code, start_paused.json()) == (409, {"code": "mode_paused"})
    assert (check_paused.status_code, check_paused.json()) == INVALID
    assert (inbox_paused.status_code, inbox_paused.json()) == (200, [])
    # a closed session, then a deleted Desk, answers 409 closed
    closed, open_one = await open_visitor(client, copy), await open_visitor(client, copy)
    await set_session(app, copy, closed.session_id, closed_at=frozen_clock.now())
    for response in await all_three(client, closed, closed.headers):
        assert (response.status_code, response.json()) == (409, {"code": "closed"})
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        desk = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == copy.rivera.desk_id)))).one()
        desk.deleted_at = frozen_clock.now()
    for response in await all_three(client, open_one, open_one.headers):
        assert (response.status_code, response.json()) == (409, {"code": "closed"})
    refusals = [entry.event.summary for entry in await rows_of(app, copy.copy_id, select(LedgerEntry).where(
        LedgerEntry.desk_id == copy.rivera.desk_id).order_by(LedgerEntry.seq)) if entry.event.kind == "auth"][12:]
    assert refusals == [{"route": "POST /verify/start", "reason": "mode_paused"},
                        *({"route": route, "reason": "closed"} for route in routes)] + [
                           {"route": route, "reason": "closed"} for route in routes]
    assert [challenge.person_id for challenge in await challenges(app, copy)] == [copy.people["dana"]]


@pytest.mark.parametrize("route", ["start", "check"])
async def test_a_desk_deleted_while_a_verify_route_waits_answers_closed(app, client, frozen_clock, monkeypatch,
                                                                         route):
    """Mike deletes the Desk after a verify route has checked the session and its Desk and before
    it holds the session row. The route checks both again on the row it holds, so it answers 409
    `closed`, ledgered, as it would had the deletion come first: a start makes no challenge and
    sends no code, and a check verifies no one. (The clock stands still, so the route writes no
    `last_seen_at` that would hold the row before the deletion could close it.)"""
    copy = await rivera_copy(app, client)
    visitor = await open_visitor(client, copy)
    code = ""
    if route == "check":
        [notice] = (await started(client, visitor, DANA_PHONE)).inbox
        code = code_in(await entry_of(client, visitor, notice))
    locked_session, deleted = verification.locked_session, asyncio.Event()

    async def deleted_first(ctx, session_id):
        if not deleted.is_set():
            deleted.set()
            response = await asyncio.wait_for(client.delete(f"/desks/{copy.rivera.desk_id}", headers=copy.owner), 10)
            assert response.status_code == 204, response.text
        return await locked_session(ctx, session_id)

    monkeypatch.setattr(verification, "locked_session", deleted_first)
    response = await (start(client, visitor, DANA_PHONE) if route == "start" else check(client, visitor, code))
    assert (response.status_code, response.json()) == (409, {"code": "closed"})
    made = await challenges(app, copy)
    assert [challenge.status for challenge in made] == ([] if route == "start" else ["cancelled"])
    assert await verify_entries(app, copy) == [
        {"outcome": "started", "challenge_id": challenge.challenge_id} for challenge in made]
    entries = [entry.event for entry in await rows_of(app, copy.copy_id, select(LedgerEntry).where(
        LedgerEntry.desk_id == copy.rivera.desk_id).order_by(LedgerEntry.seq))]
    [deletion] = [n for n, event in enumerate(entries) if event.summary == {"part": "desk", "deleted": True}]
    assert [(event.kind, event.session_id, event.summary) for event in entries[deletion + 1:]] == [
        ("auth", visitor.session_id, {"route": f"POST /verify/{route}", "reason": "closed"})]
    [session] = await rows_of(app, copy.copy_id, select(ActorSession).where(
        ActorSession.session_id == visitor.session_id))
    assert (session.person_id, session.verified, session.closed_at) == (None, False, frozen_clock.now())


async def test_demo_inbox_is_scoped_to_the_sessions_challenges(app, client):
    copy, other = await rivera_copy(app, client), await rivera_copy(app, client)
    first, second = await open_visitor(client, copy), await open_visitor(client, copy)
    [dana_first] = (await started(client, first, DANA_PHONE)).inbox
    assert [entry.entry_id for entry in await session_inbox(client, first)] == [dana_first.entry_id]
    assert await session_inbox(client, second) == []                  # nothing until it asks for a code itself
    [dana_second] = (await started(client, second, "510-555-0177")).inbox
    [bob] = (await started(client, second, "Bob@Example.com")).inbox
    # each session reads the codes it asked for, and no other session's, though they went to Dana too
    assert {entry.entry_id for entry in await session_inbox(client, first)} == {dana_first.entry_id}
    assert {entry.entry_id for entry in await session_inbox(client, second)} == {dana_second.entry_id, bob.entry_id}
    assert {entry.to for entry in await session_inbox(client, second)} == {"•••• 0177", "b•••@example.com"}
    stranger = await open_visitor(client, other)                      # Dana in another copy is someone else
    await started(client, stranger, DANA_PHONE)
    assert len(await session_inbox(client, stranger)) == 1
    assert dana_first.entry_id not in {entry.entry_id for entry in await owner_inbox(client, other)}
    owner_ids = {entry.entry_id for entry in await owner_inbox(client, copy)}
    assert {dana_first.entry_id, dana_second.entry_id, bob.entry_id} <= owner_ids


async def test_a_session_never_reads_a_code_another_session_asked_for(app, client):
    """A session that once typed Dana's contact doesn't read the codes later sent to her: once the
    owner gives her another contact, the code another session asks for goes there, and neither it
    nor her new contact, masked, reaches the first session."""
    copy = await rivera_copy(app, client)
    first, second = await open_visitor(client, copy), await open_visitor(client, copy)
    [old] = (await started(client, first, DANA_PHONE)).inbox
    moved = await client.put(f"/desks/{copy.rivera.desk_id}/people", headers=copy.owner, json={"upsert": [
        {"ref": "dana", "display_name": "Dana Whitfield", "contact": "dana.w@example.net"}]})
    assert moved.status_code == 200, moved.text
    [new] = (await started(client, second, "dana.w@example.net")).inbox
    assert new.to == mask_contact("dana.w@example.net")
    assert [(entry.entry_id, entry.to) for entry in await session_inbox(client, first)] == [
        (old.entry_id, mask_contact(DANA_PHONE))]
    assert [entry.entry_id for entry in await session_inbox(client, second)] == [new.entry_id]


async def test_sessions_never_see_alerts_or_checkpoints(app, client):
    copy = await rivera_copy(app, client)
    owner_typed, business_typed, dana = [await open_visitor(client, copy) for _ in range(3)]
    for _ in range(6):                                                # five codes, then a lockout alert for Dana
        await started(client, dana, DANA_PHONE)
    await started(client, business_typed, "(510) 555-0142")           # the business's own number
    for _ in range(60):                                               # until the ledger's 50th entry checkpoints
        await started(client, owner_typed, "owner")
        if any(entry.kind == "head_checkpoint" for entry in await owner_inbox(client, copy)):
            break
    everything = await owner_inbox(client, copy)
    assert {entry.kind for entry in everything} == {"verification_code", "alert", "head_checkpoint"}
    assert [entry.kind for entry in everything if entry.to == "owner" and "•••• 0177" in entry.body] == ["alert"]
    assert await session_inbox(client, owner_typed) == []
    assert await session_inbox(client, business_typed) == []
    seen = await session_inbox(client, dana)
    assert len(seen) == 5 and {(entry.kind, entry.to) for entry in seen} == {("verification_code", "•••• 0177")}
    assert [entry for entry in everything if entry.kind == "verification_code"] == seen


async def test_only_the_owners_inbox_names_a_held_decision(app, client):
    """A visitor's own request is held, so the owner's alert for it names that decision, and the
    same visitor starts Dana's verification, so their own inbox holds her code. The owner reads the
    link to the held request; every entry the session reads says it names no decision."""
    copy = await rivera_copy(app, client)
    visitor = await open_visitor(client, copy)
    held = await decided(client, visitor, "native.quote", quote_args(("drain", 1), discount_bp=8000))
    assert held.state == "held", held.reason_plain                   # rv-quote allows no discount
    await started(client, visitor, DANA_PHONE)
    naming = [(entry.kind, entry.to) for entry in await owner_inbox(client, copy)
              if entry.decision_id == held.decision_id]
    assert naming == [("alert", "owner")]
    response = await client.get("/demo_inbox", params={"session_id": visitor.session_id}, headers=visitor.headers)
    assert response.status_code == 200, response.text
    shown = response.json()
    assert [entry["kind"] for entry in shown] == ["verification_code"]
    assert all("decision_id" in entry and entry["decision_id"] is None for entry in shown)


def test_a_sessions_read_never_copies_a_decision_id(frozen_clock):
    """The session's read builds its entries without the column, so even a row that named a
    decision (which the table's check refuses for anything but an owner alert) reads as naming
    none; the owner's read carries it."""
    row = DemoInboxRow(entry_id="inbox-1", copy_id="copy-1", desk_id="desk-1", to="owner", person_id=None,
                       kind="alert", body="A request is waiting for you.", preview="A request is waiting for you.",
                       created_at=frozen_clock.now(), decision_id="dec-1")
    assert demo_inbox.owner_entry(row).decision_id == "dec-1"
    assert demo_inbox.session_entry(row).decision_id is None


def holds(text: str, code: str) -> bool:
    """Whether `code` appears in `text` as a token of its own. Views and log lines carry hex digests
    (hashes, signatures), which hold any six digits by chance inside a longer run of hex."""
    return re.search(rf"(?<![0-9A-Za-z]){code}(?![0-9A-Za-z])", text) is not None


async def test_codes_stay_in_the_kernel(app, client, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger="desk")
    codes(monkeypatch, 424242, 737373)
    copy = await rivera_copy(app, client)
    first, second = await open_visitor(client, copy), await open_visitor(client, copy)
    answers = [await start(client, first, DANA_PHONE), await start(client, second, DANA_PHONE)]
    for visitor, code in ((first, "424242"), (second, "000000"), (second, "737373"), (first, "737373")):
        await check(client, visitor, code)
    sent = [code_in(entry) for entry in await owner_inbox(client, copy) if entry.kind == "verification_code"]
    assert sorted(sent) == ["424242", "737373"]                      # the codes went to the Demo inbox, and only there
    exposed = [answer.text for answer in answers]                     # VerifyStarted and its InboxNotice
    exposed += [entry.event.model_dump_json() for entry in await rows_of(app, copy.copy_id, select(LedgerEntry))]
    for view in KERNEL_RO_VIEWS:
        exposed += [text for (text,) in api_rows(copy.copy_id, f"SELECT row_to_json(v)::text FROM kernel_ro.{view} v")]
    exposed += [f"{record.getMessage()} {record.exc_text or ''}" for record in caplog.records]
    assert any(record.getMessage().startswith("kernel_failure") for record in caplog.records)   # the 422s logged
    for code in ("424242", "737373"):
        assert not [text for text in exposed if holds(text, code)], code


async def test_a_failed_inbox_write_logs_no_code(app, client, monkeypatch, caplog):
    """A statement that fails is logged without its bound values, so a Demo inbox insert that
    fails can't write the code it carried into a log line."""
    caplog.set_level(logging.DEBUG)
    codes(monkeypatch, 424242, 737373)
    copy = await rivera_copy(app, client)
    visitor = await open_visitor(client, copy)
    [notice] = (await started(client, visitor, DANA_PHONE)).inbox
    monkeypatch.setattr(demo_inbox, "new_id", lambda prefix: notice.entry_id)   # the next entry's ID is taken
    response = await start(client, visitor, DANA_PHONE)
    assert (response.status_code, response.json()) == (500, {"code": "internal"})
    assert "IntegrityError sqlstate=23505 constraint=demo_inbox_pkey" in caplog.text   # the failed insert was logged
    assert [(row.status, code_in(await entry_of(client, visitor, notice))) for row in await challenges(app, copy)] == [
        ("live", "424242")]                                                     # and nothing of it was kept
    for code in ("424242", "737373"):
        assert not holds(caplog.text, code), code


async def test_a_refused_row_is_not_logged(app, client, monkeypatch, caplog):
    """A row Postgres refuses can be named in its error ("Failing row contains (...)"; Postgres
    leaves it out on a table under row-level security, as the kernel's are), and a Demo inbox
    entry's row holds the code: the error is logged by its class, SQLSTATE and constraint alone,
    with neither the code nor the row."""
    caplog.set_level(logging.DEBUG)
    codes(monkeypatch, 424242)
    copy = await rivera_copy(app, client)
    visitor = await open_visitor(client, copy)
    deliver = demo_inbox.deliver

    async def without_its_desk(ctx, **entry):
        if entry["kind"] == "verification_code":
            entry["desk_id"] = None                                             # NOT NULL refuses the row
        return await deliver(ctx, **entry)

    monkeypatch.setattr(demo_inbox, "deliver", without_its_desk)
    response = await start(client, visitor, DANA_PHONE)
    assert (response.status_code, response.json()) == (500, {"code": "internal"})
    assert not holds(caplog.text, "424242")
    for row in ("Failing row", "DETAIL", mask_contact(DANA_PHONE)):
        assert row not in caplog.text, row
    assert "IntegrityError sqlstate=23502 constraint=-" in caplog.text           # the refusal was logged


async def test_a_value_postgres_quotes_is_not_logged(app, client, monkeypatch, caplog):
    """Postgres quotes a value it can't read in the error's own message, which row-level security
    doesn't change: a Demo inbox entry whose code reached a column that can't hold it is logged by
    the error's class and SQLSTATE alone, without the code."""
    caplog.set_level(logging.DEBUG)
    codes(monkeypatch, 424242)
    copy = await rivera_copy(app, client)
    visitor = await open_visitor(client, copy)
    deliver = demo_inbox.deliver

    async def dated_by_its_body(ctx, *, copy_id, desk_id, to, person_id, kind, body, preview, challenge_id=None):
        if kind != "verification_code":
            return await deliver(ctx, copy_id=copy_id, desk_id=desk_id, to=to, person_id=person_id, kind=kind,
                                 body=body, preview=preview)
        await ctx.db.execute(insert(DemoInboxRow).values(
            entry_id="inbox-1", copy_id=copy_id, desk_id=desk_id, to=to, person_id=person_id, kind=kind, body=body,
            preview=preview, created_at=body, challenge_id=challenge_id))     # not a time: Postgres quotes it

    monkeypatch.setattr(demo_inbox, "deliver", dated_by_its_body)
    response = await start(client, visitor, DANA_PHONE)
    assert (response.status_code, response.json()) == (500, {"code": "internal"})
    assert not holds(caplog.text, "424242")
    assert "DataError sqlstate=22007 constraint=-" in caplog.text                # the refusal was logged


def test_every_kernel_engine_hides_bound_values(app):
    """The kernel app's engine and the module's kernel engine both log failed statements without
    their bound values."""
    assert app.state.kernel.engine.sync_engine.hide_parameters
    assert kernel_engine().sync_engine.hide_parameters


async def test_attempt_and_ledger_share_a_transaction(app, client, monkeypatch):
    copy = await rivera_copy(app, client)
    visitor = await open_visitor(client, copy)
    await started(client, visitor, DANA_PHONE)
    append = ledger.append

    async def verify_entries_fail(ctx, *, copy_id, desk_id, event):
        if event.kind == "verify":
            raise RuntimeError("the ledger is unavailable")
        return await append(ctx, copy_id=copy_id, desk_id=desk_id, event=event)

    monkeypatch.setattr(ledger, "append", verify_entries_fail)
    response = await check(client, visitor, "000000")
    assert (response.status_code, response.json()) == (500, {"code": "internal"})
    [challenge] = await challenges(app, copy)
    assert (challenge.status, challenge.failed_at) == ("live", [])    # the attempt went with its entry
    response = await start(client, visitor, "bob@example.com")
    assert (response.status_code, response.json()) == (500, {"code": "internal"})
    assert [(row.person_id, row.status) for row in await challenges(app, copy)] == [(copy.people["dana"], "live")]
    assert len(await session_inbox(client, visitor)) == 1             # no code went out for Bob
    monkeypatch.setattr(ledger, "append", append)
    assert [summary["outcome"] for summary in await verify_entries(app, copy)] == ["started"]


async def quoted(client: httpx.AsyncClient, visitor: Visitor, call_id: str) -> Fact:
    """A drain clearing quote, decided and executed in the visitor's session (Turner quotes are automatic)."""
    decision = await decided(client, visitor, "native.quote", quote_args(("drain", 1)), call_id=call_id)
    assert decision.outcome == "allow", decision.reason_plain
    [fact] = (await executed(client, visitor, decision)).facts
    return fact


async def context_facts(client: httpx.AsyncClient, visitor: Visitor) -> dict[str, Fact]:
    response = await client.get(f"/context/{visitor.session_id}", headers=visitor.headers)
    assert response.status_code == 200, response.text
    return {fact["fact_id"]: Fact.model_validate(fact) for fact in response.json()["facts"]}


async def test_verifying_adds_the_person_to_earlier_and_later_facts(app, client):
    copy = await rivera_copy(app, client)
    visitor, neighbour = await open_visitor(client, copy), await open_visitor(client, copy)
    earlier, theirs = await quoted(client, visitor, "call-1"), await quoted(client, neighbour, "call-1")
    session_label = Label(readers=["owner", f"session:{visitor.session_id}"])
    assert earlier.label == session_label
    await verified_as_dana(client, visitor)
    dana = copy.people["dana"]
    person_label = Label(readers=["owner", f"session:{visitor.session_id}", f"person:{dana}"], record_owner=dana)
    later = await quoted(client, visitor, "call-2")
    assert later.label == person_label
    facts = await context_facts(client, visitor)
    assert (facts[earlier.fact_id].label, facts[later.fact_id].label) == (person_label, person_label)
    assert theirs.fact_id not in facts                                # another session's quote stays its own
    [row] = await rows_of(app, copy.copy_id, select(FactRow).where(FactRow.fact_id == theirs.fact_id))
    assert (row.readers, row.record_owner) == (["owner", f"session:{neighbour.session_id}"], None)
    charter = [fact for fact in facts.values() if fact.fact_id.startswith("charter:")]
    assert charter and all(fact.label == Label(readers=["public"]) for fact in charter)   # public facts unchanged


async def test_a_verified_person_sees_their_facts_from_another_session(app, client):
    copy = await rivera_copy(app, client)
    first, second, unverified = [await open_visitor(client, copy) for _ in range(3)]
    await verified_as_dana(client, first)
    quote = await quoted(client, first, "call-1")
    assert quote.fact_id not in await context_facts(client, second)
    await verified_as_dana(client, second)                            # Dana again, in another chat
    assert (await context_facts(client, second))[quote.fact_id] == quote
    assert quote.fact_id not in await context_facts(client, unverified)
