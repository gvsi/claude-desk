"""The single-use link proxies (Plan 02b, Tasks 3 and 3b): a document link at `/api/d/{token}` and the mock checkout
at `/api/pay/{token}` (master plan, "Payment links").

The token in a link card's `href` is the only credential these routes take: the kernel checks it, and no cookie is
read. A document's bytes come once, and only to a GET that isn't a prefetch, so a HEAD, another method or a browser's
fetch ahead of a click never spends a link; the checkout reads, completes or cancels a payment link, and a completed
link's `payment_confirmed` line reaches its chat through `deliver()`. Tokens never reach a log line.

The app runs on FakeKernel and a scripted model. Links are issued on the fake with the visitor's own credential, as
Claude's tool calls would issue them, unless a test needs the chat that Claude's turn opens.
"""

import asyncio
import contextlib
import logging
import socket
from collections.abc import AsyncIterator
from datetime import timedelta

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text
from uvicorn.logging import TRACE_LOG_LEVEL, AccessFormatter

from desk.api.main import create_app
from desk.api.routes import proxy
from desk.kernel_api import PaymentLinkStateResult, PaymentLinkView
from tests.api.conftest import CLIENT_IP, Visitor, new_visitor
from tests.api.fakes import ScriptedModel, response, tool_use
from tests.api.test_loop_turns import tool_results
from tests.api.test_public_chat import Stream, cookie, events_path, new_slug, open_session, reply, types
from tests.api.test_secrets_at_rest import at_rest
from tests.api.test_verification import stored_events
from tests.kernel_contract.fake_kernel import Document, fake_kernel_app
from tests.kernel_contract.test_contract import cite, decide, execute, issue_payment_link, link_token

CREDENTIALS = ("x-session-token", "x-owner-session")
DOCUMENT_ROUTE = "GET /document_links/{token}"
# What a browser sends when the visitor opens a link card; an agent or a test asks for JSON.
BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
JSON = {"accept": "application/json"}
PRIVACY = {"cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
           "x-robots-tag": "noindex, nofollow"}
# A document link's refusals as a browser tab shows them, by status: (English, Spanish).
DOCUMENT_COPY = {
    404: ("This link was already opened or has expired. Ask in the chat for a new one.",
          "Este enlace ya se abrió o caducó. Pide uno nuevo en el chat."),
    422: ("This link doesn't look right. Open it again from the chat, or ask there for a new one.",
          "Este enlace no parece correcto. Ábrelo de nuevo desde el chat o pide uno nuevo allí."),
    429: ("That's a lot of requests at once. Wait a moment, then try again.",
          "Son muchas solicitudes a la vez. Espera un momento y vuelve a intentarlo."),
    503: ("Something went wrong on our side. Try again in a moment.",
          "Algo falló de nuestro lado. Inténtalo de nuevo en un momento."),
}
OTHER_REFUSAL = ("This link can't be opened. Ask in the chat for a new one.",
                 "Este enlace no se puede abrir. Pide uno nuevo en el chat.")


@pytest.fixture
def model() -> ScriptedModel:
    return ScriptedModel()


@pytest.fixture
async def app(db, fake, api_settings, clock, model) -> AsyncIterator[FastAPI]:
    app = create_app(api_settings, kernel_transport=httpx.ASGITransport(app=fake_kernel_app(fake)), model=model,
                     clock=clock, jobs_connector=InMemoryConnector())
    async with app.router.lifespan_context(app):
        yield app


async def released_document(kernel_http, fake) -> tuple[str, Document, Visitor]:
    """Dana's invoice released to a visitor verified as Dana: the link's token, the document and the visitor."""
    visitor = await new_visitor(kernel_http, fake)
    session_id = visitor.ids.session_id
    fake.verify(session_id, "dana")
    desk = fake.desks[visitor.ids.desk_id]
    invoice = next(document for document in desk.documents.values()
                   if document.record_owner_person_id == desk.person("dana").person_id)
    allowed = await decide(visitor.kernel, session_id, 0, "call-invoice", "native.release_document",
                           {"document_id": invoice.document_id})
    (fact,) = (await execute(visitor.kernel, allowed, 0)).facts
    verdict = await cite(visitor.kernel, session_id, 0, "Here is your invoice.", "document_link", fact.fact_id)
    return link_token(verdict, "/api/d/"), invoice, visitor


async def payment_link(kernel_http, fake) -> tuple[str, Visitor]:
    """A payment link for a visitor's quote of the service call deposit: its token and the visitor."""
    visitor = await new_visitor(kernel_http, fake)
    token, _ = await issue_payment_link(visitor.kernel, visitor.ids.session_id, "deposit", 1)
    return token, visitor


def conflict(state: str, cancel_reason: str | None = None) -> dict:
    """The checkout's 409: the link isn't `issued`, and how it stands now."""
    return {"error": "kernel", "code": "conflict", "state": state, "cancel_reason": cancel_reason}


def browser_with_cookies(app, browser, visitor: Visitor) -> httpx.AsyncClient:
    """A browser holding a visitor and an owner cookie on every API path, which the proxies must never send on."""
    client = browser(app)
    for name in ("desk_visitor", "desk_owner"):
        client.cookies.set(name, visitor.token, domain="desk.test", path="/api")
    return client


async def test_document_bytes_stream_once(app, browser, fake, kernel_http, db):
    token, invoice, visitor = await released_document(kernel_http, fake)
    client = browser_with_cookies(app, browser, visitor)
    fake.calls.clear()

    opened = await client.get(f"/api/d/{token}")
    assert opened.status_code == 200 and opened.content == invoice.body.encode()
    (call,) = fake.calls                                       # the link alone, with no other credential
    assert (call.route, call.path) == ("GET /document_links/{token}", f"/document_links/{token}")
    assert not [name for name in CREDENTIALS if name in call.headers] and "cookie" not in call.headers

    # Opened, unknown or past its day, a link answers the same 404, whatever the kernel's reason (asked as JSON here;
    # a browser gets static copy, `test_document_refusals_read_as_copy_in_a_browser`).
    later, _, _ = await released_document(kernel_http, fake)
    fake.now += timedelta(hours=24)
    for gone in (token, "no-such-link", later):
        refused = await client.get(f"/api/d/{gone}", headers=JSON)
        assert (refused.status_code, refused.json()) == (404, {"error": "link_used_or_expired"})

    # A kernel that can't answer leaves the link as it was, and the visitor can try again.
    again, invoice, _ = await released_document(kernel_http, fake)
    fake.fail(DOCUMENT_ROUTE, "timeout", times=1)
    unavailable = await client.get(f"/api/d/{again}", headers=JSON)
    assert (unavailable.status_code, unavailable.json()) == (503, {"error": "kernel", "code": "kernel_unavailable"})
    assert (await client.get(f"/api/d/{again}")).content == invoice.body.encode()
    assert [link for link in (token, later, again) if link in at_rest(db)] == []        # nothing kept the tokens


async def test_document_response_headers(app, browser, fake, kernel_http):
    token, _, visitor = await released_document(kernel_http, fake)
    client = browser_with_cookies(app, browser, visitor)

    opened = await client.get(f"/api/d/{token}")
    assert opened.status_code == 200
    assert {name: opened.headers.get(name) for name in (
        "content-type", "content-disposition", "cache-control", "x-content-type-options", "referrer-policy")} == {
        "content-type": "text/plain; charset=utf-8", "content-disposition": "inline", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "referrer-policy": "no-referrer"}
    assert "set-cookie" not in opened.headers

    # The kernel's own content type passes through, and its disposition too for a type the tab may show; with no
    # content type, the bytes are only bytes, and are downloaded rather than shown
    # (`test_only_a_document_that_cant_run_script_opens_in_the_tab`).
    answers = []
    for content_type, disposition in (("application/pdf", 'attachment; filename="invoice.pdf"'), (None, None)):
        other, document, _ = await released_document(kernel_http, fake)
        document.content_type, document.disposition = content_type, disposition
        answers.append((await client.get(f"/api/d/{other}"), document))
    (attached, _), (untyped, _) = answers
    assert (attached.headers["content-type"], attached.headers["content-disposition"]) == (
        "application/pdf", 'attachment; filename="invoice.pdf"')
    assert (untyped.headers["content-type"], untyped.headers["content-disposition"]) == (
        "application/octet-stream", "attachment")
    for answer, document in answers:
        assert answer.content == document.body.encode()
        assert (answer.headers["cache-control"], answer.headers["x-content-type-options"],
                answer.headers["referrer-policy"]) == ("no-store", "nosniff", "no-referrer")


async def test_document_headers_pass_the_kernels_through(app, browser, fake, kernel_http):
    client = browser(app)
    names = (*PRIVACY, "set-cookie", "x-kernel-trace")

    def sent(answer: httpx.Response) -> dict:
        return {name: answer.headers.get_list(name) for name in names}

    # The kernel's `nosniff` and referrer policy pass through as it sends them, each once. Whatever else it says, the
    # document is kept out of caches and search indexes, and nothing else of the kernel's is sent on.
    token, document, _ = await released_document(kernel_http, fake)
    document.headers = {"X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
                        "Cache-Control": "public, max-age=3600", "X-Robots-Tag": "all", "Set-Cookie": "kernel=1",
                        "X-Kernel-Trace": "abc"}
    opened = await client.get(f"/api/d/{token}")
    assert (opened.status_code, opened.content) == (200, document.body.encode())
    assert sent(opened) == {"cache-control": ["no-store"], "x-content-type-options": ["nosniff"],
                            "referrer-policy": ["same-origin"], "x-robots-tag": ["noindex, nofollow"],
                            "set-cookie": [], "x-kernel-trace": []}

    # With none of the kernel's, or an empty one, the API's own stand: never sniffed, and no referrer at all.
    for headers in ({}, {"X-Content-Type-Options": "", "Referrer-Policy": ""}):
        other, document, _ = await released_document(kernel_http, fake)
        document.headers = headers
        opened = await client.get(f"/api/d/{other}")
        assert (opened.status_code, opened.content) == (200, document.body.encode())
        assert sent(opened) == {**{name: [value] for name, value in PRIVACY.items()},
                                "set-cookie": [], "x-kernel-trace": []}, headers

    # `nosniff` is the only value that header has, so the kernel's passes through, in whatever case, only when it says
    # that: anything else (a kernel bug) would let a browser sniff the document, and the API's own `nosniff` stands.
    for value, expected in (("NoSniff", "NoSniff"), ("sniff", "nosniff"), ("none", "nosniff"),
                            ("nosniff, sniff", "nosniff")):
        other, document, _ = await released_document(kernel_http, fake)
        document.headers = {"X-Content-Type-Options": value}
        opened = await client.get(f"/api/d/{other}")
        assert (opened.status_code, opened.content) == (200, document.body.encode())
        privacy = {**PRIVACY, "x-content-type-options": expected}
        assert sent(opened) == {**{name: [header] for name, header in privacy.items()},
                                "set-cookie": [], "x-kernel-trace": []}, value


async def test_only_a_document_that_cant_run_script_opens_in_the_tab(app, browser, fake, kernel_http):
    client = browser(app)

    async def opened(content_type: str | None, disposition: str | None) -> httpx.Response:
        token, document, _ = await released_document(kernel_http, fake)
        # The kernel's content type exactly as given: the fake's own would add a charset to a bare `text/` type.
        document.content_type, document.disposition = None, disposition
        document.headers = {"Content-Type": content_type} if content_type else {}
        answer = await client.get(f"/api/d/{token}")
        assert (answer.status_code, answer.content) == (200, document.body.encode()), content_type
        assert answer.headers["x-content-type-options"] == "nosniff", content_type
        return answer

    def shown(answer: httpx.Response) -> tuple[str, str, list[str]]:
        return (answer.headers["content-type"], answer.headers["content-disposition"],
                answer.headers.get_list("content-security-policy"))

    # A document opens on the API's own origin, so the tab shows only a type that can't run script there, with the
    # kernel's disposition and no sandbox: a browser won't show a PDF inline under one.
    for content_type, disposition, expected in (
            ("application/pdf", None, "inline"),
            ("Application/PDF", 'inline; filename="invoice.pdf"', 'inline; filename="invoice.pdf"'),
            ("application/pdf", 'attachment; filename="invoice.pdf"', 'attachment; filename="invoice.pdf"'),
            ("image/png", None, "inline"), ("image/jpeg", None, "inline"), ("image/gif", None, "inline"),
            ("image/webp", None, "inline"), ("text/plain; charset=utf-8", None, "inline")):
        assert shown(await opened(content_type, disposition)) == (content_type, expected, []), content_type

    # Any other type (a page, an SVG, XML, or bytes the kernel leaves untyped) could run script on the API's origin if
    # shown there: it is downloaded instead, under the kernel's file name, and sandboxed should a browser show it.
    for content_type, disposition, expected in (
            ("text/html; charset=utf-8", None, "attachment"),
            ("image/svg+xml", 'inline; filename="plan.svg"', 'attachment; filename="plan.svg"'),
            ("application/xhtml+xml", "INLINE", "attachment"),
            ("text/xml; charset=utf-8", 'attachment; filename="feed.xml"', 'attachment; filename="feed.xml"'),
            (None, None, "attachment"),
            # A browser reads a comma as separating types and takes the last one it understands, so a type with a
            # comma anywhere may name another after the one on the list (an HTML page, an SVG): it is downloaded.
            ("text/plain; charset=utf-8, text/html", None, "attachment"),
            ("image/png;x=1, image/svg+xml", 'inline; filename="logo.png"', 'attachment; filename="logo.png"'),
            ("text/plain,text/html", None, "attachment"),
            ("text/plain, text/html", None, "attachment")):
        assert shown(await opened(content_type, disposition)) == (
            content_type or "application/octet-stream", expected, ["sandbox"]), content_type
    # Two Content-Type headers from the kernel reach the API as one value joined by a comma, the last case above.
    assert httpx.Headers([("content-type", "text/plain"), ("content-type", "text/html")])["content-type"] == (
        "text/plain, text/html")


def refusal_headers(answer: httpx.Response) -> dict:
    return {name: answer.headers.get(name) for name in (
        "content-type", "content-language", "vary", "set-cookie", *PRIVACY)}


async def test_document_refusals_read_as_copy_in_a_browser(app, browser, fake, kernel_http):
    token, _, _ = await released_document(kernel_http, fake)
    client = browser(app)
    assert (await client.get(f"/api/d/{token}")).status_code == 200
    unopened, invoice, _ = await released_document(kernel_http, fake)

    # A browser tab is the only screen a document link has, so a refusal there is short static copy, never JSON: in
    # Spanish when the browser prefers it to English, else in English. The status and the privacy headers stay.
    refusals = ((404, f"/api/d/{token}"), (404, "/api/d/no-such-link"), (404, "/api/d/a-link/with-more"),
                (422, "/api/d/not.a.token"), (503, f"/api/d/{unopened}"))
    languages = ((None, "en"), ("en-US,en;q=0.9", "en"), ("es-MX,es;q=0.9,en;q=0.8", "es"), ("fr-FR, es;q=0.5", "es"),
                 ("es;q=0.4, en-GB;q=0.8", "en"), ("es;q=0, *;q=0.1", "en"), ("en, es", "en"), ("es, en", "es"))
    for status, path in refusals:
        for accept_language, language in languages:
            if status == 503:
                fake.fail(DOCUMENT_ROUTE, "timeout", times=1)
            headers = {"accept": BROWSER_ACCEPT, **({"accept-language": accept_language} if accept_language else {})}
            refused = await client.get(path, headers=headers)
            assert (refused.status_code, refused.text) == (status, DOCUMENT_COPY[status][language == "es"]), (
                path, accept_language)
            assert refusal_headers(refused) == {"content-type": "text/plain; charset=utf-8", "content-language": language,
                                                "vary": "accept, accept-language", "set-cookie": None, **PRIVACY}
    # With no `Accept` at all, or one that takes anything, it is the same copy.
    for headers in ({}, {"accept": "*/*"}, {"accept": "application/json;q=0"}):
        refused = await client.get(f"/api/d/{token}", headers=headers)
        assert (refused.status_code, refused.text) == (404, DOCUMENT_COPY[404][0]), headers

    # An agent or a test that asks for JSON gets the `ApiError`, with the same status and headers.
    for status, path, body in ((404, f"/api/d/{token}", {"error": "link_used_or_expired"}),
                               (422, "/api/d/not.a.token", {"error": "invalid"}),
                               (503, f"/api/d/{unopened}", {"error": "kernel", "code": "kernel_unavailable"})):
        for accept in ("application/json", "text/plain;q=0.5, application/json"):
            if status == 503:
                fake.fail(DOCUMENT_ROUTE, "timeout", times=1)
            refused = await client.get(path, headers={"accept": accept, "accept-language": "es"})
            assert (refused.status_code, refused.json()) == (status, body), (path, accept)
            assert refusal_headers(refused) == {"content-type": "application/json", "content-language": None,
                                                "vary": "accept, accept-language", "set-cookie": None, **PRIVACY}
    # The kernel never answered for the link that met an outage, so it still opens.
    assert (await client.get(f"/api/d/{unopened}")).content == invoice.body.encode()


async def test_other_document_refusals_read_as_the_nearest_copy(app, browser, fake, kernel_http, monkeypatch):
    # Answers an app error as the server would (500), not by raising it in the test.
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(CLIENT_IP, 50000),
                                                             raise_app_exceptions=False), base_url="https://desk.test")
    token, invoice, _ = await released_document(kernel_http, fake)
    browsing = {"accept": BROWSER_ACCEPT}

    # A failure of the API's own (500) reads as the line for something gone wrong on our side, as a 503 does.
    async def broken(request):
        raise RuntimeError("the route broke")

    with monkeypatch.context() as patched:
        patched.setattr(proxy, "_proxy", broken)
        for accept_language, language in ((None, 0), ("es", 1)):
            failed = await client.get(f"/api/d/{token}", headers={**browsing, **(
                {"accept-language": accept_language} if accept_language else {})})
            assert (failed.status_code, failed.text) == (500, DOCUMENT_COPY[503][language])
            assert refusal_headers(failed)["cache-control"] == "no-store"
        failed = await client.get(f"/api/d/{token}", headers=JSON)
        assert (failed.status_code, failed.json()) == (500, {"error": "internal"})

    # Any other refusal, such as a method the link doesn't take or a kernel conflict, reads as the general line.
    for status, answer in ((405, client.post(f"/api/d/{token}", headers=browsing)),
                           (405, client.delete(f"/api/d/{token}", headers={**browsing, "accept-language": "es"}))):
        refused = await answer
        assert refused.status_code == status and refused.text in OTHER_REFUSAL
    assert (refused.text, refused.headers["content-language"]) == (OTHER_REFUSAL[1], "es")
    fake.fail(DOCUMENT_ROUTE, "409", times=1)
    refused = await client.get(f"/api/d/{token}", headers=browsing)
    assert (refused.status_code, refused.text) == (409, OTHER_REFUSAL[0])
    assert refusal_headers(refused) == {"content-type": "text/plain; charset=utf-8", "content-language": "en",
                                        "vary": "accept, accept-language", "set-cookie": None, **PRIVACY}
    assert (await client.get(f"/api/d/{token}")).content == invoice.body.encode()   # none of these spent the link
    await client.aclose()


async def test_head_and_other_methods_never_spend_a_link(app, browser, fake, kernel_http):
    token, invoice, _ = await released_document(kernel_http, fake)
    client = browser(app)
    fake.calls.clear()

    # A link checker or an unfurler that looks first with HEAD gets the document's headers and no body, whatever the
    # token names: only a GET asks the kernel, so a HEAD can't tell an open link from a spent one, and spends nothing.
    for path in (f"/api/d/{token}", f"/api/d/{token}", "/api/d/no-such-link"):
        looked = await client.head(path)
        assert (looked.status_code, looked.content) == (200, b""), path
        assert {name: looked.headers.get(name) for name in (*PRIVACY, "content-type", "set-cookie")} == {
            **PRIVACY, "content-type": None, "set-cookie": None}, path
    # One that can't be a link's token at all is refused as a GET for it would be, in the tab's copy.
    refused = await client.head("/api/d/bad!token", headers={"accept": BROWSER_ACCEPT})
    assert refused.status_code == 422
    assert refusal_headers(refused) == {"content-type": "text/plain; charset=utf-8", "content-language": "en",
                                        "vary": "accept, accept-language", "set-cookie": None, **PRIVACY}

    # Every other method is refused as one the link doesn't take, in the tab's copy, and says which it does.
    for method in ("POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"):
        refused = await client.request(method, f"/api/d/{token}", headers={"accept": BROWSER_ACCEPT})
        assert (refused.status_code, refused.text, refused.headers.get("allow")) == (
            405, OTHER_REFUSAL[0], "GET, HEAD"), method
        assert refusal_headers(refused) == {"content-type": "text/plain; charset=utf-8", "content-language": "en",
                                            "vary": "accept, accept-language", "set-cookie": None, **PRIVACY}, method
    assert fake.calls == []

    # The link is still unspent, and opens once.
    opened = await client.get(f"/api/d/{token}")
    assert (opened.status_code, opened.content) == (200, invoice.body.encode())
    assert (await client.get(f"/api/d/{token}", headers=JSON)).status_code == 404


async def test_prefetch_never_spends_a_link(app, browser, fake, kernel_http):
    token, invoice, _ = await released_document(kernel_http, fake)
    client = browser(app)
    fake.calls.clear()

    # What a browser sends when it fetches a link ahead of a click (Chrome's speculation rules, Firefox's link
    # prefetch, a prerender, and older Firefox's and Safari's own headers): told to come back now, so the visitor's own
    # click opens the link.
    purposes = ({"sec-purpose": "prefetch"}, {"sec-purpose": "prefetch;prerender"},
                {"sec-purpose": "prefetch; anonymous-client-ip"}, {"sec-purpose": "prerender"},
                {"purpose": "prefetch"}, {"Purpose": "Prefetch"}, {"x-other": "1", "sec-purpose": " PREFETCH "},
                {"x-moz": "prefetch"}, {"X-Purpose": "preview"})
    for purpose in purposes:
        for accept_language, language in ((None, 0), ("es", 1)):
            early = await client.get(f"/api/d/{token}", headers={"accept": BROWSER_ACCEPT, **purpose, **(
                {"accept-language": accept_language} if accept_language else {})})
            assert (early.status_code, early.headers.get("retry-after"), early.text) == (
                503, "0", DOCUMENT_COPY[503][language]), purpose
            assert refusal_headers(early) == {
                "content-type": "text/plain; charset=utf-8", "content-language": "es" if language else "en",
                "vary": "accept, accept-language", "set-cookie": None, **PRIVACY}, purpose
        asked = await client.get(f"/api/d/{token}", headers={**JSON, **purpose})
        assert (asked.status_code, asked.headers.get("retry-after"), asked.json()) == (
            503, "0", {"error": "prefetch"}), purpose
    assert fake.calls == []

    # Any other purpose, or none, is the visitor opening the link: it opens once.
    opened = await client.get(f"/api/d/{token}", headers={"sec-purpose": "", "purpose": "navigate"})
    assert (opened.status_code, opened.content) == (200, invoice.body.encode())
    assert [call.route for call in fake.calls] == [DOCUMENT_ROUTE]


async def test_checkout_view_and_complete(app, browser, fake, kernel_http, db):
    token, visitor = await payment_link(kernel_http, fake)
    client = browser_with_cookies(app, browser, visitor)
    expected = await kernel_http.public().call("GET /payment_links/{token}", path={"token": token})
    fake.calls.clear()

    shown = await client.get(f"/api/pay/{token}")
    assert (shown.status_code, shown.json()) == (200, expected.model_dump(mode="json"))
    assert shown.json()["state"] == "issued" and shown.headers["cache-control"] == "no-store"
    paid = await client.post(f"/api/pay/{token}/complete")
    assert paid.status_code == 200
    result = PaymentLinkStateResult.model_validate(paid.json())
    assert (result.state, result.session_id) == ("paid", visitor.ids.session_id)
    assert [block.template for block in result.verdict.blocks] == ["payment_confirmed"]
    # The kernel saw the link's token and nothing else: no session, owner or cookie.
    assert [(call.route, call.path) for call in fake.calls] == [
        ("GET /payment_links/{token}", f"/payment_links/{token}"),
        ("POST /payment_links/{token}/complete", f"/payment_links/{token}/complete")]
    assert not [call for call in fake.calls if {*CREDENTIALS, "cookie"} & set(call.headers)]

    # Paid once: completing or cancelling again is the kernel's 409, with the link as it reads now.
    for step in ("complete", "cancel"):
        again = await client.post(f"/api/pay/{token}/{step}")
        assert (again.status_code, again.json()) == (409, conflict("paid"))
    assert len(fake.called("POST /payment_links/{token}/complete")) == 2

    # A link cancelled at checkout pays nothing and has no verdict; it can't be paid after.
    other, its_visitor = await payment_link(kernel_http, fake)
    cancelled = await client.post(f"/api/pay/{other}/cancel")
    assert (cancelled.status_code, cancelled.json()) == (
        200, {"state": "cancelled", "session_id": its_visitor.ids.session_id, "verdict": None})
    assert (await client.post(f"/api/pay/{other}/complete")).json() == conflict("cancelled")

    # A token that names no link is the kernel's 404; one that can't be a token never reaches the kernel.
    for method, path in (("GET", "/api/pay/no-such-link"), ("POST", "/api/pay/no-such-link/complete")):
        unknown = await client.request(method, path)
        assert (unknown.status_code, unknown.json()) == (404, {"error": "kernel", "code": "not_found"})
    fake.calls.clear()
    malformed = await client.get("/api/pay/not.a.token")
    assert (malformed.status_code, malformed.json(), fake.calls) == (422, {"error": "invalid"}, [])
    assert [link for link in (token, other) if link in at_rest(db)] == []                # nothing kept the tokens


def done(request) -> dict:
    """What the one tool call Claude's last request answers as done gave it (its `model_view`)."""
    (result,) = [result for result in tool_results(request) if result["content"]["outcome"] == "done"]
    return result["content"]["result"]


async def test_completed_link_publishes_payment_confirmed(app, browser, fake, kernel_http, model, engine):
    slug = await new_slug(kernel_http, fake)
    client, token, opened = await open_session(app, browser, slug)
    session_id = opened["state"]["session_id"]
    # Claude quotes the deposit, issues its payment link and shows the link's card.
    model.add(response(tool_use("native__quote", {"items": [{"item_id": "deposit", "qty": 1}]})),
              lambda request: response(tool_use("native__payment_link", {"quote_id": done(request)["quote_id"]})),
              lambda request: response(reply("Here's the link to pay the deposit.",
                                             {"template": "payment_link", "fact_id": done(request)["fact_id"]})))
    checkout = browser(app, ip="198.51.100.50")               # the checkout page, which holds no cookie

    async with Stream(app, events_path(slug), headers=[cookie(token)]) as stream:
        sent = await client.post(f"/api/public/desks/{slug}/messages", json={"text": "Can I pay the deposit now?"})
        assert sent.status_code == 202
        events = await stream.until(lambda events: "turn_end" in types(events))
        (card,) = [block for _, event in events if event.type == "message" for block in event.blocks
                   if block.template == "payment_link"]
        link = card.href.removeprefix("/pay/")
        # The owner has taken the chat over by the time the visitor pays: the kernel signs the confirmation at the
        # session's current generation, so it is shown.
        assert fake.set_mode(session_id, "owner").generation == 1
        paid = await checkout.post(f"/api/pay/{link}/complete")
        assert paid.status_code == 200
        events = await stream.until(lambda events: types(events).count("message") == 2)
    await app.state.runtime.runner.drain()

    verdict = PaymentLinkStateResult.model_validate(paid.json()).verdict
    confirmed = events[-1][1]
    assert confirmed.type == "message" and [block.template for block in confirmed.blocks] == ["payment_confirmed"]
    assert (confirmed.author, confirmed.generation, confirmed.message_id, confirmed.blocks, confirmed.signature) == (
        "desk", 1, verdict.message_id, verdict.blocks, verdict.signature)
    async with engine.connect() as conn:
        delivered = (await conn.execute(text("SELECT author, ref_id FROM app.messages WHERE session_id = :s"
                                             " AND kind = 'delivered' ORDER BY n"), {"s": session_id})).all()
    assert [tuple(row) for row in delivered][-1] == ("desk", verdict.message_id)

    # Completing again is the kernel's 409, and nothing more reaches the chat.
    again = await checkout.post(f"/api/pay/{link}/complete")
    assert (again.status_code, again.json()) == (409, conflict("paid"))
    assert len(await stored_events(engine, session_id, "message")) == 2


async def test_link_cancelled_by_a_rule_change_says_so_at_checkout(app, browser, fake, kernel_http):
    token, visitor = await payment_link(kernel_http, fake)
    # The owner lowers the payment-link card below the deposit: the activation cancels the open link.
    (link_id,) = fake.lower_link_limit(visitor.ids.desk_id, 1000)
    assert (fake.payment_links[link_id].state, fake.payment_links[link_id].cancel_reason) == (
        "cancelled", "rules_changed")
    # The kernel's view, which the checkout gets unchanged. Once `PaymentLinkView` carries `cancel_reason`,
    # `business_name` and `customer_name` (the kernel plans' contract deltas), they are in it, and checked below.
    expected = (await kernel_http.public().call("GET /payment_links/{token}", path={"token": token})).model_dump(
        mode="json")
    # The day `cancel_reason` joins the contract, this fails until the fake serves the link's reason too.
    landed = "cancel_reason" in PaymentLinkView.model_fields
    assert expected.get("cancel_reason") == ("rules_changed" if landed else None)
    client = browser(app)

    shown = await client.get(f"/api/pay/{token}")
    assert (shown.status_code, shown.json()) == (200, expected) and expected["state"] == "cancelled"
    for step in ("complete", "cancel"):
        refused = await client.post(f"/api/pay/{token}/{step}")
        assert (refused.status_code, refused.json()) == (409, conflict("cancelled", expected.get("cancel_reason")))


UVICORN_LOGGERS = ("uvicorn.error", "uvicorn.access", "uvicorn.asgi")


@contextlib.asynccontextmanager
async def served(app: FastAPI) -> AsyncIterator[str]:
    """The app (its lifespan already running) on a uvicorn server on a loopback port, logging every request to its
    access log and, at trace level, each ASGI scope and message; yields the server's URL."""
    levels = {name: logging.getLogger(name).level for name in UVICORN_LOGGERS}
    listening = socket.socket()
    listening.bind(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(app, lifespan="off", log_config=None, log_level="trace"))
    serving = asyncio.create_task(server.serve(sockets=[listening]))
    try:
        async with asyncio.timeout(5):
            while not server.started:
                await asyncio.sleep(0.01)
        yield f"http://127.0.0.1:{listening.getsockname()[1]}"
    finally:
        server.should_exit = True
        await asyncio.wait_for(serving, 5)
        listening.close()
        for name, level in levels.items():
            logging.getLogger(name).setLevel(level)


def shown(record: logging.LogRecord) -> str:
    """Everything a handler could write for the record."""
    return logging.Formatter().format(record) + repr(record.args) + (record.stack_info or "")


async def test_proxy_tokens_are_redacted_in_logs(app, fake, kernel_http, caplog):
    caplog.set_level(TRACE_LOG_LEVEL)
    document, _, _ = await released_document(kernel_http, fake)
    paying, _ = await payment_link(kernel_http, fake)
    tokens = (document, paying)

    async with served(app) as url, httpx.AsyncClient(base_url=url) as client:     # httpx logs each request's URL
        assert (await client.get(f"/api/d/{document}")).status_code == 200
        assert (await client.get(f"/api/pay/{paying}")).status_code == 200
        assert (await client.post(f"/api/pay/{paying}/complete")).status_code == 200
        assert (await client.post(f"/api/pay/{paying}/cancel?from=checkout")).status_code == 409
    # Any logger, the app's own included, naming the API's paths or the kernel's token routes, even in a traceback.
    logging.getLogger("desk.api.proxy").warning("checkout at /pay/%s", paying)
    kernel_url = httpx.URL(f"http://127.0.0.1:8701/document_links/{document}")
    logging.getLogger("httpx").info("HTTP Request: %s %s", "GET", kernel_url)
    try:
        raise RuntimeError(f"POST /payment_links/{paying}/complete failed")
    except RuntimeError:
        logging.getLogger("some.library").exception("the kernel call for %s failed", {"path": f"/api/d/{document}"})

    access = [record for record in caplog.records if record.name == "uvicorn.access"]
    formatted = [AccessFormatter('%(client_addr)s - "%(request_line)s" %(status_code)s', use_colors=False).format(
        record) for record in access]
    assert [line.split('"')[1] for line in formatted] == [
        "GET /api/d/<redacted> HTTP/1.1", "GET /api/pay/<redacted> HTTP/1.1",
        "POST /api/pay/<redacted>/complete HTTP/1.1", "POST /api/pay/<redacted>/cancel?from=checkout HTTP/1.1"]
    client_lines = [record.getMessage() for record in caplog.records if record.name == "httpx"]
    assert len(client_lines) == 5 and all("<redacted>" in line for line in client_lines)
    assert any(record.name == "uvicorn.asgi" and "scope=" in record.getMessage() for record in caplog.records)
    leaked = [(record.name, token) for record in caplog.records for token in tokens if token in shown(record)]
    assert leaked == [] and not [token for token in tokens if token in caplog.text]


async def test_document_paths_never_reach_the_logs(app, fake, kernel_http, caplog, monkeypatch, db):
    caplog.set_level(TRACE_LOG_LEVEL)
    opened, _, _ = await released_document(kernel_http, fake)
    unopened, _, _ = await released_document(kernel_http, fake)
    tokens = (opened, unopened)

    async def broken(request):
        raise RuntimeError(f"the route broke at {request.url}")

    # Every way a document link is answered: opened, refused, looked at, prefetched, the wrong method, the kernel
    # down or failing, and a failure of the API's own.
    answers = []
    async with served(app) as url, httpx.AsyncClient(base_url=url, headers={"accept": BROWSER_ACCEPT}) as client:
        answers += [await client.get(f"/api/d/{opened}"), await client.get(f"/api/d/{opened}"),
                    await client.head(f"/api/d/{unopened}"),
                    await client.get(f"/api/d/{unopened}", headers={"sec-purpose": "prefetch"}),
                    await client.post(f"/api/d/{unopened}"), await client.delete(f"/api/d/{unopened}")]
        for failure in ("timeout", "500"):
            fake.fail(DOCUMENT_ROUTE, failure, times=1)
            answers.append(await client.get(f"/api/d/{unopened}?from=chat"))
        with monkeypatch.context() as patched:
            patched.setattr(proxy, "_proxy", broken)
            answers.append(await client.get(f"/api/d/{unopened}"))
    assert [answer.status_code for answer in answers] == [200, 404, 200, 503, 405, 405, 503, 503, 500]

    access = [AccessFormatter('"%(request_line)s" %(status_code)s', use_colors=False).format(record)
              for record in caplog.records if record.name == "uvicorn.access"]
    assert [line.split('"')[1] for line in access] == [
        "GET /api/d/<redacted> HTTP/1.1", "GET /api/d/<redacted> HTTP/1.1", "HEAD /api/d/<redacted> HTTP/1.1",
        "GET /api/d/<redacted> HTTP/1.1", "POST /api/d/<redacted> HTTP/1.1", "DELETE /api/d/<redacted> HTTP/1.1",
        "GET /api/d/<redacted>?from=chat HTTP/1.1", "GET /api/d/<redacted>?from=chat HTTP/1.1",
        "GET /api/d/<redacted> HTTP/1.1"]
    # The kernel client keeps its own requests out of httpx's logs, so no line names the kernel's link route at all.
    assert [record.name for record in caplog.records if "/document_links/" in shown(record)] == []
    # The API's own failure is logged by its type and route only (its message names the link), and the server's
    # line about it drops the exception.
    assert [record.name for record in caplog.records if "the route broke" in shown(record)] == []
    (crash,) = [record for record in caplog.records if record.name == "desk.api.unexpected_errors"]
    assert crash.getMessage() == "unexpected RuntimeError on GET /api/d/<redacted>"
    assert any(record.name == "uvicorn.error" and record.getMessage().startswith("Exception in ASGI application")
               for record in caplog.records)
    assert any(record.name == "uvicorn.asgi" and "scope=" in record.getMessage() for record in caplog.records)
    leaked = [(record.name, token) for record in caplog.records for token in tokens if token in shown(record)]
    assert leaked == [] and not [token for token in tokens if token in caplog.text]

    # No answer, no ledger entry and no row of the API's names a link either.
    assert not [token for answer in answers for token in tokens
                if token in answer.text or token in str(answer.headers.raw)]
    assert fake.called("POST /ledger/append") == []
    assert not [token for desk in fake.desks.values() for entry in desk.ledger for token in tokens
                if token in entry.model_dump_json()]
    assert [token for token in tokens if token in at_rest(db)] == []


async def test_proxies_share_the_per_address_limit(app, browser, fake, kernel_http, clock):
    token, _ = await payment_link(kernel_http, fake)
    client = browser(app)
    routes = [("GET", "/api/d/no-such-link"), ("GET", f"/api/pay/{token}"), ("POST", "/api/pay/no-such-link/complete"),
              ("POST", "/api/pay/no-such-link/cancel")]

    # Sixty link requests in ten minutes from one address, across the four routes; then each route is refused.
    answered = [(await client.request(method, path)).status_code for _ in range(15) for method, path in routes]
    assert answered == [404, 200, 404, 404] * 15
    fake.calls.clear()
    for method, path in routes:
        refused = await client.request(method, path, headers=JSON)
        assert (refused.status_code, refused.json()) == (429, {"error": "rate_limited", "retry_after": 600})
    # A browser opening a document link is told to wait, in its tab's copy, with the same `Retry-After`.
    waiting = await client.get("/api/d/no-such-link", headers={"accept": BROWSER_ACCEPT, "accept-language": "es"})
    assert (waiting.status_code, waiting.text, waiting.headers["retry-after"]) == (429, DOCUMENT_COPY[429][1], "600")
    assert refusal_headers(waiting) == {"content-type": "text/plain; charset=utf-8", "content-language": "es",
                                        "vary": "accept, accept-language", "set-cookie": None, **PRIVACY}
    assert fake.calls == []                   # refused before the kernel; with no credential, nothing is ledgered
    assert (await browser(app, ip="198.51.100.60").get(f"/api/pay/{token}")).status_code == 200
    clock.advance(600)
    assert (await client.get(f"/api/pay/{token}")).status_code == 200
