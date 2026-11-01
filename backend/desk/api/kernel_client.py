"""The API's only way to the kernel (master plan, "Kernel HTTP API v2").

`KernelHttp` holds one connection pool and no credential. Each request gets a view that carries
exactly one caller's credential: `.session(token)` sends `X-Session-Token`, `.owner(token)`
`X-Owner-Session`, `.agent(auth, body_sha256)` the four `AgentAuth` headers and
`X-Agent-Body-Sha256`, and `.public()` nothing. No view sends a principal, person, level or
assurance; the kernel builds identity from the credential.

Failures fail closed and say only what the API needs ("Fail-closed behavior"): a 4xx `KernelError`
raises `KernelFailed(status, code)`, grouped by what the turn does next; anything else (no answer
within the deadline, a 5xx, a body that isn't the route's model) raises `KernelUnavailable`.

Credentials never reach a log or an exception's text: this module logs nothing, its errors carry
only the route template, status and code, and httpx's and httpcore's own records are dropped while
a kernel call runs, since a request line can hold a link token in its path.
"""

import asyncio
import contextlib
import contextvars
import logging
import re
from collections.abc import AsyncIterator, Iterator
from http.cookiejar import CookieJar, DefaultCookiePolicy
from typing import Any
from urllib.parse import parse_qsl, quote

import httpx
from pydantic import TypeAdapter, ValidationError

from desk.api.settings import Settings
from desk.contracts import AgentAuth
from desk.kernel_api import KERNEL_ROUTES, KernelError, WhoAmI

DEFAULT_TIMEOUT_S = 6.0      # above the reviewer's 4 s
PROVING_TIMEOUT_S = 60.0     # compiling and proving a policy version
REPLY_CHECK_TIMEOUT_S = 12.0  # one 8 s soft check, plus rendering, database reads and signing
PROVING_ROUTES = frozenset({"POST /policy/draft", "POST /tools/confirm", "POST /policy/{version}/probe"})
# Routes whose answer is bytes, not JSON: fetched only with stream(), since a document link is single use.
STREAM_ROUTES = frozenset({"GET /document_links/{token}"})
# Routes whose body carries only the fields the caller set, so a kernel that predates a field still takes a request
# that leaves it out: a copy asks for the recorded night (Plan 01d) only by setting `replay_night`.
SET_FIELDS_ONLY = frozenset({"POST /copies"})

ENDS_SESSION = frozenset({"auth", "not_found", "closed"})            # the turn ends with error{code: "session"}
SILENT = frozenset({"stale_generation", "mode_owner", "mode_paused"})  # the turn ends with turn_end only
REFUSES_CALL = frozenset({"conflict", "invalid", "rate_limited"})    # a refused tool_result; the turn goes on
TURN_OVER = frozenset({"replayed"})                                   # an agent's turn already answered
KERNEL_FAULTS = frozenset({"seed_unproved", "internal"})             # treated as the kernel being unreachable


class KernelFailed(Exception):
    """The kernel refused the call with a 4xx `KernelError`."""

    def __init__(self, status: int, code: str, *, detail: dict[str, list[str]] | None = None):
        super().__init__(f"kernel answered {status} {code}")
        self.status, self.code = status, code
        self.detail = detail or {}

    @property
    def ends_session(self) -> bool:
        return self.code in ENDS_SESSION

    @property
    def silent(self) -> bool:
        return self.code in SILENT

    @property
    def refuses_call(self) -> bool:
        return self.code in REFUSES_CALL

    @property
    def turn_over(self) -> bool:
        return self.code in TURN_OVER


class KernelUnavailable(Exception):
    """No usable answer: a connect error or timeout (no status), a 5xx (its `seed_unproved` or `internal`
    code kept) or any other answer the route's model doesn't describe."""

    def __init__(self, route: str, status: int | None = None, code: str | None = None):
        parts = (route, "kernel unavailable", status, code)
        super().__init__(" ".join(str(part) for part in parts if part is not None))
        self.route, self.status, self.code = route, status, code


def _failure(route: str, response: httpx.Response) -> KernelFailed | KernelUnavailable:
    """The error a non-2xx answer raises."""
    try:
        code = KernelError.model_validate_json(response.content).code
    except ValidationError:
        code = None
    if response.is_client_error and code is not None and code not in KERNEL_FAULTS:
        try:
            detail = TypeAdapter(dict[str, list[str]]).validate_python(response.json().get("detail", {}))
        except ValidationError:
            detail = {}
        return KernelFailed(response.status_code, code, detail=detail)
    return KernelUnavailable(route, response.status_code, code if code in KERNEL_FAULTS else None)


_PARAM = re.compile(r"\{(\w+)\}")
_HEADER_VALUE = re.compile(r"[\x21-\x7e]+")      # visible ASCII: a credential can't add or split a header
_SHA256_HEX = re.compile(r"[0-9a-f]{64}")
_ADAPTERS = {route: TypeAdapter(response) for route, (_, response) in KERNEL_ROUTES.items() if response is not None}


def _credential(headers: dict[str, str]) -> dict[str, str]:
    """The headers, refused (without echoing a value) unless each is non-empty visible ASCII."""
    for name, value in headers.items():
        if not isinstance(value, str) or not _HEADER_VALUE.fullmatch(value):
            raise ValueError(f"{name} must be non-empty visible ASCII")
    return headers


def _path_value(value: object) -> str:
    """One path segment: an id, slug, token or version, with no way to climb out of its route."""
    if isinstance(value, bool) or not isinstance(value, (str, int)) or str(value) in ("", ".", ".."):
        raise ValueError("a path value is a non-empty id, slug, token or version")
    return quote(str(value), safe="")


_IN_KERNEL_CALL: contextvars.ContextVar[bool] = contextvars.ContextVar("desk_kernel_call", default=False)


class _QuietDuringKernelCalls(logging.Filter):
    """Drops httpx's and httpcore's records made while a kernel call runs; other clients still log."""

    def filter(self, record: logging.LogRecord) -> bool:
        return not _IN_KERNEL_CALL.get()


# A logger's filters see only the records made on it, so each httpx and httpcore logger gets one.
# httpx imports every httpcore module, so their loggers exist by now; the names cover any that don't yet.
_QUIET = _QuietDuringKernelCalls()
for _name in {"httpx", "httpcore.connection", "httpcore.http11", "httpcore.http2", "httpcore.proxy", "httpcore.socks",
              *(name for name in logging.root.manager.loggerDict if name.startswith("httpcore."))}:
    logging.getLogger(_name).addFilter(_QUIET)


@contextlib.contextmanager
def _quiet() -> Iterator[None]:
    token = _IN_KERNEL_CALL.set(True)
    try:
        yield
    finally:
        _IN_KERNEL_CALL.reset(token)


def _no_cookies() -> CookieJar:
    """A jar that keeps nothing, so no answer can plant a cookie that another view would send."""
    return CookieJar(policy=DefaultCookiePolicy(allowed_domains=[]))


class KernelHttp:
    """The kernel over HTTP, with typed requests and responses keyed by `KERNEL_ROUTES`."""

    def __init__(self, base_url: str, transport: httpx.AsyncBaseTransport | None = None,
                 timeout_s: float = DEFAULT_TIMEOUT_S):
        self.base_url = httpx.URL(base_url)
        self._network_transport = transport is None
        self._timeout_s = timeout_s
        self._client = httpx.AsyncClient(base_url=self.base_url, transport=transport, timeout=timeout_s,
                                         trust_env=False, follow_redirects=False, cookies=_no_cookies())

    @property
    def network_transport(self) -> bool:
        """True when the client uses httpx's own network transport, built here with no proxy."""
        return self._network_transport

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "KernelHttp":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    def session(self, token: str) -> "CredentialView":
        """A visitor session, by the token from its cookie."""
        return CredentialView(self, "session", _credential({"X-Session-Token": token}))

    def owner(self, token: str) -> "CredentialView":
        """The copy's owner, by the token from the owner cookie."""
        return CredentialView(self, "owner", _credential({"X-Owner-Session": token}))

    def agent(self, auth: AgentAuth, body_sha256: str) -> "CredentialView":
        """An agent, by the signature headers of its A2A request and the sha256 of the raw body they sign."""
        if type(auth) is not AgentAuth:
            raise TypeError("an agent view takes the request's AgentAuth")
        if not isinstance(body_sha256, str) or not _SHA256_HEX.fullmatch(body_sha256):
            raise ValueError("X-Agent-Body-Sha256 must be a lowercase hex sha256")
        return CredentialView(self, "agent", _credential({
            "X-Agent-Key-Id": auth.agent_key_id, "X-Agent-Ts": auth.ts, "X-Agent-Nonce": auth.nonce,
            "X-Agent-Sig": auth.sig, "X-Agent-Body-Sha256": body_sha256,
        }))

    def public(self) -> "KernelView":
        return KernelView(self, "public", {})

    def _request(self, route: str, body: Any, path: dict | None, query: dict | None,
                 headers: dict[str, str], *, timeout_s: float | None = None) -> httpx.Request:
        """The request for `route`, refused before anything is sent unless its body and path fit the route."""
        if route not in KERNEL_ROUTES:
            raise ValueError(f"{route!r} is not a kernel route")
        request_model = KERNEL_ROUTES[route][0]
        if request_model is None and body is not None:
            raise TypeError(f"{route} takes no body")
        if request_model is not None and type(body) is not request_model:
            raise TypeError(f"{route} takes a {request_model.__name__}")
        method, _, target = route.partition(" ")
        template, _, fixed = target.partition("?")
        if set(path or {}) != set(_PARAM.findall(template)):
            raise TypeError(f"{route} takes path values for {sorted(_PARAM.findall(template))}")
        url = _PARAM.sub(lambda match: _path_value(path[match.group(1)]), template)
        # A None value leaves its parameter out; a value the route fixes ("?verify=true") always goes.
        params = {name: value for name, value in (query or {}).items() if value is not None}
        params.update(parse_qsl(fixed))
        content = None
        if body is not None:
            content = body.model_dump_json(exclude_unset=route in SET_FIELDS_ONLY).encode()
            headers = {**headers, "Content-Type": "application/json"}
        return self._client.build_request(method, url, params=params, headers=headers, content=content,
                                          timeout=self._timeout(route) if timeout_s is None else timeout_s)

    def _timeout(self, route: str) -> float:
        if route == "POST /check_reply":
            return REPLY_CHECK_TIMEOUT_S
        return PROVING_TIMEOUT_S if route in PROVING_ROUTES else self._timeout_s

    async def _send(self, route: str, request: httpx.Request, *, stream: bool = False,
                    timeout_s: float | None = None) -> httpx.Response:
        """The kernel's answer, read whole unless `stream`, within the deadline; never a redirect's target."""
        try:
            with _quiet():
                async with asyncio.timeout(self._timeout(route) if timeout_s is None else timeout_s):
                    return await self._client.send(request, stream=stream)
        except (httpx.HTTPError, TimeoutError):
            raise KernelUnavailable(route) from None   # the request, which holds the credential, stays out of the chain

    async def _call(self, route: str, body: Any, path: dict | None, query: dict | None,
                    headers: dict[str, str], *, timeout_s: float | None = None) -> Any:
        if route in STREAM_ROUTES:
            raise TypeError(f"{route} answers bytes: use stream()")
        response = await self._send(route, self._request(route, body, path, query, headers, timeout_s=timeout_s),
                                    timeout_s=timeout_s)
        if not response.is_success:
            raise _failure(route, response)
        if KERNEL_ROUTES[route][1] is None:
            return None
        try:
            return _ADAPTERS[route].validate_json(response.content)
        except ValidationError:
            raise KernelUnavailable(route, response.status_code) from None

    @contextlib.asynccontextmanager
    async def _stream(self, route: str, path: dict, headers: dict[str, str]) -> AsyncIterator[httpx.Response]:
        if route not in STREAM_ROUTES:
            raise TypeError(f"{route} answers JSON: use call()")
        response = await self._send(route, self._request(route, None, path, None, headers), stream=True)
        with _quiet():                      # the caller reads the body inside the `async with`
            try:
                if not response.is_success:
                    try:
                        await response.aread()
                    except httpx.HTTPError:
                        raise KernelUnavailable(route, response.status_code) from None
                    raise _failure(route, response)
                yield response
            finally:
                await response.aclose()


class KernelView:
    """One caller's credential over the shared client; `repr` never shows it."""

    __slots__ = ("_http", "_kind", "_headers")

    def __init__(self, http: KernelHttp, kind: str, headers: dict[str, str]):
        self._http, self._kind, self._headers = http, kind, headers

    def __repr__(self) -> str:
        return f"<KernelView {self._kind}>"

    async def call(self, route: str, body: Any = None, *, path: dict | None = None, query: dict | None = None,
                   timeout_s: float | None = None) -> Any:
        """Call with this credential; a timeout override applies only to this request and its HTTP transport."""
        return await self._http._call(route, body, path, query, self._headers, timeout_s=timeout_s)

    def stream(self, route: str, path: dict) -> contextlib.AbstractAsyncContextManager[httpx.Response]:
        """The kernel's answer as a byte stream (a document link), to read inside the `async with`."""
        return self._http._stream(route, path, self._headers)


class CredentialView(KernelView):
    __slots__ = ()

    async def whoami(self, session_id: str | None = None) -> WhoAmI:
        """The copy, session and generation this credential names: the API's only source for them."""
        return await self.call("GET /whoami", query=None if session_id is None else {"session_id": session_id})


def assert_production_safe(settings: Settings, http: object) -> None:
    """In production, refuse to start unless the kernel client is `KernelHttp` on httpx's own network
    transport to the kernel process on 127.0.0.1, and the API reads the real `kernel_ro` views."""
    if not settings.production:
        return
    if type(http) is not KernelHttp or not http.network_transport:
        raise RuntimeError("production reaches the kernel only over HTTP")
    if http.base_url.scheme != "http" or http.base_url.host != "127.0.0.1":
        raise RuntimeError("production reaches the kernel only at http://127.0.0.1")
    if settings.kernel_ro_schema != "kernel_ro":
        raise RuntimeError("production reads only the kernel_ro views")
