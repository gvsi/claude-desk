"""POST /owner/messages: the owner speaks in a conversation, or whispers to Claude.

A say is the owner's own text, shown to the visitor as written. The kernel checks it for the
canaries of the Desk's documents and nothing else (the owner may name a price; Claude may not),
keeps it as an `owner_statement` fact the conversation can read, and answers with a signed,
ledgered verdict holding one `owner_said` card. A say carrying a canary is blocked: no card, no
fact, and a receipt for the owner alone. A whisper is a note for Claude: ledgered, and nothing
else. Claude can never cite what the owner said: it backs no quote, and only the kernel issues
`owner_said` cards.

Tests run on Rivera Plumbing copies as `POST /copies` seeds them (Friday 10:04 in Oakland).
"""

import asyncio
import logging

import httpx
from sqlalchemy import select

from desk.contracts import Claim, OwnerMessageResult
from desk.db.models import ActorSession, Desk, Document
from desk.db.models import Fact as FactRow
from desk.kernel_service import auth, labels, render, reply_check

from .helpers import kernel_ctx, ledger_rows, rows_of
from .test_adapters import Rivera, rivera, visitor_of
from .test_context import owner_session_id
from .test_decide import open_visitor, set_mode, set_session
from .test_reply_check import (assert_handed_off, checked, clause, post_check, public_key, reply_entries,
                               verify_verdict)

ROUTE = "POST /owner/messages"
SAY = "A tank replacement usually runs $1,400 to $1,900."
KERNEL_ONLY = {"owner_said", "payment_confirmed", "link_cancelled"}   # cards Claude may never draft


async def post_message(client: httpx.AsyncClient, copy: Rivera, session_id: str, text: str, kind: str = "say", *,
                       headers: dict[str, str] | None = None) -> httpx.Response:
    return await client.post("/owner/messages", headers=copy.owner if headers is None else headers,
                             json={"session_id": session_id, "text": text, "kind": kind})


async def sent(client: httpx.AsyncClient, copy: Rivera, session_id: str, text: str,
               kind: str = "say") -> OwnerMessageResult:
    response = await post_message(client, copy, session_id, text, kind)
    assert response.status_code == 200, response.text
    return OwnerMessageResult.model_validate(response.json())


async def test_say_returns_one_signed_owner_said_block(app, client, reviewer):
    copy, visitor = await visitor_of(app, client)
    result = await sent(client, copy, visitor.session_id, SAY)
    verdict = result.verdict
    assert verdict is not None and (verdict.ok, verdict.violations) == (True, [])
    fact_id = f"owner:{result.message_id}"
    # the owner's words as written, amounts and all: the number rule is Claude's, not the owner's
    [block] = verdict.blocks
    assert (block.kind, block.template, block.fact_id, block.title, block.text, block.lines) == (
        "card", "owner_said", fact_id, SAY, SAY, [])
    assert (verdict.message_id, verdict.generation, verdict.language, verdict.visitor_plain) == (
        result.message_id, 0, "en", "Written by Maria Rivera")
    assert result.ledger_seq == verdict.ledger_seq
    verify_verdict(await public_key(client), visitor.session_id, verdict)
    assert reviewer.soft_inputs == []                                    # no model reads what the owner says

    # the conversation can read the statement; it isn't Claude's to cite
    [fact] = await rows_of(app, copy.copy_id, select(FactRow).where(FactRow.kind == "owner_statement"))
    assert (fact.fact_id, fact.source, fact.status, fact.session_id, fact.readers, fact.expires_at) == (
        fact_id, "owner", "available", visitor.session_id, ["owner", f"session:{visitor.session_id}"], None)
    assert fact.claims == [Claim(key="text", kind="text", value=SAY)]

    # ledgered like any reply, by its author, and without the words
    [entry] = await reply_entries(app, copy)
    assert (entry.seq, entry.event.session_id, entry.event.ref_id) == (
        verdict.ledger_seq, visitor.session_id, result.message_id)
    assert entry.event.summary == {"message_id": result.message_id, "author": "owner", "ok": True, "language": "en",
                                   "violations": [], "rule_ids": [], "fact_ids": [fact_id], "soft_promise": None,
                                   "soft_checks": None, "dropped": [], "final": True}
    assert "tank replacement" not in entry.envelope_jcs

    # a conversation in Spanish gets its receipt in Spanish, and the owner's words as written
    await set_session(app, copy, visitor.session_id, last_language="es")
    spanish = (await sent(client, copy, visitor.session_id, "Le llamo en una hora, Sam.")).verdict
    assert spanish is not None and spanish.ok
    assert (spanish.language, spanish.visitor_plain, [block.title for block in spanish.blocks]) == (
        "es", "Escrito por Maria Rivera", ["Le llamo en una hora, Sam."])
    verify_verdict(await public_key(client), visitor.session_id, spanish)


async def test_say_works_during_a_take_over(app, client, monkeypatch):
    copy, visitor = await visitor_of(app, client)
    key = await public_key(client)
    assert (await set_mode(client, copy, visitor.session_id, "owner", 0))["generation"] == 1   # Maria takes over
    stalled = await post_check(client, visitor, "I can help with that.", generation=1)
    assert (stalled.status_code, stalled.json()) == (409, {"code": "mode_owner"})            # Claude waits
    taken = (await sent(client, copy, visitor.session_id, "Hi Sam, it's Maria. I can be there by four.")).verdict
    assert taken is not None and (taken.ok, taken.generation) == (True, 1)
    assert [block.template for block in taken.blocks] == ["owner_said"]
    verify_verdict(key, visitor.session_id, taken)

    # a conversation the breaker paused hears from the owner too
    await set_session(app, copy, visitor.session_id, mode="paused", strikes=3)
    paused = (await sent(client, copy, visitor.session_id, "Sorry about that, Sam. I'm here now.")).verdict
    assert paused is not None and (paused.ok, paused.generation) == (True, 1)

    # a take-over running alongside a say waits for it: the say's verdict is at the generation the
    # conversation had when it was ledgered, never one a take-over ended before it was sent
    assert (await set_mode(client, copy, visitor.session_id, "ai", 1))["generation"] == 2      # Maria resumes it
    reading, release = asyncio.Event(), asyncio.Event()
    canaries = labels.copy_canaries

    async def held_open(ctx):
        reading.set()
        await release.wait()
        return await canaries(ctx)

    monkeypatch.setattr(labels, "copy_canaries", held_open)
    say = asyncio.create_task(post_message(client, copy, visitor.session_id, "Maria here, taking this one."))
    await asyncio.wait_for(reading.wait(), 10)
    take_over = asyncio.create_task(set_mode(client, copy, visitor.session_id, "owner", 2))
    done, _ = await asyncio.wait({take_over}, timeout=0.5)
    assert not done                                                      # the take-over waits for the say
    release.set()
    response = await asyncio.wait_for(say, 10)
    assert response.status_code == 200, response.text
    alongside = OwnerMessageResult.model_validate(response.json()).verdict
    assert (await asyncio.wait_for(take_over, 10))["generation"] == 3
    assert alongside is not None and (alongside.ok, alongside.generation) == (True, 2)
    order = [(entry.event.kind, entry.event.ref_id) for entry in await ledger_rows(app, copy)
             if entry.event.kind in ("reply", "takeover")]
    assert order[-2:] == [("reply", alongside.message_id), ("takeover", None)]


async def test_say_with_a_document_canary_is_blocked(app, client, reviewer):
    copy, visitor = await visitor_of(app, client)
    documents = await rows_of(app, copy.copy_id, select(Document))
    canaries = [row.canary for row in documents]
    assert len(canaries) == 2                                             # Dana's invoice and Bob's warranty
    key = await public_key(client)
    blocked = []
    hidden = f"{canaries[1][:6]}\u200b{canaries[1][6:]}"                  # behind a zero-width space
    for document, language, text in ((documents[0], "en", f"Your invoice reference is {canaries[0]}."),
                                     (documents[1], "es", f"Tu referencia es {hidden}.")):
        await set_session(app, copy, visitor.session_id, last_language=language)
        result = await sent(client, copy, visitor.session_id, text)
        verdict = result.verdict
        # nothing for the visitor: no card, and a receipt the API shows the owner alone
        assert verdict is not None and (verdict.ok, verdict.blocks, verdict.language) == (False, [], language)
        assert [(v.kind, v.span, v.fact_ids, v.rule_id) for v in verdict.violations] == [
            ("canary", "document text", [f"document:{document.document_id}"], "labels.canary")]
        verify_verdict(key, visitor.session_id, verdict)
        assert not any(canary in result.model_dump_json() for canary in canaries)
        blocked.append(verdict)
    assert [verdict.visitor_plain for verdict in blocked] == [
        "Not sent: it included text from a private document", "No se envió: incluía texto de un documento privado"]
    assert await rows_of(app, copy.copy_id, select(FactRow).where(FactRow.kind == "owner_statement")) == []
    assert reviewer.soft_inputs == []

    # ledgered alike, and the canary nowhere in the ledger
    entries = await reply_entries(app, copy)
    assert [(entry.seq, entry.event.ref_id, entry.event.summary["author"], entry.event.summary["ok"],
             entry.event.summary["violations"], entry.event.summary["fact_ids"]) for entry in entries] == [
        (verdict.ledger_seq, verdict.message_id, "owner", False, ["canary"], []) for verdict in blocked]
    assert not any(canary in entry.envelope_jcs for entry in await ledger_rows(app, copy) for canary in canaries)


async def test_owner_statements_never_back_a_quote(app, client):
    copy, visitor = await visitor_of(app, client)
    fact_id = f"owner:{(await sent(client, copy, visitor.session_id, SAY)).message_id}"
    # Claude can't show what the owner said as a quote, or as any card it drafts; only the kernel
    # issues `owner_said`
    refused = {}
    for template in render.TEMPLATES:
        verdict = await checked(client, visitor, "Here is what Maria said.", [clause(template, fact_id)])
        assert_handed_off(verdict)
        [violation] = verdict.violations
        assert (violation.span, violation.fact_ids) == (template, [fact_id])
        refused[template] = (violation.kind, violation.rule_id)
    assert refused["quote"] == ("unknown_fact", "template_mismatch")
    assert refused["owner_said"] == ("unknown_fact", "kernel_only_template")
    # the cards only the kernel issues are pinned here, never read from the checker under test
    assert KERNEL_ONLY <= set(render.TEMPLATES)
    assert refused == {template: ("unknown_fact", "kernel_only_template" if template in KERNEL_ONLY
                                  else "names_no_fact" if not render.TEMPLATES[template].fact_kinds
                                  else "template_mismatch") for template in render.TEMPLATES}

    # and another conversation can't read it at all
    other = await open_visitor(client, copy)
    verdict = await checked(client, other, "Here is what Maria said.", [clause("quote", fact_id)])
    assert [(v.kind, v.rule_id) for v in verdict.violations] == [("unentitled_fact", "not_a_reader")]


async def test_whispers_are_ledgered_and_create_nothing(app, client, reviewer):
    copy, visitor = await visitor_of(app, client)
    facts = await rows_of(app, copy.copy_id, select(FactRow.fact_id))
    before = await ledger_rows(app, copy)
    whisper = "He's a regular: offer him the Tuesday slot at the usual $150."
    result = await sent(client, copy, visitor.session_id, whisper, "whisper")
    assert result.verdict is None                                        # nothing for the visitor
    [entry] = (await ledger_rows(app, copy))[len(before):]
    assert (entry.seq, entry.event.kind, entry.event.origin, entry.event.session_id, entry.event.ref_id) == (
        result.ledger_seq, "whisper", "kernel", visitor.session_id, result.message_id)
    assert entry.event.summary == {"message_id": result.message_id, "chars": len(whisper)}   # never the words
    assert "Tuesday" not in entry.envelope_jcs
    # no fact, so nothing Claude could cite, and no reply
    assert await rows_of(app, copy.copy_id, select(FactRow.fact_id)) == facts
    assert await reply_entries(app, copy) == []
    assert reviewer.soft_inputs == []


async def test_owner_messages_need_the_owner_of_the_sessions_copy(app, client, frozen_clock, caplog):
    caplog.set_level(logging.WARNING, logger="desk.kernel_service")
    copy, visitor = await visitor_of(app, client)
    other = await rivera(app, client)                                    # another copy and its owner
    before = await ledger_rows(app, copy)
    for kind in ("say", "whisper"):
        response = await post_message(client, copy, visitor.session_id, SAY, kind, headers=other.owner)
        assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    # a session's token, alone or beside the owner's, no token, or a wrong one
    for headers in (visitor.headers, {**copy.owner, **visitor.headers}, {}, {auth.OWNER_HEADER: "not-a-token"}):
        response = await post_message(client, copy, visitor.session_id, SAY, headers=headers)
        assert (response.status_code, response.json()) == (401, {"code": "auth"})
    # each refusal is on the conversation's ledger, and nothing was said or whispered
    assert [(entry.event.kind, entry.event.session_id, entry.event.summary)
            for entry in (await ledger_rows(app, copy))[len(before):]] == [
        ("auth", visitor.session_id, {"route": ROUTE, "reason": reason})
        for reason in ("wrong_copy", "wrong_copy", "bad_token", "bad_token", "bad_owner_token", "bad_owner_token")]
    assert await rows_of(app, copy.copy_id, select(FactRow).where(FactRow.kind == "owner_statement")) == []

    # a session no copy has: logged, as there is no Desk to ledger it on
    response = await post_message(client, copy, "no-such-session", SAY)
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    assert f"auth_unattributed route={ROUTE} reason=unknown_session" in caplog.text
    # the owner's own session is no conversation
    response = await post_message(client, copy, await owner_session_id(client, copy.owner), SAY, "whisper")
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})

    # a closed conversation, or one on a deleted Desk, takes no message
    await set_session(app, copy, visitor.session_id, closed_at=frozen_clock.now())
    late = await open_visitor(client, copy)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        (await ctx.db.scalars(ctx.repo.scoped(select(Desk)))).one().deleted_at = ctx.clock.now()
    before = await ledger_rows(app, copy)
    for session_id in (visitor.session_id, late.session_id):
        response = await post_message(client, copy, session_id, SAY)
        assert (response.status_code, response.json()) == (409, {"code": "closed"})
    refusals = [(entry.event.session_id, entry.event.summary) for entry in (await ledger_rows(app, copy))[len(before):]]
    assert refusals == [(session_id, {"route": ROUTE, "reason": "closed"})
                        for session_id in (visitor.session_id, late.session_id)]
    assert await reply_entries(app, copy) == []


async def test_the_conversation_is_read_again_under_its_lock(app, client, frozen_clock, monkeypatch):
    """The route reads the conversation's row afresh when it locks it: a copy read earlier in the
    request, before the conversation closed, doesn't let the owner's message into it."""
    copy, visitor = await visitor_of(app, client)
    require_owner, read_earlier = auth.require_owner, []

    async def read_before_it_closes(ctx, request, **kwargs):
        owner = await require_owner(ctx, request, **kwargs)
        read_earlier.append((await ctx.db.scalars(ctx.repo.scoped(select(ActorSession).where(
            ActorSession.session_id == visitor.session_id)))).one())        # an earlier read, still held
        await set_session(app, copy, visitor.session_id, closed_at=frozen_clock.now())   # then it closes
        return owner

    monkeypatch.setattr(auth, "require_owner", read_before_it_closes)
    response = await post_message(client, copy, visitor.session_id, SAY)
    assert (response.status_code, response.json()) == (409, {"code": "closed"})
    assert await reply_entries(app, copy) == []


async def test_owner_message_text_is_bounded(app, client):
    copy, visitor = await visitor_of(app, client)
    before = [entry.seq for entry in await ledger_rows(app, copy)]
    # nothing to show (blank, or only characters no font draws), or over two thousand characters
    for kind in ("say", "whisper"):
        for text in ("", " \n\t", "\u200b\u2060", "a" * 2001):
            response = await post_message(client, copy, visitor.session_id, text, kind)
            assert (response.status_code, response.json()) == (422, {"code": "invalid"}), (kind, text)
    response = await post_message(client, copy, visitor.session_id, SAY, "shout")
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert [entry.seq for entry in await ledger_rows(app, copy)] == before            # nothing kept
    # the credential comes first: a bad one is 401 whatever the text
    response = await post_message(client, copy, visitor.session_id, "", headers={})
    assert (response.status_code, response.json()) == (401, {"code": "auth"})
    # two thousand characters is the most
    longest = "Thanks! " * 250
    said = (await sent(client, copy, visitor.session_id, longest)).verdict
    assert said is not None and [block.title for block in said.blocks] == [longest]
    whispered = await sent(client, copy, visitor.session_id, longest, "whisper")
    [entry] = [entry for entry in await ledger_rows(app, copy) if entry.event.kind == "whisper"]
    assert (entry.seq, entry.event.summary["chars"]) == (whispered.ledger_seq, 2000)


async def test_owner_text_is_measured_before_it_is_read(app, client, monkeypatch):
    copy, visitor = await visitor_of(app, client)
    read, shown = [], reply_check.shown

    def reading(text: str) -> str:
        read.append(len(text))
        return shown(text)

    monkeypatch.setattr(reply_check, "shown", reading)
    # over two thousand characters is refused by its length alone, before any of it is normalized
    for kind in ("say", "whisper"):
        response = await post_message(client, copy, visitor.session_id, "½" * 2001, kind)
        assert (response.status_code, response.json()) == (422, {"code": "invalid"}), kind
    assert read == []


async def test_say_is_shown_as_typed_and_checked_as_read(app, client):
    copy, visitor = await visitor_of(app, client)
    # an ellipsis, a fraction, a ligature and an emoji stay as the owner typed them; only what no
    # font draws (here a zero-width space) is left out
    typed = "Running late\u2026 be there in \u00bd an hour, \ufb01ne by you? \U0001f642"
    result = await sent(client, copy, visitor.session_id, f"Running\u200b late{typed[12:]}")
    said = result.verdict
    assert said is not None and said.ok
    [block] = said.blocks
    assert (block.title, block.text) == (typed, typed)
    [fact] = await rows_of(app, copy.copy_id, select(FactRow).where(FactRow.kind == "owner_statement"))
    assert fact.claims == [Claim(key="text", kind="text", value=typed)]
    # every check reads the text in NFKC: a canary in full-width characters is blocked
    dana, *_ = await rows_of(app, copy.copy_id, select(Document).order_by(Document.document_id))
    wide = "".join(chr(ord(ch) + 0xFEE0) if "!" <= ch <= "~" else ch for ch in dana.canary)
    blocked = (await sent(client, copy, visitor.session_id, f"Your reference\u2026 {wide}")).verdict
    assert blocked is not None and (blocked.ok, blocked.blocks) == (False, [])
    assert [violation.kind for violation in blocked.violations] == ["canary"]
