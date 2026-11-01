"""Ledger reads, head checkpoints and the API's own entries."""

import asyncio
import hashlib
import json

import desk_kernel
import psycopg
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy import select

from desk.contracts import LedgerEntry, LedgerEvent, LedgerPage
from desk.db.models import DemoInboxEntry as DemoInboxRow
from desk.db.models import Desk
from desk.db.models import LedgerEntry as LedgerEntryRow
from desk.db.session import database_url, dispose_engines, libpq_url
from desk.kernel_service import auth, ledger
from desk.kernel_service.repo import new_id

from .helpers import kernel_ctx, ledger_rows, make_copy_rows, rows_of

GENESIS = "0" * 64


async def create_copy(client) -> dict:
    response = await client.post("/copies", json={})
    assert response.status_code == 200, response.text
    return response.json()


async def slug_of(app, copy_id: str, desk_id: str) -> str:
    [desk] = await rows_of(app, copy_id, select(Desk).where(Desk.desk_id == desk_id))
    return desk.slug


async def open_session(client, slug: str) -> dict:
    response = await client.post("/sessions", json={"desk_slug": slug, "kind": "visitor"})
    assert response.status_code == 200, response.text
    return response.json()


def attempt(n: int) -> LedgerEvent:
    return LedgerEvent(kind="auth", origin="kernel", summary={"route": "POST /decide", "reason": "bad_token", "n": n})


async def read_page(client, desk_id: str, owner_token: str):
    return await client.get(f"/ledger/{desk_id}", params={"verify": "true"}, headers={auth.OWNER_HEADER: owner_token})


async def test_owner_reads_a_verified_page(app, client, frozen_clock):
    copy = await create_copy(client)            # Desk, knowledge, tool pins, urgent tool, policy, held request
    [desk_id] = copy["desk_ids"]
    slug = await slug_of(app, copy["copy_id"], desk_id)
    for _ in range(2):
        frozen_clock.advance(1)
        await open_session(client, slug)        # a session entry each
    response = await read_page(client, desk_id, copy["owner_token"])
    assert response.status_code == 200, response.text
    page = LedgerPage.model_validate(response.json())
    signer = app.state.kernel.signer
    assert [entry.seq for entry in page.entries] == list(range(1, 13))
    assert [entry.event.kind for entry in page.entries] == [
        "desk_data", "desk_data", "desk_data", "tool_pin", "tool_pin", "business_tools", "policy", "tool_pin",
        "session", "decide", "session", "session"]
    assert {entry.desk_id for entry in page.entries} == {desk_id}
    assert (page.chain_ok, page.first_bad_seq) == (True, None)
    assert page.entries[0].prev_hash == GENESIS
    assert page.head == page.entries[-1].hash
    assert (page.public_key_hex, page.key_id) == (signer.public_key_hex(), signer.key_id())
    # the entries are the stored ones, field for field
    stored = await rows_of(app, copy["copy_id"], select(LedgerEntryRow).order_by(LedgerEntryRow.seq))
    assert [entry.model_dump() for entry in page.entries] == [
        LedgerEntry.model_validate(row, from_attributes=True).model_dump() for row in stored]
    # it always verifies, whatever the flag says
    response = await client.get(f"/ledger/{desk_id}", params={"verify": "false"},
                                headers={auth.OWNER_HEADER: copy["owner_token"]})
    assert (response.status_code, response.json()["chain_ok"]) == (200, True)
    # a page read while entries are being appended is a consistent snapshot, never a broken chain
    rows = await make_copy_rows(app)

    async def append_one(n: int) -> None:
        async with kernel_ctx(app) as ctx:
            await ledger.append(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, event=attempt(n))

    async def read_one() -> dict:
        response = await read_page(client, rows.desk_id, rows.owner_token)
        assert response.status_code == 200, response.text
        return response.json()

    await append_one(0)   # a Desk has its first entry from birth (create_desk's desk_data entry)
    results = await asyncio.gather(*(append_one(n) for n in range(1, 31)), *(read_one() for _ in range(15)))
    for snapshot in results[30:]:
        assert (snapshot["chain_ok"], snapshot["first_bad_seq"]) == (True, None), len(snapshot["entries"])
        assert snapshot["head"] == (snapshot["entries"][-1]["hash"] if snapshot["entries"] else GENESIS)
    # a Desk with no entries yet has an empty chain at genesis
    rows = await make_copy_rows(app)
    response = await read_page(client, rows.desk_id, rows.owner_token)
    assert response.status_code == 200, response.text
    assert {k: response.json()[k] for k in ("entries", "head", "chain_ok", "first_bad_seq")} == {
        "entries": [], "head": GENESIS, "chain_ok": True, "first_bad_seq": None}


ENVELOPE = ("copy_id", "desk_id", "seq", "prev_hash", "created_at", "event")


async def test_serialized_page_verifies_without_the_database(app, client, frozen_clock, tmp_path):
    copy = await create_copy(client)
    [desk_id] = copy["desk_ids"]
    slug = await slug_of(app, copy["copy_id"], desk_id)
    for _ in range(3):
        frozen_clock.advance(1)
        await open_session(client, slug)
    response = await read_page(client, desk_id, copy["owner_token"])
    assert response.status_code == 200, response.text
    saved = tmp_path / "ledger.json"
    saved.write_text(response.text)
    # close the database: what follows reads only the file
    await app.state.kernel.engine.dispose()
    await dispose_engines()
    page = LedgerPage.model_validate_json(saved.read_text())
    assert len(page.entries) == 13 and page.chain_ok                        # the copy's ten, then three sessions
    public_key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(page.public_key_hex))
    assert page.key_id == hashlib.sha256(bytes.fromhex(page.public_key_hex)).hexdigest()[:16]
    prev_hash = GENESIS
    for n, entry in enumerate(page.entries, start=1):
        dumped = entry.model_dump(mode="json")
        envelope_jcs = desk_kernel.canonical_json(json.dumps({field: dumped[field] for field in ENVELOPE}))
        assert entry.hash == desk_kernel.ledger_hash(envelope_jcs) == hashlib.sha256(envelope_jcs.encode()).hexdigest()
        assert (entry.seq, entry.prev_hash, entry.key_id) == (n, prev_hash, page.key_id)
        public_key.verify(bytes.fromhex(entry.signature), b"desk-ledger-v1\0" + bytes.fromhex(entry.hash))  # raises if bad
        prev_hash = entry.hash
    assert page.head == prev_hash
    entries_json = json.dumps([entry.model_dump(mode="json") for entry in page.entries])
    assert json.loads(desk_kernel.verify_chain(entries_json, page.public_key_hex)) == {"ok": True, "first_bad_seq": None}


def as_admin(sql: str, params: tuple) -> None:
    """Change kernel rows behind the kernel's back, as someone with the database's admin role could."""
    with psycopg.connect(libpq_url(database_url("ADMIN"))) as admin:
        assert admin.execute(sql, params).rowcount == 1


async def page_state(client, desk_id: str, owner_token: str) -> tuple[bool, int | None]:
    response = await read_page(client, desk_id, owner_token)
    assert response.status_code == 200, response.text
    return response.json()["chain_ok"], response.json()["first_bad_seq"]


async def test_tampering_names_the_first_bad_seq(app, client, frozen_clock):
    copy = await create_copy(client)
    [desk_id] = copy["desk_ids"]
    slug = await slug_of(app, copy["copy_id"], desk_id)
    for _ in range(3):
        frozen_clock.advance(1)
        await open_session(client, slug)
    assert await page_state(client, desk_id, copy["owner_token"]) == (True, None)
    # entry 7's summary (the rules' activation, after knowledge, tool pins and the urgent tool) edited
    # in place: the page shows it and says the chain breaks there
    edit = ("UPDATE kernel.ledger_entries SET event = jsonb_set(event, '{summary,status}', %s)"
            " WHERE desk_id = %s AND seq = 7")
    as_admin(edit, ('"draft"', desk_id))
    response = await read_page(client, desk_id, copy["owner_token"])
    assert response.json()["entries"][6]["event"]["summary"]["status"] == "draft"
    assert await page_state(client, desk_id, copy["owner_token"]) == (False, 7)
    as_admin(edit, ('"active"', desk_id))
    assert await page_state(client, desk_id, copy["owner_token"]) == (True, None)
    # the newest entry dropped: what's left still links, but the Desk's head names entry 13
    as_admin("DELETE FROM kernel.ledger_entries WHERE desk_id = %s AND seq = 13", (desk_id,))
    assert await page_state(client, desk_id, copy["owner_token"]) == (False, 13)


async def test_head_checkpoint_every_fifty_entries(app, client):
    rows = await make_copy_rows(app)
    inbox = select(DemoInboxRow)

    async def append_all(numbers) -> list[LedgerEntry]:
        async with kernel_ctx(app) as ctx:
            return [await ledger.append(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, event=attempt(n))
                    for n in numbers]

    await append_all(range(1, 50))
    assert await rows_of(app, rows.copy_id, inbox) == []
    # the 50th entry's checkpoint is part of its transaction: a rollback leaves neither
    with pytest.raises(RuntimeError):
        async with kernel_ctx(app) as ctx:
            await ledger.append(ctx, copy_id=rows.copy_id, desk_id=rows.desk_id, event=attempt(50))
            raise RuntimeError("the record that entry 50 describes failed")
    assert await rows_of(app, rows.copy_id, inbox) == []
    assert len(await ledger_rows(app, rows)) == 49
    [fiftieth] = await append_all([50])
    assert fiftieth.seq == 50                     # the caller gets its own entry back
    stored = await ledger_rows(app, rows)
    assert [entry.seq for entry in stored] == list(range(1, 52))
    [delivered] = await rows_of(app, rows.copy_id, inbox)
    assert (delivered.desk_id, delivered.to, delivered.person_id, delivered.kind, delivered.preview) == (
        rows.desk_id, "owner", None, "head_checkpoint", "Ledger checkpoint")
    signer = app.state.kernel.signer
    body = json.loads(delivered.body)
    assert body == {"desk_id": rows.desk_id, "seq": 50, "head": fiftieth.hash, "signature": fiftieth.signature,
                    "key_id": signer.key_id()}
    # the owner can check the signed head with the kernel's public key alone
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(signer.public_key_hex())).verify(
        bytes.fromhex(body["signature"]), b"desk-ledger-v1\0" + bytes.fromhex(body["head"]))
    checkpoint = stored[50]
    assert (checkpoint.event.kind, checkpoint.event.origin, checkpoint.event.session_id) == (
        "head_checkpoint", "kernel", None)
    assert checkpoint.event.summary == {"checkpoint_seq": 50, "entry_id": delivered.entry_id}
    assert checkpoint.prev_hash == fiftieth.hash
    # the next one follows entry 100, and the whole chain verifies
    appended = await append_all(range(51, 100))
    assert appended[-1].seq == 100
    stored = await ledger_rows(app, rows)
    assert len(stored) == 101
    assert [entry.seq for entry in stored if entry.event.kind == "head_checkpoint"] == [51, 101]
    assert stored[100].event.summary["checkpoint_seq"] == 100
    # (the frozen clock gives both the same time)
    assert sorted(json.loads(entry.body)["seq"] for entry in await rows_of(app, rows.copy_id, inbox)) == [50, 100]
    page = (await read_page(client, rows.desk_id, rows.owner_token)).json()
    assert (page["chain_ok"], page["head"]) == (True, stored[100].hash)


async def append_api(client, desk_id: str, headers: dict, **event):
    return await client.post("/ledger/append", json={"desk_id": desk_id, "event": event}, headers=headers)


async def test_api_entries_are_limited_to_three_kinds(app, client):
    rows = await make_copy_rows(app)
    visitor = await open_session(client, rows.slug)
    session_id, as_visitor = visitor["state"]["session_id"], {auth.SESSION_HEADER: visitor["session_token"]}
    # an entry the API sends as the kernel's is stored as the API's: it is recorded as reported
    response = await append_api(client, rows.desk_id, as_visitor, kind="rate_limit", origin="kernel",
                                session_id=session_id, summary={"limit": "visitor_message"})
    assert response.status_code == 200, response.text
    entry = LedgerEntry.model_validate(response.json())
    assert (entry.seq, entry.desk_id, entry.copy_id) == (2, rows.desk_id, rows.copy_id)
    assert entry.event == LedgerEvent(kind="rate_limit", origin="api", session_id=session_id,
                                      summary={"limit": "visitor_message"})
    stored = await ledger_rows(app, rows)
    assert LedgerEntry.model_validate(stored[-1], from_attributes=True) == entry
    # the other two kinds, under the session's token or the owner's
    for kind, headers in (("session", as_visitor), ("agent_auth", as_visitor), ("rate_limit", rows.owner)):
        response = await append_api(client, rows.desk_id, headers, kind=kind, origin="api", summary={"limit": "proxy"})
        assert (response.status_code, response.json()["event"]["origin"]) == (200, "api"), (kind, response.text)
    written = len(await ledger_rows(app, rows))
    # any other kind is refused, whatever origin it claims
    for kind in ("decide", "approval", "auth", "policy", "head_checkpoint", "desk_data"):
        for origin in ("api", "kernel"):
            response = await append_api(client, rows.desk_id, as_visitor, kind=kind, origin=origin, summary={})
            assert (response.status_code, response.json()) == (422, {"code": "invalid"}), (kind, origin)
    # check_summary applies, and what can't be hashed or stored is refused rather than failing later
    for unsafe in ({"summary": {"contact": "(510) 555-0177"}}, {"summary": {"note": "dana@example.com"}},
                   {"summary": {"limit": "proxy", "nested": {"Token": "t"}}}, {"summary": {"retry_after": 1.5}},
                   {"summary": {"limit": "nul\x00"}}, {"summary": {"limit\x00": "proxy"}},
                   {"summary": {}, "ref_id": "dana@example.com"}, {"summary": {}, "ref_id": "x" * 65}):
        response = await append_api(client, rows.desk_id, as_visitor, kind="rate_limit", origin="api", **unsafe)
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), unsafe
    lone_surrogate = ('{"desk_id": "%s", "event": {"kind": "rate_limit", "origin": "api", "summary": {"limit": "\\ud800"}}}'
                      % rows.desk_id)
    response = await client.post("/ledger/append", content=lone_surrogate.encode(),
                                 headers={**as_visitor, "content-type": "application/json"})
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert len(await ledger_rows(app, rows)) == written


async def add_desk(app, rows) -> str:
    """A second Desk in `rows`' copy."""
    desk_id = new_id("desk")
    async with kernel_ctx(app) as ctx:
        ctx.bind(rows.copy_id)
        ctx.db.add(Desk(desk_id=desk_id, copy_id=rows.copy_id, business_id=rows.business_id, name="Second line",
                        slug=f"second-line-{desk_id[-6:]}", created_at=ctx.clock.now()))
    return desk_id


async def test_api_entries_name_their_own_session_and_desk(app, client):
    a, b = await make_copy_rows(app), await make_copy_rows(app)
    second_desk = await add_desk(app, a)
    visitor, other = await open_session(client, a.slug), await open_session(client, a.slug)
    session_id, as_visitor = visitor["state"]["session_id"], {auth.SESSION_HEADER: visitor["session_token"]}
    rate_limit = {"kind": "rate_limit", "origin": "api", "summary": {"limit": "proxy"}}

    def refused(reason: str, session: str | None) -> LedgerEvent:
        return LedgerEvent(kind="auth", origin="kernel", session_id=session,
                           summary={"route": "POST /ledger/append", "reason": reason})

    # a session's token writes only to its own Desk; a refusal goes on that Desk's ledger
    for desk_id in (b.desk_id, second_desk, "desk-unknown"):
        response = await append_api(client, desk_id, as_visitor, **rate_limit)
        assert (response.status_code, response.json()) == (404, {"code": "not_found"}), desk_id
        assert (await ledger_rows(app, a))[-1].event == refused("wrong_copy", session_id)
    # and names only its own session
    response = await append_api(client, a.desk_id, as_visitor, **rate_limit, session_id=other["state"]["session_id"])
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    assert (await ledger_rows(app, a))[-1].event == refused("wrong_session", session_id)
    for named in (session_id, None):
        response = await append_api(client, a.desk_id, as_visitor, **rate_limit, session_id=named)
        assert (response.status_code, response.json()["event"]["session_id"]) == (200, named)
    # the owner's token writes to any Desk of its copy, naming the owner session or none
    for desk_id, named in ((a.desk_id, None), (second_desk, a.owner_session_id)):
        response = await append_api(client, desk_id, a.owner, **rate_limit, session_id=named)
        assert (response.status_code, response.json()["desk_id"]) == (200, desk_id), response.text
    response = await append_api(client, b.desk_id, a.owner, **rate_limit)
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    response = await append_api(client, a.desk_id, a.owner, **rate_limit, session_id=session_id)
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    assert (await ledger_rows(app, a))[-1].event == refused("wrong_session", a.owner_session_id)
    assert await ledger_rows(app, b) == []
    # a bad token is 401, and writes nothing
    written = len(await ledger_rows(app, a))
    for headers in ({auth.SESSION_HEADER: "not-a-token"}, {auth.OWNER_HEADER: "not-a-token"},
                    {auth.SESSION_HEADER: a.owner_token}, {auth.OWNER_HEADER: visitor["session_token"]},
                    {**as_visitor, **a.owner}, {}):
        response = await append_api(client, a.desk_id, headers, **rate_limit)
        assert (response.status_code, response.json()) == (401, {"code": "auth"}), headers
    assert len(await ledger_rows(app, a)) == written


async def test_ledger_needs_the_owner_of_the_copy(app, client, caplog):
    a, b = await make_copy_rows(app), await make_copy_rows(app)
    visitor = await open_session(client, a.slug)
    response = await read_page(client, a.desk_id, a.owner_token)
    assert (response.status_code, len(response.json()["entries"])) == (200, 1)
    # another copy's owner, or an unknown Desk, finds nothing
    for desk_id, token in ((a.desk_id, b.owner_token), ("desk-unknown", a.owner_token)):
        response = await read_page(client, desk_id, token)
        assert (response.status_code, response.json()) == (404, {"code": "not_found"}), desk_id
    # a visitor's token, a wrong token or none is refused
    for headers in ({auth.SESSION_HEADER: visitor["session_token"]}, {auth.OWNER_HEADER: visitor["session_token"]},
                    {auth.OWNER_HEADER: "not-a-token"}, {}):
        response = await client.get(f"/ledger/{a.desk_id}", params={"verify": "true"}, headers=headers)
        assert (response.status_code, response.json()) == (401, {"code": "auth"}), headers
    # reading writes nothing, and no refusal reaches a ledger the caller couldn't read
    assert len(await ledger_rows(app, a)) == 1 and await ledger_rows(app, b) == []
    assert "auth_unattributed" in caplog.text
