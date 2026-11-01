"""The reply check on Markdown prose: the chats render Claude's prose as Markdown (the owner's decision
of 2026-11-01), so the kernel scans what a visitor sees as well as the raw text.

Formatting can't hide a price, date, discount or promise from the scan, and every number stays
refused but the markers of a numbered list of up to nine steps from 1; honest bullets, bold,
headings and tables without numbers pass; every link a reader can click, shown or hidden, must go
to the business's own contact; images are refused.
"""

import pytest

from desk import markdown_text, public_contact
from desk.contracts import RenderedBlock
from desk.kernel_service import reply_check

from .test_adapters import visitor_of
from .test_reply_check import assert_kept, change_fact, checked, clause, own_quote

STEPS = "1. Turn off the main valve\n2. Open the lowest tap\n3. Wait for Maria\n4. Keep the area dry"
# The business's contact as its owner might write it: a phone, an email and a website, in its accepted form.
RIVERA_CONTACT = "Call (510) 555-0142 · Email: maria@riveraplumbing.example · Website: www.riveraplumbing.example"


async def with_contact(app, copy, contact: str = RIVERA_CONTACT) -> None:
    await change_fact(app, copy, "charter:contact", claims=[{"key": "contact", "kind": "text", "value": contact}])


def found(verdict) -> list[tuple[str, str, str]]:
    return [(violation.kind, violation.rule_id, violation.span) for violation in verdict.violations]


def test_a_list_from_one_of_at_most_nine_items_shows_no_number_to_scan():
    """The owner's decision of 2026-11-01: a numbered list of steps passes. A list that starts at 1
    and has at most nine items shows only 1 to 9: its numbers are left out of the visible reading,
    and its typed markers are blanked from the raw one, wherever its lines put them."""
    read = markdown_text.read(STEPS)
    assert read.visible == "Turn off the main valve\nOpen the lowest tap\nWait for Maria\nKeep the area dry\n"
    assert read.list_markers == ((0, 2), (27, 29), (50, 52), (68, 70))
    assert markdown_text.blank_list_markers(STEPS) == (
        "   Turn off the main valve\n   Open the lowest tap\n   Wait for Maria\n   Keep the area dry")
    assert markdown_text.read("1) a\n2) b").list_markers == ((0, 2), (5, 7))
    assert markdown_text.read("> 1. a\n> 2. b").list_markers == ((2, 4), (9, 11))      # in a quote
    assert markdown_text.read("- 1. a\n- 1) b").list_markers == ((2, 4), (9, 11))      # after bullets
    assert markdown_text.read("1. 1. a").list_markers == ((0, 2), (3, 5))              # one in another
    assert markdown_text.read("1. a\r\n2. b").list_markers == ((0, 2), (6, 8))
    assert markdown_text.read("01. a\n02. b").list_markers == ((0, 3), (6, 9))       # renders 1 and 2
    nine = markdown_text.read("\n".join("1. step" for _ in range(9)))
    assert (nine.visible, len(nine.list_markers)) == ("step\n" * 9, 9)


@pytest.mark.parametrize(("prose", "visible"), [
    ("5. Call us", "5. Call us\n"),                        # a list that starts at 5
    ("0. a", "0. a\n"),
    ("100. dollars", "100. dollars\n"),
    ("8. a\n1. b\n1. c", "8. a\n9. b\n10. c\n"),           # numbered from its start, whatever is typed
    ("\n".join("1. step" for _ in range(10)), "".join(f"{n}. step\n" for n in range(1, 11))),   # ten items
    ("> 12. a\n- 70) b", "12. a\n70. b\n"),
    ("Turn off the valve and wait\n3. hours later", "Turn off the valve and wait\n3. hours later\n"),  # no list
    ("```\n1. a\n```", "1. a\n"),                           # code, not a list
])
def test_every_other_list_and_digit_shows_its_numbers(prose, visible):
    read = markdown_text.read(prose)
    assert (read.visible, read.list_markers) == (visible, ())
    assert markdown_text.blank_list_markers(prose) == prose


def test_a_new_delimiter_starts_a_list_judged_on_its_own():
    read = markdown_text.read("1. a\n\n10) b")                 # the second list starts at 10
    assert (read.visible, read.list_markers) == ("a\n10. b\n", ((0, 2),))


def test_raw_html_is_left_out_of_the_visible_reading_as_a_renderer_without_it_drops_it():
    """A renderer without raw HTML drops it, so a tag inside a word joins its letters, a comment
    shows nothing, an HTML block shows nothing, and a link or image written in HTML is neither. The
    raw reading, what an escaping renderer shows, still scans every character."""
    assert markdown_text.read("fr<b></b>ee").visible == "free\n"
    assert markdown_text.read("Call <!-- note --> us").visible == "Call  us\n"
    assert markdown_text.read("<div>\n$100\n</div>").visible == ""
    html_link = markdown_text.read('<a href="https://elsewhere.example">Our reviews</a> are kind.')
    assert (html_link.visible, html_link.links) == ("Our reviews are kind.\n", ())
    assert markdown_text.read('<img src="https://elsewhere.example/a.png"> Here.').images is False


ELEVEN_STEPS = "\n".join(f"{n}. Check the next fitting" for n in range(1, 12))
TEN_ONES = "\n".join("1. Check the next fitting" for _ in range(10))     # renders 1 to 10
NINE_STEPS = "\n".join(f"{n}. Check the next fitting" for n in range(1, 10))


@pytest.mark.parametrize("prose", [
    "1. a\n2. b\n3. c",
    "1) a\n2) b",
    "1. Turn off the valve\n2. Open a faucet",
    STEPS,
    NINE_STEPS,
    "  1. Turn off the valve\n  2. Open a faucet",
    "To stop the leak:\n\n1. Turn off the main valve\n2. Open the lowest tap\n\nMaria looks at it when she's there.",
    "Before Maria gets there:\n1. Turn off the main valve\n   - It is under the sink\n2. Keep the area dry",
])
async def test_a_numbered_list_from_one_to_nine_passes_by_the_owners_decision(app, client, prose):
    """The owner's decision of 2026-11-01: the markers of an ordered list that starts at 1 and has at
    most nine items are no number in Claude's prose."""
    copy, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, prose)
    assert (verdict.ok, verdict.violations) == (True, [])
    assert verdict.blocks == [RenderedBlock(kind="prose", text=prose)]


@pytest.mark.parametrize(("prose", "span"), [
    ("5. Call us", "5"),                       # a list that starts at 5
    ("3. Turn off the valve", "3"),
    ("10. Turn off the valve", "10"),
    ("0. Turn off the valve", "0"),
    ("0. a", "0"),
    (ELEVEN_STEPS, "10"),
    (TEN_ONES, "10"),                          # typed "1." each, it shows 1 to 10
    ("1. a\n\n10) b", "10"),                   # a new delimiter starts a new list, at 10
    ("Maria can be there in 5 days.", "5"),
    ("Step 1. Turn off the valve", "1"),       # not at a line start
    ("1.5 hours is all it takes.", "1.5"),
    ("1. Turn off the valve\n2. Wait 3 hours", "3"),
    ("Turn off the valve and wait\n3. hours later it is dry", "3"),   # a line, not a list: it shows mid-sentence
    ("```\n1. Turn off the valve\n```", "1"),                          # code shows its digits
])
async def test_every_other_number_stays_blocked(app, client, prose, span):
    copy, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, prose)
    assert verdict.ok is False
    assert ("number_in_prose", "digit", span) in found(verdict)


@pytest.mark.parametrize(("prose", "rule_ids"), [
    # what the raw text already shows, formatted
    ("The visit is **$100**.", {"currency", "digit"}),
    ("| Service | Price |\n|---|---|\n| Drain | $180 |", {"currency", "digit"}),
    ("- Free inspection\n- Photos of the work", {"lex.en.promise"}),
    ("# Free estimates", {"lex.en.promise"}),
    ("[Free estimate](https://riveraplumbing.example)", {"lex.en.promise"}),
    ("It's `$100` for the visit.", {"currency", "digit"}),
    # numbers stay refused in every Markdown form but list numbers 1 to 9
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
    ("You get a fr<b></b>ee inspection.", {"lex.en.promise"}),        # a renderer may drop the tags
    ("You get a fr~ee~ inspection.", {"lex.en.promise"}),              # GFM strikes single tildes through
    ("You get a fr~~ee~~ inspection.", {"lex.en.promise"}),
    # what the raw text shows inside a tag the chats drop
    ("<span>$100</span> for the visit.", {"currency", "digit"}),
    ("<div>\n$100 for the visit\n</div>", {"currency", "digit"}),
])
async def test_formatting_hides_no_claim_from_the_scan(app, client, prose, rule_ids):
    copy, visitor = await visitor_of(app, client)
    verdict = await checked(client, visitor, prose)
    assert verdict.ok is False
    assert rule_ids <= {violation.rule_id for violation in verdict.violations}, verdict.violations
    assert [block.template for block in verdict.blocks] == ["handoff"]      # none of the prose is shown


def test_struck_through_text_is_still_read_with_one_tilde_or_two():
    """The chats' renderer (remark-gfm) strikes text through between one tilde or two; a reader still
    reads it."""
    assert markdown_text.read("fr~ee~ and ~~fr~~ee").visible == "free and free\n"


def test_titles_and_alt_text_are_read_after_the_body_so_they_split_no_word():
    read = markdown_text.read('You get a [fr](https://r.example "details")ee ![x](https://r.example/a.png "t") visit.')
    assert read.visible == "You get a free  visit.\ndetails\nx\nt\n"


async def test_a_link_title_splits_no_word_from_the_scan(app, client):
    copy, visitor = await visitor_of(app, client)
    await with_contact(app, copy)
    verdict = await checked(client, visitor, 'You get a [fr](https://riveraplumbing.example "details")ee inspection.')
    assert verdict.ok is False
    assert ("promise_word", "lex.en.promise", "free") in found(verdict)


async def test_html_an_escaping_renderer_shows_is_caught_by_the_raw_reading(app, client):
    """A renderer that escapes raw HTML shows the prose as written, tags and all: that is the raw
    reading, so its number is the raw scan's."""
    copy, visitor = await visitor_of(app, client)
    prose = "Call <b>us</b> for <i>$100</i>"
    verdict = await checked(client, visitor, prose)
    raw = reply_check.scan_prose(prose)
    assert verdict.ok is False and {"currency", "digit"} <= {violation.rule_id for violation in raw}
    assert [v for v in verdict.violations if v.kind == "number_in_prose"] == [
        v for v in raw if v.kind == "number_in_prose"]


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
async def test_a_markdown_link_must_go_to_the_business_contact(app, client, prose, span):
    copy, visitor = await visitor_of(app, client)
    await with_contact(app, copy)
    verdict = await checked(client, visitor, prose)
    assert verdict.ok is False
    assert ("promise_word", "markdown.link", span) in found(verdict)


@pytest.mark.parametrize(("prose", "span"), [
    ("See https://elsewhere.example for reviews.", "https://elsewhere.example"),
    ("See http://riveraplumbing.example for photos.", "http://riveraplumbing.example"),     # https only
    ("See www.riveraplumbing.example.evil.example for photos.", "www.riveraplumbing.example.evil.example"),
    ("See www.elsewhere.example/rivera for reviews.", "www.elsewhere.example/rivera"),
    ("Write to someone@elsewhere.example about it.", "someone@elsewhere.example"),
    ("Run `curl https://elsewhere.example/pay` to pay.", "https://elsewhere.example/pay"),   # in code too
    ("Reviews: <https://elsewhere.example>", "https://elsewhere.example"),
    ("Write to <someone@elsewhere.example>.", "someone@elsewhere.example"),
    ("See [https://elsewhere.example/rivera](https://elsewhere.example/rivera).", "https://elsewhere.example/rivera"),
    ("See [our site](https://riveraplumbing.example) or https://riverap1umbing.example.",   # a lookalike
     "https://riverap1umbing.example"),
])
async def test_every_clickable_link_must_go_to_the_business_contact(app, client, prose, span):
    """The owner's decision of 2026-11-01: every link a reader can click, shown or hidden, goes to
    the business's public contact. The chats autolink a URL with a scheme or "www." and a bare
    email address, as GFM does, so each is held to the contact too."""
    copy, visitor = await visitor_of(app, client)
    await with_contact(app, copy)
    verdict = await checked(client, visitor, prose)
    assert verdict.ok is False
    assert ("promise_word", "markdown.link", span) in found(verdict)


TABLE = "| Service | Notes |\n|---|---|\n"


async def test_a_cell_past_the_header_is_read_as_the_chats_show_it(app, client):
    """markdown-it drops a row's cells past its header's width, but the chats' renderer shows them,
    so each table's lines are read whole too."""
    copy, visitor = await visitor_of(app, client)
    await with_contact(app, copy)
    verdict = await checked(client, visitor, f"{TABLE}| Drain | Fast | You get a fr*ee* inspection |")
    assert verdict.ok is False and ("promise_word", "lex.en.promise", "free") in found(verdict)
    verdict = await checked(client, visitor, f"{TABLE}| Drain | Fast | [pay](https://elsewhere.example/pay) |")
    assert verdict.ok is False and ("promise_word", "markdown.link", "pay") in found(verdict)


@pytest.mark.parametrize(("prose", "span"), [
    ("Thanks for asking.\n\n[unused]: https://elsewhere.example/pay", "https://elsewhere.example/pay"),
    ('<a href="https://elsewhere.example/pay">Our reviews</a> are kind.', 'https://elsewhere.example/pay">Our'),
    ("Write to <!-- someone@elsewhere.example --> us.", "someone@elsewhere.example"),
])
async def test_a_url_or_email_written_anywhere_in_the_prose_is_held_to_the_contact(app, client, prose, span):
    """Defence in depth: the raw prose is read for URLs and email addresses too, so one the visible
    reading doesn't show (a reference never used, HTML a renderer drops) is still held to the contact."""
    copy, visitor = await visitor_of(app, client)
    await with_contact(app, copy)
    verdict = await checked(client, visitor, prose)
    assert verdict.ok is False and ("promise_word", "markdown.link", span) in found(verdict)


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
    "Book online at https://riveraplumbing.example/book any time.",
    "Photos of her past jobs are at www.riveraplumbing.example.",
    "Photos are at https://WWW.riveraplumbing.example/photos (or www.riveraplumbing.example).",
    "You can write to maria@riveraplumbing.example about it.",
    "You can write to MARIA@RiveraPlumbing.example about it.",
    "The forms are on irs.gov if you need them.",                    # no scheme or www.: no link
    "Pay for it at riveraplumbing.example/pay when you're ready.",
    "Call <!-- note --> us about it.",
    "Turn off the main valve.<br>Keep the area dry until Maria gets there.",
])
async def test_honest_formatting_and_the_business_own_links_pass(app, client, prose):
    copy, visitor = await visitor_of(app, client)
    await with_contact(app, copy)
    verdict = await checked(client, visitor, prose)
    assert (verdict.ok, found(verdict)) == (True, [])
    assert verdict.blocks == [RenderedBlock(kind="prose", text=prose)]


def test_the_links_the_chats_make_of_plain_text_are_read_as_links():
    """GFM links a URL with a scheme or "www." (here read as https) and an email address, without the
    punctuation a sentence puts after it; a domain alone isn't a link."""
    links = markdown_text.literal_links(
        "Visit www.rivera.example. Or (https://pay.example/a?b=1), or write to maria@rivera.example.\n"
        "See irs.gov, http://rivera.example/x@y.example and www.code.example!")
    assert [(link.text, link.href) for link in links] == [
        ("www.rivera.example", "https://www.rivera.example"),
        ("https://pay.example/a?b=1", "https://pay.example/a?b=1"),
        ("http://rivera.example/x@y.example", "http://rivera.example/x@y.example"),
        ("www.code.example", "https://www.code.example"),
        ("maria@rivera.example", "mailto:maria@rivera.example")]


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


async def test_prose_the_parser_cannot_read_whole_is_refused(app, client, monkeypatch):
    """Prose nested deeper than the parser follows loses text from its reading, and any parser error
    leaves none: either is refused as `markdown.parse`, and its list markers stay in the raw scan."""
    copy, visitor = await visitor_of(app, client)
    deep = ">" * 25 + " Turn off the main valve."
    verdict = await checked(client, visitor, deep)
    assert verdict.ok is False and ("promise_word", "markdown.parse", reply_check.shown(deep)[:40]) in found(verdict)

    def broken(text: str):
        raise RuntimeError("the parser failed")

    monkeypatch.setattr(markdown_text, "read", broken)
    verdict = await checked(client, visitor, "1. Turn off the main valve\n2. Keep the area dry")
    assert verdict.ok is False
    assert [(kind, rule_id) for kind, rule_id, _ in found(verdict)] == [
        ("number_in_prose", "digit"), ("number_in_prose", "digit"), ("promise_word", "markdown.parse")]


@pytest.mark.parametrize(("prose", "spans"), [
    # the link by its text, and its URL as the raw prose writes it
    ("Here is your quote, and you can [pay here](https://elsewhere.example/pay).",
     ["pay here", "https://elsewhere.example/pay"]),
    ("Here is your quote. Reviews are at https://elsewhere.example/reviews.", ["https://elsewhere.example/reviews"]),
])
async def test_a_cited_card_is_kept_when_only_a_link_in_the_prose_fails(app, client, prose, spans):
    """A link to a site the contact doesn't name is a failure of Claude's own words: the checked card
    it cited is still shown, without the prose."""
    copy, visitor = await visitor_of(app, client)
    quote = await own_quote(client, visitor)
    verdict = await checked(client, visitor, prose, [clause("quote", quote.fact_id)])
    assert_kept(verdict, [("quote", quote.fact_id)])
    assert found(verdict) == [("promise_word", "markdown.link", span) for span in spans]
