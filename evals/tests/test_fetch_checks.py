"""The fetch cases' own checks: the connection spy, the scripted resolver and the refusal's reason."""

import asyncio
import ipaddress
import socket
import sys
import types
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from evals.tier1 import test_fetch_guard
from evals.tier1.test_fetch_guard import connections_made, refusal_reason, scripted_resolver


def closed_port() -> int:
    """A loopback port nothing listens on."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


async def test_connections_made_sees_every_way_the_process_connects():
    """Plain sockets, asyncio's streams and httpx's async client all connect through
    `socket.socket.connect` or `connect_ex`, so the spy records each attempt, refused or not, and
    leaves both as they were."""
    connect, connect_ex = socket.socket.connect, socket.socket.connect_ex
    server = await asyncio.start_server(lambda reader, writer: writer.close(), "127.0.0.1", 0)
    listening = server.sockets[0].getsockname()[1]
    refused = closed_port()
    try:
        with connections_made() as made:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock, pytest.raises(OSError):
                sock.connect(("127.0.0.1", refused))
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                assert sock.connect_ex(("127.0.0.1", refused)) != 0
            _, writer = await asyncio.open_connection("127.0.0.1", listening)
            writer.close()
            async with httpx.AsyncClient(trust_env=False) as client:
                with pytest.raises(httpx.ConnectError):
                    await client.get(f"http://127.0.0.1:{refused}/")
    finally:
        server.close()
        await server.wait_closed()
    assert made == [("127.0.0.1", refused), ("127.0.0.1", refused), ("127.0.0.1", listening),
                    ("127.0.0.1", refused)]
    assert (socket.socket.connect, socket.socket.connect_ex) == (connect, connect_ex)


def test_scripted_resolver_answers_in_the_system_resolvers_shape():
    """Each lookup of the host is answered by the system resolver asked for the next scripted
    addresses instead, the answers joined, so the guard gets exactly the shape it expects; another
    host, or a lookup past the script, fails the case."""
    def system(host: str, port: int = 80) -> list[tuple[str, int]]:
        return [(host, port)]

    resolver, lookups = scripted_resolver(system, "rivera.example", [["93.184.215.14"], ["10.0.0.5", "8.8.8.8"]])
    assert resolver("rivera.example", 443) == [("93.184.215.14", 443)]
    assert resolver(host="rivera.example") == [("10.0.0.5", 80), ("8.8.8.8", 80)]
    assert len(lookups) == 2
    with pytest.raises(AssertionError, match="resolved rivera.example 3 times"):
        resolver("rivera.example")
    with pytest.raises(AssertionError, match="other.example"):
        resolver("other.example")


async def test_scripted_resolver_follows_an_async_system_resolver():
    async def system(host: str) -> tuple[str, ...]:
        return (host,)

    resolver, lookups = scripted_resolver(system, "rivera.example", [["93.184.215.14", "10.0.0.5"]])
    assert await resolver("rivera.example") == ("93.184.215.14", "10.0.0.5")
    assert len(lookups) == 1


def test_refusal_reason_reads_the_reason_given():
    class FetchRefused(Exception):
        def __init__(self, reason: str):
            super().__init__(reason)
            self.reason = reason

    assert refusal_reason(FetchRefused("address")) == "address"
    assert refusal_reason(ValueError("redirects")) == "redirects"
    assert refusal_reason(ValueError()) is None
    assert refusal_reason(ValueError(3)) is None


# The white-box cases, run against a stand-in for Plan 01c's guard: they pass a guard that keeps
# the rules and fail one that breaks any of them.

class StandInGuard:
    """A guard written to Plan 01c's rules (resolve once, every answer public, fetch the checked
    address by the host's name, check each redirect from scratch), with switches that break each."""

    def __init__(self, *, resolve_twice: bool = False, look_again: bool = False, by_name: bool = False,
                 trust_redirects: bool = False):
        self.resolve_twice, self.look_again = resolve_twice, look_again
        self.by_name, self.trust_redirects = by_name, trust_redirects

        class FetchRefused(Exception):
            def __init__(self, reason: str):
                super().__init__(reason)
                self.reason = reason

        self.FetchRefused = FetchRefused

    @staticmethod
    def system_resolver(host: str, port: int) -> list[str]:
        return [info[4][0] for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]

    async def guarded_fetch(self, url: str, *, resolver: Any, transport: Any = None) -> Any:
        for hop in range(4):
            target = httpx.URL(url)
            answers = resolver(target.host, target.port or 80)
            checks = hop == 0 or not self.trust_redirects
            if checks and not all(ipaddress.ip_address(answer).is_global for answer in answers):
                raise self.FetchRefused("address")
            if self.resolve_twice:   # connects to what a second lookup answers
                answers = resolver(target.host, target.port or 80)
            elif self.look_again:    # looks again, though it connects to the checked answer
                resolver(target.host, target.port or 80)
            sent = target if self.by_name else target.copy_with(host=answers[0])
            async with httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=False) as client:
                response = await client.get(sent, headers={"Host": target.host})
            if response.is_redirect:
                url = str(target.join(response.headers["location"]))
                continue
            return types.SimpleNamespace(text=response.text)
        raise self.FetchRefused("redirects")


@pytest.fixture
def stand_in_guard(monkeypatch: pytest.MonkeyPatch) -> Callable[..., None]:
    """Install a stand-in guard as Plan 01c's `fetch_guard`, with httpx standing in for httpx2."""

    def install(**broken: bool) -> None:
        guard = StandInGuard(**broken)
        module = types.ModuleType("desk.kernel_service.fetch_guard")
        module.FetchRefused, module.guarded_fetch = guard.FetchRefused, guard.guarded_fetch
        module.system_resolver = guard.system_resolver
        package = types.ModuleType("desk.kernel_service")
        package.__path__ = []
        monkeypatch.setitem(sys.modules, "desk.kernel_service", package)
        monkeypatch.setitem(sys.modules, "desk.kernel_service.fetch_guard", module)
        monkeypatch.setitem(sys.modules, "httpx2", httpx)

    return install


async def test_white_box_cases_pass_a_guard_that_keeps_the_rules(stand_in_guard):
    stand_in_guard()
    await test_fetch_guard.test_fetch_rejects_a_redirect_to_a_private_address()
    await test_fetch_guard.test_fetch_rejects_dns_rebinding()


@pytest.mark.parametrize("broken", ["resolve_twice", "look_again", "by_name"])
async def test_rebinding_case_fails_a_guard_open_to_rebinding(stand_in_guard, broken: str):
    stand_in_guard(**{broken: True})
    with pytest.raises(AssertionError):
        await test_fetch_guard.test_fetch_rejects_dns_rebinding()


async def test_redirect_case_fails_a_guard_that_trusts_redirects(stand_in_guard):
    stand_in_guard(trust_redirects=True)
    with pytest.raises((AssertionError, pytest.fail.Exception)):
        await test_fetch_guard.test_fetch_rejects_a_redirect_to_a_private_address()
