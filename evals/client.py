"""A client for the Claude Desk API as one person's browser, or another person's agent, uses it.

`DeskClient(base_url, passcode)` calls the API's routes by operation (`evals.routes.ROUTES`): it
enters with the passcode (the owner cookie), opens a chat on a Desk (the visitor cookie), sends
messages, reads the chat's event stream, reads as the owner, and posts signed A2A requests. One
client is one person: a case that needs two owners or two visitors makes two clients.

The API's cookies are `Secure`, and a standard cookie jar never sends a `Secure` cookie over plain
HTTP, which is how the evals reach an in-process API on loopback. So on `http://127.0.0.1` or
`http://localhost` the client keeps each `Set-Cookie` itself, by name, value and `Path`, and sends
it on the paths it matches, to that origin only, as a browser does for a secure context; on any
other origin (an `https` deployment) it uses httpx's own jar. Cookies, tokens and codes never
appear in what the client raises.

For tier 2 the client also plays the simulated owner (answers, whispers, Desk data, the Answering
switch, a simulated tool change) and a visiting agent: `agent_demo` takes a key for the open chat's
Desk, and `a2a_send` signs each A2A request with it, as the agent itself would. A proving route's 202
(`ProvingPending`) is re-sent until it answers.
"""

import asyncio
import hashlib
import json
import re
import secrets
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from http.cookiejar import CookieJar, DefaultCookiePolicy
from typing import Any

import httpx
import rfc8785
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from httpx_sse import aconnect_sse

from desk.contracts import A2ARequest, DemoAgentIssued, Mandate
from evals.credentials import mask_credentials, mask_values
from evals.routes import ROUTES

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
DEFAULT_PORTS = {"http": 80, "https": 443}
TIMEOUT_S = 30.0
_DOCUMENT_LINK = re.compile(r"/api/d/[^/?#\s]+")
# A payment link card's href: the checkout page's path, `/pay/<token>` (the web app's), or the API's own.
_PAYMENT_LINK = re.compile(r"(?:/api)?/pay/([^/?#\s]+)")
# A proving route answers 202 `ProvingPending{retry: {path, body}}` once its kernel call passes 25 s; the
# owner app re-sends `retry` every 3 s ("How proofs run"), and so does the client, for at most two minutes.
PROVING_RETRY_S, PROVING_LIMIT_S = 3.0, 120.0
SHOWN_UNREADABLE = 80   # the characters shown of a body or event that isn't JSON
SHOWN_BODY = 500   # the characters a refusal's message shows of a JSON body


class ApiCallFailed(AssertionError):
    """An operation that needs a 2xx answer got another. Carries the status and the body the API sent,
    never what the request carried: a JSON body as it came, for the caller to judge; one that isn't
    JSON as its first 80 characters, named by its `content_type` (None for a JSON body). The message,
    and a body that isn't JSON, have their credentials masked before they are cut (`mask_credentials`),
    so one that crosses a cut is never shown in part; a JSON body's message shows a copy masked before it
    is serialized (`mask_values`)."""

    def __init__(self, op: str, status: int, body: Any, *, content_type: str | None = None, what: str = "a body"):
        self.op, self.status, self.content_type = op, status, content_type
        self.body = body if content_type is None else mask_credentials(body)[:SHOWN_UNREADABLE]
        if content_type is None:
            shown = json.dumps(mask_values(body)) if not isinstance(body, str) else body
            message = f"{op} answered {status}: {mask_credentials(shown)[:SHOWN_BODY]}"
        else:
            message = f"{op} answered {status} ({content_type}) with {what} that isn't JSON: {self.body!r}"
        super().__init__(message)


class AnswerUnreadable(ApiCallFailed):
    """A 2xx answer the operation reads as JSON, or an event of the chat's stream, that isn't JSON, named the
    way a refusal whose body isn't JSON is. It is never the API turning the call down, so no caller reads it
    as one: the stack failed."""

    def __init__(self, op: str, response: httpx.Response, what: str, text: str):
        super().__init__(op, response.status_code, text, content_type=_content_type(response), what=what)


@dataclass(frozen=True)
class StreamEvent:
    """One event of a chat's stream: its SSE id (the event's `seq`), its SSE event name and its
    JSON payload exactly as received."""

    id: str | None
    event: str
    data: Any

    @property
    def type(self) -> str | None:
        return self.data.get("type") if isinstance(self.data, dict) else None


# Cookies on a loopback origin

Origin = tuple[str, str, int]


def origin_of(url: httpx.URL) -> Origin:
    return url.scheme, url.host, url.port or DEFAULT_PORTS.get(url.scheme, 0)


def _request_path(url: httpx.URL) -> str:
    """The path a cookie's `Path` is matched against: as sent, without the query."""
    return url.raw_path.decode("ascii").partition("?")[0] or "/"


def _default_path(request_path: str) -> str:
    """RFC 6265 5.1.4: the request path up to its last "/", or "/"."""
    if not request_path.startswith("/") or request_path.count("/") == 1:
        return "/"
    return request_path[: request_path.rindex("/")]


def path_matches(request_path: str, cookie_path: str) -> bool:
    """RFC 6265 5.1.4: the cookie's path is the request's, or a prefix of it ending at a "/"."""
    if request_path == cookie_path:
        return True
    return request_path.startswith(cookie_path) and (
        cookie_path.endswith("/") or request_path[len(cookie_path)] == "/")


class LoopbackJar:
    """The cookies one origin set, kept as a browser keeps them: by name and path, with the expiry
    `Max-Age` or `Expires` gives. A cookie with a `Domain` other than the origin's host is refused."""

    def __init__(self, origin: Origin):
        self.origin = origin
        self._cookies: dict[tuple[str, str], tuple[str, float | None]] = {}   # (name, path) -> (value, expiry)

    def keep(self, url: httpx.URL, set_cookies: list[str]) -> None:
        if origin_of(url) != self.origin:
            return
        for header in set_cookies:
            self._keep_one(url, header)

    def _keep_one(self, url: httpx.URL, header: str) -> None:
        pair, *attributes = header.split(";")
        name, sep, value = pair.partition("=")
        name, value = name.strip(), value.strip()
        if not sep or not name:
            return
        path, max_age, expires, domain = None, None, None, None
        for attribute in attributes:
            key, _, given = attribute.partition("=")
            key, given = key.strip().lower(), given.strip()
            if key == "path" and given.startswith("/"):
                path = given
            elif key == "max-age" and re.fullmatch(r"-?\d+", given):
                max_age = int(given)
            elif key == "expires":
                try:
                    expires = parsedate_to_datetime(given).timestamp()
                except (TypeError, ValueError):
                    pass
            elif key == "domain" and given:
                domain = given.lstrip(".").lower()
        if domain is not None and domain != url.host.lower():
            return
        path = path or _default_path(_request_path(url))
        expiry = time.time() + max_age if max_age is not None else expires   # Max-Age wins, as RFC 6265 says
        self._cookies.pop((name, path), None)   # replaced, or expired at once by Max-Age=0 or a past Expires
        self._cookies[(name, path)] = (value, expiry)

    def header(self, url: httpx.URL) -> str | None:
        """The `Cookie` header a request to `url` carries, or None: longer paths first."""
        if origin_of(url) != self.origin:
            return None
        now, request_path = time.time(), _request_path(url)
        live = [(name, path, value) for (name, path), (value, expiry) in self._cookies.items()
                if (expiry is None or expiry > now) and path_matches(request_path, path)]
        live.sort(key=lambda cookie: -len(cookie[1]))
        return "; ".join(f"{name}={value}" for name, _, value in live) or None

    def held(self) -> list[tuple[str, str]]:
        """Each live cookie's name and path, never its value."""
        now = time.time()
        return [key for key, (_, expiry) in self._cookies.items() if expiry is None or expiry > now]

    def values(self) -> set[str]:
        """Every cookie value kept, live or not: only for a writer to redact."""
        return {value for value, _ in self._cookies.values()}


def _no_jar() -> CookieJar:
    """A jar for httpx that refuses every cookie, so a loopback cookie is kept and sent only by
    `LoopbackJar`, once. (httpx copies a jar given as `httpx.Cookies` into one with the default
    policy, so it is given the `CookieJar` itself.)"""
    return CookieJar(policy=DefaultCookiePolicy(allowed_domains=[]))


def _content_type(response: httpx.Response) -> str:
    return response.headers.get("content-type") or "no content type"


def _refused(op: str, response: httpx.Response) -> ApiCallFailed:
    """A non-2xx answer as the `ApiCallFailed` it raises, with its status, for the caller to judge."""
    try:
        body = response.json()
    except ValueError:
        return ApiCallFailed(op, response.status_code, response.text, content_type=_content_type(response))
    return ApiCallFailed(op, response.status_code, body)


def _json(op: str, response: httpx.Response) -> Any:
    """A 2xx answer's JSON body, or None when it has none; a body that isn't JSON raises `AnswerUnreadable`."""
    if not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        raise AnswerUnreadable(op, response, "a body", response.text) from None


# The client

class DeskClient:
    """One person's client for the API at `base_url`: an owner with the passcode, a visitor of one
    chat at a time (`open_chat`), or both. `http` is the underlying `httpx.AsyncClient`."""

    def __init__(self, base_url: str, passcode: str, *, transport: httpx.AsyncBaseTransport | None = None,
                 timeout_s: float = TIMEOUT_S, now: Callable[[], datetime] | None = None):
        self.base_url, self.passcode, self._timeout_s = base_url.rstrip("/"), passcode, timeout_s
        self.desk_slug: str | None = None    # the open chat's Desk
        self.session_id: str | None = None   # the open chat's session
        self.agent_session_id: str | None = None   # the agent's A2A session, once the Desk opened one
        self.last_a2a_nonce: str | None = None     # the nonce of the last A2A request sent, which names its turn
        self._now = now or (lambda: datetime.now(UTC))   # an agent signs `ts` on the Desk's clock
        self._agent: DemoAgentIssued | None = None
        url = httpx.URL(self.base_url)
        loopback = url.scheme == "http" and url.host in LOOPBACK_HOSTS
        self._jar = LoopbackJar(origin_of(url)) if loopback else None
        hooks = {"request": [self._send_cookies], "response": [self._keep_cookies]} if loopback else {}
        self.http = httpx.AsyncClient(
            base_url=self.base_url, transport=transport, timeout=timeout_s, trust_env=False,
            cookies=_no_jar() if loopback else None, event_hooks=hooks,
        )

    async def __aenter__(self) -> "DeskClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self.http.aclose()

    def cookies(self) -> list[tuple[str, str]]:
        """The name and path of each cookie the client holds for the API, never a value."""
        if self._jar is not None:
            return self._jar.held()
        return [(cookie.name, cookie.path) for cookie in self.http.cookies.jar]

    def held_secrets(self) -> set[str]:
        """Every secret value the client holds (cookie values, the agent's key, the passcode), for a
        writer to redact from what it keeps. Never logged or shown."""
        values = {self.passcode}
        if self._jar is not None:
            values |= self._jar.values()
        else:
            values |= {cookie.value for cookie in self.http.cookies.jar if cookie.value}
        if self._agent is not None:
            values.add(self._agent.agent_private_key_hex)
        return {value for value in values if value}

    async def _send_cookies(self, request: httpx.Request) -> None:
        assert self._jar is not None
        if header := self._jar.header(request.url):
            request.headers["Cookie"] = header

    async def _keep_cookies(self, response: httpx.Response) -> None:
        assert self._jar is not None
        self._jar.keep(response.request.url, response.headers.get_list("set-cookie"))

    # Calls by operation

    async def request(
        self,
        op: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        content: bytes | None = None,
        query: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        """Call the operation's route (`ROUTES[op]`) with its path parameters, and return the answer
        whatever its status: for cases that judge a refusal."""
        route = ROUTES[op]
        return await self.http.request(
            route.method, route.url(**(params or {})), params={**route.query, **(query or {})}, json=json,
            content=content, headers=headers,
        )

    async def _ok(self, op: str, **kwargs: Any) -> Any:
        response = await self.request(op, **kwargs)
        if not 200 <= response.status_code < 300:
            raise _refused(op, response)
        return _json(op, response)

    def _chat(self) -> dict[str, str]:
        if self.desk_slug is None:
            raise RuntimeError("no chat is open; open_chat(desk_slug) first")
        return {"desk_slug": self.desk_slug}

    # Plan 02a: the public chat, the owner's reads, the health check

    async def health(self) -> Any:
        return await self._ok("health")

    async def enter(self) -> Any:
        """A new copy with the passcode (`CopyOut`); the owner cookie comes with it."""
        return await self._ok("enter", json={"passcode": self.passcode})

    async def open_chat(self, desk_slug: str) -> Any:
        """Open a chat on the Desk (the visitor cookie), and return its session's state, read from
        `GET …/session`. Later chat operations are on this chat."""
        await self._ok("open_chat", params={"desk_slug": desk_slug})
        self.desk_slug = desk_slug
        state = (await self.transcript())["state"]
        self.session_id = state["session_id"]
        return state

    async def transcript(self) -> Any:
        """The open chat as its visitor reads it (`VisitorTranscript`: state, items, last_seq)."""
        return await self._ok("chat_session", params=self._chat())

    async def send(self, text: str) -> Any:
        """A visitor message (`MessageAccepted`); the reply arrives on the stream."""
        return await self._ok("send", params=self._chat(), json={"text": text})

    async def events(self, last_event_id: str | int | None = None, *,
                     query: dict[str, Any] | None = None) -> AsyncIterator[StreamEvent]:
        """The open chat's event stream, from after `last_event_id` (all of it with None), until the
        caller stops reading. A refused stream raises `ApiCallFailed`, and an event whose data isn't JSON
        `AnswerUnreadable`.

        An event without data is skipped, as the SSE spec never dispatches one: httpx-sse keeps the last
        event id across events, so once one has set an id, it hands over the API's keep-alive comment
        as an event with no data."""
        route = ROUTES["events"]
        headers = {} if last_event_id is None else {"Last-Event-ID": str(last_event_id)}
        timeout = httpx.Timeout(self._timeout_s, read=None)   # a quiet stream isn't a failure; callers bound it
        async with aconnect_sse(self.http, route.method, route.url(**self._chat()), params=query or {},
                                headers=headers, timeout=timeout) as source:
            response = source.response
            if response.status_code != 200:
                await response.aread()
                raise _refused("events", response)
            async for sse in source.aiter_sse():
                if not sse.data:   # a keep-alive
                    continue
                try:
                    data = json.loads(sse.data)
                except ValueError:
                    raise AnswerUnreadable("events", response, "an event", sse.data) from None
                yield StreamEvent(id=sse.id or None, event=sse.event, data=data)

    async def owner_session(self, session_id: str) -> Any:
        """A conversation as the owner reads it (`OwnerTranscript`)."""
        return await self._ok("owner_session", params={"session_id": session_id})

    async def owner_decision(self, decision_id: str) -> Any:
        return await self._ok("owner_decision", params={"decision_id": decision_id})

    async def owner_ledger(self, desk_id: str) -> Any:
        """The Desk's ledger, verified (`LedgerPage`)."""
        return await self._ok("owner_ledger", params={"desk_id": desk_id})

    # Plan 02b: verification, the Demo inbox, document links, A2A, take-over

    async def verify_start(self, contact: str) -> Any:
        return await self._ok("verify_start", params=self._chat(), json={"contact": contact})

    async def verify_check(self, code: str) -> Any:
        return await self._ok("verify_check", params=self._chat(), json={"code": code})

    async def my_demo_inbox(self) -> Any:
        """The open chat's own Demo inbox."""
        return await self._ok("my_demo_inbox", params=self._chat())

    async def fetch_document(self, url: str) -> httpx.Response:
        """A document link card's `href` (`/api/d/<token>`), fetched once; the answer whatever its status."""
        if not isinstance(url, str) or not _DOCUMENT_LINK.fullmatch(url):
            raise ValueError("fetch_document takes a document link card's href, /api/d/<token>")
        return await self.http.get(url)

    async def a2a(self, desk_slug: str, body: bytes, headers: dict[str, str]) -> httpx.Response:
        """A signed A2A request: `body` exactly as signed, with the agent's signature headers; the
        answer whatever its status."""
        return await self.request("a2a", params={"desk_slug": desk_slug}, content=body,
                                  headers={**headers, "Content-Type": "application/json"})

    async def owner_take_over(self, session_id: str, generation: int | None = None) -> Any:
        """The owner takes the conversation over (`SessionState`), at its current generation unless given."""
        if generation is None:
            generation = (await self.owner_session(session_id))["state"]["generation"]
        return await self._ok("owner_take_over", params={"session_id": session_id}, json={"generation": generation})

    # Plan 05b: the simulated owner and a visiting agent in a tier 2 run

    async def owner_answer(self, decision_id: str, answer: str) -> Any:
        """The owner's answer to a held request (`ApprovalAnswerOut`)."""
        return await self._ok("owner_answer", params={"decision_id": decision_id}, json={"answer": answer})

    async def owner_demo_inbox(self) -> Any:
        """The owner's Demo inbox, every entry of the copy, codes included."""
        return await self._ok("owner_demo_inbox")

    async def owner_set_answering(self, desk_id: str, on: bool) -> Any:
        return await self._ok("owner_set_answering", params={"desk_id": desk_id}, json={"on": on})

    async def owner_whisper(self, session_id: str, text: str) -> Any:
        """A whisper to Claude in the conversation (`OwnerMessageResult`); the visitor never sees it."""
        return await self._owner_write("owner_whisper", params={"session_id": session_id},
                                       json={"text": text, "kind": "whisper"})

    async def owner_add_document(self, desk_id: str, document: dict[str, Any]) -> Any:
        """A document the owner uploads (`SeedDocument`'s fields); the kernel adds its canary."""
        return await self._owner_write("owner_add_document", params={"desk_id": desk_id}, json={"document": document})

    async def owner_add_knowledge(self, desk_id: str, item: dict[str, Any]) -> Any:
        """A knowledge item the owner adds (`KnowledgeItem`'s fields): untrusted text, never policy."""
        return await self._owner_write("owner_add_knowledge", params={"desk_id": desk_id}, json={"item": item})

    async def owner_simulate_tool_change(self, desk_id: str, tool: str) -> Any:
        """The demo's changed tool definition: the tool is off until the owner reviews it (`ToolProfile`)."""
        return await self._owner_write("owner_simulate_tool_change", params={"desk_id": desk_id}, json={"tool": tool})

    async def complete_payment_link(self, href: str) -> Any:
        """The mock checkout of a payment link card's `href` (`PaymentLinkStateResult`), as its payer."""
        match = _PAYMENT_LINK.fullmatch(href) if isinstance(href, str) else None
        if match is None:
            raise ValueError("complete_payment_link takes a payment link card's href, /pay/<token>")
        return await self._ok("complete_payment_link", params={"token": match.group(1)}, json={})

    async def agent_demo(self) -> DemoAgentIssued:
        """A demo agent's key and signed mandate for the open chat's Desk, issued once; the client keeps
        them, so `a2a_send` signs as that agent."""
        self._agent = DemoAgentIssued.model_validate(await self._ok("agent_demo", params=self._chat()))
        return self._agent

    async def a2a_send(self, text: str, *, mandate: Mandate | None = None, verify_code: str | None = None) -> Any:
        """One A2A turn as the agent `agent_demo` issued: the first opens the session (with `mandate`, if
        given), later ones name it. Signed over the exact body sent, with a fresh nonce and `ts` on the
        Desk's clock. Returns the `A2AResponse` as received, unvalidated, so an answer missing a field
        (its disclosure, say) reaches whoever judges it; a non-2xx answer raises `ApiCallFailed`."""
        if self._agent is None or self.desk_slug is None:
            raise RuntimeError("no agent: open_chat(desk_slug), then agent_demo(), first")
        request = A2ARequest(desk_slug=self.desk_slug, session_id=self.agent_session_id, message=text,
                             mandate=mandate, verify_code=verify_code)
        body = request.model_dump_json().encode()
        headers = self._agent_headers(body)
        self.last_a2a_nonce = headers["X-Agent-Nonce"]   # the API stores the turn's answer under it (`app.a2a_turns`)
        answer = await self._ok("a2a", params={"desk_slug": self.desk_slug}, content=body,
                                headers={**headers, "Content-Type": "application/json"})
        if isinstance(answer, dict) and isinstance(answer.get("session_id"), str):
            self.agent_session_id = answer["session_id"]
        return answer

    def _agent_headers(self, body: bytes) -> dict[str, str]:
        """`AgentAuth` for `body`: Ed25519 over the canonical JSON of the slug, `ts`, nonce and body hash."""
        assert self._agent is not None and self.desk_slug is not None
        ts = self._now().astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        nonce = secrets.token_urlsafe(16)
        signed = rfc8785.dumps({"desk_slug": self.desk_slug, "ts": ts, "nonce": nonce,
                                "body_sha256": hashlib.sha256(body).hexdigest()})
        key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(self._agent.agent_private_key_hex))
        return {"X-Agent-Key-Id": self._agent.agent_key_id, "X-Agent-Ts": ts, "X-Agent-Nonce": nonce,
                "X-Agent-Sig": key.sign(signed).hex()}

    async def _owner_write(self, op: str, **kwargs: Any) -> Any:
        """An owner write that may prove: a 202 `ProvingPending` is re-sent as its `retry` says (an owner
        path only), every 3 s, until the route answers otherwise; past two minutes it raises
        `ApiCallFailed` with the 202."""
        deadline = time.monotonic() + PROVING_LIMIT_S
        response = await self.request(op, **kwargs)
        while response.status_code == 202:
            pending = _json(op, response)
            retry = pending.get("retry") if isinstance(pending, dict) else None
            path = retry.get("path") if isinstance(retry, dict) else None
            if not isinstance(path, str) or not path.startswith("/api/owner/") or time.monotonic() > deadline:
                raise ApiCallFailed(op, 202, pending)
            await asyncio.sleep(PROVING_RETRY_S)
            response = await self.http.request(ROUTES[op].method, path, json=retry.get("body"))
        if not 200 <= response.status_code < 300:
            raise _refused(op, response)
        return _json(op, response)


__all__ = ["AnswerUnreadable", "ApiCallFailed", "DeskClient", "LoopbackJar", "StreamEvent", "path_matches"]
