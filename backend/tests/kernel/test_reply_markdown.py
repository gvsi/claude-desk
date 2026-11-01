"""The reply check on Markdown prose: the chats render Claude's prose as Markdown (the owner's decision
of 2026-11-01), so the kernel scans what a visitor sees as well as the raw text.

Formatting can't hide a price, date, discount or promise from the scan, and numbers stay refused in
every Markdown form, list markers included; honest bullets, bold, headings, tables without numbers and
links to the business's own site pass; a link's target must be the business's own contact; images are
refused.
"""

import pytest

from desk import public_contact
from desk.contracts import RenderedBlock
from desk.kernel_service import markdown_text

from .test_adapters import visitor_of
from .test_reply_check import change_fact, checked

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


# The business's contact as its owner might write it: a phone, an email and a website, in its accepted form.
RIVERA_CONTACT = "Call (510) 555-0142 · Email: maria@riveraplumbing.example · Website: www.riveraplumbing.example"


async def with_contact(app, copy, contact: str = RIVERA_CONTACT) -> None:
    await change_fact(app, copy, "charter:contact", claims=[{"key": "contact", "kind": "text", "value": contact}])


def found(verdict) -> list[tuple[str, str, str]]:
    return [(violation.kind, violation.rule_id, violation.span) for violation in verdict.violations]


@pytest.mark.parametrize(("prose", "span"), [
    ("[Pay here](https://elsewhere.example/pay) for the visit.", "Pay here"),
    ("Here is our [site](javascript:alert)", "site"),
    ("See [our photos](https://riveraplumbing.example.evil.example).", "our photos"),   # the host must match
    ("See [our photos](https://evil.example/riveraplumbing.example).", "our photos"),
    ("See [our photos](https://riveraplumbing.example@evil.example).", "our photos"),
    ("See [our photos](http://riveraplumbing.example).", "our photos"),                # https only
    ("See [our photos](ftp://riveraplumbing.example).", "our photos"),
    ("Read [this page](/pay) first.", "this page"),
    ("[riveraplumbing.example](https://elsewhere.example)", "riveraplumbing.example"),
    ("[Write to us](mailto:someone@elsewhere.example)", "Write to us"),
    ("[Write to us](mailto:maria@riveraplumbing.example.evil.example)", "Write to us"),
    ("[Our page][page] has the details.\n\n[page]: https://elsewhere.example", "Our page"),
    ("Everything is on [the page about the visit and what to bring along](https://elsewhere.example).",
     "the page about the visit and what to bri"),
])
async def test_a_link_hiding_its_target_must_go_to_the_business_contact(app, client, prose, span):
    copy, visitor = await visitor_of(app, client)
    await with_contact(app, copy)
    verdict = await checked(client, visitor, prose)
    assert verdict.ok is False
    assert ("promise_word", "markdown.link", span) in found(verdict)


@pytest.mark.parametrize("prose", [
    "- Turn off the main valve\n- Open the lowest tap\n- Keep the area dry until Maria gets there",
    "* Turn off the main valve\n* Keep the area dry until Maria gets there",
    "**Service call deposit**\n\nMaria credits it to the repair if you go ahead with it.",
    "## What to do now\n\nTurn off the main valve and keep the area dry.",
    "| Service | What it covers |\n|---|---|\n| Drain clearing | Kitchen and bathroom drains |",
    "Photos of her past jobs are on [our website](https://riveraplumbing.example).",
    "Photos of her past jobs are on [our website](https://www.riveraplumbing.example/photos).",
    "Photos of her past jobs are on [our website](HTTPS://RiveraPlumbing.Example/photos).",
    "Photos of her past jobs are at https://riveraplumbing.example and on the way.",
    "Photos of her past jobs are at <https://riveraplumbing.example>.",
    "You can also [email Maria](mailto:maria@riveraplumbing.example) about it.",
    "You can also write to <maria@riveraplumbing.example> about it.",
    "You can also see [https://elsewhere.example/rivera](https://elsewhere.example/rivera) for reviews.",
])
async def test_honest_formatting_and_the_business_own_links_pass(app, client, prose):
    copy, visitor = await visitor_of(app, client)
    await with_contact(app, copy)
    verdict = await checked(client, visitor, prose)
    assert (verdict.ok, found(verdict)) == (True, [])
    assert verdict.blocks == [RenderedBlock(kind="prose", text=prose)]


@pytest.mark.parametrize(("contact", "hosts", "emails"), [
    (RIVERA_CONTACT, {"riveraplumbing.example"}, {"maria@riveraplumbing.example"}),
    ("Website: https://WWW.Rivera.example/book, Email: Maria@Rivera.example",
     {"rivera.example"}, {"maria@rivera.example"}),
    ("riverapl.example/photos or https://pay.riverapl.example", {"riverapl.example", "pay.riverapl.example"}, set()),
    ("(510) 555-0142", set(), set()),
    ("Call Maria any time, she is free", set(), set()),          # not a contact: names nothing
])
def test_a_public_contact_names_its_hosts_and_emails(contact, hosts, emails):
    assert public_contact.contact_endpoints(contact) == (frozenset(hosts), frozenset(emails))


@pytest.mark.parametrize("prose", [
    "![](https://riveraplumbing.example/a.png)",
    "Here is the valve to turn: ![the valve](https://riveraplumbing.example/valve.png)",
    "[![our logo](https://riveraplumbing.example/logo.png)](https://riveraplumbing.example)",
    "![a](https://riveraplumbing.example/a.png) and ![b](https://riveraplumbing.example/b.png)",
])
async def test_an_image_is_refused_whoever_hosts_it(app, client, prose):
    copy, visitor = await visitor_of(app, client)
    await with_contact(app, copy)
    verdict = await checked(client, visitor, prose)
    assert verdict.ok is False
    assert [violation for violation in found(verdict) if violation[1].startswith("markdown.")] == [
        ("promise_word", "markdown.image", "image")]
