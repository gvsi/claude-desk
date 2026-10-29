"""The API cases' own checks: the quote a script cites, stored events, digits, turn shapes and leaks.

Tier 1's API cases are pending until Plans 02a and 02 land, so these tests are what runs the
checks they judge with, each on crafted input that passes and on input each rule must fail.
"""

import asyncio
import json

import httpx
import pytest

from evals.client import StreamEvent
from evals.fakes import FakeAnthropic, Text
from evals.oracles import scan_visible
from evals.tier1.test_api_payloads import (
    CALL_USAGE,
    GREETING,
    NUMBERS_PROSE,
    OPUS,
    QUOTE_PROSE,
    QuoteScript,
    code_in_log,
    digit_hits,
    found_in,
    is_empty,
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
    held = {"outcome": "held_for_owner", "decision_id": "dec-1", "message": "I've asked Maria."}
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
        "turn 1: writing 1 carries ['text', 'type'] as 'writing'"]
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


def test_is_empty_means_no_records():
    assert is_empty(None) and is_empty([]) and is_empty({}) and is_empty({"entries": [], "head": "0" * 64})
    assert is_empty({"error": "not_found"})
    assert not is_empty([{"seq": 1}])
    assert not is_empty({"entries": [{"seq": 1}], "chain_ok": True})
    assert not is_empty({"state": {}, "items": [{"n": 1}]})
    assert not is_empty({"page": {"entries": [{"seq": 1}]}})


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
