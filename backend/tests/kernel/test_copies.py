"""Copies: each visitor's own Turner Plumbing, seeded through the one Desk seed path."""

import ast
import json
import re
import unicodedata
from datetime import time, timedelta
from zoneinfo import ZoneInfo

import desk_kernel
import psycopg
import pytest
from fastapi import FastAPI, Request
from sqlalchemy import select

from desk.contracts import Claim, Decision
from desk.db.models import (ActorSession, Business, CalendarSlot, Copy, Desk, Document, Fact, LedgerEntry,
                             NotificationPref, Person, PriceItem, Tool)
from desk.db.models import KnowledgeItem as KnowledgeRow
from desk.db.session import COPY_SETTING, database_url, libpq_url
from desk import presets
from desk.kernel_service import adapters, auth, desks, mcp_client, reply_check, seed
from desk.kernel_service.repo import Ctx, KernelFailure, new_id

from .fakes import FakeAdapter
from .helpers import kernel_ctx, rows_of
from .test_adapters import visitor_of
from .test_context import context_of
from .test_decide import verify_signature

TZ = ZoneInfo("America/Los_Angeles")


def add_owner_desk_probe(app: FastAPI) -> None:
    """A route that only checks the owner's claim on the Desk it names, as every owner Desk route does first."""

    @app.get("/test/owner/desks/{desk_id}")
    async def probe(desk_id: str, ctx: Ctx, request: Request) -> dict:
        owner = await auth.require_owner(ctx, request, desk_id=desk_id)
        return {"copy_id": owner.copy_id}


async def create_copy(client) -> dict:
    response = await client.post("/copies", json={})
    assert response.status_code == 200, response.text
    return response.json()


async def test_copy_returns_seeded_chat(client):
    created = await create_copy(client)
    chat = created["seeded_chat"]
    decision = Decision.model_validate(chat["decision"])
    assert chat["session_id"] == decision.session_id
    assert chat["visitor_line"] == seed.HELD_REQUEST_VISITOR_LINE
    assert (decision.outcome, decision.state, decision.visitor_plain) == (
        "hold", "held", "Waiting for Mike Turner to approve")
    verify_signature((await client.get("/health")).json()["public_key_hex"], decision)

    # The owner's pending approvals name this same hold, in this same visitor session.
    assert api_rows(created["copy_id"],
                    "SELECT decision_id, session_id FROM kernel_ro.decisions WHERE state = 'held'") == [
        (decision.decision_id, chat["session_id"])]
    response = await client.get(f"/decisions/{decision.decision_id}",
                                headers={"X-Owner-Session": created["owner_token"]})
    assert response.status_code == 200, response.text
    assert Decision.model_validate(response.json()) == decision.model_copy(update={"inbox": []})


def api_rows(copy_id: str, sql: str) -> list[tuple]:
    """What the API process reads from a kernel_ro view for a copy (as desk_api)."""
    with psycopg.connect(libpq_url(database_url("API"))) as api:
        api.execute("SELECT set_config(%s, %s, true)", (COPY_SETTING, copy_id))
        return api.execute(sql).fetchall()


def inside_hours(starts_at, minutes: int, hours) -> bool:
    """The slot starts and ends inside one of the business's windows, in its time zone."""
    local = starts_at.astimezone(TZ)
    start, end = local.hour * 60 + local.minute, local.hour * 60 + local.minute + minutes
    day = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")[local.weekday()]
    for window in hours:
        window_end = 1440 if window.end == time(0) else window.end.hour * 60 + window.end.minute
        if day in window.days and window.start.hour * 60 + window.start.minute <= start and end <= window_end:
            return True
    return False


async def test_copy_seeds_rivera_plumbing(app, client, frozen_clock):
    created = await create_copy(client)
    copy_id, [desk_id] = created["copy_id"], created["desk_ids"]
    assert created["owner_session"] == {"session_id": created["owner_session"]["session_id"], "kind": "owner",
                                        "verified": True, "assurance": "owner_session", "mode": "ai", "generation": 0}
    [desk] = await rows_of(app, copy_id, select(Desk))
    assert re.fullmatch(r"turner-plumbing-[a-z0-9]{6}", desk.slug)
    assert (desk.desk_id, desk.name, desk.answering) == (desk_id, "Main line", True)   # the demo Desk is live
    [business] = await rows_of(app, copy_id, select(Business))
    assert (business.business_id, business.name, business.owner_display_name, business.timezone, business.brand) == (
        desk.business_id, "Turner Plumbing", "Mike Turner", "America/Los_Angeles",
        {"palette": "teal", "primary": "#1F4E4A", "accent": "#B87333"})   # teal picked, so Settings shows it
    [owner] = await rows_of(app, copy_id, select(ActorSession).where(ActorSession.kind == "owner"))
    assert (owner.session_id, owner.kind, owner.desk_id, owner.assurance) == (
        created["owner_session"]["session_id"], "owner", None, "owner_session")
    response = await client.get("/whoami", headers={"X-Owner-Session": created["owner_token"]})   # the copy credential
    assert (response.status_code, response.json()["copy_id"], response.json()["desk_ids"]) == (200, copy_id, [desk_id])
    # the API sees Dana and Bob with masked contacts only
    assert api_rows(copy_id, "SELECT display_name, masked_contact FROM kernel_ro.people ORDER BY display_name") == [
        ("Bob Okafor", "b•••@example.com"), ("Dana Whitfield", "d•••@example.com")]
    prices = await rows_of(app, copy_id, select(PriceItem).order_by(PriceItem.unit_cents))
    assert [(p.item_id, p.title, p.unit_cents) for p in prices] == [
        ("deposit", "Service call deposit", 2000), ("short-notice", "Short-notice fee", 5000),
        ("pipe", "Pipe repair (starting price)", 10000), ("heater", "Water heater flush", 15000),
        ("drain", "Drain clearing", 18000), ("leak", "Leak repair", 25000)]
    slots = await rows_of(app, copy_id, select(CalendarSlot).order_by(CalendarSlot.starts_at))
    assert len(slots) == 10 * 5 + 2 * 2                    # two weeks of weekday and Saturday slots
    for slot in slots:
        assert slot.starts_at > frozen_clock.now() and slot.minutes == 120, slot.slot_id
        assert inside_hours(slot.starts_at, slot.minutes, desk.hours), slot.slot_id
        assert slot.slot_id == slot.starts_at.astimezone(TZ).strftime("S-%Y%m%d-%H%M")
    assert slots[-1].starts_at - frozen_clock.now() < timedelta(days=15)
    # charter facts, the hours included, are public
    facts = {fact.fact_id: fact for fact in await rows_of(app, copy_id, select(Fact).where(Fact.kind == "charter"))}
    assert set(facts) == {"charter:contact", "charter:policy:service_area", "charter:policy:first_visit",
                          "charter:policy:arrival", "charter:hours",
                          *(f"charter:starter:{n}:{lang}" for n in (1, 2, 3) for lang in ("en", "es"))}
    assert all(fact.readers == ["public"] and fact.source == "kernel" and fact.status == "available"
               for fact in facts.values())
    assert [(c.key, c.value) for c in facts["charter:contact"].claims] == [("contact", "(510) 555-0142")]
    [windows] = facts["charter:hours"].claims
    assert (windows.key, windows.kind) == ("windows", "text")
    assert windows.value == desk_kernel.canonical_json(json.dumps([w.model_dump(mode="json") for w in desk.hours]))
    assert [(w.days, w.start, w.end) for w in desk.hours] == [
        (["mon", "tue", "wed", "thu", "fri"], time(8), time(18)), (["sat"], time(9), time(13))]
    # the Desk's creation and two knowledge items are first, then its two mock payments tools pinned
    # (plan 01c), its urgent business tool written as the owner's replacement writes it, its rules'
    # activation and the urgent tool that version turns on, then the held request on Today
    # (test_adapters.test_copy_seeds_one_held_quote)
    entries = await rows_of(app, copy_id, select(LedgerEntry).order_by(LedgerEntry.seq))
    assert [(e.desk_id, e.seq, e.event.kind) for e in entries] == [
        (desk_id, 1, "desk_data"), (desk_id, 2, "desk_data"), (desk_id, 3, "desk_data"),
        (desk_id, 4, "tool_pin"), (desk_id, 5, "tool_pin"), (desk_id, 6, "business_tools"), (desk_id, 7, "policy"),
        (desk_id, 8, "tool_pin"), (desk_id, 9, "session"), (desk_id, 10, "decide")]
    pins = mcp_client.seed_pins()
    [urgent] = await rows_of(app, copy_id, select(Tool).where(Tool.tool == "desk.emergency-callback"))
    assert [e.event.summary for e in entries[:8]] == [
        {"part": "desk", "created": True},
        {"part": "knowledge", "item_id": "kn-website", "owner_only_forced": False},
        {"part": "knowledge", "item_id": "kn-price-list", "owner_only_forced": False},
        {"tool": "payments.create_refund", "event": "connected", "status": "enabled",
         "definition_sha256": pins["create_refund"]},
        {"tool": "payments.list_charges", "event": "connected", "status": "enabled",
         "definition_sha256": pins["list_charges"]},
        {"tools": [{"tool": "desk.emergency-callback", "block": "urgent", "definition_sha256": urgent.definition_sha256,
                    "change": "new"}]},
        {"version": 1, "status": "active", "preset": "rivera", "activated": True, "from": None,
         "auto_money_cap_cents": 50_000},
        {"tool": "desk.emergency-callback", "event": "enabled", "version": 1,
         "definition_sha256": urgent.definition_sha256}]
    # the seed's cards: the starter preset's utility cards plus Turner's own
    ask_first = seed.PRESETS["ask_first"]
    assert all(card.card_id.startswith("preset-") and card.mode == "auto" for card in ask_first)
    assert [card.card_id for card in seed.RIVERA_CARDS] == [card.card_id for card in ask_first] + [
        "rv-quote", "rv-book-wk", "rv-book-sat", "rv-docs", "rv-link", "rv-charges", "rv-refund", "rv-mandate",
        "rv-urgent"]
    [link] = [card for card in seed.RIVERA_CARDS if card.card_id == "rv-link"]       # the 01c rows of the seed
    assert (link.applies_to, link.mode, link.who, link.max_amount_cents, link.review) == (
        "native.payment_link", "auto", "anyone", 30_000, True)
    assert [(c.applies_to, c.mode, c.who, c.max_amount_cents) for c in seed.RIVERA_CARDS[-4:]] == [
        ("payments.list_charges", "auto", "record_owner", None), ("payments.create_refund", "ask", "record_owner", None),
        ("native.charge_mandate", "auto", "anyone", 2_000), ("desk.emergency-callback", "auto", "anyone", None)]
    assert {card.applies_to for card in ask_first} == {
        "native.find_slots", "native.capture_lead", "native.request_callback", "native.start_verification",
        "native.fetch_website", "native.read_memory", "native.web_search"}
    assert seed.PRESETS is presets.PRESETS and seed.PRESETS["auto"][:len(ask_first)] == ask_first
    assert [(c.card_id, c.applies_to, c.mode, c.who) for c in seed.PRESETS["auto"][len(ask_first):]] == [
        ("preset-quote", "native.quote", "auto", "anyone"), ("preset-book-weekday", "native.book", "auto", "anyone"),
        ("preset-documents", "native.release_document", "auto", "record_owner"),
        ("preset-charge-ask", "effect:charge", "ask", "anyone"), ("preset-pay-out-ask", "effect:pay_out", "ask", "anyone")]
    # both processes import the presets, so they are plain data over the shared contracts
    tree = ast.parse(open(presets.__file__).read())
    imported = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)} | {
        alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
    assert {name for name in imported if name.split(".")[0] not in ("datetime", "typing")} == {"desk.contracts"}


SEEDED_KNOWLEDGE = [  # (item ID, source, title), as Settings › Knowledge lists them on a new copy
    ("kn-website", "website", "Your website, turner-plumbing.example, read during setup"),
    ("kn-price-list", "setup", "Price list, from your answers in setup"),
]


async def test_copy_seeds_the_website_and_price_list_knowledge(app, client):
    """A new copy's Desk knows what setup would have given it, everyone may read both items, and
    each was stored as an owner's item is: canary-checked and ledgered `desk_data`."""
    copy, visitor = await visitor_of(app, client)
    stored = await rows_of(app, copy.copy_id, select(KnowledgeRow).order_by(KnowledgeRow.item_id))
    assert sorted((row.desk_id, row.item_id, row.source, row.title, row.readers) for row in stored) == sorted(
        (copy.desk_id, item_id, source, title, ["public"]) for item_id, source, title in SEEDED_KNOWLEDGE)
    texts = {item.item_id: item.text for item in seed.RIVERA_KNOWLEDGE}       # as the seed keeps them
    assert {row.item_id: row.text for row in stored} == texts
    entries = await rows_of(app, copy.copy_id, select(LedgerEntry).where(LedgerEntry.desk_id == copy.desk_id)
                            .order_by(LedgerEntry.seq))
    assert [entry.event.summary for entry in entries if entry.event.kind == "desk_data"
            and entry.event.summary.get("part") == "knowledge"] == [
        {"part": "knowledge", "item_id": item_id, "owner_only_forced": False} for item_id, _, _ in SEEDED_KNOWLEDGE]
    # a stranger's context carries both, and the API's view shows their titles and texts
    context = await context_of(client, visitor.session_id, visitor.headers)
    assert sorted((item.item_id, item.source, item.title, item.text, item.label.readers)
                  for item in context.knowledge) == sorted(
        (item_id, source, title, texts[item_id], ["public"]) for item_id, source, title in SEEDED_KNOWLEDGE)
    assert api_rows(copy.copy_id, "SELECT item_id, source, title, text, readers FROM kernel_ro.knowledge_items"
                                  " ORDER BY item_id") == sorted(
        (item_id, source, title, texts[item_id], ["public"]) for item_id, source, title in SEEDED_KNOWLEDGE)


def test_seeded_knowledge_states_no_amount(frozen_clock):
    """A price reaches a visitor only on a quote card built from the price list, so the seeded
    knowledge names the price list's items and states no amount: no digit, no currency, and nothing
    the reply check's prose scan would stop if Claude repeated it word for word."""
    _, desk = seed.rivera_seed(frozen_clock.now())
    for item in seed.RIVERA_KNOWLEDGE:
        for text in (item.title, item.text):
            assert not re.search(r"\d|\bcents?\b|\bdollars?\b", text, re.IGNORECASE), text
            assert not any(unicodedata.category(ch) == "Sc" for ch in text), text      # no currency sign
            assert reply_check.scan_prose(text) == [], text
    [price_list] = [item for item in seed.RIVERA_KNOWLEDGE if item.item_id == "kn-price-list"]
    assert all(price.title.lower() in price_list.text.lower() for price in desk.price_items)
    [website] = [item for item in seed.RIVERA_KNOWLEDGE if item.item_id == "kn-website"]
    [area] = [claim.value for claim in desk.charter if claim.key == "policy:service_area"]
    assert area in website.text                                                  # as the charter states it
    assert website.text == (
        "Turner Plumbing is Mike Turner's home plumbing business: drain clearing, leak repair and "
        "water heater flushes. " + area)


async def test_a_copy_prices_a_plumbing_emergency(app, client):
    """A plumbing emergency is quoted as "pipe repairs start from $100, and there's a short-notice fee
    of $50", each amount on a quote card. Cards come only from the price list, so a fresh copy's list
    holds both, the pipe repair titled as the starting price it is (a price item has no "from" price)."""
    created = await create_copy(client)
    prices = {p.item_id: (p.title, p.unit_cents) for p in await rows_of(app, created["copy_id"], select(PriceItem))}
    assert prices["short-notice"] == ("Short-notice fee", 5_000)
    assert prices["pipe"] == ("Pipe repair (starting price)", 10_000)


def test_the_price_list_knowledge_says_when_the_short_notice_fee_applies():
    """The owner's sentence (2026-11-01) tells Claude when to add the fee, with no amount: an amount
    reaches a visitor only on a quote card."""
    from desk.kernel_service import seed
    [price_list] = [item for item in seed.RIVERA_KNOWLEDGE if item.item_id == "kn-price-list"]
    assert "The short-notice fee is added to an urgent visit that Mike fits in at short notice." in price_list.text


async def test_copies_are_isolated(app, client):
    add_owner_desk_probe(app)
    a, b = await create_copy(client), await create_copy(client)
    assert a["copy_id"] != b["copy_id"] and a["owner_token"] != b["owner_token"]
    [a_desk], [b_desk] = a["desk_ids"], b["desk_ids"]
    a_owner = {"X-Owner-Session": a["owner_token"]}
    response = await client.get(f"/test/owner/desks/{a_desk}", headers=a_owner)
    assert (response.status_code, response.json()) == (200, {"copy_id": a["copy_id"]})
    response = await client.get(f"/test/owner/desks/{b_desk}", headers=a_owner)      # copy A's owner on copy B's Desk
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    [b_row] = await rows_of(app, b["copy_id"], select(Desk))
    visitor = await client.post("/sessions", json={"desk_slug": b_row.slug, "kind": "visitor"})
    response = await client.post(f"/sessions/{visitor.json()['state']['session_id']}/mode",
                                 json={"mode": "owner", "generation": 0}, headers=a_owner)
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})    # nor take over its sessions
    # each copy sees its own people only, through KernelRepo and through the API's views
    assert await rows_of(app, a["copy_id"], select(Person).where(Person.desk_id == b_desk)) == []
    a_people = await rows_of(app, a["copy_id"], select(Person))
    assert {(p.ref, p.desk_id) for p in a_people} == {("dana", a_desk), ("bob", a_desk)}
    assert {p.person_id for p in a_people}.isdisjoint(p.person_id for p in await rows_of(app, b["copy_id"],
                                                                                         select(Person)))
    assert api_rows(a["copy_id"], "SELECT DISTINCT desk_id FROM kernel_ro.people") == [(a_desk,)]


async def test_documents_get_a_fresh_canary(app, client):
    copies = [await create_copy(client), await create_copy(client)]
    canaries = []
    for copy in copies:
        people = {p.ref: p.person_id for p in await rows_of(app, copy["copy_id"], select(Person))}
        documents = {d.ref: d for d in await rows_of(app, copy["copy_id"], select(Document))}
        assert set(documents) == {"dana-invoice", "bob-warranty"}
        for ref, owner, title in (("dana-invoice", "dana", "Invoice, drain clearing"),
                                  ("bob-warranty", "bob", "Warranty, water heater flush")):
            document = documents[ref]
            assert re.fullmatch(r"cdk-[0-9a-f]{16}", document.canary)
            assert document.body.endswith(f"\n\nReference {document.canary}")      # the canary rides in the body
            assert (document.title, document.record_owner_person_id) == (title, people[owner])
            [fact] = await rows_of(app, copy["copy_id"], select(Fact).where(
                Fact.fact_id == f"document:{document.document_id}"))
            assert (fact.kind, fact.status, fact.source, fact.desk_id) == ("document", "available", "kernel",
                                                                           copy["desk_ids"][0])
            assert fact.claims == [Claim(key="title", kind="text", value=title)]    # the title only, never the body
            assert (fact.readers, fact.record_owner) == (["owner", f"person:{people[owner]}"], people[owner])
        canaries.append(documents["dana-invoice"].canary)
    assert canaries[0] != canaries[1]                                               # fresh in every copy
    # the API's view of documents has neither the body nor the canary
    [(title, owner)] = api_rows(copies[0]["copy_id"], "SELECT title, record_owner_person_id FROM kernel_ro.documents"
                                                      " WHERE title LIKE 'Invoice%'")
    assert title == "Invoice, drain clearing" and owner.startswith("person-")


async def test_seed_has_no_person_at_the_business_contact(app, client, frozen_clock):
    """A visitor who types the business's own number must not reach a person on record."""
    _, desk = seed.rivera_seed(frozen_clock.now())
    [business_contact] = [claim.value for claim in desk.charter if claim.key == "contact"]
    assert desks.normalize_contact(business_contact) == "+15105550142"
    assert desks.normalize_contact(" Dana@Example.com ") == "dana@example.com"
    assert desks.mask_contact("(510) 555-0177") == "•••• 0177"
    on_record = {desks.normalize_contact(person.contact) for person in desk.people}
    assert on_record == {"dana@example.com", "bob@example.com"}
    created = await create_copy(client)
    people = await rows_of(app, created["copy_id"], select(Person))
    assert {p.contact_norm for p in people} == on_record
    assert desks.normalize_contact(business_contact) not in {p.contact_norm for p in people}
    assert {p.contact for p in people} == {"dana@example.com", "bob@example.com"}           # as given, kernel-only


async def test_seed_rejects_an_hours_claim_and_a_bad_owner_name(app, frozen_clock):
    copy_id = new_id("copy")
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy_id)
        ctx.db.add(Copy(copy_id=copy_id, created_at=frozen_clock.now()))
    business, desk = seed.rivera_seed(frozen_clock.now())
    hours = Claim.model_construct(key="hours", kind="text", value="Open 8 to 6")   # the contract won't build one
    bad_seeds = [
        (business, desk.model_copy(update={"charter": [*desk.charter, hours]})),
        *((business.model_copy(update={"owner_display_name": name}), desk)
          for name in ("M4ria", "", "Mike\nTurner", "M" * 41, "Mike <Turner>", "   ")),
        # and what would leave the Desk unusable: a time zone Cedar's hours can't use, a document
        # owned by nobody on record, a contact no code could reach
        (business.model_copy(update={"timezone": "Pacific/Atlantis"}), desk),
        (business, desk.model_copy(update={"documents": [
            desk.documents[0].model_copy(update={"record_owner_ref": "carol"})]})),
        (business, desk.model_copy(update={"people": [
            desk.people[0].model_copy(update={"contact": "ask at the front desk"})]})),
    ]
    for business_seed, desk_seed in bad_seeds:
        async with kernel_ctx(app) as ctx:                     # commits anything written before the refusal
            ctx.bind(copy_id)
            with pytest.raises(desks.InvalidSeed) as refused:
                await desks.create_desk(ctx, copy_id, business_seed, desk_seed)
        assert (refused.value.status, refused.value.code) == (422, "invalid")   # on owner routes
    for table in (Business, Desk, Person, PriceItem, CalendarSlot, Document, Fact, NotificationPref, Tool, LedgerEntry):
        assert await rows_of(app, copy_id, select(table)) == [], table.__tablename__


async def test_create_desk_enables_only_native_tools(app, frozen_clock, registry):
    registry.clear()                                                        # without the native adapters
    native = adapters.register(FakeAdapter("native.find_slots", effects=["read"], status="disabled"))
    adapters.register(FakeAdapter("payments.list_charges", effects=["read"]))     # MCP: only a pinned connect adds it
    copy_id = new_id("copy")
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy_id)
        ctx.db.add(Copy(copy_id=copy_id, created_at=frozen_clock.now()))
        desk_id = (await desks.create_desk(ctx, copy_id, *seed.rivera_seed(frozen_clock.now()))).desk_id
    [row] = await rows_of(app, copy_id, select(Tool))
    enabled = native.profile.model_copy(update={"status": "enabled"})
    assert (row.desk_id, row.tool, row.source, row.status, row.effects) == (
        desk_id, "native.find_slots", "native", "enabled", ["read"])
    assert row.profile == enabled
    assert row.profile_sha256 == adapters.profile_sha256(native.profile)     # status isn't part of the pin
    assert row.definition_sha256 == row.profile_sha256          # the hash the owner names it by (plan 01c)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy_id)
        assert await desks.enabled_profiles(ctx, desk_id) == [enabled]


async def test_two_desks_in_one_copy_each_get_charter_facts(app, client, frozen_clock):
    created, other = await create_copy(client), await create_copy(client)
    copy_id, [main_line] = created["copy_id"], created["desk_ids"]
    [business] = await rows_of(app, copy_id, select(Business))
    _, desk = seed.rivera_seed(frozen_clock.now())
    emergencies = desk.model_copy(update={"name": "Emergencies", "people": [], "documents": [], "calendar_slots": []})
    second_business = seed.rivera_seed(frozen_clock.now())[0].model_copy(update={
        "name": "Ignored when reusing", "existing_business_id": business.business_id})
    async with kernel_ctx(app) as ctx:
        second = await desks.create_desk(ctx, copy_id, second_business, emergencies)
    assert re.fullmatch(r"turner-plumbing-[a-z0-9]{6}", second.slug)            # named after the stored business
    desks_now = {d.desk_id: d for d in await rows_of(app, copy_id, select(Desk))}
    assert set(desks_now) == {main_line, second.desk_id}
    assert {d.business_id for d in desks_now.values()} == {business.business_id}
    assert len(await rows_of(app, copy_id, select(Business))) == 1
    for desk_id in desks_now:                                                   # fact IDs repeat per Desk
        facts = await rows_of(app, copy_id, select(Fact).where(Fact.desk_id == desk_id, Fact.kind == "charter"))
        assert {f.fact_id for f in facts} >= {"charter:hours", "charter:contact"}, desk_id
        assert all(f.readers == ["public"] for f in facts)
    second_ledger = await rows_of(app, copy_id, select(LedgerEntry).where(LedgerEntry.desk_id == second.desk_id))
    assert [(e.seq, e.event.kind) for e in second_ledger] == [(1, "desk_data")]   # its own chain
    # a business of another copy is not found, and nothing is written
    [other_business] = await rows_of(app, other["copy_id"], select(Business))
    async with kernel_ctx(app) as ctx:
        with pytest.raises(KernelFailure) as refused:
            await desks.create_desk(ctx, copy_id, second_business.model_copy(update={
                "existing_business_id": other_business.business_id}), emergencies)
    assert (refused.value.status, refused.value.code) == (404, "not_found")
    assert len(await rows_of(app, copy_id, select(Desk))) == 2
