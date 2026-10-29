"""Test helpers: kernel rows and contexts outside a request."""

from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass

import httpx
from fastapi import FastAPI
from sqlalchemy import func, select

from desk.contracts import NotificationDefaults, PolicyVersion, RuleCard
from desk.db.models import ActorSession, Business, Copy, Desk, LedgerEntry, NotificationPref
from desk.db.models import PolicyVersion as PolicyVersionRow
from desk.kernel_service import activation, auth, compiler, desks
from desk.kernel_service.repo import KernelCtx, kernel_transaction, new_id

NOTIFICATIONS = NotificationDefaults(now=["approval", "emergency", "breaker"], briefing=["lead", "callback", "booking"])


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
    rows = CopyRows(copy_id=copy_id, business_id=new_id("biz"), desk_id=desk_id, slug=f"rivera-plumbing-{desk_id[-6:]}",
                    owner_session_id=auth.new_session_id(), owner_token=auth.new_token())
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        now = ctx.clock.now()
        ctx.db.add_all([
            Copy(copy_id=rows.copy_id, created_at=now),
            Business(business_id=rows.business_id, copy_id=rows.copy_id, name="Rivera Plumbing",
                     owner_display_name="Maria Rivera", timezone="America/Los_Angeles"),
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


async def ledger_rows(app: FastAPI, rows: CopyRows) -> list[LedgerEntry]:
    return await rows_of(app, rows.copy_id,
                         select(LedgerEntry).where(LedgerEntry.desk_id == rows.desk_id).order_by(LedgerEntry.seq))


async def activate_cards(ctx: KernelCtx, desk_id: str, cards: list[RuleCard]) -> PolicyVersionRow:
    """Test only: compiles `cards` over the Desk's enabled profiles and stores them as its active
    version, with no proof, superseding the version that was active. Decisions then run on it as
    on any active version; nothing outside tests ever activates a version without a proof."""
    profiles = await desks.enabled_profiles(ctx, desk_id)
    schema = compiler.desk_schema(profiles)
    compiled = compiler.compile_cards(cards, profiles)
    current = await activation.active_version(ctx, desk_id)
    if current is not None:
        current.status = "superseded"
        await ctx.db.flush()                  # one active version per Desk
    latest = (await ctx.db.scalars(ctx.repo.scoped(
        select(func.max(PolicyVersionRow.version)).where(PolicyVersionRow.desk_id == desk_id)))).one()
    row = activation.version_row(
        copy_id=ctx.copy_id, desk_id=desk_id, version=(latest or 0) + 1,
        parent_version=current.version if current is not None else None, compiled=compiled,
        a0=compiler.compile_cards(cards, profiles, review=False).A, schema=schema,
        hashes=activation.version_hashes(compiled, schema, profiles, cards=cards), status="active", proof=None,
        created_at=ctx.clock.now())
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


async def draft_and_confirm(client: httpx.AsyncClient, owner_token: str, desk_id: str,
                            cards: list[RuleCard]) -> PolicyVersion:
    """Drafts `cards` on the Desk's active version and confirms them, as the owner app does; the
    draft has to prove, so the kernel needs `symcc` mode (the `desk_prove` fixture, or a stub)."""
    headers = {auth.OWNER_HEADER: owner_token}
    parent = await active_version_number(client, owner_token, desk_id)
    response = await client.post("/policy/draft", headers=headers, json={
        "desk_id": desk_id, "cards": [card.model_dump(mode="json") for card in cards], "expected_parent": parent})
    assert response.status_code == 200, response.text
    drafted = PolicyVersion.model_validate(response.json())
    assert drafted.status == "proved", drafted.proof
    response = await client.post("/policy/confirm", headers=headers, json={"desk_id": desk_id,
                                                                          "version": drafted.version})
    assert response.status_code == 200, response.text
    return PolicyVersion.model_validate(response.json())
