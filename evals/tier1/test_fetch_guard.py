"""The owner's website fetch at setup: a private address is never fetched.

`native.fetch_website` resolves a host once, refuses unless every answer is a public address,
connects to the address it checked, and checks every redirect the same way (Plan 01c's
`fetch_guard`). The owner deciding and running a fetch of a loopback, private, link-local,
unique-local or IPv4-mapped address, however it is written, gets a `failed` execution with nothing
for Claude and no knowledge stored, and the kernel never opens a connection to the address. Tier 1
refuses every connection off loopback anyway, so a failed fetch alone would prove nothing: each
case also watches the connections the process opens, the in-process kernel's among them.

Two cases call the guard directly (`white_box`), on Plan 01c's mock transport and a resolver that
answers as scripted: a public page redirecting to a private address, and a host whose second
lookup would answer a private one (DNS rebinding).
"""

import functools
import importlib
import inspect
import socket
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import pytest

from desk.contracts import Decision
from evals.tier1.args import fetch_website_args, schema_mismatches
from evals.tier1.golden_desk import GoldenDesk, golden_desk
from evals.tier1.harness import Expect, KernelHarness
from evals.tier1.test_approvals import read
from evals.tier1.test_payments_and_agents import owner_context
from evals.tier1.test_sessions import new_call_id


@contextmanager
def connections_made() -> Iterator[list[tuple[str, int]]]:
    """Every TCP connection this process tries to open inside the block, as (address, port), from
    any thread: the kernel target runs in this process, so its fetches are seen too. Each attempt
    is recorded before it is made, so one the loopback guard or the network refuses still shows."""
    made: list[tuple[str, int]] = []

    def spying(connect: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(connect)
        def spy(sock: socket.socket, address: Any) -> Any:
            if sock.family in (socket.AF_INET, socket.AF_INET6) and isinstance(address, tuple):
                made.append((str(address[0]), int(address[1])))
            return connect(sock, address)

        return spy

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(socket.socket, "connect", spying(socket.socket.connect))
        patch.setattr(socket.socket, "connect_ex", spying(socket.socket.connect_ex))
        yield made


def scripted_resolver(
    system: Callable[..., Any], host: str, script: list[list[str]]
) -> tuple[Callable[..., Any], list[str]]:
    """A resolver for the guard that answers its n-th lookup of `host` with the n-th list of
    addresses in `script`, and the lookups it was asked. Each answer is the system resolver's own
    answer for those literal addresses (which needs no network), joined, so it has whatever shape
    and calling convention the guard expects: awaited if the system resolver is. Any other host, or
    a lookup past the script, fails the case."""
    lookups: list[str] = []

    def asked_for(args: tuple[Any, ...], kwargs: dict[str, Any]) -> list[tuple[tuple[Any, ...], dict[str, Any]]]:
        assert host in args or host in kwargs.values(), f"the resolver was asked for {args} {kwargs}, not {host}"
        lookups.append(host)
        assert len(lookups) <= len(script), f"the guard resolved {host} {len(lookups)} times"
        return [(tuple(address if arg == host else arg for arg in args),
                 {name: address if value == host else value for name, value in kwargs.items()})
                for address in script[len(lookups) - 1]]

    def joined(answers: list[Any]) -> Any:
        whole = answers[0]
        for answer in answers[1:]:
            whole = whole + answer
        return whole

    def resolver(*args: Any, **kwargs: Any) -> Any:
        answers = [system(*each_args, **each_kwargs) for each_args, each_kwargs in asked_for(args, kwargs)]
        if any(inspect.isawaitable(answer) for answer in answers):
            async def awaited() -> Any:
                return joined([await answer for answer in answers])

            return awaited()
        return joined(answers)

    return resolver, lookups


def refusal_reason(error: BaseException) -> str | None:
    """The reason a `FetchRefused` gives (`scheme`, `port`, `userinfo`, `address`, ...)."""
    reason = getattr(error, "reason", None)
    if reason is None and error.args and isinstance(error.args[0], str):
        reason = error.args[0]
    return reason if isinstance(reason, str) else None


# The owner's fetch through the kernel

FETCH = "native.fetch_website"
FETCH_PORTS = {80, 443}   # the only ports the guard fetches from
PRIVATE_URLS = [
    "http://127.0.0.1/",
    "http://localhost/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://169.254.170.2/v2/credentials",   # the ECS task metadata address
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://2130706433/",   # 127.0.0.1, written as one number
]
FAILED = {"state": "failed", "facts": [], "model_view": {}}


async def owner_fetch(k: KernelHarness, desk: GoldenDesk, url: str) -> Decision:
    """The owner's fetch of `url` for its own Desk: decided, then run, by `/execute` if allowed or by
    the owner's own `allow_once` if held. The run fails, writing nothing and giving Claude nothing."""
    owner = desk.copy.owner_session
    args = fetch_website_args(url)
    if k.is_real:
        declared = {profile.tool: profile for profile in (await owner_context(k, desk)).tools_declared}
        assert FETCH in declared, "the owner's session is never given the website fetch"
        mismatches = schema_mismatches(args, declared[FETCH].input_schema)
        assert not mismatches, f"evals/tier1/args.py builds {FETCH} args its input_schema doesn't take: {mismatches}"
    call = {"call_id": new_call_id(), "tool": FETCH, "args": args}
    decided = await k.call("POST /decide", auth=desk.owner, body={
        "session_id": owner.session_id, "generation": owner.generation, "call": call, "desk_id": desk.desk_id,
    }, expect=Expect(fields={"outcome": {"$in": ["allow", "hold"]}, "action.tool": FETCH}))
    if decided.outcome == "allow":
        await k.call("POST /execute", auth=desk.owner, body={
            "decision_id": decided.decision_id, "session_id": owner.session_id, "generation": owner.generation,
        }, expect=Expect(fields=FAILED))
    else:
        await k.call("POST /approvals/{decision_id}/answer", path={"decision_id": decided.decision_id},
                     body={"answer": "allow_once"}, auth=desk.owner, expect=Expect(fields={
                         "decision.state": "failed", **{f"execution.{path}": value for path, value in FAILED.items()},
                     }))
    return decided


async def website_knowledge(records: Any, desk: GoldenDesk) -> list[dict[str, Any]]:
    """The Desk's knowledge items from a website fetch (real kernel only)."""
    return [row for row in await records.knowledge_items(desk.copy.copy_id)
            if row["desk_id"] == desk.desk_id and row["source"] == "website"]


@pytest.mark.requires("01c-setup")
@pytest.mark.parametrize("url", PRIVATE_URLS)
async def test_fetch_rejects_private_addresses(k: KernelHarness, records, url: str):
    """The owner's fetch of a loopback, private, link-local, unique-local or IPv4-mapped address,
    in any form, fails: nothing for Claude, no knowledge stored, and no connection opened to a web
    port, so the guard refused it rather than the network."""
    desk = await golden_desk(k)
    stored_before = await website_knowledge(records, desk) if k.is_real else []
    with connections_made() as made:
        decided = await owner_fetch(k, desk, url)
    await read(k, desk.owner, decided, "failed")

    if k.is_real:
        fetched = [connection for connection in made if connection[1] in FETCH_PORTS]
        assert fetched == [], f"the kernel connected to {fetched} for {url}"
        assert await website_knowledge(records, desk) == stored_before, f"the fetch of {url} stored knowledge"


# The guard itself (Plan 01c's `fetch_guard`, called directly)

FETCH_GUARD = "desk.kernel_service.fetch_guard"
SITE = "turner-plumbing.example"
PUBLIC, PRIVATE = "93.184.215.14", "10.0.0.5"   # a public address and a private one; neither is ever connected to
PAGE = "<html><head><title>Turner Plumbing</title></head><body>Drains, leaks and water heaters.</body></html>"


def guard_and_transport() -> tuple[Any, Any]:
    """Plan 01c's guard module and its HTTP client library (for the mock transport), imported only
    where a white-box case runs."""
    return importlib.import_module(FETCH_GUARD), importlib.import_module("httpx2")


async def fetched(result: Any) -> Any:
    """The guard's answer, awaited if the guard is async."""
    return await result if inspect.isawaitable(result) else result


@pytest.mark.requires("01c-setup")
@pytest.mark.white_box
async def test_fetch_rejects_a_redirect_to_a_private_address():
    """A redirect is checked from scratch: a public address answering with a redirect to
    `http://10.0.0.5/` is refused for its `address`, and the private address is never asked."""
    fetch_guard, httpx2 = guard_and_transport()
    asked: list[Any] = []

    def answer(request: Any) -> Any:
        asked.append(request)
        if request.url.host == PUBLIC:
            return httpx2.Response(302, headers={"location": f"http://{PRIVATE}/"})
        return httpx2.Response(200, headers={"content-type": "text/html"}, text=PAGE)

    with pytest.raises(fetch_guard.FetchRefused) as refused:
        await fetched(fetch_guard.guarded_fetch(f"http://{PUBLIC}/", resolver=fetch_guard.system_resolver,
                                                transport=httpx2.MockTransport(answer)))
    assert refusal_reason(refused.value) == "address", f"refused for {refusal_reason(refused.value)!r}"
    assert [request.url.host for request in asked] == [PUBLIC], "the redirect's private address was asked"


@pytest.mark.requires("01c-setup")
@pytest.mark.white_box
async def test_fetch_rejects_dns_rebinding():
    """A host is resolved once and fetched at the address that was checked: when its first lookup
    answers a public address and a second would answer a private one, the guard looks it up once
    and asks the public address for the site by name. A lookup answering a public and a private
    address together is refused for its `address`, with nothing asked."""
    fetch_guard, httpx2 = guard_and_transport()
    asked: list[Any] = []

    def answer(request: Any) -> Any:
        asked.append(request)
        return httpx2.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=PAGE)

    rebinding, lookups = scripted_resolver(fetch_guard.system_resolver, SITE, [[PUBLIC], [PRIVATE]])
    page = await fetched(fetch_guard.guarded_fetch(f"http://{SITE}/", resolver=rebinding,
                                                   transport=httpx2.MockTransport(answer)))
    assert len(lookups) == 1, f"the guard looked {SITE} up {len(lookups)} times"
    sent = [(request.url.host, request.headers.get("host")) for request in asked]
    assert sent in ([(PUBLIC, SITE)], [(PUBLIC, f"{SITE}:80")]), f"the guard asked {sent}"
    assert "Drains, leaks and water heaters." in page.text, "the checked address's page isn't what was fetched"

    asked.clear()
    mixed, lookups = scripted_resolver(fetch_guard.system_resolver, SITE, [[PUBLIC, PRIVATE]])
    with pytest.raises(fetch_guard.FetchRefused) as refused:
        await fetched(fetch_guard.guarded_fetch(f"http://{SITE}/", resolver=mixed,
                                                transport=httpx2.MockTransport(answer)))
    assert refusal_reason(refused.value) == "address", f"refused for {refusal_reason(refused.value)!r}"
    assert (len(lookups), asked) == (1, []), f"{len(lookups)} lookups; asked {len(asked)} times"
