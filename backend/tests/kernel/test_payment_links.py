"""Payment links: a quote's single-use link to the mock checkout ("Test payment, no money moves").

`native.payment_link` takes a quote by its ID and nothing else: the amount is the quote's, priced by
the kernel, and the quote must be the session's own, on its Desk, available, unexpired and unpaid. A
quote has one open link at a time: asking again answers with it.
Executing it creates a checkout at the mock payments server (idempotency key: the action's ID) and
a link whose token opens `/pay/{token}` once within a day. The token stays in the link's row: Claude
sees the link's fact, title and amount, and the visitor sees the token only in the `href` of a
`payment_link` card. An auto-allowed link is checked again against the rules version active when it
is issued, so a rule change that lands as it runs applies to it.

Tests run on Rivera Plumbing copies as `POST /copies` seeds them (Friday 10:04 in Oakland). A test
that drafts and confirms cards needs the solver (`solver`): an auto `native.quote` card that allows
up to 10% off and an auto `native.payment_link` card up to $500, both for anyone.
"""

import asyncio
import dataclasses
import hashlib
import re
import secrets
import socket
import time
from datetime import timedelta

import httpx
import httpx2
import psycopg
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from desk.contracts import Claim, Decision, Fact, Label, PolicyVersion, Review, RuleCard
from desk.db.models import PaymentLink, Quote
from desk.db.session import database_url, libpq_url
from desk.kernel_service import adapters, compiler, execute, payments, render
from desk.kernel_api import PaymentLinkView

from .helpers import draft_and_confirm, kernel_ctx, ledger_rows, rows_of, verify_session
from .test_adapters import Rivera, objects, quote_args, rivera
from .test_agent_auth import mint, open_agent
from .test_decide import Visitor, decided, open_visitor
from .conftest import Mockpay
from .test_execute import executed, read
from .test_labels_hardening import documents
from .test_money_cap import post_draft
from .test_public_header import store_business
from .test_release_document import confirmed, violations
from .test_verification import api_rows
from .test_reply_check import assert_handed_off, checked, clause

TOOL = "native.payment_link"
QUOTES = RuleCard(card_id="quotes", applies_to="native.quote", mode="auto", who="anyone", max_discount_bp=1_000,
                  reason="Quotes from the price list, up to 10% off.")
LINKS = RuleCard(card_id="links", applies_to=TOOL, mode="auto", who="anyone", max_amount_cents=50_000,
                 reason="Payment links up to $500.")


async def test_input_schema_takes_only_a_quote(app, client):
    adapter = adapters.ADAPTERS[TOOL]
    profile = adapter.profile
    schema = profile.input_schema
    assert schema == adapter.Args.model_json_schema()
    assert objects(schema) and all(obj.get("additionalProperties") is False for obj in objects(schema))
    assert list(schema["properties"]) == ["quote_id"] and schema["required"] == ["quote_id"]
    assert (profile.source, profile.status, profile.resource_kind, profile.reversible) == (
        "native", "enabled", "quote", False)
    # the one effect Claude's profile declares is the one Cedar groups the action under
    action = compiler.desk_schema([])[""]["actions"][TOOL]
    assert profile.effects == [m["id"].removeprefix("effect:") for m in action["memberOf"]] == ["charge"]
    assert action["appliesTo"]["resourceTypes"] == ["Quote"]
    assert adapter.free_text_fields == frozenset()          # a quote ID, never the visitor's words
    assert adapter.model_view_keys == {"fact_id", "title", "amount_cents"}
    # the executed receipt the owner signed off, word for word
    assert [render.executed_status(TOOL, lang, owner="Maria Rivera") for lang in ("en", "es")] == [
        "Payment link made for this quote", "Enlace de pago creado para esta cotización"]

    copy = await rivera(app, client)
    visitor = await open_visitor(client, copy)
    # an amount, a title or anything else the schema doesn't name is refused before any action exists
    for call_id, args in (("call-1", {"quote_id": "quote-x", "amount_cents": 100}),
                          ("call-2", {"quote_id": "quote-x", "title": "Anything"}), ("call-3", {}),
                          ("call-4", {"quote_id": 7}), ("call-5", {"quote_id": "q" * 65})):
        refused = await decided(client, visitor, TOOL, args, call_id=call_id)
        assert (refused.outcome, refused.action) == ("refuse", None), args
        assert "The request wasn't in a form the tool takes" in refused.reason_plain, args


async def link_desk(client: httpx.AsyncClient, copy: Rivera) -> Rivera:
    """The copy with `QUOTES` and `LINKS` drafted and confirmed, at the seed's $500 money cap."""
    await draft_and_confirm(client, copy.owner_token, copy.desk_id, [QUOTES, LINKS])
    return copy


async def quoted(client: httpx.AsyncClient, visitor: Visitor, *items: tuple[str, int], discount_bp: int | None = None,
                 call_id: str = "call-quote") -> str:
    """The visitor's quote for `items`, decided and executed under `QUOTES`: its ID."""
    decision = await decided(client, visitor, "native.quote", quote_args(*items, discount_bp=discount_bp),
                             call_id=call_id)
    assert decision.outcome == "allow", decision.reason_plain
    return (await executed(client, visitor, decision)).model_view["quote_id"]


async def link_for(client: httpx.AsyncClient, visitor: Visitor, quote_id: str, call_id: str = "call-link") -> Decision:
    return await decided(client, visitor, TOOL, {"quote_id": quote_id}, call_id=call_id)


async def links_of(app: FastAPI, copy: Rivera) -> list[PaymentLink]:
    return await rows_of(app, copy.copy_id, select(PaymentLink).order_by(PaymentLink.created_at))


def checkouts(copy: Rivera) -> list[tuple]:
    """The copy's checkouts at the mock payments server, read as its own role: (key, amount, title,
    customer, state)."""
    with psycopg.connect(libpq_url(database_url("MOCKPAY"))) as conn:
        return conn.execute("SELECT idempotency_key, amount_cents, title, customer_id, state FROM mockpay.checkouts"
                            " WHERE copy_id = %s ORDER BY idempotency_key", (copy.copy_id,)).fetchall()


async def payment_entries(app: FastAPI, copy: Rivera) -> list[tuple[str | None, dict]]:
    return [(entry.event.session_id, entry.event.summary) for entry in await ledger_rows(app, copy)
            if entry.event.kind == "payment"]


@pytest.mark.solver
async def test_link_amount_is_the_quotes_server_price(desk_prove, app, client, frozen_clock):
    copy = await link_desk(client, await rivera(app, client))
    visitor = await open_visitor(client, copy)
    quote_id = await quoted(client, visitor, ("drain", 1), discount_bp=1_000)          # $180 less 10%
    decision = await link_for(client, visitor, quote_id)
    assert (decision.outcome, decision.card_ids, decision.policy_version) == ("allow", ["links"], 2), \
        decision.reason_plain
    action = decision.action
    assert (action.resource.kind, action.resource.id, action.amount_cents) == ("quote", quote_id, 16_200)
    assert (action.list_cents, action.discount_bp, action.effects) == (None, None, ["charge"])
    result = await executed(client, visitor, decision)

    # one link for the quote's total, for a day, to this session
    [link] = await links_of(app, copy)
    now = frozen_clock.now()
    assert (link.quote_id, link.action_id, link.session_id, link.amount_cents, link.title, link.state) == (
        quote_id, action.action_id, visitor.session_id, 16_200, "Drain clearing", "issued")
    assert (link.customer_id, link.mandate_id, link.completion_started_at) == (f"session:{visitor.session_id}",
                                                                              None, None)
    assert (link.created_at, link.updated_at, link.expires_at) == (now, now, now + timedelta(hours=24))
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", link.token)
    assert link.token_sha256 == hashlib.sha256(link.token.encode()).hexdigest()
    # and one checkout at the provider, under the action's key, for the same amount and title
    assert checkouts(copy) == [(action.action_id, 16_200, "Drain clearing", f"session:{visitor.session_id}",
                                "open")]

    # Claude gets the fact to cite, the title and the amount; the fact is the session's and the owner's
    fact_id = f"payment_link:{link.link_id}"
    assert result.facts == [Fact(
        fact_id=fact_id, kind="payment_link", status="available", source="kernel",
        claims=[Claim(key="title", kind="text", value="Drain clearing"),
                Claim(key="total", kind="money", value=16_200), Claim(key="ref", kind="ref", value=link.link_id)],
        label=Label(readers=["owner", f"session:{visitor.session_id}"]), expires_at=link.expires_at)]
    assert result.model_view == {"fact_id": fact_id, "title": "Drain clearing", "amount_cents": 16_200}
    assert await payment_entries(app, copy) == [
        (visitor.session_id, {"link_id": link.link_id, "state": "issued", "version": 2})]

    # its receipt says what was done
    done = await read(client, visitor.headers, decision)
    assert (done.state, done.visitor_plain) == ("executed", "Payment link made for this quote")
    # executing it again makes no other link or checkout
    assert await executed(client, visitor, decision) == result
    assert len(await links_of(app, copy)) == 1 and len(checkouts(copy)) == 1


@pytest.mark.solver
async def test_another_sessions_quote_is_refused(desk_prove, app, client, frozen_clock):
    copy = await link_desk(client, await rivera(app, client))
    owner_of_quote, stranger = await open_visitor(client, copy), await open_visitor(client, copy)
    quote_id = await quoted(client, owner_of_quote, ("leak", 1))
    # another session can't name it, nor a quote no Desk has
    for call_id, (visitor, named) in enumerate(((stranger, quote_id), (owner_of_quote, "quote-nosuch"))):
        refused = await link_for(client, visitor, named, call_id=f"call-{call_id}")
        assert (refused.outcome, refused.action) == ("refuse", None), named
        assert "It didn't match your records, so it was refused." in refused.reason_plain
    unstorable = await link_for(client, owner_of_quote, "quote\x00x", call_id="call-nul")   # names no row at all
    assert (unstorable.outcome, unstorable.action) == ("refuse", None)
    # nor, once it has expired, the session that asked for it
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        quote = (await ctx.db.scalars(ctx.repo.scoped(select(Quote).where(Quote.quote_id == quote_id)))).one()
        quote.expires_at = frozen_clock.now()
    refused = await link_for(client, owner_of_quote, quote_id, call_id="call-late")
    assert (refused.outcome, refused.action) == ("refuse", None)
    # a link is for one of this conversation's quotes: a verified person's quote from an earlier
    # conversation is refused in a new one, though she may read it there
    dana = await confirmed(client, copy, "dana@example.com")
    dana_quote = await quoted(client, dana, ("deposit", 1))
    again = await confirmed(client, copy, "dana@example.com")
    assert (await link_for(client, again, dana_quote)).outcome == "refuse"
    assert (await link_for(client, stranger, dana_quote, call_id="call-stranger")).outcome == "refuse"
    assert (await link_for(client, dana, dana_quote, call_id="call-own")).outcome == "allow"
    assert await links_of(app, copy) == [] and checkouts(copy) == []


async def test_a_quote_named_by_its_fact_id_is_the_same_quote(app, client, reviewer):
    """Claude's context shows a quote by its fact ID (`quote:<id>`), and the tool takes "the
    quote_id in your context", so passing the whole fact ID is an honest way to name it: it links
    exactly the quote the bare ID would, under the Rivera seed's `rv-link` with a passing review.
    Another session still can't name it either way, and no other prefix is read as the quote's."""
    reviewer.answer = Review(within_charter_bp=9500, manipulation_bp=300, recommendation="allow")
    copy = await rivera(app, client)
    visitor, other = await open_visitor(client, copy), await open_visitor(client, copy)
    quote_id = await quoted(client, visitor, ("deposit", 1))
    for call_id, (who, named) in enumerate(((other, quote_id), (other, f"quote:{quote_id}"),
                                            (visitor, f"document:{quote_id}"), (visitor, f"quote:quote:{quote_id}"))):
        refused = await link_for(client, who, named, call_id=f"call-refused-{call_id}")
        assert (refused.outcome, refused.action) == ("refuse", None), named
    checks = [entry.event.summary.get("check") for entry in await ledger_rows(app, copy)
              if entry.event.kind == "decide" and entry.event.summary.get("reason") == "adapter_refused"]
    assert checks == ["no_such_quote"] * 4

    decision = await link_for(client, visitor, f"quote:{quote_id}", call_id="call-fact")
    assert (decision.outcome, decision.card_ids) == ("allow", ["rv-link"]), decision.reason_plain
    assert (decision.action.resource.kind, decision.action.resource.id, decision.action.amount_cents) == (
        "quote", quote_id, 2_000)
    result = await executed(client, visitor, decision)
    [link] = await links_of(app, copy)
    assert (link.quote_id, link.action_id, link.session_id, link.amount_cents) == (
        quote_id, decision.action.action_id, visitor.session_id, 2_000)
    assert checkouts(copy) == [(decision.action.action_id, 2_000, "Service call deposit",
                                f"session:{visitor.session_id}", "open")]
    # the bare ID names the same quote, so it answers with that same link
    again = await link_for(client, visitor, quote_id, call_id="call-bare")
    assert (again.outcome, again.action.resource) == ("allow", decision.action.resource)
    assert (await executed(client, visitor, again)).facts == result.facts
    assert len(await links_of(app, copy)) == 1 and len(checkouts(copy)) == 1


@pytest.mark.solver
async def test_a_quote_has_one_open_link_and_is_paid_once(desk_prove, app, client):
    """Asking again for a link to a quote that has an open one answers with that link: one checkout,
    one link and one `issued` entry, the same fact for both actions, and the receipt the owner
    signed off. Once the link is paid the quote is paid, and a further request for it is refused at
    step 1, before any action exists, with the adapter's `quote_paid` on its `decide` entry."""
    copy = await link_desk(client, await rivera(app, client))
    visitor = await open_visitor(client, copy)
    quote_id = await quoted(client, visitor, ("deposit", 1))
    first = await link_for(client, visitor, quote_id, call_id="call-link-1")
    second = await link_for(client, visitor, quote_id, call_id="call-link-2")
    assert (first.outcome, second.outcome) == ("allow", "allow"), (first.reason_plain, second.reason_plain)
    issued = await executed(client, visitor, first)
    again = await executed(client, visitor, second)
    assert again.state == "succeeded"
    assert ([fact.fact_id for fact in again.facts], again.model_view) == (
        [fact.fact_id for fact in issued.facts], issued.model_view)
    [link] = await links_of(app, copy)
    assert link.action_id == first.action.action_id
    assert checkouts(copy) == [(first.action.action_id, 2_000, "Service call deposit",
                                f"session:{visitor.session_id}", "open")]
    assert await payment_entries(app, copy) == [
        (visitor.session_id, {"link_id": link.link_id, "state": "issued", "version": 2})]
    done = await read(client, visitor.headers, second)
    assert (done.state, done.visitor_plain) == ("executed", "Payment link made for this quote")

    response = await client.post(f"/payment_links/{link.token}/complete", json={})
    assert response.status_code == 200, response.text
    [quote] = await rows_of(app, copy.copy_id, select(Quote).where(Quote.quote_id == quote_id))
    assert quote.status == "paid"
    refused = await link_for(client, visitor, quote_id, call_id="call-link-3")
    assert (refused.outcome, refused.state, refused.action) == ("refuse", "refused", None), refused.reason_plain
    assert "It didn't match your records, so it was refused." in refused.reason_plain
    refusals = [entry.event.summary for entry in await ledger_rows(app, copy)
                if entry.event.kind == "decide" and entry.event.summary.get("outcome") == "refuse"]
    assert refusals == [{"outcome": "refuse", "tool": TOOL, "reason": "adapter_refused", "check": "quote_paid",
                         "policy_version": 2, "auto_money_cap_cents": 50_000}]
    assert len(await links_of(app, copy)) == 1 and len(checkouts(copy)) == 1


async def delay(mockpay: Mockpay, copy: Rivera, op: str, seconds: float) -> None:
    """The mock payments server's test switch: the copy's later `op` calls wait `seconds` first."""
    async with httpx.AsyncClient(base_url=mockpay.url, trust_env=False) as http:
        response = await http.post("/provider/test/delay", json={"op": op, "seconds": seconds},
                                   headers={"X-Mockpay-Key": mockpay.key, "X-Desk-Copy": copy.copy_id})
    assert response.status_code == 200, response.text


async def landed(copy: Rivera, key: str, within: float = 6.0) -> None:
    """Waits until the provider holds a checkout under `key` (a delayed request finishing)."""
    deadline = time.monotonic() + within
    while not [row for row in checkouts(copy) if row[0] == key]:
        assert time.monotonic() < deadline, "the delayed checkout never landed"
        await asyncio.sleep(0.1)


def nothing_listening() -> str:
    """A loopback URL with no server behind it."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{sock.getsockname()[1]}"


@pytest.mark.solver
@pytest.mark.parametrize("how", ["server_stopped", "checkout_delayed"])
async def test_checkout_errors_map_to_outcomes(desk_prove, app, client, mockpay, monkeypatch, how):
    copy = await link_desk(client, await rivera(app, client))
    visitor = await open_visitor(client, copy)
    decision = await link_for(client, visitor, await quoted(client, visitor, ("heater", 1)))
    assert decision.outcome == "allow", decision.reason_plain
    key = decision.action.action_id
    if how == "server_stopped":
        # the request never reaches a provider: nothing can have happened, so the action failed
        runtime = app.state.kernel
        monkeypatch.setattr(app.state, "kernel", dataclasses.replace(
            runtime, settings=dataclasses.replace(runtime.settings, mockpay_url=nothing_listening())))
        result = await executed(client, visitor, decision)
        assert (result.state, result.facts, result.model_view) == ("failed", [], {})
        assert (await read(client, visitor.headers, decision)).state == "failed"
        assert await links_of(app, copy) == [] and checkouts(copy) == []
        assert await payment_entries(app, copy) == []
        return
    # the checkout takes 3 s, past the 2 s deadline: it may still land, so the outcome is unknown
    await delay(mockpay, copy, "checkout", 3)
    started = time.monotonic()
    result = await executed(client, visitor, decision)
    assert time.monotonic() - started < 3
    assert (result.state, result.facts, result.model_view) == ("unknown", [], {})
    assert await links_of(app, copy) == []
    # once it lands, a read settles it at the provider by its key: executed, with one link for one checkout
    await landed(copy, key)
    settled = await read(client, visitor.headers, decision)
    assert settled.state == "executed"
    [link] = await links_of(app, copy)
    assert (link.action_id, link.amount_cents, link.state) == (key, 15_000, "issued")
    assert checkouts(copy) == [(key, 15_000, "Water heater flush", f"session:{visitor.session_id}", "open")]
    assert await payment_entries(app, copy) == [
        (visitor.session_id, {"link_id": link.link_id, "state": "issued", "version": 2})]
    stored = await executed(client, visitor, decision)
    assert (stored.state, stored.model_view["fact_id"]) == ("succeeded", f"payment_link:{link.link_id}")


@pytest.mark.solver
async def test_link_clause_renders_title_and_path(desk_prove, app, client, reviewer):
    copy = await link_desk(client, await rivera(app, client))
    visitor = await open_visitor(client, copy)
    decision = await link_for(client, visitor, await quoted(client, visitor, ("deposit", 1)))
    result = await executed(client, visitor, decision)
    [fact] = result.facts
    [link] = await links_of(app, copy)
    cited = [clause("payment_link", fact.fact_id)]

    # the card, in either language: what the link is for and its amount, from the fact, and the link
    # as its `href` alone; the soft-promise check reads the card's text, never the link
    for language, prose in (("en", "Here is your payment link."), ("es", "Aquí tienes tu enlace de pago.")):
        verdict = await checked(client, visitor, prose, cited)
        assert (verdict.ok, verdict.language) == (True, language), verdict.violations
        [_, card] = verdict.blocks
        assert (card.kind, card.template, card.fact_id, card.title, card.lines, card.text, card.href, card.options) == (
            "card", "payment_link", fact.fact_id, "Service call deposit, $20.00", [], "Service call deposit, $20.00",
            f"/pay/{link.token}", [])
        assert verdict.model_dump_json().count(link.token) == 1
    assert reviewer.soft_inputs and link.token not in repr(reviewer.soft_inputs)

    # the token is in no claim, model_view, ledger entry or kernel_ro row, and no other token is either
    assert link.token not in result.model_dump_json()
    shown = [entry.event.model_dump_json() for entry in await ledger_rows(app, copy)]
    for view in ("payment_links", "facts", "actions", "decisions"):
        shown += [text for (text,) in api_rows(copy.copy_id, f"SELECT row_to_json(v)::text FROM kernel_ro.{view} v")]
    assert shown and not [text for text in shown if link.token in text or link.token_sha256 in text]
    [row] = api_rows(copy.copy_id, "SELECT action_id FROM kernel_ro.payment_links")
    assert row == (decision.action.action_id,)

    # another session citing it gets the handoff: no title, no link
    stranger = await open_visitor(client, copy)
    verdict = await checked(client, stranger, "Here is your payment link.", cited)
    assert violations(verdict) == [("unentitled_fact", "not_a_reader", [fact.fact_id])]
    assert_handed_off(verdict)
    assert link.token not in verdict.model_dump_json()

    # a link that can no longer be paid shows no card, even before its fact catches up
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        (await ctx.db.scalars(ctx.repo.scoped(select(PaymentLink)))).one().state = "cancelled"
    verdict = await checked(client, visitor, "Here is your payment link.", cited)
    assert violations(verdict) == [("stale_fact", "nothing_to_show", [fact.fact_id])]
    assert link.token not in verdict.model_dump_json()


LINKS_TO_100 = LINKS.model_copy(update={"max_amount_cents": 10_000, "reason": "Payment links up to $100."})


async def lowered_draft(client: httpx.AsyncClient, copy: Rivera) -> PolicyVersion:
    """A proved draft on version 2 at a $100 money cap, with `LINKS` lowered to $100; not confirmed."""
    response = await post_draft(client, copy, [QUOTES, LINKS_TO_100], 2, auto_money_cap_cents=10_000)
    assert response.status_code == 200, response.text
    drafted = PolicyVersion.model_validate(response.json())
    assert (drafted.version, drafted.status, drafted.auto_money_cap_cents) == (3, "proved", 10_000), drafted.proof
    return drafted


async def confirm(client: httpx.AsyncClient, copy: Rivera, version: int) -> None:
    response = await client.post("/policy/confirm", headers=copy.owner, json={"desk_id": copy.desk_id,
                                                                              "version": version})
    assert response.status_code == 200, response.text


@pytest.mark.solver
@pytest.mark.parametrize("when", ["after_the_intent", "while_the_checkout_is_unknown"])
async def test_activation_during_link_issue_is_applied(desk_prove, app, client, mockpay, monkeypatch, when):
    copy = await link_desk(client, await rivera(app, client))
    lowered = await lowered_draft(client, copy)
    visitor = await open_visitor(client, copy)
    decision = await link_for(client, visitor, await quoted(client, visitor, ("heater", 2)))     # $300
    assert (decision.outcome, decision.policy_version) == ("allow", 2), decision.reason_plain
    key = decision.action.action_id
    if when == "after_the_intent":
        # the owner confirms the $100 version as the intent commits: the link is checked against it
        # before anything reaches the provider
        async def confirmed_now() -> None:
            await confirm(client, copy, lowered.version)

        monkeypatch.setattr(execute, "_after_intent", confirmed_now)
        result = await executed(client, visitor, decision)
        assert (result.state, result.facts) == ("failed", [])
        [entry] = [e.event.summary for e in await ledger_rows(app, copy)
                   if e.event.kind == "execute" and e.event.summary.get("state") == "failed"]
        assert (entry["action_id"], entry["reason"], entry["policy_version"]) == (key, "rules_changed", 2)
    else:
        # the checkout lands after the deadline, the version is confirmed, then a read settles it:
        # the new version no longer allows the link, so its checkout is cancelled at the provider
        await delay(mockpay, copy, "checkout", 3)
        assert (await executed(client, visitor, decision)).state == "unknown"
        await landed(copy, key)
        await confirm(client, copy, lowered.version)
        assert (await read(client, visitor.headers, decision)).state == "failed"
    assert (await read(client, visitor.headers, decision)).state == "failed"
    assert await links_of(app, copy) == []
    assert await payment_entries(app, copy) == []
    expected = [] if when == "after_the_intent" else [
        (key, 30_000, "Water heater flush × 2", f"session:{visitor.session_id}", "cancelled")]
    assert checkouts(copy) == expected


async def view(client: httpx.AsyncClient, token: str) -> PaymentLinkView:
    """What the mock checkout page reads (the API proxies it), by the link's token alone."""
    response = await client.get(f"/payment_links/{token}")
    assert response.status_code == 200, response.text
    return PaymentLinkView.model_validate(response.json())


async def issued(app: FastAPI, client: httpx.AsyncClient, copy: Rivera, visitor: Visitor, *items: tuple[str, int],
                 call_id: str = "call-link") -> PaymentLink:
    """A link to a new quote for `items`, decided under `LINKS` and executed: its row."""
    decision = await link_for(client, visitor, await quoted(client, visitor, *items, call_id=f"{call_id}-quote"),
                              call_id=call_id)
    assert decision.outcome == "allow", decision.reason_plain
    await executed(client, visitor, decision)
    return next(link for link in await links_of(app, copy) if link.action_id == decision.action.action_id)


@pytest.mark.solver
async def test_link_view_names_the_desks_business(desk_prove, app, client):
    copy = await link_desk(client, await rivera(app, client))
    visitor = await open_visitor(client, copy)
    link = await issued(app, client, copy, visitor, ("drain", 1))
    public = await client.get(f"/public/{copy.slug}")
    assert public.status_code == 200, public.text
    seen = await view(client, link.token)
    assert seen == PaymentLinkView(title="Drain clearing", amount_cents=18_000, state="issued", language="en",
                                   business_name=public.json()["business_name"], customer_name=None)
    assert seen.business_name == "Rivera Plumbing"
    # the business's name as it stands, read from the link's Desk, never from the request
    response = await client.put(f"/desks/{copy.desk_id}/business", headers=copy.owner, json={
        "name": "Rivera & Daughters Plumbing", "owner_display_name": "Maria Rivera", "timezone": "America/Los_Angeles",
        "brand": {"primary": "#1F4E4A", "accent": "#B87333"}})
    assert response.status_code == 200, response.text
    assert (await view(client, link.token)).business_name == "Rivera & Daughters Plumbing"
    # the session's language as it last wrote
    assert (await checked(client, visitor, "Hola, ¿qué tal?")).language == "es"
    assert (await view(client, link.token)).language == "es"
    # a token no link has, or no token could be, is the same 404 for all
    for token in (link.token[:-1] + ("A" if link.token[-1] != "A" else "B"), "not-a-token", "x" * 200):
        response = await client.get(f"/payment_links/{token}")
        assert (response.status_code, response.json()) == (404, {"code": "not_found"}), token
    # a name holding a document's canary, stored before owner writes checked for one, is withheld
    # here as the public page withholds it
    dana = (await documents(app, copy))["dana-invoice"]
    await store_business(app, copy, name=f"Rivera Plumbing {dana.canary}")
    response = await client.get(f"/payment_links/{link.token}")
    assert response.status_code == 200, response.text
    assert dana.canary not in response.text
    public = await client.get(f"/public/{copy.slug}")
    assert PaymentLinkView.model_validate(response.json()).business_name == public.json()["business_name"] == ""


async def stand_in(app: FastAPI, copy: Rivera, like: PaymentLink, *, session_id: str, customer_id: str) -> str:
    """Test only: a live link row like `like`, for another session or customer, written directly,
    since an agent's link and a link for someone other than its session's person can't be issued
    here. Its token."""
    token = secrets.token_urlsafe(32)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        ctx.db.add(PaymentLink(
            link_id=f"paylink-{secrets.token_hex(8)}", copy_id=copy.copy_id, desk_id=like.desk_id,
            session_id=session_id, quote_id=like.quote_id, action_id=f"act-{secrets.token_hex(8)}", title=like.title,
            amount_cents=like.amount_cents, state="issued", token=token,
            token_sha256=hashlib.sha256(token.encode()).hexdigest(), provider_checkout_id=like.provider_checkout_id,
            customer_id=customer_id, expires_at=like.expires_at, created_at=like.created_at,
            updated_at=like.updated_at))
    return token


async def set_state(app: FastAPI, copy: Rivera, link_id: str, state: str) -> None:
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        link = (await ctx.db.scalars(ctx.repo.scoped(select(PaymentLink).where(PaymentLink.link_id == link_id)))).one()
        link.state = state


@pytest.mark.solver
async def test_customer_name_shows_only_while_the_link_is_live(desk_prove, app, client, frozen_clock):
    copy = await link_desk(client, await rivera(app, client))
    dana, bob = await confirmed(client, copy, "dana@example.com"), await confirmed(client, copy, "bob@example.com")
    link = await issued(app, client, copy, dana, ("deposit", 1))
    bobs = await issued(app, client, copy, bob, ("deposit", 1), call_id="call-bob")
    dana_id, bob_id = link.customer_id.removeprefix("person:"), bobs.customer_id.removeprefix("person:")
    assert (link.customer_id, bobs.customer_id) == (f"person:{dana_id}", f"person:{bob_id}")
    # a verified customer's live link names them by first name and last initial, from the record
    assert (await view(client, link.token)).customer_name == "Dana W."
    assert (await view(client, bobs.token)).customer_name == "Bob O."

    # an unverified session's link names no one
    stranger = await open_visitor(client, copy)
    unverified = await issued(app, client, copy, stranger, ("deposit", 1), call_id="call-stranger")
    assert (unverified.customer_id, (await view(client, unverified.token)).customer_name) == (
        f"session:{stranger.session_id}", None)
    # nor an agent's, even one verified as Dana, nor a link whose customer isn't its session's person
    agent = await mint(client, copy.owner, copy.desk_id)
    agent_session = (await open_agent(client, copy.slug, agent, frozen_clock)).state.session_id
    await verify_session(app, copy.copy_id, agent_session, dana_id)
    for session_id, customer_id in ((agent_session, f"person:{dana_id}"), (dana.session_id, f"person:{bob_id}")):
        token = await stand_in(app, copy, link, session_id=session_id, customer_id=customer_id)
        assert (await view(client, token)).customer_name is None, (session_id, customer_id)

    # once it is paid, cancelled, unknown or expired, the same token names no one (a read settles an
    # unknown link with the provider first, so here the provider can't be reached and it stays unknown)
    runtime = app.state.kernel
    for state in ("paid", "cancelled", "unknown", "expired"):
        await set_state(app, copy, link.link_id, state)
        if state == "unknown":
            app.state.kernel = dataclasses.replace(runtime, settings=dataclasses.replace(
                runtime.settings, mockpay_url=nothing_listening()))
        try:
            seen = await view(client, link.token)
        finally:
            app.state.kernel = runtime
        assert (seen.state, seen.customer_name) == (state, None), state
    await set_state(app, copy, link.link_id, "issued")
    assert (await view(client, link.token)).customer_name == "Dana W."
    # nor once the person is off the record
    response = await client.put(f"/desks/{copy.desk_id}/people", headers=copy.owner, json={"upsert": [],
                                                                                            "remove": ["dana"]})
    assert response.status_code == 200, response.text
    assert (await view(client, link.token)).customer_name is None
    assert (await view(client, bobs.token)).customer_name == "Bob O."
    # nor once a day has passed, when the link reads as expired
    frozen_clock.advance((bobs.expires_at - frozen_clock.now()).total_seconds())
    seen = await view(client, bobs.token)
    assert (seen.state, seen.customer_name) == ("expired", None)


@pytest.mark.solver
async def test_reconciling_a_link_never_waits_for_a_confirm(desk_prove, app, client, mockpay):
    copy = await link_desk(client, await rivera(app, client))
    visitor = await open_visitor(client, copy)
    decision = await link_for(client, visitor, await quoted(client, visitor, ("deposit", 1)))
    await delay(mockpay, copy, "checkout", 3)
    assert (await executed(client, visitor, decision)).state == "unknown"
    await landed(copy, decision.action.action_id)
    # a confirm holds the active version (its row FOR UPDATE) while a read reconciles the link: the read
    # doesn't wait for it, and leaves the link unknown for the next one
    with psycopg.connect(libpq_url(database_url("ADMIN"))) as confirming:
        confirming.execute("SELECT version FROM kernel.policy_versions WHERE desk_id = %s AND status = 'active'"
                           " FOR UPDATE", (copy.desk_id,))
        started = time.monotonic()
        assert (await asyncio.wait_for(read(client, visitor.headers, decision), 5)).state == "unknown"
        assert time.monotonic() - started < 2
        assert await links_of(app, copy) == []
        confirming.rollback()
    # once it is done, the next read settles it
    assert (await read(client, visitor.headers, decision)).state == "executed"
    [link] = await links_of(app, copy)
    assert checkouts(copy) == [(decision.action.action_id, 2_000, "Service call deposit",
                                f"session:{visitor.session_id}", "open")]


KEY = "k" * 32


def answering(status: int, body: object = None, *, raises: type[Exception] | None = None, sleep: float = 0,
              seen: list | None = None):
    """A `httpx2.MockTransport` handler: records each request in `seen`, then raises, or waits and answers."""

    async def handle(request: httpx2.Request) -> httpx2.Response:
        if seen is not None:
            seen.append(request)
        if raises is not None:
            raise raises("simulated", request=request)
        await asyncio.sleep(sleep)
        return httpx2.Response(status, json=body)

    return handle


@pytest.mark.parametrize(("handler", "outcome"), [
    (answering(200, {"checkout_id": "co_1"}), "co_1"),
    (answering(409, {"error": "conflict"}), payments.ProviderError),           # refused: nothing happened
    (answering(422, {"error": "invalid"}), payments.ProviderError),
    (answering(500, {"error": "boom"}), payments.ProviderTimeout),             # may have landed
    (answering(302, None), payments.ProviderTimeout),
    (answering(200, {"checkout_id": "co_1", "extra": True}), payments.ProviderTimeout),   # a closed answer only
    (answering(200, {"checkout_id": 7}), payments.ProviderTimeout),
    (answering(200, None, raises=httpx2.ConnectError), payments.ProviderError),     # never reached it
    (answering(200, None, raises=httpx2.ConnectTimeout), payments.ProviderError),
    (answering(200, None, raises=httpx2.ReadTimeout), payments.ProviderTimeout),
    (answering(200, None, raises=httpx2.RemoteProtocolError), payments.ProviderTimeout),
    (answering(200, {"checkout_id": "co_1"}, sleep=2.5), payments.ProviderTimeout),   # past the 2 s deadline
])
async def test_provider_answers_map_to_outcomes(handler, outcome):
    client = payments.ProviderClient("copy-1", url="http://mockpay.test", key=KEY,
                                     transport=httpx2.MockTransport(handler))
    call = client.create_checkout(idempotency_key="act-1", amount_cents=2_000, title="Deposit", customer_id="session:s")
    if isinstance(outcome, str):
        assert await call == outcome
    else:
        with pytest.raises(outcome):
            await call
    assert KEY not in repr(client)


async def test_provider_money_is_strict_and_nothing_is_sent_without_a_key():
    for amount in (True, "2000", 2000.0, -1, 1_000_001):
        transport = httpx2.MockTransport(answering(200, {"charge_id": "ch_1", "owner_person_id": None,
                                                         "amount_cents": amount, "refunded_cents": 0}))
        client = payments.ProviderClient("copy-1", url="http://mockpay.test", key=KEY, transport=transport)
        with pytest.raises(payments.ProviderTimeout):
            await client.read_charge("ch_1")
    seen: list[httpx2.Request] = []
    sent = payments.ProviderClient("copy-1", url="http://mockpay.test", key=KEY,
                                   transport=httpx2.MockTransport(answering(200, {"state": "voided",
                                                                                  "object_id": "co_1"}, seen=seen)))
    assert (await sent.void("checkout", "act-1")).state == "voided"
    [request] = seen
    assert (request.headers["X-Mockpay-Key"], request.headers["X-Desk-Copy"]) == (KEY, "copy-1")
    for key in ("", KEY[:-1]):                       # no key, or one the server would refuse: never sent
        unsent = payments.ProviderClient("copy-1", url="http://mockpay.test", key=key,
                                         transport=httpx2.MockTransport(answering(200, {}, seen=seen)))
        with pytest.raises(payments.ProviderError):
            await unsent.void("checkout", "act-1")
    assert len(seen) == 1
