"""The single-use link proxies: a document link at `/api/d/{token}` and the mock checkout at `/api/pay/{token}`.

A link's token is the only credential these routes take, and it authenticates only its own document or payment link:
the kernel checks it. No cookie is read or set, and every kernel call goes through the public view, which carries no
other credential. Each route counts against the per-address `proxy` limit. A token is never stored, and every log
line naming one of these paths, or the kernel's link routes, has it redacted (`log_redaction`).

- A document streams from the kernel as it serves it, once, with the kernel's content type and headers that keep it
  out of caches, content sniffing, referrers and search indexes (the kernel's own `nosniff` and referrer policy pass
  through). It opens on the API's own origin, so only a type that can't run script there (a PDF, a PNG, JPEG, GIF or
  WebP image, plain text) keeps the kernel's disposition (`inline` by default); any other is downloaded as an
  attachment under a `sandbox` policy. Opened, expired or unknown links answer the same 404. A browser tab is
  the only screen a document link has, so every refusal on `/api/d/` keeps its status and those headers but reads as
  short static copy, in Spanish when the browser prefers it to English, else in English (`document_refusal`); only a
  request that asks for JSON gets the `ApiError`.
- Since opening a document link uses it up, only a GET that isn't a prefetch asks the kernel for it. A HEAD (a link
  checker or an unfurler looking first) answers 200 with the headers and no body, any other method 405, and a
  browser's fetch ahead of a click (`Sec-Purpose` or `Purpose`: `prefetch`, `prerender`; `X-Moz: prefetch`;
  `X-Purpose: preview`) 503 with `Retry-After: 0`; none of them spends the link. An unfurler that opens the link with
  a plain GET still uses it up, as the visitor would: the web's link card is the one to render it without prefetch,
  and the visitor can ask in the chat for a new link.
- The checkout page reads the kernel's `PaymentLinkView` unchanged, and completes or cancels the link. A link that
  isn't `issued` is the kernel's 409, answered with how the link stands now (`PaymentConflict`). A completion's
  `payment_confirmed` verdict is shown in the link's chat as the Desk's message, through `deliver()`, which drops it
  once the session's generation has moved on (master plan, "Payment links").
"""

import logging
import re
from collections.abc import Callable
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Path, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.types import Receive, Scope, Send

from desk.api.deliver import Reply, deliver
from desk.api.deps import ApiProblem, Runtime, client_ip, runtime
from desk.api.kernel_client import KernelFailed, KernelUnavailable, KernelView
from desk.api.ro import kernel_session
from desk.api.schemas import ApiError, PaymentConflict, error_responses, operation_ids
from desk.api.store import Ids
from desk.kernel_api import PaymentLinkActionRequest, PaymentLinkStateResult, PaymentLinkView

router = APIRouter(prefix="/api", generate_unique_id_function=operation_ids("proxy"))
logger = logging.getLogger(__name__)
# A link token as the kernel mints them (`secrets.token_urlsafe(32)`), with room to spare: anything else names no link.
Token = Annotated[str, Path(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")]
DOCUMENT_ROUTE = "GET /document_links/{token}"
# A document is a visitor's own private data: never kept by a cache, never sniffed into something it isn't, its
# address (which holds the token) never sent on as a referrer, and never indexed or followed by a crawler.
DOCUMENT_HEADERS = {"cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
                    "x-robots-tag": "noindex, nofollow"}
# Of those, the ones the kernel may send with a document's bytes, each with the values of it that pass through
# unchanged; the API's stand for any it leaves out, sends empty or sends otherwise. `nosniff` is the only value
# `X-Content-Type-Options` has, so any other (a kernel bug) would let a browser sniff the document: the API's stands.
# Nothing else of the kernel's headers is sent on but the content type and disposition.
KERNEL_DOCUMENT_HEADERS: dict[str, Callable[[str], bool]] = {
    "x-content-type-options": lambda value: value.lower() == "nosniff",
    "referrer-policy": bool,
}
# The types a browser shows in the tab without running script in them. A document opens on the API's own origin, so
# one of any other type (a page, an SVG, XML, or bytes the kernel leaves untyped) is downloaded instead, and sandboxed
# should a browser show it anyway. A PDF is never sandboxed: a browser won't show one inline under a sandbox.
INLINE_TYPES = frozenset({"application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"})
DOWNLOAD_HEADERS = {"content-security-policy": "sandbox"}
DOCUMENT_PATH = "/api/d/"
# What a document link takes: GET opens it (once), HEAD looks without opening it; any other method is 405.
DOCUMENT_METHODS = "GET, HEAD"
# What a browser says when it fetches a link ahead of a click, by header: `Sec-Purpose` (or the older `Purpose`), older
# Firefox's `X-Moz` and older Safari's `X-Purpose`. Such a fetch would open the link before the visitor does, so it is
# told to come back now (503, `Retry-After: 0`) and the click opens it.
PREFETCH_PURPOSES: dict[str, frozenset[str]] = {
    "sec-purpose": frozenset({"prefetch", "prerender"}), "purpose": frozenset({"prefetch", "prerender"}),
    "x-moz": frozenset({"prefetch"}), "x-purpose": frozenset({"preview"}),
}
# A refusal on a document link keeps those headers, and its body depends on what the browser asks for.
REFUSAL_HEADERS = {**DOCUMENT_HEADERS, "vary": "accept, accept-language"}
# A document link's refusals as its browser tab shows them, by status: (English, Spanish). Static copy, never the
# kernel's or Claude's words; the visitor's way on is always the chat the link came from.
DOCUMENT_COPY: dict[int, tuple[str, str]] = {
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
# The document route's error answers in OpenAPI: the static copy, or the `ApiError` for a request that asks for JSON.
DOCUMENT_ERRORS = {status: {**entry, "content": {"text/plain": {"schema": {"type": "string"}}}}
                   for status, entry in error_responses(404, 422, 429, 503).items()}


def _quality(params: str) -> float:
    """The `q` of a header value's parameters: 1 when there is none, and 0 (not wanted) when it can't be read."""
    for param in params.split(";"):
        name, _, value = param.partition("=")
        if name.strip().lower() == "q":
            try:
                quality = float(value)
            except ValueError:
                return 0.0
            return quality if 0 <= quality <= 1 else 0.0
    return 1.0


def _ranked(header: str) -> list[tuple[str, float]]:
    """A header's comma-separated values, lowercased, each with its `q`, in the order sent."""
    values = []
    for item in header.split(","):
        value, _, params = item.partition(";")
        values.append((value.strip().lower(), _quality(params)))
    return values


def _spanish(request: Request) -> bool:
    """Whether the browser prefers Spanish to English (`Accept-Language`); the first listed wins a tie."""
    languages = [(quality, primary) for tag, quality in _ranked(request.headers.get("accept-language", ""))
                 if (primary := tag.partition("-")[0]) in ("en", "es") and quality > 0]
    return max(languages, key=lambda language: language[0], default=(0, "en"))[1] == "es"


def document_refusal(request: Request, status: int, error: ApiError,
                     headers: dict[str, str] | None = None) -> Response | None:
    """An error answer on a document link (`/api/d/…`), or None for any other path. The link opens in a browser tab,
    which no screen of the app covers, so the answer is static copy for its status (`DOCUMENT_COPY`), in Spanish when
    the browser prefers it, as `text/plain`. Only a request whose `Accept` names `application/json` gets the
    `ApiError`. Either way the status, the error's own headers (`Retry-After`) and the document's privacy headers stay."""
    if not request.url.path.startswith(DOCUMENT_PATH):
        return None
    return _refusal(request, status, error, headers)


def _refusal(request: Request, status: int, error: ApiError, headers: dict[str, str] | None) -> Response:
    """`document_refusal`'s answer, on a path known to be a document link's."""
    sent = {**(headers or {}), **REFUSAL_HEADERS}
    if status == 405:           # the router names only the first route on the path (the GET), so say both here
        sent = {name: value for name, value in sent.items() if name.lower() != "allow"} | {"allow": DOCUMENT_METHODS}
    if any(media == "application/json" and quality > 0 for media, quality in _ranked(request.headers.get("accept", ""))):
        return JSONResponse(error.model_dump(exclude_none=True), status_code=status, headers=sent)
    spanish = _spanish(request)
    copy = DOCUMENT_COPY.get(status) or (DOCUMENT_COPY[503] if status >= 500 else OTHER_REFUSAL)
    return PlainTextResponse(copy[spanish], status_code=status,
                             headers={**sent, "content-language": "es" if spanish else "en"})


async def _proxy(request: Request) -> Runtime:
    """The runtime, once the request's address is within the `proxy` limit (no credential to ledger a refusal with)."""
    state = runtime(request).started()
    await state.limiter.enforce("proxy", client_ip(request))
    return state


def _prefetch(request: Request) -> bool:
    """Whether a browser is fetching the link ahead of a click: `Sec-Purpose` (or the older `Purpose`) names
    `prefetch` or `prerender`, `X-Moz` names `prefetch` or `X-Purpose` names `preview` (`PREFETCH_PURPOSES`), as an
    item or as a parameter of one (`prefetch;prerender`)."""
    return any(part.partition("=")[0].strip().lower() in purposes
               for name, purposes in PREFETCH_PURPOSES.items() for value in request.headers.getlist(name)
               for part in re.split(r"[,;]", value))


def _shown_as(content_type: str, disposition: str | None) -> dict[str, str]:
    """How a browser takes a document of this type: with the kernel's disposition (`inline` when it sends none) if the
    type can't run script (`INLINE_TYPES`), else as an `attachment` that keeps the kernel's parameters (its file name),
    under a `sandbox` policy. A browser reads a comma as separating types and takes the last one it understands (two
    headers arrive joined by one), so a type with a comma anywhere is never on the list: it may name another after
    the one checked (`text/plain; charset=utf-8, text/html`)."""
    if "," not in content_type and content_type.partition(";")[0].strip().lower() in INLINE_TYPES:
        return {"content-disposition": disposition or "inline"}
    _, separator, parameters = (disposition or "").partition(";")
    return {"content-disposition": f"attachment{separator}{parameters}", **DOWNLOAD_HEADERS}


class DocumentBytes(Response):
    """A document link's bytes, streamed from the kernel as they arrive. The kernel opens the link (using it up) only
    when this response is sent, in the request's own task, so the stream is opened and closed there; a refusal before
    the first byte is raised for the app's error handlers to answer."""

    def __init__(self, kernel: KernelView, token: str):
        super().__init__()
        self._kernel, self._token = kernel, token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            async with self._kernel.stream(DOCUMENT_ROUTE, {"token": self._token}) as upstream:
                content_type = upstream.headers.get("content-type") or "application/octet-stream"
                headers = {"content-type": content_type,
                           **_shown_as(content_type, upstream.headers.get("content-disposition")),
                           **DOCUMENT_HEADERS,
                           **{name: value for name, passes in KERNEL_DOCUMENT_HEADERS.items()
                              if passes(value := upstream.headers.get(name, ""))}}
                await send({"type": "http.response.start", "status": 200,
                            "headers": [(name.encode(), value.encode()) for name, value in headers.items()]})
                try:
                    async for chunk in upstream.aiter_bytes():
                        await send({"type": "http.response.body", "body": chunk, "more_body": True})
                except httpx.HTTPError:
                    raise KernelUnavailable(DOCUMENT_ROUTE) from None   # cut short: the browser sees it unfinished
                await send({"type": "http.response.body", "body": b"", "more_body": False})
        except KernelFailed as failure:
            if failure.status == 404:
                raise ApiProblem(404, "link_used_or_expired") from None
            raise
        if self.background is not None:
            await self.background()


@router.get("/d/{token}", response_class=Response,
            responses={200: {"content": {"application/octet-stream": {}}, "description": "The document's bytes"},
                       **DOCUMENT_ERRORS})
async def document(token: Token, request: Request) -> Response:
    """The document a link card opens, once: the kernel's bytes and content type. The tab shows it only when its type
    can't run script (a PDF, a PNG, JPEG, GIF or WebP image, plain text); any other is downloaded as an attachment,
    sandboxed. A link that was opened, has expired or names nothing answers 404 `link_used_or_expired` alike. A
    browser's prefetch or prerender is 503 `prefetch` with `Retry-After: 0`, and leaves the link unopened. Refusals
    read as static copy unless JSON is asked for (`document_refusal`)."""
    state = await _proxy(request)
    if _prefetch(request):
        return _refusal(request, 503, ApiError(error="prefetch"), {"Retry-After": "0"})
    return DocumentBytes(state.kernel.public(), token)


@router.head("/d/{token}", include_in_schema=False)
async def document_head(token: Token, request: Request) -> Response:
    """A look at a document link before opening it (a link checker's or an unfurler's HEAD): 200 with the document's
    privacy headers and no body, whatever the token names. It never asks the kernel, which would open the link and use
    it up, so it can't tell an open link from a spent one."""
    await _proxy(request)
    return Response(status_code=200, headers=DOCUMENT_HEADERS)


# The mock checkout -------------------------------------------------------------------------------------------------

LINK_ROUTE = "GET /payment_links/{token}"
STEPS = {"complete": "POST /payment_links/{token}/complete", "cancel": "POST /payment_links/{token}/cancel"}
STEP_RESPONSES = {**error_responses(404, 422, 429, 503), 409: {"model": PaymentConflict}}


@router.get("/pay/{token}", response_model=PaymentLinkView, responses=error_responses(404, 422, 429, 503))
async def payment_link(token: Token, request: Request, response: Response) -> PaymentLinkView:
    """What the checkout page shows: the kernel's `PaymentLinkView`, unchanged. Never cached: the link's state moves."""
    state = await _proxy(request)
    view = await state.kernel.public().call(LINK_ROUTE, path={"token": token})
    response.headers["Cache-Control"] = "no-store"
    return view


async def _step(state: Runtime, token: str,
                step: Literal["complete", "cancel"]) -> PaymentLinkStateResult | JSONResponse:
    """The kernel's answer to completing or cancelling the link. A link that isn't `issued` is the kernel's 409
    `conflict`; the link is then read again, so the answer says how it stands now and why it was cancelled."""
    kernel = state.kernel.public()
    try:
        return await kernel.call(STEPS[step], PaymentLinkActionRequest(), path={"token": token})
    except KernelFailed as failure:
        if (failure.status, failure.code) != (409, "conflict"):
            raise
    view = await kernel.call(LINK_ROUTE, path={"token": token})
    # `cancel_reason` joins `PaymentLinkView` with the kernel payments plan's contract (01c); until then it reads null.
    cancelled = PaymentConflict(state=view.state, cancel_reason=getattr(view, "cancel_reason", None))
    return JSONResponse(cancelled.model_dump(mode="json"), status_code=409)


async def _confirm_in_chat(state: Runtime, result: PaymentLinkStateResult) -> None:
    """Show the kernel's `payment_confirmed` verdict in the link's chat, as the Desk's message, through `deliver()`,
    which drops it if the session's generation has moved on. The kernel's answer names the session; its copy and Desk
    come from the API's own rows for that session (`ro.kernel_session`), so a chat the API never served gets nothing.
    The payment stands whatever happens here: a line that can't be shown is logged, and the answer is the kernel's."""
    if result.verdict is None:
        return
    try:
        async with state.database().connect() as conn:
            session = await kernel_session(conn, result.session_id, state.settings.kernel_ro_schema)
            if session is None:
                logger.warning("a paid link's session has no chat here; its confirmation isn't shown")
                return
            ids = Ids(copy_id=session["copy_id"], desk_id=session["desk_id"], session_id=result.session_id)
            await deliver(conn, ids, Reply(result.verdict, "desk", via="kernel"),
                          ro_schema=state.settings.kernel_ro_schema)
            await conn.commit()
    except Exception as error:
        logger.error("a payment confirmation couldn't be shown in its chat (%s)", type(error).__name__)


@router.post("/pay/{token}/complete", response_model=PaymentLinkStateResult, responses=STEP_RESPONSES)
async def complete_payment(token: Token, request: Request) -> PaymentLinkStateResult | JSONResponse:
    """Pay the link (a test payment: no money moves). The kernel pays an `issued` link once and answers with its
    `payment_confirmed` verdict, which is shown in the link's chat (`_confirm_in_chat`); any other link is 409 with how
    it stands now, and nothing is shown."""
    state = await _proxy(request)
    result = await _step(state, token, "complete")
    if isinstance(result, PaymentLinkStateResult):
        await _confirm_in_chat(state, result)
    return result


@router.post("/pay/{token}/cancel", response_model=PaymentLinkStateResult, responses=STEP_RESPONSES)
async def cancel_payment(token: Token, request: Request) -> PaymentLinkStateResult | JSONResponse:
    """Cancel an `issued` link at checkout: nothing is paid and there is no verdict; any other link is 409."""
    return await _step(await _proxy(request), token, "cancel")
