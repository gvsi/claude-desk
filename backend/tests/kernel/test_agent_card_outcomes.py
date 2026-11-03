"""What happens when an agent asks for each ability on a Desk's public Agent Card.

`GET /public/{slug}` lists one block for each thing an agent can ask for on the Desk now
(`render.agent_card`), and beside each one its outcome for an agent with no standing of its own:
`allowed`, `asks_first` or `never`, read from the active version's cards for anyone
(`compiler.outcome_for`), with the kernel's words for it in the language asked for. An ability whose
label names a verified customer is read for that customer, so cards for verified people and record
owners count there too. Nothing else of any card reaches the page: no card ID, reason, amount, hours
or discount, and nothing at all of a card for a person or an agent key. Tests run on Turner Plumbing copies as `POST /copies` seeds
them (Friday 10:04 in Oakland).
"""

import hashlib
import json
import logging
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import OWNER_NAME_FALLBACK, RuleCard
from desk.db.models import Person
from desk.kernel_api import PublicDesk
from desk.kernel_service import activation, compiler, decide, public, render
from desk.kernel_service.seed import RIVERA_CARDS, RIVERA_MONEY_CAP_CENTS

from .helpers import activate_cards, kernel_ctx, rows_of
from .test_adapters import Rivera, quote_args, rivera
from .test_decide import decided, open_visitor
from .test_desk_writes import put_part

# Turner Plumbing's agent abilities as seeded, each with its outcome: its own auto cards for anyone allow
# most of them (the signed-limit charge within its card's limit too), and its auto cards for record owners
# allow a verified customer's documents and charges, the abilities whose labels name that customer.
SEEDED = [
    ("Get a quote from the price list", "allowed"),
    ("Find open times", "allowed"),
    ("Book a visit", "allowed"),
    ("Get a payment link for a quote", "allowed"),
    ("Pay for a quote within a signed limit", "allowed"),
    ("Leave contact details", "allowed"),
    ("Ask for a callback", "allowed"),
    ("Verify a customer with a code sent to their contact on record", "allowed"),
    ("Receive a verified customer's own documents", "allowed"),
    ("List a verified customer's own charges", "allowed"),
]
DOCUMENTS, CHARGES = "Receive a verified customer's own documents", "List a verified customer's own charges"
WORDS = {"en": {"allowed": "Allowed", "asks_first": "Asks first", "never": "Never"},
         "es": {"allowed": "Permitido", "asks_first": "Pregunta primero", "never": "Nunca"}}


async def public_page(client: httpx.AsyncClient, copy: Rivera, lang: str = "en") -> PublicDesk:
    response = await client.get(f"/public/{copy.slug}", params={"lang": lang})
    assert response.status_code == 200, response.text
    return PublicDesk.model_validate(response.json())


@pytest.mark.parametrize("lang", ["en", "es"])
async def test_each_ability_carries_its_outcome_for_anyone_in_the_kernels_words(app: FastAPI, client, lang):
    copy = await rivera(app, client)
    english = await public_page(client, copy)
    card = (await public_page(client, copy, lang)).agent_card
    assert [(block.outcome, block.outcome_text) for block in card] == [
        (outcome, WORDS[lang][outcome]) for _, outcome in SEEDED]
    assert [block.text for block in english.agent_card] == [text for text, _ in SEEDED]


async def activate(app: FastAPI, copy: Rivera, cards: list[RuleCard]) -> None:
    """Makes `cards` the Desk's active version (`activate_cards`: compiled, unproved, test only)."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        await activate_cards(ctx, copy.desk_id, cards, auto_money_cap_cents=RIVERA_MONEY_CAP_CENTS)


def outcomes(page: PublicDesk) -> dict[str, str | None]:
    return {block.text: block.outcome for block in page.agent_card}


async def test_a_never_card_for_anyone_reads_never_on_its_tool_or_its_effect(app: FastAPI, client):
    copy = await rivera(app, client)
    await activate(app, copy, [*RIVERA_CARDS,
                               RuleCard(card_id="no-book", applies_to="native.book", mode="never", who="anyone",
                                        reason="No bookings for now."),
                               RuleCard(card_id="no-reads", applies_to="effect:read", mode="never", who="anyone",
                                        reason="Nothing read for now.")])
    page = await public_page(client, copy)
    assert outcomes(page) == {text: "never" if text in ("Book a visit", "Find open times") else outcome
                              for text, outcome in SEEDED}
    spanish = await public_page(client, copy, "es")
    assert {(b.outcome, b.outcome_text) for b in spanish.agent_card if b.outcome == "never"} == {("never", "Nunca")}


async def test_an_ability_no_card_for_anyone_allows_reads_asks_first(app: FastAPI, client):
    copy = await rivera(app, client)
    # no card for quotes any more (they fall to their default ask), and an ask card for callbacks beside the auto one
    await activate(app, copy, [*(card for card in RIVERA_CARDS if card.applies_to != "native.quote"),
                               RuleCard(card_id="ask-callback", applies_to="native.request_callback", mode="ask",
                                        who="anyone", reason="Callbacks ask you first.")])
    page = await public_page(client, copy)
    asked = {"Get a quote from the price list", "Ask for a callback"}
    assert outcomes(page) == {text: "asks_first" if text in asked else outcome for text, outcome in SEEDED}
    assert {block.outcome_text for block in page.agent_card if block.text in asked} == {"Asks first"}


async def test_an_ability_whose_label_names_a_verified_customer_reads_their_standings_cards(app: FastAPI, client):
    copy = await rivera(app, client)
    # as seeded, `rv-docs` and `rv-charges` (auto, for record owners) allow both, as they would that customer
    assert {text: outcome for text, outcome in outcomes(await public_page(client, copy)).items()
            if text in (DOCUMENTS, CHARGES)} == {DOCUMENTS: "allowed", CHARGES: "allowed"}
    # without its record owners' card documents ask first; a never card for verified people refuses charges; and a
    # card for verified people on another ability changes nothing there, where only cards for anyone count
    await activate(app, copy, [*(card for card in RIVERA_CARDS if card.card_id not in ("rv-docs", "rv-quote")),
                               RuleCard(card_id="no-charges", applies_to="payments.list_charges", mode="never",
                                        who="verified", reason="No charges shown for now."),
                               RuleCard(card_id="verified-quote", applies_to="native.quote", mode="auto",
                                        who="verified", reason="Quotes for verified customers.")])
    page = await public_page(client, copy)
    assert outcomes(page) == {**dict(SEEDED), DOCUMENTS: "asks_first", CHARGES: "never",
                              "Get a quote from the price list": "asks_first"}


def test_only_the_abilities_whose_labels_name_a_verified_customer_read_their_standings_cards():
    for lang, labels in (("en", "verified customer"), ("es", "cliente verificado")):
        module = render.en if lang == "en" else render.es
        assert {tool for tool, label in module.AGENT_TOOLS.items() if labels in label} == set(public.STANDING), lang
    assert set(public.STANDING.values()) == {compiler.VERIFIED_OWNER}


def test_the_money_abilities_are_read_for_an_agent_holding_a_signed_limit():
    """A payment link and a charge within a signed limit are given only to an agent holding a mandate
    (`decide.tools_given`), and the baseline refuses a charge from an agent with none, so their outcome is read
    for an agent holding a signed limit (`public.SIGNED_LIMIT`). Mandates name no one, so those two read the
    cards for anyone, not a verified customer's."""
    enabled = set(decide.declared_tools("agent"))
    session, desk = SimpleNamespace(preview=False), SimpleNamespace(answering=True)

    def given(mandate_id: str | None) -> set[str]:
        agent = SimpleNamespace(kind="agent", assurance="none", person_id=None, mandate_id=mandate_id)
        return decide.tools_given(agent, session, desk, enabled)

    assert given("mandate-1") - given(None) == public.SIGNED_LIMIT == {"native.payment_link", "native.charge_mandate"}
    assert public.SIGNED_LIMIT.isdisjoint(public.STANDING)


# A visiting agent's key ID, as the kernel makes one: the first 16 hex of its public key's sha256 (a stand-in key).
ALEX_KEY = hashlib.sha256(b"alex kim's agent, a stand-in public key").hexdigest()[:16]


def scoped_cards(dana: Person) -> list[RuleCard]:
    """Cards for one person (Dana) and one agent key, every mode among them, each of which would change the outcome
    for anyone if it were read, with names and amounts in their reasons and limits."""
    person, agent = {"who": "person", "person_id": dana.person_id}, {"who": "agent", "agent_key_id": ALEX_KEY}
    return [
        RuleCard(card_id="dana-docs", applies_to="native.release_document", mode="auto", **person,
                 reason=f"{dana.display_name} gets her own documents."),
        RuleCard(card_id="dana-quote-off", applies_to="native.quote", mode="auto", max_discount_bp=1_500, **person,
                 reason=f"{dana.display_name} gets 15% off."),
        RuleCard(card_id="dana-no-callback", applies_to="native.request_callback", mode="never", **person,
                 reason=f"Never call {dana.display_name} back."),
        RuleCard(card_id="alex-charges", applies_to="payments.list_charges", mode="auto", **agent,
                 reason="Alex Kim's agent sees the charges."),
        RuleCard(card_id="alex-link", applies_to="native.payment_link", mode="auto", max_amount_cents=12_377, **agent,
                 reason="Alex Kim's agent pays links up to $123.77."),
        RuleCard(card_id="alex-ask-slots", applies_to="native.find_slots", mode="ask", **agent,
                 reason="Alex Kim's agent asks before reading open times."),
        RuleCard(card_id="alex-no-book", applies_to="native.book", mode="never", **agent,
                 reason="Alex Kim's agent never books."),
    ]


async def test_cards_for_a_person_or_an_agent_key_change_nothing_and_reach_nothing(app: FastAPI, client):
    copy = await rivera(app, client)
    [dana] = await rows_of(app, copy.copy_id, select(Person).where(Person.ref == "dana"))
    scoped = scoped_cards(dana)
    # without the record owners' cards, so documents and charges ask first, and the auto cards Dana's and Alex Kim's
    # agent have on them would flip them if they were read
    base = [card for card in RIVERA_CARDS if card.card_id not in ("rv-docs", "rv-charges")]
    await activate(app, copy, base)
    before = {lang: (await client.get(f"/public/{copy.slug}", params={"lang": lang})).json() for lang in ("en", "es")}
    await activate(app, copy, [*base, *scoped])
    for lang in ("en", "es"):
        response = await client.get(f"/public/{copy.slug}", params={"lang": lang})
        assert response.status_code == 200, response.text
        # the same page, to the byte: no outcome moved, and nothing of the scoped cards came along
        assert response.json() == before[lang]
        page = PublicDesk.model_validate(response.json())
        assert [block.outcome for block in page.agent_card] == [
            "asks_first" if text in (DOCUMENTS, CHARGES) else outcome for text, outcome in SEEDED]
        served = response.text
        for card in scoped:
            for value in (card.card_id, card.reason, card.person_id, card.agent_key_id):
                assert value is None or value not in served, (lang, value)
        for value in (dana.display_name, "Dana", "Alex", "12377", "123.77", "1500", "15%"):
            assert value not in served, (lang, value)
        # and of every card on the Desk, only an outcome key: each block is the kernel's label, a key and its words,
        # with no ID, reason, tool name, amount, hours or discount of any card
        for block in page.agent_card:
            assert (block.kind, block.template, block.fact_id, block.title, block.lines, block.href, block.options) == (
                "prose", None, None, None, [], None, [])
            assert (block.outcome, block.outcome_text) in {(key, words) for key, words in WORDS[lang].items()}
        abilities = json.dumps([block.model_dump(mode="json") for block in page.agent_card],
                               ensure_ascii=False)
        assert not any(character.isdigit() for character in abilities)
        for card in [*base, *scoped]:
            assert card.card_id not in abilities and card.reason not in abilities and card.applies_to not in abilities


async def test_an_unreadable_version_claims_no_outcome(app: FastAPI, client, monkeypatch, caplog):
    copy = await rivera(app, client)

    async def unreadable(ctx, desk_id):
        raise RuntimeError(f"no version for {desk_id}")

    monkeypatch.setattr(activation, "active_version", unreadable)
    caplog.set_level(logging.WARNING, logger="desk.kernel_service.public")
    page = await public_page(client, copy)
    # the abilities still show, with no outcome claimed: never one guessed, and never "allowed"
    assert [(block.text, block.outcome, block.outcome_text) for block in page.agent_card] == [
        (text, None, None) for text, _ in SEEDED]
    assert [record.getMessage() for record in caplog.records if record.name == "desk.kernel_service.public"] == [
        "agent_outcomes_failed error=RuntimeError"]
    monkeypatch.undo()

    # a Desk with no active version (every request is refused then) claims none either
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        (await activation.active_version(ctx, copy.desk_id)).status = "superseded"
    assert {(block.outcome, block.outcome_text) for block in (await public_page(client, copy)).agent_card} == {
        (None, None)}


@pytest.mark.parametrize("state", ["outdated", "unloadable"])
async def test_an_active_version_decide_cant_use_claims_no_outcome(app: FastAPI, client, state):
    """A version still marked active that `/decide` won't decide on, because it was proved under another
    baseline or other invariants and not rebuilt (`activation.outdated`) or its Cedar can't load
    (`versions.use`), refuses every request, so the page claims no outcome on it, as it does with none."""
    copy = await rivera(app, client)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        version = await activation.active_version(ctx, copy.desk_id)
        if state == "outdated":
            version.baseline_sha256 = "0" * 64        # proved under a baseline this kernel doesn't enforce
        else:
            version.cedar_sha256 = "0" * 64           # Cedar that no longer matches the hash it was proved under
    for lang in ("en", "es"):
        page = await public_page(client, copy, lang)
        assert {(block.outcome, block.outcome_text) for block in page.agent_card} == {(None, None)}, lang
        assert len(page.agent_card) == len(SEEDED)
    # the page agrees with `/decide`, which refuses a quote the seed's own card would allow
    visitor = await open_visitor(client, copy)
    refused = await decided(client, visitor, "native.quote", quote_args(("drain", 1)))
    assert (refused.outcome, refused.state) == ("refuse", "refused")


def test_the_outcome_words_are_the_kernels_and_name_no_one():
    tools = {"native.quote": "allowed", "native.book": "asks_first", "native.find_slots": "never"}
    for lang in ("en", "es"):
        blocks = render.agent_card(lang, set(tools), tools)
        assert [(block.outcome, block.outcome_text) for block in blocks] == [
            (outcome, WORDS[lang][outcome]) for outcome in ("allowed", "never", "asks_first")]   # in the card's order


@pytest.mark.parametrize("owner", ["Mike Turner", OWNER_NAME_FALLBACK])
async def test_no_outcome_names_the_owner_or_the_business(app: FastAPI, client, owner):
    copy = await rivera(app, client)
    business = {"name": "Turner Plumbing", "owner_display_name": owner, "timezone": "America/Los_Angeles",
                "brand": {"palette": "teal"}}
    assert (await put_part(client, copy, "business", business)).status_code == 200
    await activate(app, copy, [*(card for card in RIVERA_CARDS if card.card_id != "rv-quote"),     # quotes ask first
                               RuleCard(card_id="no-book", applies_to="native.book", mode="never", who="anyone",
                                        reason="Mike Turner takes no bookings now.")])
    for lang in ("en", "es"):
        page = await public_page(client, copy, lang)
        assert {block.outcome for block in page.agent_card} == {"allowed", "asks_first", "never"}
        for block in page.agent_card:
            assert block.outcome_text == WORDS[lang][block.outcome]
            for name in ("Mike", "Turner", "Plumbing", OWNER_NAME_FALLBACK):
                assert name not in block.outcome_text, (lang, name)
