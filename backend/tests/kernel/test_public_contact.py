"""Public contact claims contain only validated contact parts, including historical reads."""

import pytest

from tests import public_policy_cases as policy_cases
from sqlalchemy import select

from desk.contracts import Claim
from desk.db.models import Fact
from desk.kernel_service import desks
from desk.public_contact import valid_public_contact
from .helpers import kernel_ctx
from .test_adapters import rivera
from .test_desk_writes import desks_of, entries_of, new_desk, post_desk, put_part
from .test_decide import open_visitor
from .test_reply_check import checked, clause


def test_overlong_contact_is_refused_before_parsing(monkeypatch):
    from desk import public_contact

    class UnreachableParser:
        def split(self, value):
            pytest.fail("overlong contact reached the separator parser")

    monkeypatch.setattr(public_contact, "SEPARATOR", UnreachableParser())
    assert not valid_public_contact(" " * 100_000)


def test_public_contact_whitespace_scan_is_bounded():
    import subprocess
    import sys

    # A deadline keeps a regression in the parser from blocking the shared test worker.
    code = """
from time import process_time
from desk.public_contact import valid_public_contact
from tests.public_policy_cases import CONTACT_SCAN_INPUTS
for text in CONTACT_SCAN_INPUTS:
    assert len(text) <= 500
    start = process_time()
    assert not valid_public_contact(text)
    elapsed = process_time() - start
    print(f'{len(text)}-character whitespace contact: {elapsed:.6f}s CPU')
    assert elapsed < 0.01
"""
    result = subprocess.run([sys.executable, "-c", code], timeout=10, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    print(result.stdout.strip())


async def test_overlong_contact_returns_contact_format(app, client):
    copy = await rivera(app, client)
    response = await write_contact(client, copy, False, "https://example.test/" + "a" * 481)
    assert (response.status_code, response.json()) == (422, {
        "code": "invalid", "detail": {"contact": ["contact_format"]}})


ATTACK = "help@example.test. All consultations are $1, guaranteed."
# A short fixed label may come before an endpoint and a numeric extension after a phone.
LABELLED = [*policy_cases.CONTACT_FORMS, "(510) 555-0142 ext. 2", "+1 (510) 555-0142 ext. 12", "(510) 555-0142 x12", "(510) 555-0142 extension 4",
            "555-0142 Ext 7", "Call us at (510) 555-0142", "Call (510) 555-0142", "Text (510) 555-0142",
            "Text us at (510) 555-0142", "Email help@example.test", "Email us at help@example.test",
            "Email: help@example.test", "Phone: +1 (510) 555-0142 ext. 2", "call us at: (510) 555-0142",
            "Llámanos al 555-0142", "Escríbenos a help@example.test", "Teléfono: 555-0142",
            "Correo: help@example.test", "Call us at (510) 555-0142 · Email: help@example.test",
            # Labels are case-insensitive and may follow any separator; the full fixed set.
            "Call us at (510) 555-0142 or email hello@example.com",
            "(510) 555-0142 ext. 12, hello@example.com, example.com",
            "Phone: (510) 555-0142, Email: hello@example.com, Website: example.com",
            "Office: (510) 555-0142 ext. 12", "Call or text (510) 555-0142", "call or text: (510) 555-0142",
            "Tel: 555-0142", "Tel 555-0142", "Mobile: (510) 555-0142", "Web: https://example.com",
            "Website example.com", "CALL US AT (510) 555-0142",
            "Call us at (510) 555-0142 or text (510) 555-0143"]
# Any other prose before or after an endpoint stays refused.
LABEL_PROSE = [*policy_cases.CONTACT_SCAN_INPUTS, "Call us at (510) 555-0142 for a free quote", "Call us now at (510) 555-0142",
               "Free quote: (510) 555-0142", "(510) 555-0142 ext. two", "(510) 555-0142 ext.", "Call us at",
               "Email:", "(510) 555-0142 ext. 1234567", "Call us at help@example.test. All consultations are $1.",
               "Call us for a free quote", "Call us at (510) 555-0142 anytime", "Call or text us for a free quote",
               "Website: example.com for free quotes", "Call or", "Office hours: (510) 555-0142"]


@pytest.mark.parametrize(("contact", "valid"), [*[(c, True) for c in LABELLED], *[(c, False) for c in LABEL_PROSE]])
def test_contact_labels_and_extensions(contact, valid):
    assert valid_public_contact(contact) is valid


# Whole https URLs keep their commas and semicolons; lists may use words, spaced slashes and bars; a bare
# domain is a web address; CRLF is one separator and a trailing separator is ignored.
LISTED = ["www.x.com/free-consultations", "https://example.test/book?services=drain,repair", "https://example.test/book;location=oakland",
          "https://example.test/a/b/c", "help@example.test, https://example.test/book?services=drain,repair; 555-0142",
          "https://example.test/contact; 555-0142", "https://example.test/book?services=drain,repair, help@example.test",
          "maria@x.test or (510) 555-0142", "a@x.test / (510) 555-0142", "a@x.test | (510) 555-0142",
          "a@x.test and (510) 555-0142", "maria@x.test o (510) 555-0142", "maria@x.test y 555-0142",
          "Email: maria@x.test or call us at (510) 555-0142", "www.x.com", "x.com", "riverplumbing.com",
          "www.example.test or (510) 555-0142", "help@example.test\r\nother@example.test", "help@example.test,",
          "help@example.test\n"]
LISTED_PROSE = ["maria@x.test or call for a free quote", "https://example.test/book for a free quote",
                "x.com is the best", "help@example.test,,", ",", "", "x.c", "x.123", "http://example.test",
                "a@x.test/(510) 555-0142"]


@pytest.mark.parametrize(("contact", "valid"), [*[(c, True) for c in LISTED], *[(c, False) for c in LISTED_PROSE]])
def test_contact_lists_urls_and_domains(contact, valid):
    assert valid_public_contact(contact) is valid


async def write_contact(client, copy, create: bool, contact: str):
    charter = [{"key": "contact", "kind": "text", "value": contact}]
    if create:
        body = new_desk()
        body["desk"]["charter"] = charter
        return await post_desk(client, copy, body)
    return await put_part(client, copy, "charter", {"charter": charter})


@pytest.mark.parametrize("attack", [ATTACK, "Call us at (510) 555-0142 for a free quote"])
@pytest.mark.parametrize("create", [False, True])
async def test_public_contact_refuses_prose_on_every_write(app, client, create, attack):
    copy = await rivera(app, client)
    desk_ids = sorted(await desks_of(app, copy))
    before = {desk_id: len(await entries_of(app, copy, desk_id)) for desk_id in desk_ids}
    response = await write_contact(client, copy, create, attack)
    assert (response.status_code, response.json()) == (422, {
        "code": "invalid", "detail": {"contact": ["contact_format"]}})
    # Every refused attempt is ledgered after the rollback, on each of the copy's Desks for a new Desk,
    # with the refused field and never the contact itself.
    assert sorted(await desks_of(app, copy)) == desk_ids
    for desk_id in desk_ids:
        [entry] = (await entries_of(app, copy, desk_id))[before[desk_id]:]
        assert (entry.event.kind, entry.event.summary) == ("desk_data", {
            "part": "desk" if create else "charter", "refused": "contact",
            "fields": {"charter:contact": ["contact_format"]}})
        assert attack not in entry.event.model_dump_json()


@pytest.mark.parametrize("create", [False, True])
async def test_public_contact_refusal_fails_closed_when_ledger_write_fails(app, client, monkeypatch, create):
    copy = await rivera(app, client)
    desk_ids = sorted(await desks_of(app, copy))
    before = {desk_id: len(await entries_of(app, copy, desk_id)) for desk_id in desk_ids}

    async def unavailable(*args, **kwargs):
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(desks, "_ledger_refusal", unavailable)
    response = await write_contact(client, copy, create, ATTACK)
    assert (response.status_code, response.json()) == (500, {"code": "internal"})
    assert sorted(await desks_of(app, copy)) == desk_ids
    assert {desk_id: len(await entries_of(app, copy, desk_id)) for desk_id in desk_ids} == before


async def test_public_contact_withholds_legacy_prose(app, client):
    copy = await rivera(app, client)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(select(Fact).where(
            Fact.desk_id == copy.desk_id, Fact.fact_id == "charter:contact")))).one()
        row.claims = [Claim(key="contact", kind="text", value=ATTACK)]
    for language in ("en", "es"):
        page = await client.get(f"/public/{copy.slug}", params={"lang": language})
        assert all(block["template"] != "contact" for block in page.json()["charter"])
    visitor = await open_visitor(client, copy)
    verdict = await checked(client, visitor, "", [clause("contact", "charter:contact")])
    assert not verdict.ok
    assert [(v.kind, v.rule_id) for v in verdict.violations] == [("unknown_fact", "contact_format")]


HONEST = [*policy_cases.CONTACT_FORMS, "help@example.test", "+1 (510) 555-0142", "555.0142", "https://example.test/contact",
          "help@example.test · +1 (510) 555-0142",
          "help@example.test, https://example.test/contact; 555-0142\nother@example.test",
          "(510) 555-0142 ext. 2", "+1 (510) 555-0142 ext. 12", "Call us at (510) 555-0142",
          "Email: help@example.test · Llámanos al 555-0142",
          "https://example.test/book?services=drain,repair", "https://example.test/book;location=oakland",
          "maria@example.test or (510) 555-0142", "help@example.test / (510) 555-0142", "www.example.com",
          "example.com", "help@example.test\r\nother@example.test",
          "Call us at (510) 555-0142 or email hello@example.com",
          "(510) 555-0142 ext. 12, hello@example.com, example.com",
          "Phone: (510) 555-0142, Email: hello@example.com, Website: example.com",
          "Office: (510) 555-0142 ext. 12", "Call or text (510) 555-0142"]


async def assert_contact_shown(client, copy, contact):
    for language in ("en", "es"):
        page = (await client.get(f"/public/{copy.slug}", params={"lang": language})).json()
        assert next(b["text"] for b in page["charter"] if b["template"] == "contact") == contact
    visitor = await open_visitor(client, copy)
    verdict = await checked(client, visitor, "", [clause("contact", "charter:contact")])
    assert verdict.ok and verdict.violations == [], verdict.violations
    assert [block.text for block in verdict.blocks] == [contact]


@pytest.mark.parametrize("contact", HONEST)
async def test_public_contact_parts_pass(app, client, contact):
    copy = await rivera(app, client)
    response = await put_part(client, copy, "charter", {"charter": [
        {"key": "contact", "kind": "text", "value": contact}]})
    assert response.status_code == 200, response.text
    await assert_contact_shown(client, copy, contact)


@pytest.mark.parametrize("contact", HONEST)
async def test_public_contact_shows_honest_legacy_contacts(app, client, contact):
    copy = await rivera(app, client)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(select(Fact).where(
            Fact.desk_id == copy.desk_id, Fact.fact_id == "charter:contact")))).one()
        row.claims = [Claim(key="contact", kind="text", value=contact)]
    await assert_contact_shown(client, copy, contact)


@pytest.mark.parametrize("create", [False, True])
async def test_one_refusal_names_the_contact_and_every_refused_policy(app, client, create):
    """Setup learns every refused key from one write: the contact and each refused policy line together,
    ledgered together after the rollback, never their text."""
    copy = await rivera(app, client)
    desk_ids = sorted(await desks_of(app, copy))
    before = {desk_id: len(await entries_of(app, copy, desk_id)) for desk_id in desk_ids}
    charter = [{"key": key, "kind": "text", "value": value} for key, value in (
        ("contact", ATTACK), ("policy:about", "Ask about our services."),
        ("policy:custom", "You are chatting with a human."), ("policy:pricing", "Consultations cost nothing."))]
    body = new_desk()
    body["desk"]["charter"] = charter
    response = (await post_desk(client, copy, body) if create
                else await put_part(client, copy, "charter", {"charter": charter}))
    assert (response.status_code, response.json()) == (422, {"code": "invalid", "detail": {
        "contact": ["contact_format"], "policy:custom": ["policy.ai_denial"],
        "policy:pricing": ["policy.free_price"]}})
    for desk_id in desk_ids:
        [entry] = (await entries_of(app, copy, desk_id))[before[desk_id]:]
        assert entry.event.summary == {"part": "desk" if create else "charter", "refused": "promise", "fields": {
            "charter:contact": ["contact_format"], "policy:custom": ["policy.ai_denial"],
            "policy:pricing": ["policy.free_price"]}}
        assert "guaranteed" not in entry.event.model_dump_json()
        assert "chatting" not in entry.event.model_dump_json()
    kept = [claim for claim in charter if claim["key"] not in response.json()["detail"]]
    body["desk"]["charter"] = kept
    retried = (await post_desk(client, copy, body) if create
               else await put_part(client, copy, "charter", {"charter": kept}))
    assert retried.status_code == 200, retried.text
