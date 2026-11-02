"""Usage and timing records: one `app.model_calls` row per model call, and reveal and turn metrics.

A model call's row holds its usage, never its content, and `created_at` is the call's finish
(`finished_at`), written right after the call; a failed call is recorded with `stop_reason: "error"` and
zero tokens. `spent_today_cents` prices today's (UTC) calls at the master plan's list prices, for the
daily model budget: in production, once today's spend reaches `DAILY_MODEL_BUDGET_CENTS`, turns hand off with
no model call and other model routes answer 503 `demo_budget`. Reveal and turn timings are `metric` rows in
`app.run_events` (`sse.append_metric`).
"""

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from fractions import Fraction
from math import ceil
from typing import Any, ClassVar, Literal, Protocol

from pydantic import BaseModel
from sqlalchemy import func, insert, select
from sqlalchemy.ext.asyncio import AsyncConnection

from desk.db.models import ModelCall

MODEL_CALLS = ModelCall.__table__
ROUTES = frozenset({"conversation", "setup", "card_draft", "situations", "rules_chat", "visiting_agent", "triage",
                    "translation", "demo_visitor"})

# USD per million tokens: input, cache read, 5-minute cache write, output ("Model cost and latency budget").
PRICES_PER_MTOK: dict[str, tuple[Fraction, Fraction, Fraction, Fraction]] = {
    "claude-opus-5-5": (Fraction(4), Fraction("0.20"), Fraction(5), Fraction(20)),
    "claude-sonnet-5-5": (Fraction(2), Fraction("0.10"), Fraction("2.50"), Fraction(10)),
    "claude-haiku-5-5": (Fraction("0.10"), Fraction("0.01"), Fraction("0.125"), Fraction("0.50")),
}
# A model missing from the table is priced at the highest rate of each kind, so the budget never undercounts.
HIGHEST_PRICES = tuple(max(prices[i] for prices in PRICES_PER_MTOK.values()) for i in range(4))
# Production's daily model spend, in US cents, shared by every copy (the owner may change it): it keeps the demo
# inside the monthly limit that evals and the demo share.
DAILY_MODEL_BUDGET_CENTS = 15000


class Usage(Protocol):
    input_tokens: int
    cache_read_input_tokens: int | None
    cache_creation_input_tokens: int | None
    output_tokens: int


class FinishedCall(Protocol):
    """What the model client returns for a call (Task 4's `ModelResponse`)."""

    model: str
    usage: Usage | None                   # None for a call that failed
    stop_reason: str | None               # None for a call that failed
    latency_ms: int
    finished_at: datetime


async def record_model_call(conn: AsyncConnection, copy_id: str, session_id: str | None, route: str,
                            response: FinishedCall) -> int:
    """Write the call's usage row, dated at its finish; returns its `model_call_id`."""
    if route not in ROUTES:
        raise ValueError(f"{route!r} is not a model route")
    if response.finished_at.tzinfo is None:
        raise ValueError("a model call's finish time carries its time zone")
    usage = response.usage
    if usage is not None and not response.stop_reason:
        raise ValueError("a call that finished carries its stop reason")
    tokens = (0, 0, 0, 0) if usage is None else (
        usage.input_tokens, usage.cache_read_input_tokens or 0, usage.cache_creation_input_tokens or 0,
        usage.output_tokens)
    stop_reason = "error" if usage is None else response.stop_reason
    return (await conn.execute(insert(MODEL_CALLS).values(
        copy_id=copy_id, session_id=session_id, route=route, model=response.model, input_tokens=tokens[0],
        cached_tokens=tokens[1], cache_write_tokens=tokens[2], output_tokens=tokens[3],
        latency_ms=response.latency_ms, stop_reason=stop_reason,
        created_at=response.finished_at).returning(MODEL_CALLS.c.model_call_id))).scalar_one()


async def spent_today_cents(conn: AsyncConnection, clock: Callable[[], datetime]) -> int:
    """Today's (UTC, by `clock`) model spend in US cents at list prices, rounded up."""
    start = clock().astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    rows = await conn.execute(select(
        MODEL_CALLS.c.model, func.sum(MODEL_CALLS.c.input_tokens), func.sum(MODEL_CALLS.c.cached_tokens),
        func.sum(MODEL_CALLS.c.cache_write_tokens), func.sum(MODEL_CALLS.c.output_tokens),
    ).where(MODEL_CALLS.c.created_at >= start, MODEL_CALLS.c.created_at < start + timedelta(days=1))
        .group_by(MODEL_CALLS.c.model))
    dollars = Fraction(0)
    for model, *tokens in rows:
        prices = PRICES_PER_MTOK.get(model, HIGHEST_PRICES)
        dollars += sum((Fraction(int(count)) * price for count, price in zip(tokens, prices, strict=True)), Fraction(0)) / 1_000_000
    return ceil(dollars * 100)


async def over_daily_budget(conn: AsyncConnection, clock: Callable[[], datetime],
                            budget_cents: int = DAILY_MODEL_BUDGET_CENTS) -> bool:
    """True once today's (UTC) spend has reached the daily budget."""
    return await spent_today_cents(conn, clock) >= budget_cents


class RevealMetric(BaseModel):
    """From the model's finish to the reply on the visitor's stream."""

    metric_type: ClassVar[str] = "reveal"
    message_id: str
    model_finish_to_reveal_ms: int
    check_reply_ms: int
    attempts: int


class TurnMetric(BaseModel):
    metric_type: ClassVar[str] = "turn"
    turn_id: str
    model_calls: int
    tool_calls: int
    decide_ms: int
    execute_ms: int
    total_ms: int
    outcome: Literal["done", "fenced", "session_ended", "kernel_unavailable", "handoff", "turn_over", "not_ai",
                     "internal"]
    rebound: bool = False          # a thinking-binding 400 started a fresh context and the call was sent again


def metric_row(metric: Any) -> tuple[str, dict]:
    """A metric's run_events `type` and payload."""
    if not isinstance(metric, (RevealMetric, TurnMetric)):
        raise TypeError("a metric row holds a RevealMetric or a TurnMetric")
    return metric.metric_type, metric.model_dump(mode="json")
