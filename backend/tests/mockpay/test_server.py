"""The mock payments server: the kernel's key and copy header, its two MCP tools, the provider
routes with their settled idempotency keys, the test delay switch, and the kernel running it as a
supervised child (master plan, "Payments (mocked)")."""

import asyncio
import contextlib
import dataclasses
import json
import logging
import os
import pty
import signal
import socket
import sys
import time
from collections.abc import AsyncIterator
from pathlib import Path

import httpx2
import pytest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from desk.db.session import database_url, dispose_engines
from desk.kernel_service import __main__ as kernel_command
from desk.kernel_service import app as kernel_app
from desk.kernel_service.app import KernelSettings, create_app as create_kernel
from desk.mockpay import definitions, server

from .conftest import BACKEND, new_copy, new_key

NO_PROVER = "/nonexistent/desk-prove"   # the kernel's selftest fails fast, so it starts in bounded mode


def env_example(name: str) -> str:
    """A value as `.env.example` publishes it: a placeholder anyone can read."""
    for line in (BACKEND.parent / ".env.example").read_text().splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1]
    raise LookupError(name)


ENV_EXAMPLE_KEY = env_example("MOCKPAY_KEY")


def headers(key: str | None, copy: str | None) -> dict[str, str]:
    return {name: value for name, value in (("X-Mockpay-Key", key), ("X-Desk-Copy", copy)) if value is not None}


@contextlib.asynccontextmanager
async def provider(url: str, key: str | None, copy: str | None = None) -> AsyncIterator[httpx2.AsyncClient]:
    """An HTTP client for the provider routes, as the kernel's: the key, the copy, no proxies."""
    async with httpx2.AsyncClient(base_url=url, headers=headers(key, copy), trust_env=False, timeout=10) as http:
        yield http


@contextlib.asynccontextmanager
async def mcp_session(url: str, key: str, copy: str) -> AsyncIterator[Client]:
    """An MCP client as the kernel builds one: fresh, uncached (a cached list would hide a change)."""
    async with httpx2.AsyncClient(headers=headers(key, copy), trust_env=False, timeout=10) as http:
        async with Client(streamable_http_client(f"{url}/mcp", http_client=http), cache=None) as client:
            yield client


def as_listed(tool) -> dict:
    return tool.model_dump(by_alias=True, exclude_none=True, mode="json")


async def call_tool(url: str, key: str, copy: str, name: str, arguments: dict):
    async with mcp_session(url, key, copy) as client:
        return await client.call_tool(name, arguments)


def structured(result) -> dict:
    """A tool result that succeeded, whose text says what its structured content says."""
    assert not result.is_error, result.content
    assert json.loads(result.content[0].text) == result.structured_content
    return result.structured_content


def error_text(result) -> str:
    assert result.is_error and result.structured_content is None
    return result.content[0].text


def charge(owner: str, cents: int, description: str = "Drain clearing", at: str = "2026-10-20T17:00:00Z") -> dict:
    return {"owner_person_id": owner, "amount_cents": cents, "description": description, "created_at": at}


async def seed(url: str, key: str, copy: str, charges: list[dict]) -> list[str]:
    async with provider(url, key, copy) as http:
        response = await http.post("/provider/seed", json={"charges": charges})
    assert response.status_code == 200, response.text
    return response.json()["charge_ids"]


@pytest.mark.parametrize("key", ["", "k" * 31], ids=["empty", "31-characters"])
def test_server_refuses_to_start_without_a_key(key, monkeypatch, capsys):
    with pytest.raises(ValueError, match="at least 32 characters") as refused:
        server.create_app(database_url("MOCKPAY"), key, env="test")
    assert key == "" or key not in str(refused.value)
    # the command the kernel runs refuses too, and says why without the key
    monkeypatch.setenv("MOCKPAY_KEY", key)
    with pytest.raises(SystemExit) as exited:
        server.main(["--host", "127.0.0.1", "--port", "0"])
    assert exited.value.code not in (0, None)
    assert "at least 32 characters" in str(exited.value.code)
    assert key == "" or key not in capsys.readouterr().err
    assert server.create_app(database_url("MOCKPAY"), new_key(), env="test") is not None


def test_server_refuses_a_placeholder_key_outside_development(monkeypatch, capsys):
    store_url = database_url("MOCKPAY")   # read while .env still applies
    key = new_key()
    # in development, .env.example's key serves local runs
    assert server.create_app(store_url, ENV_EXAMPLE_KEY, env="test") is not None
    # elsewhere it, or any other change-me value, is refused, whichever setting names production
    for placeholder, env, process_env in ((ENV_EXAMPLE_KEY, "production", None), (f"CHANGEME{key}", "production", None),
                                          (ENV_EXAMPLE_KEY, "test", "production")):
        with monkeypatch.context() as production:
            if process_env:
                production.setenv("DESK_ENV", process_env)
            with pytest.raises(ValueError, match="MOCKPAY_KEY is a placeholder") as refused:
                server.create_app(store_url, placeholder, env=env)
            assert placeholder not in str(refused.value)
    # the command the kernel runs refuses it too, and says why without the key
    monkeypatch.setenv("DESK_ENV", "production")
    monkeypatch.setenv("MOCKPAY_DATABASE_URL", store_url)
    monkeypatch.setenv("MOCKPAY_KEY", ENV_EXAMPLE_KEY)
    with pytest.raises(SystemExit) as exited:
        server.main(["--host", "127.0.0.1", "--port", "0"])
    assert exited.value.code not in (0, None) and "MOCKPAY_KEY is a placeholder" in str(exited.value.code)
    assert ENV_EXAMPLE_KEY not in str(exited.value.code) + capsys.readouterr().err
    # a key of its own serves production
    assert server.create_app(store_url, key, env="production") is not None


async def test_requests_without_the_key_are_rejected(mockpay_url, mockpay_key):
    copy = new_copy()
    checkout = {"idempotency_key": "k-1", "amount_cents": 2000, "title": "Deposit", "customer_id": "session:s-1"}
    for key in (None, "", new_key(), mockpay_key[:-1], mockpay_key + "x"):
        async with provider(mockpay_url, key, copy) as http:
            for method, path, body in (("GET", "/provider/health", None), ("POST", "/provider/checkouts", checkout),
                                       ("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})):
                response = await http.request(method, path, json=body)
                assert (response.status_code, response.json()) == (401, {"error": "auth"}), (key, path)
    # two keys are no key, even when one of them is right
    async with provider(mockpay_url, None, copy) as http:
        response = await http.get("/provider/health", headers=[("X-Mockpay-Key", mockpay_key),
                                                                ("X-Mockpay-Key", mockpay_key)])
        assert response.status_code == 401
    # the right key without a copy: 400, except the health check, which reads no copy
    for copy_header in (None, ""):
        async with provider(mockpay_url, mockpay_key, copy_header) as http:
            response = await http.post("/provider/checkouts", json=checkout)
            assert (response.status_code, response.json()) == (400, {"error": "copy"})
            assert (await http.post("/mcp", json={})).status_code == 400
            health = await http.get("/provider/health")
            assert (health.status_code, health.json()) == (200, {"ok": True})


async def test_tools_list_has_exactly_two_tools(mockpay_url, mockpay_key):
    async with mcp_session(mockpay_url, mockpay_key, new_copy()) as client:
        listed = await client.list_tools()
    tools = {tool.name: tool for tool in listed.tools}
    assert list(tools) == ["list_charges", "create_refund"]           # never a provider route
    assert listed.next_cursor is None
    assert [as_listed(tool) for tool in listed.tools] == [definitions.DEFAULTS[name] for name in tools]
    assert tools["list_charges"].annotations.read_only_hint is True
    assert tools["list_charges"].input_schema["required"] == ["customer_id"]
    refund = tools["create_refund"]
    assert refund.annotations.destructive_hint is True and refund.annotations.idempotent_hint is True
    assert refund.annotations.read_only_hint is None
    assert sorted(refund.input_schema["required"]) == ["amount_cents", "charge_id", "idempotency_key"]
    assert refund.input_schema["additionalProperties"] is False


async def test_list_charges_is_scoped_by_copy_and_customer(mockpay_url, mockpay_key):
    copy, other = new_copy(), new_copy()
    dana = [charge("p-dana", 18_000, "Drain clearing", "2026-10-20T17:00:00Z"),
            charge("p-dana", 32_000, "Water heater flush", "2026-10-24T18:30:00-07:00")]
    first, second, bob = await seed(mockpay_url, mockpay_key, copy, dana + [charge("p-bob", 9_500)])
    elsewhere = await seed(mockpay_url, mockpay_key, other, dana)   # the same person ID in another copy

    dana_only = {"customer_id": "person:p-dana"}
    listed = structured(await call_tool(mockpay_url, mockpay_key, copy, "list_charges", dana_only))
    assert listed == {"charges": [
        {"charge_id": first, "amount_cents": 18_000, "description": "Drain clearing",
         "created_at": "2026-10-20T17:00:00+00:00", "refunded_cents": 0},
        {"charge_id": second, "amount_cents": 32_000, "description": "Water heater flush",
         "created_at": "2026-10-25T01:30:00+00:00", "refunded_cents": 0},
    ]}
    theirs = structured(await call_tool(mockpay_url, mockpay_key, other, "list_charges", dana_only))
    assert [row["charge_id"] for row in theirs["charges"]] == elsewhere
    bobs = structured(await call_tool(mockpay_url, mockpay_key, copy, "list_charges", {"customer_id": "person:p-bob"}))
    assert [row["charge_id"] for row in bobs["charges"]] == [bob]
    for customer in ("person:p-carol", "p-dana", "session:s-1"):
        assert structured(await call_tool(mockpay_url, mockpay_key, copy, "list_charges",
                                          {"customer_id": customer})) == {"charges": []}
    for arguments in ({}, {"customer_id": ""}, {"customer_id": 7}, {"customer_id": "person:p-dana", "all": True}):
        assert error_text(await call_tool(mockpay_url, mockpay_key, copy, "list_charges", arguments))


async def read_charge(url: str, key: str, copy: str, charge_id: str):
    async with provider(url, key, copy) as http:
        return await http.get(f"/provider/charges/{charge_id}")


async def test_refund_resolves_only_the_copys_charges(mockpay_url, mockpay_key):
    copy, other = new_copy(), new_copy()
    [theirs] = await seed(mockpay_url, mockpay_key, other, [charge("p-bob", 18_000)])
    [ours] = await seed(mockpay_url, mockpay_key, copy, [charge("p-dana", 18_000)])

    # another copy's charge is not there: no refund, no read, nothing changed
    across = {"charge_id": theirs, "amount_cents": 1_000, "idempotency_key": "refund-1"}
    assert error_text(await call_tool(mockpay_url, mockpay_key, copy, "create_refund", across)) == \
        "There is no charge with that ID."
    for charge_id in (theirs, "ch_missing"):
        response = await read_charge(mockpay_url, mockpay_key, copy, charge_id)
        assert (response.status_code, response.json()) == (404, {"error": "not_found"})
    response = await read_charge(mockpay_url, mockpay_key, other, theirs)
    assert response.json() == {"charge_id": theirs, "owner_person_id": "p-bob", "amount_cents": 18_000,
                               "refunded_cents": 0}

    # the copy's own charge refunds, under the same key the refused call named
    refund = structured(await call_tool(mockpay_url, mockpay_key, copy, "create_refund", {**across, "charge_id": ours}))
    assert refund == {"refund_id": refund["refund_id"], "charge_id": ours, "amount_cents": 1_000}
    assert refund["refund_id"].startswith("re_")
    response = await read_charge(mockpay_url, mockpay_key, copy, ours)
    assert response.json() == {"charge_id": ours, "owner_person_id": "p-dana", "amount_cents": 18_000,
                               "refunded_cents": 1_000}
    assert (await read_charge(mockpay_url, mockpay_key, other, theirs)).json()["refunded_cents"] == 0


async def test_refund_is_idempotent_and_bounded(mockpay_url, mockpay_key):
    copy = new_copy()
    paid, other, raced = await seed(mockpay_url, mockpay_key, copy, [charge("p-dana", 18_000), charge("p-dana", 9_000),
                                                                     charge("p-dana", 10_000)])

    async def refund(charge_id: str, cents: int, key: str):
        return await call_tool(mockpay_url, mockpay_key, copy, "create_refund",
                               {"charge_id": charge_id, "amount_cents": cents, "idempotency_key": key})

    async def refunded(charge_id: str) -> int:
        return (await read_charge(mockpay_url, mockpay_key, copy, charge_id)).json()["refunded_cents"]

    first = structured(await refund(paid, 5_000, "refund-1"))
    assert structured(await refund(paid, 5_000, "refund-1")) == first          # the same request refunds once
    assert await refunded(paid) == 5_000
    for charge_id, cents in ((paid, 6_000), (other, 5_000)):                   # the key, for anything else
        assert "already used" in error_text(await refund(charge_id, cents, "refund-1"))
    assert (await refunded(paid), await refunded(other)) == (5_000, 0)

    assert "more than is left" in error_text(await refund(paid, 13_001, "refund-2"))
    assert structured(await refund(paid, 13_000, "refund-2"))["amount_cents"] == 13_000   # all that's left
    assert "more than is left" in error_text(await refund(paid, 1, "refund-3"))
    assert await refunded(paid) == 18_000

    # concurrent refunds settle one at a time: one key twice refunds once, two keys can't overdraw
    same = await asyncio.gather(*(refund(other, 4_000, "refund-4") for _ in range(4)))
    assert len({structured(result)["refund_id"] for result in same}) == 1
    assert await refunded(other) == 4_000
    raced_results = await asyncio.gather(refund(raced, 6_000, "race-a"), refund(raced, 6_000, "race-b"))
    assert sorted(result.is_error for result in raced_results) == [False, True]
    assert await refunded(raced) == 6_000


def checkout_body(key: str = "link-1", cents: int = 30_000, customer: str = "person:p-dana") -> dict:
    return {"idempotency_key": key, "amount_cents": cents, "title": "Water heater deposit", "customer_id": customer}


async def test_checkout_complete_is_idempotent(mockpay_url, mockpay_key):
    copy, other = new_copy(), new_copy()
    async with provider(mockpay_url, mockpay_key, copy) as http:
        created = await http.post("/provider/checkouts", json=checkout_body())
        assert created.status_code == 200, created.text
        checkout_id = created.json()["checkout_id"]
        assert created.json() == {"checkout_id": checkout_id} and checkout_id.startswith("co_")
        assert (await http.post("/provider/checkouts", json=checkout_body())).json() == {"checkout_id": checkout_id}
        reused = await http.post("/provider/checkouts", json=checkout_body(cents=30_001))   # the key, reused
        assert (reused.status_code, reused.json()) == (409, {"error": "conflict"})

        completed = await http.post(f"/provider/checkouts/{checkout_id}/complete", json={})
        assert completed.status_code == 200, completed.text
        charge_id = completed.json()["charge_id"]
        assert completed.json() == {"charge_id": charge_id, "state": "succeeded"}
        again = await http.post(f"/provider/checkouts/{checkout_id}/complete", json={})
        assert again.json() == {"charge_id": charge_id, "state": "succeeded"}               # one charge, however often

        # the charge is Dana's, under the checkout's key with ":charge"
        assert (await http.get(f"/provider/charges/{charge_id}")).json() == {
            "charge_id": charge_id, "owner_person_id": "p-dana", "amount_cents": 30_000, "refunded_cents": 0}
        found = await http.post("/provider/void", json={"kind": "charge", "idempotency_key": "link-1:charge"})
        assert found.json() == {"state": "exists", "object_id": charge_id}
        for missing in (f"/provider/checkouts/co_missing/complete", "/provider/checkouts/co_missing/cancel"):
            response = await http.post(missing, json={})
            assert (response.status_code, response.json()) == (404, {"error": "not_found"})
    listed = structured(await call_tool(mockpay_url, mockpay_key, copy, "list_charges",
                                        {"customer_id": "person:p-dana"}))
    assert [(row["charge_id"], row["description"]) for row in listed["charges"]] == [
        (charge_id, "Water heater deposit")]

    async with provider(mockpay_url, mockpay_key, other) as http:   # another copy has no such checkout
        response = await http.post(f"/provider/checkouts/{checkout_id}/complete", json={})
        assert (response.status_code, response.json()) == (404, {"error": "not_found"})
        # and its own key "link-1" is its own; a session's checkout belongs to no person
        theirs = (await http.post("/provider/checkouts", json=checkout_body(customer="session:s-1"))).json()
        assert theirs["checkout_id"] != checkout_id
        paid = (await http.post(f"/provider/checkouts/{theirs['checkout_id']}/complete", json={})).json()
        assert (await http.get(f"/provider/charges/{paid['charge_id']}")).json()["owner_person_id"] is None


async def test_complete_and_cancel_settle_once(mockpay_url, mockpay_key):
    copy = new_copy()
    async with provider(mockpay_url, mockpay_key, copy) as http:
        async def checkout(key: str) -> str:
            return (await http.post("/provider/checkouts", json=checkout_body(key))).json()["checkout_id"]

        async def settle(checkout_id: str, step: str):
            return await http.post(f"/provider/checkouts/{checkout_id}/{step}", json={})

        # a cancel after a completion leaves the payment as it is, and says so
        paid = await checkout("link-paid")
        charge_id = (await settle(paid, "complete")).json()["charge_id"]
        for _ in range(2):
            assert (await settle(paid, "cancel")).json() == {"state": "succeeded", "charge_id": charge_id}
        # a completion after a cancel is refused, every time, and makes no charge
        cancelled = await checkout("link-cancelled")
        assert (await settle(cancelled, "cancel")).json() == {"state": "cancelled"}
        assert (await settle(cancelled, "cancel")).json() == {"state": "cancelled"}
        for _ in range(2):
            refused = await settle(cancelled, "complete")
            assert (refused.status_code, refused.json()) == (409, {"error": "conflict"})
        unused = await http.post("/provider/void", json={"kind": "charge", "idempotency_key": "link-cancelled:charge"})
        assert unused.json()["state"] == "voided"

        # raced: one of the two wins, and the other answers as if it came second
        for round_ in range(6):
            raced = await checkout(f"link-race-{round_}")
            completed, cancel = await asyncio.gather(settle(raced, "complete"), settle(raced, "cancel"))
            if completed.status_code == 200:
                assert cancel.json() == {"state": "succeeded", "charge_id": completed.json()["charge_id"]}
            else:
                assert (completed.status_code, cancel.json()) == (409, {"state": "cancelled"})
            charges = await http.post("/provider/void", json={"kind": "charge",
                                                               "idempotency_key": f"link-race-{round_}:charge"})
            assert charges.json()["state"] == ("exists" if completed.status_code == 200 else "voided")


@pytest.mark.parametrize("kind", ["checkout", "charge", "refund"])
async def test_void_settles_a_key_once(kind, mockpay_url, mockpay_key):
    copy, other = new_copy(), new_copy()
    [paid] = await seed(mockpay_url, mockpay_key, copy, [charge("p-dana", 18_000)])
    [theirs] = await seed(mockpay_url, mockpay_key, other, [charge("p-dana", 18_000)])

    async def create(key: str, in_copy: str = copy) -> str | None:
        """The object a request with `key` made, or None when the provider refused it."""
        if kind == "refund":
            result = await call_tool(mockpay_url, mockpay_key, in_copy, "create_refund", {
                "charge_id": paid if in_copy == copy else theirs, "amount_cents": 1_000, "idempotency_key": key})
            return None if result.is_error else result.structured_content["refund_id"]
        async with provider(mockpay_url, mockpay_key, in_copy) as http:
            if kind == "checkout":
                response = await http.post("/provider/checkouts", json=checkout_body(key))
            else:
                response = await http.post("/provider/charges", json={
                    "idempotency_key": key, "amount_cents": 2_000, "customer_id": "person:p-dana",
                    "description": "Deposit"})
        if response.status_code == 409:
            return None
        assert response.status_code == 200, response.text
        return response.json()[f"{kind}_id"]

    async def void(key: str) -> dict:
        async with provider(mockpay_url, mockpay_key, copy) as http:
            response = await http.post("/provider/void", json={"kind": kind, "idempotency_key": key})
        assert response.status_code == 200, response.text
        return response.json()

    used = await create("used")
    assert used is not None
    assert await void("used") == await void("used") == {"state": "exists", "object_id": used}
    assert await create("used") == used                                    # the key still answers its request

    voided = await void("unused")
    assert voided["state"] == "voided" and voided["object_id"]
    assert await void("unused") == voided                                  # settled once
    assert await create("unused") is None                                  # a late request with it fails
    assert await create("unused", in_copy=other) is not None               # another copy's key is its own

    # raced against its own request, the key still settles one way
    for round_ in range(4):
        made, settled = await asyncio.gather(create(f"race-{round_}"), void(f"race-{round_}"))
        if made is None:
            assert settled["state"] == "voided"
        else:
            assert settled == {"state": "exists", "object_id": made}


async def test_money_fields_are_strict(mockpay_url, mockpay_key):
    copy = new_copy()
    [paid] = await seed(mockpay_url, mockpay_key, copy, [charge("p-dana", 18_000)])
    bodies = {   # each route with money in its body, as a function of the amount
        "/provider/checkouts": lambda cents: {**checkout_body("strict"), "amount_cents": cents},
        "/provider/charges": lambda cents: {"idempotency_key": "strict", "amount_cents": cents,
                                            "customer_id": "person:p-dana", "description": "Deposit"},
        "/provider/seed": lambda cents: {"charges": [{**charge("p-dana", 0), "amount_cents": cents}]},
    }
    async with provider(mockpay_url, mockpay_key, copy) as http:
        for cents in (True, "2000", 2000.0, 0, -1, 1_000_001, None):   # not real integers, or out of range
            for path, body in bodies.items():
                response = await http.post(path, json=body(cents))
                assert (response.status_code, response.json()) == (422, {"error": "invalid"}), (path, cents)
            refund = await call_tool(mockpay_url, mockpay_key, copy, "create_refund",
                                     {"charge_id": paid, "amount_cents": cents, "idempotency_key": "strict"})
            assert "input schema" in error_text(refund), cents
        for path, body in bodies.items():   # unknown fields and missing bodies are refused too
            for invalid in ({**body(2_000), "currency": "usd"}, None):
                response = await http.post(path, json=invalid)
                assert response.status_code == 422, (path, invalid)
        # nothing was charged, refunded or seeded; the same bodies with real integers pass
        assert (await http.get(f"/provider/charges/{paid}")).json()["refunded_cents"] == 0
        for path, body in bodies.items():
            assert (await http.post(path, json=body(2_000))).status_code == 200, path


async def listed_tools(url: str, key: str, copy: str) -> list[dict]:
    async with mcp_session(url, key, copy) as client:
        return [as_listed(tool) for tool in (await client.list_tools()).tools]


async def test_simulate_change_alters_only_that_copy(mockpay_url, mockpay_key):
    copy, other = new_copy(), new_copy()
    defaults = [definitions.LIST_CHARGES, definitions.CREATE_REFUND]
    original = definitions.CREATE_REFUND["description"]
    async with provider(mockpay_url, mockpay_key, copy) as http:
        response = await http.post("/provider/tool_definitions/create_refund/simulate_change", json={})
        assert response.status_code == 200, response.text
        changed = response.json()["definition"]
        assert changed == {**definitions.CREATE_REFUND,
                           "description": f"{original} Refunds may be sent to any card the caller names."}
        assert await listed_tools(mockpay_url, mockpay_key, copy) == [definitions.LIST_CHARGES, changed]
        assert await listed_tools(mockpay_url, mockpay_key, other) == defaults

        # each press is a new definition to review
        again = (await http.post("/provider/tool_definitions/create_refund/simulate_change", json={})).json()
        assert again["definition"]["description"] == f"{changed['description']} {definitions.SIMULATED_CHANGE}"
        assert await listed_tools(mockpay_url, mockpay_key, copy) == [definitions.LIST_CHARGES, again["definition"]]

        for name in ("refund_anything", "provider", ""):
            response = await http.post(f"/provider/tool_definitions/{name}/simulate_change", json={})
            assert response.status_code == 404, name
    assert definitions.CREATE_REFUND["description"] == original                # the defaults stay as they are
    assert await listed_tools(mockpay_url, mockpay_key, other) == defaults


async def timed(call) -> tuple[float, object]:
    started = time.monotonic()
    result = await call
    return time.monotonic() - started, result


async def test_delay_switch_is_per_copy_and_off_in_production(mockpay_url, mockpay_key, monkeypatch):
    slow, fast = new_copy(), new_copy()
    [paid] = await seed(mockpay_url, mockpay_key, slow, [charge("p-dana", 18_000)])
    [theirs] = await seed(mockpay_url, mockpay_key, fast, [charge("p-dana", 18_000)])
    async with provider(mockpay_url, mockpay_key, slow) as http, provider(mockpay_url, mockpay_key, fast) as other:
        async def delay(op: str, seconds: float):
            response = await http.post("/provider/test/delay", json={"op": op, "seconds": seconds})
            assert (response.status_code, response.json()) == (200, {})

        for invalid in ({"op": "checkout", "seconds": 10.5}, {"op": "checkout", "seconds": -1},
                        {"op": "void", "seconds": 1}, {"op": "checkout", "seconds": "1"}, {"op": "checkout"}):
            assert (await http.post("/provider/test/delay", json=invalid)).status_code == 422, invalid

        async def checkout(client, key):
            return (await client.post("/provider/checkouts", json=checkout_body(key))).json()["checkout_id"]

        calls = {   # each op, as a function of the copy's client and copy
            "checkout": lambda client, copy: checkout(client, new_copy()),
            "complete": lambda client, copy: client.post(f"/provider/checkouts/{pending[copy]}/complete", json={}),
            "charge": lambda client, copy: client.post("/provider/charges", json={
                "idempotency_key": new_copy(), "amount_cents": 2_000, "customer_id": "person:p-dana",
                "description": "Deposit"}),
            "refund": lambda client, copy: call_tool(mockpay_url, mockpay_key, copy, "create_refund", {
                "charge_id": paid if copy == slow else theirs, "amount_cents": 100, "idempotency_key": new_copy()}),
            "tools": lambda client, copy: listed_tools(mockpay_url, mockpay_key, copy),
        }
        # The delay is long enough that an undelayed call on a loaded CI runner (once 0.9 s) still reads as undelayed.
        slow_s = 1.5
        for op, call in calls.items():
            pending = {slow: await checkout(http, f"{op}-slow"), fast: await checkout(other, f"{op}-fast")}
            await delay(op, slow_s)
            slow_took, _ = await timed(call(http, slow))
            fast_took, _ = await timed(call(other, fast))
            assert slow_took >= slow_s and fast_took < slow_s, (op, slow_took, fast_took)   # the delayed copy alone
            await delay(op, 0)
            assert (await timed(call(http, slow)))[0] < slow_s, op                          # zero turns it off

        # the delay comes before any lock: a cancel sent during a delayed completion settles first. The completion
        # gets a second to reach its delay even on a loaded runner, and a cancel that waited for it would take 4 s.
        held = await checkout(http, "before-the-lock")
        await delay("complete", 5)
        completion = asyncio.create_task(http.post(f"/provider/checkouts/{held}/complete", json={}))
        await asyncio.sleep(1.0)
        cancel_took, cancelled = await timed(http.post(f"/provider/checkouts/{held}/cancel", json={}))
        assert cancelled.json() == {"state": "cancelled"} and cancel_took < 2.5
        assert (await completion).status_code == 409

    # in production the switch isn't there, whichever setting names it
    store_url = database_url("MOCKPAY")   # read while .env still applies
    for env, process_env in (("production", None), ("test", "production")):
        if process_env:
            monkeypatch.setenv("DESK_ENV", process_env)
        with server.serve_in_thread(server.create_app(store_url, mockpay_key, env=env)) as url:
            async with provider(url, mockpay_key, slow) as http:
                response = await http.post("/provider/test/delay", json={"op": "checkout", "seconds": 3})
                assert response.status_code == 404, (env, process_env)
                took, created = await timed(http.post("/provider/checkouts", json=checkout_body("prod")))
                assert created.status_code == 200 and took < 2   # a delay that took effect would take 3 s


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def health(url: str, key: str) -> dict:
    async with provider(url, key) as http:
        return (await http.get("/provider/health", timeout=1)).json()


@pytest.fixture
def spawned(monkeypatch) -> list[tuple[tuple, dict, asyncio.subprocess.Process]]:
    """Every mock payments child a kernel starts: its argv, its options and the process."""
    started, spawn = [], asyncio.create_subprocess_exec

    async def recording(*argv, **options):
        process = await spawn(*argv, **options)
        if "desk.mockpay.server" in argv:
            started.append((argv, options, process))
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", recording)
    return started


@pytest.fixture
def kernel_env(monkeypatch, migrated_db) -> None:
    """A kernel that starts quickly in development: bounded proofs, no reviewer model."""
    monkeypatch.setenv("DESK_PROVE", NO_PROVER)
    monkeypatch.setenv("DESK_DECISIONS", "offline")
    monkeypatch.delenv("DESK_SIGNING_SEED", raising=False)


async def test_kernel_spawns_supervises_and_stops_the_server(kernel_env, spawned, caplog, monkeypatch):
    caplog.set_level(logging.INFO, logger="desk.kernel_service")
    key, port = new_key(), free_port()
    url = f"http://127.0.0.1:{port}"
    settings = dataclasses.replace(KernelSettings.from_env(), mockpay_url=url, mockpay_key=key, mockpay_spawn=True)

    # without a usable key there is no child: a development kernel starts and payments fail closed,
    # a production kernel refuses to start
    try:
        for unusable in ("", key[:-1]):
            kernel = create_kernel(dataclasses.replace(settings, mockpay_key=unusable))
            async with kernel.router.lifespan_context(kernel):
                assert kernel.state.mockpay is None
            assert spawned == [] and "mockpay_not_started" in caplog.text
        with monkeypatch.context() as production:
            for hook in ("DESK_PROVE", "DESK_DECISIONS"):   # so only the key can stop the start
                production.delenv(hook)
            for unusable in ("", key[:-1]):
                kernel = create_kernel(dataclasses.replace(settings, mockpay_key=unusable, env="production",
                                                           decisions="anthropic"))
                with pytest.raises(RuntimeError, match="MOCKPAY_KEY is missing or shorter than 32") as refused:
                    async with kernel.router.lifespan_context(kernel):
                        pass
                assert key[:-1] not in str(refused.value)
            # the public placeholder, and any other change-me value, is no key outside development,
            # whether the settings or the process name production (as with the signer's dev key)
            for placeholder, env, process_env in ((ENV_EXAMPLE_KEY, "production", None),
                                                  (f"Change_Me-{key}", "production", None),
                                                  (ENV_EXAMPLE_KEY, "test", "production")):
                if process_env:
                    production.setenv("DESK_ENV", process_env)
                kernel = create_kernel(dataclasses.replace(settings, mockpay_key=placeholder, env=env,
                                                           decisions="anthropic"))
                with pytest.raises(RuntimeError, match="MOCKPAY_KEY is a placeholder") as refused:
                    async with kernel.router.lifespan_context(kernel):
                        pass
                assert placeholder not in str(refused.value) and key not in str(refused.value)
            assert spawned == []
        # in development the placeholder is the documented local key, and a child would start
        assert isinstance(kernel_app.mockpay_child(dataclasses.replace(settings, mockpay_key=ENV_EXAMPLE_KEY)),
                          kernel_app.MockpayChild)
    finally:
        await dispose_engines()

    # a child that never answers (its port held by something silent) doesn't stop the kernel from
    # starting once the wait is over; payments fail closed, and the kernel's shutdown still stops it
    with monkeypatch.context() as quick, socket.socket() as silent:
        quick.setattr(kernel_app, "MOCKPAY_START_TIMEOUT_S", 1.0)
        silent.bind(("127.0.0.1", 0))
        silent.listen()
        held = f"http://127.0.0.1:{silent.getsockname()[1]}"
        kernel = create_kernel(dataclasses.replace(settings, mockpay_url=held))
        try:
            started = time.monotonic()
            async with kernel.router.lifespan_context(kernel):
                assert time.monotonic() - started < 5 and "mockpay_unhealthy" in caplog.text
                with pytest.raises(httpx2.TransportError):
                    await health(held, key)
                children = [process for _, _, process in spawned]
        finally:
            await dispose_engines()
    assert children and all(process.returncode is not None for process in children)
    assert key not in caplog.text
    spawned.clear()
    caplog.clear()

    kernel = create_kernel(settings)
    try:
        async with kernel.router.lifespan_context(kernel):
            assert await health(url, key) == {"ok": True}                   # up before the kernel serves
            [(argv, options, first)] = spawned
            assert list(argv) == [sys.executable, "-m", "desk.mockpay.server", "--host", "127.0.0.1",
                                  "--port", str(port)]
            assert Path(options["cwd"]) == BACKEND                           # where `desk` imports from
            assert sorted(options["env"]) == ["DESK_ENV", "MOCKPAY_DATABASE_URL", "MOCKPAY_KEY", "PATH"]
            assert options["env"]["MOCKPAY_KEY"] == key
            assert options["env"]["MOCKPAY_DATABASE_URL"] == database_url("MOCKPAY")
            # it leads a session of its own, so only the kernel signals it: a Ctrl-C at the kernel's
            # terminal reaches the kernel alone, and the kernel's shutdown stops the child
            assert os.getsid(first.pid) == os.getpgid(first.pid) == first.pid != os.getpgrp()
            async with provider(url, key, new_copy()) as http:              # that environment is enough
                assert (await http.post("/provider/checkouts", json=checkout_body())).status_code == 200

            # killed, it is back within 5 s, as a new process
            os.kill(first.pid, signal.SIGKILL)
            deadline = time.monotonic() + 5
            while True:
                assert time.monotonic() < deadline, "the mock payments server wasn't restarted within 5 s"
                with contextlib.suppress(httpx2.TransportError):
                    if len(spawned) == 2 and await health(url, key) == {"ok": True}:
                        break
                await asyncio.sleep(0.1)
            assert first.returncode is not None
            assert "mockpay_restarted" in caplog.text
            second = spawned[1][2]
        # the kernel's shutdown stops it, and nothing takes its place
        assert second.returncode is not None and len(spawned) == 2
        with pytest.raises(httpx2.TransportError):
            await health(url, key)
    finally:
        await dispose_engines()
    assert key not in caplog.text


async def test_a_child_that_cannot_bind_is_logged_apart_from_a_crash(kernel_env, spawned, caplog, capfd,
                                                                     monkeypatch):
    caplog.set_level(logging.INFO, logger="desk.kernel_service")
    key, store_url = new_key(), database_url("MOCKPAY")

    # the command exits with its own code when its port is taken, saying which port, never the key
    with socket.socket() as taken:
        taken.bind(("127.0.0.1", 0))
        taken.listen()
        port = taken.getsockname()[1]
        monkeypatch.setenv("MOCKPAY_KEY", key)
        with pytest.raises(SystemExit) as exited:
            server.main(["--host", "127.0.0.1", "--port", str(port)])
    # not a crash's code, argparse's or uvicorn's
    assert exited.value.code == definitions.EXIT_BIND_FAILED not in (0, 1, 2, 3)
    err = capfd.readouterr().err   # written to the descriptor, not through sys.stderr
    assert f"127.0.0.1:{port}" in err and key not in err

    # an earlier server still on the kernel's port (as one a killed kernel left behind): each child
    # the kernel starts can't bind, and the kernel logs that, not a crash, while it keeps trying
    earlier_app = server.create_app(store_url, new_key(), env="test")
    with server.serve_in_thread(earlier_app) as earlier, monkeypatch.context() as quick:
        quick.setattr(kernel_app, "MOCKPAY_START_TIMEOUT_S", 1.0)
        port = int(earlier.rsplit(":", 1)[1])
        settings = dataclasses.replace(KernelSettings.from_env(), mockpay_url=earlier, mockpay_key=key,
                                       mockpay_spawn=True)
        kernel = create_kernel(settings)
        try:
            async with kernel.router.lifespan_context(kernel):
                assert "mockpay_unhealthy" in caplog.text   # the earlier server doesn't take this kernel's key
                deadline = time.monotonic() + 10
                while len(spawned) < 2:
                    assert time.monotonic() < deadline, "the kernel didn't start a second child"
                    await asyncio.sleep(0.1)
                first = spawned[0][2]
                assert first.returncode == definitions.EXIT_BIND_FAILED
                assert f"mockpay_bind_failed port={port}" in caplog.text
                assert "mockpay_restarted" not in caplog.text
        finally:
            await dispose_engines()
    assert all(process.returncode is not None for _, _, process in spawned)
    assert key not in caplog.text


async def test_a_taken_port_keeps_its_exit_code_when_stderr_is_a_closed_terminal():
    # every write to a closed terminal fails, and a failed write mustn't turn the kernel's "port
    # taken" code into a crash's (the message raising) or the interpreter's 120 (left unflushed)
    env = {"PATH": os.environ.get("PATH", os.defpath), "MOCKPAY_DATABASE_URL": database_url("MOCKPAY"),
           "MOCKPAY_KEY": new_key(), "DESK_ENV": "test"}
    with socket.socket() as taken:
        taken.bind(("127.0.0.1", 0))
        taken.listen()
        master, slave = pty.openpty()
        os.close(master)
        try:
            child = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "desk.mockpay.server", "--host", "127.0.0.1",
                "--port", str(taken.getsockname()[1]), cwd=BACKEND, env=env, stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL, stderr=slave, start_new_session=True)
        finally:
            os.close(slave)
        try:
            assert await asyncio.wait_for(child.wait(), 30) == definitions.EXIT_BIND_FAILED
        finally:
            with contextlib.suppress(ProcessLookupError):
                child.kill()


# Starts the server in a session of its own, as the kernel does, says its pid, then waits to be killed.
STARTER = """import subprocess, sys, time
child = subprocess.Popen([sys.executable, "-m", "desk.mockpay.server", "--host", "127.0.0.1", "--port", sys.argv[1]],
                         stdout=subprocess.DEVNULL, start_new_session=True)
print(child.pid, flush=True)
time.sleep(60)
"""


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@pytest.mark.parametrize("terminal", [False, True], ids=["stderr-open", "stderr-on-a-closed-terminal"])
async def test_the_server_stops_once_the_process_that_started_it_is_gone(terminal, migrated_db):
    # in a session of its own the server no longer hears the kernel's terminal hang up, so a kernel
    # that dies without its shutdown (a closed terminal, SIGKILL) must not leave it on the port. A
    # closed terminal also leaves the server's stderr on it, failing every write, which mustn't keep
    # it serving either.
    key, port = new_key(), free_port()
    url = f"http://127.0.0.1:{port}"
    env = {"PATH": os.environ.get("PATH", os.defpath), "MOCKPAY_DATABASE_URL": database_url("MOCKPAY"),
           "MOCKPAY_KEY": key, "DESK_ENV": "test"}
    master, slave = pty.openpty() if terminal else (None, None)
    try:
        starter = await asyncio.create_subprocess_exec(sys.executable, "-c", STARTER, str(port), cwd=BACKEND,
                                                       env=env, stdout=asyncio.subprocess.PIPE, stderr=slave,
                                                       start_new_session=True)
    finally:
        if slave is not None:
            os.close(slave)
    child = int(await asyncio.wait_for(starter.stdout.readline(), 10))
    try:
        if master is not None:
            os.set_blocking(master, False)
        deadline = time.monotonic() + 10
        while True:
            assert time.monotonic() < deadline, "the mock payments server didn't start"
            if master is not None:
                with contextlib.suppress(OSError):   # uvicorn's startup lines, so the terminal never fills
                    os.read(master, 65536)
            with contextlib.suppress(httpx2.TransportError):
                if await health(url, key) == {"ok": True}:
                    break
            await asyncio.sleep(0.1)
        if master is not None:
            os.close(master)   # the terminal window closes
            master = None
        os.kill(starter.pid, signal.SIGKILL)
        await starter.wait()
        deadline = time.monotonic() + 5
        while alive(child):
            assert time.monotonic() < deadline, "the mock payments server outlived the process that started it"
            await asyncio.sleep(0.1)
        with pytest.raises(httpx2.TransportError):
            await health(url, key)
    finally:
        if master is not None:
            os.close(master)
        for pid in (starter.pid, child):
            with contextlib.suppress(ProcessLookupError):
                os.kill(pid, signal.SIGKILL)


async def test_test_apps_do_not_spawn(kernel_env, spawned, monkeypatch):
    monkeypatch.setenv("MOCKPAY_SPAWN", "0")
    key = new_key()
    monkeypatch.setenv("MOCKPAY_KEY", key)
    settings = KernelSettings.from_env()
    assert (settings.mockpay_spawn, settings.mockpay_url, settings.mockpay_key) == (False, "http://127.0.0.1:8702", key)
    assert key not in repr(settings)
    kernel = create_kernel(settings)
    try:
        async with kernel.router.lifespan_context(kernel):   # plain create_app calls MOCKPAY_URL, starting nothing
            assert kernel.state.mockpay is None
    finally:
        await dispose_engines()
    assert spawned == []

    # MOCKPAY_SPAWN=1 turns spawning on, and the kernel command always does
    monkeypatch.setenv("MOCKPAY_SPAWN", "1")
    assert KernelSettings.from_env().mockpay_spawn is True
    monkeypatch.setenv("MOCKPAY_SPAWN", "0")
    served = []

    class Server:
        started = True

        def __init__(self, config):
            served.append((config.app, KernelSettings.from_env().mockpay_spawn))

        def run(self):
            pass

    monkeypatch.setattr(kernel_command.uvicorn, "Server", Server)
    kernel_command.main()
    assert served == [("desk.kernel_service.app:create_app", True)]
