"""Releasing a document to its verified record owner by a single-use link.

`native.release_document` shares one of the Desk's documents with the person it belongs to. A
visitor who has confirmed who they are asks for it by ID; Cedar's baseline lets private data go
only to the verified record owner, and the execution writes a `document_links` row that opens once
within a day (`GET /document_links/{token}`, which the API proxies at `/api/d/{token}`). The token
stays in that table: Claude is told only that the link is ready, and the visitor sees it only in
the `href` of a signed `document_link` card.

Tests run on Turner Plumbing copies as `POST /copies` seeds them (Friday 10:04 in Oakland), where
`rv-docs` auto-allows a record owner's own documents. Visitors confirm who they are with the code
from their Demo inbox, as the verify card does.
"""

import asyncio
import hashlib
import logging
import re
import secrets
from datetime import timedelta
from types import SimpleNamespace

import httpx
import psycopg
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import Claim, Clause, Fact, Label, ReplyDraft, ReplyVerdict
from desk.db.models import ActorSession, Document, DocumentLink
from desk.db.models import Fact as FactRow
from desk.db.tables import KERNEL_RO_VIEWS
from desk.kernel_service import adapters, compiler, reply_check
from desk.kernel_service.adapters import release_document

from .helpers import connections_of, kernel_ctx, ledger_rows, rows_of, until_waiting
from .test_adapters import Rivera, objects, rivera, run
from .test_context import context_of, fact_ids, tools
from .test_decide import Visitor, decided, open_visitor
from .test_desk_writes import put_part, updated
from .test_execute import executed
from .test_reply_check import assert_handed_off, checked, clause, keep_alive_until
from .test_verification import api_rows, check, code_in, entry_of, session_inbox, started

TOOL = "native.release_document"
DANA, BOB = "dana@example.com", "bob@example.com"      # the contacts on record in the Turner seed


async def confirmed(client: httpx.AsyncClient, copy: Rivera, contact: str) -> Visitor:
    """A new visitor on the copy who confirms they are the person on record at `contact`, with
    the code their Demo inbox shows for this start (the person's earlier codes are there too)."""
    visitor = await open_visitor(client, copy)
    [notice] = (await started(client, visitor, contact)).inbox
    response = await check(client, visitor, code_in(await entry_of(client, visitor, notice)))
    assert response.status_code == 200, response.text
    return visitor


async def documents(app: FastAPI, copy: Rivera) -> dict[str, Document]:
    """The copy's documents, by their seed ref."""
    return {row.ref: row for row in await rows_of(app, copy.copy_id, select(Document))}


async def test_input_schema_is_closed(app, client):
    adapter = adapters.ADAPTERS[TOOL]
    profile = adapter.profile
    schema = profile.input_schema
    assert schema == adapter.Args.model_json_schema()
    assert objects(schema) and all(obj.get("additionalProperties") is False for obj in objects(schema))
    assert schema["properties"]["document_id"]["maxLength"] == 64
    assert (profile.source, profile.status, profile.resource_kind, profile.reversible) == (
        "native", "enabled", "document", False)
    # the effects Claude's profile declares are the ones Cedar groups the action under
    action = compiler.desk_schema([])[""]["actions"][TOOL]
    assert sorted(profile.effects) == sorted(m["id"].removeprefix("effect:") for m in action["memberOf"]) == [
        "private_data", "send_message"]
    assert action["appliesTo"]["resourceTypes"] == ["Document"]
    assert "records" in profile.description_confirmed and "card" in profile.description_confirmed
    assert adapter.free_text_fields == frozenset()        # a document ID, never the visitor's words
    assert adapter.model_view_keys == {"fact_id", "title", "link_ready"}

    copy = await rivera(app, client)
    invoice = (await documents(app, copy))["dana-invoice"]
    dana = await confirmed(client, copy, DANA)
    # an argument the schema doesn't name is refused before any action exists, as is an ID too long
    for call_id, args in (("call-1", {"document_id": invoice.document_id, "email": "someone@example.com"}),
                          ("call-2", {}), ("call-3", {"document_id": "d" * 65}),
                          ("call-4", {"document_id": 7})):
        refused = await decided(client, dana, TOOL, args, call_id=call_id)
        assert (refused.outcome, refused.action) == ("refuse", None), args
    # the same call without it is an action, resolved to the document and its record owner
    allowed = await decided(client, dana, TOOL, {"document_id": invoice.document_id}, call_id="call-5")
    assert allowed.action is not None
    assert (allowed.action.resource.kind, allowed.action.resource.id, allowed.action.resource.owner_person_id,
            allowed.action.recipient) == ("document", invoice.document_id, invoice.record_owner_person_id,
                                          "verified_contact")


async def links(app: FastAPI, copy: Rivera) -> list[DocumentLink]:
    return await rows_of(app, copy.copy_id, select(DocumentLink).order_by(DocumentLink.created_at))


async def link_entries(app: FastAPI, copy: Rivera) -> list[tuple[str | None, dict]]:
    """The `document_link` ledger entries: the session each names and its summary, in order."""
    return [(entry.event.session_id, entry.event.summary) for entry in await ledger_rows(app, copy)
            if entry.event.kind == "document_link"]


async def released(client: httpx.AsyncClient, visitor: Visitor, document: Document, call_id: str = "call-1") -> Fact:
    """The document released to the visitor, its record owner (`rv-docs`), decided and executed:
    the link's fact."""
    decision = await decided(client, visitor, TOOL, {"document_id": document.document_id}, call_id=call_id)
    assert (decision.outcome, decision.card_ids) == ("allow", ["rv-docs"]), decision.reason_plain
    [fact] = (await executed(client, visitor, decision)).facts
    return fact


async def test_record_owner_gets_one_link(app, client, frozen_clock):
    copy = await rivera(app, client)
    invoice = (await documents(app, copy))["dana-invoice"]
    dana_id = invoice.record_owner_person_id
    dana = await confirmed(client, copy, DANA)
    decision = await decided(client, dana, TOOL, {"document_id": invoice.document_id})
    assert (decision.outcome, decision.state, decision.card_ids) == ("allow", "allowed", ["rv-docs"]), \
        decision.reason_plain
    result = await executed(client, dana, decision)

    # one link, to Dana alone, for a day
    [link] = await links(app, copy)
    now = frozen_clock.now()
    assert release_document.LINK_TTL == timedelta(hours=24)
    assert (link.desk_id, link.document_id, link.session_id, link.person_id) == (
        copy.desk_id, invoice.document_id, dana.session_id, dana_id)
    assert (link.created_at, link.expires_at, link.consumed_at, link.voided_at) == (
        now, now + release_document.LINK_TTL, None, None)
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", link.token)               # secrets.token_urlsafe(32)
    # looked up by its sha256 before the copy is known, as a session's token is
    assert link.token_sha256 == hashlib.sha256(link.token.encode()).hexdigest()

    # the fact names the link by its ID and holds the title: Dana's and the owner's to read, from any
    # session Dana confirms in, and no one else's
    fact_id = f"document_link:{link.link_id}"
    assert result.state == "succeeded"
    assert result.facts == [Fact(
        fact_id=fact_id, kind="document", status="available", source="kernel",
        claims=[Claim(key="title", kind="text", value=invoice.title), Claim(key="ref", kind="ref", value=link.link_id)],
        label=Label(readers=["owner", f"person:{dana_id}"], record_owner=dana_id), expires_at=link.expires_at)]
    [row] = await rows_of(app, copy.copy_id, select(FactRow).where(FactRow.fact_id == fact_id))
    assert (row.session_id, row.action_id) == (dana.session_id, decision.action.action_id)
    assert fact_id in fact_ids((await context_of(client, dana.session_id, dana.headers)).facts)
    stranger = await open_visitor(client, copy)
    assert fact_id not in fact_ids((await context_of(client, stranger.session_id, stranger.headers)).facts)

    # Claude learns the link is ready, never the token, the canary or the document's text
    assert (result.model_view, result.inbox) == ({"fact_id": fact_id, "title": invoice.title, "link_ready": True}, [])
    shown = result.model_dump_json()
    assert link.token not in shown and invoice.canary not in shown and "Paid in full" not in shown

    # ledgered by IDs, in the execution's transaction
    assert await link_entries(app, copy) == [
        (dana.session_id, {"link_id": link.link_id, "document_id": invoice.document_id, "issued": True})]

    # reconciling the action finds the same link, and executing it again makes no other
    reconciled = await run(app, copy.copy_id, decision, "reconcile")
    assert (reconciled.facts, reconciled.model_view) == (result.facts, result.model_view)
    assert await executed(client, dana, decision) == result
    assert len(await links(app, copy)) == 1


async def open_link(client: httpx.AsyncClient, token: str) -> httpx.Response:
    """What the API asks when a visitor follows `/api/d/{token}`."""
    return await client.get(f"/document_links/{token}")


async def fact_row(app: FastAPI, copy: Rivera, fact_id: str) -> FactRow:
    [row] = await rows_of(app, copy.copy_id, select(FactRow).where(FactRow.fact_id == fact_id))
    return row


def violations(verdict) -> list[tuple[str, str, list[str]]]:
    return [(violation.kind, violation.rule_id, violation.fact_ids) for violation in verdict.violations]


async def test_link_opens_once(app, client, frozen_clock):
    copy = await rivera(app, client)
    invoice = (await documents(app, copy))["dana-invoice"]
    dana = await confirmed(client, copy, DANA)
    fact = await released(client, dana, invoice)
    [link] = await links(app, copy)

    # the first open gets the document as the owner uploaded it, its canary included
    frozen_clock.advance(60)
    opened = await open_link(client, link.token)
    assert opened.status_code == 200, opened.text
    assert opened.headers["content-type"] == "text/plain; charset=utf-8"
    assert opened.headers["cache-control"] == "no-store"
    # read as text alone, followed to nowhere, and named from its title, shown rather than saved
    assert opened.headers["x-content-type-options"] == "nosniff"
    assert opened.headers["referrer-policy"] == "no-referrer"
    assert opened.headers["content-disposition"] == 'inline; filename="Invoice-drain-clearing.txt"'
    assert opened.content == invoice.body.encode()
    [link] = await links(app, copy)
    assert link.consumed_at == frozen_clock.now()

    # and it is spent: the second gets what an unknown token gets
    again = await open_link(client, link.token)
    assert (again.status_code, again.json()["code"]) == (404, "not_found")
    assert (await links(app, copy))[0].consumed_at == link.consumed_at
    assert await link_entries(app, copy) == [
        (dana.session_id, {"link_id": link.link_id, "document_id": invoice.document_id, "issued": True}),
        (dana.session_id, {"link_id": link.link_id, "opened": True}),
        (dana.session_id, {"link_id": link.link_id, "refused": True})]

    # its fact expired as it opened, so citing the link now hands the reply to Mike
    assert (await fact_row(app, copy, fact.fact_id)).status == "expired"
    verdict = await checked(client, dana, "Here is your invoice.", [clause("document_link", fact.fact_id)])
    assert violations(verdict) == [("stale_fact", "not_current", [fact.fact_id])]
    assert_handed_off(verdict)


async def test_a_document_is_named_from_its_title_alone(app, client):
    # a title with quotes, a slash, a line break, accents and an emoji names the file in plain
    # ASCII letters, digits and hyphens, so nothing in it can end the header or start another
    copy = await rivera(app, client)
    response = await client.post("/documents", headers=copy.owner, json={"desk_id": copy.desk_id, "document": {
        "ref": "dana-receipt", "title": 'Factura "Ñandú" / nº 7\r\nSet-Cookie: x=1 🙂', "body": "Pagado.",
        "record_owner_ref": "dana"}})
    assert response.status_code == 200, response.text
    dana = await confirmed(client, copy, DANA)
    await released(client, dana, (await documents(app, copy))["dana-receipt"])
    [link] = await links(app, copy)
    opened = await open_link(client, link.token)
    assert opened.status_code == 200, opened.text
    assert opened.headers["content-disposition"] == 'inline; filename="Factura-Nandu-no-7-Set-Cookie-x-1.txt"'

    # the same rule for any title: at most sixty characters before `.txt`, and a plain name when
    # no letter or digit is left
    for title, name in (("Invoice, drain clearing", "Invoice-drain-clearing.txt"),
                        ("../../etc/passwd", "etc-passwd.txt"), ("Ｗａｒｒａｎｔｙ", "Warranty.txt"),
                        ("請求書", "document.txt"), ("", "document.txt"), (None, "document.txt"),
                        ("a" * 100, "a" * 60 + ".txt"), ("x" * 59 + " y", "x" * 59 + ".txt")):
        got = release_document.download_name(title)
        assert got == name, title
        assert re.fullmatch(r"[A-Za-z0-9-]{1,60}\.txt", got), title


async def test_link_expires_after_a_day(app, client, frozen_clock):
    copy = await rivera(app, client)
    invoice = (await documents(app, copy))["dana-invoice"]
    dana = await confirmed(client, copy, DANA)
    fact = await released(client, dana, invoice)
    [link] = await links(app, copy)

    # a day on, to the second, Dana still talking: the link is spent unopened, and so is its fact
    await keep_alive_until(client, frozen_clock, dana, 24)
    assert frozen_clock.now() == link.expires_at
    expired = await open_link(client, link.token)
    assert (expired.status_code, expired.json()["code"]) == (404, "not_found")
    frozen_clock.advance(1)
    assert (await open_link(client, link.token)).status_code == 404
    [link] = await links(app, copy)
    assert (link.consumed_at, link.voided_at) == (None, None)            # expired, not opened
    assert [summary for _, summary in await link_entries(app, copy)][1:] == [
        {"link_id": link.link_id, "refused": True}, {"link_id": link.link_id, "refused": True}]
    verdict = await checked(client, dana, "Here is your invoice.", [clause("document_link", fact.fact_id)])
    assert violations(verdict) == [("stale_fact", "not_current", [fact.fact_id])]


async def cited_in_closed_session(app: FastAPI, copy: Rivera, session_id: str, fact_id: str) -> ReplyVerdict:
    """The reply check on a draft citing `fact_id`, run on a session its Desk's deletion or its
    person's removal has closed, which the routes no longer serve: what the fact itself allows."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(
            select(ActorSession).where(ActorSession.session_id == session_id)))).one()
        assert row.closed_at is not None
        draft = ReplyDraft(session_id=session_id, generation=row.generation, prose="Here is your document.",
                           clauses=[Clause(template="document_link", fact_id=fact_id)])
        return await reply_check.check_draft(ctx, row, draft)


async def test_link_dies_with_its_desk_or_person(app, client, frozen_clock):
    copy = await rivera(app, client)
    docs = await documents(app, copy)
    dana, bob = await confirmed(client, copy, DANA), await confirmed(client, copy, BOB)
    danas = await released(client, dana, docs["dana-invoice"])
    bobs = await released(client, bob, docs["bob-warranty"], call_id="call-2")
    by_person = {link.person_id: link for link in await links(app, copy)}
    dana_link, bob_link = by_person[docs["dana-invoice"].record_owner_person_id], by_person[
        docs["bob-warranty"].record_owner_person_id]

    # Mike removes Dana: Dana's link is void, and her fact with it; Bob's stands
    frozen_clock.advance(60)
    await updated(client, copy, "people", {"remove": ["dana"]})
    by_person = {link.person_id: link for link in await links(app, copy)}
    assert by_person[dana_link.person_id].voided_at == frozen_clock.now()
    assert (by_person[bob_link.person_id].voided_at, by_person[bob_link.person_id].consumed_at) == (None, None)
    assert (await open_link(client, dana_link.token)).status_code == 404
    assert (await fact_row(app, copy, danas.fact_id)).status == "expired"
    assert (await fact_row(app, copy, bobs.fact_id)).status == "available"
    verdict = await cited_in_closed_session(app, copy, dana.session_id, danas.fact_id)
    assert violations(verdict) == [("stale_fact", "not_current", [danas.fact_id])]

    # then deletes the Desk: Bob's link is void too
    frozen_clock.advance(60)
    response = await client.delete(f"/desks/{copy.desk_id}", headers=copy.owner)
    assert response.status_code == 204, response.text
    assert {link.person_id: link.voided_at for link in await links(app, copy)}[bob_link.person_id] == \
        frozen_clock.now()
    assert (await open_link(client, bob_link.token)).status_code == 404
    assert (await fact_row(app, copy, bobs.fact_id)).status == "expired"
    verdict = await cited_in_closed_session(app, copy, bob.session_id, bobs.fact_id)
    assert violations(verdict) == [("stale_fact", "not_current", [bobs.fact_id])]

    # each refused open is on the Desk's ledger, which outlives it
    refused = [summary for _, summary in await link_entries(app, copy) if summary.get("refused")]
    assert refused == [{"link_id": dana_link.link_id, "refused": True}, {"link_id": bob_link.link_id, "refused": True}]


async def test_removing_two_people_while_a_link_opens(app, client, frozen_clock, monkeypatch):
    """Removing several people in one write locks all their sessions and voids all their links
    before it ledgers a session it closes. A link of the second person opening meanwhile holds its
    row and then takes the ledger head; were the first person's sessions ledgered before the second
    person's links were voided, each would wait on the other until Postgres ended one."""
    copy = await rivera(app, client)
    docs = await documents(app, copy)
    dana, bob = await confirmed(client, copy, DANA), await confirmed(client, copy, BOB)
    await released(client, dana, docs["dana-invoice"])
    await released(client, bob, docs["bob-warranty"], call_id="call-2")
    by_person = {link.person_id: link for link in await links(app, copy)}
    dana_link, bob_link = (by_person[docs[ref].record_owner_person_id] for ref in ("dana-invoice", "bob-warranty"))
    ledger_link, opening, go_on = release_document._ledger_link, asyncio.Event(), asyncio.Event()

    async def open_when_told(ctx, **entry):
        if entry.get("opened"):
            opening.set()                          # the link is marked opened, its row held
            await go_on.wait()
        await ledger_link(ctx, **entry)

    monkeypatch.setattr(release_document, "_ledger_link", open_when_told)
    frozen_clock.advance(60)
    opened = asyncio.create_task(open_link(client, bob_link.token))
    await asyncio.wait_for(opening.wait(), timeout=5)
    with connections_of(app) as pids:
        removed = asyncio.create_task(put_part(client, copy, "people", {"remove": ["dana", "bob"]}))
        await until_waiting(app, removed, pids, "kernel.document_links")
    go_on.set()
    opened, removed = await asyncio.gather(opened, removed)

    assert (opened.status_code, removed.status_code) == (200, 200), (opened.text, removed.text)
    assert opened.content == docs["bob-warranty"].body.encode()
    # Bob's link opened first, so only Dana's was voided; both of them are off the record
    after = {link.link_id: link for link in await links(app, copy)}
    now = frozen_clock.now()
    assert (after[dana_link.link_id].voided_at, after[dana_link.link_id].consumed_at) == (now, None)
    assert (after[bob_link.link_id].voided_at, after[bob_link.link_id].consumed_at) == (None, now)
    closed = await rows_of(app, copy.copy_id, select(ActorSession).where(
        ActorSession.session_id.in_([dana.session_id, bob.session_id])))
    assert sorted((row.session_id, row.closed_at) for row in closed) == sorted(
        [(dana.session_id, now), (bob.session_id, now)])
    opening, *closes, write = [entry.event for entry in await ledger_rows(app, copy)][-4:]
    assert (opening.kind, opening.summary) == ("document_link", {"link_id": bob_link.link_id, "opened": True})
    assert sorted((event.kind, event.session_id, event.summary["reason"]) for event in closes) == sorted(
        ("session", session_id, "person_removed") for session_id in (dana.session_id, bob.session_id))
    assert (write.kind, write.summary) == ("desk_data", {"part": "people", "refs": ["bob", "dana"]})


async def test_a_changed_contact_voids_the_persons_unopened_links(app, client, frozen_clock, caplog):
    """Whoever verified as Dana proved only that they read a code sent to her old contact. When the
    owner gives her another, a link already released to her and not yet opened is void, with its
    fact, as when she is removed, so it can't open her invoice; Bob's stands. The invoice stays
    hers: verified at her new contact, she gets a new link, which opens."""
    caplog.set_level(logging.INFO, logger="desk.kernel_service")
    copy = await rivera(app, client)
    docs = await documents(app, copy)
    dana, bob = await confirmed(client, copy, DANA), await confirmed(client, copy, BOB)
    danas = await released(client, dana, docs["dana-invoice"])
    bobs = await released(client, bob, docs["bob-warranty"], call_id="call-2")
    by_person = {link.person_id: link for link in await links(app, copy)}
    dana_link, bob_link = (by_person[docs[ref].record_owner_person_id] for ref in ("dana-invoice", "bob-warranty"))

    frozen_clock.advance(60)
    await updated(client, copy, "people", {"upsert": [{"ref": "dana", "display_name": "Dana Whitfield",
                                                       "contact": "dana.w@example.net"}]})
    after = {link.link_id: link for link in await links(app, copy)}
    assert (after[dana_link.link_id].voided_at, after[dana_link.link_id].consumed_at) == (frozen_clock.now(), None)
    assert (after[bob_link.link_id].voided_at, after[bob_link.link_id].consumed_at) == (None, None)
    assert (await fact_row(app, copy, danas.fact_id)).status == "expired"
    assert (await fact_row(app, copy, bobs.fact_id)).status == "available"
    verdict = await cited_in_closed_session(app, copy, dana.session_id, danas.fact_id)
    assert violations(verdict) == [("stale_fact", "not_current", [danas.fact_id])]

    # the link released before the change is refused, as a voided link is, and the refusal ledgered
    caplog.clear()
    refused = await open_link(client, dana_link.token)
    assert (refused.status_code, refused.json()) == (404, {"code": "not_found"})
    assert [record.getMessage() for record in caplog.records if record.getMessage().startswith("kernel_failure")] == [
        "kernel_failure route=GET /document_links/{token} status=404 code=not_found reason=document_link_refused"]
    assert (await link_entries(app, copy))[-1] == (dana.session_id, {"link_id": dana_link.link_id, "refused": True})

    # verified at her new contact, Dana gets her invoice again; Bob's link still opens
    again = await confirmed(client, copy, "dana.w@example.net")
    await released(client, again, docs["dana-invoice"])
    [new_link] = [link for link in await links(app, copy) if link.link_id not in after]
    assert (await open_link(client, new_link.token)).content == docs["dana-invoice"].body.encode()
    assert (await open_link(client, bob_link.token)).content == docs["bob-warranty"].body.encode()


async def test_wrong_person_gets_nothing(app, client):
    copy = await rivera(app, client)
    docs = await documents(app, copy)
    invoice = docs["dana-invoice"]
    bob = await confirmed(client, copy, BOB)

    # Bob, confirmed as himself, asks for Dana's invoice: the baseline refuses, before any link
    decision = await decided(client, bob, TOOL, {"document_id": invoice.document_id})
    assert (decision.outcome, decision.state, decision.policy_ids, decision.card_ids) == (
        "refuse", "refused", ["B.private_data_record_owner"], [])
    assert decision.action.resource.owner_person_id == invoice.record_owner_person_id != (
        docs["bob-warranty"].record_owner_person_id)
    assert invoice.title not in decision.visitor_plain
    assert decision.visitor_plain == "Not something I can do here"
    assert await links(app, copy) == []
    assert f"document:{invoice.document_id}" not in fact_ids((await context_of(client, bob.session_id,
                                                                                 bob.headers)).facts)

    # a document with no record owner is the owner's alone, even to a confirmed customer
    response = await client.post("/documents", headers=copy.owner, json={"desk_id": copy.desk_id, "document": {
        "ref": "price-sheet", "title": "Supplier price sheet", "body": "Wholesale prices."}})
    assert response.status_code == 200, response.text
    owners_only = response.json()["document_id"]
    decision = await decided(client, bob, TOOL, {"document_id": owners_only}, call_id="call-2")
    assert (decision.outcome, decision.action.resource.owner_person_id) == ("refuse", None)

    # and another copy's invoice, or no document at all, names nothing here: refused at step 1
    other = await documents(app, await rivera(app, client))
    for call_id, document_id in (("call-3", other["bob-warranty"].document_id), ("call-4", "doc-nothing"),
                                 ("call-5", "doc-\u0000")):
        decision = await decided(client, bob, TOOL, {"document_id": document_id}, call_id=call_id)
        assert (decision.outcome, decision.action) == ("refuse", None), document_id
    assert await links(app, copy) == []


async def test_a_document_named_by_its_fact_id_is_the_same_document(app, client, reviewer):
    """Claude's context shows a document by its fact ID (`document:<id>`), and the tool takes "the
    document_id in your context", so passing the whole fact ID is an honest way to name it: it
    resolves to the same document and record owner as the bare ID, and issues the same link and
    card. Who may have it doesn't change, and no other prefix is read as the document's."""
    copy = await rivera(app, client)
    docs = await documents(app, copy)
    invoice = docs["dana-invoice"]
    dana = await confirmed(client, copy, DANA)
    bare = await decided(client, dana, TOOL, {"document_id": invoice.document_id}, call_id="call-bare")
    named = await decided(client, dana, TOOL, {"document_id": f"document:{invoice.document_id}"}, call_id="call-fact")
    assert (named.outcome, named.card_ids) == (bare.outcome, bare.card_ids) == ("allow", ["rv-docs"]), \
        named.reason_plain
    assert named.action.resource == bare.action.resource
    assert (named.action.resource.id, named.action.resource.owner_person_id, named.action.recipient) == (
        invoice.document_id, invoice.record_owner_person_id, "verified_contact")

    # each executes to a link to the invoice, for Dana, ledgered by the document's own ID
    results = [await executed(client, dana, decision) for decision in (bare, named)]
    by_id = {link.link_id: link for link in await links(app, copy)}
    issued = [by_id[next(c.value for c in result.facts[0].claims if c.key == "ref")] for result in results]
    assert [(link.document_id, link.person_id, link.session_id) for link in issued] == [
        (invoice.document_id, invoice.record_owner_person_id, dana.session_id)] * 2
    assert [summary for _, summary in await link_entries(app, copy)] == [
        {"link_id": link.link_id, "document_id": invoice.document_id, "issued": True} for link in issued]
    bare_fact, named_fact = (result.facts[0] for result in results)
    assert (named_fact.claims[0], named_fact.label) == (bare_fact.claims[0], bare_fact.label)
    assert results[1].model_view == {"fact_id": named_fact.fact_id, "title": invoice.title, "link_ready": True}
    # and the same card, its link the new one's
    verdict = await checked(client, dana, "Here is your invoice.", [clause("document_link", named_fact.fact_id)])
    assert verdict.ok, verdict.violations
    [_, card] = verdict.blocks
    assert (card.template, card.title, card.href) == ("document_link", invoice.title, f"/api/d/{issued[1].token}")

    # Bob, confirmed as himself, naming Dana's invoice by its fact ID is refused as by its bare ID
    bob = await confirmed(client, copy, BOB)
    for call_id, document_id in (("call-bob-bare", invoice.document_id),
                                 ("call-bob-fact", f"document:{invoice.document_id}")):
        decision = await decided(client, bob, TOOL, {"document_id": document_id}, call_id=call_id)
        assert (decision.outcome, decision.policy_ids, decision.action.resource.id) == (
            "refuse", ["B.private_data_record_owner"], invoice.document_id), document_id

    # any other prefix, or the prefix twice, names no document: refused at step 1
    for n, document_id in enumerate((f"charge:{invoice.document_id}", f"quote:{invoice.document_id}",
                                     f"invoice:{invoice.document_id}", f"document:document:{invoice.document_id}",
                                     "document:")):
        decision = await decided(client, dana, TOOL, {"document_id": document_id}, call_id=f"call-other-{n}")
        assert (decision.outcome, decision.action) == ("refuse", None), document_id
    checks = [entry.event.summary.get("check") for entry in await ledger_rows(app, copy)
              if entry.event.kind == "decide" and entry.event.session_id == dana.session_id
              and entry.event.summary.get("reason") == "adapter_refused"]
    assert checks == ["no_such_document"] * 5
    assert len(await links(app, copy)) == 2


async def test_unverified_session_cannot_release(app, client):
    copy = await rivera(app, client)
    invoice = (await documents(app, copy))["dana-invoice"]

    # a stranger who knows the invoice's ID, and one who asked for a code and never entered it, aren't
    # given the tool: refused before any action exists
    stranger = await open_visitor(client, copy)
    waiting = await open_visitor(client, copy)
    await started(client, waiting, DANA)
    for visitor in (stranger, waiting):
        assert TOOL not in tools((await context_of(client, visitor.session_id, visitor.headers)).tools)
        decision = await decided(client, visitor, TOOL, {"document_id": invoice.document_id})
        assert (decision.outcome, decision.state, decision.action) == ("refuse", "refused", None)
        assert decision.visitor_plain == "Not something I can do here"
    assert await links(app, copy) == []

    # once the code is in, the same visitor is given it
    [entry] = await session_inbox(client, waiting)
    assert (await check(client, waiting, code_in(entry))).status_code == 200
    assert TOOL in tools((await context_of(client, waiting.session_id, waiting.headers)).tools)


async def test_link_clause_renders_only_for_the_record_owner(app, client, reviewer, frozen_clock):
    copy = await rivera(app, client)
    docs = await documents(app, copy)
    invoice = docs["dana-invoice"]
    dana = await confirmed(client, copy, DANA)
    fact = await released(client, dana, invoice)
    [link] = await links(app, copy)
    cited = [clause("document_link", fact.fact_id)]

    # Dana's card, in either language: the invoice's title, and the link as its `href` alone; the
    # soft-promise check reads the card's text, never the link
    for language, prose in (("en", "Here is your invoice."), ("es", "Aquí tienes tu factura.")):
        verdict = await checked(client, dana, prose, cited)
        assert (verdict.ok, verdict.language) == (True, language), verdict.violations
        [_, card] = verdict.blocks
        assert (card.kind, card.template, card.fact_id, card.title, card.lines, card.text, card.href, card.options) == (
            "card", "document_link", fact.fact_id, invoice.title, [], invoice.title, f"/api/d/{link.token}", [])
        assert verdict.model_dump_json().count(link.token) == 1
        assert invoice.canary not in verdict.model_dump_json()
    assert reviewer.soft_inputs and link.token not in repr(reviewer.soft_inputs)

    # any session Dana confirms in may show it, and showing it opens nothing
    again = await confirmed(client, copy, DANA)
    verdict = await checked(client, again, "Here is your invoice.", cited)
    assert verdict.ok, verdict.violations
    assert verdict.blocks[-1].href == f"/api/d/{link.token}"
    [link] = await links(app, copy)
    assert (link.consumed_at, link.voided_at) == (None, None)

    # a stranger, or Bob confirmed as himself, citing it gets the handoff: no title, no link
    for visitor in (await open_visitor(client, copy), await confirmed(client, copy, BOB)):
        verdict = await checked(client, visitor, "Here is your invoice.", cited)
        assert violations(verdict) == [("unentitled_fact", "not_a_reader", [fact.fact_id])]
        assert_handed_off(verdict)
        shown = verdict.model_dump_json()
        assert link.token not in shown and invoice.title not in shown

    # a link spent while a reply citing it is checked, its fact not yet expired, shows no card
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        (await ctx.db.scalars(ctx.repo.scoped(select(DocumentLink)))).one().consumed_at = frozen_clock.now()
    verdict = await checked(client, dana, "Here is your invoice.", cited)
    assert violations(verdict) == [("stale_fact", "nothing_to_show", [fact.fact_id])]
    assert link.token not in verdict.model_dump_json()


class Records(logging.Handler):
    """Every record a logger handles, as its handlers see it (after the logger's filters)."""

    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


def access_line(token: str, status: int, path: str = "/document_links/") -> None:
    """The access log line uvicorn writes for a request (its h11 and httptools servers alike), for a
    kernel served with its access log on."""
    logging.getLogger("uvicorn.access").info('%s - "%s %s HTTP/%s" %d', "127.0.0.1:50312", "GET",
                                             f"{path}{token}", "1.1", status)


async def test_tokens_never_leave_kernel_tables(app, client, caplog):
    caplog.set_level(logging.DEBUG)
    caplog.set_level(logging.INFO, logger="uvicorn.access")
    copy = await rivera(app, client)
    invoice = (await documents(app, copy))["dana-invoice"]
    dana = await confirmed(client, copy, DANA)
    fact = await released(client, dana, invoice)
    [link] = await links(app, copy)
    verdict = await checked(client, dana, "Here is your invoice.", [clause("document_link", fact.fact_id)])
    assert verdict.blocks[-1].href == f"/api/d/{link.token}"           # the one place it leaves the kernel

    # no view the API reads has a token or token hash column, and the API can't read the links themselves
    assert api_rows(copy.copy_id, "SELECT c.relname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid"
                                  " WHERE c.relnamespace = 'kernel_ro'::regnamespace"
                                  " AND a.attname IN ('token', 'token_sha256') AND NOT a.attisdropped") == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        api_rows(copy.copy_id, "SELECT count(*) FROM kernel.document_links")

    # releasing it, showing it, opening it, opening it again and an unknown token log no token, the
    # access log included (read from its own logger, however uvicorn's logging config left it)
    unknown = secrets.token_urlsafe(32)
    access, lines = logging.getLogger("uvicorn.access"), Records()
    access.addHandler(lines)
    try:
        for token in (link.token, link.token, unknown, "not-a-token"):
            response = await open_link(client, token)
            access_line(token, response.status_code)
        access_line(unknown, 404, path="/payment_links/")
    finally:
        access.removeHandler(lines)
    assert [record.getMessage() for record in lines.records] == [
        f'127.0.0.1:50312 - "GET {path}<redacted> HTTP/1.1" {status}' for path, status in (
            ("/document_links/", 200), ("/document_links/", 404), ("/document_links/", 404),
            ("/document_links/", 404), ("/payment_links/", 404))]
    # what the kernel logged (the test's own HTTP client, standing in for the API, logs its requests)
    logged = [f"{record.getMessage()} {record.exc_text or ''}" for record in [*caplog.records, *lines.records]
              if record.name.partition(".")[0] not in ("httpx", "httpcore")]
    assert [line for line in logged if line.startswith("kernel_failure")] == [
        "kernel_failure route=GET /document_links/{token} status=404 code=not_found reason=" + reason + " "
        for reason in ("document_link_refused", "unknown_document_link", "unknown_document_link")]

    # nor does any ledger summary, or any row a kernel_ro view shows the API
    exposed = logged + [entry.event.model_dump_json() for entry in await ledger_rows(app, copy)]
    for view in KERNEL_RO_VIEWS:
        exposed += [text for (text,) in api_rows(copy.copy_id, f"SELECT row_to_json(v)::text FROM kernel_ro.{view} v")]
    for token in (link.token, link.token_sha256, unknown):
        assert not [text for text in exposed if token in text], token


async def test_a_taken_token_is_not_logged(app, client, monkeypatch, caplog):
    """A link whose token is already another's is refused by the unique index, whose error names
    the key ("Key (token)=(...)"): the error is logged by its class, SQLSTATE and index alone, the
    release ends `unknown` as any failed commit does, and the token appears in no log line."""
    caplog.set_level(logging.DEBUG)
    copy = await rivera(app, client)
    invoice = (await documents(app, copy))["dana-invoice"]
    dana = await confirmed(client, copy, DANA)
    await released(client, dana, invoice)
    [link] = await links(app, copy)
    monkeypatch.setattr(release_document, "secrets", SimpleNamespace(token_urlsafe=lambda nbytes: link.token))
    decision = await decided(client, dana, TOOL, {"document_id": invoice.document_id}, call_id="call-2")
    assert (await executed(client, dana, decision)).state == "unknown"
    assert "IntegrityError sqlstate=23505 constraint=document_links_token" in caplog.text   # the refusal was logged
    for row in (link.token, "Key (", "DETAIL"):
        assert row not in caplog.text, row
