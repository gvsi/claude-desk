"""Owner-only setup web search; every search is scripted, with no network."""

import asyncio
import hashlib

import pytest
from sqlalchemy import select

from desk.db.models import ActorSession, Document
from desk.db.models import KnowledgeItem as KnowledgeRow
from desk.kernel_service import auth, labels
from desk.kernel_service.decisions import AnthropicDecisions, OfflineDecisions, SearchHit
from .fakes import FakeAnthropicClient
from .helpers import kernel_ctx, rows_of
from .test_adapters import visitor_of
from .test_agent_auth import mint, open_agent, turn
from .test_context import context_of, tools
from .test_decide import decided
from .test_setup_tools import entries, owner_of
from .test_web_search_decisions import search_message


async def test_search_is_owner_only(app, client, frozen_clock):
    copy, visitor = await visitor_of(app, client)
    owner = await owner_of(client, copy.owner, copy.desk_id)
    assert "native.web_search" in tools((await context_of(
        client, owner.session_id, copy.owner, desk_id=copy.desk_id)).tools)
    assert "native.web_search" not in tools((await context_of(
        client, visitor.session_id, visitor.headers)).tools)
    refused = await decided(client, visitor, "native.web_search", {"query": "plumber services"})
    assert (refused.outcome, refused.state, refused.action) == ("refuse", "refused", None)

    agent = await mint(client, copy.owner, copy.desk_id)
    session = await open_agent(client, copy.slug, agent, frozen_clock)
    actor = turn(agent, copy.slug, session.state.session_id, frozen_clock)
    assert "native.web_search" not in tools((await context_of(client, actor.session_id, actor.headers)).tools)
    refused = await decided(client, actor, "native.web_search", {"query": "plumber services"})
    assert (refused.outcome, refused.state, refused.action) == ("refuse", "refused", None)


async def test_search_stores_owner_only_cited_excerpts(app, client, reviewer):
    copy, visitor = await visitor_of(app, client)
    owner = await owner_of(client, copy.owner, copy.desk_id)
    hit = SearchHit(title="Plumber services", url="https://trade.example/services", snippet="Drain clearing")
    reviewer.search_answer = [hit]
    decision, result = await owner.run("native.web_search", {"query": "plumbing services"})
    assert decision.card_ids == ["preset-web-search"]
    assert result.state == "succeeded" and result.facts == []
    assert result.model_view == {"results": [hit.model_dump()], "simulated": False, "kind": "cited_excerpts"}
    [stored] = await rows_of(app, copy.copy_id, select(KnowledgeRow).where(KnowledgeRow.source == "web_search"))
    assert (stored.item_id, stored.source, stored.title, stored.text, stored.readers) == (
        "search-" + hashlib.sha256(hit.url.encode()).hexdigest()[:16], "web_search",
        "Web search: Plumber services", "Drain clearing", ["owner"])
    assert stored.item_id not in [item.item_id for item in (await context_of(
        client, visitor.session_id, visitor.headers)).knowledge]
    assert reviewer.search_inputs == ["plumbing services"]
    [usage] = [e.event for e in await entries(app, copy.copy_id, copy.desk_id) if e.event.kind == "web_search"]
    assert usage.session_id == owner.session_id and usage.ref_id == decision.action.action_id
    assert usage.summary == {"action_id": decision.action.action_id, **reviewer.search_usage.model_dump()}
    assert "plumbing services" not in repr(usage.summary)


async def test_search_filters_canaries_urls_duplicates_and_caps(app, client, reviewer):
    copy, _ = await visitor_of(app, client)
    owner = await owner_of(client, copy.owner, copy.desk_id)
    [document] = (await rows_of(app, copy.copy_id, select(Document)))[:1]
    canary = " ".join(document.canary.upper())
    reviewer.search_answer = [
        SearchHit(title=canary, url="https://trade.example/title", snippet="text"),
        SearchHit(title="Page", url="https://trade.example/" + document.canary, snippet="text"),
        SearchHit(title="Page", url="https://trade.example/body", snippet="x" * 501 + canary),
        SearchHit(title="Local", url="file:///private", snippet="text"),
        SearchHit(title="Broken", url="https:///missing-host", snippet="text"),
        SearchHit(title="long" * 100, url="https://trade.example/0", snippet="x" * 600),
        SearchHit(title="Duplicate", url="https://trade.example/0", snippet="duplicate"),
        *[SearchHit(title=f"Page {i}", url=f"https://trade.example/{i}", snippet="" if i == 1 else "Page text")
          for i in range(1, 9)]]
    _, result = await owner.run("native.web_search", {"query": "usual plumber services"})
    assert result.state == "succeeded"
    hits = result.model_view["results"]
    assert len(hits) == 8 and [hit["url"] for hit in hits] == [f"https://trade.example/{i}" for i in range(8)]
    assert hits[0]["snippet"] == "x" * 500
    stored = await rows_of(app, copy.copy_id, select(KnowledgeRow).where(KnowledgeRow.source == "web_search"))
    assert len(stored) == 8 and all(item.readers == ["owner"] for item in stored)
    assert next(item.title for item in stored if item.text == "x" * 500) == ("Web search: " + "long" * 100)[:200]
    assert next(item.text for item in stored if item.title == "Web search: Page 1") == "Page 1"
    assert document.canary not in repr(result.model_view) + repr([(i.title, i.text) for i in stored])


async def test_fourth_search_is_refused_per_desk_even_after_failure(app, client, reviewer):
    copy, _ = await visitor_of(app, client)
    owner = await owner_of(client, copy.owner, copy.desk_id)
    # A failed call still spent this Desk's search budget.
    _, failed = await owner.run("native.web_search", {"query": "plumber services"}, "failed")
    assert failed.state == "failed"
    reviewer.search_answer = []
    for i in range(2):
        await owner.run("native.web_search", {"query": "plumber services"}, f"search-{i}")
    fourth = await owner.decide("native.web_search", {"query": "plumber services"}, "fourth")
    assert fourth.outcome == "allow"
    response = await client.post("/execute", headers=owner.headers, json={
        "decision_id": fourth.decision_id, "session_id": owner.session_id, "generation": 0})
    assert response.status_code == 409
    assert len(reviewer.search_inputs) == 3
    terminal = [entry.event.summary for entry in await entries(app, copy.copy_id, copy.desk_id)
                if entry.event.kind == "execute" and entry.event.summary.get("state") == "refused_at_execution"]
    assert terminal[-1]["check"] == "search_limit"
    other, _ = await visitor_of(app, client)
    other_owner = await owner_of(client, other.owner, other.desk_id)
    _, result = await other_owner.run("native.web_search", {"query": "salon bookings"})
    assert result.state == "succeeded" and len(reviewer.search_inputs) == 4


async def test_concurrent_searches_cannot_both_take_the_third_reservation(app, client, reviewer):
    copy, _ = await visitor_of(app, client)
    owner = await owner_of(client, copy.owner, copy.desk_id)
    reviewer.search_answer = []
    for i in range(2):
        await owner.run("native.web_search", {"query": "plumber services"}, f"earlier-{i}")
    # Distinct owner sessions: a shared session lock cannot accidentally enforce the cap for us.
    token, session_id = auth.new_token(), auth.new_session_id()
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        ctx.db.add(ActorSession(session_id=session_id, copy_id=copy.copy_id, desk_id=None, kind="owner",
                                secret_hash=auth.hash_token(token), verified=True, assurance="owner_session",
                                created_at=ctx.clock.now(), last_seen_at=ctx.clock.now()))
    second = await owner_of(client, {auth.OWNER_HEADER: token}, copy.desk_id)
    actors = [owner, second]
    decisions = [await actor.decide("native.web_search", {"query": "plumber services"}, f"race-{i}")
                 for i, actor in enumerate(actors)]
    async def execute(actor, decision):
        return await client.post("/execute", headers=actor.headers, json={
            "decision_id": decision.decision_id, "session_id": actor.session_id, "generation": 0})
    results = await asyncio.wait_for(asyncio.gather(*(execute(actor, d) for actor, d in zip(actors, decisions))),
                                     timeout=10)
    assert sorted(r.status_code for r in results) == [200, 409]
    assert len(reviewer.search_inputs) == 3


async def test_a_desks_searches_wait_on_the_model_together(app, client, reviewer, monkeypatch):
    # The tools row that serializes the cap is held only until each intent commits, never through the model call,
    # so a slow search (up to the 30 s deadline) never holds up the Desk's other searches.
    copy, _ = await visitor_of(app, client)
    owner = await owner_of(client, copy.owner, copy.desk_id)
    reviewer.search_answer = []
    search, waiting, both = reviewer.web_search, [], asyncio.Event()

    async def together(query):
        waiting.append(query)
        if len(waiting) == 2:
            both.set()
        await both.wait()
        return await search(query)

    monkeypatch.setattr(reviewer, "web_search", together)
    decisions = [await owner.decide("native.web_search", {"query": f"plumber services {i}"}, f"together-{i}")
                 for i in range(2)]
    results = await asyncio.wait_for(asyncio.gather(*(owner.execute(decision) for decision in decisions)), timeout=10)
    assert [result.state for result in results] == ["succeeded", "succeeded"]
    assert sorted(reviewer.search_inputs) == ["plumber services 0", "plumber services 1"]


async def test_failed_search_stores_nothing_and_ledgers_usage(app, client, reviewer):
    copy, _ = await visitor_of(app, client)
    owner = await owner_of(client, copy.owner, copy.desk_id)
    reviewer.search_answer = None
    decision, result = await owner.run("native.web_search", {"query": "usual plumber services"})
    assert (result.state, result.model_view, result.facts) == ("failed", {}, [])
    assert await rows_of(app, copy.copy_id, select(KnowledgeRow).where(KnowledgeRow.source == "web_search")) == []
    [usage] = [entry.event for entry in await entries(app, copy.copy_id, copy.desk_id)
               if entry.event.kind == "web_search"]
    assert usage.summary == {"action_id": decision.action.action_id, **reviewer.search_usage.model_dump()}
    assert usage.summary["status"] == "error"


async def test_offline_search_makes_no_call_and_fails(app, client, reviewer, monkeypatch):
    backend = OfflineDecisions()
    assert await backend.web_search("plumber services") == (None, None)
    monkeypatch.setattr(reviewer, "web_search", backend.web_search)
    copy, _ = await visitor_of(app, client)
    owner = await owner_of(client, copy.owner, copy.desk_id)
    _, result = await owner.run("native.web_search", {"query": "plumber services"})
    assert (result.state, result.model_view, result.facts) == ("failed", {}, [])
    assert reviewer.search_inputs == []
    assert not any(e.event.kind == "web_search" for e in await entries(app, copy.copy_id, copy.desk_id))
    assert await rows_of(app, copy.copy_id, select(KnowledgeRow).where(KnowledgeRow.source == "web_search")) == []


@pytest.mark.parametrize("args", [{"query": ""}, {"query": "x" * 201}, {"query": 5},
                                  {"query": "plumber", "extra": True}, {}])
async def test_search_arguments_are_strict_and_bounded(app, client, reviewer, args):
    copy, _ = await visitor_of(app, client)
    owner = await owner_of(client, copy.owner, copy.desk_id)
    refused = await owner.decide("native.web_search", args)
    assert (refused.outcome, refused.state, refused.action) == ("refuse", "refused", None)
    assert reviewer.search_inputs == []


async def test_parser_citation_canary_after_view_limit_is_dropped(app, client, reviewer, monkeypatch):
    copy, _ = await visitor_of(app, client)
    owner = await owner_of(client, copy.owner, copy.desk_id)
    [document] = (await rows_of(app, copy.copy_id, select(Document)))[:1]
    url = "https://trade.example/tainted"
    model = FakeAnthropicClient(search_message(content=[
        {"type": "web_search_tool_result", "tool_use_id": "srv-1", "content": [
            {"type": "web_search_result", "title": "Services", "url": url, "encrypted_content": "opaque"}]},
        {"type": "text", "text": "Model prose is not a source", "citations": [
            {"type": "web_search_result_location", "url": url, "title": "Services",
             "cited_text": "x" * 600 + document.canary, "encrypted_index": "opaque"}]}]))
    monkeypatch.setattr(reviewer, "web_search", AnthropicDecisions(model).web_search)

    _, result = await owner.run("native.web_search", {"query": "plumber services"})

    assert result.state == "succeeded"
    assert result.model_view == {"results": [], "simulated": False, "kind": "cited_excerpts"}
    assert await rows_of(app, copy.copy_id, select(KnowledgeRow).where(KnowledgeRow.source == "web_search")) == []
    assert len(model.requests) == 1


async def fill_knowledge_to(app, copy, total):
    existing = await rows_of(app, copy.copy_id, select(KnowledgeRow).where(KnowledgeRow.desk_id == copy.desk_id))
    assert len(existing) <= total
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        ctx.db.add_all([
            KnowledgeRow(desk_id=copy.desk_id, copy_id=copy.copy_id, item_id=f"capacity-{i}", source="setup",
                         title=f"Existing item {i}", text="Existing knowledge", readers=["owner"],
                         created_at=ctx.clock.now()) for i in range(total - len(existing))])


async def test_search_keeps_only_hits_that_fit_knowledge_capacity(app, client, reviewer):
    copy, _ = await visitor_of(app, client)
    owner = await owner_of(client, copy.owner, copy.desk_id)
    await fill_knowledge_to(app, copy, labels.MAX_KNOWLEDGE_ITEMS - 1)
    hits = [SearchHit(title=f"Page {i}", url=f"https://trade.example/capacity/{i}", snippet=f"Cited text {i}")
            for i in range(3)]
    reviewer.search_answer = hits

    _, result = await owner.run("native.web_search", {"query": "plumber services"})

    assert result.state == "succeeded"
    assert result.model_view == {"results": [hits[0].model_dump()], "simulated": False, "kind": "cited_excerpts"}
    stored = await rows_of(app, copy.copy_id, select(KnowledgeRow).where(KnowledgeRow.desk_id == copy.desk_id))
    assert len(stored) == labels.MAX_KNOWLEDGE_ITEMS
    assert [(item.title, item.text, item.readers) for item in stored if item.source == "web_search"] == [
        ("Web search: Page 0", "Cited text 0", ["owner"])]


async def test_search_can_replace_existing_item_when_knowledge_is_full(app, client, reviewer):
    copy, _ = await visitor_of(app, client)
    owner = await owner_of(client, copy.owner, copy.desk_id)
    hit = SearchHit(title="Updated page", url="https://trade.example/existing", snippet="Updated cited text")
    item_id = "search-" + hashlib.sha256(hit.url.encode()).hexdigest()[:16]
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        ctx.db.add(KnowledgeRow(desk_id=copy.desk_id, copy_id=copy.copy_id, item_id=item_id, source="web_search",
                                title="Old page", text="Old cited text", readers=["owner"],
                                created_at=ctx.clock.now()))
    await fill_knowledge_to(app, copy, labels.MAX_KNOWLEDGE_ITEMS)
    before = await rows_of(app, copy.copy_id, select(KnowledgeRow).where(KnowledgeRow.desk_id == copy.desk_id))
    reviewer.search_answer = [
        SearchHit(title="New page", url="https://trade.example/new-before", snippet="New cited text"), hit,
        SearchHit(title="Another new page", url="https://trade.example/new-after", snippet="New cited text")]

    _, result = await owner.run("native.web_search", {"query": "plumber services"})

    assert result.state == "succeeded"
    assert result.model_view == {"results": [hit.model_dump()], "simulated": False, "kind": "cited_excerpts"}
    after = await rows_of(app, copy.copy_id, select(KnowledgeRow).where(KnowledgeRow.desk_id == copy.desk_id))
    assert len(after) == labels.MAX_KNOWLEDGE_ITEMS
    assert {item.item_id for item in after} == {item.item_id for item in before}
    [stored] = [item for item in after if item.item_id == item_id]
    assert (stored.title, stored.text, stored.readers) == ("Web search: Updated page", hit.snippet, ["owner"])
