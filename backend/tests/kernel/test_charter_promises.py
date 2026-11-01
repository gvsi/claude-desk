"""Public policy text must pass the reply check's prose scan before a charter write."""

import time
from datetime import timedelta

import pytest

from tests import public_policy_cases as policy_cases
from sqlalchemy import select

from desk.contracts import Claim
from desk.db.models import Fact as FactRow
from desk.kernel_service import desks, labels, reply_check
from desk.kernel_service.repo import KernelFailure
from desk.kernel_service.seed import rivera_seed

from .helpers import kernel_ctx
from .test_adapters import rivera
from .test_desk_writes import desks_of, entries_of, facts_of, new_desk, post_desk, put_part
from .test_decide import open_visitor
from .test_reply_check import (PUBLIC_ALLOW_WORD_CASES, assert_handed_off, assert_kept, checked, clause,
                               own_quote, public_key, reply_entries, verify_verdict)


POLICY_KEYS = ("about", "service_area", "pricing", "intake", "after_hours", "urgent", "how_we_help", "custom")


@pytest.mark.parametrize(("text", "rule"), [
    *policy_cases.COST_SERVICE_REFUSALS,
    *policy_cases.AI_DENIAL_REFUSALS,
    *policy_cases.AMENITY_REFUSALS,
    ("You are chatting with a human receptionist.", "policy.ai_denial"),
    ("Está hablando con una persona.", "policy.ai_denial"),
    ("Consultations cost nothing.", "policy.free_price"),
    ("La consulta no le cuesta nada.", "policy.free_price"),
    ("Las consultas no cuestan nada.", "policy.free_price"),
    ("No te cuesta nada.", "policy.free_price"),
    ("No les cuesta nada.", "policy.free_price"),
    ("No cobramos nada por la visita.", "policy.free_price"),
    ("Estás hablando con una persona.", "policy.ai_denial"),
    ("You are chatting with a human.", "policy.ai_denial"),
    ("I'm not a bot.", "policy.ai_denial"),
    ("This is not an AI.", "policy.ai_denial"),
    ("Soy una persona real.", "policy.ai_denial"),
    ("No soy un bot.", "policy.ai_denial"),
    ("Consultations are complimentary.", "lex.en.promise"),
    ("The first visit is complimentary.", "lex.en.promise"),
    ("Free estimates.", "lex.en.promise"),
    ("Consulta gratis.", "lex.es.promise"),
])
async def test_policy_phrase_refusal_names_only_the_bad_line_and_guards_legacy_reads(app, client, text, rule):
    copy = await rivera(app, client)
    claims = [{"key": key, "kind": "text", "value": value} for key, value in (
        ("policy:about", "Ask about our services."),
        ("policy:custom", text),
        ("policy:parking", "Complimentary parking"),
        ("contact", "(510) 555-0199"),
    )]
    response = await put_part(client, copy, "charter", {"charter": claims})
    assert (response.status_code, response.json()) == (422, {
        "code": "invalid", "detail": {"policy:custom": [rule]}})
    # Setup drops exactly the detail's keys and retries the remaining charter lines.
    kept = [claim for claim in claims if claim["key"] not in response.json()["detail"]]
    response = await put_part(client, copy, "charter", {"charter": kept})
    assert response.status_code == 200, response.text
    assert "charter:policy:parking" in await facts_of(app, copy, "charter")
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == copy.desk_id, FactRow.fact_id == "charter:policy:about")))).one()
        row.claims = [Claim(key="policy:about", kind="text", value=text)]
    for language in ("en", "es"):
        page = await client.get(f"/public/{copy.slug}", params={"lang": language})
        assert page.status_code == 200
        # The stored line is withheld on its own; the honest lines beside it stay.
        policies = [block["fact_id"] for block in page.json()["charter"] if block["template"] == "policy"]
        assert "charter:policy:about" not in policies and "charter:policy:parking" in policies
        assert text not in page.text
    visitor = await open_visitor(client, copy)
    for prose in ("", "Here are the details."):
        verdict = await checked(client, visitor, prose, [clause("policy", "charter:policy:about")])
        assert [(v.rule_id, v.fact_ids) for v in verdict.violations] == [
            ("policy_combined", ["charter:policy:about"])]
        assert_handed_off(verdict)
        verify_verdict(await public_key(client), visitor.session_id, verdict)
        assert all(block.template != "policy" for block in verdict.blocks)


@pytest.mark.parametrize("text", [
    "Within 25 miles of Oakland.",
    "We drive a few miles past Oakland.",
    "The East Bay, seven days a week.",
    "Serving the East Bay since 1998.",
    "We do evenings and weekends.",
    "Trabajamos fines de semana.",
    "Within a 25-mile radius of Oakland.",
    "We serve a 30 mile radius around Oakland.",
    "Within 1 mile of Lake Merritt.",
    "A 50-km radius.",
    "Dentro de 1 kilómetro.",
    "We cover three counties: Alameda, Contra Costa and Marin.",
    "We serve all nine Bay Area counties.",
    "Two locations: Oakland and Berkeley.",
    "Serving the five boroughs.",
    "Atendemos tres condados: Alameda, Contra Costa y Marin.",
    "Dos sucursales: Oakland y Berkeley.",
    "Serving the East Bay for over twenty years.",
    "Within half a mile of Lake Merritt.",
    "Within a hundred miles of Oakland.",
    "Oakland and Berkeley, 7 days a week.",
    "Trabajamos 7 días a la semana.",
    "We cover 20-30 miles around Oakland.",
    "Within 20–30 miles of Oakland.",
    "20 to 30 miles",
    "Trabajamos por la mañana.",
    "Serving the East Bay desde 1998.",
    "In 1998.",
    "From 1998.",
    "Est. 1998.",
    "Established 1998.",
    "Founded 1998.",
    "Desde 1998.",
    "En 1998.",
    "Since 1900.",
    "Since 2099.",
    "Oakland and Berkeley, 24/7.",
    "Oakland, Berkeley and Alameda (zip codes 94601-94612).",
    "ZIP 94601.",
    "ZIP code 94601.",
    "ZIP codes 94601.",
    "Código postal 94601.",
    "Oakland, CA 94601.",
    "Along I-580.",
    "Along Highway 101.",
    "Along Hwy 24.",
])
async def test_service_area_allows_area_and_weekly_availability(app, client, text):
    copy = await rivera(app, client)
    response = await put_part(client, copy, "charter", {"charter": [
        {"key": "policy:service_area", "kind": "text", "value": text}]})
    assert response.status_code == 200, response.text
    for language in ("en", "es"):
        page = await client.get(f"/public/{copy.slug}", params={"lang": language})
        assert [block["text"] for block in page.json()["charter"] if block["template"] == "policy"] == [text]
    visitor = await open_visitor(client, copy)
    verdict = await checked(client, visitor, "", [clause("policy", "charter:policy:service_area")])
    assert (verdict.ok, verdict.violations) == (True, [])
    assert [block.text for block in verdict.blocks] == [text]
    verify_verdict(await public_key(client), visitor.session_id, verdict)


@pytest.mark.parametrize(("values", "fields"), PUBLIC_ALLOW_WORD_CASES)
async def test_public_promise_refusal_passes_per_key_allow_words(app, client, values, fields):
    copy = await rivera(app, client)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        if fields:
            with pytest.raises(KernelFailure) as failure:
                await desks.refuse_public_promises(ctx, "business_tools", values, copy.desk_id,
                                                    allow_words={"a:title": reply_check.FREE_WORDS})
            assert (failure.value.status, failure.value.code, failure.value.detail) == (422, "invalid", fields)
        else:
            await desks.refuse_public_promises(ctx, "business_tools", values, copy.desk_id,
                                               allow_words={"a:title": reply_check.FREE_WORDS})


@pytest.mark.parametrize("parts", [
    ("No", "charge for consultations."),
    ("Sin", "costo para consultas aquí."),
    ("Your appointment is", "confirmed."),
    ("Tu cita está", "confirmada."),
])
async def test_reply_refuses_policy_promises_reassembled_in_citation_order(app, client, parts):
    copy = await rivera(app, client)
    # Public order is harmless; the unrelated policy must not be blamed for the reply's reversal.
    response = await put_part(client, copy, "charter", {"charter": [
        {"key": "policy:a", "kind": "text", "value": parts[1]},
        {"key": "policy:b", "kind": "text", "value": parts[0]},
        {"key": "policy:z", "kind": "text", "value": "Ask about our services."},
    ]})
    assert response.status_code == 200, response.text
    visitor = await open_visitor(client, copy)
    verdict = await checked(client, visitor, "", [
        clause("policy", "charter:policy:z"),
        clause("policy", "charter:policy:b"),
        clause("policy", "charter:policy:a"),
    ])
    assert verdict.ok is False
    assert [(v.kind, v.rule_id, v.fact_ids) for v in verdict.violations] == [
        ("unknown_fact", "policy_combined", ["charter:policy:b", "charter:policy:a"])]
    assert_handed_off(verdict)
    verify_verdict(await public_key(client), visitor.session_id, verdict)
    assert all(block.template != "policy" for block in verdict.blocks)
    [entry] = await reply_entries(app, copy)
    assert (entry.event.summary["ok"], entry.event.summary["rule_ids"]) == (False, ["policy_combined"])


@pytest.mark.parametrize("parts", [
    ("We offer fr", "ee consultations."),
    ("Ofrecemos consultas gra", "tis aquí."),
])
async def test_reply_keeps_honest_policy_word_fragments_on_separate_cards(app, client, parts):
    copy = await rivera(app, client)
    response = await put_part(client, copy, "charter", {"charter": [
        {"key": "policy:a", "kind": "text", "value": parts[0]},
        {"key": "policy:b", "kind": "text", "value": parts[1]},
    ]})
    assert response.status_code == 200, response.text
    visitor = await open_visitor(client, copy)
    verdict = await checked(client, visitor, "", [
        clause("policy", "charter:policy:a"), clause("policy", "charter:policy:b")])
    assert (verdict.ok, verdict.violations) == (True, [])
    assert [block.text for block in verdict.blocks] == list(parts)
    verify_verdict(await public_key(client), visitor.session_id, verdict)


@pytest.mark.parametrize("prose", ["No", "Ｎｏ"])
async def test_reply_refuses_a_promise_split_between_shown_prose_and_policy(app, client, prose):
    copy = await rivera(app, client)
    response = await put_part(client, copy, "charter", {"charter": [
        {"key": "policy:a", "kind": "text", "value": "charge for consultations."},
    ]})
    assert response.status_code == 200, response.text
    visitor = await open_visitor(client, copy)
    # The full-width letters normalize to the prose actually shown to the visitor.
    verdict = await checked(client, visitor, prose, [clause("policy", "charter:policy:a")])
    assert [(v.kind, v.rule_id, v.fact_ids) for v in verdict.violations] == [
        ("unknown_fact", "policy_combined", ["charter:policy:a"])]
    assert_handed_off(verdict)
    verify_verdict(await public_key(client), visitor.session_id, verdict)


@pytest.mark.parametrize("quote_first", [False, True])
async def test_reply_does_not_scan_quote_numbers_as_policy_text(app, client, quote_first):
    copy = await rivera(app, client)
    response = await put_part(client, copy, "charter", {"charter": [
        {"key": "policy:a", "kind": "text", "value": "Ask about our services."},
    ]})
    assert response.status_code == 200, response.text
    visitor = await open_visitor(client, copy)
    quote = await own_quote(client, visitor)
    clauses = [clause("policy", "charter:policy:a"), clause("quote", quote.fact_id)]
    if quote_first:
        clauses.reverse()
    verdict = await checked(client, visitor, "Here are the details.", clauses)
    assert (verdict.ok, verdict.violations) == (True, [])
    assert [block.template for block in verdict.blocks[1:]] == [item["template"] for item in clauses]
    assert next(block for block in verdict.blocks if block.template == "quote").title == "$180.00"
    verify_verdict(await public_key(client), visitor.session_id, verdict)


async def test_prose_only_failure_keeps_its_existing_rule_beside_a_policy(app, client):
    """A promise in Claude's words beside an honest policy card fails under the prose's own rule, not
    `policy_combined`, and the checked card is kept with no prose (the owner's ruling of 2026-11-01)."""
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    verdict = await checked(client, visitor, "No charge for consultations.", [
        clause("policy", "charter:policy:service_area")])
    assert [(v.kind, v.rule_id, v.fact_ids) for v in verdict.violations] == [
        ("promise_word", "lex.en.promise", [])]
    assert_kept(verdict, [("policy", "charter:policy:service_area")])


@pytest.mark.parametrize(("unsafe", "honest", "rules"), [
    ("20% off for first-time clients", "We work with small businesses and families.", ["digit", "percent_sign"]),
    ("20 % de descuento", "Trabajamos con pequeños negocios y familias.",
     ["digit", "lex.es.promise", "percent_sign"]),
    ("free consultation", "Ask about our services.", ["lex.en.promise"]),
    ("Nous garantissons des consultations gratuites pour tous les clients.",
     "Ask about our services.", ["language"]),
    ("garantizamos", "Pregunte por nuestros servicios aquí.", ["lex.es.promise"]),
    ("We offer \u202eeerf\u202c consultations.", "Ask about our services.", ["format_control"]),
    ("Ofrecemos consultas \u202esitarg\u202c.", "Pregunte por nuestros servicios aquí.", ["format_control"]),
])
async def test_creation_refuses_policy_before_rows_and_ledgers_on_existing_desks(app, client, unsafe, honest, rules):
    copy = await rivera(app, client)
    before = set(await desks_of(app, copy))
    entries = len(await entries_of(app, copy))
    body = new_desk()
    body["desk"]["charter"] = [{"key": "policy:about", "kind": "text", "value": unsafe}]
    response = await post_desk(client, copy, body)
    fields = {"policy:about": rules}
    assert (response.status_code, response.json()) == (422, {"code": "invalid", "detail": fields})
    assert set(await desks_of(app, copy)) == before
    [entry] = (await entries_of(app, copy))[entries:]
    assert entry.event.summary == {"part": "desk", "refused": "promise", "fields": fields}
    assert unsafe not in entry.event.model_dump_json()
    body["desk"]["charter"][0]["value"] = honest
    response = await post_desk(client, copy, body)
    assert response.status_code == 200, response.text
    for language in ("en", "es"):
        page = await client.get(f"/public/{response.json()['slug']}", params={"lang": language})
        [policy] = [block for block in page.json()["charter"] if block["template"] == "policy"]
        assert policy["text"] == honest


@pytest.mark.parametrize(("text", "rules"), [
    ("20% off for first-time clients", ["digit", "percent_sign"]),
    ("$50 deposit", ["currency", "digit"]),
    ("free consultation", ["lex.en.promise"]),
    ("we guarantee", ["lex.en.promise"]),
    ("refund within 30 days", ["digit", "lex.en.promise"]),
    ("within two hours", ["lex.en.date", "lex.en.number"]),
    ("after 6 pm", ["digit", "lex.en.date"]),
    ("Monday to Friday", ["lex.en.date"]),
    ("20 % de descuento", ["digit", "lex.es.promise", "percent_sign"]),
    ("garantizamos", ["lex.es.promise"]),
    ("reembolso", ["lex.es.promise"]),
    ("You're booked.", ["lex.en.booking"]),
    ("Tu cita está confirmada.", ["lex.es.booking"]),
    ("We offer \u202eeerf\u202c consultations.", ["format_control"]),
    ("Ofrecemos consultas \u202esitarg\u202c.", ["format_control"]),
    ("Ask about our\u200d services.", ["format_control"]),
    ("Pregunte por nuestros\u200d servicios aquí.", ["format_control"]),
])
async def test_charter_refuses_promises_without_writing_and_ledgers_rules(app, client, text, rules):
    copy = await rivera(app, client)
    before = {key: fact.claims for key, fact in (await facts_of(app, copy, "charter")).items()}
    public_before = (await client.get(f"/public/{copy.slug}")).json()["charter"]
    entries = len(await entries_of(app, copy))
    fields = {f"policy:{key}": rules for key in POLICY_KEYS}
    area_rules = {"within two hours": ["lex.en.date"], "Monday to Friday": []}.get(text, rules)
    if area_rules:
        fields["policy:service_area"] = area_rules
    else:
        del fields["policy:service_area"]
    claims = [{"key": f"policy:{key}", "kind": "text", "value": text} for key in POLICY_KEYS]
    claims += [{"key": "policy:other", "kind": "text", "value": "Ask about our services."},
               {"key": "contact", "kind": "text", "value": "(510) 555-0199"}]
    response = await put_part(client, copy, "charter", {"charter": claims})
    assert (response.status_code, response.json()) == (422, {"code": "invalid", "detail": fields})
    assert {key: fact.claims for key, fact in (await facts_of(app, copy, "charter")).items()} == before
    [entry] = (await entries_of(app, copy))[entries:]
    assert (entry.event.kind, entry.event.summary) == (
        "desk_data", {"part": "charter", "refused": "promise", "fields": fields})
    assert text not in response.text
    assert text not in entry.event.model_dump_json()
    assert (await client.get(f"/public/{copy.slug}")).json()["charter"] == public_before


@pytest.mark.parametrize("text", [
    *policy_cases.PAYMENT_TIMING,
    *policy_cases.COST_AMENITIES,
    *policy_cases.HUMAN_OCCUPATIONS,
    *policy_cases.AI_DENIAL_CONTROLS,
    *policy_cases.AMENITY_ACCEPTED,
    "Human resources consulting",
    "We treat every customer like a person",
    "Complimentary parking",
    "Our receptionist will greet you",
    "Atención personalizada",
    "No cobramos por adelantado.",
    "No cobramos nada más que lo acordado.",
    # Directions to reach a person, an AI disclosure and payment timing.
    "Talk to a real person by phone.",
    "Call to speak with a live agent.",
    "Call to speak with a live person.",
    "This is an AI assistant, not a real person.",
    "A real person will call back in the morning.",
    "I'm a human resources consultant.",
    "I am a human rights lawyer.",
    "Our photos are not AI-generated.",
    "Nothing to pay until the job is done.",
    "Habla con una persona real por teléfono.",
    "Una persona real le devolverá la llamada.",
    "Nada que pagar hasta que el trabajo esté hecho.",
    # Free amenities, never free services.
    "Complimentary parking.",
    "Free parking.",
    "Free wi-fi while you wait.",
    "Complimentary coffee while you wait.",
    "Estacionamiento gratis.",
    "We work with small businesses and families.",
    "Tell us what you need and we'll suggest next steps.",
    "Ask about our services.",
    "Trabajamos con pequeños negocios y familias.",
    "Cuéntenos qué necesita y le sugeriremos los siguientes pasos.",
    "Pregunte por nuestros servicios aquí.",
    "Service area: Portland, Beaverton, Hillsboro, Tigard",
    "Cash, card, Venmo accepted",
    "Pour-over coffee available",
    "Les ofrecemos envío a domicilio",
    "Emergency service available",
    "Se requiere un garante.",
])
async def test_honest_policy_text_is_written_and_rendered(app, client, text):
    copy = await rivera(app, client)
    response = await put_part(client, copy, "charter", {"charter": [
        {"key": "policy:about", "kind": "text", "value": text},
        {"key": "contact", "kind": "text", "value": "(510) 555-0199"},
    ]})
    assert response.status_code == 200, response.text
    facts = await facts_of(app, copy, "charter")
    assert facts["charter:policy:about"].claims[0].value == text
    assert "charter:hours" in facts
    for language in ("en", "es"):
        page = await client.get(f"/public/{copy.slug}", params={"lang": language})
        assert page.status_code == 200, page.text
        [policy] = [block for block in page.json()["charter"] if block["template"] == "policy"]
        assert policy["text"] == text
        assert reply_check.scan_public_text(policy["text"]) == []
        assert any(block["text"] == "(510) 555-0199" for block in page.json()["charter"])
    visitor = await open_visitor(client, copy)
    verdict = await checked(client, visitor, "", [clause("policy", "charter:policy:about")])
    assert verdict.ok and verdict.blocks[0].text == text
    verify_verdict(await public_key(client), visitor.session_id, verdict)


async def test_rivera_seed_policies_pass_the_scan_and_charter_write(app, client, frozen_clock):
    _, seed = rivera_seed(frozen_clock.now())
    assert {claim.key: reply_check.scan_public_text(claim.value) for claim in seed.charter
            if claim.key.startswith("policy:") and claim.kind == "text"} == {
                "policy:service_area": [], "policy:first_visit": [], "policy:arrival": []}
    copy = await rivera(app, client)
    response = await put_part(client, copy, "charter", {
        "charter": [claim.model_dump(mode="json") for claim in seed.charter]})
    assert response.status_code == 200, response.text


@pytest.mark.parametrize("create", [False, True], ids=["replace", "create"])
@pytest.mark.parametrize(("unsafe", "honest", "rule"), [
    (("No", "charge for consultations."), ("Ask about", "our services."), "lex.en.promise"),
    (("Sin", "costo para consultas aquí."), ("Pregunte por", "nuestros servicios."), "lex.es.promise"),
    (("Your appointment is", "confirmed."), ("Tell us", "what you need."), "lex.en.booking"),
    (("Tu cita está", "confirmada."), ("Cuéntenos", "qué necesita."), "lex.es.booking"),
    (("Your callback is", "scheduled."), ("Tell us", "what you need."), "lex.en.callback"),
    (("Tu llamada está", "confirmada."), ("Cuéntenos", "qué necesita."), "lex.es.callback"),
    # The claim's participle comes before the booking noun it needs, in the next policy.
    (("Ya quedó hecha", "tu cita."), ("Ya quedó hecha", "la tarea."), "lex.es.booking"),
])
async def test_split_policy_claims_follow_public_order_and_refuse_only_contributors(
        app, client, create, unsafe, honest, rule):
    copy = await rivera(app, client)
    assert all(reply_check.scan_public_text(text) == [] for text in unsafe)
    assert reply_check.scan_public_text("\n".join(unsafe)) == [rule]
    before = {key: fact.claims for key, fact in (await facts_of(app, copy, "charter")).items()}
    desk_ids = set(await desks_of(app, copy))
    entries = len(await entries_of(app, copy))

    async def write(parts):
        # Request order is deliberately different from public fact-ID order. Contact stays outside the scan.
        claims = [{"key": key, "kind": "text", "value": value} for key, value in (
            ("policy:z", "Ask about our services."), ("policy:c", parts[1]),
            ("contact", "(510) 555-0199"), ("policy:b", parts[0]), ("policy:a", "Pregunte por nuestros servicios aquí."))]
        if create:
            body = new_desk()
            body["desk"]["charter"] = claims
            return await post_desk(client, copy, body)
        return await put_part(client, copy, "charter", {"charter": claims})

    response = await write(unsafe)
    fields = {"policy:b": [rule], "policy:c": [rule]}
    assert (response.status_code, response.json()) == (422, {"code": "invalid", "detail": fields})
    assert set(await desks_of(app, copy)) == desk_ids
    assert {key: fact.claims for key, fact in (await facts_of(app, copy, "charter")).items()} == before
    [entry] = (await entries_of(app, copy))[entries:]
    assert entry.event.summary == {"part": "desk" if create else "charter", "refused": "promise", "fields": fields}
    response = await write(honest)
    assert response.status_code == 200, response.text
    slug = response.json()["slug"] if create else copy.slug
    for language in ("en", "es"):
        page = await client.get(f"/public/{slug}", params={"lang": language})
        policies = [block for block in page.json()["charter"] if block["template"] == "policy"]
        assert [block["text"] for block in policies] == ["Pregunte por nuestros servicios aquí.", *honest,
                                                       "Ask about our services."]
        assert reply_check.scan_public_text("\n".join(block["text"] for block in policies)) == []


@pytest.mark.parametrize("parts", [
    ("20% off for first-time clients", "Ask about our services."),
    ("No", "charge for consultations."),
    ("Nous garantissons des consultations gratuites pour tous les clients.", "Ask about our services."),
    ("Consultations gratuites pour tous les clients.", "Ask about our services."),
    ("Services sans frais pour tous les clients.", "Ask about our services."),
    ("Livraison offerte pour tous", "Ask about our services."),
    ("Remise de 20% sans frais", "Ask about our services."),
    ("Привет мир.", "Ask about our services."),
    ("Portland Beaverton Hillsboro free", "Ask about our services."),
])
async def test_public_withholds_only_unsafe_legacy_policy_lines(app, client, parts):
    copy = await rivera(app, client)
    # Write historical rows directly so the current write guard cannot sanitize this state.
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        rows = list(await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == copy.desk_id, FactRow.kind == "charter",
            FactRow.fact_id.in_(["charter:policy:arrival", "charter:policy:first_visit"]))
            .order_by(FactRow.fact_id))))
        for row, value in zip(rows, parts, strict=True):
            row.claims = [Claim(key=row.fact_id.removeprefix("charter:"), kind="text", value=value)]
    for language in ("en", "es"):
        page = await client.get(f"/public/{copy.slug}", params={"lang": language})
        assert page.status_code == 200
        kept = ["charter:policy:first_visit"] if parts[1] == "Ask about our services." else []
        assert [block["fact_id"] for block in page.json()["charter"] if block["template"] == "policy"] == [
            *kept, "charter:policy:service_area"]
        assert any(block["template"] == "hours" for block in page.json()["charter"])


@pytest.mark.parametrize("text", ["Nous garantissons des consultations gratuites pour tous les clients.",
                                  "Consultations gratuites pour tous les clients.",
                                  "Services sans frais pour tous les clients.",
                                  "Livraison offerte pour tous", "Remise de 20% sans frais",
                                  "Привет мир.", "Portland Beaverton Hillsboro free"])
async def test_policy_only_reply_refuses_legacy_unsupported_language(app, client, text):
    copy = await rivera(app, client)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == copy.desk_id, FactRow.fact_id == "charter:policy:service_area")))).one()
        row.claims = [Claim(key="policy:service_area", kind="text",
                           value=text)]
    visitor = await open_visitor(client, copy)
    verdict = await checked(client, visitor, "", [clause("policy", "charter:policy:service_area")])
    assert [(v.kind, v.rule_id, v.fact_ids) for v in verdict.violations] == [
        ("unknown_fact", "policy_combined", ["charter:policy:service_area"])]
    assert_handed_off(verdict)
    verify_verdict(await public_key(client), visitor.session_id, verdict)


@pytest.mark.parametrize(("text", "rules"), [
    ("Nous garantissons des consultations gratuites pour tous les clients.", ["language"]),
    ("Consultations gratuites pour tous les clients.", ["language"]),
    ("Services sans frais pour tous les clients.", ["language"]),
    ("Livraison offerte pour tous", ["language"]),
    ("Remise de 20% sans frais", ["digit", "language", "percent_sign"]),
    ("Привет мир.", ["language"]),
    ("Portland Beaverton Hillsboro free", ["lex.en.promise"]),
])
async def test_charter_refuses_unsupported_language_policy(client, app, text, rules):
    copy = await rivera(app, client)
    response = await put_part(client, copy, "charter", {"charter": [
        {"key": "policy:about", "kind": "text",
         "value": text}]})
    assert (response.status_code, response.json()) == (422, {
        "code": "invalid", "detail": {"policy:about": rules}})


@pytest.mark.parametrize("create", [False, True], ids=["replace", "create"])
@pytest.mark.parametrize(("count", "length", "code"), [
    (41, 40, "policy_count_limit"),
    (40, 201, "policy_text_limit"),
    (400, 1, "policy_count_limit"),
])
async def test_policy_limits_refuse_before_scanning_or_writing(app, client, monkeypatch, create, count, length, code):
    copy = await rivera(app, client)
    before = await facts_of(app, copy, "charter")
    desk_ids = set(await desks_of(app, copy))
    entries = len(await entries_of(app, copy))
    claims = [{"key": f"policy:{index:02d}", "kind": "text", "value": "x" * length} for index in range(count)]

    def unexpected_scan(values):
        pytest.fail("oversized policy input reached the lexical scan")

    monkeypatch.setattr(reply_check, "scan_public_policies", unexpected_scan)
    if create:
        body = new_desk()
        body["desk"]["charter"] = claims
        response = await post_desk(client, copy, body)
    else:
        response = await put_part(client, copy, "charter", {"charter": claims})
    assert (response.status_code, response.json()) == (422, {
        "code": "invalid", "detail": {"charter": [code]}})
    assert set(await desks_of(app, copy)) == desk_ids
    assert {key: fact.claims for key, fact in (await facts_of(app, copy, "charter")).items()} == {
        key: fact.claims for key, fact in before.items()}
    [entry] = (await entries_of(app, copy))[entries:]
    assert entry.event.summary == {
        "part": "desk" if create else "charter", "refused": "promise", "fields": {"charter": [code]},
        # The first forty keys and the count of all of them: a huge charter can't grow the entry.
        "keys": sorted(claim["key"] for claim in claims)[:40], "policy_count": count,
        "total_characters": count * length, "reason": code,
    }
    assert "x" * length not in entry.event.model_dump_json()
    page = await client.get(f"/ledger/{copy.desk_id}", headers=copy.owner)
    assert page.status_code == 200, page.text
    assert page.json()["chain_ok"] is True


@pytest.mark.parametrize(("count", "length"), [(41, 40), (40, 201)])
async def test_policy_cap_refusal_fails_closed_when_ledger_write_fails(app, client, monkeypatch, count, length):
    copy = await rivera(app, client)
    before = {key: fact.claims for key, fact in (await facts_of(app, copy, "charter")).items()}
    entries = len(await entries_of(app, copy))

    async def unavailable(*args, **kwargs):
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(desks, "_ledger_refusal", unavailable)
    response = await put_part(client, copy, "charter", {"charter": [
        {"key": f"policy:{index:02d}", "kind": "text", "value": "x" * length} for index in range(count)]})
    assert (response.status_code, response.json()) == (500, {"code": "internal"})
    assert {key: fact.claims for key, fact in (await facts_of(app, copy, "charter")).items()} == before
    assert len(await entries_of(app, copy)) == entries


@pytest.mark.parametrize("hidden", ["private", "expired", "canary"])
async def test_public_policy_scan_runs_after_filtering(app, client, hidden):
    copy = await rivera(app, client)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        rows = list(await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == copy.desk_id, FactRow.kind == "charter",
            FactRow.fact_id.like("charter:policy:%")).order_by(FactRow.fact_id))))
        for row, value in zip(rows, ["No", "Ask about our services.", "charge for consultations."], strict=True):
            row.claims = [Claim(key=row.fact_id.removeprefix("charter:"), kind="text", value=value)]
        middle = rows[1]
        if hidden == "private":
            middle.readers = ["owner"]
        elif hidden == "expired":
            middle.expires_at = ctx.clock.now() - timedelta(seconds=1)
        else:
            canary = next(iter((await labels.copy_canaries(ctx)).values()))
            middle.claims = [Claim(key="policy:first_visit", kind="text", value=f"Ask about our services. {canary}")]
    for language in ("en", "es"):
        page = await client.get(f"/public/{copy.slug}", params={"lang": language})
        assert page.status_code == 200
        assert all(block["template"] != "policy" for block in page.json()["charter"])


@pytest.mark.parametrize("create", [False, True], ids=["replace", "create"])
async def test_policy_limits_accept_the_exact_maximum(app, client, create):
    copy = await rivera(app, client)
    text = ("Ask about our services. " * 10)[:200]
    assert len(text) == 200
    claims = [{"key": f"policy:{index:02d}", "kind": "text", "value": text} for index in range(40)]
    if create:
        body = new_desk()
        body["desk"]["charter"] = claims
        response = await post_desk(client, copy, body)
    else:
        response = await put_part(client, copy, "charter", {"charter": claims})
    assert response.status_code == 200, response.text
    slug = response.json()["slug"] if create else copy.slug
    page = await client.get(f"/public/{slug}")
    assert len([block for block in page.json()["charter"] if block["template"] == "policy"]) == 40


@pytest.mark.parametrize("text", [
    "Garantimos o serviço.",
    "Consultas sem cobrança.",
    "Nos prestations : la visite, la pose, la réparation sont offertes.",
    "Une garantie pour la pose et la réparation.",
    "Consultas sem custo para todos os clientes.",
    "La consegna e la posa sono senza costi.",
    "Beratung kostenlos für alle Kunden.",
    "Consultations gratuites pour tous les clients.",
    "Services sans frais pour tous les clients.",
    "Livraison offerte pour tous",
    "Remise de 20% sans frais",
])
async def test_other_commitment_policy_refused_on_write_public_read_and_reply(app, client, text):
    copy = await rivera(app, client)
    response = await put_part(client, copy, "charter", {"charter": [
        {"key": "policy:about", "kind": "text", "value": text}]})
    assert response.status_code == 422
    assert "language" in response.json()["detail"]["policy:about"]
    # Directly store an older policy to exercise both public-read and reply guards.
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == copy.desk_id, FactRow.fact_id == "charter:policy:service_area")))).one()
        row.claims = [Claim(key="policy:service_area", kind="text", value=text)]
    for language in ("en", "es"):
        page = await client.get(f"/public/{copy.slug}", params={"lang": language})
        assert page.status_code == 200
        assert [block["fact_id"] for block in page.json()["charter"] if block["template"] == "policy"] == [
            "charter:policy:arrival", "charter:policy:first_visit"]
    visitor = await open_visitor(client, copy)
    verdict = await checked(client, visitor, "", [clause("policy", "charter:policy:service_area")])
    assert_handed_off(verdict)
    assert [(v.rule_id, v.fact_ids) for v in verdict.violations] == [
        ("policy_combined", ["charter:policy:service_area"])]
    verify_verdict(await public_key(client), visitor.session_id, verdict)


@pytest.mark.parametrize("text", [
    "Contact: info@example.com",
    "Non-emergency plumbing",
    "Consultas con cita previa en example.com",
    "Cash, card, Venmo accepted",
    "Service area: Portland, Beaverton, Hillsboro, Tigard",
    "Pour-over coffee available",
    "Les ofrecemos envío a domicilio",
    "Ask about our services.",
    "Consultas con cita previa.",
    "Garage parking available",
    "Offering estimates by appointment",
])
async def test_honest_policy_passes_other_commitment_guard_on_all_routes(app, client, text):
    copy = await rivera(app, client)
    response = await put_part(client, copy, "charter", {"charter": [
        {"key": "policy:about", "kind": "text", "value": text}]})
    assert response.status_code == 200, response.text
    for language in ("en", "es"):
        page = await client.get(f"/public/{copy.slug}", params={"lang": language})
        assert page.status_code == 200
        assert [b["text"] for b in page.json()["charter"] if b["template"] == "policy"] == [text]
    visitor = await open_visitor(client, copy)
    verdict = await checked(client, visitor, "", [clause("policy", "charter:policy:about")])
    assert verdict.ok and verdict.violations == []
    assert [block.text for block in verdict.blocks] == [text]
    verify_verdict(await public_key(client), visitor.session_id, verdict)


@pytest.mark.parametrize("unit", ["ZIP 94601. ", "Since 1998. ", "I-880. ", "Oakland 24/7. ", "20 miles. "])
def test_a_long_service_area_is_scanned_in_one_pass(unit):
    """Each digit's year, ZIP, road or 24/7 context is read near the digit, not from the start of
    the text, so a long service area, read on every public page view, costs one pass."""
    text = unit * (32_000 // len(unit))     # four times the charter cap: a quadratic scan takes seconds here
    started = time.process_time()
    assert reply_check.scan_public_text(text, policy_key="policy:service_area") == []
    assert time.process_time() - started < 1
