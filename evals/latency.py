"""How long a checked reply takes: a full turn as the visitor sees it, and the server's own intervals.

`python -m evals.run latency` (`run_latency`) makes `--turns` visitor turns of each of three kinds, a
plain question, a quote and a booking that may call the reviewer, each kind in a copy and a chat of its
own, the kinds taking turns one turn at a time. Each turn is a `TurnSample`: every Claude message it
showed, timed from the visitor's POST to its arrival on the stream, or why it failed. A turn that
failed gives no number and is counted (`errored_turns`); the first turn of each chat is cold and is
reported apart from the warm ones.

Locally, on the in-process stack built from this tree (`local_latency`): the full turn; the reveal
delay and reply check of each reply a good turn showed, from its `RevealMetric` row in
`app.run_events` (read from the metric itself, so a row stored late still gives its own interval, and
each checked to be under its reply's arrival); decide from the `TurnMetric.decide_ms` of the turns
that called a tool; the reviewer from the `latency_ms` of the kernel's `review` entries; and proving
from Plan 01a's `scripts.prove_latency --json`. Against the hosted deployment (`--base-url`,
`hosted_latency`), whose database is private: the full turn, and the reviewer from the owner's ledger
route. Spreads are p50 and p95 by nearest rank (`evals.usage.percentile`). The run writes
`evals/out/latency/<id>.json`, its numbers under `local` or `hosted`.
"""

import asyncio
import json
import secrets
import subprocess
import sys
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager, aclosing, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Self

import httpx
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    TypeAdapter,
    ValidationError,
    model_validator,
)

from desk.events import EvError, EvMessage, EvTurnEnd, SseEvent
from evals import results
from evals.client import ApiCallFailed, DeskClient
from evals.pricing import PRICES, NoPrice, Price, price_of
from evals.report import HostedLatency, Latency, LocalLatency, Spread, TurnSpread
from evals.tier2 import passes
from evals.tier2.runner import DESK_MODELS, KERNEL_CHECK_MODELS
from evals.tier2.schema import Provider
from evals.usage import UsageRecord, collect_usage, percentile

Kind = Literal["question", "quote", "booking"]
KINDS: tuple[Kind, ...] = ("question", "quote", "booking")
# What the visitor of each kind asks, a turn at a time, in turn: plain questions, quotes, and bookings
# that may call the reviewer. Rivera Plumbing serves Oakland, Berkeley, Alameda and Emeryville.
MESSAGES: dict[Kind, tuple[str, ...]] = {
    "question": ("Which areas do you cover?", "Are you open on Saturdays?",
                 "Do you handle leaks under the kitchen sink?"),
    "quote": ("How much is a drain clearing?", "What would a water heater repair cost?",
              "How much do you charge to fix a leak?"),
    "booking": ("Can you book me a drain clearing at the first time you have free?",
                "I'd like to book a leak repair in Oakland this week, whenever you can come.",
                "Please book me in for a water heater repair at your next opening."),
}
TURN_TIMEOUT_S = 90.0
# What a turn should cost until measured: the master plan's Opus first call and second call after a tool,
# a reviewer call and a soft-promise check ($0.031, "Model cost and latency budget"), rounded up for cold
# caches and a conversation that grows. Twenty turns of each kind come to $3.00.
PER_TURN_USD = 0.05
PROVE_RUNS = 20   # the timings `scripts.prove_latency` makes of each card set (Plan 01a)
REPO_ROOT = Path(__file__).resolve().parents[1]
FAILED_TURNS = frozenset({"kernel_unavailable", "internal"})   # `TurnMetric.outcome`s of a turn that failed
_SSE = TypeAdapter(SseEvent)


class TurnSample(BaseModel):
    """One visitor turn: each Claude message it showed (its id, and the milliseconds from the POST to
    its arrival), or why it failed."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Kind
    turn: StrictInt = Field(ge=1)            # in its chat, from 1
    session_id: str
    shown: dict[str, float] = {}
    error: str | None = None

    @model_validator(mode="after")
    def _measured_or_failed(self) -> Self:
        if self.error is None and not self.shown:
            raise ValueError("a turn that didn't fail showed a Claude message")
        return self

    @property
    def cold(self) -> bool:
        """The first turn of its chat."""
        return self.turn == 1

    @property
    def full_turn_ms(self) -> float | None:
        """The POST to the first Claude message, None for a turn that failed."""
        return None if self.error is not None else min(self.shown.values())


def spread(samples: Sequence[float]) -> Spread | None:
    """The samples' p50 and p95 by nearest rank, None for none."""
    if not samples:
        return None
    return Spread(n=len(samples), p50=percentile(samples, 50), p95=percentile(samples, 95))


def full_turn(samples: Iterable[TurnSample]) -> TurnSpread:
    """The full turn of the turns that didn't fail, cold first turns apart."""
    good = [s for s in samples if s.error is None]
    return TurnSpread(warm=spread([s.full_turn_ms for s in good if not s.cold]),
                      cold=spread([s.full_turn_ms for s in good if s.cold]))


def errored_turns(samples: Iterable[TurnSample]) -> int:
    return sum(1 for s in samples if s.error is not None)


class LatencyMismatch(ValueError):
    """The client's and the server's numbers disagree, so neither is reported."""


class Reveal(BaseModel):
    """Plan 02a's `RevealMetric`, as its `app.run_events` row's payload holds it."""

    model_config = ConfigDict(extra="ignore", frozen=True)
    message_id: str
    model_finish_to_reveal_ms: StrictInt = Field(ge=0)
    check_reply_ms: StrictInt = Field(ge=0)
    attempts: StrictInt = Field(ge=1)


def metric_rows(run_events: Iterable[Mapping[str, Any]], metric_type: str) -> list[Any]:
    """The payloads of the `metric` rows of one type (`reveal` or `turn`)."""
    return [row.get("payload") for row in run_events
            if row.get("kind") == "metric" and row.get("type") == metric_type]


def reveals(samples: Iterable[TurnSample], run_events: Iterable[Mapping[str, Any]]) -> list[Reveal]:
    """The `RevealMetric` of each reply a turn that didn't fail showed. Each reveal is checked to be
    under the time its reply took to reach the visitor, which includes it; one that isn't raises."""
    shown = {message_id: ms for s in samples if s.error is None for message_id, ms in s.shown.items()}
    found = []
    for payload in metric_rows(run_events, "reveal"):
        metric = Reveal.model_validate(payload)
        if metric.message_id not in shown:
            continue
        if metric.model_finish_to_reveal_ms >= shown[metric.message_id]:
            raise LatencyMismatch(
                f"reply {metric.message_id} was revealed {metric.model_finish_to_reveal_ms} ms after the model "
                f"finished, but reached the visitor {shown[metric.message_id]:.0f} ms after the POST")
        found.append(metric)
    return found


class Turn(BaseModel):
    """Plan 02a's `TurnMetric`, as its `app.run_events` row's payload holds it."""

    model_config = ConfigDict(extra="ignore", frozen=True)
    tool_calls: StrictInt = Field(ge=0)
    decide_ms: StrictInt = Field(ge=0)
    outcome: str


def decide_ms(run_events: Iterable[Mapping[str, Any]]) -> list[int]:
    """Each turn's time in /decide (`TurnMetric.decide_ms`), for the turns that called a tool and didn't fail."""
    turns = [Turn.model_validate(payload) for payload in metric_rows(run_events, "turn")]
    return [t.decide_ms for t in turns if t.tool_calls and t.outcome not in FAILED_TURNS]


def reviewer_ms(ledger_entries: Iterable[Mapping[str, Any]], session_ids: Iterable[str]) -> list[int]:
    """Each reviewer call's own `latency_ms`, from the kernel's `review` entries for the sessions."""
    return [record.ms for record in collect_usage({"ledger_entries": ledger_entries}, session_ids)
            if record.route == "reviewer" and record.ms is not None]


def local_latency(samples: Sequence[TurnSample], *, run_events: Iterable[Mapping[str, Any]] = (),
                  ledger_entries: Iterable[Mapping[str, Any]] = (), session_ids: Iterable[str] = (),
                  proving: Spread | None = None) -> LocalLatency:
    """What an in-process run measured, with the proving latency `scripts.prove_latency` measured."""
    run_events = list(run_events)
    metrics = reveals(samples, run_events)
    return LocalLatency(full_turn=full_turn(samples),
                        reveal_delay=spread([m.model_finish_to_reveal_ms for m in metrics]),
                        check_reply=spread([m.check_reply_ms for m in metrics]),
                        decide=spread(decide_ms(run_events)),
                        reviewer=spread(reviewer_ms(ledger_entries, session_ids)),
                        proving=proving, errored_turns=errored_turns(samples))


def hosted_latency(samples: Sequence[TurnSample], *, ledger_entries: Iterable[Mapping[str, Any]] = (),
                   session_ids: Iterable[str] = ()) -> HostedLatency:
    """What a run against the hosted deployment measured: the full turn, and the reviewer from the
    owner's ledger."""
    return HostedLatency(full_turn=full_turn(samples), reviewer=spread(reviewer_ms(ledger_entries, session_ids)),
                         errored_turns=errored_turns(samples))


# Driving the turns

@dataclass
class Chat:
    """One kind's copy and chat: the owner who entered the copy, and the visitor talking to its Desk."""

    kind: Kind
    owner: Any
    visitor: Any
    copy_id: str
    desk_id: str
    session_id: str
    last_event_id: str | None = None


@dataclass
class Measured:
    """What a latency run measured: each turn, and what the records hold of its chats (none when hosted
    but the reviewer's entries in the owner's ledger)."""

    samples: list[TurnSample]
    session_ids: list[str]
    run_events: list[dict[str, Any]] = field(default_factory=list)
    ledger_entries: list[dict[str, Any]] = field(default_factory=list)
    usage: list[UsageRecord] = field(default_factory=list)     # the chats' model calls, read locally
    stopped_by_budget: bool = False


async def drive(new_client: Callable[[], Any], *, turns: int, kinds: Sequence[Kind] = KINDS,
                clock: Callable[[], float] = time.monotonic, turn_timeout_s: float = TURN_TIMEOUT_S,
                keep_going: Callable[[list[Chat]], Awaitable[bool]] | None = None,
                ) -> tuple[list[Chat], list[TurnSample], bool]:
    """Open a copy and a chat for each kind, then make `turns` turns in each, the kinds taking turns, one
    turn at a time. Before each turn `keep_going(chats)`, when given, says whether to go on (the budget);
    the third value says whether it stopped the run."""
    chats = []
    for kind in kinds:
        owner = new_client()
        copy = await owner.enter()
        desk = copy["desks"][0]
        visitor = new_client()
        state = await visitor.open_chat(desk["slug"])
        chats.append(Chat(kind=kind, owner=owner, visitor=visitor, copy_id=copy["copy_id"], desk_id=desk["desk_id"],
                          session_id=visitor.session_id or state["session_id"]))
    samples: list[TurnSample] = []
    for n in range(1, turns + 1):
        for chat in chats:
            if keep_going is not None and not await keep_going(chats):
                return chats, samples, True
            samples.append(await one_turn(chat, n, clock=clock, turn_timeout_s=turn_timeout_s))
    return chats, samples, False


async def one_turn(chat: Chat, n: int, *, clock: Callable[[], float] = time.monotonic,
                   turn_timeout_s: float = TURN_TIMEOUT_S) -> TurnSample:
    """The chat's `n`th turn: the visitor's POST, then its stream read to the turn's end, timing each
    Claude message from the POST. Anything that went wrong is the turn's error, never a number."""
    messages = MESSAGES[chat.kind]
    shown: dict[str, float] = {}
    error = None
    started = clock()
    try:
        await chat.visitor.send(messages[(n - 1) % len(messages)])
        async with asyncio.timeout(turn_timeout_s):
            async with aclosing(chat.visitor.events(chat.last_event_id)) as stream:
                async for item in stream:
                    if item.id is not None:
                        chat.last_event_id = item.id
                    event = _SSE.validate_python(item.data)
                    if isinstance(event, EvMessage) and event.author == "claude":
                        shown.setdefault(event.message_id, (clock() - started) * 1000)
                    elif isinstance(event, EvError):
                        error = error or f"the stream sent error {event.code}"
                    elif isinstance(event, EvTurnEnd):
                        break
    except ApiCallFailed as refused:
        error = f"{refused.op} answered {refused.status}"
    except TimeoutError:
        error = f"the turn didn't end within {turn_timeout_s:g} s"
    except ValidationError:
        error = "the stream sent an event the contract doesn't define"
    except httpx.HTTPError as failed:
        error = f"the request failed ({type(failed).__name__})"
    if error is None and not shown:
        error = "the turn ended with no Claude message"
    return TurnSample(kind=chat.kind, turn=n, session_id=chat.session_id, shown=shown, error=error)


class _Clients:
    """Makes `DeskClient`s on one API and closes every one it made."""

    def __init__(self, base_url: str, passcode: str, timeout_s: float):
        self.base_url, self.passcode, self.timeout_s = base_url, passcode, timeout_s
        self.made: list[DeskClient] = []

    def __call__(self) -> DeskClient:
        client = DeskClient(self.base_url, self.passcode, timeout_s=self.timeout_s)
        self.made.append(client)
        return client

    async def aclose(self) -> None:
        for client in self.made:
            await client.aclose()


async def measure_local(target: Any, *, turns: int, kinds: Sequence[Kind] = KINDS,
                        turn_timeout_s: float = TURN_TIMEOUT_S, max_usd: float | None = None,
                        api_provider: str = "anthropic") -> Measured:
    """Turns on an in-process `ApiTarget`, then each chat's `app.run_events` rows, its copy's ledger and
    its model calls, read from the target's records. With `max_usd`, no turn starts once the chats'
    calls cost that much at list prices."""
    records = target.kernel.records

    async def usage_of(chats: list[Chat]) -> list[UsageRecord]:
        usage = []
        for chat in chats:
            ledger = [entry.model_dump(mode="json") for entry in await records.ledger_entries(chat.copy_id,
                                                                                               chat.desk_id)]
            usage += collect_usage({"model_calls": await records.model_calls(chat.session_id),
                                    "ledger_entries": ledger}, [chat.session_id])
        return usage

    async def within_budget(chats: list[Chat]) -> bool:
        return spend_usd(await usage_of(chats), api_provider).total_usd < max_usd

    clients = _Clients(target.base_url, target.passcode, max(turn_timeout_s, 30.0))
    try:
        chats, samples, stopped = await drive(clients, turns=turns, kinds=kinds, turn_timeout_s=turn_timeout_s,
                                              keep_going=within_budget if max_usd is not None else None)
        run_events, ledger = [], []
        for chat in chats:
            run_events += await records.run_events(chat.session_id)
            ledger += [entry.model_dump(mode="json") for entry in await records.ledger_entries(chat.copy_id,
                                                                                                chat.desk_id)]
        return Measured(samples=samples, session_ids=[chat.session_id for chat in chats], run_events=run_events,
                        ledger_entries=ledger, usage=await usage_of(chats), stopped_by_budget=stopped)
    finally:
        await clients.aclose()


async def measure_hosted(base_url: str, passcode: str, *, turns: int, kinds: Sequence[Kind] = KINDS,
                         turn_timeout_s: float = TURN_TIMEOUT_S) -> Measured:
    """Turns on the hosted deployment, then the reviewer's entries in each copy's ledger, read through
    the owner's ledger route (its database is private)."""
    clients = _Clients(base_url, passcode, max(turn_timeout_s, 30.0))
    try:
        chats, samples, _ = await drive(clients, turns=turns, kinds=kinds, turn_timeout_s=turn_timeout_s)
        ledger = []
        for chat in chats:
            ledger += (await chat.owner.owner_ledger(chat.desk_id))["entries"]
        return Measured(samples=samples, session_ids=[chat.session_id for chat in chats], ledger_entries=ledger)
    finally:
        await clients.aclose()


@dataclass(frozen=True)
class Spent:
    """US dollars at list prices: the API's calls, and the kernel's checks, which use the Claude API."""

    api_usd: float
    kernel_usd: float

    @property
    def total_usd(self) -> float:
        return self.api_usd + self.kernel_usd


def spend_usd(usage: Iterable[UsageRecord], api_provider: str) -> Spent:
    """What the calls cost: the API's at its provider's list prices, the kernel's checks at the Claude API's."""
    api = kernel = 0.0
    for record in usage:
        if record.route in ("reviewer", "soft_promise"):
            kernel += record.cost_usd("anthropic")
        elif record.route != "simulator":
            api += record.cost_usd(api_provider)
    return Spent(api_usd=api, kernel_usd=kernel)


# The latency run

class LatencyRefused(RuntimeError):
    """The latency run can't go ahead; the message says why. No turn was made."""


class LatencyConfig(BaseModel):
    """What `python -m evals.run latency` was asked for."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    turns: int = Field(20, ge=1)                 # of each kind
    max_usd: float = Field(ge=0, allow_inf_nan=False)
    base_url: str | None = None                  # the hosted deployment; in-process when None
    dry_run: bool = False
    provider: Provider = "anthropic"             # MODEL_PROVIDER: where the in-process API's calls go
    pass_id: str | None = Field(None, pattern=passes.PASS_ID.pattern)   # the pass the numbers are for
    turn_timeout_s: float = Field(TURN_TIMEOUT_S, gt=0)

    @model_validator(mode="after")
    def _holds_together(self) -> Self:
        if self.base_url is not None and self.dry_run:
            raise ValueError("--dry-run scripts the in-process stack's models; a deployment's can't be scripted")
        return self


class LatencyRun(BaseModel):
    """A finished latency run, as `evals/out/latency/<latency_id>.json` holds it: its numbers under
    `latency.local` or `latency.hosted`, and each turn."""

    model_config = ConfigDict(extra="forbid")
    latency_id: str
    created_at: AwareDatetime
    git_sha: str
    pass_id: str | None
    where: Literal["local", "hosted"]
    base_url: str | None
    provider: Literal["anthropic", "bedrock", "fake", "unknown"]   # the API's: unknown for a deployment
    turns_per_kind: int
    kinds: list[Kind]
    estimate_usd: float
    spend_usd: float | None                      # measured at list prices; None for a dry run or a deployment
    stopped_by_budget: bool
    latency: Latency
    proving: dict[str, Any] | None               # `scripts.prove_latency --json` as it printed
    samples: list[TurnSample]


@dataclass
class LatencyDeps:
    """What `run_latency` reaches outside itself, so a test can stand in for any of it."""

    root: Path = REPO_ROOT
    target: Callable[[LatencyConfig], AbstractAsyncContextManager[Any]] | None = None
    measure_local: Callable[..., Awaitable[Measured]] = measure_local
    measure_hosted: Callable[..., Awaitable[Measured]] = measure_hosted
    prove: Callable[[Path], Mapping[str, Any]] | None = None
    credential: Callable[[str], str | None] | None = None
    prices: Mapping[str, Mapping[str, Price]] | None = None
    spend_file: Path | None = None
    now: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        self.target = self.target or in_process_target
        self.prove = self.prove or prove_latency
        self.credential = self.credential or (lambda name: passes.credential(name, self.root))
        self.prices = PRICES if self.prices is None else self.prices
        self.spend_file = self.spend_file or passes.shared_spend_file(self.root)


async def run_latency(config: LatencyConfig, deps: LatencyDeps | None = None) -> tuple[LatencyRun, Path]:
    """Measure, then write `evals/out/latency/<latency_id>.json`; returns the run and the file.

    Before any turn: a real run's estimate ($0.05 a turn) must be within `--max-usd`; a local real run
    needs `ANTHROPIC_API_KEY` (and `BEDROCK_BEARER_TOKEN` on Bedrock), list prices for every model the
    stack calls, and room for the estimate in this month's eval spend (the limit less the demo
    reserve, as a pass); a hosted run needs `DESK_PASSCODE`. A local run then proves first
    (`scripts.prove_latency --json`), so a failed proof costs nothing. During a local real run no turn
    starts once the turns' calls cost `--max-usd`, and after it what they cost is appended to the
    shared spend file, with no tier 2 runs, so the monthly guard counts it. A hosted run's calls are
    the deployment's, inside its own daily budget, and no dry run spends anything."""
    deps = deps or LatencyDeps()
    hosted, real = config.base_url is not None, not config.dry_run
    estimate = round(len(KINDS) * config.turns * PER_TURN_USD, 6) if real else 0.0
    if estimate > config.max_usd:
        raise LatencyRefused(f"the estimate ${estimate:.2f} for {len(KINDS) * config.turns} turns is over --max-usd "
                             f"${config.max_usd:.2f}")
    passcode = None
    if hosted:
        passcode = deps.credential("DESK_PASSCODE")
        if not passcode:
            raise LatencyRefused("a hosted run enters the deployment as its owner: set DESK_PASSCODE in .env")
    elif real:
        _require_credentials(config, deps)
        _require_prices(config, deps)
        _within_the_month(estimate, deps)
    proved = proving = None
    if not hosted:
        try:
            proved = dict(deps.prove(deps.root))
            proving = proving_spread(proved)
        except Exception as failure:
            raise LatencyRefused(f"scripts.prove_latency didn't measure proving ({failure}); it comes with the "
                                 "kernel core plan (01a)") from None
    now = deps.now()
    latency_id = f"{now.astimezone(UTC):%Y%m%d-%H%M%S}-{secrets.token_hex(3)}"
    git_sha = results.git(deps.root, "rev-parse", "--verify", "HEAD^{commit}").strip()
    measured: Measured | None = None
    spend = None
    if hosted:
        measured = await deps.measure_hosted(config.base_url, passcode, turns=config.turns, kinds=KINDS,
                                             turn_timeout_s=config.turn_timeout_s)
    else:
        api_provider = "anthropic" if config.dry_run else config.provider
        started = False
        try:
            async with deps.target(config) as target:
                started = True
                measured = await deps.measure_local(target, turns=config.turns, kinds=KINDS,
                                                    turn_timeout_s=config.turn_timeout_s,
                                                    max_usd=config.max_usd if real else None,
                                                    api_provider=api_provider)
        finally:
            # Recorded before the numbers are read, so a run whose numbers disagree still counts; a run that
            # broke off before its calls were read is charged its estimate, all of it to the Claude API.
            if real and started:
                if measured is not None:
                    spent = spend_usd(measured.usage, config.provider)
                    spend = spent.total_usd
                    claude_api = spent.kernel_usd + (spent.api_usd if config.provider == "anthropic" else 0.0)
                else:
                    spend = claude_api = estimate
                passes.append_spend(deps.spend_file, {
                    "pass_id": f"latency-{latency_id}", "date": now.astimezone(UTC).date().isoformat(),
                    "provider": config.provider, "runs": 0, "desk_usd": f"{spend:.4f}",
                    "simulator_usd": f"{0:.4f}", "claude_api_usd": f"{claude_api:.4f}", "total_usd": f"{spend:.4f}"})
    if hosted:
        latency = Latency(hosted=hosted_latency(measured.samples, ledger_entries=measured.ledger_entries,
                                                session_ids=measured.session_ids))
    else:
        latency = Latency(local=local_latency(measured.samples, run_events=measured.run_events,
                                              ledger_entries=measured.ledger_entries,
                                              session_ids=measured.session_ids, proving=proving))
    run = LatencyRun(
        latency_id=latency_id, created_at=now, git_sha=git_sha, pass_id=config.pass_id,
        where="hosted" if hosted else "local", base_url=config.base_url,
        provider="unknown" if hosted else "fake" if config.dry_run else config.provider,
        turns_per_kind=config.turns, kinds=list(KINDS), estimate_usd=estimate, spend_usd=spend,
        stopped_by_budget=measured.stopped_by_budget, latency=latency, proving=proved, samples=measured.samples)
    out = deps.root / "evals" / "out" / "latency" / f"{latency_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(run.model_dump_json(indent=1) + "\n")
    return run, out


def _require_credentials(config: LatencyConfig, deps: LatencyDeps) -> None:
    needed = ["ANTHROPIC_API_KEY"] + (["BEDROCK_BEARER_TOKEN"] if config.provider == "bedrock" else [])
    if missing := [name for name in needed if not deps.credential(name)]:
        raise LatencyRefused(f"a real run on {config.provider} needs {' and '.join(missing)} (the kernel's checks "
                             "use ANTHROPIC_API_KEY on every provider); set it in .env")


def _require_prices(config: LatencyConfig, deps: LatencyDeps) -> None:
    wanted = {(config.provider, model) for model in DESK_MODELS.values()} | {
        ("anthropic", model) for model in KERNEL_CHECK_MODELS.values()}
    missing = []
    for provider, model in sorted(wanted):
        try:
            price_of(model, provider, deps.prices)
        except NoPrice:
            missing.append(f"{provider} {model}")
    if missing:
        raise LatencyRefused(f"no list prices for {', '.join(missing)} in evals.pricing.PRICES; a run on a "
                             "provider without prices doesn't start")


def _within_the_month(estimate: float, deps: LatencyDeps) -> None:
    """The estimate, all of it counted as Claude API spend, must fit in what this month leaves for evals."""
    limit, reserve = passes.load_budget(deps.root)
    spent = sum(float(row.get("claude_api_usd") or 0)
                for row in passes.month_rows(passes.read_spend(deps.spend_file), deps.now()))
    if spent + estimate > limit - reserve:
        raise LatencyRefused(f"this run's ${estimate:.2f} would take this month's eval spend past "
                             f"${limit - reserve:.2f} (the ${limit:.0f} monthly limit less the ${reserve:.0f} demo "
                             f"reserve): ${max(limit - reserve - spent, 0):.2f} remains")


def prove_latency(root: Path) -> dict[str, Any]:
    """`scripts.prove_latency --json` (Plan 01a), run from `backend/`: `{rivera: {p50_ms, p95_ms},
    cards_30: {p50_ms, p95_ms}}` over its timings of each card set."""
    done = subprocess.run([sys.executable, "-m", "scripts.prove_latency", "--json"], cwd=root / "backend",
                          capture_output=True, text=True, timeout=1800)
    if done.returncode != 0:
        raise RuntimeError(f"it exited {done.returncode}")
    return json.loads(done.stdout)


def proving_spread(proved: Mapping[str, Any]) -> Spread:
    """The proving latency of the Rivera card set, the one the Desk under test runs."""
    rivera = proved["rivera"]
    return Spread(n=PROVE_RUNS, p50=rivera["p50_ms"], p95=rivera["p95_ms"])


@asynccontextmanager
async def in_process_target(config: LatencyConfig) -> AsyncIterator[Any]:
    """The kernel and the API in this process, built from the working tree: every model scripted on a dry
    run (the Desk replies in plain prose and the reviewer passes), else real on the run's provider."""
    from evals.fakes import Json, ToolUse
    from evals.tier1.golden_desk import REVIEW_PASS, REVIEWER_MODEL
    from evals.tier1.targets import KernelTarget, load_api_target

    make = load_api_target()
    models, provider = ("fake", "anthropic") if config.dry_run else ("real", config.provider)
    kernel = KernelTarget(models=models)
    api = None
    try:
        await kernel.start()
        if config.dry_run:
            kernel.fake.default(DESK_MODELS["conversation"], ToolUse(
                "send_reply", {"prose": "Thanks for your message. How can I help?", "clauses": []}))
            kernel.fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))
        api = make(kernel, models=models, provider=provider)
        await api.start()
        try:
            await passes.preflight(api, kernel_health=kernel.health)
        except passes.PassRefused as refused:
            raise LatencyRefused(str(refused)) from None
        yield api
    finally:
        if api is not None:
            await api.stop()
        await kernel.stop()


__all__ = ["KINDS", "MESSAGES", "PER_TURN_USD", "Chat", "Kind", "LatencyConfig", "LatencyDeps", "LatencyMismatch",
           "LatencyRefused", "LatencyRun", "Measured", "Reveal", "Spent", "Turn", "TurnSample", "decide_ms", "drive",
           "errored_turns", "full_turn", "hosted_latency", "in_process_target", "local_latency", "measure_hosted",
           "measure_local", "metric_rows", "one_turn", "prove_latency", "proving_spread", "reveals", "reviewer_ms",
           "run_latency", "spend_usd", "spread"]
