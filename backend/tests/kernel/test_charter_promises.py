"""Public policy text must pass the reply check's prose scan before a charter write."""

import pytest

from desk.kernel_service import reply_check
from desk.kernel_service.seed import rivera_seed

from .test_adapters import rivera
from .test_desk_writes import entries_of, facts_of, put_part


POLICY_KEYS = ("about", "service_area", "pricing", "intake", "after_hours", "urgent", "how_we_help", "custom")


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
])
async def test_charter_refuses_promises_without_writing_and_ledgers_rules(app, client, text, rules):
    copy = await rivera(app, client)
    before = {key: fact.claims for key, fact in (await facts_of(app, copy, "charter")).items()}
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
