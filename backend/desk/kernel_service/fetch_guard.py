"""The website fetch's guard: the owner's setup reads a public web page, and nothing else.

The setup interview may ask the kernel to read the business's website (`native.fetch_website`).
The URL comes from text Claude wrote, so it is untrusted, and the kernel runs inside the
deployment's network, next to addresses no visitor should reach (the database, the API process,
the ECS task metadata and credentials endpoint at 169.254.170.2). `guarded_fetch` therefore only
reads a public address:

- the URL is `http` or `https`, on port 80 or 443, with no user name or password;
- its host is resolved once (`Resolver`), every answer must be a public address
  (`is_public_address`), and the request goes to the first answer itself, the address in the URL
  with the hostname in the `Host` header and as the TLS server name, so a second lookup can't
  rebind it to another address;
- a redirect is never followed by the HTTP client: its `Location`, read against the hostname URL,
  is checked from scratch like the first URL (its own lookup, on a client of its own), at most
  `MAX_REDIRECTS` times;
- the answer is `text/html` or `text/plain`, uncompressed, at most `MAX_BYTES`, streamed and cut
  off past it, and the whole fetch, lookups included, ends within `FETCH_TOTAL_TIMEOUT_S`.

The page comes back as plain text (`FetchedPage`): read in its charset when that is one of the
web's text charsets (`CHARSETS`), else as UTF-8; HTML without its scripts and styles; whitespace
collapsed, at most `MAX_TEXT` characters, and always text the knowledge store holds. It stays
untrusted text, never an instruction. Anything refused raises `FetchRefused` with a plain reason,
before any request when the URL or an address is the problem.
"""

import asyncio
import codecs
import ipaddress
import socket
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Literal

import httpx2

FETCH_TOTAL_TIMEOUT_S = 4.0               # the whole fetch, lookups and redirects included
MAX_REDIRECTS = 3
MAX_BYTES = 1024 * 1024                   # 1 MiB of body, as sent (the fetch asks for no compression)
MAX_TEXT = 20_000                         # characters of page text kept
MAX_TITLE = 200                           # characters of title kept, as knowledge holds it
DEFAULT_PORTS = {"http": 80, "https": 443}
PORTS = frozenset({80, 443})
TYPES = frozenset({"text/html", "text/plain"})
# The charsets a page is read in, by Python's codec names: the web's common text charsets. Any other
# the site names, such as a codec that isn't text (base64) or one that can spell characters UTF-8
# can't hold (UTF-7), is ignored and the page read as UTF-8.
CHARSETS = frozenset({"utf-8", "utf-16", "utf-16-le", "utf-16-be", "ascii",
                      *(f"iso8859-{n}" for n in range(1, 17)), *(f"cp{n}" for n in range(1250, 1259))})
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
USER_AGENT = "ClaudeDesk-Setup/0.1"

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
Reason = Literal["scheme", "port", "userinfo", "address", "redirects", "type", "too_large", "timeout", "error"]
Resolver = Callable[[str], Awaitable[Sequence[str]]]   # a hostname's addresses, from one lookup

NAT64 = (ipaddress.ip_network("64:ff9b::/96"), ipaddress.ip_network("64:ff9b:1::/48"))


class FetchRefused(Exception):
    """The fetch didn't read the page, for `reason`: the URL's `scheme`, `port` or `userinfo`; an
    `address` that isn't public (or none at all); too many `redirects`; a `type` other than HTML or
    plain text; a body `too_large`; a `timeout`; or any other `error` on the way."""

    def __init__(self, reason: Reason):
        super().__init__(reason)
        self.reason: Reason = reason


@dataclass(frozen=True)
class FetchedPage:
    final_url: str                        # the hostname URL the page came from, after any redirects
    content_type: str                     # "text/html" or "text/plain"
    title: str                            # the HTML title, or "" (at most MAX_TITLE characters)
    text: str                             # the page as plain text, at most MAX_TEXT characters


def is_public_address(ip: IPAddress | str) -> bool:
    """Whether a fetch may connect to `ip`: a global unicast address. Never a private, loopback,
    link-local, IPv6 site-local, shared, multicast, reserved or unspecified one, and never an IPv6
    form that carries an IPv4 address (IPv4-mapped, 6to4, Teredo, NAT64), whatever address it carries."""
    address = ipaddress.ip_address(ip) if isinstance(ip, str) else ip
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None or address.sixtofour is not None or address.teredo is not None \
                or any(address in network for network in NAT64) or address.is_site_local:
            return False
    return address.is_global and not (address.is_multicast or address.is_reserved or address.is_unspecified)


async def system_resolver(host: str) -> list[str]:
    """The addresses `host` resolves to, from one `getaddrinfo`, in the order it gave them."""
    answers = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(sockaddr[0]) for *_, sockaddr in answers))


async def guarded_fetch(url: str, *, resolver: Resolver, transport: httpx2.AsyncBaseTransport | None = None
                        ) -> FetchedPage:
    """The page at `url`, read under the rules above, or `FetchRefused`. `transport` is the HTTP
    transport to send through (tests pass an `httpx2.MockTransport`); by default, the network's."""
    try:
        async with asyncio.timeout(FETCH_TOTAL_TIMEOUT_S):
            return await _fetch(url, resolver, transport)
    except TimeoutError:
        raise FetchRefused("timeout") from None


async def _fetch(url: str, resolver: Resolver, transport: httpx2.AsyncBaseTransport | None) -> FetchedPage:
    current = _checked_url(url)
    for hop in range(MAX_REDIRECTS + 1):
        answer = await _hop(current, resolver, transport, last=hop == MAX_REDIRECTS)
        if isinstance(answer, FetchedPage):
            return answer
        current = answer
    raise FetchRefused("redirects")       # unreachable: the last hop returns or refuses


async def _hop(url: httpx2.URL, resolver: Resolver, transport: httpx2.AsyncBaseTransport | None, *,
               last: bool) -> FetchedPage | httpx2.URL:
    """One request, to `url`'s checked address on a client of its own (no connection or cookie
    carries over to another hop): the page, or the checked URL a redirect names (`redirects` when
    it is the `last` hop's)."""
    host = url.raw_host.decode("ascii")
    address = await _public_address(host, resolver)
    async with httpx2.AsyncClient(transport=transport, follow_redirects=False, trust_env=False,
                                  timeout=httpx2.Timeout(FETCH_TOTAL_TIMEOUT_S)) as client:
        request = client.build_request(
            "GET", url.copy_with(host=str(address), fragment=None),
            headers={"Host": url.netloc.decode("ascii"), "User-Agent": USER_AGENT,
                     "Accept": "text/html, text/plain;q=0.9", "Accept-Encoding": "identity"},
            extensions={"sni_hostname": host})
        try:
            response = await client.send(request, stream=True, follow_redirects=False)
        except httpx2.TimeoutException:
            raise FetchRefused("timeout") from None
        except httpx2.HTTPError:
            raise FetchRefused("error") from None
        try:
            if response.status_code in REDIRECT_STATUSES:
                location = response.headers.get("location")
                if not location:
                    raise FetchRefused("error")
                if last:
                    raise FetchRefused("redirects")
                return _checked_url(_joined(url, location))
            if not 200 <= response.status_code < 300:
                raise FetchRefused("error")
            content_type = _content_type(response)
            body = await _body(response)
        finally:
            await response.aclose()
    return _page(url, content_type, _decoded(body, response.charset_encoding))


def _checked_url(url: str | httpx2.URL) -> httpx2.URL:
    """`url` parsed, if a fetch may go to it: `http` or `https`, no user name or password, port 80
    or 443, and a host."""
    try:
        parsed = url if isinstance(url, httpx2.URL) else httpx2.URL(url)
    except (httpx2.InvalidURL, TypeError, ValueError):
        raise FetchRefused("error") from None
    if parsed.scheme not in DEFAULT_PORTS:
        raise FetchRefused("scheme")
    if parsed.userinfo:
        raise FetchRefused("userinfo")
    if (parsed.port if parsed.port is not None else DEFAULT_PORTS[parsed.scheme]) not in PORTS:
        raise FetchRefused("port")
    if not parsed.raw_host:
        raise FetchRefused("error")
    return parsed


def _joined(base: httpx2.URL, location: str) -> httpx2.URL:
    """A redirect's `Location`, read against the hostname URL that answered it."""
    try:
        return base.join(location)
    except (httpx2.InvalidURL, TypeError, ValueError):
        raise FetchRefused("error") from None


async def _public_address(host: str, resolver: Resolver) -> IPAddress:
    """The address to connect to for `host`: the host itself when it is an address, else the first
    answer of one lookup, provided every answer is public."""
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if not is_public_address(literal):
            raise FetchRefused("address")
        return literal
    try:
        answers = list(await resolver(host))
    except Exception:                     # a failed lookup: no address to check, so no request
        raise FetchRefused("error") from None
    try:
        addresses = [ipaddress.ip_address(answer) for answer in answers]
    except ValueError:
        raise FetchRefused("address") from None
    if not addresses or not all(is_public_address(address) for address in addresses):
        raise FetchRefused("address")
    return addresses[0]


def _content_type(response: httpx2.Response) -> str:
    """The answer's media type, if it is one the fetch reads, sent without compression."""
    media_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    encoding = response.headers.get("content-encoding", "identity").strip().lower()
    if media_type not in TYPES or encoding not in ("", "identity"):
        raise FetchRefused("type")
    return media_type


async def _body(response: httpx2.Response) -> bytes:
    """The answer's body, at most MAX_BYTES: a longer declared length is refused before reading,
    and the stream is cut off as soon as it passes the limit."""
    declared = response.headers.get("content-length", "").strip()
    if declared.isdigit() and int(declared) > MAX_BYTES:
        raise FetchRefused("too_large")
    chunks, size = [], 0
    try:                                  # `_content_type` let through no compression, so bytes are as sent
        async for chunk in response.aiter_bytes():
            size += len(chunk)
            if size > MAX_BYTES:
                raise FetchRefused("too_large")
            chunks.append(chunk)
    except httpx2.TimeoutException:
        raise FetchRefused("timeout") from None
    except httpx2.HTTPError:
        raise FetchRefused("error") from None
    return b"".join(chunks)


def _decoded(body: bytes, charset: str | None) -> str:
    """The body as text, any undecodable byte replaced: in its declared charset when that is one of
    `CHARSETS`, else (none, one Python lacks, or any other codec the site names) as UTF-8."""
    try:
        encoding = codecs.lookup(charset or "utf-8").name
    except (LookupError, ValueError):
        encoding = "utf-8"
    if encoding not in CHARSETS:
        encoding = "utf-8"
    try:
        return body.decode(encoding, errors="replace")
    except (LookupError, ValueError):     # a backstop: no codec in CHARSETS raises when it replaces
        return body.decode("utf-8", errors="replace")


def _page(url: httpx2.URL, content_type: str, text: str) -> FetchedPage:
    if content_type == "text/html":
        title, text = _html_text(text)
    else:
        title = ""
    return FetchedPage(final_url=str(url), content_type=content_type, title=_plain(title)[:MAX_TITLE],
                       text=_plain(text)[:MAX_TEXT])


_CONTROLS = {code: " " for code in (*range(0x20), *range(0x7F, 0xA0))}    # Unicode's control characters


def _plain(text: str) -> str:
    """`text` on one line, as the knowledge store holds it: any character UTF-8 can't encode (a lone
    surrogate) becomes "?", control characters (NUL among them) spaces, and every run of whitespace
    one space."""
    holdable = text.encode("utf-8", errors="replace").decode("utf-8")
    return " ".join(holdable.translate(_CONTROLS).split())


class _PageText(HTMLParser):
    """An HTML page's title and its text, without scripts or styles; block elements separate words."""

    SKIPPED = frozenset({"script", "style"})
    BLOCKS = frozenset({"address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "footer",
                        "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol",
                        "p", "pre", "section", "table", "td", "th", "tr", "ul"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title: list[str] = []
        self.text: list[str] = []
        self._skipping = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in self.SKIPPED:
            self._skipping += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self.BLOCKS:
            self.text.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIPPED:
            self._skipping = max(0, self._skipping - 1)
        elif tag == "title":
            self._in_title = False
        elif tag in self.BLOCKS:
            self.text.append(" ")

    def handle_data(self, data: str) -> None:
        if self._skipping:
            return
        (self.title if self._in_title else self.text).append(data)


def _html_text(html: str) -> tuple[str, str]:
    parser = _PageText()
    try:
        parser.feed(html)
        parser.close()
    except Exception:                     # a page the parser can't read is no page
        raise FetchRefused("error") from None
    return "".join(parser.title), "".join(parser.text)
