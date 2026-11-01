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

No recheck takes back the record of something that already happened. An execution's T2 checks its
session before the adapter acts, under the session row it holds, and commits what the adapter did
as it decided; a reconciliation a read runs commits before the read goes on; the API's own ledger
entries commit as sent. The session's next read answers its close.
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
from desk.contracts import Decision, ExecResult
from desk.db.models import ActorSession, Desk, Execution, Person, Quote
from desk.db.models import Decision as DecisionRow
from desk.kernel_api import KERNEL_ROUTES
from desk.kernel_service import adapters, auth, context, execute, ledger

from .helpers import connections_of, kernel_ctx, ledger_rows, rows_of, until_waiting
from .test_adapters import Rivera, quote_args, rivera, visitor_of
from .test_approvals import held_quote, post_cancel
from .test_context import get_context
from .test_decide import Visitor, decided, post_decide, set_session
from .test_desk_writes import updated, upload
from .test_execute import committed, fake_quote_desk, leave_an_intent, post_execute
from .test_ledger_read import append_api
from .test_release_document import BOB, DANA, confirmed
from .test_reply_check import post_check
from .test_turn_language import post_turn
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
    "POST /agents/demo": plain(lambda client, copy, v: client.post("/agents/demo", json={"desk_id": copy.desk_id},
                                                                    headers=v.headers)),
    "POST /sessions/{session_id}/turn": plain(lambda client, copy, v: post_turn(client, v.session_id, v.headers,
                                                                                "Hola, ¿me puede ayudar?")),
}

# Rows a session's token is proved on that record something which already happened and answer only
# that record: no recheck takes the record back (`test_a_record_commits_whatever_happens_to_its_session`).
RECORD_ROUTES = {"POST /ledger/append": "the API's own entry (a rate limit, say), answered as stored"}

# Every other row, and why no session's token is proved on it.
NO_SESSION_ROUTES: dict[str, str] = {
    **dict.fromkeys(["POST /desks", "PUT /desks/{id}/business", "PUT /desks/{id}/charter", "PUT /desks/{id}/hours",
                     "PUT /desks/{id}/prices", "PUT /desks/{id}/calendar", "PUT /desks/{id}/people",
                     "PUT /desks/{id}/notifications", "PUT /desks/{id}/answering", "PUT /desks/{id}/memory",
                     "PUT /desks/{id}/business_tools",
                     "DELETE /desks/{id}",
                     "POST /documents", "POST /sessions/{id}/mode", "GET /demo_inbox",
                     "POST /approvals/{decision_id}/answer", "POST /owner/messages", "POST /policy/draft",
                     "POST /policy/confirm", "POST /knowledge", "POST /handoffs/{id}/done",
                     "GET /ledger/{desk_id}?verify=true", "POST /policy/{version}/probe",
                     "GET /policy/{version}/cancelled_links?desk_id=", "POST /tools/connect", "POST /tools/confirm",
                     "POST /tools/simulate_change"], "the owner's credential alone"),
    **dict.fromkeys(["POST /copies", "POST /sessions", "GET /public/{desk_slug}", "GET /health"],
                    "no credential: a new copy or session, the public page, the kernel's health"),
    "GET /document_links/{token}": "the link's own single-use token, which a removal or contact change voids",
    **dict.fromkeys(["GET /payment_links/{token}", "POST /payment_links/{token}/complete",
                     "POST /payment_links/{token}/cancel"],
                    "the payment link's own token, which pays once: a completion checks the link's baseline "
                    "(`payments.recheck_link_baseline`), then its session under the row it holds, before the "
                    "provider is asked"),
}


def test_every_kernel_route_is_classified():
    classes = [set(SESSION_ROUTES), set(RECORD_ROUTES), set(NO_SESSION_ROUTES)]
    assert sum(map(len, classes)) == len(set().union(*classes))                   # each row in one class
    assert set().union(*classes) == set(KERNEL_ROUTES)


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
    ("execute.py", "execute_allowed"): "T1's intent row, before any side effect; T2 checks the session again",
    ("execute.py", "_side_effect"): "T2: what the adapter did, recorded as T2 decided; the session was "
                                    "checked before the adapter ran, under the row T2 holds through this commit",
    ("execute.py", "_refused_in_t2"): "a refusal's record, then 409 or the failed result",
    ("execute.py", "_fenced"): "a fence's record, then 409",
    ("execute.py", "_settle_failed"): "T3: a failed result, which holds nothing read",
    ("execute.py", "_settle_unknown"): "T3: an unknown result, which holds nothing read",
    ("execute.py", "reconcile_orphans"): "a reconciliation, a record of what already happened: at startup, "
                                          "outside any request, or on a read, which then answers under them",
    ("payments.py", "_refused"): "a completion or cancel refused: its record, then 409",
    ("payments.py", "complete_link"): "C1: a baseline refusal's record, then 409, or the completion's marker, "
                                      "before the provider is asked; C2 answers",
    ("payments.py", "_pay"): "C2: a refusal's record, or what the provider did, recorded as C2 decided; the "
                             "link's session was checked before the provider was asked, under the row C2 holds "
                             "through this commit, and no recheck may take back a payment that happened",
    ("payments.py", "_settle"): "C3: an exception in C2 settled, which holds nothing read",
    ("payments.py", "reconcile_links_at_startup"): "startup reconciliation, outside any request",
    ("payments.py", "settle_link"): "a link's reconciliation on a read, a record of what already happened, "
                                    "committed before the read goes on",
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
    the session, so no route admits a session the recheck doesn't see; only the record routes ask
    `require_session_token` not to."""
    def reads_the_session_token(call: ast.Call) -> bool:
        return (isinstance(call.func, ast.Attribute) and call.func.attr == "get" and len(call.args) == 1
                and "SESSION_HEADER" in ast.unparse(call.args[0]))
    assert _calls_in_functions(reads_the_session_token) == {("auth.py", "authenticate_session"),
                                                             ("auth.py", "require_session_token")}
    watching = _calls_in_functions(lambda call: ast.unparse(call.func) == "watch_session")
    assert {("auth.py", "authenticate_session"), ("auth.py", "require_session_token")} <= watching
    unwatched = _calls_in_functions(lambda call: any(keyword.arg == "watch" for keyword in call.keywords))
    assert unwatched == {("app.py", "append_api_entry")} and set(RECORD_ROUTES) == {"POST /ledger/append"}


# ---- Executions ----------------------------------------------------------------------------------------
#
# An execution's adapter acts on the world, which a rollback can't undo. So its session is checked
# again in T2, under the session row T2 holds, before the adapter runs (`auth.session_stands`, as
# `still_open` reads it); and the commit that records what the adapter did runs no recheck, whatever
# happens to the session after the check: the session's next read answers it.

async def person_off_the_record(app: FastAPI, copy: Rivera, ref: str = "dana") -> None:
    """The person's row marked removed, straight to the row: the session verified as them stays open."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        [person] = await ctx.db.scalars(ctx.repo.scoped(select(Person).where(Person.ref == ref)))
        person.removed_at = ctx.clock.now()


async def allowed_quote(app: FastAPI, client: httpx.AsyncClient) -> tuple[Rivera, Visitor, Decision]:
    """A Rivera copy, a visitor verified as Dana, and her quote at list price, allowed."""
    copy = await rivera(app, client)
    dana = await confirmed(client, copy, DANA)
    allowed = await decided(client, dana, "native.quote", quote_args(("drain", 1)))
    assert allowed.outcome == "allow", allowed.reason_plain
    return copy, dana, allowed


async def execution_of(app: FastAPI, copy: Rivera, decision: Decision) -> tuple[str, str]:
    """The execution's state and its decision's, as committed."""
    [execution] = await rows_of(app, copy.copy_id, select(Execution).where(
        Execution.decision_id == decision.decision_id))
    [row] = await rows_of(app, copy.copy_id, select(DecisionRow).where(DecisionRow.decision_id == decision.decision_id))
    return execution.state, row.state


async def test_an_execution_whose_person_leaves_before_its_side_effect_runs_nothing(app, client, monkeypatch):
    """Dana's person row is marked removed after T1 committed the intent: T2, holding her session's
    row, reads her off the record before the adapter runs. Nothing runs; the execution is settled
    refused (not unknown) and the answer is 409 `closed`, ledgered as at authentication."""
    copy, dana, allowed = await allowed_quote(app, client)
    quote, calls = adapters.ADAPTERS["native.quote"], []
    run_quote = quote.execute

    async def counted(*args, **kwargs):
        calls.append(args)
        return await run_quote(*args, **kwargs)

    async def dana_leaves() -> None:
        await person_off_the_record(app, copy)

    monkeypatch.setattr(quote, "execute", counted)
    monkeypatch.setattr(execute, "_after_intent", dana_leaves)
    response = await post_execute(client, dana, allowed)

    assert (response.status_code, response.json()) == (409, {"code": "closed"}), response.text[:300]
    assert calls == []                                                  # the adapter never ran
    assert await rows_of(app, copy.copy_id, select(Quote)) == []
    assert await execution_of(app, copy, allowed) == ("failed", "refused_at_execution")
    last = (await ledger_rows(app, copy))[-1].event
    assert (last.kind, last.session_id, last.summary) == (
        "auth", dana.session_id, {"route": "POST /execute", "reason": "closed"})


@pytest.mark.parametrize("change", ["removal", "person_off_the_record"])
async def test_an_execution_that_ran_is_recorded_whatever_happens_to_its_session(app, client, monkeypatch, change):
    """The adapter has run and T2 is about to commit when the owner removes Dana (her removal waits
    for the session row T2 holds) or her person row is marked removed: the execution and its
    `execute` entry still commit as T2 decided, the answer is the result, and her session's next
    read is 409 `closed`."""
    copy, dana, allowed = await allowed_quote(app, client)
    finished, go_on = asyncio.Event(), asyncio.Event()
    finish = execute._finish

    async def finish_then_wait(ctx, target, execution, result, decision_state, summary):
        await finish(ctx, target, execution, result, decision_state, summary)
        finished.set()                                       # the adapter ran, T2 not yet committed
        await go_on.wait()

    monkeypatch.setattr(execute, "_finish", finish_then_wait)
    running = asyncio.create_task(post_execute(client, dana, allowed))
    await asyncio.wait_for(finished.wait(), timeout=5)
    if change == "removal":
        with connections_of(app) as pids:
            removing = asyncio.create_task(client.put(f"/desks/{copy.desk_id}/people", headers=copy.owner,
                                                      json={"remove": ["dana"]}))
            await until_waiting(app, removing, pids)            # for Dana's session row, which T2 holds
        go_on.set()
        response, removed = await asyncio.wait_for(asyncio.gather(running, removing), timeout=5)
        assert removed.status_code == 200, removed.text
    else:
        await person_off_the_record(app, copy)
        go_on.set()
        response = await asyncio.wait_for(running, timeout=5)

    assert response.status_code == 200, response.text[:300]
    assert ExecResult.model_validate(response.json()).state == "succeeded"
    assert await execution_of(app, copy, allowed) == ("succeeded", "executed")
    assert len(await rows_of(app, copy.copy_id, select(Quote))) == 1
    executed = [entry.event.summary for entry in await ledger_rows(app, copy) if entry.event.kind == "execute"
                and entry.event.summary.get("decision_id") == allowed.decision_id]
    assert [summary["state"] for summary in executed] == ["executed"]
    after = await get_context(client, dana.session_id, dana.headers)
    assert (after.status_code, after.json()) == (409, {"code": "closed"})


async def test_a_reconciliation_stands_when_the_read_that_settled_it_is_refused(app, client, registry, frozen_clock,
                                                                                 monkeypatch):
    """A read settles an orphaned execution before it answers (`execute.refresh_decision`), asking
    the adapter what happened. That records what already happened, so it commits at once, as an
    execution's settling commit does: its Desk deleted while the read goes on, the read is 409
    `closed`, and the reconciliation stands."""
    quote, rows, visitor, allowed = await fake_quote_desk(app, client)
    await leave_an_intent(app, client, monkeypatch, "stored", visitor, allowed, rows.copy_id)
    frozen_clock.advance(31)                                    # no execution is running it now
    paused, go_on = asyncio.Event(), asyncio.Event()
    monkeypatch.setattr(execute, "reconcile_orphans", paused_after(execute.reconcile_orphans, paused, go_on))
    reading = asyncio.create_task(client.get(f"/decisions/{allowed.decision_id}", headers=visitor.headers))
    await asyncio.wait_for(paused.wait(), timeout=5)
    # the Desk is deleted while the read goes on, straight to its row (once the read's reconciliation commits it
    # holds no session row, so the route itself could close the session here too, as the closing tests below do)
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        [desk] = await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == rows.desk_id)))
        desk.deleted_at = ctx.clock.now()
    go_on.set()
    response = await asyncio.wait_for(reading, timeout=5)

    assert (response.status_code, response.json()) == (409, {"code": "closed"}), response.text[:300]
    assert quote.calls[-2:] == ["reconcile", "on_failed"]
    assert await committed(app, rows.copy_id, allowed.action.action_id) == ("failed", "failed")
    base = {"decision_id": allowed.decision_id, "action_id": allowed.action.action_id}
    assert [entry.event.summary for entry in await ledger_rows(app, rows) if entry.event.kind == "execute"] == [
        {**base, "state": "unknown", "orphaned": True}, {**base, "state": "failed", "reconciled": True}]


async def test_a_record_commits_whatever_happens_to_its_session(app, client, monkeypatch, frozen_clock):
    """`POST /ledger/append` records something that already happened in the API and answers only
    that entry, so no recheck takes it back: with the session closed right after its token was
    proved, the entry still commits and is answered, and the session's next read is 409 `closed`."""
    copy, visitor = await visitor_of(app, client)
    append, closing = ledger.append, {"armed": True}

    async def close_then_append(ctx, **kwargs):
        if closing["armed"]:
            closing["armed"] = False
            await set_session(app, copy, visitor.session_id, closed_at=frozen_clock.now())
        return await append(ctx, **kwargs)

    monkeypatch.setattr(ledger, "append", close_then_append)
    response = await append_api(client, copy.desk_id, visitor.headers, kind="rate_limit", origin="api",
                                session_id=visitor.session_id, summary={"limit": "visitor_message"})

    assert not closing["armed"]
    assert response.status_code == 200, response.text[:300]
    last = (await ledger_rows(app, copy))[-1].event
    assert (last.kind, last.session_id, last.summary) == ("rate_limit", visitor.session_id,
                                                         {"limit": "visitor_message"})
    after = await get_context(client, visitor.session_id, visitor.headers)
    assert (after.status_code, after.json()) == (409, {"code": "closed"})


NEW_CONTACT = {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield", "contact": "dana.w@example.net"}]}


async def closed_mid_read(client: httpx.AsyncClient, rows, monkeypatch, request: Callable[[], Awaitable[httpx.Response]]
                          ) -> httpx.Response:
    """`request`'s answer when the owner gives the session's person another contact (closing the session) right
    after the read's reconciliation commits: from then on the read holds no session row, so the write doesn't wait."""
    from .test_desk_writes import put_part
    paused, go_on = asyncio.Event(), asyncio.Event()
    monkeypatch.setattr(execute, "reconcile_orphans", paused_after(execute.reconcile_orphans, paused, go_on))
    task = asyncio.create_task(request())
    await asyncio.wait_for(paused.wait(), timeout=5)
    changed = await asyncio.wait_for(put_part(client, rows, "people", NEW_CONTACT), timeout=5)
    assert changed.status_code == 200, changed.text
    go_on.set()
    return await asyncio.wait_for(task, timeout=5)


async def verified_fake_quote_desk(app: FastAPI, client: httpx.AsyncClient):
    from .fakes import FakeAdapter
    from .helpers import verify_session
    from .test_approvals import add_person
    from .test_compiler import card
    from .test_decide import desk_with, open_visitor
    quote = FakeAdapter("native.quote")
    rows = await desk_with(app, [quote], [card("quote", "native.quote")])
    visitor = await open_visitor(client, rows)
    dana = await add_person(app, rows, "dana", "Dana Whitfield")
    await verify_session(app, rows.copy_id, visitor.session_id, dana)
    return quote, rows, visitor


async def test_a_cancel_closed_mid_read_answers_closed(app, client, registry, monkeypatch, frozen_clock):
    # after a cancel's reconciliation commits, a session the owner closed meanwhile is answered as closed,
    # never with its decision's state
    from desk.kernel_service.adapters.base import AdapterResult
    from desk.contracts import Claim, Fact
    from desk.kernel_service import labels
    from .test_decide import decided
    from .test_execute import leave_an_intent
    quote, rows, visitor = await verified_fake_quote_desk(app, client)
    allowed = await decided(client, visitor, "native.quote", {"qty": 1})
    await leave_an_intent(app, client, monkeypatch, "stored", visitor, allowed, rows.copy_id)
    frozen_clock.advance(31)                                    # no execution is running it now
    quote.script["reconcile"] = lambda xctx, action: AdapterResult(
        facts=[Fact(fact_id="quote:rec-1", kind="quote", status="available", source="kernel",
                    claims=[Claim(key="title", kind="text", value="a quote")],
                    label=labels.new_fact_label(xctx.session_row))], model_view={"ok": True})
    response = await closed_mid_read(client, rows, monkeypatch, lambda: client.post(
        f"/decisions/{allowed.decision_id}/cancel", headers=visitor.headers, json={"session_id": visitor.session_id}))
    assert (response.status_code, response.json()) == (409, {"code": "closed"})


async def test_a_retry_still_unknown_closed_mid_read_answers_closed(app, client, registry, monkeypatch, frozen_clock):
    # a retry of an unknown allow whose adapter still can't say: its reconciliation commits, the owner closes the
    # session, and the retry's refusal answers closed, not conflict
    from desk.kernel_service.adapters.base import AdapterUnknown
    from .test_decide import decided
    from .test_execute import executed, post_execute
    quote, rows, visitor = await verified_fake_quote_desk(app, client)
    allowed = await decided(client, visitor, "native.quote", {"qty": 1})
    quote.script["execute"] = RuntimeError("lost")
    assert (await executed(client, visitor, allowed)).state == "unknown"
    quote.script["reconcile"] = AdapterUnknown("still")
    frozen_clock.advance(1)                                     # the read writes last_seen_at, locking its row
    response = await closed_mid_read(client, rows, monkeypatch, lambda: post_execute(client, visitor, allowed))
    assert (response.status_code, response.json()) == (409, {"code": "closed"})
