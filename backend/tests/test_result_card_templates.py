"""The API's result-card vocabulary agrees with the kernel without importing it in API code."""

from desk.api.prompts import RESULT_CARD_TEMPLATES, REPLY_TEMPLATES, DeskIdentity, conversation_system
from desk.kernel_service import render
from desk.kernel_service.adapters import payment_link, release_document  # noqa: F401 -- register link templates


def test_result_card_templates_match_the_kernel():
    result_kinds = {kind for name, template in render.TEMPLATES.items() if name in REPLY_TEMPLATES
                    for kind in template.fact_kinds if kind != "charter"}
    assert set(RESULT_CARD_TEMPLATES) == result_kinds
    prompt = conversation_system(DeskIdentity(business_name="Business", desk_name="Desk", owner_name="Owner",
                                               kind="visitor"))[0]["text"]
    bullet = next(line for line in prompt.splitlines() if line.startswith("- Clauses and the facts they cite:"))
    for kind, name in RESULT_CARD_TEMPLATES.items():
        assert name in REPLY_TEMPLATES
        assert render.TEMPLATES[name].fact_kinds == {kind}
        assert f"{name} (a {kind} fact)" in bullet
