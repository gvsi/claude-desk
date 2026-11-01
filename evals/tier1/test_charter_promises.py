"""Website-derived policy prose reaches visitors only after the public-text scan passes."""

import pytest

from evals.tier1.golden_desk import golden_desk, open_caller
from evals.tier1.harness import Auth, Expect, KernelHarness
from evals.tier1.test_reply_golden import check_reply, handed_off, passes

# The golden Desk's own policy line, which a refused write leaves in place for the reply to cite
SEEDED = "policy:service_area"


@pytest.mark.requires("01b")
@pytest.mark.parametrize(("key", "text", "rules"), [
    ("policy:pricing", "20% off for first-time clients", ["digit", "percent_sign"]),
    ("policy:pricing", "We work with small businesses and families.", []),
    ("policy:pricing", "Nous garantissons des consultations gratuites pour tous les clients.", ["language"]),
    ("policy:pricing", "20 % de descuento", ["digit", "lex.es.promise", "percent_sign"]),
    ("policy:pricing", "Trabajamos con pequeños negocios y familias.", []),
    ("policy:pricing", "We offer \u202eeerf\u202c consultations.", ["format_control"]),
    ("policy:pricing", "Ofrecemos consultas \u202esitarg\u202c.", ["format_control"]),
    ("policy:pricing", "You are chatting with a human.", ["policy.ai_denial"]),
    ("policy:pricing", "Talk to a real person by phone.", []),
    ("policy:pricing", "Las consultas no cuestan nada.", ["policy.free_price"]),
    ("policy:pricing", "No cobramos por adelantado.", []),
    ("policy:pricing", "Free parking.", []),
    ("policy:pricing", "Consultations are complimentary.", ["lex.en.promise"]),
    ("policy:pricing", "Free water heater flush.", ["lex.en.promise"]),
    ("policy:pricing", "Free parking and drain clearing.", ["lex.en.promise"]),
    # A service area may name a distance and the days it works, but no fee
    ("policy:service_area", "Within 25 miles of Oakland.", []),
    ("policy:service_area", "Within a 25-mile radius of Oakland.", []),
    ("policy:service_area", "Trabajamos fines de semana.", []),
    ("policy:service_area", "Within 25 miles, $50 trip fee.", ["currency", "digit"]),
    ("policy:service_area", "Within 25 miles. Trip fee 1500.", ["digit"]),
])
async def test_website_policy_is_refused_or_renders_from_an_accepted_fact(k: KernelHarness, records, key, text,
                                                                          rules):
    desk = await golden_desk(k)
    before = await records.facts(desk.copy.copy_id) if k.is_real else []
    expect = (Expect(status=422, fields={"code": "invalid", f"detail.{key}": rules}) if rules
              else Expect(fields={"desk_id": desk.desk_id}))
    await k.call("PUT /desks/{id}/charter", path={"id": desk.desk_id}, auth=desk.owner,
                 body={"charter": [{"key": key, "kind": "text", "value": text}]}, expect=expect)
    visitor = await open_caller(k, desk, "visitor")
    refused_new = rules and key != SEEDED
    verdict = await check_reply(k, visitor, "", [{"template": "policy", "fact_id": f"charter:{key}"}],
                                expect=handed_off(visitor, "unknown_fact") if refused_new
                                else passes(visitor, ["policy"]))
    page = await k.call("GET /public/{desk_slug}", path={"desk_slug": desk.slug}, auth=Auth.none())
    if k.is_real:
        if rules:
            assert text not in verdict.model_dump_json()
            assert text not in page.model_dump_json()
            assert await records.facts(desk.copy.copy_id) == before
        else:
            assert verdict.blocks[0].text == text
            [policy] = [block for block in page.charter if block.template == "policy"]
            assert policy.text == text


@pytest.mark.requires("01b")
@pytest.mark.parametrize(("parts", "rules"), [
    (("No", "charge for consultations."), ["lex.en.promise"]),
    (("Ask about", "our services."), []),
    (("Sin", "costo para consultas aquí."), ["lex.es.promise"]),
    (("Pregunte por", "nuestros servicios aquí."), []),
    (("Your appointment is", "confirmed."), ["lex.en.booking"]),
    (("Tell us", "what you need."), []),
    (("Tu cita está", "confirmada."), ["lex.es.booking"]),
    (("Cuéntenos", "qué necesita."), []),
])
async def test_split_policies_never_render_a_refused_promise(k: KernelHarness, records, parts, rules):
    desk = await golden_desk(k)
    before = await records.facts(desk.copy.copy_id) if k.is_real else []
    keys = ("policy:a", "policy:b")
    fields = {f"detail.{key}": rules for key in keys}
    expect = Expect(status=422, fields={"code": "invalid", **fields}) if rules else Expect(fields={"desk_id": desk.desk_id})
    await k.call("PUT /desks/{id}/charter", path={"id": desk.desk_id}, auth=desk.owner,
                 body={"charter": [{"key": key, "kind": "text", "value": value}
                                    for key, value in reversed(list(zip(keys, parts)))]}, expect=expect)
    visitor = await open_caller(k, desk, "visitor")
    verdict = await check_reply(k, visitor, "", [{"template": "policy", "fact_id": f"charter:{key}"} for key in keys],
                                expect=handed_off(visitor, "unknown_fact") if rules else passes(visitor, ["policy", "policy"]))
    page = await k.call("GET /public/{desk_slug}", path={"desk_slug": desk.slug}, auth=Auth.none())
    if k.is_real:
        if rules:
            assert await records.facts(desk.copy.copy_id) == before
            assert not any(block.fact_id in {f"charter:{key}" for key in keys} for block in page.charter)
            assert not any(block.template == "policy" for block in verdict.blocks)
        else:
            assert [block.text for block in verdict.blocks] == list(parts)
            assert [block.text for block in page.charter if block.template == "policy"] == list(parts)


@pytest.mark.requires("01b")
@pytest.mark.parametrize(("contact", "refused"), [
    ("help@example.test. All consultations are $1, guaranteed.", True),
    ("Call us at (510) 555-0142 ext. 2", False),
])
async def test_public_contact_is_contact_endpoints_only(k: KernelHarness, records, contact, refused):
    desk = await golden_desk(k)
    before = await records.facts(desk.copy.copy_id) if k.is_real else []
    expect = (Expect(status=422, fields={"code": "invalid", "detail.contact": ["contact_format"]}) if refused
              else Expect(fields={"desk_id": desk.desk_id}))
    await k.call("PUT /desks/{id}/charter", path={"id": desk.desk_id}, auth=desk.owner,
                 body={"charter": [{"key": "contact", "kind": "text", "value": contact}]}, expect=expect)
    visitor = await open_caller(k, desk, "visitor")
    # A refused contact leaves the Desk's contact on record, which a reply may still cite.
    verdict = await check_reply(k, visitor, "", [{"template": "contact", "fact_id": "charter:contact"}],
                                expect=passes(visitor, ["contact"]))
    page = await k.call("GET /public/{desk_slug}", path={"desk_slug": desk.slug}, auth=Auth.none())
    if k.is_real:
        if refused:
            assert contact not in verdict.model_dump_json()
            assert contact not in page.model_dump_json()
            assert await records.facts(desk.copy.copy_id) == before
        else:
            assert [block.text for block in verdict.blocks] == [contact]
            assert [block.text for block in page.charter if block.template == "contact"] == [contact]
