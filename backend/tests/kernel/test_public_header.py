"""No document canary in the public page's header.

Anyone may read a Desk's public page (`GET /public/{slug}`) with no session, and its header shows
the owner's words as they were typed: the business's name, the Desk's name, the owner's display
name and the brand colors. So an owner write of one of them that carries a document's canary, even
split or disguised, is refused (422 `invalid`) and ledgered `desk_data` `{part, refused: "canary",
fields, fact_ids}`, naming the fields and the documents, never the text. A value stored before
that check is withheld from the page, which shows the field's safe fallback instead, and the
owner is alerted in the Demo inbox. Tests run on Rivera Plumbing copies as `POST /copies` seeds
them (Friday 10:04 in Oakland).
"""

import httpx
from fastapi import FastAPI
from sqlalchemy import select

from desk.db.models import Business, Desk
from desk.db.models import DemoInboxEntry as InboxRow
from desk.kernel_api import PublicDesk

from .helpers import kernel_ctx, rows_of
from .test_adapters import Rivera, rivera
from .test_desk_writes import LOPEZ_DESK, desks_of, entries_of, new_desk, post_desk, put_part
from .test_labels_hardening import assert_no_canary_on_record, disguises, documents, full_width

RIVERA_BRAND = {"primary": "#1F4E4A", "accent": "#B87333"}
RIVERA_BUSINESS = {"name": "Rivera Plumbing", "owner_display_name": "Maria Rivera",
                   "timezone": "America/Los_Angeles", "brand": RIVERA_BRAND}


def business(**fields) -> dict:
    """A `PUT /desks/{id}/business` body: Rivera Plumbing's business with `fields` changed."""
    return RIVERA_BUSINESS | fields


async def public_page(client: httpx.AsyncClient, copy: Rivera) -> PublicDesk:
    response = await client.get(f"/public/{copy.slug}")
    assert response.status_code == 200, response.text
    return PublicDesk.model_validate(response.json())


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


async def withheld_alerts(app: FastAPI, copy: Rivera) -> list[str]:
    """The bodies of the owner's alerts that the public page left something out."""
    return [row.body for row in await rows_of(app, copy.copy_id, select(InboxRow).where(
        InboxRow.desk_id == copy.desk_id, InboxRow.kind == "alert", InboxRow.to == "owner",
        InboxRow.preview == "Hidden from your public page").order_by(InboxRow.created_at))]


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
    # the name gives way to its fallback, and the rest of the page is served as it was
    assert page == clean.model_copy(update={"business_name": ""})
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
    assert await public_page(client, copy) == clean.model_copy(update={"owner_display_name": "", "brand": {}})
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
