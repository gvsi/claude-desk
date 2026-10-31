"""Website-derived policy prose reaches visitors only after the public-text scan passes."""

import pytest

from evals.tier1.golden_desk import golden_desk, open_caller
from evals.tier1.harness import Auth, Expect, KernelHarness
from evals.tier1.test_reply_golden import check_reply, handed_off, passes


@pytest.mark.requires("01b")
@pytest.mark.parametrize(("text", "rules"), [
    ("20% off for first-time clients", ["digit", "percent_sign"]),
    ("We work with small businesses and families.", []),
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
