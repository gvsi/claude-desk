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

A real run stops at `--max-usd`: before each turn it reads what its chats' calls have cost from
records it can trust (`under_budget`), the target's own records locally, and a hosted run's meter
(`LatencyDeps.hosted_usage`). The deployment reports no such usage, since its owner's ledger records
only the kernel's checks and never the conversation's calls, so a hosted run is refused
(`HOSTED_UNMETERED`) rather than run uncapped.
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
from evals.pricing import PRICES, Price
from evals.report import HostedLatency, Latency, LocalLatency, Spread, TurnSpread
from evals.tier2 import passes
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
# a reviewer call and a Sonnet soft-promise check ($0.0324, "Model cost and latency budget"), rounded up for cold
# caches and a conversation that grows. Twenty turns of each kind come to $3.00.
PER_TURN_USD = 0.05
PROVE_RUNS = 20   # the timings `scripts.prove_latency --runs` makes of each card set (Plan 01a)
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


# Reads what the chats' model calls have cost so far, from records the run can trust.
UsageReader = Callable[[Sequence[Chat]], Awaitable[list[UsageRecord]]]


@dataclass
class Meter:
    """The spend a run's budget last read between turns, at list prices (`under_budget`): a run that
    breaks off before its calls are read is charged no less."""

    last_usd: float = 0.0


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
                        api_provider: str = "anthropic", meter: Meter | None = None) -> Measured:
    """Turns on an in-process `ApiTarget`, then each chat's `app.run_events` rows, its copy's ledger and
    its model calls, read from the target's records. With `max_usd`, no turn starts once the chats'
    calls cost that much at list prices, and `meter` keeps the last figure read."""
    records = target.kernel.records

    async def usage_of(chats: Sequence[Chat]) -> list[UsageRecord]:
        usage = []
        for chat in chats:
            ledger = [entry.model_dump(mode="json") for entry in await records.ledger_entries(chat.copy_id,
                                                                                               chat.desk_id)]
            usage += collect_usage({"model_calls": await records.model_calls(chat.session_id),
                                    "ledger_entries": ledger}, [chat.session_id])
        return usage

    clients = _Clients(target.base_url, target.passcode, max(turn_timeout_s, 30.0))
    try:
        chats, samples, stopped = await drive(
            clients, turns=turns, kinds=kinds, turn_timeout_s=turn_timeout_s,
            keep_going=under_budget(max_usd, usage_of, api_provider, meter) if max_usd is not None else None)
        run_events, ledger = [], []
        for chat in chats:
            run_events += await records.run_events(chat.session_id)
            ledger += [entry.model_dump(mode="json") for entry in await records.ledger_entries(chat.copy_id,
                                                                                                chat.desk_id)]
        return Measured(samples=samples, session_ids=[chat.session_id for chat in chats], run_events=run_events,
                        ledger_entries=ledger, usage=await usage_of(chats), stopped_by_budget=stopped)
    finally:
        await clients.aclose()


async def measure_hosted(base_url: str, passcode: str, *, turns: int, max_usd: float, usage_of: UsageReader,
                         kinds: Sequence[Kind] = KINDS, turn_timeout_s: float = TURN_TIMEOUT_S,
                         meter: Meter | None = None) -> Measured:
    """Turns on the hosted deployment, then the reviewer's entries in each copy's ledger, read through
    the owner's ledger route (its database is private), and the chats' model calls as `usage_of` reads
    them. No turn starts once those calls cost `max_usd` at the Claude API's list prices (a deployment
    runs on it), as `usage_of` reads them before each turn: a hosted run is never uncapped. `meter`
    keeps the last figure read."""
    clients = _Clients(base_url, passcode, max(turn_timeout_s, 30.0))
    try:
        chats, samples, stopped = await drive(clients, turns=turns, kinds=kinds, turn_timeout_s=turn_timeout_s,
                                              keep_going=under_budget(max_usd, usage_of, "anthropic", meter))
        ledger = []
        for chat in chats:
            ledger += (await chat.owner.owner_ledger(chat.desk_id))["entries"]
        return Measured(samples=samples, session_ids=[chat.session_id for chat in chats], ledger_entries=ledger,
                        usage=await usage_of(chats), stopped_by_budget=stopped)
    finally:
        await clients.aclose()


def under_budget(max_usd: float, usage_of: UsageReader, api_provider: str,
                 meter: Meter | None = None) -> Callable[[list[Chat]], Awaitable[bool]]:
    """`drive`'s budget: another turn may start while the chats' calls so far, as `usage_of` reads them,
    cost less than `max_usd` at list prices (`spend_usd`), each figure read kept in `meter`. A read or a
    price that fails raises, which stops the run, and leaves `meter` at the last figure read."""

    async def keep_going(chats: list[Chat]) -> bool:
        spent = spend_usd(await usage_of(chats), api_provider).total_usd
        if meter is not None:
            meter.last_usd = spent
        return spent < max_usd

    return keep_going


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


HOSTED_UNMETERED = ("a hosted run can't stop at --max-usd: the deployment's database is private and its owner's "
                    "ledger records only the kernel's checks, not the conversation's model calls, so the run can read "
                    "no usage it can trust between turns, and it isn't run uncapped; measure latency locally instead")


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
    spend_usd: float | None                      # at list prices; None for a dry run
    spend_estimated: bool                        # spend_usd is estimated: the calls couldn't all be read or priced
    stopped_by_budget: bool
    latency: Latency
    proving: dict[str, Any] | None               # `scripts.prove_latency --json` as it printed
    samples: list[TurnSample]

    @model_validator(mode="after")
    def _estimated_spend_is_spend(self) -> Self:
        if self.spend_estimated and self.spend_usd is None:
            raise ValueError("only a run that spent can have its spend estimated")
        return self


@dataclass
class LatencyDeps:
    """What `run_latency` reaches outside itself, so a test can stand in for any of it."""

    root: Path = REPO_ROOT
    target: Callable[[LatencyConfig], AbstractAsyncContextManager[Any]] | None = None
    measure_local: Callable[..., Awaitable[Measured]] = measure_local
    measure_hosted: Callable[..., Awaitable[Measured]] = measure_hosted
    prove: Callable[[Path], Mapping[str, Any]] | None = None
    # How a hosted run reads, between turns, what its chats' calls have cost, from records it can trust. None
    # while the deployment reports no such usage (`HOSTED_UNMETERED`), which refuses every hosted run.
    hosted_usage: UsageReader | None = None
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

    Before any turn: a real run's estimate ($0.05 a turn) must be within `--max-usd`, and the run needs
    list prices for every model the stack calls and room for the estimate in this month's eval spend
    (the limit less the demo reserve, by a pass's own checks). A local real run also needs
    `ANTHROPIC_API_KEY` (and `BEDROCK_BEARER_TOKEN` on Bedrock). A hosted run needs `DESK_PASSCODE`
    and a meter of the deployment's usage it can trust (`LatencyDeps.hosted_usage`); with none, it is
    refused (`HOSTED_UNMETERED`) rather than run uncapped. A local run then proves first
    (`scripts.prove_latency --json`), so a failed proof costs nothing. During a real run no turn starts
    once the turns' calls cost `--max-usd`, and after it what they cost is appended to the shared
    spend file with no tier 2 runs, so the monthly guard counts it and no pass's cost per run does. A
    hosted run's calls are priced at the Claude API's list prices, which a deployment runs on. When the
    calls can't all be read or priced, as when the run breaks off, it is charged the larger of its
    estimate and the spend its budget last read between turns (`Meter`) instead, and the spend row
    (`estimated_usd`) and the run's file (`spend_estimated`) say so. No dry run spends anything."""
    deps = deps or LatencyDeps()
    hosted, real = config.base_url is not None, not config.dry_run
    estimate = round(len(KINDS) * config.turns * PER_TURN_USD, 6) if real else 0.0
    if estimate > config.max_usd:
        raise LatencyRefused(f"the estimate ${estimate:.2f} for {len(KINDS) * config.turns} turns is over --max-usd "
                             f"${config.max_usd:.2f}")
    passcode = None
    if hosted:
        if deps.hosted_usage is None:
            raise LatencyRefused(HOSTED_UNMETERED)
        passcode = deps.credential("DESK_PASSCODE")
        if not passcode:
            raise LatencyRefused("a hosted run enters the deployment as its owner: set DESK_PASSCODE in .env")
    # Where the API's calls are priced: a deployment's at the Claude API's prices, since production refuses
    # Bedrock (as a tier 2 pass by URL prices them), the in-process stack's at its own provider's.
    api_provider = "anthropic" if hosted else passes.stack_models(config)[1]
    if real:
        try:   # a tier 2 pass's own checks, as a latency run's
            if not hosted:   # a deployment calls its models with its own keys
                passes.require_credentials(config.provider, deps.credential, what="latency run")
            passes.require_prices(deps.prices, api_provider, on_provider=passes.API_ROUTES.values(),
                                  on_claude_api=passes.KERNEL_ROUTES.values(), what="latency run")
            # The estimate, all of it counted as Claude API spend.
            passes.within_the_month(estimate, passes.read_spend(deps.spend_file), deps.now(), deps.root,
                                    what="latency run")
        except passes.PassRefused as refused:
            raise LatencyRefused(str(refused)) from None
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
    meter = Meter()
    spend, estimated = None, False
    started = False
    try:
        if hosted:
            started = True
            measured = await deps.measure_hosted(config.base_url, passcode, turns=config.turns,
                                                 max_usd=config.max_usd, usage_of=deps.hosted_usage, kinds=KINDS,
                                                 turn_timeout_s=config.turn_timeout_s, meter=meter)
        else:
            async with deps.target(config) as target:
                started = True
                measured = await deps.measure_local(target, turns=config.turns, kinds=KINDS,
                                                    turn_timeout_s=config.turn_timeout_s,
                                                    max_usd=config.max_usd if real else None,
                                                    api_provider=api_provider, meter=meter)
    finally:
        # Recorded before the numbers are read, so a run whose numbers disagree still counts.
        if real and started:
            spend, estimated = _charge(deps.spend_file, f"latency-{latency_id}", now, estimate, measured, api_provider,
                                       metered=meter.last_usd)
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
        spend_estimated=estimated, stopped_by_budget=measured.stopped_by_budget, latency=latency, proving=proved,
        samples=measured.samples)
    out = deps.root / "evals" / "out" / "latency" / f"{latency_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(run.model_dump_json(indent=1) + "\n")
    return run, out


def _charge(spend_file: Path, row_id: str, now: datetime, estimate: float, measured: Measured | None,
            api_provider: str, *, metered: float = 0.0) -> tuple[float, bool]:
    """Appends a real latency run's spend to the shared spend file, with no tier 2 runs, and returns it
    and whether it is estimated: its calls at list prices (the API's at `api_provider`'s, the kernel's
    checks at the Claude API's), or, for a run that broke off before its calls were read or whose calls
    can't all be priced, the larger of its estimate and the spend its budget last read (`metered`), so
    never less than it knew it had spent, all of it on the Claude API, which the row marks as estimated."""
    spend = claude_api = max(estimate, metered)
    estimated = True
    if measured is not None:
        try:
            spent = spend_usd(measured.usage, api_provider)
        except (LookupError, ValueError):   # no list price for a model, or a count that isn't one
            pass
        else:
            spend, estimated = spent.total_usd, False
            claude_api = spent.kernel_usd + (spent.api_usd if api_provider == "anthropic" else 0.0)
    passes.append_spend(spend_file, {
        "pass_id": row_id, "date": now.astimezone(UTC).date().isoformat(), "provider": api_provider, "runs": 0,
        "desk_usd": f"{spend:.4f}", "simulator_usd": f"{0:.4f}", "claude_api_usd": f"{claude_api:.4f}",
        "total_usd": f"{spend:.4f}", "estimated_usd": f"{spend if estimated else 0:.4f}"})
    return spend, estimated


def prove_latency(root: Path) -> dict[str, Any]:
    """`scripts.prove_latency --json` (Plan 01a), run from `backend/`: `{rivera: {p50_ms, p95_ms},
    cards_30: {p50_ms, p95_ms}}` over its timings of each card set."""
    done = subprocess.run([sys.executable, "-m", "scripts.prove_latency", "--json", "--runs", str(PROVE_RUNS)],
                          cwd=root / "backend", capture_output=True, text=True, timeout=1800)
    if done.returncode != 0:
        raise RuntimeError(f"it exited {done.returncode}")
    return json.loads(done.stdout)


def proving_spread(proved: Mapping[str, Any]) -> Spread:
    """The proving latency of the Rivera card set, the one the Desk under test runs."""
    rivera = proved["rivera"]
    return Spread(n=PROVE_RUNS, p50=rivera["p50_ms"], p95=rivera["p95_ms"])


@asynccontextmanager
async def in_process_target(config: LatencyConfig, *, kernel_target: Callable[..., Any] | None = None,
                            make_api_target: Callable[..., Any] | None = None,
                            check: Callable[..., Any] | None = None) -> AsyncIterator[Any]:
    """The kernel and the API a tier 2 pass runs on (`passes.in_process_api`), built from the working
    tree: the Desk's models scripted as on a dry pass, else real on the run's provider. A preflight that
    refuses refuses the run. The keyword arguments stand in for the kernel target, Plan 02a's
    `make_api_target` and the preflight in tests."""

    async def preflight(api: Any, *, kernel_health: Any) -> None:
        try:
            await (check or passes.preflight)(api, kernel_health=kernel_health)
        except passes.PassRefused as refused:
            raise LatencyRefused(str(refused)) from None

    async with passes.in_process_api(config, kernel_target=kernel_target, make_api_target=make_api_target,
                                     check=preflight) as api:
        yield api


__all__ = ["HOSTED_UNMETERED", "KINDS", "MESSAGES", "PER_TURN_USD", "Chat", "Kind", "LatencyConfig", "LatencyDeps",
           "LatencyMismatch", "LatencyRefused", "LatencyRun", "Measured", "Meter", "Reveal", "Spent", "Turn",
           "TurnSample", "UsageReader", "decide_ms", "drive", "errored_turns", "full_turn", "hosted_latency",
           "in_process_target", "local_latency", "measure_hosted", "measure_local", "metric_rows", "one_turn",
           "prove_latency", "proving_spread", "reveals", "reviewer_ms", "run_latency", "spend_usd", "spread",
           "under_budget"]
