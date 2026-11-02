"""Test helpers: kernel rows and contexts outside a request, and the lock waits a test waits for."""

import asyncio
import contextlib
import re
from collections.abc import Collection, Iterator
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import event, func, select, text

from desk.contracts import NotificationDefaults, PolicyVersion, RuleCard, ToolProfile
from desk.db.models import ActorSession, Business, Copy, Desk, Lead, LedgerEntry, NotificationPref
from desk.db.models import PolicyVersion as PolicyVersionRow
from desk.kernel_service import activation, auth, compiler, desks
from desk.kernel_service.repo import KernelCtx, kernel_transaction, new_id

NOTIFICATIONS = NotificationDefaults(now=["approval", "emergency", "breaker"], briefing=["lead", "callback", "booking"])
# The money cap Plan 01a's tests were written for: $500, as every Desk was held to before the cap
# moved onto each rules version. The production keyword stays required; these helpers default to it.
TEST_CAP = 50_000


def compile_at(cards: list[RuleCard], profiles: list[ToolProfile], *, cap: int = TEST_CAP,
               **kwargs) -> compiler.CompiledSets:
    """`compiler.compile_cards` at the money cap `cap` ($500 unless given)."""
    return compiler.compile_cards(cards, profiles, auto_money_cap_cents=cap, **kwargs)


def context(**attrs) -> dict:
    """A Cedar request context: `attrs`, with `auto_money_cap_cents` at $500 unless given."""
    return {"auto_money_cap_cents": TEST_CAP, **attrs}


def draft_refusals(caplog: pytest.LogCaptureFixture) -> list[str]:
    """The reasons the kernel logged for the drafts it refused, in order."""
    return [match.group(1) for record in caplog.records
            if (match := re.fullmatch(r"kernel_failure route=POST /policy/draft status=422 code=invalid reason=(\S+)",
                                      record.getMessage()))]


@dataclass(frozen=True)
class CopyRows:
    copy_id: str
    business_id: str
    desk_id: str
    slug: str
    owner_session_id: str
    owner_token: str                      # sent as X-Owner-Session

    @property
    def owner(self) -> dict[str, str]:
        return {auth.OWNER_HEADER: self.owner_token}


def kernel_ctx(app: FastAPI) -> AbstractAsyncContextManager[KernelCtx]:
    """A context on a new transaction, committed at the end of the block (rolled back on an exception)."""
    return kernel_transaction(app.state.kernel)


async def make_copy_rows(app: FastAPI, *, notifications: NotificationDefaults = NOTIFICATIONS) -> CopyRows:
    """A committed copy with a business, one Desk, its notification defaults and the copy's owner
    session (as `POST /copies` opens it), whose token the rows carry."""
    copy_id, desk_id = new_id("copy"), new_id("desk")
    rows = CopyRows(copy_id=copy_id, business_id=new_id("biz"), desk_id=desk_id, slug=f"turner-plumbing-{desk_id[-6:]}",
                    owner_session_id=auth.new_session_id(), owner_token=auth.new_token())
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        now = ctx.clock.now()
        ctx.db.add_all([
            Copy(copy_id=rows.copy_id, created_at=now),
            Business(business_id=rows.business_id, copy_id=rows.copy_id, name="Turner Plumbing",
                     owner_display_name="Mike Turner", timezone="America/Los_Angeles"),
            Desk(desk_id=rows.desk_id, copy_id=rows.copy_id, business_id=rows.business_id, name="Main line",
                 slug=rows.slug, created_at=now),
            NotificationPref(desk_id=rows.desk_id, copy_id=rows.copy_id, now=notifications.now,
                             briefing=notifications.briefing),
            ActorSession(session_id=rows.owner_session_id, copy_id=rows.copy_id, desk_id=None, kind="owner",
                         secret_hash=auth.hash_token(rows.owner_token), verified=True, assurance="owner_session",
                         created_at=now, last_seen_at=now),
        ])
    return rows


async def rows_of(app: FastAPI, copy_id: str, stmt) -> list:
    """The committed rows a SELECT finds in a copy, through KernelRepo.scoped()."""
    async with kernel_ctx(app) as ctx:
        repo = ctx.bind(copy_id)
        return list((await ctx.db.scalars(repo.scoped(stmt))).all())


async def verify_session(app: FastAPI, copy_id: str, session_id: str, person_id: str) -> None:
    """Test only: marks a visitor session verified as `person_id`, as `POST /verify/check` (Plan
    01b) records a correct code: the person bound to the session, assurance `demo_code`."""
    async with kernel_ctx(app) as ctx:
        repo = ctx.bind(copy_id)
        row = (await ctx.db.scalars(repo.scoped(select(ActorSession).where(
            ActorSession.session_id == session_id)))).one()
        row.person_id, row.assurance, row.verified = person_id, "demo_code", True


async def save_lead(app: FastAPI, rows: CopyRows, session_id: str, *, name: str | None = "Jane Doe",
                    contact: str | None = "jane@example.com") -> None:
    """Test only: the lead `native.capture_lead` saves for a session, with the visitor's name and
    contact (its note is the contact, as `capture_lead.lead_note` writes it), so the session may book."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        ctx.db.add(Lead(lead_id=new_id("lead"), copy_id=rows.copy_id, desk_id=rows.desk_id, session_id=session_id,
                        display_name=name, note=contact, created_at=ctx.clock.now()))


async def ledger_rows(app: FastAPI, rows: CopyRows) -> list[LedgerEntry]:
    return await rows_of(app, rows.copy_id,
                         select(LedgerEntry).where(LedgerEntry.desk_id == rows.desk_id).order_by(LedgerEntry.seq))


async def activate_cards(ctx: KernelCtx, desk_id: str, cards: list[RuleCard], *,
                         auto_money_cap_cents: int = TEST_CAP) -> PolicyVersionRow:
    """Test only: compiles `cards` over the Desk's enabled profiles at the money cap
    `auto_money_cap_cents` ($500 unless given) and stores them as its active version, with no
    proof, superseding the version that was active. Decisions then run on it as on any active
    version; nothing outside tests ever activates a version without a proof."""
    cap = auto_money_cap_cents
    profiles = await desks.enabled_profiles(ctx, desk_id)
    schema = compiler.desk_schema(profiles)
    compiled = compiler.compile_cards(cards, profiles, auto_money_cap_cents=cap)
    current = await activation.active_version(ctx, desk_id)
    if current is not None:
        current.status = "superseded"
        await ctx.db.flush()                  # one active version per Desk
    latest = (await ctx.db.scalars(ctx.repo.scoped(
        select(func.max(PolicyVersionRow.version)).where(PolicyVersionRow.desk_id == desk_id)))).one()
    row = activation.version_row(
        copy_id=ctx.copy_id, desk_id=desk_id, version=(latest or 0) + 1,
        parent_version=current.version if current is not None else None, compiled=compiled,
        a0=compiler.compile_cards(cards, profiles, auto_money_cap_cents=cap, review=False).A, schema=schema,
        hashes=activation.version_hashes(compiled, schema, profiles, cards=cards, auto_money_cap_cents=cap),
        auto_money_cap_cents=cap, status="active", proof=None, created_at=ctx.clock.now())
    ctx.db.add(row)
    await ctx.db.flush()
    return row


async def active_version_number(client: httpx.AsyncClient, owner_token: str, desk_id: str) -> int | None:
    """The Desk's active version, as its safety ledger records it: the last `policy` entry that
    activated one (a new Desk's first version, then each confirm)."""
    response = await client.get(f"/ledger/{desk_id}", headers={auth.OWNER_HEADER: owner_token})
    assert response.status_code == 200, response.text
    active = None
    for entry in response.json()["entries"]:
        event = entry["event"]
        summary = event["summary"]
        if event["kind"] == "policy" and (summary.get("status") == "active" or summary.get("activated")):
            active = summary["version"]
    return active


async def draft_and_confirm(client: httpx.AsyncClient, owner_token: str, desk_id: str, cards: list[RuleCard], *,
                            auto_money_cap_cents: int | None = None) -> PolicyVersion:
    """Drafts `cards` on the Desk's active version, at the money cap `auto_money_cap_cents` (None:
    the active version's), and confirms them, as the owner app does; the draft has to prove, so the
    kernel needs `symcc` mode (the `desk_prove` fixture, or a stub)."""
    headers = {auth.OWNER_HEADER: owner_token}
    parent = await active_version_number(client, owner_token, desk_id)
    body = {"desk_id": desk_id, "cards": [card.model_dump(mode="json") for card in cards], "expected_parent": parent}
    if auto_money_cap_cents is not None:
        body["auto_money_cap_cents"] = auto_money_cap_cents
    response = await client.post("/policy/draft", headers=headers, json=body)
    assert response.status_code == 200, response.text
    drafted = PolicyVersion.model_validate(response.json())
    assert drafted.status == "proved", drafted.proof
    response = await client.post("/policy/confirm", headers=headers, json={"desk_id": desk_id,
                                                                          "version": drafted.version})
    assert response.status_code == 200, response.text
    return PolicyVersion.model_validate(response.json())


# ---- Lock waits ---------------------------------------------------------------------------------

@contextlib.contextmanager
def connections_of(app: FastAPI) -> Iterator[set[int]]:
    """The server PIDs of the kernel app's connections checked out while the block runs: the ones
    this test's requests use."""
    pids: set[int] = set()

    def checked_out(dbapi_connection, connection_record, connection_proxy) -> None:
        pids.add(dbapi_connection.driver_connection.info.backend_pid)

    engine = app.state.kernel.engine.sync_engine
    event.listen(engine, "checkout", checked_out)
    try:
        yield pids
    finally:
        event.remove(engine, "checkout", checked_out)


async def lock_waiters(app: FastAPI, pids: Collection[int], table: str | None = "kernel.sessions") -> int:
    """How many of the connections `pids` are waiting on a lock now: for a row of `table`, or for
    any lock when `table` is None (an insert waiting to learn whether its key is taken holds no
    row's lock). A backend waiting for a row holds or waits for that row's tuple lock, which
    `pg_locks` shows on the row's table."""
    relation = "" if table is None else (
        "AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND l.locktype = 'tuple' "
        "AND l.relation = to_regclass(:table))")
    async with app.state.kernel.engine.connect() as conn:
        return (await conn.execute(text(
            f"SELECT count(*) FROM pg_stat_activity a WHERE a.wait_event_type = 'Lock' AND a.pid = ANY(:pids) {relation}"),
            {"pids": sorted(pids), "table": table})).scalar_one()


async def until_waiting(app: FastAPI, task: asyncio.Task, pids: Collection[int], table: str | None = "kernel.sessions",
                        timeout: float = 5.0) -> None:
    """Returns once `task` has answered or one of the connections `pids` waits on a lock: for a
    row of `table`, or any lock when `table` is None."""
    deadline = asyncio.get_running_loop().time() + timeout
    while not task.done() and await lock_waiters(app, pids, table) == 0:
        assert asyncio.get_running_loop().time() < deadline, "nothing waited on a lock"
        await asyncio.sleep(0.01)
