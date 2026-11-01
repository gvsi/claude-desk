"""The website fetch's guard: only public addresses, checked once per hop and connected to as checked.

Every test runs the fetch on an injected resolver and an `httpx2.MockTransport`, so nothing
leaves the machine: the resolver counts its lookups and the transport records what would have
been sent.
"""

import asyncio
import gzip
import ipaddress
import socket
import time
from collections.abc import Callable

import httpx2
import pytest

from desk.kernel_service import fetch_guard, repo
from desk.kernel_service.fetch_guard import FetchRefused

HOST = "turner-plumbing.example"
PUBLIC = "93.184.215.14"
PAGE = "<html><head><title>Turner Plumbing</title></head><body><p>Drains and leaks in Oakland.</p></body></html>"


class Resolver:
    """A resolver that answers from `answers` (a hostname's addresses, or a list of answers to give
    in turn) and records every lookup."""

    def __init__(self, answers: dict[str, list[str] | list[list[str]]]):
        self.answers = {host: list(given) for host, given in answers.items()}
        self.lookups: list[str] = []

    async def __call__(self, host: str) -> list[str]:
        self.lookups.append(host)
        given = self.answers.get(host, [])
        if given and isinstance(given[0], list):
            return given.pop(0) if len(given) > 1 else given[0]
        return given


class Site:
    """An `httpx2.MockTransport` whose `handler` answers each request; `requests` records them."""

    def __init__(self, handler: Callable[[httpx2.Request], httpx2.Response] | None = None):
        self.requests: list[httpx2.Request] = []
        self.handler = handler or (lambda request: html(PAGE))
        self.transport = httpx2.MockTransport(self._handle)

    def _handle(self, request: httpx2.Request):
        self.requests.append(request)
        return self.handler(request)


def html(body: str, *, status: int = 200, **headers: str) -> httpx2.Response:
    return httpx2.Response(status, headers={"content-type": "text/html; charset=utf-8", **headers}, text=body)


def redirect(location: str, status: int = 302) -> httpx2.Response:
    return httpx2.Response(status, headers={"location": location})


async def refused(url: str, resolver: Resolver, site: Site) -> str:
    with pytest.raises(FetchRefused) as raised:
        await fetch_guard.guarded_fetch(url, resolver=resolver, transport=site.transport)
    return raised.value.reason


ADDRESSES = [
    ("8.8.8.8", True), ("2606:4700::1111", True),
    ("10.0.0.1", False), ("172.16.0.1", False), ("192.168.1.1", False), ("127.0.0.1", False),
    ("169.254.170.2", False),             # the ECS task metadata and credentials endpoint
    ("169.254.169.254", False), ("100.64.0.1", False), ("0.0.0.0", False), ("224.0.0.1", False),
    ("255.255.255.255", False), ("::1", False), ("fe80::1", False), ("fd12::1", False),
    ("::ffff:127.0.0.1", False), ("::ffff:8.8.8.8", False),   # IPv4-mapped, even of a public address
    ("64:ff9b::a00:1", False),            # NAT64 of 10.0.0.1
    ("2002:a00:1::", False),              # 6to4 of 10.0.0.1
    ("ff02::1", False),
    ("fec0::1", False),                   # IPv6 site-local, deprecated but private by definition
]


@pytest.mark.parametrize(("address", "public"), ADDRESSES)
def test_address_policy(address, public):
    assert fetch_guard.is_public_address(ipaddress.ip_address(address)) is public
    assert fetch_guard.is_public_address(address) is public


async def test_private_target_refused():
    resolver, site = Resolver({"localhost": ["127.0.0.1"], "metadata.example": ["169.254.169.254"]}), Site()
    for url in ("http://10.0.0.1/", "http://127.0.0.1:80/", "https://[::1]/", "http://169.254.170.2/v2/credentials",
                "http://[::ffff:10.0.0.1]/", "http://localhost/", "https://metadata.example/latest/meta-data/"):
        assert await refused(url, resolver, site) == "address", url
    assert resolver.lookups == ["localhost", "metadata.example"]      # an address in the URL needs no lookup
    assert site.requests == []


async def test_any_private_answer_refuses():
    site = Site()
    for answers in ([PUBLIC, "10.0.0.1"], ["10.0.0.1", PUBLIC], [PUBLIC, "::1"], [PUBLIC, "fd12::1"], []):
        resolver = Resolver({HOST: answers})
        assert await refused(f"https://{HOST}/", resolver, site) == "address", answers
        assert resolver.lookups == [HOST]

    async def unknown(host: str) -> list[str]:                     # a name that doesn't resolve
        raise socket.gaierror(socket.EAI_NONAME, "nodename nor servname provided")

    with pytest.raises(FetchRefused) as raised:
        await fetch_guard.guarded_fetch(f"https://{HOST}/", resolver=unknown, transport=site.transport)
    assert raised.value.reason == "error"
    assert site.requests == []


async def test_rebinding_resolves_once_and_connects_to_the_checked_address():
    # a rebinding name: public on the first lookup, the metadata endpoint on any later one
    resolver, site = Resolver({HOST: [[PUBLIC], ["169.254.170.2"]]}), Site()
    page = await fetch_guard.guarded_fetch(f"https://{HOST}/services?area=oakland#top", resolver=resolver,
                                           transport=site.transport)
    assert resolver.lookups == [HOST]
    [request] = site.requests
    assert str(request.url) == f"https://{PUBLIC}/services?area=oakland"
    assert request.headers["host"] == HOST
    assert request.extensions["sni_hostname"] == HOST
    assert (page.final_url, page.content_type, page.title, page.text) == (
        f"https://{HOST}/services?area=oakland#top", "text/html", "Turner Plumbing", "Drains and leaks in Oakland.")

    # an IPv6 answer goes in the URL in brackets, and a port that isn't the scheme's stays in the Host
    resolver, site = Resolver({HOST: ["2606:4700::1111"]}), Site()
    await fetch_guard.guarded_fetch(f"http://{HOST}:443/", resolver=resolver, transport=site.transport)
    [request] = site.requests
    assert (str(request.url), request.headers["host"], request.extensions["sni_hostname"]) == (
        "http://[2606:4700::1111]:443/", f"{HOST}:443", HOST)


@pytest.mark.parametrize("location", ["https://intranet.example/admin", "http://[::ffff:127.0.0.1]/",
                                      "http://169.254.170.2/v2/credentials"])
async def test_redirect_to_private_is_refused(location):
    resolver = Resolver({HOST: [PUBLIC], "intranet.example": ["10.0.0.5"]})
    site = Site(lambda request: redirect(location) if request.url.path == "/" else html(PAGE))
    assert await refused(f"https://{HOST}/", resolver, site) == "address"
    assert [str(request.url) for request in site.requests] == [f"https://{PUBLIC}/"]   # never sent to the target


async def test_relative_redirect_keeps_the_hostname():
    resolver = Resolver({HOST: [PUBLIC]})
    site = Site(lambda request: redirect("/about", 301) if request.url.path == "/" else html(PAGE))
    page = await fetch_guard.guarded_fetch(f"https://{HOST}/", resolver=resolver, transport=site.transport)
    # read against the hostname, not the address it connected to, and resolved again from scratch
    assert page.final_url == f"https://{HOST}/about"
    assert resolver.lookups == [HOST, HOST]
    assert [(str(r.url), r.headers["host"], r.extensions["sni_hostname"]) for r in site.requests] == [
        (f"https://{PUBLIC}/", HOST, HOST), (f"https://{PUBLIC}/about", HOST, HOST)]


def chain(last: str) -> Callable[[httpx2.Request], httpx2.Response]:
    """A site where /0 redirects to /1, /1 to /2 and so on, up to the page at `last`."""

    def handler(request: httpx2.Request) -> httpx2.Response:
        return html(PAGE) if request.url.path == last else redirect(f"/{int(request.url.path[1:]) + 1}")

    return handler


async def test_redirect_limit():
    resolver = Resolver({HOST: [PUBLIC]})
    # three redirects are followed
    site = Site(chain("/3"))
    page = await fetch_guard.guarded_fetch(f"https://{HOST}/0", resolver=resolver, transport=site.transport)
    assert (page.final_url, len(site.requests)) == (f"https://{HOST}/3", 4)
    # a fourth is refused without being sent, and so is a redirect with nowhere to go
    site = Site(chain("/9"))
    assert await refused(f"https://{HOST}/0", resolver, site) == "redirects"
    assert [r.url.path for r in site.requests] == ["/0", "/1", "/2", "/3"]
    assert await refused(f"https://{HOST}/0", resolver, Site(lambda request: httpx2.Response(302))) == "error"


class Endless(httpx2.AsyncByteStream):
    """A body that never ends, 64 KiB at a time; `sent` counts the chunks read from it."""

    def __init__(self):
        self.sent = 0

    async def __aiter__(self):
        while True:
            self.sent += 1
            yield b"<p>" + b"a" * (64 * 1024 - 3)


def body(content: bytes | None = None, content_type: str | None = "text/plain", *,
         stream: httpx2.AsyncByteStream | None = None, **headers: str) -> httpx2.Response:
    """An answer with `content` (or `stream`), of `content_type` (None: no type at all)."""
    typed = {"content-type": content_type} if content_type else {}
    return httpx2.Response(200, headers={**typed, **{k.replace("_", "-"): v for k, v in headers.items()}},
                           content=content, stream=stream)


async def test_size_and_type_limits():
    resolver = Resolver({HOST: [PUBLIC]})

    async def fetched(response: httpx2.Response) -> fetch_guard.FetchedPage:
        return await fetch_guard.guarded_fetch(f"https://{HOST}/", resolver=resolver,
                                               transport=Site(lambda request: response).transport)

    async def refusal(response: httpx2.Response) -> str:
        return await refused(f"https://{HOST}/", resolver, Site(lambda request: response))

    # up to 1 MiB is read; a byte more is too large, whether declared or streamed, and a stream is
    # cut off as soon as it passes the limit
    limit = fetch_guard.MAX_BYTES
    assert (await fetched(body(b"a" * limit))).text == "a" * fetch_guard.MAX_TEXT
    assert await refusal(body(b"a" * (limit + 1))) == "too_large"
    endless = Endless()
    assert await refusal(body(content_type="text/html", stream=endless)) == "too_large"
    assert endless.sent == 17
    unread = Endless()
    assert await refusal(body(content_type="text/html", stream=unread, content_length=str(limit + 1))) == "too_large"
    assert unread.sent == 0

    # only HTML and plain text, sent uncompressed
    compressed = gzip.compress(PAGE.encode())
    for content_type, encoding in (("application/json", "identity"), ("image/png", "identity"), (None, "identity"),
                                   ("application/octet-stream", "identity"), ("text/html", "gzip")):
        response = body(compressed if encoding == "gzip" else PAGE.encode(), content_type, content_encoding=encoding)
        assert await refusal(response) == "type", (content_type, encoding)
    for status in (404, 500, 304):
        assert await refusal(html(PAGE, status=status)) == "error", status

    # the page as plain text: no script or style, whitespace collapsed, in its charset, cut to size
    page = await fetched(body((
        "<title>  Turner\n Plumbing\x00 </title><style>p { color: red }</style><script>alert('hi')</script>"
        "<h1>Café &amp; drains</h1><p>Open\t8–6</p><div>Oakland</div><!-- a note -->"
    ).encode("latin-1", "replace"), "TEXT/HTML; charset=ISO-8859-1"))
    assert (page.content_type, page.title, page.text) == (
        "text/html", "Turner Plumbing", "Café & drains Open 8?6 Oakland")
    page = await fetched(html(f"<title>{'t' * 300}</title><p>{'word ' * 10_000}</p>"))
    assert (len(page.title), len(page.text)) == (fetch_guard.MAX_TITLE, fetch_guard.MAX_TEXT)
    page = await fetched(body(b"Open 8 to 6.\r\n\r\nCall."))
    assert (page.content_type, page.title, page.text) == ("text/plain", "", "Open 8 to 6. Call.")

    # the site names the charset, but only a text charset the web uses is taken: any other (a codec
    # that isn't text, or one like UTF-7 that spells characters UTF-8 can't hold) reads the page as
    # UTF-8, and the title and text are always ones the knowledge store holds
    for charset, sent, title, text in (
            ("windows-1252", "<title>Café</title>Open".encode("cp1252"), "Café", "Open"),
            ("utf-16le", "<title>Café</title>".encode("utf-16-le") + b"\x00\xd8", "Café", "\ufffd"),
            ("base64", b"<title>Caf\xc3\xa9</title>Q2Fmw6k=", "Café", "Q2Fmw6k="),
            ("hex", b"<title>Caf\xc3\xa9</title>4361", "Café", "4361"),
            ("rot13", b"<title>Caf\xc3\xa9</title>Pnsr", "Café", "Pnsr"),
            ("idna", b"<title>Caf\xc3\xa9</title>xn--caf-dma", "Café", "xn--caf-dma"),
            ("undefined", b"<title>Caf\xc3\xa9</title>Open", "Café", "Open"),
            ("utf\x008", b"<title>Caf\xc3\xa9</title>Open", "Café", "Open"),
            ("utf-7", b"<title>Caf+AOk- +2AA-</title>+2AA-", "Caf+AOk- +2AA-", "+2AA-"),
            ("unicode_escape", b"<title>Caf\\xe9 \\ud800</title>\\ud800", "Caf\\xe9 \\ud800", "\\ud800")):
        page = await fetched(body(sent, f"text/html; charset={charset}"))
        assert (page.title, page.text) == (title, text), charset
        assert repo.storable(page.title) and repo.storable(page.text), charset
    # and should a decoder ever give a character UTF-8 can't hold (a lone surrogate), it becomes "?"
    assert fetch_guard._plain(" Caf\udce9\x00\ud800 ") == "Caf? ?"


async def test_scheme_port_userinfo_rejected():
    resolver, site = Resolver({HOST: [PUBLIC]}), Site()
    cases = [
        (f"ftp://{HOST}/", "scheme"), ("file:///etc/passwd", "scheme"), (f"gopher://{HOST}:70/", "scheme"),
        ("javascript:alert(1)", "scheme"), (HOST, "scheme"),
        (f"https://{HOST}:8443/", "port"), (f"http://{HOST}:22/", "port"), ("http://127.0.0.1:6379/", "port"),
        (f"http://{HOST}:0/", "port"),
        (f"https://maria:secret@{HOST}/", "userinfo"), (f"https://mike@{HOST}/", "userinfo"),
        ("https:///no-host", "error"),
    ]
    for url, reason in cases:
        assert await refused(url, resolver, site) == reason, url
    assert (resolver.lookups, site.requests) == ([], [])          # refused before any lookup
    # a redirect is checked from scratch too
    for location, reason in ((f"ftp://{HOST}/", "scheme"), (f"https://{HOST}:8443/", "port"),
                             (f"https://mike@{HOST}/", "userinfo")):
        site = Site(lambda request, location=location: redirect(location) if request.url.path == "/" else html(PAGE))
        assert await refused(f"https://{HOST}/", resolver, site) == reason, location
        assert len(site.requests) == 1


async def test_timeout():
    async def stalls(request: httpx2.Request) -> httpx2.Response:   # a server that never answers
        await asyncio.sleep(60)
        return html(PAGE)

    started = time.monotonic()
    assert await refused(f"https://{HOST}/", Resolver({HOST: [PUBLIC]}), Site(stalls)) == "timeout"
    assert fetch_guard.FETCH_TOTAL_TIMEOUT_S == 4.0
    assert time.monotonic() - started < 4.5
