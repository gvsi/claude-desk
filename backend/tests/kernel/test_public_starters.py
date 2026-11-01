"""A Desk's starter questions on its public page, which only the demo seed writes.

The public chat's first view shows up to three starter chips, and a chip sends its words as the
visitor's own message. The kernel serves them on the public read (`PublicDesk.starters`) from the
Desk's seed-only charter facts `charter:starter:<n>:<lang>` (n from 1 to 3, lang `en` or `es`),
in the language asked for, each trimmed and at most 80 characters, and `[]` for a Desk without
them or when reading them fails. Only the Rivera seed writes them: an owner's or setup's charter
write, or a new Desk, naming a `starter:` key is refused (422 `invalid`, `starter_seed_only`), and
an owner's charter write keeps the seed's starters, as it keeps the hours. They are words for a
visitor to send, not facts about the business, so neither Claude's context nor the reviewer is
given them. Tests run on Rivera Plumbing copies as `POST /copies` seeds them (Friday 10:04 in
Oakland).
"""

import logging

import pytest
from sqlalchemy import select

from desk.contracts import Claim
from desk.db.models import Fact as FactRow
from desk.kernel_api import DeskCreated
from desk.kernel_service import desks, labels, public

from .helpers import kernel_ctx
from .test_adapters import Rivera, book, rivera, visitor_of
from .test_context import context_of, owner_session_id
from .test_decide import PASS
from .test_desk_writes import desks_of, facts_of, new_desk, post_desk, put_part, updated
from .test_labels_hardening import documents
from .test_public_header import public_page

# The owner's signed starters for Rivera Plumbing, in the order the chips show them.
RIVERA_STARTERS = {
    "en": ["How much is drain clearing?", "Can someone come Tuesday?", "Do you work in Alameda?"],
    "es": ["¿Cuánto cuesta destapar un desagüe?", "¿Puede venir alguien el martes?", "¿Trabajan en Alameda?"],
}
STARTER_FACTS = {f"charter:starter:{n}:{lang}" for n in (1, 2, 3) for lang in ("en", "es")}
CONTACT = {"key": "contact", "kind": "text", "value": "(510) 555-0199"}


async def store_starters(app, copy: Rivera, starters: dict[str, str | None], *, readers: list[str] | None = None,
                         status: str = "available") -> None:
    """Test only: the Desk's starter facts by key (`starter:<n>:<lang>`) stored as they are, or
    removed for None, as a kernel without the seed's own strings could have stored them."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        for key, text in starters.items():
            row = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
                FactRow.desk_id == copy.desk_id, FactRow.fact_id == f"charter:{key}")))).one_or_none()
            if row is not None:
                await ctx.db.delete(row)
                await ctx.db.flush()
            if text is None:
                continue
            fact = desks.charter_fact(Claim(key=key, kind="text", value=text))
            if readers is not None:
                fact = fact.model_copy(update={"label": fact.label.model_copy(update={"readers": readers})})
            row = labels.fact_row(copy.copy_id, copy.desk_id, fact.model_copy(update={"status": status}),
                                  ctx.clock.now())
            ctx.db.add(row)


async def test_the_public_page_serves_riveras_starters_in_its_language(app, client):
    copy = await rivera(app, client)
    for lang in ("en", "es"):
        page = await public_page(client, copy, lang)
        assert page.starters == RIVERA_STARTERS[lang], lang
        # a starter is no charter card: the page's charter is the hours, the contact and the policies
        assert [block.template for block in page.charter] == ["hours", "contact", "policy", "policy", "policy"]
        assert not [block for block in page.charter if "starter" in (block.fact_id or "")]
    for params in ({}, {"lang": "fr"}):                           # English unless Spanish is asked for
        response = await client.get(f"/public/{copy.slug}", params=params)
        assert response.status_code == 200, response.text
        assert response.json()["starters"] == RIVERA_STARTERS["en"], params


async def test_the_seed_stores_each_starter_as_a_public_charter_fact_per_language(app, client):
    copy = await rivera(app, client)
    starters = {fact_id: fact for fact_id, fact in (await facts_of(app, copy, "charter")).items()
                if fact_id.startswith("charter:starter:")}
    assert set(starters) == STARTER_FACTS
    for lang, texts in RIVERA_STARTERS.items():
        for n, text in enumerate(texts, start=1):
            fact = starters[f"charter:starter:{n}:{lang}"]
            assert fact.claims == [Claim(key=f"starter:{n}:{lang}", kind="text", value=text)]
            assert (fact.readers, fact.source, fact.status) == (["public"], "kernel", "available")


async def test_a_desk_without_starters_serves_none(app, client):
    copy = await rivera(app, client)
    response = await post_desk(client, copy, new_desk())
    assert response.status_code == 200, response.text
    created = DeskCreated.model_validate(response.json())
    for lang in ("en", "es"):
        response = await client.get(f"/public/{created.slug}", params={"lang": lang})
        assert response.status_code == 200, response.text
        assert response.json()["starters"] == [], lang


async def test_starters_are_trimmed_kept_to_eighty_characters_and_served_in_order(app, client):
    copy = await rivera(app, client)
    dana = (await documents(app, copy))["dana-invoice"]
    eighty = "Q" * 79 + "?"
    await store_starters(app, copy, {
        "starter:1:en": "  Is there parking?\n",
        "starter:2:en": "W" * 80 + "?",                         # 81 characters: left out, never cut short
        "starter:3:en": f"  {eighty} ",                         # 80 once trimmed
        "starter:4:en": "Do you fix boilers?",                  # only the first three are starters
        "starter:1:es": "   ",                                  # nothing to show
        "starter:3:es": f"¿Tienen la referencia {dana.canary}?",  # a document's canary
    })
    assert (await public_page(client, copy, "en")).starters == ["Is there parking?", eighty]
    assert (await public_page(client, copy, "es")).starters == ["¿Puede venir alguien el martes?"]
    # a starter the public can't read, or one no longer available, isn't shown
    await store_starters(app, copy, {"starter:1:en": "Is there parking?"}, readers=["owner"])
    await store_starters(app, copy, {"starter:3:en": eighty}, status="expired")
    await store_starters(app, copy, {"starter:2:en": None})
    assert (await public_page(client, copy, "en")).starters == []


async def test_a_failing_starters_read_is_empty_and_logged(app, client, monkeypatch, caplog):
    copy = await rivera(app, client)
    whole = await public_page(client, copy)

    def broken(*args, **kwargs):
        raise RuntimeError("How much is drain clearing at Rivera Plumbing?")

    monkeypatch.setattr(public, "starters", broken)
    with caplog.at_level(logging.INFO):
        page = await public_page(client, copy)
    assert page == whole.model_copy(update={"starters": []})            # the rest of the page stands
    assert [record.getMessage() for record in caplog.records if "starters" in record.getMessage()] == [
        "starters_failed error=RuntimeError"]
    kernel_log = "\n".join(record.getMessage() for record in caplog.records if record.name.startswith("desk"))
    for desk_data in ("drain", "Rivera", copy.slug, copy.desk_id, copy.copy_id):
        assert desk_data not in kernel_log


@pytest.mark.parametrize("key", ["starter:1", "starter:1:en", "starter:4"])
async def test_an_owner_charter_write_naming_a_starter_is_refused(app, client, key):
    copy = await rivera(app, client)
    before = {fact_id: fact.claims for fact_id, fact in (await facts_of(app, copy, "charter")).items()}
    starter = {"key": key, "kind": "text", "value": "Is the first visit free today?"}
    response = await put_part(client, copy, "charter", {"charter": [CONTACT, starter]})
    assert (response.status_code, response.json()) == (422, {"code": "invalid", "detail": {key: ["starter_seed_only"]}})
    assert {fact_id: fact.claims for fact_id, fact in (await facts_of(app, copy, "charter")).items()} == before
    assert (await public_page(client, copy)).starters == RIVERA_STARTERS["en"]
    # a new Desk is held to the same, and none is created
    body = new_desk()
    body["desk"]["charter"].append(starter)
    response = await post_desk(client, copy, body)
    assert (response.status_code, response.json()) == (422, {"code": "invalid", "detail": {key: ["starter_seed_only"]}})
    assert set(await desks_of(app, copy)) == {copy.desk_id}
    # the charter's own checks come first, as before
    hours = {"key": "hours", "kind": "text", "value": "Open 8 to 6"}
    response = await put_part(client, copy, "charter", {"charter": [CONTACT, hours, starter]})
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})


async def test_an_owner_charter_write_keeps_the_seeds_starters(app, client):
    copy = await rivera(app, client)
    await updated(client, copy, "charter", {"charter": [CONTACT]})
    assert set(await facts_of(app, copy, "charter")) == {"charter:contact", "charter:hours", *STARTER_FACTS}
    assert (await public_page(client, copy, "es")).starters == RIVERA_STARTERS["es"]


async def test_starters_stay_out_of_claudes_context_and_the_reviewer(app, client, reviewer):
    reviewer.answer = PASS
    copy, visitor = await visitor_of(app, client)
    await store_starters(app, copy, {f"starter:{n}:{lang}": text
                                   for lang, texts in RIVERA_STARTERS.items()
                                   for n, text in enumerate(texts, start=1)})
    owner = await context_of(client, await owner_session_id(client, copy.owner), copy.owner, desk_id=copy.desk_id)
    for seen in (await context_of(client, visitor.session_id, visitor.headers), owner):
        facts = [fact.fact_id for fact in seen.facts]
        assert "charter:policy:service_area" in facts and not [fact for fact in facts if "starter" in fact]
    decision = await book(client, visitor, "S-20261102-1000")                  # Monday at 10:00, reviewed
    assert decision.outcome == "allow"
    [review] = reviewer.inputs
    assert [fact.key for fact in review.facts] == [
        "contact", "windows", "policy:arrival", "policy:first_visit", "policy:service_area"]
