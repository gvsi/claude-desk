"""The API cases' own checks: the quote a script cites, stored events, digits, turn shapes and leaks.

Tier 1's API cases are pending until Plans 02a and 02 land, so these tests are what runs the
checks they judge with, each on crafted input that passes and on input each rule must fail.
"""

import asyncio
import json
import secrets
from contextlib import asynccontextmanager
from types import SimpleNamespace

import httpx
import pytest

from evals.client import StreamEvent
from evals.fakes import FakeAnthropic, Text
from evals.oracles import scan_visible
from evals.tier1 import test_api_payloads as api_payloads
from evals.tier1.test_api_payloads import (
    CALL_USAGE,
    GREETING,
    NUMBERS_PROSE,
    OPUS,
    QUOTE_PROSE,
    QuoteScript,
    code_in_log,
    digit_hits,
    empty_read_problems,
    found_in,
    quote_fact_id,
    read_quietly,
    read_turn,
    sse_payloads,
    turn_problems,
)


def test_the_smoke_greeting_passes_the_scanner():
    """The API conformance smoke test's only scripted reply carries no amount or date, so a
    compliant reply checker shows it rather than regenerating (its earlier "today" would be blocked,
    leaving the one-call case an unscripted second conversation call)."""
    assert scan_visible(GREETING) == [], f"the smoke greeting has scanner hits: {scan_visible(GREETING)}"
    assert NUMBERS_PROSE and scan_visible(NUMBERS_PROSE), "the blocked prose must have hits, as the case expects"


def request_with(tool_result_content: object, *, name: str = "native__quote") -> dict:
    """A Messages request whose history holds one `name` call and its tool result."""
    return {"model": "claude-opus-5-5", "messages": [
        {"role": "user", "content": "How much is a drain clearing?"},
        {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "", "signature": "x"},
            {"type": "tool_use", "id": "toolu_1", "name": name, "input": {"items": [{"item_id": "drain", "qty": 1}]}},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": tool_result_content}]},
    ]}


def test_quote_fact_id_reads_the_quote_result_claude_was_sent():
    done = {"outcome": "done", "decision_id": "dec-1", "result": {"fact_id": "quote:q-1"}, "fact_ids": ["quote:q-1"]}
    assert quote_fact_id(request_with(json.dumps(done))) == "quote:q-1"
    assert quote_fact_id(request_with([{"type": "text", "text": json.dumps(done)}])) == "quote:q-1"
    assert quote_fact_id({"model": "claude-opus-5-5", "messages": [{"role": "user", "content": "Hi"}]}) is None
    assert quote_fact_id(request_with(json.dumps(done), name="native__find_slots")) is None


def test_a_quote_not_done_fails_the_script():
    held = {"outcome": "held_for_owner", "decision_id": "dec-1", "message": "I've asked Mike."}
    with pytest.raises(AssertionError, match="held_for_owner"):
        quote_fact_id(request_with(json.dumps(held)))
    two = {"outcome": "done", "decision_id": "dec-1", "result": {}, "fact_ids": ["quote:q-1", "quote:q-2"]}
    with pytest.raises(AssertionError, match="not one quote done"):
        quote_fact_id(request_with(json.dumps(two)))


async def test_quote_script_cites_the_fact_the_kernel_returned():
    """Claude quotes, then cites the quote's own fact once its result arrives, then says the follow-ups."""
    fake = FakeAnthropic().start()
    try:
        script = QuoteScript(fake, [Text(NUMBERS_PROSE)]).start()
        done = {"outcome": "done", "decision_id": "dec-1", "result": {}, "fact_ids": ["quote:q-9"]}
        async with httpx.AsyncClient(base_url=fake.url) as client:
            async def ask(body: dict) -> dict:
                response = await client.post("/v1/messages", json={**body, "max_tokens": 64})
                assert response.status_code == 200, response.text
                return response.json()

            first = await ask({"model": OPUS, "messages": [{"role": "user", "content": "How much?"}]})
            second = await ask(request_with(json.dumps(done)))
            third = await ask(request_with(json.dumps(done)))
    finally:
        fake.stop()
    assert [block["name"] for block in first["content"]] == ["native__quote"]
    assert first["usage"]["input_tokens"] == CALL_USAGE[0].input_tokens
    assert second["content"][0]["input"] == {"prose": QUOTE_PROSE,
                                             "clauses": [{"template": "quote", "fact_id": "quote:q-9"}]}
    assert second["usage"]["input_tokens"] == CALL_USAGE[1].input_tokens
    assert third["content"] == [{"type": "text", "text": NUMBERS_PROSE}]   # the result seen again scripts nothing new
    assert script.fact_id == "quote:q-9"
    fake.check()


def test_sse_payloads_are_the_published_events_by_seq():
    rows = [
        {"kind": "sse", "seq": 1, "type": "writing", "payload": {"type": "writing"}},
        {"kind": "control", "seq": None, "type": "decision_due", "payload": {"decision_id": "dec-1"}},
        {"kind": "sse", "seq": 2, "type": "turn_end", "payload": json.dumps({"type": "turn_end"})},
        {"kind": "metric", "seq": None, "type": "reveal", "payload": {"attempts": 1}},
        {"kind": "control", "seq": 3, "type": "run_resumable", "payload": {}},   # kind decides, not a seq
    ]
    assert sse_payloads(rows) == {1: {"type": "writing"}, 2: {"type": "turn_end"}}


def test_digit_hits_read_what_a_visitor_reads_outside_cards():
    message = {"type": "message", "visitor_plain": "Reply checked", "blocks": [
        {"kind": "prose", "text": "Here is your quote."},
        {"kind": "card", "template": "quote", "text": "Drain clearing $180", "title": "Quote", "lines": ["$180"]},
    ]}
    assert digit_hits([("message 1", message)]) == []
    leaky = {"type": "message", "visitor_plain": "Reply checked", "blocks": [
        {"kind": "prose", "text": "It costs $89, or 15% off."}]}
    assert digit_hits([("message 2", leaky)]) == [
        ("message 2", "currency", "$"), ("message 2", "digit", "89"), ("message 2", "digit", "15"),
        ("message 2", "percent", "%"),
    ]
    receipt = {"type": "receipt", "visitor_plain": "Quote for eighty-nine dollars ready", "ledger_seq": 12}
    assert [kind for _, kind, _ in digit_hits([("receipt", receipt)])] == ["currency"]


def event(seq: int, kind: str, data: dict | None = None, name: str | None = None) -> StreamEvent:
    return StreamEvent(id=str(seq), event=name or kind, data=data if data is not None else {"type": kind})


def test_turn_problems_hold_writing_first_and_one_turn_end():
    message = {"type": "message", "author": "claude"}
    good = [[event(1, "writing"), event(2, "receipt"), event(3, "message", message), event(4, "turn_end")],
            [event(5, "writing"), event(6, "message", message), event(7, "turn_end")]]
    assert turn_problems(good) == []
    assert turn_problems([[event(1, "message", message), event(2, "writing"), event(3, "turn_end")]]) == [
        "turn 1: message 1 has no writing before it"]
    assert turn_problems([[event(1, "writing", {"type": "writing", "text": "Thinking about $89"}),
                           event(2, "message", message), event(3, "turn_end")]]) == [
        "turn 1: writing 1 carries ['*', 'type'] as 'writing'"]
    assert turn_problems([[event(1, "writing", {"type": "writing", TOKEN_KEY: 1, HEX_KEY: 2}),
                           event(2, "turn_end")]]) == [   # keys a token could have are never shown
        "turn 1: writing 1 carries ['*', '*', 'type'] as 'writing'"]
    assert turn_problems([[event(1, "writing", name="message"), event(2, "turn_end")]]) == [
        "turn 1: writing 1 carries ['type'] as 'message'"]
    assert turn_problems([[event(1, "writing"), event(2, "message", message)]]) == [
        "turn 1 ends ['writing', 'message'], not with its one turn_end"]
    assert turn_problems([[event(1, "writing"), event(2, "turn_end"), event(3, "turn_end")]]) == [
        "turn 1 ends ['writing', 'turn_end', 'turn_end'], not with its one turn_end"]


def test_found_in_reads_ids_as_written_and_planted_words_loosely():
    needles = {"session id": "s-Ab12", "planted": "acorn alder amber basil birch bramble"}
    assert found_in('{"state": {"session_id": "s-Ab12"}}', needles) == ["session id"]
    assert found_in("Noted: ACORN, alder; amber\nbasil birch-bramble.", needles) == ["planted"]
    assert found_in('{"state": {"session_id": "s-ab12"}}', needles) == []
    assert found_in("acorn alder amber basil birch", needles) == []


def test_code_in_log_finds_only_the_code_itself():
    assert code_in_log("verify_check code=482913 failed", "482913")
    assert code_in_log("[482913]", "482913")
    for text in ("id 1482913", "4829130", "hash ab482913cd", "48-29-13", "latency 482.913"):
        assert not code_in_log(text, "482913"), text


FOREIGN_NOTE = "Bob asked privately for a refund: his invoice has the wrong address."   # another copy's record
EMPTY_LEDGER = {"entries": [], "head": "0" * 64, "chain_ok": True, "first_bad_seq": None,
                "public_key_hex": "ab" * 32, "key_id": "ab" * 8}
NOT_FOUND = {"error": "kernel", "code": "not_found"}


def test_empty_read_problems_allow_only_errors_and_empty_shapes():
    """A read naming another copy's records answers 404 with the API's error body (or none), or a
    success holding nothing in its operation's shape: no body, an empty list or object, a
    transcript with no items and no state, a ledger page with no entries and only its documented
    metadata. Anything else is a problem, a scalar field or a scalar body above all."""
    nothing = [(404, None), (404, NOT_FOUND), (404, {"error": "not_found", "code": None, "retry_after": None}),
               (200, None), (200, []), (200, {}), (204, None)]
    for op in ("owner_session", "owner_decision", "owner_ledger"):
        for status, body in nothing:
            assert empty_read_problems(op, status, body) == [], (op, status, body)
    assert empty_read_problems("owner_session", 200, {"items": []}) == []
    assert empty_read_problems("owner_session", 200, {"state": None, "items": []}) == []
    assert empty_read_problems("owner_ledger", 200, EMPTY_LEDGER) == []
    assert empty_read_problems("owner_ledger", 200, {"entries": []}) == []

    something = {
        "a scalar field": ("owner_session", 200, {"summary": FOREIGN_NOTE, "items": []}),
        "nested scalar data": ("owner_session", 200, {"items": [], "state": {"note": FOREIGN_NOTE}}),
        "a scalar body": ("owner_decision", 200, FOREIGN_NOTE),
        "a number body": ("owner_decision", 200, 18000),
        "a list of records": ("owner_session", 200, [{"text": FOREIGN_NOTE}]),
        "a record": ("owner_decision", 200, {"decision_id": "dec-b", "reason_plain": FOREIGN_NOTE}),
        "a page with entries": ("owner_ledger", 200, {**EMPTY_LEDGER, "entries": [{"seq": 1}]}),
        "a page with a note": ("owner_ledger", 200, {**EMPTY_LEDGER, "note": FOREIGN_NOTE}),
        "a note as the head": ("owner_ledger", 200, {**EMPTY_LEDGER, "head": FOREIGN_NOTE}),
        "a transcript's fields on a ledger": ("owner_ledger", 200, {"items": []}),
        "a note in an error body": ("owner_decision", 404, {**NOT_FOUND, "detail": FOREIGN_NOTE}),
        "a note as the error": ("owner_decision", 404, {"error": FOREIGN_NOTE}),
        "an error body that is text": ("owner_ledger", 404, FOREIGN_NOTE),
        "a refusal not a 404": ("owner_ledger", 403, NOT_FOUND),
        "a server error": ("owner_session", 500, None),
    }
    passed = [name for name, (op, status, body) in something.items() if not empty_read_problems(op, status, body)]
    assert passed == []
    problems = [problem for op, status, body in something.values() for problem in empty_read_problems(op, status, body)]
    assert not [problem for problem in problems if "Bob" in problem], "a problem names what the answer held"


# Keys an answer chooses that a token could have: one spelled like a field name, and one in
# hexadecimal that starts with a letter. Made fresh each run, so no token-like text is in the source.
TOKEN_KEY = "tok_" + secrets.token_hex(16)
HEX_KEY = "e" + secrets.token_hex(19)


def test_empty_read_problems_name_only_the_contracts_fields():
    """A problem names a field only when the read's contract declares it (the API's error body,
    `Decision`, `LedgerPage`, a transcript's `items` and `state`); any other key is the answer's
    own choice, so it may be a token, and is never shown, however it is spelled."""
    keyed = {
        "a token-shaped key": ("owner_session", 200, {"items": [], TOKEN_KEY: True}),
        "a hexadecimal key": ("owner_ledger", 200, {**EMPTY_LEDGER, HEX_KEY: 1}),
        "both beside a decision": ("owner_decision", 200, {"decision_id": "dec-b", TOKEN_KEY: 1, HEX_KEY: 2}),
        "both in an error body": ("owner_decision", 404, {**NOT_FOUND, TOKEN_KEY: 1, HEX_KEY: 2}),
        "a field-shaped key": ("owner_session", 200, {"items": [], "summary": FOREIGN_NOTE}),
    }
    for name, (op, status, body) in keyed.items():
        problems = empty_read_problems(op, status, body)
        assert problems, name
        shown = [problem for problem in problems if TOKEN_KEY in problem or HEX_KEY in problem or "summary" in problem]
        assert shown == [], (name, shown)
    assert len(empty_read_problems("owner_decision", 404, {**NOT_FOUND, TOKEN_KEY: 1, HEX_KEY: 2})) == 2   # one each
    decision = empty_read_problems("owner_decision", 200, {"decision_id": "dec-b", TOKEN_KEY: 1})
    assert any("'decision_id'" in problem for problem in decision), decision   # Decision declares it


@pytest.mark.parametrize("key", ["token", "hex"])
async def test_cross_copy_case_never_prints_an_undeclared_key(monkeypatch: pytest.MonkeyPatch, key):
    """The whole case fails a read whose answer holds a key the contract doesn't declare, and its
    failure shows the key nowhere: a token-shaped or hexadecimal key is never printed."""
    chosen = TOKEN_KEY if key == "token" else HEX_KEY
    with pytest.raises(AssertionError, match="A's owner reading B's") as failure:
        await run_cross_copy_case(monkeypatch, 200, {"items": [], chosen: True})
    assert chosen not in str(failure.value), str(failure.value)


class StreamOf:
    """A client whose open chat streams `events`, then, if `then_wait`, stays open and quiet."""

    def __init__(self, events: list[StreamEvent], then_wait: bool = False):
        self._events, self._then_wait = events, then_wait
        self.asked: list[tuple[object, object]] = []
        self.closed = False

    async def events(self, last_event_id=None, *, query=None):
        self.asked.append((last_event_id, query))
        try:
            for item in self._events:
                yield item
            if self._then_wait:
                await asyncio.sleep(3600)
        finally:
            self.closed = True


async def test_read_turn_reads_to_the_turn_end():
    stream = StreamOf([event(4, "writing"), event(5, "message", {"type": "message"}), event(6, "turn_end"),
                       event(7, "writing")])
    turn = await read_turn(stream, "3")
    assert [item.id for item in turn] == ["4", "5", "6"]
    assert stream.asked == [("3", None)] and stream.closed
    with pytest.raises(AssertionError, match="ended before turn_end"):
        await read_turn(StreamOf([event(1, "writing")]), None)
    waiting = StreamOf([event(1, "writing")], then_wait=True)
    with pytest.raises(AssertionError, match=r"no turn_end within 0.2 s; the stream carried \['writing'\]"):
        await read_turn(waiting, None, timeout_s=0.2)
    assert waiting.closed


async def test_read_quietly_reads_what_comes_within_its_time():
    stream = StreamOf([event(1, "writing")], then_wait=True)
    assert [item.id for item in await read_quietly(stream, query={"session_id": "s-b"}, seconds=0.2)] == ["1"]
    assert stream.asked == [(None, {"session_id": "s-b"})] and stream.closed


# The cross-copy owner case, run whole against stand-in clients

class CrossCopyClient:
    """One browser in `test_owner_cookie_with_another_copys_ids_reads_nothing`: its copy and chat,
    the owner reads of its own copy, and `request`, which the case sends only for the reads
    naming copy B's records; each answers `foreign`'s status and body."""

    def __init__(self, n: int, foreign: tuple[int, object]):
        self.copy = "a" if n in (0, 2) else "b"   # owner A, owner B, visitor A, visitor B
        self.foreign, self.session_id = foreign, None

    async def enter(self) -> dict:
        desk = {"desk_id": f"desk-{self.copy}", "slug": f"slug-{self.copy}"}
        return {"copy_id": f"copy-{self.copy}", "desks": [desk]}

    async def open_chat(self, slug: str) -> dict:
        self.session_id = f"s-{slug}"
        return {"session_id": self.session_id}

    async def owner_session(self, session_id: str) -> dict:
        return {"state": {"session_id": session_id}, "items": []}

    async def owner_decision(self, decision_id: str) -> dict:
        return {"decision_id": decision_id}

    async def owner_ledger(self, desk_id: str) -> dict:
        return {**EMPTY_LEDGER, "entries": [{"seq": 1}]}

    async def request(self, op: str, **kwargs: object) -> httpx.Response:
        status, body = self.foreign
        return httpx.Response(status) if body is None else httpx.Response(status, json=body)


class CrossCopyRecords:
    async def decisions(self, copy_id: str) -> list[dict]:
        return [{"decision_id": f"dec-{copy_id}"}]

    async def ledger_entries(self, copy_id: str, desk_id: str) -> list[SimpleNamespace]:
        return [SimpleNamespace(seq=1, hash=f"{ord(copy_id[-1]):064x}")]


async def run_cross_copy_case(monkeypatch: pytest.MonkeyPatch, status: int, body: object) -> None:
    @asynccontextmanager
    async def clients(api: object, n: int):
        yield [CrossCopyClient(i, (status, body)) for i in range(n)]

    async def plant(client: CrossCopyClient, words: str, reply: str) -> dict[str, str]:
        return {"session id": client.session_id, "planted message": words, "planted reply": reply}

    monkeypatch.setattr(api_payloads, "clients", clients)
    monkeypatch.setattr(api_payloads, "plant", plant)
    await api_payloads.test_owner_cookie_with_another_copys_ids_reads_nothing(
        SimpleNamespace(travel=lambda when: None), SimpleNamespace(), FakeAnthropic(), CrossCopyRecords())


@pytest.mark.parametrize(("status", "body"), [(404, NOT_FOUND), (404, None), (200, [])],
                         ids=["error", "no body", "empty"])
async def test_cross_copy_case_passes_reads_that_answer_nothing(monkeypatch: pytest.MonkeyPatch, status, body):
    await run_cross_copy_case(monkeypatch, status, body)


@pytest.mark.parametrize(("status", "body"), [
    (200, {"summary": FOREIGN_NOTE, "items": []}),     # a foreign note in a scalar field
    (200, {"items": [], "page": {"note": FOREIGN_NOTE}}),   # in nested scalar data
    (200, FOREIGN_NOTE),                                 # as a scalar body
    (404, {**NOT_FOUND, "detail": FOREIGN_NOTE}),        # beside a 404's error body
], ids=["scalar field", "nested scalar", "scalar body", "error body"])
async def test_cross_copy_case_fails_a_read_holding_another_copys_note(
    monkeypatch: pytest.MonkeyPatch, status, body,
):
    """Copy B's private note holds none of B's ids or planted words, so only the shape of the
    answer can catch it: each of the three reads answering it fails the case."""
    with pytest.raises(AssertionError, match="A's owner reading B's"):
        await run_cross_copy_case(monkeypatch, status, body)
