"""Rules by chat, presets, card diffs, tools and knowledge (Plan 02b, Task 9).

The owner changes a Desk's rules in five ways, each a draft the kernel compiles and proves and the owner confirms:
asking Claude in plain words (route `rules_chat`), adding the cards an approval drafted, applying a preset, taking a
suggestion drawn from their own approvals, or setting a new money cap (the active money cards above a lower one come
down to it in the draft, each saying its new limit). Every draft answers with its owner cards and how they differ from
the active rules, by card ID, default asks left out; a new or changed money card above the Desk's money cap, or a card
that would change starting a verification, is refused before the kernel is asked, and nothing changes until the owner
confirms. The Rules page lists each tool with the cards that cover it, and each tool's page its recent decisions.
Documents, knowledge and the demo's tool change go to the kernel as the owner.

The app runs on FakeKernel with a scripted model; `PROVING_WAIT_S` is shortened where a test waits past it.
"""

import asyncio
import html
import json
import re
from collections.abc import AsyncIterator
from datetime import time, timedelta
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text as sql

from desk.api import proving
from desk.api.main import create_app
from desk.api.metrics import record_model_call
from desk.api.prompts import (
    CARD_ID_MAX_LENGTH,
    CARD_REASON_MAX_LENGTH,
    CHAT_ERRORS,
    OWNER_CARDS_MAX,
    RULES_CHAT_SYSTEM,
    ChatCard,
    HoursAnswer,
    RuleChange,
    RuleChat,
)
from desk.api.ratelimit import LIMITS, Limit
from desk.api.rules import card_diff, chat_view, desk_hours, preset_of, rule_card
from desk.api.schemas import (
    CardDiff,
    CoveringCard,
    DraftCardsIn,
    RuleChatOut,
    RulesDraft,
    RulesView,
    Suggestion,
    ToolDecisions,
    ToolRow,
)
from desk.contracts import (
    HoursWindow,
    KnowledgeItem,
    Label,
    PolicyVersion,
    RuleCard,
    SeedDocument,
    ToolCall,
    ToolProfile,
)
from desk.kernel_api import (
    AnswerRequest,
    CreateSessionRequest,
    DecideRequest,
    DeskHoursRequest,
    DocumentCreated,
    ExecuteRequest,
    PolicyConfirmRequest,
    PolicyDraftRequest,
    ToolsSimulateChangeRequest,
)
from desk.presets import PRESETS, preset_cards
from tests.api.fakes import ScriptedModel, gated
from tests.api.test_copies import production_settings, usage_row
from tests.api.test_owner_desks import Owner, new_desk, new_owner
from tests.api.test_setup_questions import cut_short, idle_in_transaction, structured
from tests.kernel_contract.fake_kernel import DEFAULT_REASON, fake_kernel_app


@pytest.fixture
def model() -> ScriptedModel:
    return ScriptedModel()


@pytest.fixture
async def app(db, fake, api_settings, clock, model) -> AsyncIterator[FastAPI]:
    app = create_app(api_settings, kernel_transport=httpx.ASGITransport(app=fake_kernel_app(fake)), model=model,
                     clock=clock, jobs_connector=InMemoryConnector())
    async with app.router.lifespan_context(app):
        yield app


def card(card_id: str, applies_to: str = "native.quote", mode: str = "auto", **fields) -> RuleCard:
    return RuleCard(card_id=card_id, applies_to=applies_to, mode=mode, who=fields.pop("who", "anyone"),
                    reason=fields.pop("reason", f"Card {card_id}."), **fields)


def default(tool: str) -> RuleCard:
    return RuleCard(card_id=f"default-{tool}", applies_to=tool, mode="ask", who="anyone", is_default=True,
                    reason="Anything your rules don't cover waits for you.")


def test_card_diff_matches_by_id_and_skips_defaults():
    kept, before_changed = card("kept"), card("changed", max_discount_bp=500)
    after_changed, gone = card("changed", max_discount_bp=1_000), card("gone", "native.book")
    new = card("new", mode="ask")
    before = [kept, before_changed, gone, default("native.book")]
    after = [new, after_changed, kept, default("native.find_slots")]

    assert card_diff(before, after) == CardDiff(added=[new], removed=[gone], changed=[(before_changed, after_changed)])
    # A card is matched by its ID alone: the same card under a new ID is one removed and one added.
    renamed = gone.model_copy(update={"card_id": "renamed"})
    assert card_diff([gone], [renamed]) == CardDiff(added=[renamed], removed=[gone], changed=[])
    # Default asks come and go with the tools the cards cover: never a change the owner reviews.
    assert card_diff([default("native.book")], [default("native.quote")]) == CardDiff(added=[], removed=[],
                                                                                      changed=[])
    assert card_diff(before, before) == CardDiff(added=[], removed=[], changed=[])


def rules_url(owner: Owner) -> str:
    return f"/api/owner/desks/{owner.desk_id}/rules"


def owner_cards(fake, desk_id: str) -> list[RuleCard]:
    """The Desk's active owner cards, as the kernel has them."""
    return [card for card in fake.desks[desk_id].cards if not card.is_default]


async def confirmed(owner: Owner, kernel_http, desk_id: str, cards: list[RuleCard], parent: int) -> PolicyVersion:
    """`cards` drafted and confirmed straight on the kernel, as the owner: the Desk's active rules from now on."""
    view = kernel_http.owner(owner.token)
    version = await view.call("POST /policy/draft", PolicyDraftRequest(desk_id=desk_id, cards=cards,
                                                                       expected_parent=parent))
    return await view.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=desk_id, version=version.version))


async def test_rules_view_lists_each_tools_covering_cards(app, browser, fake, kernel_http):
    owner = await new_owner(app, browser, fake, kernel_http)
    desk_id = owner.desk_id
    change = card("card-change", "effect:change", mode="ask", who="verified",
                  reason="Changes for verified customers ask you first.")
    active = await confirmed(owner, kernel_http, desk_id, [*owner_cards(fake, desk_id), change],
                             fake.desks[desk_id].policy_version)
    await kernel_http.owner(owner.token).call("POST /tools/simulate_change", ToolsSimulateChangeRequest(
        desk_id=desk_id, tool="payments.create_refund"))
    desk = fake.desks[desk_id]
    fake._put_tool(desk, desk.tools["native.fetch_website"].model_copy(update={"status": "disabled"}))
    fake.flush()

    reply = await owner.browser.get(f"/api/owner/desks/{desk_id}/rules")
    assert reply.status_code == 200, reply.text
    view = RulesView.model_validate(reply.json())
    assert view.active == active and view.preset is None          # Turner's rules are neither preset
    rows = {row.tool: row for row in view.tools}
    assert list(rows) == sorted(desk.tools)

    def covering(card_id: str, *, shared: bool) -> CoveringCard:
        found = next(each for each in active.cards if each.card_id == card_id)
        return CoveringCard(card_id=card_id, mode=found.mode, reason=found.reason, shared=shared)

    # A tool's own cards are unshared; a card on one of its effects is shared with every tool that has the effect.
    assert rows["native.book"].cards == [covering("rv-book-wk", shared=False), covering("rv-book-sat", shared=False),
                                         covering("card-change", shared=True)]
    assert covering("card-change", shared=True) in rows["native.quote"].cards
    assert not any(each.card_id == "card-change" for each in rows["native.find_slots"].cards)   # read, not change
    # A tool no card covers lists the compiler's default ask.
    assert rows["payments.list_charges"].cards == [CoveringCard(card_id="default-payments.list_charges", mode="ask",
                                                                reason=DEFAULT_REASON, shared=False)]
    # Statuses pass through as the kernel has them.
    assert rows["payments.create_refund"].status == "needs_review" and rows["payments.create_refund"].pending_sha256
    assert rows["native.fetch_website"].status == "disabled" and rows["native.book"].status == "enabled"

    other = await new_owner(app, browser, fake, kernel_http)
    assert (await other.browser.get(f"/api/owner/desks/{desk_id}/rules")).status_code == 404
    assert (await browser(app).get(f"/api/owner/desks/{desk_id}/rules")).status_code == 401


async def held_quote(kernel_http, fake, owner: Owner, *, person: str | None = None, call_id: str = "call-1"):
    """A visitor on the owner's Desk (verified as `person`, if given) asks for a discounted quote: a held request."""
    created = await kernel_http.public().call("POST /sessions", CreateSessionRequest(desk_slug=owner.slug,
                                                                                     kind="visitor"))
    if person is not None:
        fake.verify(created.state.session_id, person)
    call = ToolCall(call_id=call_id, tool="native.quote",
                    args={"items": [{"item_id": "drain", "qty": 1}], "requested_discount_bp": 1_000})
    decision = await kernel_http.session(created.session_token).call(
        "POST /decide", DecideRequest(session_id=created.state.session_id, generation=0, call=call))
    assert decision.state == "held", decision
    return decision


def rules_path(owner: Owner, step: str) -> str:
    return f"/api/owner/policy/{owner.desk_id}/{step}"


async def test_approval_card_diff_drafts_through_the_kernel(app, browser, fake, kernel_http):
    owner = await new_owner(app, browser, fake, kernel_http)
    active = fake.desks[owner.desk_id].policy_version
    before = owner_cards(fake, owner.desk_id)
    decision = await held_quote(kernel_http, fake, owner, person="dana")
    answered = await owner.browser.post(f"/api/owner/approvals/{decision.decision_id}/answer",
                                        json={"answer": "allow_person"})
    assert answered.status_code == 200, answered.text
    (person_card,) = added = [RuleCard.model_validate(each) for each in answered.json()["card_diff"]]
    assert person_card.who == "person"

    reply = await owner.browser.post(rules_path(owner, "draft"), json={"add": [each.model_dump(mode="json")
                                                                               for each in added]})
    assert reply.status_code == 200, reply.text
    draft = RulesDraft.model_validate(reply.json())
    # The approval's card goes to the kernel after the active owner cards, on the active version, as cards.
    (posted,) = fake.called("POST /policy/draft")
    assert posted.headers["x-owner-session"] == owner.token
    request = PolicyDraftRequest.model_validate(posted.body)
    assert (request.desk_id, request.expected_parent, request.cards) == (owner.desk_id, active, [*before, person_card])
    version = fake.desks[owner.desk_id].versions[draft.version]
    assert (version.status, version.parent) == ("proved", active) and draft.proof == version.proof
    assert draft.cards == [*before, person_card] and draft.diff == CardDiff(added=[person_card], removed=[],
                                                                             changed=[])
    # Nothing changes until the owner confirms.
    assert RulesView.model_validate((await owner.browser.get(rules_url(owner))).json()).active.version == active

    confirmed = await owner.browser.post(rules_path(owner, "confirm"), json={"version": draft.version})
    assert confirmed.status_code == 200, confirmed.text
    assert PolicyVersion.model_validate(confirmed.json()).status == "active"
    view = RulesView.model_validate((await owner.browser.get(rules_url(owner))).json())
    assert view.active.version == draft.version and person_card in view.active.cards

    # The same card again replaces the one by its ID; a body that is neither form never reaches the kernel.
    narrower = person_card.model_copy(update={"reason": "Dana's quotes go ahead with up to 10% off."})
    reply = await owner.browser.post(rules_path(owner, "draft"), json={"add": [narrower.model_dump(mode="json")]})
    assert RulesDraft.model_validate(reply.json()).diff == CardDiff(added=[], removed=[],
                                                                    changed=[(person_card, narrower)])
    drafts = len(fake.called("POST /policy/draft"))
    for body in ({}, {"add": []}, {"add": [narrower.model_dump(mode="json")], "cards": []}):
        refused = await owner.browser.post(rules_path(owner, "draft"), json=body)
        assert (refused.status_code, refused.json()) == (422, {"error": "invalid"}), body
    assert len(fake.called("POST /policy/draft")) == drafts


async def drafted(owner: Owner, path: str, body: dict | None = None) -> RulesDraft:
    reply = await owner.browser.post(path, json=body)
    assert reply.status_code == 200, reply.text
    return RulesDraft.model_validate(reply.json())


def dumped(*cards: RuleCard) -> list[dict]:
    return [each.model_dump(mode="json") for each in cards]


def adding(*cards: RuleCard) -> dict:
    return {"add": dumped(*cards)}


async def test_draft_inputs_are_bounded(app, browser, fake, kernel_http, model):
    owner = await new_owner(app, browser, fake, kernel_http)
    active = fake.desks[owner.desk_id].policy_version
    room = OWNER_CARDS_MAX - len(owner_cards(fake, owner.desk_id))

    # At each bound a card is drafted, and Claude can carry it as it stands in a rules chat.
    longest = card("c" * CARD_ID_MAX_LENGTH, reason="r" * CARD_REASON_MAX_LENGTH)
    filling = [longest, *(card(f"fill-{n}", mode="ask") for n in range(room - 1))]
    draft = await drafted(owner, rules_path(owner, "draft"), adding(*filling))
    assert len([each for each in draft.cards if not each.is_default]) == OWNER_CARDS_MAX
    assert ChatCard.model_validate(chat_view(longest)).card_id == longest.card_id
    every = [card(f"card-{n}", mode="ask") for n in range(OWNER_CARDS_MAX)]
    await drafted(owner, rules_path(owner, "draft"), {"cards": dumped(*every), "expected_parent": active})

    # One past any of them is 422 before the kernel is asked: a card ID or a reason too long, too many cards sent,
    # or cards to add that would leave the Desk with too many.
    drafts = len(fake.called("POST /policy/draft"))
    long_id = card("c" * (CARD_ID_MAX_LENGTH + 1))
    long_reason = card("long-reason", reason="r" * (CARD_REASON_MAX_LENGTH + 1))
    too_many = [*every, card("one-more", mode="ask")]
    for body in (adding(long_id), adding(long_reason), adding(*too_many), adding(*filling, card("one-more")),
                 {"cards": dumped(long_id), "expected_parent": active},
                 {"cards": dumped(long_reason), "expected_parent": active},
                 {"cards": dumped(*too_many), "expected_parent": active}):
        refused = await owner.browser.post(rules_path(owner, "draft"), json=body)
        assert (refused.status_code, refused.json()) == (422, {"error": "invalid"})
    assert len(fake.called("POST /policy/draft")) == drafts

    # The rules chat's input is bounded too, before any model call.
    refused = await owner.browser.post(rules_path(owner, "chat"), json={"text": "q" * 2001})
    assert (refused.status_code, refused.json()) == (422, {"error": "invalid"}) and model.requests == []


def test_the_draft_bounds_the_api_document_names_are_the_ones_checked():
    """`DraftCardsIn`'s docstring is its description in `openapi.json`: the numbers it gives are the bounds the code
    checks, so changing one of them can't leave the published description behind."""
    doc = " ".join((DraftCardsIn.__doc__ or "").split())
    assert f"At most {OWNER_CARDS_MAX} cards" in doc
    assert f"each `card_id` at most {CARD_ID_MAX_LENGTH} characters" in doc
    assert f"each `reason` at most {CARD_REASON_MAX_LENGTH}," in doc
    assert sorted(set(re.findall(r"\b\d+\b", doc))) == sorted(
        {str(OWNER_CARDS_MAX), str(CARD_ID_MAX_LENGTH), str(CARD_REASON_MAX_LENGTH), "409", "422"})


async def test_a_kernel_written_card_drafts_however_long_the_persons_name(app, browser, fake, kernel_http):
    """An "allow for this person" approval drafts a card whose reason the kernel writes around the person's display
    name ("Allowed for {name} after you approved a request like this."), and a name has no bound. Posted back through
    `add`, or among the cards as they should stand, it drafts however long the name. The reason bound still holds for
    a reason of the owner's own that long, and for one shaped like the kernel's on a card that isn't for one person."""
    owner = await new_owner(app, browser, fake, kernel_http)
    active = fake.desks[owner.desk_id].policy_version
    name = "Dana " + "W" * 175
    fake.desks[owner.desk_id].person("dana").display_name = name
    decision = await held_quote(kernel_http, fake, owner, person="dana")
    answered = await owner.browser.post(f"/api/owner/approvals/{decision.decision_id}/answer",
                                        json={"answer": "allow_person"})
    assert answered.status_code == 200, answered.text
    (person_card,) = [RuleCard.model_validate(each) for each in answered.json()["card_diff"]]
    assert len(name) == 180 and len(person_card.reason) > CARD_REASON_MAX_LENGTH

    assert (await drafted(owner, rules_path(owner, "draft"), adding(person_card))).diff.added == [person_card]
    standing = [*owner_cards(fake, owner.desk_id), person_card]
    assert (await drafted(owner, rules_path(owner, "draft"), {"cards": dumped(*standing),
                                                              "expected_parent": active})).cards[-1] == person_card

    drafts = len(fake.called("POST /policy/draft"))
    for other in (person_card.model_copy(update={"reason": "r" * len(person_card.reason)}),
                  card("for-anyone", reason=person_card.reason)):
        refused = await owner.browser.post(rules_path(owner, "draft"), json=adding(other))
        assert (refused.status_code, refused.json()) == (422, {"error": "invalid"})
    assert len(fake.called("POST /policy/draft")) == drafts


async def test_confirm_conflict_is_reported(app, browser, fake, kernel_http):
    owner = await new_owner(app, browser, fake, kernel_http)
    first = await drafted(owner, rules_path(owner, "draft"), adding(card("chat-1", reason="Quotes go ahead.")))
    second = await drafted(owner, rules_path(owner, "draft"), adding(card("chat-2", "native.book", mode="never")))
    assert first.version != second.version

    reply = await owner.browser.post(rules_path(owner, "confirm"), json={"version": first.version})
    assert reply.status_code == 200 and reply.json()["version"] == first.version
    # The second draft was made on the rules the first replaced: the kernel refuses it, and the owner is told the
    # rules changed since, so they draft again; the first stays in force.
    reply = await owner.browser.post(rules_path(owner, "confirm"), json={"version": second.version})
    assert (reply.status_code, reply.json()) == (409, {"error": "rules_changed_since_draft"})
    assert RulesView.model_validate((await owner.browser.get(rules_url(owner))).json()).active.version == first.version
    assert fake.desks[owner.desk_id].versions[second.version].status == "proved"         # drafted, never active

    # A confirm whose answer was lost: the kernel activated the draft, so sending it again answers it as it is.
    third = await drafted(owner, rules_path(owner, "draft"), adding(card("chat-3", "native.find_slots")))
    fake.drop_response("POST /policy/confirm")
    lost = await owner.browser.post(rules_path(owner, "confirm"), json={"version": third.version})
    assert (lost.status_code, lost.json()) == (503, {"error": "kernel", "code": "kernel_unavailable"})
    again = await owner.browser.post(rules_path(owner, "confirm"), json={"version": third.version})
    assert (again.status_code, again.json()["status"]) == (200, "active")
    confirms = len(fake.called("POST /policy/confirm"))
    # A draft the kernel didn't prove is never sent to confirm; nor is a version that isn't the Desk's.
    fake.proof(ok=False, times=1)
    rejected = await drafted(owner, rules_path(owner, "draft"), adding(card("chat-4", "native.capture_lead")))
    assert not rejected.proof.ok
    reply = await owner.browser.post(rules_path(owner, "confirm"), json={"version": rejected.version})
    assert (reply.status_code, reply.json()) == (409, {"error": "conflict"})
    other = await new_owner(app, browser, fake, kernel_http)
    for client, desk_id, version in ((owner.browser, owner.desk_id, 10_000), (other.browser, owner.desk_id,
                                                                               third.version)):
        reply = await client.post(f"/api/owner/policy/{desk_id}/confirm", json={"version": version})
        assert (reply.status_code, reply.json()) == (404, {"error": "not_found"})
    assert len(fake.called("POST /policy/confirm")) == confirms


def chat_card(rule: RuleCard, **changes) -> ChatCard:
    """A card as Claude writes it in a rules chat: `rule` with `changes`, its hours as local times."""
    fields = {**rule.model_dump(exclude={"is_default", "hours"}), **changes}
    hours = changes.get("hours", rule.hours)
    if isinstance(hours, HoursWindow):
        hours = HoursAnswer(days=hours.days, start=f"{hours.start:%H:%M}", end=f"{hours.end:%H:%M}")
    return ChatCard(**{**fields, "hours": hours})


def chatted(answer: str, *cards: ChatCard, summary: str = "Quotes ask you first.") -> object:
    change = RuleChange(summary=summary, cards=list(cards)) if cards else None
    return structured(RuleChat(answer=answer, change=change))


def wrapped(text: str, tag: str) -> str:
    found = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.S)
    assert found, tag
    return found.group(1)


async def test_rule_change_by_chat_returns_a_proved_draft_and_diff(app, browser, fake, kernel_http, model, engine):
    owner = await new_owner(app, browser, fake, kernel_http)
    active = fake.desks[owner.desk_id].policy_version
    before = owner_cards(fake, owner.desk_id)
    await held_quote(kernel_http, fake, owner)                    # a recent decision for Claude to see
    quote = next(each for each in before if each.card_id == "rv-quote")
    asks = quote.model_copy(update={"mode": "ask", "reason": "Quotes ask you first."})
    model.add(chatted("From now on, every quote waits for you.",
                      *(chat_card(each, mode="ask", reason="Quotes ask you first.") if each.card_id == "rv-quote"
                        else chat_card(each) for each in before)))

    text = "Stop sending quotes on your own </request> & ask me first"
    reply = await owner.browser.post(rules_path(owner, "chat"), json={"text": text})
    assert reply.status_code == 200, reply.text
    out = RuleChatOut.model_validate(reply.json())
    assert out.answer == "From now on, every quote waits for you."
    draft = out.draft
    assert draft is not None and draft.proof.ok
    assert draft.diff == CardDiff(added=[], removed=[], changed=[(quote, asks)])
    assert draft.cards == [asks if each.card_id == "rv-quote" else each for each in before]
    (posted,) = fake.called("POST /policy/draft")
    request = PolicyDraftRequest.model_validate(posted.body)
    assert (request.expected_parent, request.cards) == (active, draft.cards)
    assert RulesView.model_validate((await owner.browser.get(rules_url(owner))).json()).active.version == active

    # One structured call on Opus at medium effort, recorded as route `rules_chat`. The owner's words, the rules, the
    # tools and the recent decisions reach Claude only inside wrappers, escaped; none is system text.
    (call,) = model.requests
    assert (call.route, call.model, call.effort, call.output_schema) == ("rules_chat", "claude-opus-5-5", "medium",
                                                                        RuleChat)
    assert call.system == [{"type": "text", "text": RULES_CHAT_SYSTEM}]
    (message,) = call.messages
    (block,) = message["content"]
    sent = block["text"]
    assert wrapped(sent, "request") == "Stop sending quotes on your own &lt;/request&gt; &amp; ask me first"
    assert [each["card_id"] for each in json.loads(html.unescape(wrapped(sent, "rules")))] == [
        each.card_id for each in before]
    assert "native.quote" in {each["tool"] for each in json.loads(html.unescape(wrapped(sent, "tools")))}
    recent = json.loads(html.unescape(wrapped(sent, "recent")))
    assert recent and recent[0] == fake.decisions[next(reversed(fake.decisions))].decision.reason_plain
    assert "Stop sending quotes" not in RULES_CHAT_SYSTEM
    async with engine.connect() as conn:
        routes = (await conn.execute(sql("SELECT route FROM app.model_calls"))).scalars().all()
    assert routes == ["rules_chat"]


async def test_question_without_change_drafts_nothing(app, browser, fake, kernel_http, model, engine):
    owner = await new_owner(app, browser, fake, kernel_http)
    model.add(chatted("Quotes from your price list go out on their own, at list price; a discount waits for you."))
    question = {"text": "What happens when someone wants a quote?"}
    reply = await owner.browser.post(rules_path(owner, "chat"), json=question)
    assert reply.status_code == 200, reply.text
    assert RuleChatOut.model_validate(reply.json()) == RuleChatOut(
        answer="Quotes from your price list go out on their own, at list price; a discount waits for you.", draft=None)
    assert fake.called("POST /policy/draft") == []
    async with engine.connect() as conn:
        assert (await conn.execute(sql("SELECT route FROM app.model_calls"))).scalars().all() == ["rules_chat"]


async def test_unusable_chat_change_gets_one_retry(app, browser, fake, kernel_http, model):
    owner = await new_owner(app, browser, fake, kernel_http)
    before = owner_cards(fake, owner.desk_id)
    kept = [chat_card(each) for each in before]
    # A card for one person Claude made up, a target the Desk doesn't have, a compiler's ID and an ID used twice:
    # code sends Claude the problems, once.
    made_up = ChatCard(card_id="chat-1", applies_to="native.book", mode="auto", who="person", person_id="person-dana",
                       reason="Dana books on her own.")
    elsewhere = ChatCard(card_id="chat-2", applies_to="admin.export_customers", mode="auto", who="anyone",
                         reason="Exports the customer list.")
    unusable = [*kept, made_up, elsewhere,
                chat_card(card("default-native.quote")), chat_card(card("chat-3")), chat_card(card("chat-3"))]
    fixed = [*kept, chat_card(card("chat-4", "native.capture_lead", reason="Leads are saved on their own."))]
    model.add(chatted("Done.", *unusable), chatted("Done.", *fixed))
    draft = RuleChatOut.model_validate((await owner.browser.post(rules_path(owner, "chat"), json={
        "text": "Let Dana book on her own"})).json()).draft
    assert draft is not None and [each.card_id for each in draft.diff.added] == ["chat-4"]
    retry = model.requests[1].messages[-1]["content"][0]["text"]
    lines = retry.splitlines()[1:-1]
    first = len(kept)
    assert lines == [f"- change.cards.{first}: {CHAT_ERRORS['scoped']}",
                     f"- change.cards.{first + 1}: {CHAT_ERRORS['target']}",
                     f"- change.cards.{first + 2}: {CHAT_ERRORS['default']}",
                     f"- change.cards.{first + 4}: {CHAT_ERRORS['twice']}"]

    # Twice unusable, nothing is drafted and Claude couldn't answer.
    model.add(chatted("Done.", *unusable), chatted("Done.", *unusable))
    reply = await owner.browser.post(rules_path(owner, "chat"), json={"text": "Let Dana book on her own, please"})
    assert (reply.status_code, reply.json()) == (503, {"error": "model_unavailable"})
    assert len(fake.called("POST /policy/draft")) == 1


async def test_a_chat_answer_cut_short_drafts_nothing(app, browser, fake, kernel_http, model, engine):
    # Claude's change stopped before it finished (`max_tokens`), though its text happens to fit: Claude couldn't
    # answer, so nothing is retried or drafted, and only the call's usage is recorded.
    owner = await new_owner(app, browser, fake, kernel_http)
    before = owner_cards(fake, owner.desk_id)
    change = RuleChange(summary="Quotes ask you first.",
                        cards=[chat_card(each, mode="ask", reason="Quotes ask you first.") if each.card_id == "rv-quote"
                               else chat_card(each) for each in before])
    model.add(cut_short(RuleChat(answer="From now on, every quote waits for you.", change=change)))
    reply = await owner.browser.post(rules_path(owner, "chat"), json={"text": "Ask me before every quote"})
    assert (reply.status_code, reply.json()) == (503, {"error": "model_unavailable"})
    assert len(model.requests) == 1 and fake.called("POST /policy/draft") == []
    async with engine.connect() as conn:
        assert (await conn.execute(sql("SELECT route FROM app.model_calls"))).scalars().all() == ["rules_chat"]


async def test_a_chat_waiting_on_claude_keeps_no_transaction_open(app, browser, fake, kernel_http, model, db):
    # The chat's reads of the rules, the tools and the recent decisions end before Claude is asked, so no transaction
    # waits on the model; the call is bounded.
    owner = await new_owner(app, browser, fake, kernel_http)
    await held_quote(kernel_http, fake, owner)                    # a recent decision to read
    release = asyncio.Event()
    slow = gated(chatted("Quotes from your price list go out on their own."), release)
    model.add(slow)
    reply = asyncio.create_task(owner.browser.post(rules_path(owner, "chat"), json={"text": "What about quotes?"}))
    try:
        await asyncio.wait_for(slow.entered.wait(), 5)
        assert idle_in_transaction(db) == 0
    finally:
        release.set()
    assert (await reply).status_code == 200
    (call,) = model.requests
    assert call.timeout_s == 120            # longer than setup's 60 s: the route answers 202 at 25 s regardless


async def test_chat_keeps_a_card_for_one_person_on_its_target(app, browser, fake, kernel_http, model):
    owner = await new_owner(app, browser, fake, kernel_http)
    person = card("person-dana-quote", who="person", person_id=fake.desks[owner.desk_id].person("dana").person_id,
                  max_discount_bp=1_000, reason="Dana's quotes go ahead with up to 10% off.")
    added = await drafted(owner, rules_path(owner, "draft"), adding(person))
    assert (await owner.browser.post(rules_path(owner, "confirm"), json={"version": added.version})).status_code == 200
    kept = [chat_card(each) for each in owner_cards(fake, owner.desk_id) if each.card_id != person.card_id]
    # Dana's card kept under its ID but pointed at another tool would be a new grant for one person: code sends it
    # back once. Changed in its limits on its own tool, it drafts.
    moved = chat_card(person, applies_to="native.book", max_discount_bp=0, reason="Dana books on her own.")
    narrowed = chat_card(person, max_discount_bp=500, reason="Dana's quotes go ahead with up to 5% off.")
    model.add(chatted("Done.", *kept, moved), chatted("Done.", *kept, narrowed))
    draft = RuleChatOut.model_validate((await owner.browser.post(rules_path(owner, "chat"), json={
        "text": "Let Dana book on her own"})).json()).draft
    assert draft is not None and draft.diff.changed == [(person, rule_card(narrowed))]
    retry = model.requests[1].messages[-1]["content"][0]["text"]
    assert retry.splitlines()[1:-1] == [f"- change.cards.{len(kept)}: {CHAT_ERRORS['scoped']}"]


async def test_chat_reads_every_card_the_owner_confirmed(app, browser, fake, kernel_http, model):
    owner = await new_owner(app, browser, fake, kernel_http)
    # The kernel takes any card the contract does, so an active owner card can carry a longer reason than the owner's
    # app may send or Claude may write in a chat (one put in place straight on the kernel here). Claude still reads it
    # as it stands.
    long = card("owner-quote", reason="Quotes from the price list go out on their own, at list price. " * 4)
    assert len(long.reason) > CARD_REASON_MAX_LENGTH
    await confirmed(owner, kernel_http, owner.desk_id, [*owner_cards(fake, owner.desk_id), long],
                    fake.desks[owner.desk_id].policy_version)
    model.add(chatted("Quotes from your price list go out on their own."))
    reply = await owner.browser.post(rules_path(owner, "chat"), json={"text": "What happens to quotes?"})
    assert reply.status_code == 200, reply.text
    sent = model.requests[0].messages[0]["content"][0]["text"]
    rules = json.loads(html.unescape(wrapped(sent, "rules")))
    assert {"card_id": "owner-quote", "reason": long.reason}.items() <= next(
        each for each in rules if each["card_id"] == "owner-quote").items()


async def test_rules_chat_counts_on_owner_ai_and_the_model_budget(app, browser, fake, kernel_http, model, clock,
                                                                 api_settings, passcode_hash, monkeypatch):
    monkeypatch.setattr(proving, "PROVING_WAIT_S", 0.3)
    owner = await new_owner(app, browser, fake, kernel_http)
    path = rules_path(owner, "chat")

    async def finished(body: dict) -> httpx.Response:
        for _ in range(40):
            reply = await owner.browser.post(path, json=body)
            if reply.status_code != 202:
                return reply
            assert reply.json() == {"retry": {"path": path, "body": body}}
        raise AssertionError("the rules chat did not finish after its retry responses")

    extra = card("chat-1", "native.capture_lead", reason="Leads are saved on their own.")
    model.add(chatted("Done.", *(chat_card(each) for each in [*owner_cards(fake, owner.desk_id), extra])))
    release = fake.gate("POST /policy/draft")

    # A chat sent again while its work is still going joins that work: it is counted once.
    assert (await owner.browser.post(path, json={"text": "Save leads on your own"})).status_code == 202
    assert (await owner.browser.post(path, json={"text": "Save leads on your own"})).status_code == 202
    release.set()
    assert (await finished({"text": "Save leads on your own"})).status_code == 200
    for n in range(LIMITS["owner_ai"].limit - 1):
        model.add(chatted("Quotes go out on their own."))
        assert (await finished({"text": f"What happens to quotes? ({n})"})).status_code == 200
    asked, drafts = len(model.requests), len(fake.called("POST /policy/draft"))
    assert asked == LIMITS["owner_ai"].limit

    # The 41st in the hour is refused before Claude or the kernel is asked.
    limited = await owner.browser.post(path, json={"text": "And bookings?"})
    assert (limited.status_code, limited.json()["error"]) == (429, "rate_limited")
    assert (len(model.requests), len(fake.called("POST /policy/draft"))) == (asked, drafts)

    # In production, past the daily model budget, another copy's chat is refused the same way.
    other = await new_owner(app, browser, fake, kernel_http)
    app.state.runtime.settings = production_settings(passcode_hash, api_database_url=api_settings.api_database_url,
                                                     kernel_ro_schema=api_settings.kernel_ro_schema,
                                                     trusted_proxy_hops=0)
    async with app.state.runtime.engine.begin() as conn:      # $150 today: the budget is reached
        await record_model_call(conn, "copy-budget", None, "setup", usage_row(7_500_000, clock()))
    refused = await other.browser.post(rules_path(other, "chat"), json={"text": "What happens to quotes?"})
    assert (refused.status_code, refused.json()) == (503, {"error": "demo_budget"})
    assert (len(model.requests), len(fake.called("POST /policy/draft"))) == (asked, drafts)


async def test_drafting_counts_on_the_copys_drafts_limit(app, browser, fake, kernel_http, monkeypatch):
    # Each draft is proved by the kernel, so a copy drafts and confirms at most 40 times an hour (here 3) across its
    # Desks; a request sent again that joins or takes its work's answer isn't counted again.
    assert LIMITS["drafts"] == Limit(40, 3600, "copy")
    monkeypatch.setitem(LIMITS, "drafts", Limit(3, 3600, "copy"))
    owner = await new_owner(app, browser, fake, kernel_http)
    auto = await drafted(owner, rules_path(owner, "preset"), {"preset": "auto"})
    assert (await owner.browser.post(rules_path(owner, "preset"), json={"preset": "auto"})).status_code == 200
    await drafted(owner, rules_path(owner, "preset"), {"preset": "ask_first"})
    confirmed = await owner.browser.post(rules_path(owner, "confirm"), json={"version": auto.version})
    assert confirmed.status_code == 200, confirmed.text
    drafts, confirms = len(fake.called("POST /policy/draft")), len(fake.called("POST /policy/confirm"))
    for path, body in (("draft", {"add": [card("added-1", "native.capture_lead").model_dump(mode="json")]}),
                       ("preset", {"preset": "ask_first"}), ("suggestions/native.quote", None),
                       ("money_cap", {"auto_money_cap_cents": 10_000}), ("confirm", {"version": auto.version + 1})):
        limited = await owner.browser.post(rules_path(owner, path), json=body)
        assert (limited.status_code, limited.json()["error"]) == (429, "rate_limited"), path
    assert (len(fake.called("POST /policy/draft")), len(fake.called("POST /policy/confirm"))) == (drafts, confirms)
    events = [entry.event for entry in fake.desks[owner.desk_id].ledger if entry.event.kind == "rate_limit"]
    assert [event.summary for event in events] == [{"limit": "drafts"}]


async def test_card_above_the_money_cap_is_refused_with_the_limit(app, browser, fake, kernel_http, model):
    owner = await new_owner(app, browser, fake, kernel_http)
    kept = [chat_card(each) for each in owner_cards(fake, owner.desk_id)]
    over = ChatCard(card_id="chat-1", applies_to="effect:charge", mode="auto", who="anyone", max_amount_cents=60_000,
                    reason="Takes payments up to $600 on its own.")
    model.add(chatted("I'll take payments up to $600 without asking you.", *kept, over))
    reply = await owner.browser.post(rules_path(owner, "chat"), json={"text": "Take payments up to $600 yourself"})
    # Turner's money cap is $500: nothing reaches the kernel, and the owner is told the limit to raise first.
    assert (reply.status_code, reply.json()) == (422, {"error": "above_money_cap", "cap_cents": 50_000})
    assert "$500" in model.requests[0].messages[0]["content"][0]["text"].split("\n")[0]
    assert fake.called("POST /policy/draft") == []

    # At the cap it drafts; asked of the draft route, a card above it never reaches the kernel either.
    at_cap = over.model_copy(update={"max_amount_cents": 50_000, "reason": "Takes payments up to $500 on its own."})
    model.add(chatted("I'll take payments up to $500 without asking you.", *kept, at_cap))
    reply = await owner.browser.post(rules_path(owner, "chat"), json={"text": "Then take payments up to $500"})
    draft = RuleChatOut.model_validate(reply.json()).draft
    assert draft is not None and draft.diff.added == [rule_card(at_cap)] and draft.auto_money_cap_cents == 50_000
    drafts = len(fake.called("POST /policy/draft"))
    above = {**rule_card(at_cap).model_dump(mode="json"), "max_amount_cents": 50_001}
    reply = await owner.browser.post(rules_path(owner, "draft"), json={"add": [above]})
    assert reply.status_code == 422 and len(fake.called("POST /policy/draft")) == drafts


async def test_money_cap_change_drafts_through_the_kernel(app, browser, fake, kernel_http):
    # Turner's money cap is $500, with an auto payment link card up to $300 (`rv-link`) and agent payments up to $20.
    owner = await new_owner(app, browser, fake, kernel_http)
    desk, path = fake.desks[owner.desk_id], rules_path(owner, "money_cap")
    active, rivera = desk.policy_version, owner_cards(fake, owner.desk_id)
    by_id = {each.card_id: each for each in rivera}
    link, mandate = by_id["rv-link"], by_id["rv-mandate"]
    assert (desk.auto_money_cap_cents, link.max_amount_cents, mandate.max_amount_cents) == (50_000, 30_000, 2_000)

    # Lowering it to $100: one draft of the active owner cards, on the active version, at the new cap. The $300 card
    # comes down to $100, its reason replaced by the new limit in the owner's words (the Rules page is in English),
    # and the $20 card stays as it is.
    lowered = await drafted(owner, path, {"auto_money_cap_cents": 10_000})
    (posted,) = fake.called("POST /policy/draft")
    assert posted.headers["x-owner-session"] == owner.token
    down = link.model_copy(update={"max_amount_cents": 10_000, "reason": "Up to $100, your payment limit."})
    assert PolicyDraftRequest.model_validate(posted.body) == PolicyDraftRequest(
        desk_id=owner.desk_id, cards=[down if each == link else each for each in rivera], expected_parent=active,
        auto_money_cap_cents=10_000)
    assert lowered.cards == [down if each == link else each for each in rivera]
    assert lowered.diff == CardDiff(added=[], removed=[], changed=[(link, down)])
    assert lowered.auto_money_cap_cents == 10_000 == desk.versions[lowered.version].auto_money_cap_cents
    # Nothing changes until the owner confirms: the Rules page still shows the $500 version.
    view = RulesView.model_validate((await owner.browser.get(rules_url(owner))).json())
    assert (view.active.version, view.active.auto_money_cap_cents) == (active, 50_000)

    # At $0 each auto money card asks instead, and says so.
    zero = await drafted(owner, path, {"auto_money_cap_cents": 0})
    assert zero.auto_money_cap_cents == 0
    assert [after.model_dump(include={"card_id", "mode", "max_amount_cents", "reason"})
            for _, after in zero.diff.changed] == [
        {"card_id": card_id, "mode": "ask", "max_amount_cents": None, "reason": "Your payment limit is $0."}
        for card_id in ("rv-link", "rv-mandate")]

    # Confirming the $100 draft makes its cap the Desk's.
    confirmed = await owner.browser.post(rules_path(owner, "confirm"), json={"version": lowered.version})
    assert confirmed.status_code == 200, confirmed.text
    view = RulesView.model_validate((await owner.browser.get(rules_url(owner))).json())
    assert (view.active.version, view.active.auto_money_cap_cents) == (lowered.version, 10_000)
    assert down in view.active.cards

    # Raising it to $800 changes no card: the same cards, at the new cap.
    raised = await drafted(owner, path, {"auto_money_cap_cents": 80_000})
    request = PolicyDraftRequest.model_validate(fake.called("POST /policy/draft")[-1].body)
    assert (request.cards, request.expected_parent, request.auto_money_cap_cents) == (
        owner_cards(fake, owner.desk_id), lowered.version, 80_000)
    assert raised.diff == CardDiff(added=[], removed=[], changed=[]) and raised.auto_money_cap_cents == 80_000

    # A cap above the $10,000 platform ceiling, or one that isn't a whole number of cents from 0, never reaches the
    # kernel.
    drafts = len(fake.called("POST /policy/draft"))
    for body, error in (({"auto_money_cap_cents": 1_000_001}, "above_platform_ceiling"),
                        ({"auto_money_cap_cents": -1}, "invalid"), ({"auto_money_cap_cents": 500.0}, "invalid"),
                        ({"auto_money_cap_cents": "500"}, "invalid"), ({"auto_money_cap_cents": True}, "invalid"),
                        ({}, "invalid"), ({"auto_money_cap_cents": 500, "cards": []}, "invalid")):
        reply = await owner.browser.post(path, json=body)
        assert (reply.status_code, reply.json()) == (422, {"error": error}), body
    assert (await owner.browser.post(path, json={"auto_money_cap_cents": 1_000_000})).status_code == 200
    drafts += 1

    # Another copy's Desk is not found, whatever the cap.
    other = await new_owner(app, browser, fake, kernel_http)
    for cap in (10_000, 1_000_001):
        reply = await other.browser.post(path, json={"auto_money_cap_cents": cap})
        assert (reply.status_code, reply.json()) == (404, {"error": "not_found"}), cap
    assert len(fake.called("POST /policy/draft")) == drafts


async def put_deposit(owner, kernel_http):
    from desk.contracts import BusinessTool
    from desk.kernel_api import BusinessToolsRequest

    deposit = BusinessTool(tool="desk.deposit", title="Deposit", description="Take a deposit.",
                           config={"block": "purpose_payment", "purpose": "Deposit", "amount_cents": 5000})
    await kernel_http.owner(owner.token).call("PUT /desks/{id}/business_tools",
        BusinessToolsRequest(tools=[deposit]), path={"id": owner.desk_id})


async def test_money_cap_lowering_drafts_business_payment_cards_down(app, browser, fake, kernel_http):
    owner = await new_owner(app, browser, fake, kernel_http)
    await put_deposit(owner, kernel_http)
    desk = fake.desks[owner.desk_id]
    assert desk.tools["desk.deposit"].status == "needs_review"
    deposit = card("deposit", "desk.deposit", max_amount_cents=5000, reason="Deposits up to $50.")
    await confirmed(owner, kernel_http, owner.desk_id, [*owner_cards(fake, owner.desk_id), deposit],
                    desk.policy_version)
    for cap in (2000, 0):
        lowered = await drafted(owner, rules_path(owner, "money_cap"), {"auto_money_cap_cents": cap})
        [after] = [each for each in lowered.cards if each.card_id == "deposit"]
        assert (after.mode, after.max_amount_cents, after.reason) == (
            ("auto", 2000, "Up to $20, your payment limit.") if cap
            else ("ask", None, "Your payment limit is $0."))
        assert (deposit, after) in lowered.diff.changed
    assert deposit in owner_cards(fake, owner.desk_id)
    assert desk.auto_money_cap_cents == 50_000


@pytest.mark.parametrize("route", ["draft", "chat"])
async def test_business_payment_above_cap_is_refused_before_the_kernel(app, browser, fake, kernel_http, model, route):
    owner = await new_owner(app, browser, fake, kernel_http)
    await put_deposit(owner, kernel_http)
    deposit = card("deposit", "desk.deposit", max_amount_cents=50_001)
    if route == "chat":
        kept = [chat_card(each) for each in owner_cards(fake, owner.desk_id)]
        model.add(chatted("Take deposits.", *kept, chat_card(deposit)))
        body = {"text": "Take deposits yourself."}
    else:
        body = adding(deposit)
    response = await owner.browser.post(rules_path(owner, route), json=body)
    assert (response.status_code, response.json()) == (422, {"error": "above_money_cap", "cap_cents": 50_000})
    assert fake.called("POST /policy/draft") == []


@pytest.mark.parametrize("target", ["native.payment_link", "desk.deposit"])
async def test_auto_money_card_with_no_maximum_gets_one_retry_in_chat(app, browser, fake, kernel_http, model, target):
    # "Take deposits on your own", and Claude's auto card leaves out the limit: a business money tool gets the same
    # retry line a native one does, and the corrected card drafts.
    from desk.contracts import AUTO_MONEY_HARD_CAP_CENTS

    owner = await new_owner(app, browser, fake, kernel_http)
    await put_deposit(owner, kernel_http)
    kept = [chat_card(each) for each in owner_cards(fake, owner.desk_id)]
    unlimited = ChatCard(card_id="chat-deposit", applies_to=target, mode="auto", who="anyone",
                         reason="Takes deposits on its own.")
    limited = unlimited.model_copy(update={"max_amount_cents": 5000, "reason": "Takes deposits up to $50 on its own."})
    model.add(chatted("Done.", *kept, unlimited), chatted("Done.", *kept, limited))
    reply = await owner.browser.post(rules_path(owner, "chat"), json={"text": "Take deposits on your own."})
    assert reply.status_code == 200, reply.text
    draft = RuleChatOut.model_validate(reply.json()).draft
    assert draft is not None and draft.diff.added == [rule_card(limited)]
    retry = model.requests[1].messages[-1]["content"][0]["text"]
    assert retry.splitlines()[1:-1] == [
        f"- change.cards.{len(kept)}: Value error, an auto money card needs max_amount_cents of at most "
        f"{AUTO_MONEY_HARD_CAP_CENTS}"]
    assert len(fake.called("POST /policy/draft")) == 1


async def test_business_money_card_with_no_maximum_is_above_the_cap(app, browser, fake, kernel_http):
    from desk.api.rules import AboveMoneyCap, check_cap

    unlimited = card("deposit", "desk.deposit")
    with pytest.raises(AboveMoneyCap):
        check_cap([unlimited], [], 50_000, money_tools=frozenset({"desk.deposit"}))
    check_cap([unlimited.model_copy(update={"applies_to": "desk.enquiry"})], [], 50_000,
              money_tools=frozenset({"desk.deposit"}))
    owner = await new_owner(app, browser, fake, kernel_http)
    await put_deposit(owner, kernel_http)
    response = await owner.browser.post(rules_path(owner, "draft"), json=adding(unlimited))
    assert (response.status_code, response.json()) == (422, {"error": "above_money_cap", "cap_cents": 50_000})
    assert fake.called("POST /policy/draft") == []


async def test_the_money_limit_drafts_however_many_cards_the_desk_holds(app, browser, fake, kernel_http):
    # The owner-card bound keeps a draft from growing a Desk past what a rules chat can carry. The money limit adds no
    # card, so a Desk already holding more (an active version of 61 owner cards) can still change its cap.
    owner = await new_owner(app, browser, fake, kernel_http)
    rivera = owner_cards(fake, owner.desk_id)
    planted(fake, owner.desk_id, *(card(f"extra-{n}", mode="ask", reason="Quotes ask you first.")
                                   for n in range(OWNER_CARDS_MAX + 1 - len(rivera))))
    assert len(owner_cards(fake, owner.desk_id)) == OWNER_CARDS_MAX + 1

    lowered = await drafted(owner, rules_path(owner, "money_cap"), {"auto_money_cap_cents": 10_000})
    assert (len(lowered.cards), lowered.auto_money_cap_cents) == (OWNER_CARDS_MAX + 1, 10_000)
    assert [after.card_id for _, after in lowered.diff.changed] == ["rv-link"]
    # A draft that adds a card is still held to the bound.
    reply = await owner.browser.post(rules_path(owner, "draft"), json=adding(card("one-more", "native.capture_lead")))
    assert (reply.status_code, reply.json()) == (422, {"error": "invalid"})


async def test_the_money_cap_shown_is_the_drafted_versions(db, fake, api_settings, clock, model, browser,
                                                           kernel_http):
    # The cap a money-limit draft shows is read back from the version the kernel drafted, never the API's copy of
    # the cap it asked for: a kernel answering another cap is what the owner reads.
    drafting = fake.policy_draft

    def another_cap(request, body: PolicyDraftRequest) -> PolicyVersion:
        return drafting(request, body).model_copy(update={"auto_money_cap_cents": 12_345})

    fake.policy_draft = another_cap
    app = create_app(api_settings, kernel_transport=httpx.ASGITransport(app=fake_kernel_app(fake)), model=model,
                     clock=clock, jobs_connector=InMemoryConnector())
    async with app.router.lifespan_context(app):
        owner = await new_owner(app, browser, fake, kernel_http)
        draft = await drafted(owner, rules_path(owner, "money_cap"), {"auto_money_cap_cents": 10_000})
    (posted,) = fake.called("POST /policy/draft")
    assert PolicyDraftRequest.model_validate(posted.body).auto_money_cap_cents == 10_000
    assert draft.auto_money_cap_cents == 12_345


async def test_a_money_cap_lowering_that_fails_sends_nothing(app, browser, fake, kernel_http, monkeypatch):
    # The lowering is the API's convenience, never the guard: if it fails, the route refuses, and nothing is drafted
    # or sent to the kernel.
    owner = await new_owner(app, browser, fake, kernel_http)
    desk = fake.desks[owner.desk_id]
    active, versions = desk.policy_version, set(desk.versions)

    def failing(cards, active, cap, language):
        raise ValueError("the lowering failed")

    monkeypatch.setattr("desk.api.rules.lower_to_cap", failing)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                                 base_url="https://desk.test", cookies=owner.browser.cookies) as client:
        reply = await client.post(rules_path(owner, "money_cap"), json={"auto_money_cap_cents": 10_000})
    assert (reply.status_code, reply.json()) == (500, {"error": "internal"})
    assert fake.called("POST /policy/draft") == []
    assert (desk.policy_version, set(desk.versions), desk.auto_money_cap_cents) == (active, versions, 50_000)


async def test_preset_drafts_the_shared_preset_cards(app, browser, fake, kernel_http, model):
    owner = await new_owner(app, browser, fake, kernel_http)
    created = await owner.browser.post("/api/owner/desks", json=new_desk())
    assert created.status_code == 201, created.text
    new = Owner(browser=owner.browser, token=owner.token, copy_id=owner.copy_id, desk_id=created.json()["desk_id"],
                slug=created.json()["slug"], copy=owner.copy)

    async def preset() -> str | None:
        return RulesView.model_validate((await new.browser.get(rules_url(new))).json()).preset

    assert await preset() == "ask_first"                      # a new Desk starts on Ask me first
    draft = await drafted(new, rules_path(new, "preset"), {"preset": "auto"})
    (posted,) = fake.called("POST /policy/draft")
    assert PolicyDraftRequest.model_validate(posted.body).cards == PRESETS["auto"]    # unchanged: the proved hashes
    assert draft.cards == PRESETS["auto"] and draft.diff == CardDiff(
        added=PRESETS["auto"][len(PRESETS["ask_first"]):], removed=[], changed=[])
    assert await preset() == "ask_first"                      # until the owner confirms
    assert (await new.browser.post(rules_path(new, "confirm"), json={"version": draft.version})).status_code == 200
    assert await preset() == "auto"

    # A rule change by chat leaves the presets: there is no "custom" state, just none.
    cards = [chat_card(each) for each in PRESETS["auto"] if each.card_id != "preset-quote"]
    model.add(chatted("Quotes will wait for you.", *cards))
    changed = RuleChatOut.model_validate((await new.browser.post(rules_path(new, "chat"), json={
        "text": "Stop quoting on your own"})).json()).draft
    assert (await new.browser.post(rules_path(new, "confirm"), json={"version": changed.version})).status_code == 200
    assert await preset() is None

    # Applying a preset replaces every owner card: one for a person and a "never" one included, each listed as
    # removed, so the owner sees them go.
    rivera = owner_cards(fake, owner.desk_id)
    person = card("person-dana-quote", who="person", person_id=fake.desks[owner.desk_id].person("dana").person_id,
                  max_discount_bp=1_000, reason="Dana's quotes go ahead with up to 10% off.")
    never = card("never-anyone-native.book", "native.book", mode="never", reason="You said never for this.")
    added = await drafted(owner, rules_path(owner, "draft"), adding(person, never))
    assert (await owner.browser.post(rules_path(owner, "confirm"), json={"version": added.version})).status_code == 200
    draft = await drafted(owner, rules_path(owner, "preset"), {"preset": "ask_first"})
    assert draft.cards == PRESETS["ask_first"]
    assert person in draft.diff.removed and never in draft.diff.removed and draft.diff.removed == [
        each for each in [*rivera, person, never] if each not in PRESETS["ask_first"]]
    reply = await owner.browser.post(rules_path(owner, "preset"), json={"preset": "custom"})
    assert (reply.status_code, reply.json()) == (422, {"error": "invalid"})


WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"]
EIGHT_TO_SIX = HoursWindow(days=WEEKDAYS, start=time(8), end=time(18))
NINE_TO_FIVE = HoursWindow(days=WEEKDAYS, start=time(9), end=time(17))
SATURDAY = HoursWindow(days=["sat"], start=time(9), end=time(13))
PRESET_BOOKING_REASON = "Weekday bookings in working hours, checked by the reviewer."
# The reason of a booking card in the Desk's own hours: the example Desk's own weekday rule's wording.
OPENING_HOURS_REASON = "Weekday bookings in opening hours, checked by the reviewer."


def booking_cards(cards: list[RuleCard]) -> list[RuleCard]:
    return [each for each in cards if each.applies_to == "native.book"]


def with_bookings(*bookings: RuleCard) -> list[RuleCard]:
    """"Recommended rules" with `bookings` in place of its weekday booking card, every other card as it is."""
    (shipped,) = booking_cards(PRESETS["auto"])
    at = PRESETS["auto"].index(shipped)
    return [*PRESETS["auto"][:at], *bookings, *PRESETS["auto"][at + 1:]]


def test_recommended_rules_book_weekdays_in_the_desks_own_hours():
    # An 8 to 6 weekday Desk's "Recommended rules" book weekdays 8 to 6: one booking card, the preset's own in all
    # but its hours and its reason (which names no hours, in the example Desk's own words), in its place; every other
    # card is the preset's.
    (shipped,) = booking_cards(PRESETS["auto"])
    cards = preset_cards("auto", [EIGHT_TO_SIX])
    assert cards == with_bookings(shipped.model_copy(update={"hours": EIGHT_TO_SIX, "reason": OPENING_HOURS_REASON}))
    (booking,) = booking_cards(cards)
    assert (booking.card_id, booking.applies_to, booking.mode, booking.who, booking.hours, booking.review,
            booking.reason) == ("preset-book-weekday", "native.book", "auto", "anyone", EIGHT_TO_SIX, True,
                                OPENING_HOURS_REASON)
    # Saturday hours drop out ("weekday bookings"), so Saturday bookings ask first.
    assert preset_cards("auto", [EIGHT_TO_SIX, SATURDAY]) == cards
    # A window over the whole week keeps its weekdays; windows with the same hours merge, their days in week order.
    week = HoursWindow(days=["sun", "mon", "tue", "wed", "thu", "fri", "sat"], start=time(8), end=time(18))
    assert preset_cards("auto", [week]) == cards
    assert preset_cards("auto", [HoursWindow(days=["thu", "fri"], start=time(8), end=time(18)),
                                 HoursWindow(days=["wed", "tue", "mon"], start=time(8), end=time(18))]) == cards
    # A window that ends at midnight (00:00) keeps that end.
    all_day = HoursWindow(days=["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start=time(0), end=time(0))
    (midnight,) = booking_cards(preset_cards("auto", [all_day]))
    assert midnight.hours == HoursWindow(days=WEEKDAYS, start=time(0), end=time(0))


def test_recommended_rules_take_a_card_per_weekday_window():
    # Split weekday hours make a booking card per window, numbered by their first day, then their hours, however the
    # Desk keeps them, each the preset's card in all but its ID and hours.
    (shipped,) = booking_cards(PRESETS["auto"])
    mon_to_thu = HoursWindow(days=["mon", "tue", "wed", "thu"], start=time(8), end=time(18))
    friday = HoursWindow(days=["fri"], start=time(8), end=time(16))
    cards = preset_cards("auto", [friday, SATURDAY, mon_to_thu])
    assert cards == with_bookings(
        shipped.model_copy(update={"card_id": "preset-book-weekday-1", "hours": mon_to_thu,
                                   "reason": OPENING_HOURS_REASON}),
        shipped.model_copy(update={"card_id": "preset-book-weekday-2", "hours": friday, "reason": OPENING_HOURS_REASON}))
    assert preset_cards("auto", [mon_to_thu, friday]) == cards
    # Two windows on one day (a lunch break) are two cards, the morning's first.
    morning = HoursWindow(days=WEEKDAYS, start=time(8), end=time(12))
    afternoon = HoursWindow(days=WEEKDAYS, start=time(13), end=time(18))
    assert [(each.card_id, each.hours) for each in booking_cards(preset_cards("auto", [afternoon, morning]))] == [
        ("preset-book-weekday-1", morning), ("preset-book-weekday-2", afternoon)]


def test_recommended_rules_fall_back_to_the_shipped_cards():
    # No hours at all, or weekday hours of exactly 9 to 5: the shipped cards byte for byte, so the draft hits the
    # proofs shipped for them.
    shipped = [each.model_dump_json() for each in PRESETS["auto"]]
    for hours in ([], [NINE_TO_FIVE], [NINE_TO_FIVE, SATURDAY],
                  [HoursWindow(days=["mon", "tue"], start=time(9), end=time(17)),
                   HoursWindow(days=["wed", "thu", "fri", "sat"], start=time(9), end=time(17))]):
        assert [each.model_dump_json() for each in preset_cards("auto", hours)] == shipped, hours
    # Fewer weekdays at 9 to 5 aren't the shipped card's hours.
    (fewer,) = booking_cards(preset_cards("auto", [HoursWindow(days=["mon", "tue", "wed", "thu"], start=time(9),
                                                                end=time(17))]))
    assert (fewer.card_id, fewer.hours.days) == ("preset-book-weekday", ["mon", "tue", "wed", "thu"])
    # "Ask me first" books nothing: its cards whatever the hours.
    assert preset_cards("ask_first", [EIGHT_TO_SIX]) == PRESETS["ask_first"]


def test_recommended_rules_leave_weekday_bookings_to_ask_without_weekday_hours():
    # A Desk open only at weekends has no weekday hours to book in: the booking card is left out, so a weekday
    # booking falls to the compiler's default ask, and every other card is the preset's.
    (shipped,) = booking_cards(PRESETS["auto"])
    weekend = HoursWindow(days=["sat", "sun"], start=time(10), end=time(16))
    without = [each for each in PRESETS["auto"] if each != shipped]
    for hours in ([SATURDAY], [weekend], [SATURDAY, weekend]):
        assert preset_cards("auto", hours) == without, hours
        assert preset_of(without, hours) == "auto"
    assert preset_of(PRESETS["auto"], [SATURDAY]) is None


def test_preset_of_reads_the_desks_own_recommended_rules():
    hours = [EIGHT_TO_SIX, SATURDAY]
    cards = preset_cards("auto", hours)
    assert preset_of([*reversed(cards), default("native.payment_link")], hours) == "auto"
    assert preset_of(PRESETS["ask_first"], hours) == "ask_first"
    # The shipped 9 to 5 cards aren't an 8 to 6 Desk's "Recommended rules", nor its own those of another Desk.
    assert preset_of(PRESETS["auto"], hours) is None
    assert preset_of(cards, []) is None
    assert preset_of(PRESETS["auto"], []) == "auto"


# Hours a Desk's row could hold that don't read as its windows: none at all, JSON that isn't a list, a window with no
# days, a window with a time that isn't one, and a good window beside a bad one.
MALFORMED_HOURS = [None, {"days": ["mon"], "start": "08:00:00", "end": "18:00:00"}, "8 to 6",
                   [{"days": [], "start": "08:00:00", "end": "18:00:00"}],
                   [{"days": ["mon"], "start": "25:00:00", "end": "18:00:00"}],
                   [EIGHT_TO_SIX.model_dump(mode="json"), {"days": ["tue"], "start": "8am", "end": "18:00:00"}]]


async def test_desk_hours_that_dont_read_are_none():
    # The Desk's row is the kernel's, so its hours are its windows; any that don't read are none, never an error, so
    # the Rules page and a preset's draft still work (a draft then takes the shipped cards).
    async def owner_of(row: dict | None) -> list[HoursWindow]:
        async def one(view: str, **equals: object) -> dict | None:
            assert (view, equals) == ("desks", {"desk_id": "desk-1"})
            return row

        return await desk_hours(SimpleNamespace(ro=SimpleNamespace(one=one)), "desk-1")

    assert await owner_of({"desk_id": "desk-1", "hours": [EIGHT_TO_SIX.model_dump(mode="json")]}) == [EIGHT_TO_SIX]
    assert await owner_of(None) == []
    assert await owner_of({"desk_id": "desk-1"}) == []                      # no hours key
    for hours in MALFORMED_HOURS:
        assert await owner_of({"desk_id": "desk-1", "hours": hours}) == [], hours

    # A read that fails still fails.
    async def failing(view: str, **equals: object) -> dict | None:
        raise ConnectionError("the database is down")

    with pytest.raises(ConnectionError):
        await desk_hours(SimpleNamespace(ro=SimpleNamespace(one=failing)), "desk-1")


async def test_preset_drafts_the_shipped_cards_when_a_desks_hours_dont_read(app, browser, fake, kernel_http):
    owner = await new_owner(app, browser, fake, kernel_http)
    desk = fake.desks[owner.desk_id]
    shipped = [each.model_dump_json() for each in PRESETS["auto"]]
    for hours in MALFORMED_HOURS:
        fake._put("desks", (desk.desk_id,), {
            "desk_id": desk.desk_id, "copy_id": desk.copy_id, "business_id": desk.business_id, "name": desk.name,
            "slug": desk.slug, "hours": hours, "answering": desk.answering, "created_at": desk.created_at})
        fake.flush()
        reply = await owner.browser.get(rules_url(owner))
        assert reply.status_code == 200, (hours, reply.text)
        assert RulesView.model_validate(reply.json()).preset is None
        draft = await drafted(owner, rules_path(owner, "preset"), {"preset": "auto"})
        posted = fake.called("POST /policy/draft")[-1]
        assert [each.model_dump_json() for each in PolicyDraftRequest.model_validate(posted.body).cards] == shipped
        assert [each.model_dump_json() for each in draft.cards] == shipped, hours


async def test_preset_drafts_recommended_rules_in_the_desks_own_hours(app, browser, fake, kernel_http):
    # Turner's Desk keeps 8 to 6 on weekdays and 9 to 1 on Saturdays: its "Recommended rules" book weekdays 8 to 6,
    # and Saturday bookings ask first.
    owner = await new_owner(app, browser, fake, kernel_http)
    assert fake.desks[owner.desk_id].hours == [EIGHT_TO_SIX, SATURDAY]

    async def preset() -> str | None:
        return RulesView.model_validate((await owner.browser.get(rules_url(owner))).json()).preset

    draft = await drafted(owner, rules_path(owner, "preset"), {"preset": "auto"})
    (posted,) = fake.called("POST /policy/draft")
    sent = PolicyDraftRequest.model_validate(posted.body).cards
    assert sent == draft.cards == with_bookings(booking_cards(PRESETS["auto"])[0].model_copy(
        update={"hours": EIGHT_TO_SIX, "reason": OPENING_HOURS_REASON}))
    (booking,) = booking_cards(sent)
    assert (booking.card_id, booking.hours, booking.review, booking.reason) == (
        "preset-book-weekday", EIGHT_TO_SIX, True, OPENING_HOURS_REASON)
    # It is Turner's own weekday rule in everything but its ID.
    (rivera_weekday,) = [each for each in owner_cards(fake, owner.desk_id) if each.card_id == "rv-book-wk"]
    assert booking == rivera_weekday.model_copy(update={"card_id": "preset-book-weekday"})
    # Turner's own 8 to 6 weekday rule goes to the preset's, and his Saturday rule goes, to ask first.
    assert {each.card_id for each in draft.diff.removed} >= {"rv-book-wk", "rv-book-sat"}
    assert booking in draft.diff.added
    assert await preset() is None
    assert (await owner.browser.post(rules_path(owner, "confirm"), json={"version": draft.version})).status_code == 200
    assert await preset() == "auto"

    # Hours of 9 to 5 on weekdays draft the shipped cards as they are; the 8 to 6 cards aren't this Desk's preset now.
    await kernel_http.owner(owner.token).call("PUT /desks/{id}/hours", DeskHoursRequest(hours=[NINE_TO_FIVE]),
                                              path={"id": owner.desk_id})
    assert await preset() is None
    again = await drafted(owner, rules_path(owner, "preset"), {"preset": "auto"})
    assert PolicyDraftRequest.model_validate(fake.called("POST /policy/draft")[-1].body).cards == PRESETS["auto"]
    assert again.diff == CardDiff(added=[], removed=[], changed=[(booking, booking_cards(PRESETS["auto"])[0])])

    assert (await owner.browser.post(rules_path(owner, "confirm"), json={"version": again.version})).status_code == 200
    assert await preset() == "auto"

    # Hours at weekends alone draft no booking card: weekday bookings ask first.
    await kernel_http.owner(owner.token).call("PUT /desks/{id}/hours", DeskHoursRequest(hours=[SATURDAY]),
                                              path={"id": owner.desk_id})
    assert await preset() is None
    weekend = await drafted(owner, rules_path(owner, "preset"), {"preset": "auto"})
    assert booking_cards(PolicyDraftRequest.model_validate(fake.called("POST /policy/draft")[-1].body).cards) == []
    assert booking_cards(weekend.cards) == [] and weekend.diff.removed == booking_cards(PRESETS["auto"])


async def approved_link(kernel_http, owner: Owner, items: list[dict], n: int) -> None:
    """A visitor's payment link for their quote of `items`, held for the owner and approved once."""
    created = await kernel_http.public().call("POST /sessions", CreateSessionRequest(desk_slug=owner.slug,
                                                                                     kind="visitor"))
    view, session_id = kernel_http.session(created.session_token), created.state.session_id

    async def decide(call_id: str, tool: str, args: dict):
        return await view.call("POST /decide", DecideRequest(session_id=session_id, generation=0,
                                                             call=ToolCall(call_id=call_id, tool=tool, args=args)))

    quote = await decide(f"quote-{n}", "native.quote", {"items": items})
    quoted = await view.call("POST /execute", ExecuteRequest(decision_id=quote.decision_id, session_id=session_id,
                                                             generation=0))
    held = await decide(f"link-{n}", "native.payment_link", {"quote_id": quoted.model_view["quote_id"]})
    assert held.state == "held", held
    await kernel_http.owner(owner.token).call("POST /approvals/{decision_id}/answer",
                                              AnswerRequest(answer="allow_once"),
                                              path={"decision_id": held.decision_id})


def items(**counts: int) -> list[dict]:
    return [{"item_id": item_id, "qty": qty} for item_id, qty in counts.items()]


async def test_suggestion_after_three_approvals(app, browser, fake, kernel_http, clock):
    owner = await new_owner(app, browser, fake, kernel_http)
    fake.now = clock.now
    # The owner takes away the card that let payment links go out on their own: each one now asks them.
    rivera = owner_cards(fake, owner.desk_id)
    asking = await drafted(owner, rules_path(owner, "draft"), {
        "cards": [each.model_dump(mode="json") for each in rivera if each.card_id != "rv-link"],
        "expected_parent": fake.desks[owner.desk_id].policy_version})
    assert (await owner.browser.post(rules_path(owner, "confirm"), json={"version": asking.version})).status_code == 200

    async def suggested() -> list[Suggestion]:
        reply = await owner.browser.get(f"/api/owner/desks/{owner.desk_id}/suggestions")
        assert reply.status_code == 200, reply.text
        return [Suggestion.model_validate(each) for each in reply.json()]

    fake.now = clock.now - timedelta(days=31)               # an approval from before the 30 days counts for nothing
    await approved_link(kernel_http, owner, items(leak=2, heater=2), 0)
    fake.now = clock.now
    await approved_link(kernel_http, owner, items(drain=1), 1)
    await approved_link(kernel_http, owner, items(leak=1), 2)
    assert await suggested() == []                          # two in 30 days

    await approved_link(kernel_http, owner, items(deposit=10), 3)
    (suggestion,) = await suggested()
    assert (suggestion.tool, suggestion.count) == ("native.payment_link", 3)
    assert suggestion.text == "You approved 3 payment link requests. Let me handle these?"
    assert suggestion.card == RuleCard(card_id="suggested-native-payment-link", applies_to="native.payment_link",
                                       mode="auto", who="anyone", max_amount_cents=25_000,   # the largest approved
                                       reason="Payment link requests up to $250 go ahead without asking you.")

    # An $800 approval: the card still allows no more than the Desk's money cap, $500.
    await approved_link(kernel_http, owner, items(leak=2, heater=2), 4)
    (suggestion,) = await suggested()
    assert suggestion.count == 4 and suggestion.card.max_amount_cents == 50_000
    assert suggestion.card.reason == "Payment link requests up to $500 go ahead without asking you."

    draft = await drafted(owner, rules_path(owner, "suggestions/native.payment_link"))
    assert draft.diff == CardDiff(added=[suggestion.card], removed=[], changed=[])
    assert (await owner.browser.post(rules_path(owner, "confirm"), json={"version": draft.version})).status_code == 200
    assert await suggested() == []                          # an auto card covers payment links now
    reply = await owner.browser.post(rules_path(owner, "suggestions/native.payment_link"))
    assert (reply.status_code, reply.json()) == (404, {"error": "not_found"})


async def test_a_draft_the_kernel_refuses_reaches_the_owner_unchanged(app, browser, fake, kernel_http, model, clock):
    # The kernel refuses a whole draft (422 `invalid`, naming no card) for a reason the API doesn't check first.
    # Whichever way the owner drafts, they get the kernel's error as it is, with no retry, and nothing is drafted.
    owner = await new_owner(app, browser, fake, kernel_http)
    fake.now = clock.now
    desk = fake.desks[owner.desk_id]
    rivera = owner_cards(fake, owner.desk_id)
    refused = (422, {"error": "kernel", "code": "invalid"})

    # The owner takes away the card that let payment links go out on their own, and approves three of them: a
    # suggestion to draft later.
    without_link = [each for each in rivera if each.card_id != "rv-link"]
    asking = await drafted(owner, rules_path(owner, "draft"), {"cards": dumped(*without_link),
                                                               "expected_parent": desk.policy_version})
    assert (await owner.browser.post(rules_path(owner, "confirm"), json={"version": asking.version})).status_code == 200
    for n in range(3):
        await approved_link(kernel_http, owner, items(drain=1), n)
    active, versions, drafts = desk.policy_version, set(desk.versions), len(fake.called("POST /policy/draft"))

    extra = card("chat-1", "native.capture_lead", reason="Leads are saved on their own.")
    model.add(chatted("Leads will be saved on their own.", *(chat_card(each) for each in [*without_link, extra])))
    for path, body in ((rules_path(owner, "chat"), {"text": "Save leads on your own"}),
                       (rules_path(owner, "draft"), adding(extra)),
                       (rules_path(owner, "draft"), {"cards": dumped(*without_link, extra), "expected_parent": active}),
                       (rules_path(owner, "preset"), {"preset": "auto"}),
                       (rules_path(owner, "suggestions/native.payment_link"), None),
                       (rules_path(owner, "money_cap"), {"auto_money_cap_cents": 10_000})):
        fake.fail("POST /policy/draft", "422", times=1)
        reply = await owner.browser.post(path, json=body)
        assert (reply.status_code, reply.json()) == refused, path
    assert len(model.requests) == 1

    assert len(fake.called("POST /policy/draft")) == drafts + 6
    assert (desk.policy_version, set(desk.versions)) == (active, versions)
    view = RulesView.model_validate((await owner.browser.get(rules_url(owner))).json())
    assert view.active.version == active
    assert [each for each in view.active.cards if not each.is_default] == without_link


def planted(fake, desk_id: str, *cards: RuleCard) -> None:
    """The Desk's active rules with `cards` added, confirmed straight in the fake kernel: a version the kernel's
    draft checks never saw, as one confirmed before it refused such cards could be."""
    desk = fake.desks[desk_id]
    parent = desk.policy_version
    fake._supersede_active(desk)
    desk.cards = [*desk.cards, *cards]
    desk.policy_version = fake._next_version(desk)
    fake._put_policy(desk, parent_version=parent)
    fake.flush()


async def test_a_card_that_would_change_verification_is_named_before_the_kernel(app, browser, fake, kernel_http,
                                                                                model, monkeypatch):
    # Verification is always on (`desk.always_on`): a card on starting one other than the presets' own, an ask or
    # never card on its effect, or an auto one on its effect for one person or agent would change it. Whichever way
    # the owner drafts, the API names each such card (422 `changes_always_on`) before the kernel is asked, with no
    # retry, and nothing is drafted. The kernel refuses the same cards whatever the API sends (its contract tests).
    owner = await new_owner(app, browser, fake, kernel_http)
    desk = fake.desks[owner.desk_id]
    rivera = owner_cards(fake, owner.desk_id)
    (verification,) = [each for each in rivera if each.applies_to == "native.start_verification"]
    active, versions = desk.policy_version, set(desk.versions)

    def named(*card_ids: str) -> tuple[int, dict]:
        return 422, {"error": "changes_always_on", "card_ids": list(card_ids)}

    # Rules by chat: Claude makes verification ask the owner. The owner hears which card, with no retry.
    model.add(chatted("Codes will wait for you.", *(
        chat_card(each, mode="ask", reason="Codes ask you first.") if each == verification else chat_card(each)
        for each in rivera)))
    reply = await owner.browser.post(rules_path(owner, "chat"), json={"text": "Ask me before sending any code"})
    assert (reply.status_code, reply.json()) == named(verification.card_id)
    assert len(model.requests) == 1

    # Cards to add, or cards as they should stand: each card that would change it is named, in the cards' order.
    send_never = card("send-never", "effect:send_message", mode="never", reason="Nothing is sent to customers.")
    send_dana = card("send-dana", "effect:send_message", who="person", person_id=desk.person("dana").person_id,
                     reason="Dana's messages go out on their own.")
    narrower = verification.model_copy(update={"who": "verified"})
    for body, card_ids in ((adding(send_never), ["send-never"]), (adding(send_dana, send_never), ["send-dana",
                                                                                                "send-never"]),
                           ({"cards": dumped(*(narrower if each == verification else each for each in rivera)),
                             "expected_parent": active}, [verification.card_id])):
        reply = await owner.browser.post(rules_path(owner, "draft"), json=body)
        assert (reply.status_code, reply.json()) == named(*card_ids), body

    # A preset, made to carry one here (the shipped presets carry only the presets' own card for it).
    monkeypatch.setitem(PRESETS, "auto", [*PRESETS["auto"], send_never])
    reply = await owner.browser.post(rules_path(owner, "preset"), json={"preset": "auto"})
    assert (reply.status_code, reply.json()) == named("send-never")
    assert fake.called("POST /policy/draft") == []

    # An auto card on its effect for anyone ranks below the presets' card and changes no start: it is drafted.
    send_anyone = card("send-anyone", "effect:send_message", reason="Messages to customers go out on their own.")
    assert (await drafted(owner, rules_path(owner, "draft"), adding(send_anyone))).diff.added == [send_anyone]
    assert len(fake.called("POST /policy/draft")) == 1

    # The money limit drafts the active cards: one that would change verification, as an active version confirmed
    # before the kernel refused such cards could hold, is named too, and the cap draft waits for the owner to fix it.
    planted(fake, owner.desk_id, send_never)
    reply = await owner.browser.post(rules_path(owner, "money_cap"), json={"auto_money_cap_cents": 10_000})
    assert (reply.status_code, reply.json()) == named("send-never")
    assert len(fake.called("POST /policy/draft")) == 1
    assert len(set(desk.versions) - versions) == 1                         # the one draft for anyone


async def test_simulate_tool_change_proxies(app, browser, fake, kernel_http):
    owner = await new_owner(app, browser, fake, kernel_http)
    tools = f"/api/owner/desks/{owner.desk_id}/tools"
    reply = await owner.browser.post(f"{tools}/simulate_change", json={"tool": "payments.create_refund"})
    assert reply.status_code == 200, reply.text
    changed = ToolProfile.model_validate(reply.json())
    assert changed.status == "needs_review" and changed.pending_sha256 and changed.pending_definition_text
    (call,) = fake.called("POST /tools/simulate_change")
    assert call.headers["x-owner-session"] == owner.token
    assert call.body == {"desk_id": owner.desk_id, "tool": "payments.create_refund"}
    rows = {row.tool: row for row in RulesView.model_validate((await owner.browser.get(rules_url(owner))).json()).tools}
    assert (rows["payments.create_refund"].status, rows["payments.create_refund"].pending_sha256) == (
        "needs_review", changed.pending_sha256)

    # The kernel's refusal passes through; a tool that isn't one, or another copy's Desk, never reaches it.
    native = await owner.browser.post(f"{tools}/simulate_change", json={"tool": "native.quote"})
    assert (native.status_code, native.json()) == (422, {"error": "kernel", "code": "invalid"})
    unknown = await owner.browser.post(f"{tools}/simulate_change", json={"tool": "admin.export_customers"})
    assert (unknown.status_code, unknown.json()) == (422, {"error": "invalid"})
    business = await owner.browser.post(f"{tools}/simulate_change", json={"tool": "desk.intake"})
    assert (business.status_code, business.json()) == (422, {"error": "invalid"})
    other = await new_owner(app, browser, fake, kernel_http)
    elsewhere = await other.browser.post(f"{tools}/simulate_change", json={"tool": "payments.create_refund"})
    assert (elsewhere.status_code, elsewhere.json()) == (404, {"error": "not_found"})
    assert len(fake.called("POST /tools/simulate_change")) == 2

    # A new Desk connects the mock payments server: its tools come back pinned and waiting for the owner's review,
    # with no card covering them yet.
    created = (await owner.browser.post("/api/owner/desks", json=new_desk())).json()
    reply = await owner.browser.post(f"/api/owner/desks/{created['desk_id']}/tools/connect")
    assert reply.status_code == 200, reply.text
    connected = [ToolRow.model_validate(row) for row in reply.json()]
    assert [(row.tool, row.status, row.cards) for row in connected] == [
        ("payments.create_refund", "needs_review", []), ("payments.list_charges", "needs_review", [])]
    assert fake.called("POST /tools/connect")[-1].body == {"desk_id": created["desk_id"], "server": "mock_payments"}


async def test_knowledge_marked_public(app, browser, fake, kernel_http):
    owner = await new_owner(app, browser, fake, kernel_http)
    path = f"/api/owner/desks/{owner.desk_id}/knowledge"
    item = KnowledgeItem(item_id="upload-parking", source="upload", title="Parking",
                         text="Street parking is free after 6 pm.", label=Label(readers=["owner"]))
    reply = await owner.browser.post(path, json={"item": item.model_dump(mode="json")})
    assert (reply.status_code, KnowledgeItem.model_validate(reply.json())) == (200, item)
    public = item.model_copy(update={"label": Label(readers=["public"])})
    reply = await owner.browser.post(path, json={"item": public.model_dump(mode="json")})
    assert (reply.status_code, KnowledgeItem.model_validate(reply.json())) == (200, public)
    (call, again) = fake.called("POST /knowledge")
    assert again.headers["x-owner-session"] == owner.token and again.body == {
        "desk_id": owner.desk_id, "item": public.model_dump(mode="json")}
    assert fake.desks[owner.desk_id].knowledge["upload-parking"].label.readers == ["public"]

    # The kernel decides who may read knowledge: its refusal passes through. A body that isn't an item, or another
    # copy's Desk, never reaches it.
    person = item.model_copy(update={"label": Label(readers=["person:someone"])})
    refused = await owner.browser.post(path, json={"item": person.model_dump(mode="json")})
    assert (refused.status_code, refused.json()) == (422, {"error": "kernel", "code": "invalid"})
    loose = await owner.browser.post(path, json={"item": item.model_dump(mode="json"), "public": True})
    assert (loose.status_code, loose.json()) == (422, {"error": "invalid"})
    other = await new_owner(app, browser, fake, kernel_http)
    elsewhere = await other.browser.post(path, json={"item": public.model_dump(mode="json")})
    assert (elsewhere.status_code, elsewhere.json()) == (404, {"error": "not_found"})
    assert len(fake.called("POST /knowledge")) == 3


async def test_document_upload_goes_to_the_kernel(app, browser, fake, kernel_http):
    owner = await new_owner(app, browser, fake, kernel_http)
    path = f"/api/owner/desks/{owner.desk_id}/documents"
    estimate = SeedDocument(ref="dana-estimate", title="Estimate, leak repair", body="For Dana Whitfield.\n",
                            record_owner_ref="dana")
    reply = await owner.browser.post(path, json={"document": estimate.model_dump(mode="json")})
    assert reply.status_code == 201, reply.text
    created = DocumentCreated.model_validate(reply.json())
    (call,) = fake.called("POST /documents")
    assert call.headers["x-owner-session"] == owner.token and call.body == {
        "desk_id": owner.desk_id, "document": estimate.model_dump(mode="json")}
    document = fake.desks[owner.desk_id].documents[created.document_id]
    assert document.title == "Estimate, leak repair" and "For Dana Whitfield." not in reply.text
    nobody = estimate.model_copy(update={"ref": "nobodys", "record_owner_ref": "nobody"})
    refused = await owner.browser.post(path, json={"document": nobody.model_dump(mode="json")})
    assert (refused.status_code, refused.json()) == (422, {"error": "kernel", "code": "invalid"})


async def test_tool_decisions_are_paged_and_owner_only(app, browser, fake, kernel_http):
    owner = await new_owner(app, browser, fake, kernel_http)
    created = await kernel_http.public().call("POST /sessions", CreateSessionRequest(desk_slug=owner.slug,
                                                                                     kind="visitor"))
    session_id = created.state.session_id
    fake.verify(session_id, "dana")
    view = kernel_http.session(created.session_token)
    made = []
    for n in range(25):
        fake.now += timedelta(seconds=1)
        made.append(await view.call("POST /decide", DecideRequest(session_id=session_id, generation=0, call=ToolCall(
            call_id=f"slots-{n}", tool="native.find_slots", args={}))))
    await held_quote(kernel_http, fake, owner)                 # another tool's decision, never listed here
    path = f"/api/owner/desks/{owner.desk_id}/tools/native.find_slots/decisions"

    first = await owner.browser.get(path)
    assert first.status_code == 200, first.text
    page = ToolDecisions.model_validate(first.json())
    newest = list(reversed(made))
    assert [row.decision_id for row in page.items] == [each.decision_id for each in newest[:20]]
    assert page.next_before is not None
    row, decision = page.items[0], newest[0]
    assert (row.session_id, row.display_name, row.outcome, row.state, row.reason_plain, row.ledger_seq) == (
        session_id, "Dana Whitfield", decision.outcome, decision.state, decision.reason_plain, decision.ledger_seq)
    rest = ToolDecisions.model_validate((await owner.browser.get(path, params={"before": page.next_before})).json())
    assert [row.decision_id for row in rest.items] == [each.decision_id for each in newest[20:]]
    assert rest.next_before is None
    small = ToolDecisions.model_validate((await owner.browser.get(path, params={"limit": 5})).json())
    assert [row.decision_id for row in small.items] == [each.decision_id for each in newest[:5]]

    for params in ({"limit": 0}, {"limit": 51}, {"before": "not-a-cursor"}):
        reply = await owner.browser.get(path, params=params)
        assert (reply.status_code, reply.json()) == (422, {"error": "invalid"}), params
    # Owner only, on the copy's own Desks and tools.
    unknown = await owner.browser.get(f"/api/owner/desks/{owner.desk_id}/tools/admin.export_customers/decisions")
    assert (unknown.status_code, unknown.json()) == (404, {"error": "not_found"})
    other = await new_owner(app, browser, fake, kernel_http)
    assert (await other.browser.get(path)).status_code == 404
    visitor = browser(app)
    assert (await visitor.post(f"/api/public/desks/{owner.slug}/sessions")).status_code in (200, 201)
    reply = await visitor.get(path)
    assert (reply.status_code, reply.json()) == (401, {"error": "no_owner_session"})


async def test_every_draft_carries_its_cards(app, browser, fake, kernel_http, model, clock):
    owner = await new_owner(app, browser, fake, kernel_http)
    fake.now = clock.now
    rivera = owner_cards(fake, owner.desk_id)
    extra = card("chat-1", "native.capture_lead", reason="Leads are saved on their own.")
    model.add(chatted("Done.", *(chat_card(each) for each in [*rivera, extra])))
    chat = RuleChatOut.model_validate((await owner.browser.post(rules_path(owner, "chat"), json={
        "text": "Save leads on your own"})).json()).draft
    drafts = {
        "chat": chat,
        "cards": await drafted(owner, rules_path(owner, "draft"), {
            "cards": [each.model_dump(mode="json") for each in rivera if each.card_id != "rv-link"],
            "expected_parent": fake.desks[owner.desk_id].policy_version}),
        "add": await drafted(owner, rules_path(owner, "draft"), adding(extra.model_copy(update={"card_id": "add-1"}))),
        "preset": await drafted(owner, rules_path(owner, "preset"), {"preset": "auto"}),
    }
    for name, draft in drafts.items():
        version = fake.desks[owner.desk_id].versions[draft.version]
        assert draft.cards == [each for each in version.cards if not each.is_default] and draft.cards, name
        assert draft.auto_money_cap_cents == 50_000 and draft.diff is not None, name
        assert draft.summary.on_its_own and draft.summary.asks_you, name
        # A draft is read again by its version, the same as when it was made.
        reread = await owner.browser.get(f"/api/owner/desks/{owner.desk_id}/rules/drafts/{draft.version}")
        assert (reread.status_code, RulesDraft.model_validate(reread.json())) == (200, draft), name

    # Only the Desk's drafts are read: not its active version, a version it doesn't have, or another copy's draft.
    active = fake.desks[owner.desk_id].policy_version
    for version in (active, 10_000):
        reply = await owner.browser.get(f"/api/owner/desks/{owner.desk_id}/rules/drafts/{version}")
        assert (reply.status_code, reply.json()) == (404, {"error": "not_found"}), version
    other = await new_owner(app, browser, fake, kernel_http)
    reply = await other.browser.get(f"/api/owner/desks/{owner.desk_id}/rules/drafts/{chat.version}")
    assert reply.status_code == 404


async def test_slow_drafts_answer_202_with_their_body(app, browser, fake, kernel_http, model, monkeypatch):
    monkeypatch.setattr(proving, "PROVING_WAIT_S", 0.3)
    owner = await new_owner(app, browser, fake, kernel_http)
    path, text = rules_path(owner, "chat"), "Save leads on your own"
    extra = card("chat-1", "native.capture_lead", reason="Leads are saved on their own.")
    model.add(chatted("Done.", *(chat_card(each) for each in [*owner_cards(fake, owner.desk_id), extra])))
    release = fake.gate("POST /policy/draft")

    # Past the wait, the answer names the same path and body to send again; sent again, it joins the same work.
    reply = await owner.browser.post(path, json={"text": text})
    assert (reply.status_code, reply.json()) == (202, {"retry": {"path": path, "body": {"text": text}}})
    retry = reply.json()["retry"]
    assert (await owner.browser.post(retry["path"], json=retry["body"])).status_code == 202
    release.set()
    reply = await owner.browser.post(retry["path"], json=retry["body"])
    assert reply.status_code == 200, reply.text
    assert RuleChatOut.model_validate(reply.json()).draft.diff.added == [extra]
    assert len(model.requests) == 1 and len(fake.called("POST /policy/draft")) == 1

    # A kernel that gives no answer in time, or that could only check the rules on cases: "Rules can't be checked
    # right now", and nothing to confirm.
    monkeypatch.setattr(proving, "PROVING_WAIT_S", 25)
    fake.fail("POST /policy/draft", "timeout", times=1)
    reply = await owner.browser.post(rules_path(owner, "preset"), json={"preset": "auto"})
    assert (reply.status_code, reply.json()) == (409, {"error": "rules_cannot_be_checked"})
    fake.proof(method="bounded", times=1)
    reply = await owner.browser.post(rules_path(owner, "preset"), json={"preset": "ask_first"})
    assert (reply.status_code, reply.json()) == (409, {"error": "rules_cannot_be_checked"})
