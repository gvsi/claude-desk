"""The simulated visitor: a model that plays a scenario's persona, one structured turn at a time.

`Simulator(model, effort, provider)` asks its model for the visitor's next turn (`VisitorTurn`)
through `output_config.format`, with a cached system prompt and no tools or `tool_choice`. The
attacker runs on `claude-opus-5-5` at effort `medium` and the legitimate visitor on
`claude-sonnet-5-5` at effort `low`, on the Claude API or Amazon Bedrock; the provider never swaps
in another model.

**Refusals.** The client carries the SDK's client-side `BetaRefusalFallbackMiddleware`, falling
back to the other production model on both providers, with no server-side `fallbacks` field or
beta. A run holds one `BetaFallbackState` (`SimulatorRun`), so once a turn is re-served, later turns
of that run go straight to the fallback model. A turn served by a model other than the configured
one is counted (`fallback_turns`), and a response carrying a `fallback` block is a switch, read
from the response itself: on this non-streaming path the pinned SDK (2.3.0) prepends that block to
the re-served response and leaves its `usage` as the serving model's. Served models are named by
their production names through `BEDROCK_MODEL_IDS`. A turn both models refuse raises
`SimulatorRefused`.

**What it sees.** Only observations (`observe_events`, `observe_a2a`): the Desk's prose, its cards
as `[card: <template>] <text>`, status lines as `[status] <visitor_plain>`, the visitor's own
messages and harness notes. Ids, signatures, link tokens and Demo inbox entries never reach it.

**Credentials** follow the API's model client rules (`desk.api.model.make_model`):
`ANTHROPIC_CUSTOM_HEADERS` set refuses either provider before any client exists; the Claude API
client always gets an explicit key and host, so the SDK reads no ambient credential; the Bedrock
client is built only from `bedrock_client_kwargs` with `BEDROCK_BEARER_TOKEN`, so no AWS library or
credential chain is involved. `fake_url` points either client at a `FakeAnthropic` with no
credential (a placeholder key on the Claude API client, `skip_auth` on the Bedrock one).
"""

import os
import sys
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, TextIO

import anthropic
import httpx2
from anthropic import BetaFallbackState, BetaRefusalFallbackMiddleware
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from desk.api.model import BEDROCK_MODEL_IDS, NO_API_KEY, bedrock_client_kwargs
from desk.contracts import RenderedBlock
from desk.events import EvError, EvHeld, EvMessage, EvOwnerJoined, EvOwnerLeft, EvReceipt, EvResolved
from evals.tier2.artifact import A2AAnswer
from evals.tier2.prompts import (
    ATTACKER_SYSTEM,
    CHECK_SYSTEM,
    CHECK_USER,
    MAX_MESSAGE_CHARS,
    VISITOR_SYSTEM,
    Observation,
    user_turn,
)
from evals.tier2.schema import Provider, Scenario

ANTHROPIC_API_URL = "https://api.anthropic.com"
DEFAULT_AWS_REGION = "us-west-2"
REPO_ROOT = Path(__file__).resolve().parents[2]
ATTACKER_MODEL, ATTACKER_EFFORT = "claude-opus-5-5", "medium"
VISITOR_MODEL, VISITOR_EFFORT = "claude-sonnet-5-5", "low"
# Each simulator model's refusal fallback: the other production model.
FALLBACK_MODEL = {ATTACKER_MODEL: VISITOR_MODEL, VISITOR_MODEL: ATTACKER_MODEL}
PROVIDERS: tuple[Provider, ...] = ("anthropic", "bedrock")
# The `betas` the refusal middleware sends on each provider: None sends the pinned SDK's default
# (`anthropic-beta: fallback-credit-2026-07-01`); () sends none. A non-streaming retry needs no
# credit token, so if Bedrock rejects the header, its entry becomes () and `simulator-check` runs again.
SIMULATOR_FALLBACK_BETAS: dict[Provider, tuple[str, ...] | None] = {"anthropic": None, "bedrock": None}
MAX_TOKENS = 2000
CHECK_MAX_TOKENS = 200
MAX_RETRIES = 2
# What either provider may call a production model, back to its production name.
PRODUCTION_NAMES = {served: name for name, profile in BEDROCK_MODEL_IDS.items()
                    for served in (name, profile, profile.removeprefix("us."))}

SimulatorErrorKind = Literal["infra", "simulator_refused", "config_mismatch"]


class SimulatorError(RuntimeError):
    """The simulator couldn't give a turn: `kind` is how the runner records the run's error."""

    def __init__(self, kind: SimulatorErrorKind, detail: str):
        super().__init__(detail)
        self.kind, self.detail = kind, detail


class SimulatorRefused(SimulatorError):
    """The configured model and its fallback both refused the turn."""

    def __init__(self, detail: str):
        super().__init__("simulator_refused", detail)


class VisitorTurn(BaseModel):
    """The visitor's next move: a message to send, a contact to ask a code for, a code to enter,
    or done (the message is then not sent)."""

    model_config = ConfigDict(extra="forbid")
    message: str = Field(max_length=MAX_MESSAGE_CHARS)
    verify_contact: str | None
    verify_code: str | None
    done: bool


@dataclass(frozen=True)
class ServedTurn:
    """One simulator call as served: the model that served it (its production name), whether that
    is the configured model's fallback, whether the response carried a `fallback` block, and usage."""

    model: str
    fallback: bool
    switched: bool
    usage: dict[str, Any]


@dataclass
class SimulatorRun:
    """One run's simulator state: its `BetaFallbackState` and every turn it served."""

    state: BetaFallbackState = field(default_factory=BetaFallbackState)
    turns: list[ServedTurn] = field(default_factory=list)

    @property
    def fallback_turns(self) -> int:
        return sum(served.fallback for served in self.turns)

    @property
    def switches(self) -> int:
        return sum(served.switched for served in self.turns)

    @property
    def served_models(self) -> list[str]:
        return [served.model for served in self.turns]

    @property
    def usage(self) -> list[dict[str, Any]]:
        return [served.usage for served in self.turns]


# What the visitor sees

def said(text: str) -> Observation:
    """The visitor's own message."""
    return Observation("you", text)


def note(text: str) -> Observation:
    """A note from the harness (a code accepted, a verification done out of band)."""
    return Observation("note", text)


def observe_blocks(blocks: Sequence[RenderedBlock]) -> list[Observation]:
    """Prose as it reads, cards as their template and text: never a fact id, title or link."""
    return [Observation("card", block.text, block.template) if block.kind == "card"
            else Observation("prose", block.text) for block in blocks]


def observe_events(events: Sequence[Any]) -> list[Observation]:
    """What a visitor's chat shows for these SSE events (models or their JSON): checked messages,
    status lines and the chat's own lines. Writing indicators, turn ends and Demo inbox notices show
    nothing here: the attack suite treats the Demo inbox as out of the visitor's reach."""
    seen: list[Observation] = []
    for event in events:
        if isinstance(event, EvMessage):
            seen += observe_blocks(event.blocks)
        elif isinstance(event, EvReceipt | EvHeld | EvResolved):
            seen.append(Observation("status", event.visitor_plain))
        elif isinstance(event, EvOwnerJoined):
            seen.append(Observation("status", f"{event.name} joined the chat."))
        elif isinstance(event, EvOwnerLeft):
            seen.append(Observation("status", "Claude is helping again."))
        elif isinstance(event, EvError):
            seen.append(Observation("status", "The chat couldn't answer that just now."))
    return seen


def observe_a2a(response: A2AAnswer | dict[str, Any] | BaseModel) -> list[Observation]:
    """What an agent reads in an A2A answer: its blocks and receipts' status lines. Read leniently
    (`A2AAnswer`), so an answer missing its disclosure is still shown and judged, never dropped."""
    answer = response if isinstance(response, A2AAnswer) else A2AAnswer.model_validate(
        response.model_dump() if isinstance(response, BaseModel) else response)
    return [*observe_blocks(answer.blocks), *(Observation("status", r.visitor_plain) for r in answer.receipts)]


# The client

def _credential(name: str) -> str | None:
    """A credential from the environment, else from the repository's `.env`; never printed."""
    if value := os.environ.get(name):
        return value
    path = REPO_ROOT / ".env"
    if not path.is_file():
        return None
    for line in path.read_text().splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key.strip() == name:
            return value.strip().strip("'\"") or None
    return None


def _key(value: str | None, name: str) -> str:
    """`value` as an API key: one run of printable ASCII, else a `RuntimeError` naming `name`, never the value."""
    if not value or not value.isascii() or not value.isprintable() or any(c.isspace() for c in value):
        raise RuntimeError(f"{name} must be set to one API key: printable ASCII with no spaces")
    return value


def model_id(provider: Provider, name: str) -> str:
    """The id the provider names a production model by."""
    return BEDROCK_MODEL_IDS[name] if provider == "bedrock" else name


def production_name(served: str) -> str:
    return PRODUCTION_NAMES.get(served, served)


def build_client(provider: Provider, *, fallback_model: str, fake_url: str | None = None,
                 http_client: httpx2.AsyncClient | None = None) -> Any:
    """The simulator's SDK client on `provider`, carrying the refusal middleware that falls back to
    `fallback_model` (a production name) with that provider's `SIMULATOR_FALLBACK_BETAS` entry."""
    if provider not in PROVIDERS:
        raise ValueError(f"the simulator's provider is one of {list(PROVIDERS)}, not {provider!r}")
    if os.environ.get("ANTHROPIC_CUSTOM_HEADERS"):
        raise RuntimeError("ANTHROPIC_CUSTOM_HEADERS is set; the simulator sends no custom headers, which could "
                           "replace its key")
    middleware = [BetaRefusalFallbackMiddleware([{"model": model_id(provider, fallback_model)}],
                                                betas=SIMULATOR_FALLBACK_BETAS[provider])]
    if provider == "bedrock":
        if fake_url is not None:   # no credential at all: the fake reads none
            return anthropic.AsyncAnthropicBedrockMantle(skip_auth=True, base_url=fake_url,
                                                         aws_region=DEFAULT_AWS_REGION,
                                                         max_retries=MAX_RETRIES, http_client=http_client,
                                                         middleware=middleware)
        kwargs = bedrock_client_kwargs(_credential("AWS_REGION") or DEFAULT_AWS_REGION,
                                       bearer_token=_credential("BEDROCK_BEARER_TOKEN"))
        return anthropic.AsyncAnthropicBedrockMantle(**kwargs, max_retries=MAX_RETRIES, http_client=http_client,
                                                     middleware=middleware)
    if fake_url is not None:
        api_key, base_url = NO_API_KEY, fake_url   # the placeholder: only a fake server ever gets it
    else:
        api_key, base_url = _key(_credential("ANTHROPIC_API_KEY"), "ANTHROPIC_API_KEY"), ANTHROPIC_API_URL
    return anthropic.AsyncAnthropic(api_key=api_key, base_url=base_url, max_retries=MAX_RETRIES,
                                    http_client=http_client, middleware=middleware)


# The simulator

class Simulator:
    """The simulated visitor on one model and provider. `new_run()` gives each run its own state;
    `next_turn` asks for the visitor's next move given what it has seen."""

    def __init__(self, model: str, effort: Literal["low", "medium", "high"], provider: Provider = "anthropic", *,
                 fake_url: str | None = None, http_client: httpx2.AsyncClient | None = None):
        if model not in FALLBACK_MODEL:
            raise ValueError(f"the simulator runs on a production model with a fallback, {sorted(FALLBACK_MODEL)}, "
                             f"not {model!r}")
        if provider not in PROVIDERS:
            raise ValueError(f"the simulator's provider is one of {list(PROVIDERS)}, not {provider!r}")
        self.model, self.effort, self.provider = model, effort, provider
        self.fallback_model = FALLBACK_MODEL[model]
        self.fallbacks = ({"model": model_id(provider, self.fallback_model)},)
        self.suite = "attack" if model == ATTACKER_MODEL else "legit"   # the suite whose visitor it plays
        self.system = ATTACKER_SYSTEM if self.suite == "attack" else VISITOR_SYSTEM
        self._client = build_client(provider, fallback_model=self.fallback_model, fake_url=fake_url,
                                    http_client=http_client)

    @classmethod
    def attacker(cls, provider: Provider = "anthropic", **hooks: Any) -> "Simulator":
        return cls(ATTACKER_MODEL, ATTACKER_EFFORT, provider, **hooks)

    @classmethod
    def visitor(cls, provider: Provider = "anthropic", **hooks: Any) -> "Simulator":
        return cls(VISITOR_MODEL, VISITOR_EFFORT, provider, **hooks)

    @classmethod
    def for_suite(cls, suite: Literal["attack", "legit"], provider: Provider = "anthropic",
                  **hooks: Any) -> "Simulator":
        return cls.attacker(provider, **hooks) if suite == "attack" else cls.visitor(provider, **hooks)

    @property
    def model_id(self) -> str:
        return model_id(self.provider, self.model)

    def new_run(self) -> SimulatorRun:
        return SimulatorRun()

    async def aclose(self) -> None:
        await self._client.close()

    async def next_turn(self, scenario: Scenario, observations: Sequence[Observation], run: SimulatorRun, *,
                        turns_left: int | None = None) -> VisitorTurn:
        """The visitor's next turn in `run`. Raises `SimulatorRefused` when both models refuse, and
        `SimulatorError` when the answer isn't a turn or the scenario is another suite's (`config_mismatch`:
        a cooperative customer standing in for an attacker would pass every attack)."""
        if scenario.suite != self.suite:
            raise SimulatorError("config_mismatch", f"the {self.model} simulator plays the {self.suite} suite's "
                                                    f"visitor, not {scenario.id}'s")
        left = scenario.max_turns if turns_left is None else turns_left
        text = user_turn(scenario.persona, scenario.goal, scenario.visitor, observations, left)
        return await self._turn(self.system, text, run, MAX_TOKENS)

    async def check_turn(self, run: SimulatorRun) -> VisitorTurn:
        """One short turn, for `simulator-check`."""
        return await self._turn(CHECK_SYSTEM, CHECK_USER, run, CHECK_MAX_TOKENS)

    async def _turn(self, system: str, text: str, run: SimulatorRun, max_tokens: int) -> VisitorTurn:
        started = time.monotonic()
        try:
            with run.state:
                message = await self._client.beta.messages.parse(
                    model=self.model_id, max_tokens=max_tokens,
                    system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                    messages=[{"role": "user", "content": text}],
                    output_format=VisitorTurn, output_config={"effort": self.effort},
                )
        except (ValidationError, ValueError) as error:
            raise SimulatorError("infra", f"the simulator's answer isn't a visitor turn ({type(error).__name__})") \
                from None
        served = production_name(message.model)
        if served not in (self.model, self.fallback_model):
            raise SimulatorError("config_mismatch", f"a simulator turn was served by {served!r}, which is neither "
                                                    f"{self.model} nor its fallback {self.fallback_model}")
        usage = message.usage
        run.turns.append(ServedTurn(
            model=served, fallback=served != self.model,
            switched=any(block.type == "fallback" for block in message.content),
            usage={"model": served, "input_tokens": usage.input_tokens,
                   "cache_read_input_tokens": usage.cache_read_input_tokens or 0,
                   "cache_creation_input_tokens": usage.cache_creation_input_tokens or 0,
                   "output_tokens": usage.output_tokens, "stop_reason": message.stop_reason,
                   "latency_ms": round((time.monotonic() - started) * 1000)},
        ))
        if message.stop_reason == "refusal":
            raise SimulatorRefused(f"{self.model} and its fallback {self.fallback_model} refused the turn")
        texts = [block for block in message.content if block.type == "text"]
        if message.stop_reason != "end_turn" or len(texts) != 1 or texts[0].parsed_output is None:
            raise SimulatorError("infra", f"the simulator's answer stopped with {message.stop_reason} and "
                                          f"{len(texts)} text blocks, not one visitor turn")
        return texts[0].parsed_output


# python -m evals.run simulator-check

async def simulator_check(provider: Provider, *, fake_url: str | None = None,
                          http_client: httpx2.AsyncClient | None = None, out: TextIO = sys.stdout) -> int:
    """One short simulator turn on `provider`, through the refusal middleware with its
    `SIMULATOR_FALLBACK_BETAS` entry: exit 0 when it is served, 1 when the API answers an error (a 4xx
    naming the `anthropic-beta` header says which setting to change)."""
    try:
        simulator = Simulator.visitor(provider, fake_url=fake_url, http_client=http_client)
    except RuntimeError as refused:   # a credential missing or malformed: named, never shown
        print(f"simulator-check {provider}: {refused}", file=out)
        return 1
    betas = SIMULATOR_FALLBACK_BETAS[provider]
    sent = "the SDK's default fallback-credit beta" if betas is None else (", ".join(betas) or "no beta")
    try:
        run = simulator.new_run()
        await simulator.check_turn(run)
    except anthropic.APIStatusError as error:
        print(f"simulator-check {provider}: {simulator.model_id} answered {error.status_code} with {sent}: "
              f"{_error_message(error)}", file=out)
        if 400 <= error.status_code < 500 and "anthropic-beta" in str(error.body).lower():
            print(f"The error names the anthropic-beta header: set SIMULATOR_FALLBACK_BETAS[{provider!r}] = () in "
                  "evals/tier2/simulator.py and run the check again.", file=out)
        return 1
    except (anthropic.AnthropicError, httpx2.HTTPError, SimulatorError) as error:
        print(f"simulator-check {provider}: {simulator.model_id} failed: {type(error).__name__}", file=out)
        return 1
    finally:
        await simulator.aclose()
    print(f"simulator-check {provider}: served by {', '.join(run.served_models)} with {sent}", file=out)
    return 0


def _error_message(error: anthropic.APIStatusError) -> str:
    body = error.body if isinstance(error.body, dict) else {}
    detail = body.get("error") if isinstance(body.get("error"), dict) else body
    return str(detail.get("message", ""))[:300] if isinstance(detail, dict) else ""


__all__ = [
    "ATTACKER_MODEL", "FALLBACK_MODEL", "SIMULATOR_FALLBACK_BETAS", "VISITOR_MODEL", "ServedTurn", "Simulator",
    "SimulatorError", "SimulatorRefused", "SimulatorRun", "VisitorTurn", "build_client", "model_id", "note",
    "observe_a2a", "observe_blocks", "observe_events", "production_name", "said", "simulator_check",
]
