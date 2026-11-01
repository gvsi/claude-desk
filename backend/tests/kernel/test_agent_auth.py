"""Signed visiting agents: demo agents, their wallet-signed mandates, and the signature, key and
nonce checks on every call an agent session makes.

An agent signs each A2A request itself (Ed25519 over the RFC 8785 canonical JSON of
`{desk_slug, ts, nonce, body_sha256}`), and the API forwards the four signature headers and the
body's sha256 to the kernel on every call of that turn. These tests sign as an agent would, with
their own Ed25519 code over `desk_kernel.canonical_json`, never the kernel's signing helpers, and
call the kernel as the API would. Demo agents come from `POST /agents/demo`, minted by the copy's
owner or a session on the Desk; the private key in the answer is the agent's alone.
"""

import hashlib
import json
from dataclasses import dataclass, field
from datetime import timedelta

import desk_kernel
import httpx
import psycopg
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from sqlalchemy import select

from desk.contracts import DemoAgentIssued, DemoInboxEntry, Mandate, ReplyVerdict, SessionCreated, SessionState
from desk.db.models import (ActorSession, AgentKey, AgentNonce, DemoWalletKey, Desk, Document, Tool,
                            VerificationChallenge)
from desk.db.models import Decision as DecisionRow
from desk.db.models import Mandate as MandateRow
from desk.db.session import database_url, libpq_url
from desk.db.tables import KERNEL_TABLES
from desk.kernel_api import PublicDesk, VerifyStarted, WhoAmI
from desk.kernel_service import agents
from desk.kernel_service.auth import Named
from desk.kernel_service.clock import signed_time
from desk.kernel_service.desks import mask_contact
from desk.kernel_service.sessions import principal_for

from .helpers import kernel_ctx, ledger_rows, make_copy_rows, rows_of
from .test_adapters import Rivera, quote_args, rivera
from .test_decide import add_desk, decided, open_visitor, post_decide, set_session
from .test_execute import executed, executions_of, post_execute
from .test_verification import DANA_PHONE, code_in, codes, rivera_copy

KEY_HEADER, TS_HEADER, NONCE_HEADER, SIG_HEADER, BODY_HEADER = (
    "X-Agent-Key-Id", "X-Agent-Ts", "X-Agent-Nonce", "X-Agent-Sig", "X-Agent-Body-Sha256")


def canonical(obj: dict) -> bytes:
    return desk_kernel.canonical_json(json.dumps(obj)).encode()


def sign(private_key_hex: str, obj: dict) -> str:
    return Ed25519PrivateKey.from_private_bytes(bytes.fromhex(private_key_hex)).sign(canonical(obj)).hex()


@dataclass
class Agent:
    """A demo agent as its runner holds it: the key the kernel returned once, and its mandate."""

    issued: DemoAgentIssued
    nonces: int = field(default=0)

    @property
    def key_id(self) -> str:
        return self.issued.agent_key_id

    def new_nonce(self) -> str:
        self.nonces += 1
        return f"nonce-{self.key_id}-{self.nonces:04d}"

    def headers(self, slug: str, body: bytes, *, ts: str, nonce: str | None = None,
                signed_slug: str | None = None) -> dict[str, str]:
        """The headers of one signed A2A request, as the API forwards them to the kernel."""
        nonce = nonce or self.new_nonce()
        body_sha256 = hashlib.sha256(body).hexdigest()
        sig = sign(self.issued.agent_private_key_hex, {"desk_slug": signed_slug or slug, "ts": ts, "nonce": nonce,
                                                       "body_sha256": body_sha256})
        return {KEY_HEADER: self.key_id, TS_HEADER: ts, NONCE_HEADER: nonce, SIG_HEADER: sig, BODY_HEADER: body_sha256}


def a2a_body(slug: str, message: str = "Hello, can you quote a drain clearing?", session_id: str | None = None) -> bytes:
    """The raw body of an A2A request: what the signature's `body_sha256` covers."""
    return json.dumps({"desk_slug": slug, "session_id": session_id, "message": message}).encode()


async def mint(client: httpx.AsyncClient, headers: dict[str, str], desk_id: str) -> Agent:
    response = await client.post("/agents/demo", headers=headers, json={"desk_id": desk_id})
    assert response.status_code == 200, response.text
    return Agent(DemoAgentIssued.model_validate(response.json()))


async def post_open(client: httpx.AsyncClient, slug: str, headers: dict[str, str], mandate: dict | None) -> httpx.Response:
    """An agent's `POST /sessions`, with the mandate its A2A request carried."""
    return await client.post("/sessions", headers=headers, json={"desk_slug": slug, "kind": "agent", "mandate": mandate})


async def agent_sessions(app, copy_id: str) -> list[ActorSession]:
    return await rows_of(app, copy_id, select(ActorSession).where(ActorSession.kind == "agent"))


def refusals(entries) -> list[tuple[str, str, str | None]]:
    return [(e.event.kind, e.event.summary["reason"], e.event.summary.get("agent_key_id"))
            for e in entries if e.event.kind == "agent_auth" and "reason" in e.event.summary]


async def test_bad_signature_is_refused(app, client, frozen_clock):
    rows = await make_copy_rows(app)
    agent = await mint(client, rows.owner, rows.desk_id)
    body = a2a_body(rows.slug)
    ts = signed_time(frozen_clock.now())
    mandate = agent.issued.mandate.model_dump(mode="json")
    # signed over another Desk's slug: the signature doesn't cover this request
    response = await post_open(client, rows.slug, agent.headers(rows.slug, body, ts=ts, signed_slug="other-desk"),
                               mandate)
    assert (response.status_code, response.json()) == (401, {"code": "auth"})
    # signed over another body than the one the API hashed
    headers = agent.headers(rows.slug, body, ts=ts) | {BODY_HEADER: hashlib.sha256(b"another body").hexdigest()}
    response = await post_open(client, rows.slug, headers, mandate)
    assert (response.status_code, response.json()) == (401, {"code": "auth"})
    # a signature that isn't hex, and one by a key the kernel never issued under this key id
    for sig in ("not-a-signature", sign(Ed25519PrivateKey.generate().private_bytes_raw().hex(), {"x": 1})):
        headers = agent.headers(rows.slug, body, ts=ts) | {SIG_HEADER: sig}
        response = await post_open(client, rows.slug, headers, mandate)
        assert (response.status_code, response.json()) == (401, {"code": "auth"})
    # a good signature with a second credential beside it: a call carries exactly one
    visitor = await open_visitor(client, rows)
    for second in (visitor.headers, rows.owner):
        response = await post_open(client, rows.slug, agent.headers(rows.slug, body, ts=ts) | second, mandate)
        assert (response.status_code, response.json()) == (401, {"code": "auth"})
    assert await agent_sessions(app, rows.copy_id) == []
    entries = await ledger_rows(app, rows)
    assert refusals(entries) == [("agent_auth", reason, agent.key_id) for reason in (
        "bad_signature", "bad_signature", "malformed", "bad_signature")]
    assert [e.event.summary for e in entries if e.event.kind == "auth"] == [
        {"route": "POST /sessions", "reason": "bad_token"}] * 2
    for entry in entries:                                    # never the signature, the nonce or the key
        assert agent.issued.agent_private_key_hex not in entry.envelope_jcs
        assert "nonce-" not in entry.envelope_jcs


async def test_stale_timestamp_is_refused(app, client, frozen_clock):
    rows = await make_copy_rows(app)
    agent = await mint(client, rows.owner, rows.desk_id)
    mandate = agent.issued.mandate.model_dump(mode="json")
    now = frozen_clock.now()
    # more than five minutes either side of the kernel's clock, not the signed time's exact form, or no time at all
    for ts in (signed_time(now - timedelta(seconds=301)), signed_time(now + timedelta(seconds=301)),
               now.strftime("%Y-%m-%dT%H:%M:%SZ"), "2026-13-45T99:99:99.000000Z"):
        body = a2a_body(rows.slug, message=f"Hello at {ts}")
        response = await post_open(client, rows.slug, agent.headers(rows.slug, body, ts=ts), mandate)
        assert (response.status_code, response.json()) == (401, {"code": "auth"})
    assert await agent_sessions(app, rows.copy_id) == []
    assert refusals(await ledger_rows(app, rows)) == [
        ("agent_auth", "stale_timestamp", agent.key_id), ("agent_auth", "stale_timestamp", agent.key_id),
        ("agent_auth", "malformed", agent.key_id), ("agent_auth", "malformed", agent.key_id)]
    # within the window, the same agent opens its session
    body = a2a_body(rows.slug)
    response = await post_open(client, rows.slug, agent.headers(
        rows.slug, body, ts=signed_time(now - timedelta(seconds=299))), mandate)
    assert response.status_code == 200, response.text
    assert [row.agent_key_id for row in await agent_sessions(app, rows.copy_id)] == [agent.key_id]


async def test_key_from_another_copy_is_refused(app, client, registry, frozen_clock):
    ours, theirs = await make_copy_rows(app), await make_copy_rows(app)
    agent = await mint(client, theirs.owner, theirs.desk_id)
    ts = signed_time(frozen_clock.now())
    body = a2a_body(ours.slug)
    # another copy's key is no key here, mandate or not
    for mandate in (agent.issued.mandate.model_dump(mode="json"), None):
        response = await post_open(client, ours.slug, agent.headers(ours.slug, body, ts=ts), mandate)
        assert (response.status_code, response.json()) == (401, {"code": "auth"})
    assert refusals(await ledger_rows(app, ours)) == [("agent_auth", "unknown_key", agent.key_id)] * 2
    # and a key opens sessions only on the Desk it was minted for, even in its own copy
    other_desk = await add_desk(app, theirs, [], [])
    [other_slug] = [row.slug for row in await rows_of(app, theirs.copy_id, select(Desk).where(
        Desk.desk_id == other_desk))]
    response = await post_open(client, other_slug, agent.headers(other_slug, a2a_body(other_slug), ts=ts), None)
    assert (response.status_code, response.json()) == (401, {"code": "auth"})
    assert await agent_sessions(app, ours.copy_id) == await agent_sessions(app, theirs.copy_id) == []
    response = await post_open(client, theirs.slug, agent.headers(theirs.slug, a2a_body(theirs.slug), ts=ts), None)
    assert response.status_code == 200, response.text


def kernel_text(copy_id: str) -> str:
    """Every kernel row of a copy, as text (read as desk_admin)."""
    with psycopg.connect(libpq_url(database_url("ADMIN"))) as admin:
        found = [admin.execute(f"SELECT row_to_json(t)::text FROM kernel.{table} t WHERE copy_id = %s",
                               (copy_id,)).fetchall() for table in KERNEL_TABLES]
    return "\n".join(text for rows in found for (text,) in rows)


def agent_key_columns() -> list[str]:
    with psycopg.connect(libpq_url(database_url("ADMIN"))) as admin:
        return [name for (name,) in admin.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'kernel'"
            " AND table_name = 'agent_keys' ORDER BY ordinal_position").fetchall()]


async def open_agent(client: httpx.AsyncClient, slug: str, agent: Agent, frozen_clock, *, mandate: bool = True,
                     body: bytes | None = None, nonce: str | None = None) -> SessionCreated:
    """The agent's signed `POST /sessions`, with its mandate unless `mandate` is False."""
    headers = agent.headers(slug, body or a2a_body(slug), ts=signed_time(frozen_clock.now()), nonce=nonce)
    response = await post_open(client, slug, headers, agent.issued.mandate.model_dump(mode="json") if mandate else None)
    assert response.status_code == 200, response.text
    return SessionCreated.model_validate(response.json())


async def test_demo_agent_round_trip(app, client, frozen_clock):
    rows = await make_copy_rows(app)
    now = frozen_clock.now()
    agent = await mint(client, rows.owner, rows.desk_id)
    issued = agent.issued
    private = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(issued.agent_private_key_hex))
    public_hex = private.public_key().public_bytes_raw().hex()
    assert issued.agent_key_id == hashlib.sha256(bytes.fromhex(public_hex)).hexdigest()[:16]
    # the kernel keeps the public half only: there is no column for the private one, nor a copy of it
    assert not any("private" in column for column in agent_key_columns())
    [key] = await rows_of(app, rows.copy_id, select(AgentKey))
    assert (key.agent_key_id, key.desk_id, key.public_key_hex, key.source, key.minted_by, key.created_at) == (
        issued.agent_key_id, rows.desk_id, public_hex, "demo", "owner", now)
    assert issued.agent_private_key_hex not in kernel_text(rows.copy_id)
    # the mint is ledgered without a key
    [minted] = [e for e in await ledger_rows(app, rows) if e.event.kind == "agent_auth"]
    assert (minted.event.session_id, minted.event.summary) == (None, {
        "agent_key_id": issued.agent_key_id, "mandate_id": issued.mandate.mandate_id, "minted_by": "owner"})
    # the demo wallet signed the mandate: $20 a charge, $100 in all, for an hour, for this agent and Desk
    mandate = issued.mandate
    assert (mandate.issuer, mandate.agent_key_id, mandate.desk_id, mandate.on_behalf_of, mandate.allowed_effects,
            mandate.per_charge_cents, mandate.total_cents, mandate.currency, mandate.expires_at) == (
        "demo-wallet", issued.agent_key_id, rows.desk_id, "Demo visitor", ["charge"], 2_000, 10_000, "usd",
        signed_time(now + timedelta(hours=1)))
    [wallet] = await rows_of(app, rows.copy_id, select(DemoWalletKey))
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(wallet.public_key_hex)).verify(
        bytes.fromhex(mandate.sig), canonical(mandate.model_dump(mode="json", exclude={"sig"})))

    # a signed POST /sessions opens an agent session bound to the key and the mandate, with no token
    created = await open_agent(client, rows.slug, agent, frozen_clock)
    assert created.session_token is None
    assert (created.state.kind, created.state.verified, created.state.assurance, created.state.mode) == (
        "agent", False, "none", "ai")
    [row] = await agent_sessions(app, rows.copy_id)
    assert (row.session_id, row.desk_id, row.secret_hash) == (created.state.session_id, rows.desk_id, None)
    principal = principal_for(row)
    assert (principal.kind, principal.agent_key_id, principal.mandate_id) == (
        "agent", issued.agent_key_id, mandate.mandate_id)
    [stored] = await rows_of(app, rows.copy_id, select(MandateRow))
    assert (stored.session_id, stored.issuer, stored.nonce, stored.envelope) == (
        row.session_id, "demo-wallet", mandate.nonce, mandate)
    opened = [e for e in await ledger_rows(app, rows) if e.event.kind == "session"]
    assert [e.event.summary for e in opened] == [{"session_id": row.session_id, "kind": "agent",
                                                  "agent_key_id": issued.agent_key_id,
                                                  "mandate_id": mandate.mandate_id}]

    # the next turn starts with GET /whoami?session_id= and a new nonce
    body = a2a_body(rows.slug, "And on Saturday?", session_id=row.session_id)
    response = await client.get("/whoami", params={"session_id": row.session_id},
                                headers=agent.headers(rows.slug, body, ts=signed_time(frozen_clock.now())))
    assert response.status_code == 200, response.text
    assert WhoAmI.model_validate(response.json()) == WhoAmI(
        kind="agent", copy_id=rows.copy_id, desk_id=rows.desk_id, desk_ids=[rows.desk_id], session=created.state)
    # the API ledgers its own entries for the agent's session on the same signature, as reported
    headers = agent.headers(rows.slug, body, ts=signed_time(frozen_clock.now()))
    entry = {"desk_id": rows.desk_id, "event": {"kind": "rate_limit", "origin": "kernel", "session_id": row.session_id,
                                                "summary": {"route": "a2a", "limit": "turns"}}}
    response = await client.post("/ledger/append", headers=headers, json=entry)
    assert response.status_code == 200, response.text
    assert (response.json()["event"]["origin"], response.json()["event"]["session_id"]) == ("api", row.session_id)
    for refused in ({}, agent.headers(rows.slug, a2a_body(rows.slug, "Other"), ts=signed_time(frozen_clock.now()),
                                      nonce=headers[NONCE_HEADER])):
        assert (await client.post("/ledger/append", headers=refused, json=entry)).status_code == 401
    nameless = {**entry, "event": {**entry["event"], "session_id": None}}
    assert (await client.post("/ledger/append", headers=headers, json=nameless)).status_code == 401

    # a visitor mints one too; that session can name the agent sessions its keys open
    visitor = await open_visitor(client, rows)
    minted_by_visitor = await mint(client, visitor.headers, rows.desk_id)
    [key] = await rows_of(app, rows.copy_id, select(AgentKey).where(
        AgentKey.agent_key_id == minted_by_visitor.key_id))
    assert key.minted_by == visitor.session_id
    entry = [e for e in await ledger_rows(app, rows) if e.event.kind == "agent_auth"][-1]
    assert (entry.event.session_id, entry.event.summary["minted_by"]) == (visitor.session_id, "session")
    theirs = await open_agent(client, rows.slug, minted_by_visitor, frozen_clock, mandate=False)
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        assert await agents.minted_sessions(ctx, visitor.session_id) == [theirs.state.session_id]
        assert await agents.minted_sessions(ctx, row.session_id) == []


async def wallet_signed(app, copy_id: str, mandate: Mandate, **changes) -> dict:
    """`mandate` with `changes`, signed again by the copy's own demo wallet, as JSON."""
    [wallet] = await rows_of(app, copy_id, select(DemoWalletKey))
    fields = mandate.model_dump(mode="json", exclude={"sig"}) | changes
    return fields | {"sig": sign(wallet.private_key_hex, fields)}


@pytest.mark.parametrize("case", ["another_desk", "expired", "nonce_reused", "agent_key_id_mismatch",
                                  "untrusted_signer", "total_cents_edited", "another_issuer", "limits_out_of_range"])
async def test_mandate_checks(app, client, registry, frozen_clock, case):
    rows = await make_copy_rows(app)
    agent = await mint(client, rows.owner, rows.desk_id)
    mandate = agent.issued.mandate
    presented = mandate.model_dump(mode="json")
    reason = {"another_desk": "mandate_audience", "expired": "mandate_expired", "nonce_reused": "mandate_reused",
              "agent_key_id_mismatch": "mandate_key", "untrusted_signer": "mandate_signature",
              "total_cents_edited": "mandate_signature", "another_issuer": "mandate_issuer",
              "limits_out_of_range": "mandate_limits"}[case]
    sessions_before = 0
    if case == "another_desk":                  # the wallet's own signature, for another Desk of the copy
        presented = await wallet_signed(app, rows.copy_id, mandate, desk_id=await add_desk(app, rows, [], []))
    elif case == "expired":                     # an hour on, with a fresh signature over a fresh timestamp
        frozen_clock.advance(3600)
    elif case == "nonce_reused":                # a mandate opens one session
        await open_agent(client, rows.slug, agent, frozen_clock)
        sessions_before = 1
    elif case == "agent_key_id_mismatch":       # another agent's mandate, as its wallet signed it
        presented = (await mint(client, rows.owner, rows.desk_id)).issued.mandate.model_dump(mode="json")
    elif case == "untrusted_signer":            # well formed, but signed by a key that isn't the copy's wallet
        fields = mandate.model_dump(mode="json", exclude={"sig"})
        presented = fields | {"sig": sign(Ed25519PrivateKey.generate().private_bytes_raw().hex(), fields)}
    elif case == "another_issuer":              # the wallet's own signature over an issuer the copy doesn't trust
        presented = await wallet_signed(app, rows.copy_id, mandate, issuer="another-wallet")
    elif case == "limits_out_of_range":         # the wallet's own signature over a charge above the mandate's total
        presented = await wallet_signed(app, rows.copy_id, mandate, per_charge_cents=20_000, total_cents=10_000)
    else:                                       # the limit raised after the wallet signed
        presented = presented | {"total_cents": 1_000_000}
    body = a2a_body(rows.slug, message=f"Pay the deposit ({case})")
    response = await post_open(client, rows.slug, agent.headers(rows.slug, body, ts=signed_time(frozen_clock.now())),
                               presented)
    assert (response.status_code, response.json()) == (401, {"code": "auth"})
    assert len(await agent_sessions(app, rows.copy_id)) == sessions_before
    assert len(await rows_of(app, rows.copy_id, select(MandateRow))) == sessions_before
    assert refusals(await ledger_rows(app, rows)) == [("agent_auth", reason, agent.key_id)]


async def test_demo_mandate_is_signed_over_its_own_fields(app, monkeypatch):
    """The wallet signs what `verify_mandate` checks, every field of the mandate but its signature,
    so a field the contract gains later, with a default, is signed too."""
    rows = await make_copy_rows(app)

    class MandateWithALaterField(Mandate):
        note: str | None = "a field added later"

    monkeypatch.setattr(agents, "Mandate", MandateWithALaterField)
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        issued = await agents.issue_demo_agent(ctx, rows.desk_id, "owner", route="POST /agents/demo")
        assert agents.mandate_fields(issued.mandate)["note"] == "a field added later"
        await agents.verify_mandate(ctx, rows.desk_id, issued.agent_key_id, issued.mandate, route="POST /sessions",
                                    named=Named(copy_id=rows.copy_id, desk_id=rows.desk_id))


@dataclass(frozen=True)
class SignedTurn:
    """One A2A turn of an agent session: what the test_decide and test_execute helpers call `visitor`."""

    session_id: str
    headers: dict[str, str]


def turn(agent: Agent, slug: str, session_id: str, frozen_clock, message: str = "Quote a drain clearing, please.",
         *, nonce: str | None = None) -> SignedTurn:
    body = a2a_body(slug, message, session_id=session_id)
    return SignedTurn(session_id, agent.headers(slug, body, ts=signed_time(frozen_clock.now()), nonce=nonce))


async def agent_on_rivera(app, client, frozen_clock) -> tuple[Rivera, Agent, SessionCreated]:
    """A Turner Plumbing copy and a demo agent its owner minted, in a session with its mandate."""
    copy = await rivera(app, client)
    agent = await mint(client, copy.owner, copy.desk_id)
    return copy, agent, await open_agent(client, copy.slug, agent, frozen_clock)


async def test_unsigned_agent_calls_are_refused(app, client, frozen_clock):
    copy, agent, created = await agent_on_rivera(app, client, frozen_clock)
    session_id = created.state.session_id
    signed = turn(agent, copy.slug, session_id, frozen_clock)
    decision = await decided(client, signed, "native.quote", quote_args(("drain", 1)))
    assert decision.outcome == "allow", decision.reason_plain
    visitor = await open_visitor(client, copy)
    before = len(await ledger_rows(app, copy))
    calls = {
        "GET /context/{session_id}": lambda headers: client.get(f"/context/{session_id}", headers=headers),
        "POST /decide": lambda headers: post_decide(client, SignedTurn(session_id, headers), "native.quote",
                                                    quote_args(("leak", 1)), call_id="call-unsigned"),
        "POST /execute": lambda headers: post_execute(client, signed, decision, headers=headers),
        "POST /check_reply": lambda headers: client.post("/check_reply", headers=headers, json={
            "draft": {"session_id": session_id, "generation": 0, "prose": "I can help with that.", "clauses": []}}),
    }
    # no credential, and a visitor's token naming the agent's session: an agent session has no token,
    # so a call naming it with no credential at all is an agent call with no signature (`agent_auth`)
    for headers in ({}, visitor.headers):
        for route, call in calls.items():
            response = await call(headers)
            assert (response.status_code, response.json()) == (401, {"code": "auth"}), (route, headers)
    entries = (await ledger_rows(app, copy))[before:]
    assert [(e.event.kind, e.event.session_id, e.event.summary) for e in entries] == [
        ("agent_auth", session_id, {"route": route, "reason": "unsigned"}) for route in calls
    ] + [("auth", session_id, {"route": route, "reason": "bad_token"}) for route in calls]
    # nothing ran: one decision, not executed, and no reply checked
    assert [row.decision_id for row in await rows_of(app, copy.copy_id, select(DecisionRow).where(
        DecisionRow.session_id == session_id))] == [decision.decision_id]
    assert await executions_of(app, copy.copy_id) == []
    assert not [e for e in entries if e.event.kind == "reply"]
    # the agent's own signature on its turn runs them
    assert (await executed(client, signed, decision)).state == "succeeded"
    assert (await client.get(f"/context/{session_id}", headers=signed.headers)).status_code == 200


async def test_signed_request_for_another_agents_session_is_refused(app, client, frozen_clock):
    copy, agent_a, created_a = await agent_on_rivera(app, client, frozen_clock)
    agent_b = await mint(client, copy.owner, copy.desk_id)
    await open_agent(client, copy.slug, agent_b, frozen_clock)
    session_a = created_a.state.session_id
    before = len(await ledger_rows(app, copy))
    # agent B signs its own turn validly, but names agent A's session
    as_b = turn(agent_b, copy.slug, session_a, frozen_clock)
    responses = [
        await client.get("/whoami", params={"session_id": session_a}, headers=as_b.headers),
        await client.get(f"/context/{session_a}", headers=as_b.headers),
        await post_decide(client, as_b, "native.quote", quote_args(("drain", 1))),
        await client.post("/check_reply", headers=as_b.headers, json={
            "draft": {"session_id": session_a, "generation": 0, "prose": "I can help with that.", "clauses": []}}),
    ]
    assert [(r.status_code, r.json()) for r in responses] == [(401, {"code": "auth"})] * 4
    entries = (await ledger_rows(app, copy))[before:]
    assert [(e.event.kind, e.event.session_id, e.event.summary["reason"], e.event.summary["agent_key_id"])
            for e in entries] == [("agent_auth", session_a, "wrong_key", agent_b.key_id)] * 4
    assert await rows_of(app, copy.copy_id, select(DecisionRow).where(DecisionRow.session_id == session_a)) == []
    # agent A's own signature is still its session's credential
    as_a = turn(agent_a, copy.slug, session_a, frozen_clock)
    assert (await decided(client, as_a, "native.quote", quote_args(("drain", 1)))).outcome == "allow"


async def whoami_as(client: httpx.AsyncClient, signed: SignedTurn) -> httpx.Response:
    return await client.get("/whoami", params={"session_id": signed.session_id}, headers=signed.headers)


async def check_as(client: httpx.AsyncClient, signed: SignedTurn, prose: str, *,
                   final: bool | None = None) -> httpx.Response:
    """The turn's `/check_reply`, with `final` as given, or without it."""
    body = {"draft": {"session_id": signed.session_id, "generation": 0, "prose": prose, "clauses": []}}
    if final is not None:
        body["final"] = final
    return await client.post("/check_reply", headers=signed.headers, json=body)


async def test_nonce_rules(app, client, frozen_clock):
    copy, agent, created = await agent_on_rivera(app, client, frozen_clock)
    session_id = created.state.session_id
    other = (await open_agent(client, copy.slug, agent, frozen_clock, mandate=False)).state.session_id
    # one turn: the same session and body hash may repeat its nonce on every call of the turn
    signed = turn(agent, copy.slug, session_id, frozen_clock)
    nonce = signed.headers[NONCE_HEADER]
    for _ in range(2):
        assert (await whoami_as(client, signed)).status_code == 200
    assert (await client.get(f"/context/{session_id}", headers=signed.headers)).status_code == 200
    ts = signed.headers[TS_HEADER]
    # the same nonce over another body, or for another session of the same key: 401
    other_body = agent.headers(copy.slug, a2a_body(copy.slug, "Something else", session_id=session_id),
                               ts=ts, nonce=nonce)
    other_session = agent.headers(copy.slug, a2a_body(copy.slug, "Quote a drain clearing, please.",
                                                      session_id=session_id), ts=ts, nonce=nonce)
    responses = [await whoami_as(client, SignedTurn(session_id, other_body)),
                 await whoami_as(client, SignedTurn(other, other_session))]
    assert [(r.status_code, r.json()) for r in responses] == [(401, {"code": "auth"})] * 2
    # a passing verdict ends the turn: the same call again is a replay
    assert (await check_as(client, signed, "I can help with that.")).json()["ok"] is True
    replayed = await whoami_as(client, signed)
    assert (replayed.status_code, replayed.json()) == (409, {"code": "replayed"})
    # so does a canary, which hands off at once
    canary = (await rows_of(app, copy.copy_id, select(Document)))[0].canary
    handoff = turn(agent, copy.slug, session_id, frozen_clock, "What's on my invoice?")
    verdict = (await check_as(client, handoff, f"Your reference is {canary}.")).json()
    assert (verdict["ok"], [v["kind"] for v in verdict["violations"]]) == (False, ["canary"])
    replayed = await whoami_as(client, handoff)
    assert (replayed.status_code, replayed.json()) == (409, {"code": "replayed"})
    # and so do five minutes: six minutes on, the same nonce and body, freshly signed, are spent
    late = turn(agent, copy.slug, session_id, frozen_clock, "Is Saturday open?")
    assert (await whoami_as(client, late)).status_code == 200
    frozen_clock.advance(360)
    body = a2a_body(copy.slug, "Is Saturday open?", session_id=session_id)
    again = SignedTurn(session_id, agent.headers(copy.slug, body, ts=signed_time(frozen_clock.now()),
                                                 nonce=late.headers[NONCE_HEADER]))
    replayed = await whoami_as(client, again)
    assert (replayed.status_code, replayed.json()) == (409, {"code": "replayed"})
    entries = [e for e in await ledger_rows(app, copy) if e.event.kind == "agent_auth" and "reason" in e.event.summary]
    assert [(e.event.session_id, e.event.summary["reason"]) for e in entries] == [
        (session_id, "nonce_reused"), (other, "nonce_reused"), (session_id, "replayed"), (session_id, "replayed"),
        (session_id, "replayed")]


@pytest.mark.parametrize("when", ["during_the_turn", "after_a_passing_verdict", "after_an_immediate_handoff"])
async def test_resent_opening_request_recovers_its_session(app, client, frozen_clock, when):
    copy = await rivera(app, client)
    agent = await mint(client, copy.owner, copy.desk_id)
    body = a2a_body(copy.slug)
    headers = agent.headers(copy.slug, body, ts=signed_time(frozen_clock.now()))
    mandate = agent.issued.mandate.model_dump(mode="json")
    response = await post_open(client, copy.slug, headers, mandate)
    assert response.status_code == 200, response.text
    created = SessionCreated.model_validate(response.json())
    opening = SignedTurn(created.state.session_id, headers)
    if when == "after_a_passing_verdict":
        assert (await check_as(client, opening, "I can help with that.")).json()["ok"] is True
    elif when == "after_an_immediate_handoff":
        verdict = (await check_as(client, opening, "Je peux vous aider avec ça.")).json()
        assert [v["kind"] for v in verdict["violations"]] == ["unsupported_language"]
    if when != "during_the_turn":
        assert (await whoami_as(client, opening)).json() == {"code": "replayed"}     # the turn is over
    # the API lost the answer and sends the opening request again: the session it opened, nothing new
    frozen_clock.advance(30)
    resent = await post_open(client, copy.slug, headers, mandate)
    assert resent.status_code == 200, resent.text
    assert SessionCreated.model_validate(resent.json()) == created
    assert [row.session_id for row in await agent_sessions(app, copy.copy_id)] == [created.state.session_id]
    assert len(await rows_of(app, copy.copy_id, select(MandateRow))) == 1         # the mandate isn't spent again
    [entry] = [e for e in await ledger_rows(app, copy) if e.event.summary.get("resent_opening")]
    assert (entry.event.kind, entry.event.session_id, entry.event.summary) == (
        "agent_auth", created.state.session_id, {"agent_key_id": agent.key_id, "resent_opening": True})
    # the same nonce over another opening body is no resend
    other = agent.headers(copy.slug, a2a_body(copy.slug, "Another opening"), ts=signed_time(frozen_clock.now()),
                          nonce=headers[NONCE_HEADER])
    assert (await post_open(client, copy.slug, other, mandate)).json() == {"code": "auth"}


@pytest.mark.parametrize("final", [True, False], ids=["final", "first-attempt"])
async def test_a_blocked_check_sent_as_final_ends_the_turn(app, client, frozen_clock, final):
    """A blocked check the API says is final (`final: true`, its last attempt, whose handoff it
    shows) is the turn's answer, so it ends the turn: the same nonce is then replayed. One it says
    isn't, blocked only for what a rewrite can fix, leaves the turn open for the rewrite."""
    copy, agent, created = await agent_on_rivera(app, client, frozen_clock)
    signed = turn(agent, copy.slug, created.state.session_id, frozen_clock)
    verdict = ReplyVerdict.model_validate((await check_as(client, signed, "It comes to 180 dollars.",
                                                          final=final)).json())
    assert (verdict.ok, {v.kind for v in verdict.violations}) == (False, {"number_in_prose"})
    response = await whoami_as(client, signed)
    if final:
        assert (response.status_code, response.json()) == (409, {"code": "replayed"})
    else:
        assert response.status_code == 200, response.text
        assert (await check_as(client, signed, "I can help with that.", final=True)).json()["ok"] is True
    [row] = [row for row in await rows_of(app, copy.copy_id, select(AgentNonce))
             if row.nonce == signed.headers[NONCE_HEADER]]
    assert row.spent_at == frozen_clock.now()


async def test_regenerate_after_a_violation_uses_the_same_nonce(app, client, frozen_clock):
    copy, agent, created = await agent_on_rivera(app, client, frozen_clock)
    signed = turn(agent, copy.slug, created.state.session_id, frozen_clock)
    first = ReplyVerdict.model_validate((await check_as(client, signed, "It comes to 180 dollars.")).json())
    assert (first.ok, {v.kind for v in first.violations}) == (False, {"number_in_prose"})   # not an immediate handoff
    # Claude regenerates once, on the same turn and nonce: the second verdict is what is shown
    second = ReplyVerdict.model_validate((await check_as(client, signed, "I can help with that.")).json())
    assert second.ok and [block.text for block in second.blocks] == ["I can help with that."]
    assert second.message_id != first.message_id
    third = await check_as(client, signed, "I can help with that too.")
    assert (third.status_code, third.json()) == (409, {"code": "replayed"})
    # the turn's second check ends it even when it fails too
    again = turn(agent, copy.slug, created.state.session_id, frozen_clock, "And the price?")
    for _ in range(2):
        assert (await check_as(client, again, "It comes to 180 dollars.")).json()["ok"] is False
    assert (await check_as(client, again, "I can help with that.")).json() == {"code": "replayed"}
    nonces = {row.nonce: row for row in await rows_of(app, copy.copy_id, select(AgentNonce))}
    for headers in (signed.headers, again.headers):
        row = nonces[headers[NONCE_HEADER]]
        assert (row.session_id, row.check_replies, row.spent_at) == (
            created.state.session_id, 2, frozen_clock.now())
    assert [e.event.summary["ok"] for e in await ledger_rows(app, copy) if e.event.kind == "reply"] == [
        False, True, False, False]


async def test_demo_agent_rate_limit(app, client, frozen_clock):
    rows = await make_copy_rows(app)
    visitor = await open_visitor(client, rows)
    for minted in range(agents.DEMO_AGENTS_PER_COPY_PER_HOUR):
        await mint(client, rows.owner if minted % 2 else visitor.headers, rows.desk_id)
        frozen_clock.advance(60)
    # the copy's eleventh within the hour, by the owner or the visitor: 429, ledgered, nothing minted
    for headers, session_id in ((rows.owner, None), (visitor.headers, visitor.session_id)):
        response = await client.post("/agents/demo", headers=headers, json={"desk_id": rows.desk_id})
        assert (response.status_code, response.json()) == (429, {"code": "rate_limited"})
        entry = (await ledger_rows(app, rows))[-1]
        assert (entry.event.kind, entry.event.session_id, entry.event.summary) == ("rate_limit", session_id, {
            "route": "POST /agents/demo", "limit": "demo_agents_per_copy_per_hour", "max": 10})
    assert len(await rows_of(app, rows.copy_id, select(AgentKey))) == 10
    # an hour after the first, there is room for one more
    frozen_clock.advance(3600 - 10 * 60 + 1)
    await mint(client, rows.owner, rows.desk_id)
    assert (await client.post("/agents/demo", headers=rows.owner, json={"desk_id": rows.desk_id})).status_code == 429


async def test_session_cannot_mint_for_another_desk(app, client, frozen_clock):
    rows, elsewhere = await make_copy_rows(app), await make_copy_rows(app)
    second_desk = await add_desk(app, rows, [], [])
    visitor = await open_visitor(client, rows)
    before = len(await ledger_rows(app, rows))
    # a visitor on one Desk mints for no other: another copy's Desk, or the copy's second Desk
    for desk_id in (elsewhere.desk_id, second_desk):
        response = await client.post("/agents/demo", headers=visitor.headers, json={"desk_id": desk_id})
        assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    assert [(e.event.kind, e.event.session_id, e.event.summary) for e in (await ledger_rows(app, rows))[before:]] == [
        ("auth", visitor.session_id, {"route": "POST /agents/demo", "reason": "wrong_copy"})] * 2
    # nor does an owner for another copy's Desk, a request with no credential or with two, or an agent
    agent = await mint(client, elsewhere.owner, elsewhere.desk_id)
    signed = agent.headers(elsewhere.slug, a2a_body(elsewhere.slug), ts=signed_time(frozen_clock.now()))
    for headers, status in ((rows.owner, 404), ({}, 401), (rows.owner | visitor.headers, 401), (signed, 401),
                            (visitor.headers | signed, 401)):
        response = await client.post("/agents/demo", headers=headers, json={"desk_id": elsewhere.desk_id})
        assert response.status_code == status, (headers.keys(), response.text)
    assert await rows_of(app, rows.copy_id, select(AgentKey)) == []
    assert [key.agent_key_id for key in await rows_of(app, elsewhere.copy_id, select(AgentKey))] == [agent.key_id]
    # its own Desk, once deleted, mints nothing either
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        desk = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == rows.desk_id)))).one()
        desk.deleted_at = frozen_clock.now()
    for headers in (visitor.headers, rows.owner):
        response = await client.post("/agents/demo", headers=headers, json={"desk_id": rows.desk_id})
        assert (response.status_code, response.json()) == (409, {"code": "closed"})
    assert await rows_of(app, rows.copy_id, select(AgentKey)) == []


async def verify_as(client: httpx.AsyncClient, signed: SignedTurn, step: str, **fields) -> httpx.Response:
    """`POST /verify/start` or `/verify/check` for the agent session, on its signed turn."""
    return await client.post(f"/verify/{step}", headers=signed.headers,
                             json={"session_id": signed.session_id, **fields})


async def inbox_of(client: httpx.AsyncClient, session_id: str, headers: dict[str, str]) -> list[DemoInboxEntry]:
    response = await client.get("/demo_inbox", params={"session_id": session_id}, headers=headers)
    assert response.status_code == 200, response.text
    return [DemoInboxEntry.model_validate(entry) for entry in response.json()]


async def test_minting_session_reads_its_agents_codes(app, client, frozen_clock):
    copy = await rivera_copy(app, client)
    desk_id = copy.rivera.desk_id
    minter, other = await open_visitor(client, copy), await open_visitor(client, copy)
    agent = await mint(client, minter.headers, desk_id)
    session_id = (await open_agent(client, copy.slug, agent, frozen_clock)).state.session_id
    # the agent asks, on its own signed turn, to verify as Dana
    signed = turn(agent, copy.slug, session_id, frozen_clock, f"I'm Dana Whitfield, my number is {DANA_PHONE}.")
    response = await verify_as(client, signed, "start", contact=DANA_PHONE)
    assert response.status_code == 200, response.text
    [notice] = VerifyStarted.model_validate(response.json()).inbox
    # the visitor who minted the agent reads its code, as if it had typed Dana's contact itself
    [entry] = await inbox_of(client, minter.session_id, minter.headers)
    assert (entry.entry_id, entry.kind, entry.to) == (notice.entry_id, "verification_code", mask_contact(DANA_PHONE))
    assert await inbox_of(client, other.session_id, other.headers) == []
    # the codes of agents another session or the owner minted are not the minter's: Bob's stays out
    for minted_by in (other.headers, copy.owner):
        theirs = await mint(client, minted_by, desk_id)
        their_session = (await open_agent(client, copy.slug, theirs, frozen_clock, mandate=False)).state.session_id
        bob = turn(theirs, copy.slug, their_session, frozen_clock, "I'm Bob.")
        assert (await verify_as(client, bob, "start", contact="bob@example.com")).status_code == 200
    assert [e.entry_id for e in await inbox_of(client, minter.session_id, minter.headers)] == [notice.entry_id]
    assert {e.to for e in await inbox_of(client, other.session_id, other.headers)} == {"b•••@example.com"}
    # the agent types the code back on the same turn: its session is now Dana's, at demo assurance
    response = await verify_as(client, signed, "check", code=code_in(entry))
    assert response.status_code == 200, response.text
    state = SessionState.model_validate(response.json())
    assert (state.session_id, state.kind, state.verified, state.assurance) == (session_id, "agent", True, "demo_code")
    [row] = await rows_of(app, copy.copy_id, select(ActorSession).where(ActorSession.session_id == session_id))
    assert row.person_id == copy.people["dana"]


async def verify_calls(client: httpx.AsyncClient, session_id: str, headers: dict[str, str]) -> list[httpx.Response]:
    """The three verify routes for the session `session_id`, called with `headers`."""
    body = {"session_id": session_id}
    return [await client.post("/verify/start", headers=headers, json={**body, "contact": DANA_PHONE}),
            await client.post("/verify/check", headers=headers, json={**body, "code": "000000"}),
            await client.get("/demo_inbox", params=body, headers=headers)]


async def test_verify_routes_accept_agent_sessions(app, client, frozen_clock, monkeypatch):
    copy = await rivera_copy(app, client)
    agent, intruder = [await mint(client, copy.owner, copy.rivera.desk_id) for _ in range(2)]
    session_id = (await open_agent(client, copy.slug, agent, frozen_clock)).state.session_id
    await open_agent(client, copy.slug, intruder, frozen_clock, mandate=False)
    visitor = await open_visitor(client, copy)
    before = len(await ledger_rows(app, copy.rivera))
    # an agent session has no token: no credential, a visitor's or the owner's token, or another
    # agent's valid signature naming the session is refused, ledgered, and starts nothing
    as_intruder = turn(intruder, copy.slug, session_id, frozen_clock)
    for headers in ({}, visitor.headers, copy.owner, as_intruder.headers):
        for response in await verify_calls(client, session_id, headers):
            assert (response.status_code, response.json()) == (401, {"code": "auth"}), headers.keys()
    routes = ["POST /verify/start", "POST /verify/check", "GET /demo_inbox"]
    entries = (await ledger_rows(app, copy.rivera))[before:]
    assert [(e.event.kind, e.event.session_id, e.event.summary["route"], e.event.summary["reason"],
             e.event.summary.get("agent_key_id")) for e in entries] == [
        *(("agent_auth", session_id, route, "unsigned", None) for route in routes),
        *(("auth", session_id, route, "bad_token", None) for route in routes * 2),
        *(("agent_auth", session_id, route, "wrong_key", intruder.key_id) for route in routes)]
    assert await rows_of(app, copy.copy_id, select(VerificationChallenge)) == []
    # its own signature, on one turn: it starts, reads its own code, gets the one 422 for a wrong
    # code, and verifies as Dana
    codes(monkeypatch, 111111)
    signed = turn(agent, copy.slug, session_id, frozen_clock, f"My number is {DANA_PHONE}.")
    response = await verify_as(client, signed, "start", contact=DANA_PHONE)
    assert response.status_code == 200, response.text
    [notice] = VerifyStarted.model_validate(response.json()).inbox
    [entry] = await inbox_of(client, session_id, signed.headers)
    assert (entry.entry_id, code_in(entry)) == (notice.entry_id, "111111")
    wrong = await verify_as(client, signed, "check", code="000000")
    assert (wrong.status_code, wrong.json()) == (422, {"code": "invalid"})
    response = await verify_as(client, signed, "check", code="111111")
    assert response.status_code == 200, response.text
    assert SessionState.model_validate(response.json()).verified
    [challenge] = await rows_of(app, copy.copy_id, select(VerificationChallenge))
    assert (challenge.session_id, challenge.person_id, challenge.status) == (
        session_id, copy.people["dana"], "consumed")
    assert [(e.event.session_id, e.event.summary["outcome"]) for e in await ledger_rows(app, copy.rivera)
            if e.event.kind == "verify"] == [(session_id, "started"), (session_id, "wrong_code"),
                                             (session_id, "verified")]
    # once a passing verdict ends the turn, its calls are replays: 409, ledgered, nothing run
    assert (await check_as(client, signed, "I can help with that.")).json()["ok"] is True
    before = len(await ledger_rows(app, copy.rivera))
    for response in await verify_calls(client, session_id, signed.headers):
        assert (response.status_code, response.json()) == (409, {"code": "replayed"})
    assert [(e.event.kind, e.event.summary["route"], e.event.summary["reason"])
            for e in (await ledger_rows(app, copy.rivera))[before:]] == [
        ("agent_auth", route, "replayed") for route in routes]


AGENT_TOOL_LABELS = {   # Turner Plumbing's agent tools today, by the plain label the card gives each
    "en": ["get a quote from the price list", "find open times", "book a visit"],
    "es": ["pedir una cotización de la lista de precios", "buscar horarios libres", "reservar una visita"],
}


async def test_public_agent_card_is_kernel_rendered(app, client, frozen_clock):
    copy, agent, created = await agent_on_rivera(app, client, frozen_clock)
    [wallet] = await rows_of(app, copy.copy_id, select(DemoWalletKey))
    [key] = await rows_of(app, copy.copy_id, select(AgentKey))
    canaries = [row.canary for row in await rows_of(app, copy.copy_id, select(Document))]
    for lang, disclosure in (("en", "an AI"), ("es", "una IA")):
        response = await client.get(f"/public/{copy.slug}", params={"lang": lang})
        assert response.status_code == 200, response.text
        card = PublicDesk.model_validate(response.json()).agent_card
        # prose blocks the kernel writes from its own templates: no clause, template or fact behind them
        assert card and all((b.kind, b.template, b.fact_id, b.title, b.lines, b.href, b.options) == (
            "prose", None, None, None, [], None, []) for b in card)
        text = "\n".join(block.text for block in card)
        for expected in (*AGENT_TOOL_LABELS[lang], copy.slug, f"/api/a2a/{copy.slug}", "X-Agent-Key-Id",
                         "X-Agent-Ts", "X-Agent-Nonce", "X-Agent-Sig", "desk_slug, ts, nonce", "body_sha256",
                         "Ed25519", "RFC 8785", "5 minut", disclosure, "Claude", "Mike Turner"):
            assert expected in text, (lang, expected)
        assert ("not business credentials" if lang == "en" else "No son credenciales del negocio") in text
        # no amount, key, mandate or private field
        for private in ("$", "20.00", "100", "2000", "10000", "Dana", "Bob", "example.com", "510", "Invoice",
                        wallet.public_key_hex, key.public_key_hex, agent.key_id, agent.issued.agent_private_key_hex,
                        agent.issued.mandate.mandate_id, agent.issued.mandate.nonce, created.state.session_id,
                        copy.copy_id, copy.desk_id, "native.", "payments.", *canaries):
            assert private not in text, (lang, private)
    # the card lists only what an agent can do on this Desk now: a tool turned off drops out
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        tool = (await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(Tool.tool == "native.book")))).one()
        tool.status = "disabled"
    text = "\n".join(b.text for b in PublicDesk.model_validate((await client.get(f"/public/{copy.slug}")).json()).agent_card)
    assert "find open times" in text and "book a visit" not in text


@pytest.mark.parametrize("kind", ["canary", "unsupported_language", "session_paused", "check_unavailable",
                                  "uncertain_language"])
# A soft-check outage is rewritten too (the owner's ruling of 2026-11-01), so its turn goes on.
async def test_nonfinal_reply_kinds_end_only_unrecoverable_agent_turns(app, client, frozen_clock, reviewer, kind):
    copy, agent, created = await agent_on_rivera(app, client, frozen_clock)
    signed = turn(agent, copy.slug, created.state.session_id, frozen_clock)
    prose = "I can help with that."
    if kind == "canary":
        canary = (await rows_of(app, copy.copy_id, select(Document)))[0].canary
        prose = f"Your reference is {canary}."
    elif kind == "unsupported_language":
        prose = "Je peux vous aider avec ça."
    elif kind == "uncertain_language":
        prose = "Absolutely. Payment link below."
    elif kind == "check_unavailable":
        reviewer.soft_answer = None
    else:
        await set_session(app, copy, created.state.session_id, mode="paused")
    response = await check_as(client, signed, prose, final=False)
    assert response.status_code == 200, response.text
    verdict = ReplyVerdict.model_validate(response.json())
    assert {v.kind for v in verdict.violations} == {kind}
    response = await whoami_as(client, signed)
    rewritable = kind in ("uncertain_language", "check_unavailable")
    assert response.status_code == (200 if rewritable else 409), response.text
    if rewritable:
        assert verdict.blocks == []
    else:
        assert response.json() == {"code": "replayed"}
