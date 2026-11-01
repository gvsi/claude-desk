"""Usage and cost per conversation, from what a run's records hold.

`collect_usage(records, session_ids)` reads one `UsageRecord` per model call from a run's records:
the API's `app.model_calls` rows (route as the row names it), the kernel's ledger, whose `review`
entries hold the reviewer's call (route `reviewer`) and whose `reply` entries hold the soft-promise
check's under `soft_promise` (route `soft_promise`, null when the check made no call; its one try
is one record, irrespective of its violation kind), and the
simulated visitor's usage per turn (route `simulator`). A row or entry naming another session than
`session_ids` is left out; one naming no session is the copy's own and is kept. `kernel_check_call(event)`
is that reading of one ledger entry, which the tier 2 runner shares for a run's usage and spend.

`conversation_metrics(runs)` turns the judged legitimate runs of a pass (their artifacts) into the
report's `Metrics`: Desk-side cost per conversation (mean, p50, p95), the conversation, reviewer,
soft-promise, triage and translation calls, with the API's calls at the run's API provider's list
prices and the kernel's checks at the Claude API's, which they always use; setup calls (setting up a
Desk, drafting cards, situations and the rules chat) reported apart as setup cost; the visiting
agent's and the simulated visitor's calls left out. `percentile(samples, q)` is the nearest-rank
percentile every spread here and in `evals.latency` uses.

The production soft check uses Sonnet 5.5 (the 220-case calibration averaged $0.0017/check).
Costs use each ledger entry's actual model and token counts, including thinking in output_tokens;
historical Haiku checks retain their own price. Latency is recorded without a two-second cutoff.
"""

import math
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from fractions import Fraction
from statistics import fmean
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidationError

from evals.pricing import cost_usd
from evals.report import CostSpread, Metrics, TokensPerCall
from evals.tier2.artifact import RunArtifact

# The API's model routes, as `app.model_calls` names them (master "Data model and database roles").
ApiRoute = Literal["conversation", "setup", "card_draft", "situations", "rules_chat", "visiting_agent", "triage",
                   "translation"]
Route = ApiRoute | Literal["reviewer", "soft_promise", "simulator"]
KERNEL_ROUTES: dict[str, Route] = {"review": "reviewer", "reply": "soft_promise"}   # ledger kind: route
CONVERSATION_ROUTES = frozenset({"conversation", "reviewer", "soft_promise", "triage", "translation"})
SETUP_ROUTES = frozenset({"setup", "card_draft", "situations", "rules_chat"})
KERNEL_PROVIDER = "anthropic"   # the kernel's checks use the Claude API on every provider


class UsageRecord(BaseModel):
    """One model call: its route, the model that served it, its session and its token counts, and how
    long it took in milliseconds when its record says."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    route: Route
    model: str
    session_id: str | None
    input_tokens: StrictInt = Field(ge=0)
    cached_tokens: StrictInt = Field(ge=0)        # cache reads
    cache_write_tokens: StrictInt = Field(ge=0)
    output_tokens: StrictInt = Field(ge=0)
    ms: StrictInt | None = Field(default=None, ge=0)

    def cost_usd(self, provider: str) -> float:
        """What the call cost at `provider`'s list prices."""
        return cost_usd(self.model_dump(include={"input_tokens", "cached_tokens", "cache_write_tokens",
                                                 "output_tokens"}), self.model, provider)


def collect_usage(records: Mapping[str, Iterable[Mapping[str, Any]]], session_ids: Iterable[str]) -> list[UsageRecord]:
    """Every model call `records` holds for the sessions: `model_calls` (the API's rows), `ledger_entries`
    (the kernel's ledger rows or entries) and `simulator` (the simulated visitor's usage per turn), each
    optional. A call whose record can't be read raises, so none is left out unseen."""
    sessions = set(session_ids)
    usage = []
    for row in records.get("model_calls", ()):
        if row.get("session_id") in sessions or row.get("session_id") is None:
            usage.append(UsageRecord(route=row.get("route"), model=row.get("model"), session_id=row.get("session_id"),
                                     **_counts(row, "cached_tokens", "cache_write_tokens"), ms=row.get("latency_ms")))
    for entry in records.get("ledger_entries", ()):
        event = entry.get("event")
        if not isinstance(event, Mapping):
            raise ValueError(f"ledger entry {entry.get('seq')} has no event to read")
        if event.get("session_id") in sessions or event.get("session_id") is None:
            if (call := kernel_check_call(event)) is not None:
                usage.append(call)
    for turn in records.get("simulator", ()):
        usage.append(UsageRecord(route="simulator", model=turn.get("model"), session_id=None,
                                 **_counts(turn, "cache_read_input_tokens", "cache_creation_input_tokens"),
                                 ms=turn.get("latency_ms")))
    return usage


def kernel_check_call(event: Mapping[str, Any]) -> UsageRecord | None:
    """The model call a kernel ledger event records, the one reading of it for the report's usage and a
    run's spend alike: a `review` entry's is its summary (route `reviewer`), a `reply` entry's is its
    summary's `soft_promise` (route `soft_promise`), which the kernel always writes, null when the check
    made no call; no other entry records one. Only that explicit null reads as no call: an entry whose
    summary isn't an object, a `reply` entry without `soft_promise`, or a call that can't be read (not an
    object, no model, a token count that isn't a whole number) raises `ValueError` saying what, so none
    is left out unseen."""
    kind = event.get("kind")
    route, summary = KERNEL_ROUTES.get(kind), event.get("summary")
    if route is None:
        return None
    if not isinstance(summary, Mapping):
        raise ValueError(f"the kernel's {kind} entry has no summary to read")
    if route == "soft_promise" and "soft_promise" not in summary:
        raise ValueError(f"the kernel's {kind} entry doesn't say whether its check made a call (no soft_promise)")
    call = summary["soft_promise"] if route == "soft_promise" else summary
    if call is None:
        return None   # the soft-promise check made no call (a `review` entry is written only when one ran)
    if not isinstance(call, Mapping):
        raise ValueError(f"the kernel's {kind} entry holds a call that isn't an object")
    try:
        return UsageRecord(route=route, model=call.get("model"), session_id=event.get("session_id"),
                           **_counts(call, "cached_tokens", "cache_write_tokens"), ms=call.get("latency_ms"))
    except ValidationError as error:   # named as the kernel's call names them
        unread = sorted({"latency_ms" if problem["loc"][0] == "ms" else str(problem["loc"][0])
                         for problem in error.errors() if problem["loc"]})
        raise ValueError(f"the kernel's {kind} entry holds a call whose {', '.join(unread)} can't be read") from None


def _counts(record: Mapping[str, Any], cached: str, write: str) -> dict[str, Any]:
    return {"input_tokens": record.get("input_tokens"), "cached_tokens": record.get(cached),
            "cache_write_tokens": record.get(write), "output_tokens": record.get("output_tokens")}


def run_usage(artifact: RunArtifact) -> list[UsageRecord]:
    """A run's model calls, from its artifact: the API's rows the runner read for its sessions, and the
    kernel's checks and the simulated visitor's turns as its records hold them."""
    return collect_usage({"model_calls": [row for row in artifact.usage if row.get("part") == "api"],
                          "ledger_entries": artifact.records.get("ledger_entries", []),
                          "simulator": artifact.simulator_usage}, artifact.session_ids)


def conversation_metrics(runs: Iterable[RunArtifact]) -> Metrics | None:
    """The report's usage numbers over `runs` (the judged legitimate runs' artifacts), None for none."""
    costs: list[float] = []
    setup: list[float] = []
    by_route: dict[str, list[UsageRecord]] = defaultdict(list)
    decide_calls = 0
    for artifact in runs:
        sessions = set(artifact.session_ids)
        decide_calls += sum(1 for row in artifact.records.get("decisions", []) if row.get("session_id") in sessions)
        cost = 0.0
        for record in run_usage(artifact):
            if record.route != "simulator":
                by_route[record.route].append(record)
            provider = KERNEL_PROVIDER if record.route in KERNEL_ROUTES.values() else artifact.providers.api
            if record.route in CONVERSATION_ROUTES:
                cost += record.cost_usd(provider)
            elif record.route in SETUP_ROUTES:
                setup.append(record.cost_usd(provider))
        costs.append(cost)
    if not costs:
        return None
    return Metrics(conversations=len(costs),
                   cost_per_conversation_usd=CostSpread(mean=fmean(costs), p50=percentile(costs, 50),
                                                        p95=percentile(costs, 95)),
                   setup_cost_usd=sum(setup) if setup else None,
                   tokens_per_call={route: _tokens_per_call(calls) for route, calls in sorted(by_route.items())},
                   reviewer_calls=len(by_route.get("reviewer", ())), decide_calls=decide_calls)


def reviewer_calls_per_conversation(metrics: Metrics) -> float:
    return metrics.reviewer_calls / metrics.conversations


def skip_rate(metrics: Metrics) -> float | None:
    """The share of /decide calls that didn't call the reviewer, None when there was no /decide call."""
    return 1 - metrics.reviewer_calls / metrics.decide_calls if metrics.decide_calls else None


def _tokens_per_call(calls: Sequence[UsageRecord]) -> TokensPerCall:
    return TokensPerCall(calls=len(calls), input=fmean(c.input_tokens for c in calls),
                         cached=fmean(c.cached_tokens for c in calls),
                         cache_write=fmean(c.cache_write_tokens for c in calls),
                         output=fmean(c.output_tokens for c in calls))


def percentile(samples: Sequence[float], q: float) -> float:
    """The nearest-rank `q`th percentile (0 < q <= 100): the smallest sample with at least q percent of
    the samples at or below it."""
    if not samples:
        raise ValueError("a percentile needs at least one sample")
    if not 0 < q <= 100:
        raise ValueError(f"a nearest-rank percentile is over 0 and at most 100, not {q}")
    ordered = sorted(samples)
    rank = max(1, math.ceil(Fraction(q) * len(ordered) / 100))
    return ordered[rank - 1]


__all__ = ["CONVERSATION_ROUTES", "SETUP_ROUTES", "UsageRecord", "collect_usage", "conversation_metrics",
           "kernel_check_call", "percentile", "reviewer_calls_per_conversation", "run_usage", "skip_rate"]
