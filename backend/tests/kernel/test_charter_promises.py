"""Public policy text must pass the reply check's prose scan before a charter write."""

import pytest

from desk.kernel_service import reply_check
from desk.kernel_service.seed import rivera_seed

from .test_adapters import rivera
from .test_desk_writes import desks_of, entries_of, facts_of, new_desk, post_desk, put_part
from .test_decide import open_visitor
from .test_reply_check import (assert_handed_off, checked, clause, own_quote, public_key, reply_entries,
                               verify_verdict)


POLICY_KEYS = ("about", "service_area", "pricing", "intake", "after_hours", "urgent", "how_we_help", "custom")


@pytest.mark.parametrize("parts", [
    ("No", "charge for consultations."),
    ("Sin", "costo para consultas."),
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
    ("Ofrecemos consultas gra", "tis."),
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
    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    verdict = await checked(client, visitor, "No charge for consultations.", [
        clause("policy", "charter:policy:service_area")])
    assert [(v.kind, v.rule_id, v.fact_ids) for v in verdict.violations] == [
        ("promise_word", "lex.en.promise", [])]
    assert_handed_off(verdict)


@pytest.mark.parametrize(("unsafe", "honest", "rules"), [
    ("20% off for first-time clients", "We work with small businesses and families.", ["digit", "percent_sign"]),
    ("20 % de descuento", "Trabajamos con pequeños negocios y familias.",
     ["digit", "lex.es.promise", "percent_sign"]),
    ("free consultation", "Ask about our services.", ["lex.en.promise"]),
    ("garantizamos", "Pregunte por nuestros servicios.", ["lex.es.promise"]),
    ("We offer \u202eeerf\u202c consultations.", "Ask about our services.", ["format_control"]),
    ("Ofrecemos consultas \u202esitarg\u202c.", "Pregunte por nuestros servicios.", ["format_control"]),
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
    ("Pregunte por nuestros\u200d servicios.", ["format_control"]),
])
async def test_charter_refuses_promises_without_writing_and_ledgers_rules(app, client, text, rules):
    copy = await rivera(app, client)
    before = {key: fact.claims for key, fact in (await facts_of(app, copy, "charter")).items()}
    public_before = (await client.get(f"/public/{copy.slug}")).json()["charter"]
    entries = len(await entries_of(app, copy))
    fields = {f"policy:{key}": rules for key in POLICY_KEYS}
    claims = [{"key": key, "kind": "text", "value": text} for key in fields]
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
    "We work with small businesses and families.",
    "Tell us what you need and we'll suggest next steps.",
    "Ask about our services.",
    "Trabajamos con pequeños negocios y familias.",
    "Cuéntenos qué necesita y le sugeriremos los siguientes pasos.",
    "Pregunte por nuestros servicios.",
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
    (("Sin", "costo para consultas."), ("Pregunte por", "nuestros servicios."), "lex.es.promise"),
    (("Your appointment is", "confirmed."), ("Tell us", "what you need."), "lex.en.booking"),
    (("Tu cita está", "confirmada."), ("Cuéntenos", "qué necesita."), "lex.es.booking"),
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
            ("contact", "(510) 555-0199"), ("policy:b", parts[0]), ("policy:a", "Pregunte por nuestros servicios."))]
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
        assert [block["text"] for block in policies] == ["Pregunte por nuestros servicios.", *honest,
                                                       "Ask about our services."]
        assert reply_check.scan_public_text("\n".join(block["text"] for block in policies)) == []
