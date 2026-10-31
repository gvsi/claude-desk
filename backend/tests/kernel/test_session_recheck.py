"""A session's read is answered only if the session is still open, as the same verified person,
when the read ends.

A route checks the session's state when it authenticates it, on the row as it read it, and for
most routes without a lock. The owner can close the session in the meantime: a contact change or
a person's removal (`desks.put_people`), or the Desk's deletion. A read that went on with the
state it read first would answer a closed session, and after a contact change it could answer
with a document the owner added for the person since. So every visitor or agent session a
request admits is checked again, read afresh, after the request's last read and before it answers
(`auth.watch_session`, run by `KernelCtx.commit` and when the request's transaction ends): closed,
or no longer the person it read as, is 409 `closed`, ledgered as at authentication, and nothing
it read is answered.

Each race test pauses a context read on real Postgres (after authentication, or after its reads),
commits the owner's change, and lets it go on. Every route a session's token is proved on is then
called with the session closed right after its token, and two static guards keep new code on the
shared path: a session's token is read only where the session is watched, and a commit that ends
what a request answers runs the rechecks.
"""

import ast
import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk import kernel_service
from desk.contracts import Decision
from desk.db.models import ActorSession, Person
from desk.kernel_api import KERNEL_ROUTES
from desk.kernel_service import auth, context

from .helpers import kernel_ctx, ledger_rows
from .test_adapters import Rivera, quote_args, rivera, visitor_of
from .test_approvals import held_quote, post_cancel
from .test_context import get_context
from .test_decide import Visitor, decided, post_decide, set_session
from .test_desk_writes import updated, upload
from .test_execute import post_execute
from .test_ledger_read import append_api
from .test_release_document import BOB, DANA, confirmed
from .test_reply_check import post_check
from .test_verification import check, start

NEW_DOCUMENT = {"ref": "dana-estimate", "title": "Estimate, tankless heater", "body": "Tankless heater: $3,100.00",
                "record_owner_ref": "dana"}


def paused_after(original, paused: asyncio.Event, go_on: asyncio.Event):
    """`original`, which answers only once the test lets it go on."""
    async def pausing(*args, **kwargs):
        result = await original(*args, **kwargs)
        paused.set()
        await go_on.wait()
        return result
    return pausing


async def owner_changes(client, copy, change: str) -> None:
    """The owner's change, committed: Dana given another contact (and a new document of hers
    added), Dana removed, or the Desk deleted."""
    if change == "contact":
        await updated(client, copy, "people", {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                           "contact": "dana.w@example.net"}]})
        response = await upload(client, copy, NEW_DOCUMENT)
    elif change == "removal":
        response = await client.put(f"/desks/{copy.desk_id}/people", headers=copy.owner, json={"remove": ["dana"]})
    else:
        response = await client.delete(f"/desks/{copy.desk_id}", headers=copy.owner)
    assert response.status_code in (200, 204), response.text


@pytest.mark.parametrize("pause", ["after_auth", "after_read"])
@pytest.mark.parametrize("change", ["contact", "removal", "deletion"])
async def test_a_context_read_is_refused_once_the_owner_closes_its_session(app, client, monkeypatch, change, pause):
    """Dana's verified session reads its context while the owner gives her another contact, removes
    her or deletes the Desk: 409 `closed`, ledgered, and nothing of hers in the answer, the
    document added since least of all."""
    copy = await rivera(app, client)
    dana = await confirmed(client, copy, DANA)
    paused, go_on = asyncio.Event(), asyncio.Event()
    if pause == "after_auth":
        monkeypatch.setattr(auth, "require_caller", paused_after(auth.require_caller, paused, go_on))
    else:
        monkeypatch.setattr(context, "session_context", paused_after(context.session_context, paused, go_on))
    reading = asyncio.create_task(get_context(client, dana.session_id, dana.headers))
    await asyncio.wait_for(paused.wait(), timeout=5)
    await owner_changes(client, copy, change)
    go_on.set()
    response = await asyncio.wait_for(reading, timeout=5)

    assert NEW_DOCUMENT["title"] not in response.text, "a closed session read the document added since"
    assert (response.status_code, response.json()) == (409, {"code": "closed"}), response.text[:300]
    last = (await ledger_rows(app, copy))[-1].event
    assert (last.kind, last.session_id, last.summary) == (
        "auth", dana.session_id, {"route": "GET /context/{session_id}", "reason": "closed"})


@pytest.mark.parametrize("change", ["person_removed", "person_swapped"])
async def test_a_read_is_refused_once_its_person_is_off_the_record(app, client, monkeypatch, change):
    """The recheck reads the person too: a session still open whose person has left the record, or
    that names another person than it read as, is refused as closed. Neither happens through the
    owner's writes, which close the person's sessions in the same transaction; each is written here
    straight to the rows, while the read waits after authentication."""
    copy = await rivera(app, client)
    dana, bob = await confirmed(client, copy, DANA), await confirmed(client, copy, BOB)
    paused, go_on = asyncio.Event(), asyncio.Event()
    monkeypatch.setattr(auth, "require_caller", paused_after(auth.require_caller, paused, go_on))
    reading = asyncio.create_task(get_context(client, dana.session_id, dana.headers))
    await asyncio.wait_for(paused.wait(), timeout=5)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        sessions = {row.session_id: row for row in await ctx.db.scalars(ctx.repo.scoped(select(ActorSession).where(
            ActorSession.session_id.in_([dana.session_id, bob.session_id]))))}
        danas = sessions[dana.session_id]
        if change == "person_removed":
            [person] = await ctx.db.scalars(ctx.repo.scoped(select(Person).where(Person.person_id == danas.person_id)))
            person.removed_at = ctx.clock.now()
        else:
            danas.person_id = sessions[bob.session_id].person_id
    go_on.set()
    response = await asyncio.wait_for(reading, timeout=5)

    assert (response.status_code, response.json()) == (409, {"code": "closed"}), response.text[:300]


# ---- Every route a session calls --------------------------------------------------------------------

WATCH_SESSION = auth.watch_session

Call = Callable[[], Awaitable[httpx.Response]]
Setup = Callable[[FastAPI, httpx.AsyncClient], Awaitable[tuple[Rivera, Visitor, Call]]]


def plain(call: Callable[[httpx.AsyncClient, Rivera, Visitor], Awaitable[httpx.Response]]) -> Setup:
    """A route a fresh stranger on a Rivera copy calls with nothing made first."""
    async def setup(app, client):
        copy, visitor = await visitor_of(app, client)
        return copy, visitor, lambda: call(client, copy, visitor)
    return setup


def after_a_decision(call: Callable[[httpx.AsyncClient, Visitor, Decision], Awaitable[httpx.Response]], *,
                     held: bool = False) -> Setup:
    """A route a stranger calls on one of their decisions: an allowed quote, or one Maria must answer."""
    async def setup(app, client):
        if held:
            copy, visitor, decision = await held_quote(app, client)
        else:
            copy, visitor = await visitor_of(app, client)
            decision = await decided(client, visitor, "native.quote", quote_args(("drain", 1)), call_id="call-1")
            assert decision.outcome == "allow", decision.reason_plain
        return copy, visitor, lambda: call(client, visitor, decision)
    return setup


# Every `KERNEL_ROUTES` row a visitor's or agent's session token is proved on, and how a stranger
# calls it. A new row must be named here or below, so a route a session calls can't skip the test.
SESSION_ROUTES: dict[str, Setup] = {
    "GET /context/{session_id}?desk_id=": plain(lambda client, copy, v: get_context(client, v.session_id, v.headers)),
    "GET /whoami": plain(lambda client, copy, v: client.get("/whoami", headers=v.headers)),
    "GET /demo_inbox?session_id=": plain(lambda client, copy, v: client.get(
        "/demo_inbox", params={"session_id": v.session_id}, headers=v.headers)),
    "POST /decide": plain(lambda client, copy, v: post_decide(client, v, "native.quote", quote_args(("drain", 1)))),
    "GET /decisions/{id}": after_a_decision(lambda client, v, d: client.get(f"/decisions/{d.decision_id}",
                                                                              headers=v.headers)),
    "GET /decisions/by_call?session_id=&generation=&call_id=": after_a_decision(lambda client, v, d: client.get(
        "/decisions/by_call", params={"session_id": v.session_id, "generation": 0, "call_id": "call-1"},
        headers=v.headers)),
    "POST /execute": after_a_decision(lambda client, v, d: post_execute(client, v, d)),
    "POST /decisions/{decision_id}/cancel": after_a_decision(lambda client, v, d: post_cancel(client, v, d.decision_id),
                                                             held=True),
    "POST /verify/start": plain(lambda client, copy, v: start(client, v, DANA)),
    "POST /verify/check": plain(lambda client, copy, v: check(client, v, "000000")),
    "POST /check_reply": plain(lambda client, copy, v: post_check(client, v, "I can help with that.")),
    "POST /ledger/append": plain(lambda client, copy, v: append_api(
        client, copy.desk_id, v.headers, kind="rate_limit", origin="api", session_id=v.session_id,
        summary={"limit": "visitor_message"})),
}

# Every other row, and why no session's token is proved on it.
NO_SESSION_ROUTES: dict[str, str] = {
    **dict.fromkeys(["POST /desks", "PUT /desks/{id}/business", "PUT /desks/{id}/charter", "PUT /desks/{id}/hours",
                     "PUT /desks/{id}/prices", "PUT /desks/{id}/calendar", "PUT /desks/{id}/people",
                     "PUT /desks/{id}/notifications", "PUT /desks/{id}/answering", "DELETE /desks/{id}",
                     "POST /documents", "POST /sessions/{id}/mode", "GET /demo_inbox",
                     "POST /approvals/{decision_id}/answer", "POST /owner/messages", "POST /policy/draft",
                     "POST /policy/confirm", "POST /knowledge", "POST /handoffs/{id}/done",
                     "GET /ledger/{desk_id}?verify=true"], "the owner's credential alone"),
    **dict.fromkeys(["POST /copies", "POST /sessions", "GET /public/{desk_slug}", "GET /health"],
                    "no credential: a new copy or session, the public page, the kernel's health"),
    "GET /document_links/{token}": "the link's own single-use token, which a removal or contact change voids",
    **dict.fromkeys(["POST /policy/{version}/probe", "POST /tools/connect", "POST /tools/confirm",
                     "POST /tools/simulate_change", "GET /payment_links/{token}",
                     "POST /payment_links/{token}/complete", "POST /payment_links/{token}/cancel", "POST /agents/demo"],
                    "not served yet (the payments, agents and setup kernel plan, 01c): classify it when it is"),
}


def test_every_kernel_route_is_classified():
    assert not set(SESSION_ROUTES) & set(NO_SESSION_ROUTES)
    assert set(SESSION_ROUTES) | set(NO_SESSION_ROUTES) == set(KERNEL_ROUTES)


@pytest.mark.parametrize("route", sorted(SESSION_ROUTES))
async def test_every_session_route_refuses_a_session_closed_after_its_token(app, client, monkeypatch, frozen_clock,
                                                                            route):
    """Each route a session calls, with the session closed (committed elsewhere) right after its
    token is proved and before the route reads anything: 409 `closed`, ledgered on the session as
    at authentication, and nothing else."""
    copy, visitor, call = await SESSION_ROUTES[route](app, client)
    closing = {"armed": True}

    async def close_then_watch(ctx, request, row):
        if closing["armed"]:
            closing["armed"] = False
            await set_session(app, copy, row.session_id, closed_at=frozen_clock.now())
        await WATCH_SESSION(ctx, request, row)

    monkeypatch.setattr(auth, "watch_session", close_then_watch)
    before = len(await ledger_rows(app, copy))
    response = await call()

    assert not closing["armed"], "the route proved no session's token"
    assert (response.status_code, response.json()) == (409, {"code": "closed"}), (route, response.text[:300])
    [entry] = [entry.event for entry in (await ledger_rows(app, copy))[before:]]
    assert (entry.kind, entry.session_id, entry.summary["reason"]) == ("auth", visitor.session_id, "closed")


# ---- Static guards ------------------------------------------------------------------------------------

PACKAGE = Path(kernel_service.__file__).parent

# Where a commit may end a transaction without the request's rechecks: each records a refusal, or
# a step whose answer comes from a later commit that runs them, or runs outside a request.
PLAIN_COMMITS = {
    ("approvals.py", "_refused"): "an answer refused: its record, then 409",
    ("approvals.py", "answer"): "the owner's answer, before the approved execution, whose T2 answers",
    ("approvals.py", "cancel"): "a cancel refused: its record, then 409",
    ("verification.py", "_refused"): "a code that verified nobody: its attempt, then 422",
    ("execute.py", "_refused_at_execution"): "a refusal's record, then 409",
    ("execute.py", "_not_runnable"): "a refusal's record, then 409",
    ("execute.py", "execute_allowed"): "T1's intent row: T2's commit, which answers, runs them",
    ("execute.py", "_refused_in_t2"): "a refusal's record, then 409 or the failed result",
    ("execute.py", "_fenced"): "a fence's record, then 409",
    ("execute.py", "_settle_failed"): "T3: a failed result, which holds nothing read",
    ("execute.py", "_settle_unknown"): "T3: an unknown result, which holds nothing read",
    ("execute.py", "reconcile_orphans"): "startup reconciliation, outside any request",
    ("repo.py", "kernel_transaction"): "runs them first whenever the transaction read anything",
    ("repo.py", "commit"): "KernelCtx.commit, which runs them first",
}


def _calls_in_functions(predicate: Callable[[ast.Call], bool]) -> set[tuple[str, str]]:
    """(file, innermost function) for every call in the kernel service that `predicate` picks."""
    found: set[tuple[str, str]] = set()

    def visit(node: ast.AST, where: str, function: str | None) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            function = node.name
        if isinstance(node, ast.Call) and predicate(node):
            found.add((where, function or "<module>"))
        for child in ast.iter_child_nodes(node):
            visit(child, where, function)

    for path in sorted(PACKAGE.rglob("*.py")):
        visit(ast.parse(path.read_text()), str(path.relative_to(PACKAGE)), None)
    return found


def test_a_commit_that_answers_runs_the_rechecks():
    """A request that commits and then answers with what it read must commit through
    `KernelCtx.commit`, or its rechecks don't run; every plain `db.commit()` is one listed above."""
    plain_commits = _calls_in_functions(lambda call: isinstance(call.func, ast.Attribute) and call.func.attr == "commit"
                                        and isinstance(call.func.value, ast.Attribute) and call.func.value.attr == "db")
    assert plain_commits <= set(PLAIN_COMMITS), sorted(plain_commits - set(PLAIN_COMMITS))


def test_a_session_token_is_proved_only_where_the_session_is_watched():
    """The only reads of a session's token are in the two functions that prove it, and both watch
    the session, so no route admits a session the recheck doesn't see."""
    def reads_the_session_token(call: ast.Call) -> bool:
        return (isinstance(call.func, ast.Attribute) and call.func.attr == "get" and len(call.args) == 1
                and "SESSION_HEADER" in ast.unparse(call.args[0]))
    assert _calls_in_functions(reads_the_session_token) == {("auth.py", "authenticate_session"),
                                                             ("auth.py", "require_session_token")}
    watching = _calls_in_functions(lambda call: ast.unparse(call.func) == "watch_session")
    assert {("auth.py", "authenticate_session"), ("auth.py", "require_session_token")} <= watching
