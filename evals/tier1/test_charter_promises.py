"""Website-derived policy prose reaches visitors only after the public-text scan passes."""

import pytest

from evals.tier1.golden_desk import golden_desk, open_caller
from evals.tier1.harness import Auth, Expect, KernelHarness
from evals.tier1.test_reply_golden import check_reply, handed_off, passes


@pytest.mark.requires("01b")
@pytest.mark.parametrize(("text", "rules"), [
    ("20% off for first-time clients", ["digit", "percent_sign"]),
    ("We work with small businesses and families.", []),
    ("20 % de descuento", ["digit", "lex.es.promise", "percent_sign"]),
    ("Trabajamos con pequeños negocios y familias.", []),
    ("We offer \u202eeerf\u202c consultations.", ["format_control"]),
    ("Ofrecemos consultas \u202esitarg\u202c.", ["format_control"]),
])
async def test_website_policy_is_refused_or_renders_from_an_accepted_fact(k: KernelHarness, records, text, rules):
    desk = await golden_desk(k)
    before = await records.facts(desk.copy.copy_id) if k.is_real else []
    expect = (Expect(status=422, fields={"code": "invalid", "detail.policy:pricing": rules}) if rules
              else Expect(fields={"desk_id": desk.desk_id}))
    await k.call("PUT /desks/{id}/charter", path={"id": desk.desk_id}, auth=desk.owner,
                 body={"charter": [{"key": "policy:pricing", "kind": "text", "value": text}]}, expect=expect)
    visitor = await open_caller(k, desk, "visitor")
    verdict = await check_reply(k, visitor, "", [{"template": "policy", "fact_id": "charter:policy:pricing"}],
                                expect=handed_off(visitor, "unknown_fact") if rules else passes(visitor, ["policy"]))
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
    (("Sin", "costo para consultas."), ["lex.es.promise"]),
    (("Pregunte por", "nuestros servicios."), []),
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
