"""The reply check on Markdown prose: the chats render Claude's prose as Markdown (the owner's decision
of 2026-11-01), so the kernel scans what a visitor sees as well as the raw text.

Formatting can't hide a price, date, discount or promise from the scan, and numbers stay refused in
every Markdown form, list markers included; honest bullets, bold, headings, tables without numbers and
links to the business's own site pass; a link's target must be the business's own contact; images are
refused.
"""

import pytest

from desk.contracts import RenderedBlock
from desk.kernel_service import markdown_text

from .test_adapters import visitor_of
from .test_reply_check import checked

STEPS = "1. Turn off the main valve\n2. Open the lowest tap\n3. Wait for Maria\n4. Keep the area dry"


def test_an_ordered_list_is_read_with_the_numbers_it_renders():
    assert markdown_text.read(STEPS).visible == (
        "1. Turn off the main valve\n2. Open the lowest tap\n3. Wait for Maria\n4. Keep the area dry\n")
    # a list renders its numbers from its start, whatever its other markers say
    assert markdown_text.read("1. a\n1. b\n1. c").visible == "1. a\n2. b\n3. c\n"
    assert markdown_text.read("3. a\n1. b").visible == "3. a\n4. b\n"
    assert markdown_text.read("01. a\n02. b").visible == "1. a\n2. b\n"
    assert markdown_text.read("100. dollars").visible == "100. dollars\n"
    # a new delimiter starts a new list, here at 500; a list in a quote or a bullet renders its numbers too
    assert markdown_text.read("1. a\n500) b").visible == "1. a\n500. b\n"
    assert markdown_text.read("> 2. a\n- 7) b").visible == "2. a\n7. b\n"
    eleven = "\n".join(f"{n}. step" for n in range(1, 12))
    assert markdown_text.read(eleven).visible == "".join(f"{n}. step\n" for n in range(1, 12))


ELEVEN_STEPS = "\n".join(f"{n}. Check the next fitting" for n in range(1, 12))


@pytest.mark.parametrize(("prose", "rule_ids"), [
    # what the raw text already shows, formatted
    ("The visit is **$100**.", {"currency", "digit"}),
    ("| Service | Price |\n|---|---|\n| Drain | $180 |", {"currency", "digit"}),
    ("- Free inspection\n- Photos of the work", {"lex.en.promise"}),
    ("# Free estimates", {"lex.en.promise"}),
    ("[Free estimate](https://riveraplumbing.example)", {"lex.en.promise"}),
    ("It's `$100` for the visit.", {"currency", "digit"}),
    # numbers stay refused in every Markdown form, list markers included
    (STEPS, {"digit"}),
    ("100. dollars", {"digit", "lex.en.money"}),
    ("1. Drain the tank\n500) Refill it", {"digit"}),
    (ELEVEN_STEPS, {"digit"}),
    # what only the rendered text shows
    ("You get a fr*ee* inspection.", {"lex.en.promise"}),
    ("You get a _free_ inspection.", {"lex.en.promise"}),
    ("You get a __free__ inspection.", {"lex.en.promise"}),
    ("The work is gu**aran**teed.", {"lex.en.promise"}),
    ("Take &dollar;50 off.", {"currency", "digit"}),
    ("You get a fr&#101;e inspection.", {"lex.en.promise"}),
    ("Save 10&percnt; on it.", {"digit", "percent_sign"}),
    ("&#xbd; the deposit comes back.", {"digit"}),
])
async def test_formatting_hides_no_claim_from_the_scan(app, client, prose, rule_ids):
    copy, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, prose)
    assert verdict.ok is False
    assert rule_ids <= {violation.rule_id for violation in verdict.violations}, verdict.violations
    assert [block.template for block in verdict.blocks] == ["handoff"]      # none of the prose is shown
