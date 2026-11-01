"""Public contact claims contain only validated contact parts, including historical reads."""

import pytest
from sqlalchemy import select

from desk.contracts import Claim
from desk.db.models import Fact
from .helpers import kernel_ctx
from .test_adapters import rivera
from .test_desk_writes import new_desk, post_desk, put_part
from .test_decide import open_visitor
from .test_reply_check import checked, clause

ATTACK = "help@example.test. All consultations are $1, guaranteed."


@pytest.mark.parametrize("create", [False, True])
async def test_public_contact_refuses_prose_on_every_write(app, client, create):
    copy = await rivera(app, client)
    charter = [{"key": "contact", "kind": "text", "value": ATTACK}]
    if create:
        body = new_desk()
        body["desk"]["charter"] = charter
        response = await post_desk(client, copy, body)
    else:
        response = await put_part(client, copy, "charter", {"charter": charter})
    assert (response.status_code, response.json()) == (422, {
        "code": "invalid", "detail": {"contact": ["contact_format"]}})


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


@pytest.mark.parametrize("contact", ["help@example.test", "+1 (510) 555-0142", "555.0142",
    "https://example.test/contact", "help@example.test · +1 (510) 555-0142",
    "help@example.test, https://example.test/contact; 555-0142\nother@example.test"])
async def test_public_contact_parts_pass(app, client, contact):
    copy = await rivera(app, client)
    response = await put_part(client, copy, "charter", {"charter": [
        {"key": "contact", "kind": "text", "value": contact}]})
    assert response.status_code == 200, response.text
    page = (await client.get(f"/public/{copy.slug}")).json()
    assert next(b["text"] for b in page["charter"] if b["template"] == "contact") == contact
