"""The owner's knowledge list reads only its Desk's kernel view, preserving masked content."""

from datetime import datetime, timedelta
from hashlib import sha256

from desk.kernel_api import DecideRequest, ExecuteRequest

from tests.api.test_owner_desks import new_desk, new_owner


async def test_fresh_copy_lists_seeded_knowledge_in_creation_order(api, browser, fake, kernel_http):
    owner = await new_owner(api, browser, fake, kernel_http)
    path = f"/api/owner/desks/{owner.desk_id}/knowledge"
    seeded = fake.desks[owner.desk_id]
    calls = len(fake.calls)

    reply = await owner.browser.get(path)

    assert reply.status_code == 200, reply.text
    rows = reply.json()
    assert [row["item_id"] for row in rows] == ["kn-website", "kn-price-list"]
    assert datetime.fromisoformat(rows[0]["created_at"]) < datetime.fromisoformat(rows[1]["created_at"])
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
    assert [row["item_id"] for row in rows] == ["kn-website", "kn-price-list", "a-later"]
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
    assert [row["item_id"] for row in rows] == ["a-legacy", "z-legacy", "kn-website", "kn-price-list"]
    assert [row["created_at"] for row in rows[:2]] == [None, None]


async def test_knowledge_order_uses_database_collation_with_null_timestamps(
        api, browser, fake, kernel_http, fake_ro, db):
    owner = await new_owner(api, browser, fake, kernel_http)
    tied_at = fake.now - timedelta(seconds=1)
    fake_ro.write({"knowledge_items": [
        {"copy_id": owner.copy_id, "desk_id": owner.desk_id, "item_id": item_id, "source": "upload",
         "title": "Notes", "text": "Call on weekdays.", "readers": ["public"], "created_at": created_at}
        for item_id, created_at in (("A", tied_at), ("a", tied_at), ("z-legacy", None))]})
    # Use PostgreSQL's collation as the oracle, as the kernel does, rather than Python's string order.
    expected = [row[0] for row in db.execute(
        "SELECT item_id FROM fake_kernel_ro.knowledge_items WHERE copy_id = %s AND desk_id = %s"
        " ORDER BY created_at NULLS FIRST, item_id", (owner.copy_id, owner.desk_id)).fetchall()]

    reply = await owner.browser.get(f"/api/owner/desks/{owner.desk_id}/knowledge")

    assert reply.status_code == 200, reply.text
    rows = reply.json()
    assert rows[0]["item_id"] == "z-legacy"
    assert rows[0]["created_at"] is None
    assert {row["item_id"] for row in rows[1:3]} == {"a", "A"}
    assert [row["item_id"] for row in rows] == expected


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


async def test_web_search_knowledge_lists_for_its_owner(api, browser, fake, kernel_http, fake_ro):
    """What setup's web search stored (`source: "web_search"`, owner-only) lists like any other knowledge."""
    owner = await new_owner(api, browser, fake, kernel_http)
    path = f"/api/owner/desks/{owner.desk_id}/knowledge"
    fake_ro.write({"knowledge_items": [{
        "copy_id": owner.copy_id, "desk_id": owner.desk_id, "item_id": "search-0123456789abcdef",
        "source": "web_search", "title": "Web search: How CPA firms onboard clients", "text": "Cited page text.",
        "readers": ["owner"], "created_at": fake.now}]})

    reply = await owner.browser.get(path)

    assert reply.status_code == 200, reply.text
    (row,) = [row for row in reply.json() if row["item_id"] == "search-0123456789abcdef"]
    assert (row["source"], row["readers"]) == ("web_search", ["owner"])


async def test_owner_search_results_are_listed_as_knowledge(api, browser, fake, kernel_http):
    owner = await new_owner(api, browser, fake, kernel_http)
    kernel_owner = kernel_http.owner(owner.token)
    session = owner.copy.owner_session
    decision = await kernel_owner.call("POST /decide", DecideRequest(
        session_id=session.session_id, generation=session.generation, desk_id=owner.desk_id,
        call={"call_id": "search-knowledge", "tool": "native.web_search", "args": {"query": "plumber services"}}))
    assert decision.outcome == "allow"
    result = await kernel_owner.call("POST /execute", ExecuteRequest(
        decision_id=decision.decision_id, session_id=session.session_id, generation=session.generation))
    assert result.state == "succeeded"

    reply = await owner.browser.get(f"/api/owner/desks/{owner.desk_id}/knowledge")

    assert reply.status_code == 200, reply.text
    rows = [row for row in reply.json() if row["source"] == "web_search"]
    assert rows == [{
        "item_id": "search-" + sha256(hit["url"].encode()).hexdigest()[:16],
        "source": "web_search", "title": "Web search: " + hit["title"], "text": hit["snippet"],
        "readers": ["owner"], "created_at": fake.now.isoformat().replace("+00:00", "Z")}
        for hit in result.model_view["results"]]
    assert rows
