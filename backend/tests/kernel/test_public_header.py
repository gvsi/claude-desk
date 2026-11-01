"""No document canary in what strangers are shown of a Desk.

Anyone may read a Desk's public page (`GET /public/{slug}`) with no session, and its header shows
the owner's words as they were typed: the business's name, the Desk's name, the owner's display
name and the brand colors. Its address is a slug made from the business's name, its charter cards
show the owner's policies, and strangers are quoted from the price list's IDs and titles. So an
owner write of any of them that carries a document's canary, even split or disguised, or one a
new Desk's slug would carry, is refused (422 `invalid`) and ledgered `desk_data` `{part, refused:
"canary", fields, fact_ids}`, naming the fields and the documents, never the text. A header value
stored before that check is withheld from the page, which shows the field's safe fallback
instead, in the header and in the Agent Card that names the business and the owner, and the owner
is alerted in the Demo inbox. Tests run on Rivera Plumbing copies as `POST /copies` seeds
them (Friday 10:04 in Oakland).
"""

import secrets

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import BRAND_PALETTE, Claim, PriceItem, RenderedBlock
from desk.db.models import Business, Desk
from desk.db.models import DemoInboxEntry as InboxRow
from desk.db.models import Fact as FactRow
from desk.db.models import PriceItem as PriceRow
from desk.kernel_api import DeskCreated, PublicDesk
from desk.kernel_service import desks

from .helpers import kernel_ctx, rows_of
from .test_adapters import Rivera, rivera
from .test_desk_writes import LOPEZ_DESK, desks_of, entries_of, new_desk, post_desk, put_part, updated
from .test_labels_hardening import assert_no_canary_on_record, disguises, documents, full_width

RIVERA_BRAND = {"palette": "teal", **BRAND_PALETTE["teal"]}   # as the seed stores it
RIVERA_BUSINESS = {"name": "Rivera Plumbing", "owner_display_name": "Maria Rivera",
                   "timezone": "America/Los_Angeles", "brand": RIVERA_BRAND}


def business(**fields) -> dict:
    """A `PUT /desks/{id}/business` body: Rivera Plumbing's business with `fields` changed."""
    return RIVERA_BUSINESS | fields


async def public_page(client: httpx.AsyncClient, copy: Rivera, lang: str = "en") -> PublicDesk:
    response = await client.get(f"/public/{copy.slug}", params={"lang": lang})
    assert response.status_code == 200, response.text
    return PublicDesk.model_validate(response.json())


def card_naming(card: list[RenderedBlock], name: str, shown: str) -> list[RenderedBlock]:
    """The Agent Card `card`, which names `name`, naming `shown` in its place."""
    assert any(name in block.text for block in card)
    return [block.model_copy(update={"text": block.text.replace(name, shown)}) for block in card]


# What the Agent Card says in place of a name the page withholds: fixed words, never the name
WITHHELD_BUSINESS = {"en": "this business", "es": "este negocio"}
WITHHELD_OWNER = {"en": "the owner", "es": "la persona a cargo"}


async def test_a_document_body_in_the_business_name_is_refused(app, client):
    copy = await rivera(app, client)
    dana = (await documents(app, copy))["dana-invoice"]
    before = len(await entries_of(app, copy))
    # the owner pastes Dana's whole invoice into the business's name
    response = await put_part(client, copy, "business", business(name=dana.body))
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert [row.name for row in await rows_of(app, copy.copy_id, select(Business))] == ["Rivera Plumbing"]
    # ledgered on the Desk, naming the field and the document, never the text
    [entry] = (await entries_of(app, copy))[before:]
    assert (entry.event.kind, entry.event.summary) == ("desk_data", {
        "part": "business", "refused": "canary", "fields": ["name"], "fact_ids": [f"document:{dana.document_id}"]})
    await assert_no_canary_on_record(app, copy, dana.canary)
    assert (await public_page(client, copy)).business_name == "Rivera Plumbing"


async def test_a_disguised_or_split_canary_in_any_header_field_is_refused(app, client):
    copy = await rivera(app, client)
    seeded = await documents(app, copy)
    dana, bob = seeded["dana-invoice"], seeded["bob-warranty"]
    refused = [({"name": f"Rivera Plumbing {disguised}"}, ["name"], dana) for disguised in disguises(dana.canary)]
    refused += [
        ({"brand": {"accent": f"#c2410c {bob.canary}"}}, ["brand"], bob),           # a brand color
        ({"brand": {f"accent {full_width(bob.canary)}": "#c2410c"}}, ["brand"], bob),   # or its name
        # refused for the canary before the display name's own check, so it is on record
        ({"owner_display_name": f"Maria {dana.canary}"}, ["owner_display_name"], dana),
        # split between two fields the page shows side by side: every field is named
        ({"name": f"Rivera Plumbing {dana.canary[:10]}", "owner_display_name": f"{dana.canary[10:]} Maria"},
         ["name", "owner_display_name", "brand"], dana),
    ]
    before = len(await entries_of(app, copy))
    for fields, named, document in refused:
        response = await put_part(client, copy, "business", business(**fields))
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), fields
    assert [(row.name, row.owner_display_name, row.brand) for row in await rows_of(
        app, copy.copy_id, select(Business))] == [("Rivera Plumbing", "Maria Rivera", RIVERA_BRAND)]
    assert [entry.event.summary for entry in (await entries_of(app, copy))[before:]] == [
        {"part": "business", "refused": "canary", "fields": named, "fact_ids": [f"document:{document.document_id}"]}
        for _, named, document in refused]
    await assert_no_canary_on_record(app, copy, dana.canary, bob.canary)


async def store(app: FastAPI, copy: Rivera, model: type[Business] | type[Desk], **fields) -> None:
    """Test only: the copy's one business or Desk with `fields` stored as they are, as a kernel
    without the canary check could have stored them."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(select(model)))).one()
        for field, value in fields.items():
            setattr(row, field, value)


async def store_business(app: FastAPI, copy: Rivera, **fields) -> None:
    await store(app, copy, Business, **fields)


async def test_a_new_desk_is_held_to_the_same(app, client):
    copy = await rivera(app, client)
    dana = (await documents(app, copy))["dana-invoice"]
    refused = [(new_desk(name=f"Lopez Electric {dana.canary}"), ["business.name"]),
               (new_desk(owner_display_name=f"Ana {dana.canary}"), ["business.owner_display_name"]),
               (new_desk(brand={"accent": dana.canary.upper()}), ["business.brand"]),
               (new_desk(desk=LOPEZ_DESK.model_copy(update={"name": f"Main line {dana.canary}"})), ["desk.name"])]
    before = len(await entries_of(app, copy))
    for body, _ in refused:
        response = await post_desk(client, copy, body)
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), body
    assert set(await desks_of(app, copy)) == {copy.desk_id}
    assert [row.name for row in await rows_of(app, copy.copy_id, select(Business))] == ["Rivera Plumbing"]
    # with no new Desk, each refusal goes on the ledger of the Desk whose document it held
    assert [entry.event.summary for entry in (await entries_of(app, copy))[before:]] == [
        {"part": "desk", "refused": "canary", "fields": named, "fact_ids": [f"document:{dana.document_id}"]}
        for _, named in refused]
    # a new Desk of a business whose name was stored holding a canary would carry it in its public
    # address, which is made from that name, so it is refused too
    [rivera_business] = await rows_of(app, copy.copy_id, select(Business))
    await store_business(app, copy, name=f"Rivera Plumbing {dana.canary}")
    response = await post_desk(client, copy, new_desk(existing_business_id=rivera_business.business_id))
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert set(await desks_of(app, copy)) == {copy.desk_id}
    assert (await entries_of(app, copy))[-1].event.summary == {
        "part": "desk", "refused": "canary", "fields": ["business.name"],
        "fact_ids": [f"document:{dana.document_id}"]}
    await assert_no_canary_on_record(app, copy, dana.canary)


async def test_a_new_desk_holding_two_desks_documents_is_ledgered_on_both(app, client):
    copy = await rivera(app, client)
    response = await post_desk(client, copy, new_desk())
    assert response.status_code == 200, response.text
    lopez = DeskCreated.model_validate(response.json())
    seeded = await documents(app, copy)
    dana, kim = seeded["dana-invoice"], seeded["kim-estimate"]
    before = {desk_id: len(await entries_of(app, copy, desk_id)) for desk_id in (copy.desk_id, lopez.desk_id)}
    # Dana's invoice (on Rivera's Desk) in the business's name, Kim's estimate (on Lopez's) in the Desk's
    line_2 = LOPEZ_DESK.model_copy(update={"name": f"Line 2 {kim.canary}"})
    response = await post_desk(client, copy, new_desk(name=f"Lopez Electric {dana.canary}", desk=line_2))
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    # with no new Desk, the refusal goes on each Desk whose document it held
    refused = {"part": "desk", "refused": "canary", "fields": ["business.name", "desk.name"],
               "fact_ids": [f"document:{document_id}" for document_id in sorted((dana.document_id, kim.document_id))]}
    for desk_id, count in before.items():
        assert [entry.event.summary for entry in (await entries_of(app, copy, desk_id))[count:]] == [refused]
    assert set(await desks_of(app, copy)) == {copy.desk_id, lopez.desk_id}
    assert not [entry for desk_id in before for entry in await entries_of(app, copy, desk_id)
                if dana.canary in entry.envelope_jcs or kim.canary in entry.envelope_jcs]


SHARP_S = ("ß", "ẞ")                       # a small and a capital sharp s


def sharp_s(canary: str, ch: str) -> str:
    """`canary` with `ch` (a sharp s) inside it: "cdk-aa72cbeec5ße3a2fd". Read on the page, it
    gives "ss"; made into a slug, it is dropped, which leaves the canary itself."""
    return f"{canary[:14]}{ch}{canary[14:]}"


async def test_a_canary_the_public_address_would_carry_is_refused(app, client):
    """The new Desk's slug, its public address, is checked as it would be written: a name that
    holds a canary only once made into a slug is refused like one that holds it as typed."""
    copy = await rivera(app, client)
    dana = (await documents(app, copy))["dana-invoice"]
    [rivera_business] = await rows_of(app, copy.copy_id, select(Business))
    refused = {"part": "desk", "refused": "canary", "fields": ["business.name"],
               "fact_ids": [f"document:{dana.document_id}"]}
    for ch in SHARP_S:
        name = f"Lopez Electric {sharp_s(dana.canary, ch)}"
        assert dana.canary in desks.slugify(name)
        response = await post_desk(client, copy, new_desk(name=name))
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), name
        assert (await entries_of(app, copy))[-1].event.summary == refused
        # and a new Desk of a business whose stored name would make the same slug
        await store_business(app, copy, name=f"Rivera Plumbing {sharp_s(dana.canary, ch)}")
        response = await post_desk(client, copy, new_desk(existing_business_id=rivera_business.business_id))
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), ch
        assert (await entries_of(app, copy))[-1].event.summary == refused
    assert set(await desks_of(app, copy)) == {copy.desk_id}
    assert [row.slug for row in (await desks_of(app, copy)).values()] == [copy.slug]
    await assert_no_canary_on_record(app, copy, dana.canary)


async def test_a_canary_split_after_a_new_desks_business_name_is_refused(app, client, monkeypatch):
    """The business's name is read beside the field after it, as `PUT business` reads it: checking
    the slug with the name (its random suffix is never passed over) doesn't come between them, so a
    canary split between the name and the next field is refused on a new Desk too."""
    # canaries ending in two letters, so an owner's display name (letters only) can hold the end of one
    monkeypatch.setattr(desks, "new_canary", lambda: f"cdk-{secrets.token_hex(7)}fd")
    copy = await rivera(app, client)
    dana = (await documents(app, copy))["dana-invoice"]
    head, tail = dana.canary[:-2], dana.canary[-2:]
    [rivera_business] = await rows_of(app, copy.copy_id, select(Business))
    before = len(await entries_of(app, copy))
    # a new business: its name, then its owner's display name, which passes the display name's own check
    response = await post_desk(client, copy, new_desk(name=f"Lopez Electric {head}",
                                                      owner_display_name=f"{tail.capitalize()} Lopez"))
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    # an existing business whose stored name holds the start, then the new Desk's name
    await store_business(app, copy, name=f"Rivera Plumbing {head}")
    response = await post_desk(client, copy, new_desk(existing_business_id=rivera_business.business_id,
                                                      desk=LOPEZ_DESK.model_copy(update={"name": f"{tail} Line 2"})))
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    # a split names every field the request's check read
    fact_ids = [f"document:{dana.document_id}"]
    assert [entry.event.summary for entry in (await entries_of(app, copy))[before:]] == [
        {"part": "desk", "refused": "canary", "fields": ["business.name", "business.owner_display_name",
                                                         "business.brand", "desk.name", "desk.charter",
                                                         "desk.price_items"], "fact_ids": fact_ids},
        {"part": "desk", "refused": "canary", "fields": ["business.name", "desk.name", "desk.charter",
                                                         "desk.price_items"], "fact_ids": fact_ids}]
    assert set(await desks_of(app, copy)) == {copy.desk_id}
    assert [row.name for row in await rows_of(app, copy.copy_id, select(Business))] == [f"Rivera Plumbing {head}"]
    await assert_no_canary_on_record(app, copy, dana.canary, head)


RIVERA_CONTACT = {"key": "contact", "kind": "text", "value": "(510) 555-0142"}


def policy(key: str, text: str) -> dict:
    """A charter claim: the public policy `policy:<key>`."""
    return {"key": f"policy:{key}", "kind": "text", "value": text}


def price(item_id: str, title: str, unit_cents: int = 5_000) -> dict:
    return {"item_id": item_id, "title": title, "unit_cents": unit_cents}


async def charter_and_prices(app: FastAPI, copy: Rivera) -> tuple[list, list]:
    """The Desk's charter facts and price items, as stored."""
    facts = await rows_of(app, copy.copy_id, select(FactRow).where(
        FactRow.desk_id == copy.desk_id, FactRow.kind == "charter").order_by(FactRow.fact_id))
    items = await rows_of(app, copy.copy_id, select(PriceRow).where(
        PriceRow.desk_id == copy.desk_id).order_by(PriceRow.item_id))
    return ([(row.fact_id, row.claims) for row in facts], [(row.item_id, row.title, row.unit_cents) for row in items])


async def test_a_canary_in_a_public_policy_or_a_price_is_refused(app, client):
    """The public page shows the charter's policies, and strangers are quoted from the price
    list's titles, so a write of either holding a canary is refused like a header field's, its
    keys and IDs (which name the facts) as well as its text."""
    copy = await rivera(app, client)
    seeded = await documents(app, copy)
    dana, bob = seeded["dana-invoice"], seeded["bob-warranty"]
    stored, charter = await charter_and_prices(app, copy), (await public_page(client, copy)).charter
    refused = [
        # the owner pastes Dana's invoice reference into a public policy
        ("charter", [RIVERA_CONTACT, policy("refunds", f"Refunds go to the card used (ref {dana.canary}).")], dana),
        # split by a space, half of it in full width
        ("charter", [policy("refunds", f"Refunds: ref {full_width(dana.canary[:10])} {dana.canary[10:]}.")], dana),
        # or names a policy after it, which is its fact's ID
        ("charter", [RIVERA_CONTACT, policy(bob.canary, "See the warranty.")], bob),
        # a price item's title, disguised, or its ID
        ("price_items", [price("lookup", f"Invoice {disguises(dana.canary)[-1]}")], dana),
        ("price_items", [price("visit", "Service visit"), price(bob.canary, "Warranty check")], bob),
    ]
    before = len(await entries_of(app, copy))
    for field, value, _ in refused:
        response = await put_part(client, copy, "charter" if field == "charter" else "prices", {field: value})
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), value
    assert [entry.event.summary for entry in (await entries_of(app, copy))[before:]] == [
        {"part": "charter" if field == "charter" else "prices", "refused": "canary", "fields": [field],
         "fact_ids": [f"document:{document.document_id}"]} for field, _, document in refused]
    assert await charter_and_prices(app, copy) == stored
    assert (await public_page(client, copy)).charter == charter
    # a new Desk is held to the same
    for update, field in (({"charter": [Claim(key="policy:refunds", kind="text", value=f"Ref {dana.canary}")]},
                           "desk.charter"),
                          ({"price_items": [PriceItem(item_id="visit", title=f"Visit {dana.canary}", unit_cents=1)]},
                           "desk.price_items")):
        response = await post_desk(client, copy, new_desk(desk=LOPEZ_DESK.model_copy(update=update)))
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), field
        assert (await entries_of(app, copy))[-1].event.summary == {
            "part": "desk", "refused": "canary", "fields": [field], "fact_ids": [f"document:{dana.document_id}"]}
    assert set(await desks_of(app, copy)) == {copy.desk_id}
    await assert_no_canary_on_record(app, copy, dana.canary, bob.canary)
    # Text one character away from a canary still fails the policy's number scan; the canary
    # refusals above win over that scan and never return detail about the private text.
    near = dana.canary[:-1] + ("1" if dana.canary.endswith("0") else "0")
    response = await put_part(client, copy, "charter", {
        "charter": [RIVERA_CONTACT, policy("refunds", f"For our records: 5-7 days, {near}.")]})
    assert (response.status_code, response.json()) == (
        422, {"code": "invalid", "detail": {"policy:refunds": ["digit"]}})
    assert await charter_and_prices(app, copy) == stored
    await updated(client, copy, "charter", {"charter": [RIVERA_CONTACT, policy("about", "Ask about our services.")]})
    # Prices keep their structured checks, including digits in their IDs and titles.
    await updated(client, copy, "prices", {"price_items": [price("drain-24-7", "Drain clearing, 24/7", 18_000)]})


async def withheld_alerts(app: FastAPI, copy: Rivera) -> list[str]:
    """The bodies of the owner's alerts that the public page left something out."""
    return [row.body for row in await rows_of(app, copy.copy_id, select(InboxRow).where(
        InboxRow.desk_id == copy.desk_id, InboxRow.kind == "alert", InboxRow.to == "owner",
        InboxRow.preview == "Hidden from your public page").order_by(InboxRow.created_at))]


@pytest.mark.parametrize("unsafe", ["Free consultations for everyone.", "Bonjour nous vous nous vous nous vous."])
async def test_public_withholds_only_the_failing_policy_without_an_alert(app, client, unsafe):
    """The owner's decision of 2026-11-01: a stored policy line that fails the public-text scan is
    left off the page, and the owner isn't alerted."""
    from .test_decide import open_visitor
    from .test_reply_check import assert_handed_off, checked, clause, public_key, verify_verdict

    copy = await rivera(app, client)
    honest = "Ask about our services."
    response = await put_part(client, copy, "charter", {"charter": [
        {"key": "policy:about", "kind": "text", "value": honest},
        {"key": "policy:pricing", "kind": "text", "value": "Ask about pricing."}]})
    assert response.status_code == 200, response.text
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == copy.desk_id, FactRow.fact_id == "charter:policy:pricing")))).one()
        row.claims = [Claim(key="policy:pricing", kind="text", value=unsafe)]
    for language in ("en", "es"):
        page = await public_page(client, copy, language)
        assert [(block.fact_id, block.text) for block in page.charter if block.template == "policy"] == [
            ("charter:policy:about", honest)]
    assert await withheld_alerts(app, copy) == []
    visitor = await open_visitor(client, copy)
    verdict = await checked(client, visitor, "", [clause("policy", "charter:policy:about")])
    assert verdict.ok and verdict.violations == []
    assert [block.text for block in verdict.blocks] == [honest]
    verify_verdict(await public_key(client), visitor.session_id, verdict)
    verdict = await checked(client, visitor, "", [clause("policy", "charter:policy:pricing")])
    assert_handed_off(verdict)
    assert [(v.rule_id, v.fact_ids) for v in verdict.violations] == [
        ("policy_combined", ["charter:policy:pricing"])]


async def test_a_stored_canary_is_withheld_from_the_public_page(app, client, frozen_clock):
    copy = await rivera(app, client)
    dana = (await documents(app, copy))["dana-invoice"]
    clean = await public_page(client, copy)
    assert (clean.business_name, clean.desk_name, clean.owner_display_name, clean.brand) == (
        "Rivera Plumbing", "Main line", "Maria Rivera", RIVERA_BRAND)
    # Dana's invoice, pasted into the business's name before the check
    await store_business(app, copy, name=dana.body)
    response = await client.get(f"/public/{copy.slug}")
    assert response.status_code == 200, response.text
    assert dana.canary not in response.text and "Dana Whitfield" not in response.text
    page = PublicDesk.model_validate(response.json())
    # the name gives way to its fallback, in the Agent Card too, and the rest of the page is served as it was
    assert page == clean.model_copy(update={"business_name": "",
                                            "agent_card": card_naming(clean.agent_card, "Rivera Plumbing",
                                                                      WITHHELD_BUSINESS["en"])})
    # the owner hears of it at most once an hour
    alert = ("Text from one of your private documents is in your business name, so your public page doesn't show "
             "it. Change it to show it again.")
    assert await withheld_alerts(app, copy) == [alert]
    await public_page(client, copy)
    frozen_clock.advance(59 * 60)
    await public_page(client, copy)
    assert await withheld_alerts(app, copy) == [alert]
    frozen_clock.advance(60)
    await public_page(client, copy)
    assert await withheld_alerts(app, copy) == [alert, alert]


async def test_each_field_is_withheld_alone_and_a_split_withholds_them_all(app, client, frozen_clock):
    copy = await rivera(app, client)
    seeded = await documents(app, copy)
    dana, bob = seeded["dana-invoice"], seeded["bob-warranty"]
    clean = await public_page(client, copy)
    # the owner's name and a brand color, each holding a canary however written, give way alone
    await store_business(app, copy, owner_display_name=f"Maria {bob.canary.upper()}",
                         brand={"primary": "#1F4E4A", "accent": full_width(dana.canary)})
    assert await public_page(client, copy) == clean.model_copy(update={
        "owner_display_name": "", "brand": {},
        "agent_card": card_naming(clean.agent_card, "Maria Rivera", WITHHELD_OWNER["en"])})
    assert await withheld_alerts(app, copy) == [
        "Text from one of your private documents is in your display name and brand colors, so your public page "
        "doesn't show them. Change them to show them again."]
    # a canary split between the business's name and the Desk's, which the page shows side by side,
    # leaves out every field
    await store_business(app, copy, name=f"Rivera Plumbing {dana.canary[:10]}", owner_display_name="Maria Rivera",
                         brand=RIVERA_BRAND)
    await store(app, copy, Desk, name=f"{dana.canary[10:]} Main line")
    frozen_clock.advance(60 * 60)
    response = await client.get(f"/public/{copy.slug}")
    assert dana.canary[:10] not in response.text and dana.canary[10:] not in response.text
    page = PublicDesk.model_validate(response.json())
    assert (page.business_name, page.desk_name, page.owner_display_name, page.brand, page.charter) == (
        "", "", "", {}, clean.charter)
    assert (await withheld_alerts(app, copy))[-1] == (
        "Text from one of your private documents is in your business name, Desk name, display name and brand "
        "colors, so your public page doesn't show them. Change them to show them again.")


@pytest.mark.parametrize("lang", ["en", "es"])
async def test_the_agent_card_names_a_withheld_name_in_fixed_words(app, client, frozen_clock, lang):
    copy = await rivera(app, client)
    seeded = await documents(app, copy)
    dana, bob = seeded["dana-invoice"], seeded["bob-warranty"]
    clean = await public_page(client, copy, lang)
    # the business's name holds Dana's invoice: the card says "this business" in the page's language
    await store_business(app, copy, name=dana.body)
    response = await client.get(f"/public/{copy.slug}", params={"lang": lang})
    assert response.status_code == 200, response.text
    assert dana.canary not in response.text and "Dana Whitfield" not in response.text
    card = PublicDesk.model_validate(response.json()).agent_card
    assert card == card_naming(clean.agent_card, "Rivera Plumbing", WITHHELD_BUSINESS[lang])
    assert all("  " not in block.text for block in card)
    # the owner's name holds Bob's canary instead: the card says "the owner"
    await store_business(app, copy, name="Rivera Plumbing", owner_display_name=f"Maria {bob.canary}")
    response = await client.get(f"/public/{copy.slug}", params={"lang": lang})
    assert response.status_code == 200, response.text
    assert bob.canary not in response.text
    card = PublicDesk.model_validate(response.json()).agent_card
    assert card == card_naming(clean.agent_card, "Maria Rivera", WITHHELD_OWNER[lang])
    assert all("  " not in block.text and " 's" not in block.text for block in card)


async def test_ordinary_names_pass(app, client):
    copy = await rivera(app, client)
    dana = (await documents(app, copy))["dana-invoice"]
    [rivera_business] = await rows_of(app, copy.copy_id, select(Business))
    # digits, symbols, accents and hex colors are ordinary; so is text one character away from a
    # canary: a digit changed, or a plain letter between its characters
    near = dana.canary[:-1] + ("1" if dana.canary.endswith("0") else "0")
    for name in ("Rivera Plumbing & Drains 24/7", f"Rivera Plumbing, ref {near}",
                 f"Rivera Plumbing {dana.canary[:10]}x{dana.canary[10:]}"):
        before = len(await entries_of(app, copy))
        response = await put_part(client, copy, "business", business(
            name=name, owner_display_name="María O'Neil-Rivera", brand={"primary": "#0F3D3A", "accent": "#C2410C"}))
        assert response.status_code == 200, (name, response.text)
        assert [entry.event.summary for entry in (await entries_of(app, copy))[before:]] == [
            {"part": "business", "refs": [rivera_business.business_id]}]
        page = await public_page(client, copy)
        assert (page.business_name, page.owner_display_name, page.brand) == (
            name, "María O'Neil-Rivera", {"primary": "#0F3D3A", "accent": "#C2410C"})
    assert await withheld_alerts(app, copy) == []
    after_hours = LOPEZ_DESK.model_copy(update={"name": "Line 2, after hours"})
    response = await post_desk(client, copy, new_desk(desk=after_hours))
    assert response.status_code == 200, response.text


async def test_the_public_page_serves_a_pick_a_free_form_brand_or_teal(app, client):
    copy = await rivera(app, client)
    teal = {"palette": "teal", **BRAND_PALETTE["teal"]}
    assert (await public_page(client, copy)).brand == teal                       # the seed's pick
    # a pick shows as its key and the table's colours
    for key in ("plum", "clay"):
        await updated(client, copy, "business", business(brand={}, brand_palette=key))
        assert (await public_page(client, copy)).brand == {"palette": key, **BRAND_PALETTE[key]}, key
    # a brand passed back with a pick shows the table's colours, never the colours it sent
    await updated(client, copy, "business", business(brand={"palette": "navy", "primary": "#000000"}))
    assert (await public_page(client, copy)).brand == {"palette": "navy", **BRAND_PALETTE["navy"]}
    # "none", no colours: the key alone, so the web draws its neutral header
    await updated(client, copy, "business", business(brand={}, brand_palette="none"))
    assert (await public_page(client, copy)).brand == {"palette": "none"}
    # nothing stored reads as teal; free-form colours from before the palette show as stored
    await updated(client, copy, "business", business(brand={}))
    assert (await public_page(client, copy)).brand == teal
    legacy = {"primary": "#0F3D3A", "accent": "#C2410C"}
    await store_business(app, copy, brand=legacy)
    assert (await public_page(client, copy)).brand == legacy
    assert await withheld_alerts(app, copy) == []
