"""Sessions: hashed tokens, the session-state checks, /whoami and the owner's take-over."""

import hashlib
import logging
from datetime import timedelta

import psycopg
import pytest
from fastapi import FastAPI, Request
from sqlalchemy import select

from desk.contracts import Principal
from desk.db.models import ActorSession, Desk
from desk.db.session import database_url, libpq_url
from desk.kernel_service import auth, repo, sessions
from desk.kernel_service.repo import Ctx

from .helpers import kernel_ctx, ledger_rows, make_copy_rows, rows_of


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def stored_text(copy_id: str) -> str:
    """Every kernel row of a copy that could hold a token, as text (read as desk_admin)."""
    with psycopg.connect(libpq_url(database_url("ADMIN"))) as admin:
        rows = admin.execute(
            "SELECT row_to_json(s)::text FROM kernel.sessions s WHERE copy_id = %s"
            " UNION ALL SELECT row_to_json(e)::text FROM kernel.ledger_entries e WHERE copy_id = %s"
            " UNION ALL SELECT row_to_json(h)::text FROM kernel.ledger_heads h WHERE copy_id = %s",
            (copy_id, copy_id, copy_id)).fetchall()
    return "\n".join(text for (text,) in rows)


PROBE = "POST /test/sessions/{session_id}"
MODE = "POST /sessions/{id}/mode"


def add_session_probe(app: FastAPI) -> None:
    """A route that only authenticates the session it names, as every session route does first."""

    @app.post("/test/sessions/{session_id}")
    async def probe(session_id: str, ctx: Ctx, request: Request, generation: int | None = None,
                    desk_id: str | None = None) -> dict:
        row = await auth.require_session(ctx, request, session_id, generation=generation, desk_id=desk_id)
        return {"session_id": row.session_id}


async def update_row(app, copy_id: str, key_column, key: str, **values) -> None:
    """Set columns of the committed kernel row whose `key_column` is `key`, as a later task's writer would."""
    async with kernel_ctx(app) as ctx:
        copy = ctx.bind(copy_id)
        [row] = (await ctx.db.scalars(copy.scoped(select(key_column.class_).where(key_column == key)))).all()
        for name, value in values.items():
            setattr(row, name, value)


async def open_session(client, slug: str) -> dict:
    response = await client.post("/sessions", json={"desk_slug": slug, "kind": "visitor"})
    assert response.status_code == 200, response.text
    return response.json()


async def set_mode(client, rows, session_id: str, mode: str, generation: int):
    """The owner of `rows`' copy sets a session's mode."""
    return await client.post(f"/sessions/{session_id}/mode", json={"mode": mode, "generation": generation},
                             headers=rows.owner)


async def test_visitor_session_is_created_with_a_hashed_token(app, client):
    rows = await make_copy_rows(app)
    created = await open_session(client, rows.slug)
    state, token = created["state"], created["session_token"]
    assert {k: state[k] for k in ("kind", "verified", "assurance", "mode", "generation")} == {
        "kind": "visitor", "verified": False, "assurance": "none", "mode": "ai", "generation": 0}
    assert len(token) >= 43                                                    # 256 bits, URL-safe
    [row] = await rows_of(app, rows.copy_id, select(ActorSession).where(ActorSession.session_id == state["session_id"]))
    assert (row.desk_id, row.kind, row.secret_hash) == (rows.desk_id, "visitor", sha256(token))
    assert row.created_at == row.last_seen_at == app.state.kernel.clock.now()  # the kernel's clock, not now()
    assert token not in stored_text(rows.copy_id)                              # only its hash is kept
    [entry] = await ledger_rows(app, rows)
    assert (entry.event.kind, entry.event.origin, entry.event.session_id) == ("session", "kernel", state["session_id"])
    assert entry.event.summary == {"session_id": state["session_id"], "kind": "visitor"}


async def test_unknown_slug_is_404(app, client):
    await make_copy_rows(app)
    response = await client.post("/sessions", json={"desk_slug": "turner-plumbing-zzzzzz", "kind": "visitor"})
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})


async def test_agent_sessions_need_agent_auth(app, client):
    rows = await make_copy_rows(app)
    response = await client.post("/sessions", json={"desk_slug": rows.slug, "kind": "agent"})
    assert (response.status_code, response.json()) == (401, {"code": "auth"})   # unsigned (tests/kernel/test_agent_auth.py)
    # an owner's preview session needs its owner check (Plan 01b): refused until then, the same way
    response = await client.post("/sessions", json={"desk_slug": rows.slug, "kind": "visitor", "preview": True})
    assert (response.status_code, response.json()) == (401, {"code": "auth"})
    response = await client.post("/sessions", json={"desk_slug": rows.slug, "kind": "agent", "preview": True})
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    # only an agent presents a mandate
    mandate = {"mandate_id": "mandate-1", "issuer": "demo-wallet", "agent_key_id": "0" * 16, "desk_id": rows.desk_id,
               "allowed_effects": ["charge"], "per_charge_cents": 2_000, "total_cents": 10_000, "currency": "usd",
               "expires_at": "2026-10-30T18:04:05.123456Z", "nonce": "n" * 22, "sig": "0" * 128}
    response = await client.post("/sessions", json={"desk_slug": rows.slug, "kind": "visitor", "mandate": mandate})
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert await rows_of(app, rows.copy_id, select(ActorSession).where(ActorSession.desk_id == rows.desk_id)) == []
    entries = await ledger_rows(app, rows)                                         # ledgered on that Desk
    assert [(e.event.kind, e.event.session_id, e.event.summary) for e in entries] == [
        ("agent_auth", None, {"route": "POST /sessions", "reason": "unsigned"}),
        ("auth", None, {"route": "POST /sessions", "reason": "preview_unavailable"}),
    ]


async def test_wrong_token_is_401_and_ledgered(app, client):
    add_session_probe(app)
    a_rows, b_rows = await make_copy_rows(app), await make_copy_rows(app)
    a, neighbour = await open_session(client, a_rows.slug), await open_session(client, a_rows.slug)
    b = await open_session(client, b_rows.slug)
    a_id = a["state"]["session_id"]
    response = await client.post(f"/test/sessions/{a_id}", headers={"X-Session-Token": a["session_token"]})
    assert (response.status_code, response.json()) == (200, {"session_id": a_id})
    wrong = (b["session_token"],                       # a session of another copy
             neighbour["session_token"],               # another session on the same Desk
             a["session_token"][:-1])                  # a guess
    for headers in [{"X-Session-Token": token} for token in wrong] + [{}]:
        response = await client.post(f"/test/sessions/{a_id}", headers=headers)
        assert (response.status_code, response.json()) == (401, {"code": "auth"}), headers
    refusals = [entry.event for entry in await ledger_rows(app, a_rows) if entry.event.kind == "auth"]
    assert [(event.session_id, event.summary) for event in refusals] == [
        (a_id, {"route": PROBE, "reason": "bad_token"})] * 4                  # on A's Desk, naming A
    for token in wrong:
        assert token not in stored_text(a_rows.copy_id) and token not in stored_text(b_rows.copy_id)
    assert [entry.event.kind for entry in await ledger_rows(app, b_rows)] == ["session"]


async def test_a_call_without_one_credential_is_ledgered_on_the_session_it_names(app, client):
    rows = await make_copy_rows(app)
    visitor = await open_session(client, rows.slug)
    session_id, token = visitor["state"]["session_id"], visitor["session_token"]
    call = {"call_id": "call-1", "tool": "native.find_slots", "args": {}}
    calls = [   # each session call that takes either credential, naming the visitor's session
        ("POST /decide", "POST", "/decide", {"json": {"session_id": session_id, "generation": 0, "call": call}}),
        ("POST /execute", "POST", "/execute",
         {"json": {"decision_id": "dec-none", "session_id": session_id, "generation": 0}}),
        ("GET /context/{session_id}", "GET", f"/context/{session_id}", {}),
        ("GET /decisions/by_call", "GET", "/decisions/by_call",
         {"params": {"session_id": session_id, "generation": 0, "call_id": "call-1"}}),
    ]
    neither, both = {}, {"X-Session-Token": token, **rows.owner}
    for headers in (neither, both):
        for route, method, url, kwargs in calls:
            response = await client.request(method, url, headers=headers, **kwargs)
            assert (response.status_code, response.json()) == (401, {"code": "auth"}), (route, sorted(headers))
    refusals = [entry.event for entry in await ledger_rows(app, rows) if entry.event.kind == "auth"]
    assert [(event.session_id, event.summary) for event in refusals] == [
        (session_id, {"route": route, "reason": "bad_token"}) for _ in (neither, both) for route, *_ in calls]
    assert token not in stored_text(rows.copy_id) and rows.owner_token not in stored_text(rows.copy_id)


async def test_other_copy_is_404(app, client):
    add_session_probe(app)
    a_rows, b_rows = await make_copy_rows(app), await make_copy_rows(app)
    b = await open_session(client, b_rows.slug)
    b_id = b["state"]["session_id"]
    # copy A's owner takes over a copy B session
    response = await set_mode(client, a_rows, b_id, "owner", 0)
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    # a session named with a Desk that isn't its own
    response = await client.post(f"/test/sessions/{b_id}", params={"desk_id": a_rows.desk_id},
                                 headers={"X-Session-Token": b["session_token"]})
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    refusals = [entry.event for entry in await ledger_rows(app, b_rows) if entry.event.kind == "auth"]
    assert [(event.session_id, event.summary) for event in refusals] == [
        (b_id, {"route": MODE, "reason": "wrong_copy"}), (b_id, {"route": PROBE, "reason": "wrong_copy"})]
    assert await ledger_rows(app, a_rows) == []
    [row] = await rows_of(app, b_rows.copy_id, select(ActorSession).where(ActorSession.session_id == b_id))
    assert (row.mode, row.generation) == ("ai", 0)                           # nothing changed


async def test_closed_session_is_409(app, client, frozen_clock):
    add_session_probe(app)
    rows = await make_copy_rows(app)
    idle, closed = await open_session(client, rows.slug), await open_session(client, rows.slug)
    idle_id, closed_id = idle["state"]["session_id"], closed["state"]["session_id"]
    await update_row(app, rows.copy_id, ActorSession.session_id, closed_id, closed_at=frozen_clock.now())
    response = await client.post(f"/test/sessions/{closed_id}", headers={"X-Session-Token": closed["session_token"]})
    assert (response.status_code, response.json()) == (409, {"code": "closed"})
    for _ in range(2):                                                    # idle exactly 24 h: still open,
        frozen_clock.advance(timedelta(hours=24).total_seconds())         # and each call counts as activity
        response = await client.post(f"/test/sessions/{idle_id}", headers={"X-Session-Token": idle["session_token"]})
        assert response.status_code == 200
    frozen_clock.advance(timedelta(hours=24, seconds=1).total_seconds())
    response = await client.post(f"/test/sessions/{idle_id}", headers={"X-Session-Token": idle["session_token"]})
    assert (response.status_code, response.json()) == (409, {"code": "closed"})
    response = await client.post(f"/sessions/{idle_id}/mode", json={"mode": "owner", "generation": 0},
                                 headers=rows.owner)                       # the owner can't take over a closed one
    assert (response.status_code, response.json()) == (409, {"code": "closed"})
    # a deleted Desk opens no sessions
    await update_row(app, rows.copy_id, Desk.desk_id, rows.desk_id, deleted_at=frozen_clock.now())
    response = await client.post("/sessions", json={"desk_slug": rows.slug, "kind": "visitor"})
    assert (response.status_code, response.json()) == (409, {"code": "closed"})
    refusals = [entry.event for entry in await ledger_rows(app, rows) if entry.event.kind == "auth"]
    assert [(event.session_id, event.summary) for event in refusals] == [
        (closed_id, {"route": PROBE, "reason": "closed"}), (idle_id, {"route": PROBE, "reason": "closed"}),
        (idle_id, {"route": MODE, "reason": "closed"}), (None, {"route": "POST /sessions", "reason": "closed"})]
    [row] = await rows_of(app, rows.copy_id, select(ActorSession).where(ActorSession.session_id == idle_id))
    assert (row.mode, row.generation) == ("ai", 0)


async def test_stale_generation_is_409_and_ledgered(app, client):
    add_session_probe(app)
    rows = await make_copy_rows(app)
    visitor = await open_session(client, rows.slug)
    session_id, token = visitor["state"]["session_id"], {"X-Session-Token": visitor["session_token"]}
    response = await client.post(f"/test/sessions/{session_id}", params={"generation": 0}, headers=token)
    assert response.status_code == 200
    response = await client.post(f"/test/sessions/{session_id}", params={"generation": 1}, headers=token)
    assert (response.status_code, response.json()) == (409, {"code": "stale_generation"})
    response = await client.post(f"/sessions/{session_id}/mode", json={"mode": "owner", "generation": 1},
                                 headers=rows.owner)
    assert (response.status_code, response.json()) == (409, {"code": "stale_generation"})
    refusals = [entry.event for entry in await ledger_rows(app, rows) if entry.event.kind == "auth"]
    assert [(event.session_id, event.summary) for event in refusals] == [
        (session_id, {"route": PROBE, "reason": "stale_generation"}),
        (session_id, {"route": MODE, "reason": "stale_generation"})]
    [row] = await rows_of(app, rows.copy_id, select(ActorSession).where(ActorSession.session_id == session_id))
    assert (row.mode, row.generation) == ("ai", 0)


async def test_takeover_and_hand_back_bump_generation(app, client):
    add_session_probe(app)
    rows = await make_copy_rows(app)
    visitor = await open_session(client, rows.slug)
    session_id = visitor["state"]["session_id"]
    response = await set_mode(client, rows, session_id, "owner", 0)
    assert response.status_code == 200
    assert response.json() == {**visitor["state"], "mode": "owner", "generation": 1}
    # the visitor's work from before the take-over is stale now
    response = await client.post(f"/test/sessions/{session_id}", params={"generation": 0},
                                 headers={"X-Session-Token": visitor["session_token"]})
    assert (response.status_code, response.json()) == (409, {"code": "stale_generation"})
    response = await set_mode(client, rows, session_id, "ai", 1)
    assert (response.status_code, response.json()["mode"], response.json()["generation"]) == (200, "ai", 2)
    response = await set_mode(client, rows, session_id, "ai", 2)                # already there: nothing changes
    assert (response.status_code, response.json()["mode"], response.json()["generation"]) == (200, "ai", 2)
    events = [entry.event for entry in await ledger_rows(app, rows) if entry.event.kind == "takeover"]
    assert [(event.origin, event.session_id, event.summary) for event in events] == [
        ("kernel", session_id, {"from": "ai", "to": "owner", "generation": 1}),
        ("kernel", session_id, {"from": "owner", "to": "ai", "generation": 2})]
    [row] = await rows_of(app, rows.copy_id, select(ActorSession).where(ActorSession.session_id == session_id))
    assert (row.mode, row.generation) == ("ai", 2)


async def test_only_the_breaker_pauses(app, client):
    rows = await make_copy_rows(app)
    session_id = (await open_session(client, rows.slug))["state"]["session_id"]
    response = await set_mode(client, rows, session_id, "paused", 0)
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    await update_row(app, rows.copy_id, ActorSession.session_id, session_id, mode="paused", strikes=3)   # the breaker
    response = await set_mode(client, rows, session_id, "paused", 0)
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    # the owner's own session has no mode to set
    response = await set_mode(client, rows, rows.owner_session_id, "owner", 0)
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    rows_now = await rows_of(app, rows.copy_id, select(ActorSession).order_by(ActorSession.kind))
    assert [(row.kind, row.mode, row.generation) for row in rows_now] == [("owner", "ai", 0), ("visitor", "paused", 0)]
    assert [entry.event.kind for entry in await ledger_rows(app, rows)] == ["session"]


async def test_resume_resets_strikes(app, client):
    rows = await make_copy_rows(app)
    session_id = (await open_session(client, rows.slug))["state"]["session_id"]
    await update_row(app, rows.copy_id, ActorSession.session_id, session_id, mode="paused", strikes=3)
    response = await set_mode(client, rows, session_id, "ai", 0)
    assert (response.status_code, response.json()["mode"], response.json()["generation"]) == (200, "ai", 1)
    [row] = await rows_of(app, rows.copy_id, select(ActorSession).where(ActorSession.session_id == session_id))
    assert (row.mode, row.generation, row.strikes) == ("ai", 1, 0)
    events = [entry.event for entry in await ledger_rows(app, rows)]
    assert [(event.kind, event.session_id, event.summary) for event in events[1:]] == [
        ("breaker", session_id, {"resumed": True})]


async def test_take_over_of_a_paused_session(app, client):
    rows = await make_copy_rows(app)
    session_id = (await open_session(client, rows.slug))["state"]["session_id"]
    await update_row(app, rows.copy_id, ActorSession.session_id, session_id, mode="paused", strikes=3)
    response = await set_mode(client, rows, session_id, "owner", 0)
    assert (response.status_code, response.json()["mode"], response.json()["generation"]) == (200, "owner", 1)
    [row] = await rows_of(app, rows.copy_id, select(ActorSession).where(ActorSession.session_id == session_id))
    assert (row.mode, row.generation, row.strikes) == ("owner", 1, 0)   # handing back resumes Claude
    events = [entry.event for entry in await ledger_rows(app, rows)]
    assert [(event.kind, event.session_id, event.summary) for event in events[1:]] == [
        ("takeover", session_id, {"from": "paused", "to": "owner", "generation": 1})]


async def test_bad_owner_token_is_401(app, client):
    rows, other = await make_copy_rows(app), await make_copy_rows(app)
    visitor = await open_session(client, rows.slug)
    session_id = visitor["state"]["session_id"]
    await update_row(app, other.copy_id, ActorSession.session_id, other.owner_session_id,
                     closed_at=app.state.kernel.clock.now())
    bad = ({"X-Owner-Session": rows.owner_token[:-1]},              # a guess
           {"X-Owner-Session": visitor["session_token"]},           # a visitor's token isn't an owner's
           {"X-Owner-Session": other.owner_token},                  # a closed owner session
           {"X-Session-Token": rows.owner_token},                   # the owner token under the visitor header
           {})
    for headers in bad:
        response = await client.post(f"/sessions/{session_id}/mode", json={"mode": "owner", "generation": 0},
                                     headers=headers)
        assert (response.status_code, response.json()) == (401, {"code": "auth"}), headers
        response = await client.get("/whoami", headers={k: v for k, v in headers.items() if k == "X-Owner-Session"})
        assert (response.status_code, response.json()) == (401, {"code": "auth"}), headers
    refusals = [entry.event for entry in await ledger_rows(app, rows) if entry.event.kind == "auth"]
    assert [(event.session_id, event.summary) for event in refusals] == [
        (session_id, {"route": MODE, "reason": "bad_owner_token"})] * len(bad)   # on the named session's Desk
    [row] = await rows_of(app, rows.copy_id, select(ActorSession).where(ActorSession.session_id == session_id))
    assert (row.mode, row.generation) == ("ai", 0)


async def test_require_owner_takes_one_session_to_ledger_a_refusal_on():
    # A call names the session a refusal goes on by `session_id` or as `named` (the decision a read
    # names), never both: a caller passing both would lose `named` without a word. It is a caller's
    # mistake, raised before the request or the database is read.
    named = auth.Named(copy_id="copy-1", session_id="s-1")
    with pytest.raises(ValueError, match="session_id or named"):
        await auth.require_owner(None, None, session_id="s-1", named=named)


async def test_a_copy_resolver_runs_only_before_the_transaction_takes_its_connection(app):
    # A resolver takes a connection of its own. Asked once the request's transaction holds one, it
    # refuses (500 `internal`) rather than hold one connection while it waits for another, which
    # enough requests at once would turn into a starved pool.
    rows = await make_copy_rows(app)
    resolvers = (repo.copy_of_session_id, repo.copy_of_session_token, repo.copy_of_desk_slug,
                 repo.copy_of_decision_id)
    async with kernel_ctx(app) as ctx:
        assert await repo.copy_of_session_id(ctx, rows.owner_session_id) == rows.copy_id
        ctx.bind(rows.copy_id)                       # bound, with nothing run: still before
        assert await repo.copy_of_desk_slug(ctx, rows.slug) == rows.copy_id
        await ctx.db.scalars(ctx.repo.scoped(select(ActorSession.session_id)))
        for resolver in resolvers:
            with pytest.raises(RuntimeError, match="before the request's transaction"):
                await resolver(ctx, rows.owner_session_id)


async def test_unattributed_failures_are_logged_not_ledgered(app, client, caplog):
    add_session_probe(app)
    rows = await make_copy_rows(app)
    visitor = await open_session(client, rows.slug)
    with caplog.at_level(logging.INFO, logger="desk.kernel_service"):
        response = await client.post("/test/sessions/no-such-session",
                                     headers={"X-Session-Token": visitor["session_token"]})
        assert (response.status_code, response.json()) == (401, {"code": "auth"})
        response = await client.post("/sessions/no-such-session/mode", json={"mode": "owner", "generation": 0},
                                     headers={"X-Owner-Session": "a-guess"})
        assert (response.status_code, response.json()) == (401, {"code": "auth"})
        response = await client.post("/sessions/no-such-session/mode", json={"mode": "owner", "generation": 0},
                                     headers=rows.owner)
        assert (response.status_code, response.json()) == (404, {"code": "not_found"})
        response = await client.get("/whoami")
        assert (response.status_code, response.json()) == (401, {"code": "auth"})
    lines = [record.getMessage() for record in caplog.records if record.getMessage().startswith("auth_unattributed")]
    assert lines == [f"auth_unattributed route={PROBE} reason=unknown_session",
                     f"auth_unattributed route={MODE} reason=bad_owner_token",
                     f"auth_unattributed route={MODE} reason=unknown_session",
                     "auth_unattributed route=GET /whoami reason=bad_token"]
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert visitor["session_token"] not in logged and rows.owner_token not in logged and "no-such-session" not in logged
    with psycopg.connect(libpq_url(database_url("ADMIN"))) as admin:
        kinds = [kind for (kind,) in admin.execute("SELECT event->>'kind' FROM kernel.ledger_entries").fetchall()]
    assert kinds == ["session"]                                            # only the visitor's own session entry


async def test_whoami_reports_only_kernel_rows(app, client, frozen_clock):
    rows = await make_copy_rows(app)
    async with kernel_ctx(app) as ctx:                                     # a second Desk, and a deleted one
        ctx.bind(rows.copy_id)
        ctx.db.add_all([Desk(desk_id="desk-second", copy_id=rows.copy_id, business_id=rows.business_id,
                             name="Second line", slug=f"second-{rows.desk_id}",
                             created_at=frozen_clock.now() + timedelta(seconds=1)),
                        Desk(desk_id="desk-deleted", copy_id=rows.copy_id, business_id=rows.business_id,
                             name="Old line", slug=f"old-{rows.desk_id}", created_at=frozen_clock.now(),
                             deleted_at=frozen_clock.now())])
    visitor = await open_session(client, rows.slug)
    frozen_clock.advance(60)
    response = await client.get("/whoami", headers={"X-Session-Token": visitor["session_token"]})
    assert response.status_code == 200
    assert response.json() == {"kind": "visitor", "copy_id": rows.copy_id, "desk_id": rows.desk_id,
                               "desk_ids": [rows.desk_id], "session": visitor["state"]}
    response = await client.get("/whoami", headers=rows.owner)
    assert response.status_code == 200
    assert response.json() == {
        "kind": "owner", "copy_id": rows.copy_id, "desk_id": None, "desk_ids": [rows.desk_id, "desk-second"],
        "session": {"session_id": rows.owner_session_id, "kind": "owner", "verified": True,
                    "assurance": "owner_session", "mode": "ai", "generation": 0}}
    for headers in ({"X-Session-Token": visitor["session_token"][:-1]}, {"X-Owner-Session": visitor["session_token"]},
                    {"X-Session-Token": rows.owner_token}, {**rows.owner, "X-Session-Token": visitor["session_token"]}):
        response = await client.get("/whoami", headers=headers)
        assert (response.status_code, response.json()) == (401, {"code": "auth"}), headers
    # a whoami counts as activity; an idle session is closed
    [visitor_row] = await rows_of(app, rows.copy_id, select(ActorSession).where(
        ActorSession.session_id == visitor["state"]["session_id"]))
    assert visitor_row.last_seen_at == frozen_clock.now()
    frozen_clock.advance(timedelta(hours=24, seconds=1).total_seconds())
    response = await client.get("/whoami", headers={"X-Session-Token": visitor["session_token"]})
    assert (response.status_code, response.json()) == (409, {"code": "closed"})
    response = await client.get("/whoami", headers=rows.owner)               # owner sessions don't idle out
    assert response.status_code == 200
    # the principal a decision sees is built from the same rows
    [owner_row] = await rows_of(app, rows.copy_id, select(ActorSession).where(
        ActorSession.session_id == rows.owner_session_id))
    assert sessions.principal_for(visitor_row) == Principal(
        kind="visitor", session_id=visitor_row.session_id, copy_id=rows.copy_id, desk_id=rows.desk_id)
    assert sessions.principal_for(owner_row, desk_id=rows.desk_id) == Principal(
        kind="owner", session_id=rows.owner_session_id, copy_id=rows.copy_id, desk_id=rows.desk_id,
        assurance="owner_session")
    with pytest.raises(ValueError):
        sessions.principal_for(owner_row)                                    # an owner call names its Desk
    with pytest.raises(ValueError):
        sessions.principal_for(visitor_row, desk_id="desk-second")           # a visitor's Desk is its own
