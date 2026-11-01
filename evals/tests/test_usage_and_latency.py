"""Usage, cost and latency: list prices, cost per conversation, the reviewer's skip rate, and the
latency of a checked reply from the client's clock and the API's and kernel's own records.

Every case runs on crafted records (`app.model_calls` rows, ledger entries, `app.run_events` metric
rows and turn samples), so no model, database or API is involved.
"""

import itertools
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from evals.client import ApiCallFailed, StreamEvent
from evals.latency import (
    KINDS,
    MESSAGES,
    LatencyConfig,
    LatencyDeps,
    LatencyMismatch,
    LatencyRefused,
    Measured,
    TurnSample,
    drive,
    hosted_latency,
    local_latency,
    run_latency,
)
from evals.pricing import PRICES, NoPrice, Price, cost_usd
from evals.report import Latency, Spread
from evals.tests.artifacts import COPY, SESSION, START, Run, legit
from evals.tests.eval_repo import make_repo
from evals.tier2.passes import read_spend
from evals.usage import UsageRecord, conversation_metrics, percentile, reviewer_calls_per_conversation, skip_rate

OPUS, SONNET, HAIKU = "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"
_IDS = itertools.count(1)


def model_call(route: str, model: str, *, session_id: str | None = SESSION, input_tokens: int = 1_500,
               cached: int = 4_500, write: int = 0, output: int = 350, ms: int = 2_400) -> dict[str, Any]:
    """An `app.model_calls` row as a run artifact's usage holds it."""
    return {"part": "api", "model_call_id": next(_IDS), "copy_id": COPY, "session_id": session_id, "route": route,
            "model": model, "input_tokens": input_tokens, "cached_tokens": cached, "cache_write_tokens": write,
            "output_tokens": output, "latency_ms": ms, "stop_reason": "end_turn", "created_at": START.isoformat()}


def call_usage(model: str, *, input_tokens: int = 600, cached: int = 1_200, write: int = 0, output: int = 120,
               ms: int = 1_100, status: str = "ok") -> dict[str, Any]:
    """A kernel check's `CallUsage`, as its `review` entry or its `reply` entry's `soft_promise` holds it."""
    return {"model": model, "status": status, "input_tokens": input_tokens, "cached_tokens": cached,
            "cache_write_tokens": write, "output_tokens": output, "latency_ms": ms}


def reply_entry(run: Run, soft_promise: dict[str, Any] | None, *, session_id: str = SESSION) -> None:
    run.event("reply", session_id=session_id, ref_id=f"m-{next(_IDS)}", message_id=f"m-{next(_IDS)}",
              author="claude", ok=True, language="en", violations=[], rule_ids=[], fact_ids=[],
              soft_promise=soft_promise)


def priced(row: dict[str, Any], provider: str = "anthropic") -> float:
    return cost_usd(row, row["model"], provider)


def turn(kind: str, n: int, *shown: tuple[str, float], error: str | None = None) -> TurnSample:
    """A latency turn: the `n`th of its kind's chat, the Claude messages it showed (id, ms after the POST)."""
    return TurnSample(kind=kind, turn=n, session_id=f"s-{kind}", shown=dict(shown), error=error)


def reveal(message_id: str, reveal_ms: int, check_reply_ms: int, *, seconds_late: int = 0) -> dict[str, Any]:
    """A `RevealMetric` row in `app.run_events`, stored `seconds_late` after the turn began."""
    return {"kind": "metric", "type": "reveal", "seq": None, "created_at": START.timestamp() + seconds_late,
            "payload": {"message_id": message_id, "model_finish_to_reveal_ms": reveal_ms,
                        "check_reply_ms": check_reply_ms, "attempts": 1}}


def test_cost_matches_the_master_plan_examples():
    """The per-call examples in the master plan's "Model cost and latency budget", at its list prices."""
    opus_first_call = {"input_tokens": 1_500, "cache_read_input_tokens": 4_500, "cache_creation_input_tokens": 0,
                       "output_tokens": 350}
    reviewer = {"input_tokens": 600, "cache_read_input_tokens": 1_200, "cache_creation_input_tokens": 0,
                "output_tokens": 120}
    soft_promise = {"input_tokens": 900, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
                    "output_tokens": 40}
    assert cost_usd(opus_first_call, "claude-opus-5-5", "anthropic") == pytest.approx(0.0139)
    assert cost_usd(reviewer, "claude-sonnet-5-5", "anthropic") == pytest.approx(0.00252)
    assert cost_usd(soft_promise, SONNET, "anthropic") == pytest.approx(0.0022)
    # A cold cache: the same call writing the 4,500 tokens it would have read adds 4,500 × ($5 − $0.20) per MTok.
    cold = {**opus_first_call, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 4_500}
    assert cost_usd(cold, "claude-opus-5-5", "anthropic") - cost_usd(opus_first_call, "claude-opus-5-5",
                                                                      "anthropic") == pytest.approx(0.0216)


def test_soft_check_usage_prices_production_sonnet_and_historical_haiku():
    from desk.kernel_service.decisions import SOFT_PROMISE_MODEL
    from evals.tier2.runner import KERNEL_CHECK_MODELS
    from evals.usage import kernel_check_call

    assert KERNEL_CHECK_MODELS["reply"] == SOFT_PROMISE_MODEL == SONNET
    for model, expected in [(SONNET, 0.0022), (HAIKU, 0.00011)]:
        usage = kernel_check_call({"kind": "reply", "session_id": SESSION, "summary": {
            "soft_promise": call_usage(model, input_tokens=900, cached=0, output=40, ms=6_000)}})
        assert usage.model == model and usage.ms == 6_000
        assert usage.cost_usd("anthropic") == pytest.approx(expected)


def test_claude_api_prices_are_the_apis():
    """The evals price the Claude API as the API's own budget does (`desk.api.metrics.PRICES_PER_MTOK`:
    input, cache read, 5-minute cache write and output)."""
    from desk.api.metrics import PRICES_PER_MTOK

    assert {model: (price.input, price.cache_read, price.cache_write, price.output)
            for model, price in PRICES["anthropic"].items()} == PRICES_PER_MTOK


def test_cost_uses_the_providers_prices():
    """The same usage costs what its provider's row says, whichever name the provider gives the model;
    a provider with no row for the model can't price it."""
    usage = {"input_tokens": 1_000_000, "cached_tokens": 1_000_000, "cache_write_tokens": 1_000_000,
             "output_tokens": 1_000_000}   # the API's and the kernel's names for the cache counts
    regional = {**PRICES, "bedrock": {"claude-opus-5-5": Price(Fraction("4.40"), Fraction("0.22"), Fraction("5.50"),
                                                               Fraction(22))}}
    assert cost_usd(usage, "claude-opus-5-5", "anthropic", prices=regional) == pytest.approx(4 + 0.20 + 5 + 20)
    assert cost_usd(usage, "claude-opus-5-5", "bedrock", prices=regional) == pytest.approx(4.40 + 0.22 + 5.50 + 22)
    assert cost_usd(usage, "us.anthropic.claude-opus-5-5", "bedrock", prices=regional) == pytest.approx(32.12)
    with pytest.raises(NoPrice, match="bedrock"):
        cost_usd(usage, "claude-sonnet-5-5", "bedrock", prices=regional)
    with pytest.raises(NoPrice, match="bedrock"):   # empty until filled from AWS's pricing page
        cost_usd(usage, "claude-opus-5-5", "bedrock")
    with pytest.raises(NoPrice):
        cost_usd(usage, "claude-opus-5-5", "fake")


def test_percentile_is_nearest_rank():
    """The smallest sample at or above q percent of them: always a sample, never an interpolation."""
    samples = [15, 20, 35, 40, 50]
    assert [percentile(samples, q) for q in (5, 30, 40, 50, 95, 100)] == [15, 20, 20, 35, 50, 50]
    twenty = list(range(1, 21))[::-1]   # order doesn't matter
    assert percentile(twenty, 50) == 10 and percentile(twenty, 95) == 19
    assert percentile([7.5], 50) == percentile([7.5], 95) == 7.5
    with pytest.raises(ValueError):
        percentile([], 50)
    for q in (0, -5, 101):
        with pytest.raises(ValueError):
            percentile(samples, q)


def test_cost_per_conversation_counts_desk_calls_only():
    """Desk-side cost per conversation is the conversation, reviewer, soft-promise, triage and translation
    calls of the run's own sessions; setup calls are reported apart, and the visiting agent's calls and
    the simulated visitor's are left out."""
    first = Run(legit())
    conversation = [model_call("conversation", OPUS), model_call("conversation", OPUS, input_tokens=2_100, output=250)]
    triage, translation = model_call("triage", HAIKU, cached=0), model_call("translation", HAIKU, cached=0)
    setup = [model_call("setup", OPUS, session_id=None), model_call("card_draft", OPUS, session_id=None)]
    left_out = [model_call("visiting_agent", OPUS), model_call("conversation", OPUS, session_id="s-elsewhere")]
    reviewer, soft = call_usage(SONNET), call_usage(SONNET, input_tokens=900, cached=0, output=40, ms=420)
    first.event("review", ref_id=first.decide("native.book"), **reviewer)
    first.event("review", session_id="s-elsewhere", ref_id="d-elsewhere", **call_usage(SONNET))   # not the run's
    reply_entry(first, soft)
    reply_entry(first, None)   # a card-only reply: no soft-promise call
    first_artifact = first.build(usage=[*conversation, triage, translation, *setup, *left_out],
                                 simulator_usage=[{"model": SONNET, "input_tokens": 3_000, "output_tokens": 200,
                                                   "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
                                                   "latency_ms": 3_000}])
    second = Run(legit())
    second_call = model_call("conversation", OPUS, write=4_500, cached=0)   # a cold cache
    reply_entry(second, soft)
    second_artifact = second.build(usage=[second_call])

    metrics = conversation_metrics([first_artifact, second_artifact])

    first_cost = sum(map(priced, [*conversation, triage, translation, reviewer, soft]))
    second_cost = priced(second_call) + priced(soft)
    assert metrics.conversations == 2
    assert metrics.cost_per_conversation_usd.mean == pytest.approx((first_cost + second_cost) / 2)
    assert metrics.cost_per_conversation_usd.p50 == pytest.approx(min(first_cost, second_cost))
    assert metrics.cost_per_conversation_usd.p95 == pytest.approx(max(first_cost, second_cost))
    assert metrics.setup_cost_usd == pytest.approx(sum(map(priced, setup)))
    assert conversation_metrics([second_artifact]).setup_cost_usd is None   # no setup call: nothing to report
    assert conversation_metrics([]) is None


MISSING = object()


@pytest.mark.parametrize("summary", [MISSING, None, [], "", False, {"ok": True}],
                         ids=["no summary", "null", "a list", "empty text", "false", "no soft_promise key"])
def test_a_reply_entry_that_doesnt_say_whether_its_check_called_is_never_read_as_no_call(summary):
    """The kernel's `reply` entry always says whether its soft-promise check made a call: `soft_promise`
    is the call, or null for none. An entry whose summary isn't an object holding that key can't say, so
    reading it raises rather than count no call."""
    run = Run(legit())
    seq = run.event("reply", ref_id="m-unsaid", ok=True)
    if summary is MISSING:
        del run.ledger[seq - 1]["summary"]
    else:
        run.ledger[seq - 1]["summary"] = summary
    with pytest.raises(ValueError, match="the kernel's reply entry"):
        conversation_metrics([run.build()])


def test_tokens_per_call_by_route():
    """Mean tokens per call for each route the Desk's calls took, over every run; the simulated
    visitor's calls aren't the Desk's and aren't listed."""
    first, second = Run(legit()), Run(legit())
    first.event("review", ref_id=first.decide("native.book"),
                **call_usage(SONNET, input_tokens=610, cached=1_190, output=118))
    reply_entry(first, call_usage(SONNET, input_tokens=900, cached=0, output=40))
    reply_entry(second, call_usage(SONNET, input_tokens=910, cached=0, output=43))
    simulator = [{"model": OPUS, "input_tokens": 2_000, "output_tokens": 300, "cache_read_input_tokens": 0,
                  "cache_creation_input_tokens": 0, "latency_ms": 4_000}]
    runs = [
        first.build(usage=[model_call("conversation", OPUS, input_tokens=1_500, cached=4_500, output=350),
                           model_call("conversation", OPUS, input_tokens=2_100, cached=4_500, output=250),
                           model_call("visiting_agent", OPUS, input_tokens=800, cached=0, output=90)],
                    simulator_usage=simulator),
        second.build(usage=[model_call("conversation", OPUS, input_tokens=1_200, cached=0, write=4_500, output=300),
                            model_call("setup", OPUS, session_id=None, input_tokens=3_000, cached=0, output=500)],
                     simulator_usage=simulator),
    ]

    tokens = conversation_metrics(runs).tokens_per_call

    assert sorted(tokens) == ["conversation", "reviewer", "setup", "soft_promise", "visiting_agent"]
    conversation = tokens["conversation"]
    assert conversation.calls == 3
    assert (conversation.input, conversation.cached, conversation.cache_write, conversation.output) == (
        pytest.approx(1_600), pytest.approx(3_000), pytest.approx(1_500), pytest.approx(300))
    assert tokens["reviewer"].model_dump() == {"calls": 1, "input": 610, "cached": 1_190, "cache_write": 0,
                                               "output": 118}
    assert (tokens["soft_promise"].calls, tokens["soft_promise"].input, tokens["soft_promise"].output) == (
        2, pytest.approx(905), pytest.approx(41.5))
    assert (tokens["setup"].calls, tokens["visiting_agent"].calls) == (1, 1)


def test_reviewer_calls_and_skip_rate():
    """The reviewer is called on 2 of the run's 9 /decide calls, so 7 of 9 skip it; a decision of
    another session in the copy isn't the run's."""
    run = Run(legit())
    run.session("s-seed", own=False)
    run.decide("native.quote", outcome="hold", state="held", session_id="s-seed", shown=False)
    for _ in range(4):
        run.decide("native.find_slots")
    for _ in range(3):
        run.decide("native.quote", outcome="hold", state="held")
    for _ in range(2):
        decision = run.decide("native.book")
        run.event("review", ref_id=decision, **call_usage(SONNET))
    quiet = Run(legit()).build(usage=[model_call("conversation", OPUS)])   # a conversation with no tool call

    metrics = conversation_metrics([run.build(), quiet])

    assert (metrics.reviewer_calls, metrics.decide_calls) == (2, 9)
    assert skip_rate(metrics) == pytest.approx(7 / 9)
    assert reviewer_calls_per_conversation(metrics) == pytest.approx(1.0)
    assert skip_rate(conversation_metrics([quiet])) is None   # no /decide call: nothing to skip


def test_latency_excludes_errored_turns_and_counts_them():
    """A turn that failed (refused, timed out, a stream error, no Claude message) gives no full turn and
    none of its replies' reveal delays, and is counted, locally and hosted alike."""
    samples = [
        turn("question", 1, ("m-q1", 9_000.0)), turn("question", 2, ("m-q2", 6_000.0)),
        turn("question", 3, error="no answer within 90 s"),
        turn("quote", 1, error="the message was refused (429)"), turn("quote", 2, ("m-p2", 7_000.0)),
        turn("booking", 1, ("m-b1", 8_000.0)), turn("booking", 2, ("m-b2", 5_000.0), error="stream error internal"),
    ]
    run_events = [reveal("m-q1", 600, 550), reveal("m-q2", 500, 450), reveal("m-p2", 700, 640),
                  reveal("m-b1", 650, 600), reveal("m-b2", 4_000, 3_900)]

    local = local_latency(samples, run_events=run_events)
    hosted = hosted_latency(samples)

    assert local.errored_turns == hosted.errored_turns == 3
    assert local.full_turn == hosted.full_turn
    assert local.full_turn.warm == Spread(n=2, p50=6_000.0, p95=7_000.0)
    assert local.full_turn.cold == Spread(n=2, p50=8_000.0, p95=9_000.0)
    assert local.reveal_delay == Spread(n=4, p50=600.0, p95=700.0)   # m-b2's turn failed: left out


def test_cold_first_turn_reported_separately():
    """Each chat's first turn is cold and reported apart; a chat whose first turn failed has no cold turn,
    and its next turn is still warm."""
    samples = [turn("question", 1, ("m-1", 12_000.0)), turn("question", 2, ("m-2", 6_000.0)),
               turn("question", 3, ("m-3", 6_500.0)),
               turn("quote", 1, ("m-4", 14_000.0)), turn("quote", 2, ("m-5", 7_000.0)),
               turn("booking", 1, error="no answer within 90 s"), turn("booking", 2, ("m-6", 8_000.0))]

    spread = local_latency(samples).full_turn

    assert spread.cold == Spread(n=2, p50=12_000.0, p95=14_000.0)
    assert spread.warm == Spread(n=4, p50=6_500.0, p95=8_000.0)
    assert hosted_latency(samples).full_turn == spread
    assert local_latency([s for s in samples if not s.cold]).full_turn.cold is None


def test_reveal_delay_from_reveal_metrics():
    """The reveal delay and reply check are each reply's own `RevealMetric` intervals, however late the
    turn stored its metric rows; each reveal must be under the time its reply took to reach the visitor,
    or the numbers disagree and none is reported."""
    samples = [turn("quote", 1, ("m-1", 6_200.0), ("m-2", 9_100.0)), turn("quote", 2, ("m-3", 5_400.0))]
    run_events = [
        {"kind": "sse", "type": "message", "seq": 4, "created_at": START.timestamp(), "payload": {"type": "message"}},
        reveal("m-1", 480, 455, seconds_late=30), reveal("m-2", 1_900, 1_870, seconds_late=30),
        reveal("m-3", 520, 470, seconds_late=45),
        {"kind": "metric", "type": "turn", "seq": None, "created_at": START.timestamp() + 30,
         "payload": {"turn_id": "turn-1", "model_calls": 2, "tool_calls": 1, "decide_ms": 40, "execute_ms": 12,
                     "total_ms": 9_000, "outcome": "done"}},
    ]

    local = local_latency(samples, run_events=run_events)

    assert local.reveal_delay == Spread(n=3, p50=520.0, p95=1_900.0)
    assert local.check_reply == Spread(n=3, p50=470.0, p95=1_870.0)
    with pytest.raises(LatencyMismatch, match="m-3"):   # revealed 6 s after the model finished, seen after 5.4 s
        local_latency(samples, run_events=[*run_events[:3], reveal("m-3", 6_000, 470)])


def turn_metric(decide_ms: int, *, tool_calls: int = 1, outcome: str = "done") -> dict[str, Any]:
    """A `TurnMetric` row in `app.run_events`."""
    return {"kind": "metric", "type": "turn", "seq": None, "created_at": START.timestamp(),
            "payload": {"turn_id": f"turn-{next(_IDS)}", "model_calls": 2, "tool_calls": tool_calls,
                        "decide_ms": decide_ms, "execute_ms": 10, "total_ms": 8_000, "outcome": outcome}}


def review_entry(session_id: str, ms: int, status: str = "ok") -> dict[str, Any]:
    """A kernel `review` ledger entry, as the records or the owner's ledger route hold it."""
    return {"seq": next(_IDS), "event": {"kind": "review", "origin": "kernel", "session_id": session_id,
                                         "ref_id": f"d-{next(_IDS)}", "summary": call_usage(SONNET, ms=ms,
                                                                                         status=status)}}


def test_reviewer_and_decide_latency_percentiles():
    """Decide is each turn's `TurnMetric.decide_ms` for turns that called a tool and didn't fail; the
    reviewer is each `review` entry's own `latency_ms` in the run's sessions, a timed-out call included."""
    samples = [turn("booking", 1, ("m-1", 9_000.0)), turn("booking", 2, ("m-2", 7_000.0))]
    run_events = [turn_metric(ms) for ms in (12, 30, 25, 18, 90, 40)] + [
        turn_metric(0, tool_calls=0),                      # a plain answer: no /decide
        turn_metric(500, outcome="internal"), turn_metric(800, outcome="kernel_unavailable"),   # failed turns
    ]
    ledger = [review_entry("s-booking", ms) for ms in (1_100, 950, 1_400)] + [
        review_entry("s-booking", 4_000, status="timeout"), review_entry("s-elsewhere", 9_999),
        {"seq": next(_IDS), "event": {"kind": "decide", "origin": "kernel", "session_id": "s-booking",
                                      "ref_id": "d-x", "summary": {"decision_id": "d-x", "outcome": "allow"}}},
    ]

    local = local_latency(samples, run_events=run_events, ledger_entries=ledger, session_ids=["s-booking"])
    hosted = hosted_latency(samples, ledger_entries=ledger, session_ids=["s-booking"])

    assert local.decide == Spread(n=6, p50=25.0, p95=90.0)
    assert local.reviewer == hosted.reviewer == Spread(n=4, p50=1_100.0, p95=4_000.0)
    assert local_latency(samples).decide is None and local_latency(samples).reviewer is None


class StandInApi:
    """Plays the API for `drive`: one Desk per copy, and what each chat's stream sends for each of its
    turns, each event `ms` after the visitor's POST on a clock it moves itself."""

    def __init__(self, script: dict[tuple[str, int], list[tuple[int, dict[str, Any]]] | int]):
        self.script, self.now = script, 1_000.0
        self.copies: list[str] = []
        self.sent: list[tuple[str, str]] = []
        self.read_after: list[str | None] = []
        self.streams: dict[str, list[StreamEvent]] = {}

    def client(self) -> "StandInClient":
        return StandInClient(self)


class StandInClient:
    def __init__(self, api: StandInApi):
        self.api, self.session_id, self.kind = api, None, None

    async def enter(self) -> dict[str, Any]:
        self.api.copies.append(copy_id := f"copy-{len(self.api.copies) + 1}")
        return {"copy_id": copy_id, "desks": [{"desk_id": f"desk-of-{copy_id}", "slug": f"slug-{copy_id}"}]}

    async def open_chat(self, slug: str) -> dict[str, Any]:
        self.session_id = f"s-{slug}"
        self.api.streams[self.session_id] = []
        return {"session_id": self.session_id}

    async def send(self, text: str) -> None:
        kind = next(k for k, messages in MESSAGES.items() if text in messages)
        n = 1 + sum(1 for sid, _ in self.api.sent if sid == self.session_id)
        self.api.sent.append((self.session_id, text))
        script = self.api.script[(kind, n)]
        if isinstance(script, int):
            raise ApiCallFailed("send", script, {"error": "rate_limited"})
        stream, posted = self.api.streams[self.session_id], self.api.now
        for ms, data in script:
            stream.append(StreamEvent(id=str(len(stream) + 1), event=data["type"], data={**data, "_at": posted + ms}))

    async def events(self, last_event_id: str | None = None):
        self.api.read_after.append(last_event_id)
        for item in self.api.streams[self.session_id][int(last_event_id or 0):]:
            self.api.now = item.data["_at"]
            yield StreamEvent(id=item.id, event=item.event, data={k: v for k, v in item.data.items() if k != "_at"})


def message(message_id: str, author: str = "claude") -> dict[str, Any]:
    return {"type": "message", "message_id": message_id, "generation": 0, "author": author, "language": "en",
            "handoff": False, "blocks": [], "visitor_plain": "Reply checked.", "ledger_seq": 1, "signature": "0" * 128}


TURN_END, WRITING = {"type": "turn_end"}, {"type": "writing"}


async def test_turns_are_timed_from_the_post_and_failures_kept():
    """Each kind gets a copy and a chat of its own and the kinds take turns; each Claude message is timed
    from the visitor's POST on the stream read after the last event seen, an owner's message isn't
    Claude's, and a refused message, a stream error or a turn with no Claude message is a failed turn.
    Before each turn the budget may stop the run."""
    script: dict[tuple[str, int], Any] = {
        ("question", 1): [(400, WRITING), (2_500, message("m-1")), (2_600, TURN_END)],
        ("quote", 1): [(3_000, message("m-2")), (3_400, message("m-3")), (3_500, TURN_END)],
        ("booking", 1): 429,
        ("question", 2): [(100, {"type": "error", "code": "internal"}), (150, TURN_END)],
        ("quote", 2): [(900, message("m-4", author="owner")), (950, TURN_END)],
        ("booking", 2): [(5_000, message("m-5")), (5_100, TURN_END)],
    }
    api = StandInApi(script)

    chats, samples, stopped = await drive(api.client, turns=2, clock=lambda: api.now / 1000)

    assert [chat.kind for chat in chats] == ["question", "quote", "booking"] and len(set(api.copies)) == 3
    assert [(s.kind, s.turn, s.shown, s.error) for s in samples] == [
        ("question", 1, {"m-1": pytest.approx(2_500)}, None),
        ("quote", 1, {"m-2": pytest.approx(3_000), "m-3": pytest.approx(3_400)}, None),
        ("booking", 1, {}, "send answered 429"),
        ("question", 2, {}, "the stream sent error internal"),
        ("quote", 2, {}, "the turn ended with no Claude message"),
        ("booking", 2, {"m-5": pytest.approx(5_000)}, None),
    ]
    assert not stopped
    assert [text for _, text in api.sent] == [MESSAGES["question"][0], MESSAGES["quote"][0], MESSAGES["booking"][0],
                                              MESSAGES["question"][1], MESSAGES["quote"][1], MESSAGES["booking"][1]]
    assert api.read_after == [None, None, "3", "3", None]   # each chat's stream after the last event it read

    allowed = iter([True, True, False])
    budget_api = StandInApi(script)
    _, some, stopped = await drive(budget_api.client, turns=2, clock=lambda: budget_api.now / 1000,
                                   keep_going=lambda chats: _answer(next(allowed)))
    assert stopped and [(s.kind, s.turn) for s in some] == [("question", 1), ("quote", 1)]


async def _answer(value: bool) -> bool:
    return value


NOW = datetime(2026, 11, 1, 20, 0, tzinfo=UTC)
KEYS = {"ANTHROPIC_API_KEY": "kernel-check-key", "BEDROCK_BEARER_TOKEN": "bedrock-token", "DESK_PASSCODE": "passcode"}
PROVED = {"rivera": {"p50_ms": 2_310, "p95_ms": 3_480}, "cards_30": {"p50_ms": 4_020, "p95_ms": 5_600}}


class Stands:
    """What `run_latency` reaches outside itself, standing in: the in-process target, both measurements,
    a meter of the deployment's usage it can trust, the proving script, credentials and prices; it notes
    each call."""

    def __init__(self, root: Path, measured: Measured | None = None, *, keys: dict[str, str] = KEYS,
                 prices: Any = PRICES, proved: Any = PROVED):
        self.root, self.calls = root, []
        self.measured = measured or Measured(samples=[turn("question", 1, ("m-1", 9_000.0))], session_ids=["s-q"])
        self.keys, self.prices, self.proved = keys, prices, proved

    def deps(self) -> LatencyDeps:
        return LatencyDeps(root=self.root, target=self.target, measure_local=self.measure_local,
                           measure_hosted=self.measure_hosted, prove=self.prove, hosted_usage=self.hosted_usage,
                           credential=self.keys.get, prices=self.prices, spend_file=self.root / "spend.csv",
                           now=lambda: NOW)

    async def hosted_usage(self, chats: Any) -> list[UsageRecord]:
        return list(self.measured.usage)

    @asynccontextmanager
    async def target(self, config: LatencyConfig) -> AsyncIterator[Any]:
        self.calls.append(("target", config.dry_run))
        yield object()

    async def measure_local(self, target: Any, **kwargs: Any) -> Measured:
        self.calls.append(("local", kwargs["turns"], kwargs["max_usd"], kwargs["api_provider"]))
        return self.measured

    async def measure_hosted(self, base_url: str, passcode: str, **kwargs: Any) -> Measured:
        self.calls.append(("hosted", base_url, kwargs["turns"], kwargs["max_usd"],
                           kwargs["usage_of"] == self.hosted_usage))
        return self.measured

    def prove(self, root: Path) -> Any:
        self.calls.append(("prove",))
        if isinstance(self.proved, Exception):
            raise self.proved
        return self.proved


def latency_config(**changes: Any) -> LatencyConfig:
    return LatencyConfig.model_validate({"turns": 20, "max_usd": 3.0, **changes})


async def test_latency_run_refuses_before_any_turn(tmp_path):
    """No turn is made, and nothing is proved or spent, when the estimate is over --max-usd, a credential
    or a list price is missing, this month's eval spend would pass the limit less the demo reserve (for a
    hosted run too, whose metered spend the guard counts), or the hosted run has no passcode; proving
    runs before the turns, so a failed proof stops a local run before any model call."""
    root = make_repo(tmp_path / "repo")
    (root / "spend.csv").write_text("pass_id,date,provider,runs,desk_usd,simulator_usd,claude_api_usd,total_usd\n"
                                    "earlier,2026-11-01,anthropic,240,90.0,8.0,598.5,98.0\n")
    no_bedrock_key = {k: v for k, v in KEYS.items() if k != "BEDROCK_BEARER_TOKEN"}
    cases = [
        (latency_config(max_usd=2.99), {}, "estimate \\$3.00 for 60 turns is over --max-usd"),
        (latency_config(), {}, "this month's eval spend"),   # $3.00, with $1.50 of the month left
        (latency_config(), {"keys": {}}, "ANTHROPIC_API_KEY"),
        (latency_config(provider="bedrock"), {"keys": no_bedrock_key}, "BEDROCK_BEARER_TOKEN"),
        (latency_config(provider="bedrock", max_usd=0.15, turns=1), {}, "no list prices for bedrock"),
        (latency_config(base_url="https://desk.example.com"), {"keys": no_bedrock_key | {"DESK_PASSCODE": ""}},
         "DESK_PASSCODE"),
        (latency_config(base_url="https://desk.example.com"), {}, "this month's eval spend"),
        (latency_config(base_url="https://desk.example.com", max_usd=0.15, turns=1), {"prices": {}},
         "no list prices for anthropic"),
        (latency_config(max_usd=0.15, turns=1), {"proved": RuntimeError("desk-prove exited 2")}, "prove_latency"),
    ]
    for config, changes, reason in cases:
        stands = Stands(root, **changes)
        with pytest.raises(LatencyRefused, match=reason):
            await run_latency(config, stands.deps())
        assert all(call == ("prove",) for call in stands.calls), (reason, stands.calls)
    assert not (root / "evals" / "out" / "latency").exists()
    assert len(read_spend(root / "spend.csv")) == 1
    with pytest.raises(ValidationError):   # a deployment's models can't be scripted
        latency_config(base_url="https://desk.example.com", dry_run=True)


async def test_latency_run_writes_labelled_numbers_and_its_spend(tmp_path):
    """A local run proves first, measures with the budget on, appends what its calls cost to the shared
    spend file (no tier 2 runs) and writes its numbers under `local`, with the pass it was run for; a
    hosted run measures with the budget on its meter, writes its numbers under `hosted`, its API's
    provider as unknown, and appends what its metered calls cost at the Claude API's list prices; a dry
    run spends nothing."""
    root = make_repo(tmp_path / "repo")
    usage = [UsageRecord(route="conversation", model=OPUS, session_id="s-q", input_tokens=1_500, cached_tokens=4_500,
                         cache_write_tokens=0, output_tokens=350, ms=2_400),
             UsageRecord(route="reviewer", model=SONNET, session_id="s-q", input_tokens=600, cached_tokens=1_200,
                         cache_write_tokens=0, output_tokens=120, ms=1_100)]
    samples = [turn("question", 1, ("m-1", 9_000.0)), turn("question", 2, ("m-2", 6_000.0)),
               turn("quote", 1, error="send answered 429")]
    measured = Measured(samples=samples, session_ids=["s-question"],
                        run_events=[reveal("m-1", 600, 550), reveal("m-2", 500, 450), turn_metric(30)],
                        ledger_entries=[review_entry("s-question", 1_100)], usage=usage)
    stands = Stands(root, measured)

    run, path = await run_latency(latency_config(pass_id="20261101-180000-a1b2c3"), stands.deps())

    assert stands.calls == [("prove",), ("target", False), ("local", 20, 3.0, "anthropic")]
    assert path == root / "evals" / "out" / "latency" / f"{run.latency_id}.json"
    data = json.loads(path.read_text())
    assert (data["where"], data["provider"], data["pass_id"]) == ("local", "anthropic", "20261101-180000-a1b2c3")
    assert data["latency"]["hosted"] is None
    proving = Spread(n=20, p50=2_310.0, p95=3_480.0)
    assert Latency.model_validate(data["latency"]).local == local_latency(
        samples, run_events=measured.run_events, ledger_entries=measured.ledger_entries,
        session_ids=measured.session_ids, proving=proving)
    assert data["proving"] == PROVED
    [row] = read_spend(root / "spend.csv")
    assert row["pass_id"] == f"latency-{run.latency_id}" and row["date"] == "2026-11-01" and row["runs"] == "0"
    assert float(row["total_usd"]) == float(row["claude_api_usd"]) == pytest.approx(0.0139 + 0.00252, abs=1e-4)
    assert data["spend_usd"] == pytest.approx(0.0139 + 0.00252)
    assert row["estimated_usd"] == "0.0000" and data["spend_estimated"] is False     # every call was priced

    hosted = Stands(root, measured)
    run, path = await run_latency(latency_config(base_url="https://desk.example.com"), hosted.deps())
    data = json.loads(path.read_text())
    assert hosted.calls == [("hosted", "https://desk.example.com", 20, 3.0, True)]
    assert (data["where"], data["provider"], data["latency"]["local"]) == ("hosted", "unknown", None)
    assert Latency.model_validate(data["latency"]).hosted == hosted_latency(
        samples, ledger_entries=measured.ledger_entries, session_ids=measured.session_ids)
    [_, row] = read_spend(root / "spend.csv")
    assert (row["pass_id"], row["provider"], row["runs"]) == (f"latency-{run.latency_id}", "anthropic", "0")
    assert float(row["total_usd"]) == float(row["claude_api_usd"]) == pytest.approx(0.0139 + 0.00252, abs=1e-4)
    assert data["spend_usd"] == pytest.approx(0.0139 + 0.00252) and data["spend_estimated"] is False

    dry = Stands(root, measured, keys={}, prices={})
    run, path = await run_latency(latency_config(dry_run=True, max_usd=0.0), dry.deps())
    assert dry.calls == [("prove",), ("target", True), ("local", 20, None, "anthropic")]
    assert (json.loads(path.read_text())["provider"], run.spend_usd) == ("fake", None)
    assert len(read_spend(root / "spend.csv")) == 2   # the dry run spent nothing here

    broken = Stands(root, measured)

    async def breaks_off(target: Any, **kwargs: Any) -> Measured:
        raise KeyboardInterrupt

    deps = broken.deps()
    deps.measure_local = breaks_off
    with pytest.raises(KeyboardInterrupt):
        await run_latency(latency_config(turns=2), deps)
    last = read_spend(root / "spend.csv")[-1]   # what it spent is unknown: charged at the estimate, marked so
    assert last["pass_id"].startswith("latency-") and float(last["claude_api_usd"]) == pytest.approx(0.30)
    assert last["estimated_usd"] == last["total_usd"] == "0.3000"


async def test_latency_command_reads_its_options_and_fails_closed(tmp_path, monkeypatch, capsys):
    """`python -m evals.run latency` takes --turns (20), --max-usd (required), --base-url, --dry-run and
    --pass, with MODEL_PROVIDER as the provider; a refused run exits 1 and says why, a written one exits 0
    and names its file."""
    from evals import run

    monkeypatch.setenv("MODEL_PROVIDER", "bedrock")
    config = run.latency_config(["--max-usd", "3", "--pass", "20261101-180000-a1b2c3"])
    assert (config.turns, config.max_usd, config.provider, config.pass_id, config.base_url, config.dry_run) == (
        20, 3.0, "bedrock", "20261101-180000-a1b2c3", None, False)
    for argv in (["--turns", "5"], ["--max-usd", "3", "--base-url", "https://desk.example.com", "--dry-run"],
                 ["--max-usd", "3", "--turns", "0"], ["--max-usd", "3", "--records-dsn", "postgresql://x"]):
        with pytest.raises(SystemExit) as exited:
            run.latency_config(argv)
        assert exited.value.code == 2, argv

    monkeypatch.delenv("MODEL_PROVIDER")
    root = make_repo(tmp_path / "repo")
    assert await run.latency_command(["--max-usd", "1"], Stands(root).deps()) == 1
    assert "latency: the estimate $3.00 for 60 turns is over --max-usd $1.00" in capsys.readouterr().out
    assert await run.latency_command(["--max-usd", "3", "--dry-run"], Stands(root, keys={}).deps()) == 0
    assert "latency: wrote evals/out/latency/" in capsys.readouterr().out


async def test_in_process_target_builds_the_kernel_and_api_a_pass_builds():
    """`in_process_target` is the tier 2 pass's kernel and API: on a dry run the Desk's models are
    scripted as a dry pass scripts them, on the Claude API whatever MODEL_PROVIDER says, and no simulated
    visitor is scripted; on a real run they are real on the run's provider. The preflight passes before
    the target is handed over, a refusing one refuses the latency run, and the API stops before the kernel."""
    from evals.latency import in_process_target
    from evals.tier2.passes import PassRefused, script_desk

    class Scripts:
        def __init__(self) -> None:
            self.defaults: list[tuple[Any, ...]] = []

        def default(self, model: str, reply: Any, schema: str | None = None) -> None:
            self.defaults.append((model, reply, schema))

    events: list[Any] = []

    class StandInKernel:
        def __init__(self, *, models: str):
            events.append(("kernel", models))
            self.fake, self.health = Scripts(), object()

        async def start(self) -> None:
            events.append("kernel started")

        async def stop(self) -> None:
            events.append("kernel stopped")

    class StandInApi:
        def __init__(self, kernel: StandInKernel):
            self.kernel = kernel

        async def start(self) -> None:
            events.append("api started")

        async def stop(self) -> None:
            events.append("api stopped")

    def make_api_target(kernel: StandInKernel, *, models: str, provider: str) -> StandInApi:
        events.append(("api", models, provider))
        return StandInApi(kernel)

    async def preflight(api: StandInApi, *, kernel_health: Any) -> None:
        events.append(("preflight", kernel_health is api.kernel.health))

    stand_ins = {"kernel_target": StandInKernel, "make_api_target": make_api_target, "check": preflight}
    async with in_process_target(latency_config(dry_run=True, max_usd=0.0, provider="bedrock"), **stand_ins) as api:
        events.append("measured")
    dry_pass = Scripts()
    script_desk(dry_pass)
    assert dry_pass.defaults and api.kernel.fake.defaults == dry_pass.defaults
    assert events == [("kernel", "fake"), "kernel started", ("api", "fake", "anthropic"), "api started",
                      ("preflight", True), "measured", "api stopped", "kernel stopped"]

    events.clear()
    async with in_process_target(latency_config(provider="bedrock"), **stand_ins) as api:
        events.append("measured")
    assert api.kernel.fake.defaults == []
    assert events[:3] == [("kernel", "real"), "kernel started", ("api", "real", "bedrock")]

    async def refuses(api: StandInApi, *, kernel_health: Any) -> None:
        raise PassRefused("the API's health check doesn't report a healthy kernel")

    events.clear()
    with pytest.raises(LatencyRefused, match="doesn't report a healthy kernel"):
        async with in_process_target(latency_config(), **{**stand_ins, "check": refuses}):
            events.append("measured")
    assert "measured" not in events and events[-2:] == ["api stopped", "kernel stopped"]


def test_proving_is_timed_as_many_times_as_reported(tmp_path, monkeypatch):
    """`prove_latency` asks `scripts.prove_latency` for the number of timings the report gives as proving's n."""
    import subprocess

    from evals import latency

    asked: list[tuple[list[str], Path]] = []

    def run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        asked.append((args, kwargs["cwd"]))
        return subprocess.CompletedProcess(args, 0, stdout=json.dumps(PROVED), stderr="")

    monkeypatch.setattr(latency.subprocess, "run", run)
    assert latency.prove_latency(tmp_path) == PROVED
    [(args, cwd)] = asked
    assert args[1:] == ["-m", "scripts.prove_latency", "--json", "--runs", str(latency.PROVE_RUNS)]
    assert cwd == tmp_path / "backend" and latency.proving_spread(PROVED).n == latency.PROVE_RUNS


async def test_latency_spend_that_cant_be_priced_is_charged_the_estimate(tmp_path, monkeypatch, capsys):
    """A local run whose calls can't all be priced at the end (a model with no list price, first seen in
    the last turn) still appends its spend row, at the run's estimate, so the monthly guard counts it;
    the row, the run's file and the command's output say the figure is an estimate."""
    from evals import run as evals_run

    root = make_repo(tmp_path / "repo")
    unlisted = UsageRecord(route="conversation", model="claude-unlisted-1", session_id="s-q", input_tokens=900,
                           cached_tokens=0, cache_write_tokens=0, output_tokens=40, ms=700)
    measured = Measured(samples=[turn("question", 1, ("m-1", 9_000.0))], session_ids=["s-q"], usage=[unlisted])

    run, _ = await run_latency(latency_config(turns=2), Stands(root, measured).deps())

    [row] = read_spend(root / "spend.csv")
    assert row["pass_id"] == f"latency-{run.latency_id}" and row["runs"] == "0"
    assert float(row["total_usd"]) == float(row["claude_api_usd"]) == pytest.approx(0.30)
    assert run.spend_usd == pytest.approx(0.30)
    # The figure is the estimate, never a measurement: the spend row and the run's file both say so.
    assert row["estimated_usd"] == "0.3000" and run.spend_estimated is True

    monkeypatch.setenv("MODEL_PROVIDER", "anthropic")
    assert await evals_run.latency_command(["--max-usd", "3", "--turns", "2"], Stands(root, measured).deps()) == 0
    assert "$0.30 charged as an estimate, since its calls couldn't all be priced" in capsys.readouterr().out


class ChargingApi(StandInApi):
    """A stand-in deployment that charges each visitor turn one conversation call of `input_tokens` on Opus
    5.5, recorded for the turn's session in `calls`: what a meter the run could trust would read."""

    def __init__(self, *, turns: int, input_tokens: int):
        super().__init__({(kind, n): [(1_000, message(f"m-{kind}-{n}")), (1_100, TURN_END)]
                          for kind in KINDS for n in range(1, turns + 1)})
        self.input_tokens, self.calls = input_tokens, []

    def client(self) -> "ChargingClient":
        return ChargingClient(self)


class ChargingClient(StandInClient):
    async def send(self, text: str) -> None:
        await super().send(text)
        self.api.calls.append(UsageRecord(route="conversation", model=OPUS, session_id=self.session_id,
                                          input_tokens=self.api.input_tokens, cached_tokens=0, cache_write_tokens=0,
                                          output_tokens=0))

    async def owner_ledger(self, desk_id: str) -> dict[str, Any]:
        return {"entries": []}


def on_the_deployment(monkeypatch: pytest.MonkeyPatch, api: StandInApi) -> None:
    """`measure_hosted`'s clients are the stand-in deployment's."""
    from evals import latency

    class Clients:
        def __init__(self, base_url: str, passcode: str, timeout_s: float):
            pass

        def __call__(self) -> StandInClient:
            return api.client()

        async def aclose(self) -> None:
            pass

    monkeypatch.setattr(latency, "_Clients", Clients)


async def test_a_hosted_run_with_no_usage_it_can_trust_is_refused(tmp_path, monkeypatch):
    """The deployment's database is private and its owner's ledger records only the kernel's checks, never
    the conversation's calls, so a hosted run can read no usage it can trust between turns. It is refused
    before it enters the deployment, rather than run past --max-usd: here a turn costs a dollar and the cap
    is $0.45. Nothing is entered, spent or written."""
    root = make_repo(tmp_path / "repo")
    api = ChargingApi(turns=3, input_tokens=250_000)   # $4 per million input tokens: a dollar a turn
    on_the_deployment(monkeypatch, api)
    deps = LatencyDeps(root=root, credential=KEYS.get, spend_file=root / "spend.csv", now=lambda: NOW)

    with pytest.raises(LatencyRefused, match="can't stop at --max-usd"):
        await run_latency(latency_config(turns=3, max_usd=0.45, base_url="https://desk.example.com"), deps)

    assert api.copies == [] and api.sent == [] and api.calls == []
    assert not (root / "spend.csv").exists() and not (root / "evals" / "out" / "latency").exists()


async def test_a_hosted_run_stops_at_max_usd_by_the_usage_it_meters(tmp_path, monkeypatch, capsys):
    """With a meter it can trust, a hosted run reads before each turn what its chats' calls have cost, at
    the Claude API's list prices (a deployment runs on it), and starts no turn once that reaches --max-usd.
    It appends that spend to the shared spend file with no tier 2 runs, and its file and the command say it
    was stopped. A meter that can't be read stops the run, which is charged its estimate, marked so."""
    from evals import run as evals_run

    def metering(api: ChargingApi) -> Any:
        async def usage(chats: Any) -> list[UsageRecord]:
            sessions = {chat.session_id for chat in chats}
            return [call for call in api.calls if call.session_id in sessions]
        return usage

    root = make_repo(tmp_path / "repo")
    api = ChargingApi(turns=3, input_tokens=50_000)   # $0.20 a turn
    on_the_deployment(monkeypatch, api)
    deps = LatencyDeps(root=root, hosted_usage=metering(api), credential=KEYS.get, spend_file=root / "spend.csv",
                       now=lambda: NOW)

    run, path = await run_latency(latency_config(turns=3, max_usd=0.45, base_url="https://desk.example.com"), deps)

    # $0.20, $0.40 and $0.60 once each turn is made: the fourth doesn't start.
    assert len(api.sent) == len(run.samples) == 3
    assert run.stopped_by_budget and json.loads(path.read_text())["stopped_by_budget"] is True
    assert (run.where, run.provider, run.spend_usd, run.spend_estimated) == ("hosted", "unknown", pytest.approx(0.6),
                                                                             False)
    [row] = read_spend(root / "spend.csv")
    assert (row["pass_id"], row["provider"], row["runs"]) == (f"latency-{run.latency_id}", "anthropic", "0")
    assert row["total_usd"] == row["claude_api_usd"] == "0.6000" and row["estimated_usd"] == "0.0000"

    monkeypatch.setenv("MODEL_PROVIDER", "anthropic")
    api = ChargingApi(turns=3, input_tokens=50_000)
    on_the_deployment(monkeypatch, api)
    deps.hosted_usage = metering(api)
    assert await evals_run.latency_command(["--turns", "3", "--max-usd", "0.45", "--base-url",
                                            "https://desk.example.com"], deps) == 0
    assert "3 of 3 turns measured, 0 failed, stopped by --max-usd, $0.60 spent" in capsys.readouterr().out

    api = ChargingApi(turns=3, input_tokens=50_000)
    on_the_deployment(monkeypatch, api)

    async def unreadable(chats: Any) -> list[UsageRecord]:
        if api.sent:
            raise ApiCallFailed("owner_ledger", 503, {"error": "unavailable"})
        return []

    deps.hosted_usage = unreadable
    with pytest.raises(ApiCallFailed):
        await run_latency(latency_config(turns=3, max_usd=0.45, base_url="https://desk.example.com"), deps)
    assert len(api.sent) == 1
    last = read_spend(root / "spend.csv")[-1]   # what it spent can't be read: charged its estimate, marked so
    assert last["total_usd"] == last["claude_api_usd"] == last["estimated_usd"] == "0.4500"


async def test_a_latency_run_that_breaks_off_is_charged_at_least_what_it_last_metered(tmp_path, monkeypatch):
    """A run that breaks off mid-run is charged the larger of its estimate and the spend its budget last
    read between turns, all of it on the Claude API and marked as estimated, never the flat estimate
    below what it already knew it had spent. Here each turn costs $0.40 and the estimate for nine turns
    is $0.45; the meter reads $0.80 before the third turn, then fails."""
    root = make_repo(tmp_path / "repo")
    api = ChargingApi(turns=3, input_tokens=100_000)   # $0.40 a turn
    on_the_deployment(monkeypatch, api)

    async def fails_after_two_turns(chats: Any) -> list[UsageRecord]:
        if len(api.sent) > 2:
            raise ApiCallFailed("owner_ledger", 503, {"error": "unavailable"})
        sessions = {chat.session_id for chat in chats}
        return [call for call in api.calls if call.session_id in sessions]

    deps = LatencyDeps(root=root, hosted_usage=fails_after_two_turns, credential=KEYS.get,
                       spend_file=root / "spend.csv", now=lambda: NOW)
    with pytest.raises(ApiCallFailed):
        await run_latency(latency_config(turns=3, max_usd=3.0, base_url="https://desk.example.com"), deps)

    assert len(api.sent) == 3
    [row] = read_spend(root / "spend.csv")
    assert row["pass_id"].startswith("latency-") and row["runs"] == "0"
    assert row["total_usd"] == row["claude_api_usd"] == row["estimated_usd"] == "0.8000"


async def test_latency_command_names_a_failed_call_without_its_body(tmp_path, capsys):
    """A call that fails outside a turn (entering a copy, opening a chat, reading the owner's ledger) ends
    the command with exit 1 and says which call and its status, never the body the API sent."""
    import httpx

    from evals import run

    root = make_repo(tmp_path / "repo")
    for failure, said in ((ApiCallFailed("enter", 429, {"detail": "too many copies from this address"}),
                           "latency: enter answered 429\n"),
                          (httpx.ConnectError("connection refused"), "latency: the request failed (ConnectError)\n")):
        async def fails(base_url: str, passcode: str, failure: Exception = failure, **kwargs: Any) -> Measured:
            raise failure

        deps = Stands(root).deps()
        deps.measure_hosted = fails
        assert await run.latency_command(["--max-usd", "3", "--base-url", "https://desk.example.com"], deps) == 1
        out = capsys.readouterr().out
        assert out == said


@pytest.mark.parametrize("status", ["ok", "invalid", "timeout"])
def test_soft_check_try_is_one_cost_record_including_unavailable(status):
    """The reply ledger's soft-check summary is its one try's usage, priced once whether or not it
    gave a verdict."""
    from evals.latency import spend_usd
    from evals.usage import collect_usage

    call = call_usage(SONNET, input_tokens=900, cached=100, write=50, output=40, ms=420, status=status)
    event = {"kind": "reply", "session_id": SESSION,
             "summary": {"soft_promise": call, "violations": [] if status == "ok" else ["check_unavailable"]}}
    records = collect_usage({"ledger_entries": [{"event": event}]}, [SESSION])
    [record] = records
    assert (record.route, record.model, record.ms) == ("soft_promise", SONNET, 420)
    assert record.cost_usd("anthropic") == pytest.approx(priced(call))
    assert spend_usd(records, "anthropic").kernel_usd == pytest.approx(priced(call))
