"""The owner's knowledge list reads only its Desk's kernel view, preserving masked content."""

from datetime import datetime, timedelta

from tests.api.test_owner_desks import new_desk, new_owner


async def test_fresh_copy_lists_seeded_knowledge_in_creation_order(api, browser, fake, kernel_http):
    owner = await new_owner(api, browser, fake, kernel_http)
    path = f"/api/owner/desks/{owner.desk_id}/knowledge"
    seeded = fake.desks[owner.desk_id]
    calls = len(fake.calls)

    reply = await owner.browser.get(path)

    assert reply.status_code == 200, reply.text
    rows = reply.json()
    assert [row["item_id"] for row in rows] == ["kn-price-list", "kn-website"]
    for row in rows:
        item = seeded.knowledge[row["item_id"]]
        assert set(row) == {"item_id", "title", "text", "readers", "source", "created_at"}
        assert (row["title"], row["text"], row["readers"], row["source"]) == (
            item.title, item.text, ["public"], item.source)
        assert datetime.fromisoformat(row["created_at"]) == seeded.knowledge_created_at[item.item_id]
    # Authentication is the only kernel request: listing reads the copy-scoped view without a write.
    assert [call.route for call in fake.calls[calls:]] == ["GET /whoami"]

    fake.now += timedelta(seconds=1)
    added = {"item_id": "a-later", "title": "Hours", "text": "Call on weekdays.", "source": "setup",
             "label": {"readers": ["public"]}}
    assert (await owner.browser.post(path, json={"item": added})).status_code == 200
    rows = (await owner.browser.get(path)).json()
    assert [row["item_id"] for row in rows] == ["kn-price-list", "kn-website", "a-later"]
    assert datetime.fromisoformat(rows[-1]["created_at"]) == fake.now


async def test_legacy_knowledge_sorts_first_with_required_null_timestamp(api, browser, fake, kernel_http, fake_ro):
    owner = await new_owner(api, browser, fake, kernel_http)
    # These pre-migration rows have no creation time; reverse insertion tests the item_id tie-break too.
    fake_ro.write({"knowledge_items": [
        {"copy_id": owner.copy_id, "desk_id": owner.desk_id, "item_id": item_id, "source": "upload",
         "title": "Old notes", "text": "Call on weekdays.", "readers": ["public"], "created_at": None}
        for item_id in ("z-legacy", "a-legacy")]})

    reply = await owner.browser.get(f"/api/owner/desks/{owner.desk_id}/knowledge")

    assert reply.status_code == 200, reply.text
    rows = reply.json()
    assert [row["item_id"] for row in rows] == ["a-legacy", "z-legacy", "kn-price-list", "kn-website"]
    assert [row["created_at"] for row in rows[:2]] == [None, None]


async def test_owner_only_knowledge_preserves_readers_and_view_masking(api, browser, fake, kernel_http, fake_ro):
    owner = await new_owner(api, browser, fake, kernel_http)
    path = f"/api/owner/desks/{owner.desk_id}/knowledge"
    for item_id, readers in (("owner-note", ["owner"]), ("forced-private", ["public"])):
        item = {"item_id": item_id, "title": "Private notes", "text": "Private business information.",
                "source": "memory_import", "label": {"readers": readers}}
        added = await owner.browser.post(path, json={"item": item})
        assert added.status_code == 200, added.text
    # FakeKernel does not classify document canaries. Mirror the real view's output after the kernel forces an
    # item owner-only: both content fields are null, even for this owner read. No kernel implementation changes.
    fake_ro.write({"knowledge_items": [{
        "copy_id": owner.copy_id, "desk_id": owner.desk_id, "item_id": "forced-private",
        "source": "memory_import", "title": None, "text": None, "readers": ["owner"], "created_at": fake.now}]})

    reply = await owner.browser.get(path)

    assert reply.status_code == 200, reply.text
    rows = {row["item_id"]: row for row in reply.json()}
    assert rows["owner-note"] == {
        "item_id": "owner-note", "title": "Private notes", "text": "Private business information.",
        "readers": ["owner"], "source": "memory_import", "created_at": fake.now.isoformat().replace("+00:00", "Z")}
    masked = rows["forced-private"]
    assert set(masked) == {"item_id", "title", "text", "readers", "source", "created_at"}
    assert (masked["title"], masked["text"], masked["readers"]) == (None, None, ["owner"])


async def test_knowledge_list_is_scoped_to_owned_desks_and_copy(api, browser, fake, kernel_http):
    owner = await new_owner(api, browser, fake, kernel_http)
    other = await new_owner(api, browser, fake, kernel_http)
    path = f"/api/owner/desks/{owner.desk_id}/knowledge"
    for client, desk_id in ((other.browser, owner.desk_id), (owner.browser, other.desk_id),
                            (owner.browser, "unknown-desk")):
        reply = await client.get(f"/api/owner/desks/{desk_id}/knowledge")
        assert (reply.status_code, reply.json()) == (404, {"error": "not_found"})

    # A second Desk in the same copy must not inherit the first Desk's seeded knowledge.
    created = await owner.browser.post("/api/owner/desks", json=new_desk())
    assert created.status_code == 201, created.text
    empty = await owner.browser.get(f"/api/owner/desks/{created.json()['desk_id']}/knowledge")
    assert (empty.status_code, empty.json()) == (200, [])
    assert len((await owner.browser.get(path)).json()) == 2
    # Even a row in this copy is unavailable if /whoami no longer names the Desk as the owner's.
    fake.copies[owner.copy_id].desk_ids.remove(owner.desk_id)
    refused = await owner.browser.get(path)
    assert (refused.status_code, refused.json()) == (404, {"error": "not_found"})


async def test_visitor_cannot_list_owner_knowledge(api, browser, fake, kernel_http):
    owner = await new_owner(api, browser, fake, kernel_http)
    path = f"/api/owner/desks/{owner.desk_id}/knowledge"
    visitor = browser(api)
    reply = await visitor.get(path)
    assert (reply.status_code, reply.json()) == (401, {"error": "no_owner_session"})
    opened = await visitor.post(f"/api/public/desks/{owner.slug}/sessions")
    assert opened.status_code in (200, 201), opened.text
    reply = await visitor.get(path)
    assert (reply.status_code, reply.json()) == (401, {"error": "no_owner_session"})
    # A visitor credential also fails when sent in the owner-cookie slot.
    visitor.cookies.set("desk_owner", visitor.cookies.get("desk_visitor"), domain="desk.test", path="/api/owner")
    reply = await visitor.get(path)
    assert (reply.status_code, reply.json()) == (401, {"error": "no_owner_session"})
