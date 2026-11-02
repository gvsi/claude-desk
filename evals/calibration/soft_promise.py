"""The kernel's soft-promise check measured on the real model: every case in `soft_promise.yaml` sent
N times through the call the kernel makes, with the system prompt in this tree, at a git ref or in a
file, and each answer counted against what the case expects.

    python -m evals.calibration.soft_promise --samples N --max-usd X
        [--prompt-ref REF | --prompt-file PATH] [--label NAME] [--concurrency 4]
    python -m evals.calibration.soft_promise --rescore RESULTS

`make evals-soft-promise MAX_USD=<dollars> [SAMPLES=5] [PROMPT_REF=<ref> | PROMPT_FILE=<path>]` runs it.
`--rescore` calls no model and spends nothing: it scores the answers a run saved in its results file
against the case file as it is now (each case's expectation, and whether the code check blocks it, in
this tree) and prints the table; a case the run never asked about is not run, and a case whose input
(its language, prose and cards) isn't the one the run recorded is stale, its answers never scored.
`python -m evals.calibration.soft_promise_experiment` runs a frozen old/new experiment
with one shared allowance and records both input shapes; `not_ai` measures only the AI flag.
It spends money: the default is production Sonnet 5.5 on the Claude API, estimated at $0.0026
(`SONNET_PER_CALL_USD`, 1.5 times the measured $0.0017 mean). Historical Haiku arms keep their
$0.0005 allowance (`PER_CALL_USD`).

The call. Each is the kernel's own `AnthropicDecisions.soft_promise` (backend/desk/kernel_service/
decisions.py), the call the reply check makes, over the SDK client: the same model, schema, effort,
thinking, timeout and input (the reply's language, its prose as the scan reads it, `reply_check.shown`,
and its cards' texts). Only the system prompt is the one asked for: decisions.py's `SOFT_PROMISE_SYSTEM`
in this tree by default, at `--prompt-ref` (read with `git show` and taken by `ast`, never imported or
run), or the text of `--prompt-file` without its surrounding whitespace.

Before any call it refuses, saying why:
1. without `--max-usd` (and `make evals-soft-promise` without MAX_USD);
2. when its estimate, cases × samples × the selected model's allowance, is over `--max-usd`;
3. when this month's Claude API spend in the shared eval spend file plus the estimate would pass the
   monthly limit less the demo reserve (`evals/budget.toml`), as a tier 2 pass does;
4. without `ANTHROPIC_API_KEY` in the environment, with one that isn't one key (printable ASCII with
   no spaces), or with `ANTHROPIC_CUSTOM_HEADERS` set, which the kernel refuses too. The key goes to
   the SDK client and nowhere else: it is never printed or written.

Whether the kernel's code check (`reply_check.scan_prose`, offline) blocks each case is computed here
on every run, never read from the case file. Then the calls, `--concurrency` at a time, one sample of
every case before the next sample of any. Each call reserves an upper bound on its cost before it
starts (`call_bound`): one input token for every `CHARS_PER_TOKEN` characters of the system prompt and
of the case's request, plus a margin of `REQUEST_TOKENS`, at the higher of the input and cache-write
prices, and the most the check may answer, `SOFT_PROMISE_MAX_TOKENS` output tokens. A call starts only
while the spend so far and the bounds of the calls in flight leave room under `--max-usd` for its own
bound: at the cap no call starts, and the run says so and exits 1. Should a call still cost more than
its bound and take the spend past `--max-usd`, the run says so too and exits 1.

Spend. A call is charged its usage at its model's list prices (`PRICES`, from the master
plan's "Model cost and latency budget"), or its bound when its usage can't be priced: it left none
(a timeout or an error) or another model answered. The run appends one row to the shared eval spend
file, with tier 2's columns and `append_spend`: pass_id `calibration-soft-promise-<label>-<time>`,
ending `-estimated` when any call was charged its bound; provider `anthropic`; runs, the calls made;
the spend as the Desk's and the Claude API's; and in `estimated_usd`, the bounds charged for want of
usage (0 when every call was priced). A calibration's row counts against the monthly
limit but never measures what a tier 2 run costs (`passes.CALIBRATION_PREFIX`).

Results. `evals/out/soft-promise/<label>-<time>.json` (git-ignored; a run the records cite is copied
into `evals/calibration/results/` and committed) opens with a header (`about`, `RESULTS_ABOUT`) and
holds the run (the prompt, where it came from and its sha256, the commit, the model, samples,
estimate, spend, calls, whether the cap stopped it and whether the spend went past it) and, per case,
the sha256 of the input its calls sent (`input_sha256`: the request's one message, with the reply's
language, prose and cards), its expectation, whether the code check blocks it, the samples asked for
(`requested`), the count of each verdict over the samples taken (`pass`; `flag`,
promises_beyond_cards alone; `flag_ai`, denies_being_ai alone; `flag_both`; and `error`, no verdict),
its errors by status and its outcome. The saved `expected`, `code_blocked` and `outcome` are as of the
run, from the case file and the code check as they were then; `--rescore` against the case file as
it is now is the authority, as the header says. In a rescore, a case whose saved `input_sha256`
isn't the sha256 of the input it sends now, or which has none (a run that didn't record it), is
`stale`, and none of its answers is scored.

A sample meets `pass` with neither flag, `flag` with promises_beyond_cards set and `flag_ai` with
denies_being_ai set, whatever the other flag says, since either blocks the reply; an error meets
nothing. A case's outcome
is `all` only when every sample asked for met its expectation, else `some` or `none`; a case the cap
left with fewer samples than asked for is `incomplete`, and one with none `not_run`, whatever they
answered. A `code` case meets its expectation when the code check blocks it, whatever the model
answers. The printed table gives, for each group, how many cases met their expectation in all the
samples asked for, in some and in none, and how many are incomplete or not run (and, in a rescore,
stale), with the cases the code check blocks on rows of their own, and then each case not met in
every sample asked for.
"""

import argparse
import ast
import asyncio
import copy
import hashlib
import json
import math
import os
import re
import sys
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal

import anthropic
import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, computed_field, field_validator

from desk.kernel_service import decisions, reply_check
from desk.kernel_service.decisions import AnthropicDecisions, CallUsage, SoftPromiseInput, SoftPromiseVerdict
from desk.next_steps import BUSINESS_BLOCK_STEPS, NEXT_STEPS
from evals import results
from evals.pricing import PRICES as MODEL_PRICES, NoPrice, cost_usd, price_of
from evals.tier2.passes import (
    CALIBRATION_PREFIX,
    PassRefused,
    append_spend,
    load_budget,
    month_rows,
    read_spend,
    shared_spend_file,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CASES_FILE = Path(__file__).with_name("soft_promise.yaml")
OUT_DIR = REPO_ROOT / "evals" / "out" / "soft-promise"
DECISIONS_PATH = "backend/desk/kernel_service/decisions.py"
PER_CALL_USD = 0.0005
# A call's bound (`call_bound`) counts one input token for every 2 characters of its text, half the
# about 4 characters a token holds in English and Spanish prose, so it errs high, and 1,000 more as a
# margin for the request's own framing and the output schema the API adds to it.
CHARS_PER_TOKEN = 2
REQUEST_TOKENS = 1_000
# List prices in US dollars per million tokens, by model: input, cache read, 5-minute cache write and
# output (the master plan's "Model cost and latency budget").
PRICES = {model: {kind: float(getattr(price, kind))
                  for kind in ("input", "cache_read", "cache_write", "output")}
          for model, price in MODEL_PRICES["anthropic"].items()}
SONNET_MODEL = "claude-sonnet-5-5"
HAIKU_MODEL = "claude-haiku-5-5"
HAIKU_TIMEOUT_S = 2.0  # frozen historical experiment arms, independent of production
Candidate = Literal["haiku", "sonnet"]


def candidate_model(candidate: Candidate) -> str:
    return SONNET_MODEL if candidate == "sonnet" else HAIKU_MODEL


SONNET_PER_CALL_USD = 0.0026     # 1.5x the measured mean of the first Sonnet run (220 checks, $0.00171 each)


def per_call_usd(candidate: Candidate) -> float:
    if candidate == "sonnet":
        return SONNET_PER_CALL_USD
    # Keep the existing Haiku token allowance, scaled by the candidate's list prices.
    base = price_of(HAIKU_MODEL, "anthropic")
    price = price_of(candidate_model(candidate), "anthropic")
    return PER_CALL_USD * float(max(price.input / base.input, price.output / base.output))
VERDICTS = ("pass", "flag", "flag_ai", "flag_both", "error")
# A sample meets `flag` when promises_beyond_cards is set and `flag_ai` when denies_being_ai is,
# whatever the other flag says: either one blocks the reply, so `flag_both` meets both.
MEETS = {"pass": {"pass"}, "flag": {"flag", "flag_both"}, "flag_ai": {"flag_ai", "flag_both"},
         "not_ai": {"pass", "flag"}}
# The header every results file opens with (`RunResult.about`).
RESULTS_ABOUT = (
    "One run of the soft-promise check: its answers to each case. Each case's expected, code_blocked and outcome "
    "are as of the run, from the case file and the code check as they were then. `python -m "
    "evals.calibration.soft_promise --rescore <this file>` scores the answers against the case file as it is now "
    "and is the authority; a case whose input_sha256 (of its arm's language, prose, cards, next_steps and "
    "approved_names where that shape includes them) the case "
    "file no longer matches is stale there, and its answers aren't scored.")
LABEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
API_KEY = re.compile(r"[!-~]+")          # one run of printable ASCII, as the kernel takes a key
EPSILON = 1e-9                            # dollars: sums of spend, bounds and estimates compared with a cap


class Refused(RuntimeError):
    """The run can't start, or its cases or prompt can't be read; the message says why."""


# The cases

class Case(BaseModel):
    """One reply as the check reads it, and the answer it should get (see `soft_promise.yaml`)."""

    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]*$")
    group: str = Field(pattern=r"^[a-z][a-z_]*$")
    language: Literal["en", "es"]
    prose: str = Field(min_length=1)
    cards: list[str]
    expected: Literal["pass", "flag", "flag_ai", "code", "not_ai"]
    majority_required: bool = False
    next_steps: list[str] = Field(default_factory=list)
    approved_names: list[str] = Field(default_factory=list)
    note: str = ""

    @field_validator("next_steps")
    @classmethod
    def fixed_steps(cls, steps: list[str]) -> list[str]:
        if set(steps) - (set(NEXT_STEPS.values()) | set(BUSINESS_BLOCK_STEPS.values())):
            raise ValueError("next_steps contains a phrase outside the fixed mapping")
        return steps


def load_cases(path: Path) -> list[Case]:
    """The cases in `path`: a list under `cases`, beside nothing but the shared `cards`."""
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as error:
        raise Refused(f"{path.name} can't be read ({type(error).__name__})") from None
    if not isinstance(data, dict) or not isinstance(data.get("cases"), list) or set(data) - {"cards", "cases"}:
        raise Refused(f"{path.name} needs its cases listed under `cases`, beside nothing but `cards`")
    cases: list[Case] = []
    for number, entry in enumerate(data["cases"], start=1):
        try:
            case = Case.model_validate(entry)
        except ValidationError as error:
            first = error.errors()[0]
            where = ".".join(str(part) for part in first["loc"]) or "the case"
            raise Refused(f"{path.name}, case {number}: {where}: {first['msg']}") from None
        if any(case.id == earlier.id for earlier in cases):
            raise Refused(f"{path.name} names {case.id} twice")
        cases.append(case)
    if not cases:
        raise Refused(f"{path.name} holds no case")
    return cases


def code_blocked(case: Case) -> bool:
    """Whether the kernel's code check blocks the case's prose, so that in the kernel the model check
    never reads it: `reply_check.scan_prose`, offline, with the case's approved business names,
    no canary, no name of a Desk's own and no booking card."""
    return bool(reply_check.scan_prose(case.prose, approved_free_names=case.approved_names))


# The prompt

@dataclass(frozen=True)
class Prompt:
    text: str
    source: str               # "this tree", "<decisions.py> at <ref> (<commit>)" or "the file <name>"

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.text.encode()).hexdigest()


def load_prompt(root: Path, *, ref: str | None = None, file: Path | None = None) -> Prompt:
    """The system prompt to send: `file`'s text, `SOFT_PROMISE_SYSTEM` in decisions.py at `ref`
    (taken by `ast`, so nothing at the ref runs), or by default this tree's."""
    if ref is not None and file is not None:
        raise Refused("--prompt-ref and --prompt-file name the prompt one at a time")
    if file is not None:
        try:
            text = file.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError) as error:
            raise Refused(f"--prompt-file can't be read ({type(error).__name__})") from None
        if not text:
            raise Refused("--prompt-file is empty")
        return Prompt(text, f"the file {file.name}")
    if ref is None:
        return Prompt(decisions.SOFT_PROMISE_SYSTEM, "this tree")
    if ref.startswith("-"):
        raise Refused(f"--prompt-ref {ref} isn't a commit here")
    try:
        commit = results.git(root, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").strip()
        raw = results.show(root, commit, DECISIONS_PATH)
    except results.GitError:
        raise Refused(f"--prompt-ref {ref} isn't a commit here") from None
    if raw is None:
        raise Refused(f"{DECISIONS_PATH} isn't at {ref}")
    where = f"{DECISIONS_PATH} at {ref}"
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise Refused(f"{where} isn't UTF-8") from None
    return Prompt(prompt_in(source, where), f"{where} ({commit[:12]})")


def prompt_in(source: str, where: str) -> str:
    """`SOFT_PROMISE_SYSTEM`'s value in a decisions.py, a string literal (adjacent literals joined)."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        raise Refused(f"{where} doesn't parse as Python") from None
    for node in tree.body:
        if isinstance(node, ast.Assign):
            targets, value = node.targets, node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets, value = [node.target], node.value
        else:
            continue
        if not any(isinstance(target, ast.Name) and target.id == "SOFT_PROMISE_SYSTEM" for target in targets):
            continue
        try:
            text = ast.literal_eval(value)
        except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
            text = None
        if not isinstance(text, str):
            raise Refused(f"SOFT_PROMISE_SYSTEM in {where} isn't a string literal")
        if not text.strip():
            raise Refused(f"SOFT_PROMISE_SYSTEM in {where} is empty")
        return text
    raise Refused(f"{where} has no SOFT_PROMISE_SYSTEM")


# The calls

class _Messages:
    def __init__(self, messages: Any, system: str, request_hashes: frozenset[str] | None = None):
        self._messages, self._system = messages, system
        self._request_hashes = request_hashes
        self.diverged = False

    async def create(self, **request: Any) -> Any:
        wire = copy.deepcopy({**request, "system": self._system})
        actual = hashlib.sha256(json.dumps(wire, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if self._request_hashes is not None and actual not in self._request_hashes:
            self.diverged = True
            raise Refused("actual request differs from the recorded experiment hashes")
        return await self._messages.create(**wire)


class WithSystem:
    """The SDK client with a system prompt override, also used by the reviewer runner."""

    def __init__(self, client: Any, system: str, request_hashes: frozenset[str] | None = None):
        self.messages = _Messages(client.messages, system, request_hashes)


def anthropic_client(key: str) -> Any:
    """The SDK client, as the kernel builds its own: the key and the Claude API's host passed
    explicitly, so the SDK reads no other credential or host, and no retries."""
    return anthropic.AsyncAnthropic(api_key=key, base_url=decisions.ANTHROPIC_API_URL, max_retries=0)


def priced(usage: CallUsage | None) -> float | None:
    """A call's cost at its model's list prices, or None when it can't be priced: no usage, no
    tokens, or a model `PRICES` doesn't hold."""
    if usage is None:
        return None
    if not (usage.input_tokens or usage.cached_tokens or usage.cache_write_tokens or usage.output_tokens):
        return None
    try:
        # SDK output_tokens already includes thinking; never add thinking_tokens again.
        return cost_usd(usage.model_dump(), usage.model, "anthropic")
    except NoPrice:
        return None


class HistoricalHaikuSoftPromise(AnthropicDecisions):
    """Keep the measured Haiku arms reproducible after production moves to Sonnet."""

    async def soft_promise(self, data: BaseModel) -> tuple[SoftPromiseVerdict | None, CallUsage]:
        return await self._ask(
            SoftPromiseVerdict, data, model=HAIKU_MODEL, max_tokens=decisions.SOFT_PROMISE_MAX_TOKENS,
            system=decisions.SOFT_PROMISE_SYSTEM, schema=decisions.SOFT_PROMISE_SCHEMA,
            thinking={"type": "disabled"}, timeout_s=HAIKU_TIMEOUT_S, failed="soft_promise_failed")


class OldSoftPromiseInput(BaseModel):
    """The baseline wire shape, intentionally omitting next_steps."""
    language: Literal["en", "es"]
    prose: str
    cards: list[str]


class NextStepsSoftPromiseInput(OldSoftPromiseInput):
    """The historical next-steps request, before approved service names were included."""

    next_steps: list[str] = Field(default_factory=list)


InputShape = Literal["old", "new", "approved_names"]


def call_input(case: Case, shape: InputShape = "approved_names") -> SoftPromiseInput | OldSoftPromiseInput:
    """What the kernel's check reads for the case: its language, its prose as the scan reads it, and
    its cards' texts."""
    data = dict(language=case.language, prose=reply_check.shown(case.prose), cards=list(case.cards))
    if shape == "old":
        return OldSoftPromiseInput(**data)
    if shape == "new":
        return NextStepsSoftPromiseInput(**data, next_steps=list(case.next_steps))
    return SoftPromiseInput(**data, next_steps=list(case.next_steps), approved_names=list(case.approved_names))


def request_message(data: SoftPromiseInput | OldSoftPromiseInput) -> str:
    """The request's one message, as the kernel sends it: `data` as JSON with its keys sorted."""
    return json.dumps(data.model_dump(mode="json"), sort_keys=True, ensure_ascii=False)


def input_sha256(data: SoftPromiseInput | OldSoftPromiseInput) -> str:
    """The sha256 of the input a call sends: the request's one message, which holds the reply's
    language, its prose and its cards' texts."""
    return hashlib.sha256(request_message(data).encode()).hexdigest()


def call_bound(system: str, data: SoftPromiseInput | OldSoftPromiseInput, candidate: Candidate = "sonnet") -> float:
    """An upper bound on one call's cost, in dollars: at most one input token for every
    `CHARS_PER_TOKEN` characters of the system prompt and of the request's one message (`data` as
    the kernel sends it), plus `REQUEST_TOKENS`, all at the higher of the input and cache-write
    prices, and the most the check may answer, `SOFT_PROMISE_MAX_TOKENS` at the output price."""
    message = request_message(data)
    input_tokens = math.ceil((len(system) + len(message)) / CHARS_PER_TOKEN) + REQUEST_TOKENS
    rates = PRICES[candidate_model(candidate)]
    return (input_tokens * max(rates["input"], rates["cache_write"])
            + decisions.SOFT_PROMISE_MAX_TOKENS * rates["output"]) / 1_000_000


class SpendMeter:
    """Spend reservations and cap accounting, also used by the reviewer runner."""

    def __init__(self, cap: float):
        self.cap, self.spent, self.reserved, self.calls, self.estimated = cap, 0.0, 0.0, 0, 0
        self.estimated_usd = 0.0
        self.usage: list[CallUsage] = []

    def start(self, bound: float) -> bool:
        """Whether a call with this bound may start: the spend so far, the bounds of the calls in
        flight and its own must fit the cap. A worker turned away stops, and the last one only once
        no call is in flight and the cap leaves no room."""
        if self.spent + self.reserved + bound > self.cap + EPSILON:
            return False
        self.reserved += bound
        self.calls += 1
        return True

    def end(self, bound: float, usage: CallUsage | None) -> None:
        self.reserved -= bound
        if usage is not None:
            self.usage.append(usage)
        usd = priced(usage)
        if usd is None:
            usd, self.estimated = bound, self.estimated + 1
            self.estimated_usd += bound
        self.spent += usd

    @property
    def over(self) -> bool:
        """Whether the spend went past the cap: a call cost more than its bound."""
        return self.spent > self.cap + EPSILON


def verdict_name(verdict: SoftPromiseVerdict | None) -> str:
    if verdict is None:
        return "error"
    return {(False, False): "pass", (True, False): "flag", (False, True): "flag_ai",
            (True, True): "flag_both"}[(verdict.promises_beyond_cards, verdict.denies_being_ai)]


class CaseResult(BaseModel):
    """One case's answers over its samples."""

    model_config = ConfigDict(extra="forbid")
    id: str
    group: str
    language: str
    input_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")      # what the calls sent (`input_sha256`)
    expected: str
    majority_required: bool = False
    code_blocked: bool
    requested: int = Field(ge=1)                              # the samples the run asked for
    verdicts: dict[str, int] = Field(default_factory=lambda: dict.fromkeys(VERDICTS, 0))
    errors: dict[str, int] = Field(default_factory=dict)      # calls with no verdict, by status
    # A rescore's alone, never written: the saved answers are to another input than the case's now
    # (`changed`) or to one the run didn't record (`unrecorded`), so none of them is scored.
    stale: Literal["changed", "unrecorded"] | None = Field(None, exclude=True)

    @computed_field   # type: ignore[prop-decorator]
    @property
    def samples(self) -> int:
        """The samples taken: every call made for the case, an error included."""
        return sum(self.verdicts.values())

    @computed_field   # type: ignore[prop-decorator]
    @property
    def outcome(self) -> Literal["all", "some", "none", "incomplete", "not_run", "stale"]:
        """Whether the case met its expectation in all the samples asked for, some or none; a case
        with fewer samples than asked for is `incomplete`, and one with none `not_run`, whatever
        they answered. A `code` case meets it when the code check blocks it. In a rescore, a case
        whose saved answers aren't to its input now is `stale`, whatever it expects."""
        if self.stale is not None:
            return "stale"
        if self.expected == "code":
            return "all" if self.code_blocked else "none"
        if not self.samples:
            return "not_run"
        if self.samples < self.requested:
            return "incomplete"
        met = sum(count for verdict, count in self.verdicts.items() if verdict in MEETS[self.expected])
        return "all" if met == self.samples else "some" if met else "none"

    def count(self, verdict: SoftPromiseVerdict | None, usage: CallUsage | None) -> None:
        self.verdicts[verdict_name(verdict)] += 1
        if verdict is None:
            status = usage.status if usage is not None else "error"
            self.errors[status] = self.errors.get(status, 0) + 1


class PromptRecord(BaseModel):
    source: str
    sha256: str
    text: str


class RunResult(BaseModel):
    """A finished run, as its results file holds it, opening with what its fields are worth."""

    about: str = RESULTS_ABOUT
    label: str
    created_at: datetime
    git_sha: str | None
    prompt: PromptRecord
    model: str
    samples: int
    concurrency: int
    max_usd: float
    per_call_usd: float
    estimate_usd: float
    spend_usd: float
    calls: int
    estimated_calls: int        # calls with no usage to price, charged their bound
    stopped_by_cap: bool        # a call was turned away at the cap
    over_cap: bool              # the spend went past --max-usd: a call cost more than its bound
    spend_row: str
    cases: list[CaseResult]
    input_shape: InputShape = "old"
    call_usage: list[CallUsage] = Field(default_factory=list)


class Config(BaseModel):
    """What the command line asked for."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    samples: int = Field(ge=1)
    max_usd: float = Field(ge=0, allow_inf_nan=False)
    prompt_ref: str | None = None
    prompt_file: Path | None = None
    label: str | None = None
    concurrency: int = Field(4, ge=1)
    input_shape: InputShape = "approved_names"
    candidate: Candidate = "sonnet"


@dataclass
class Deps:
    """What a run reaches outside itself, so a test can stand in for any of it: `client` makes the SDK
    client from the key."""

    root: Path = REPO_ROOT
    client: Callable[[str], Any] = anthropic_client
    cases: Path = CASES_FILE
    spend_file: Path | None = None           # None: the shared one (`passes.shared_spend_file`)
    out_dir: Path = OUT_DIR
    now: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))


def default_label(config: Config) -> str:
    if config.prompt_file is not None:
        named = f"file-{config.prompt_file.stem}"
    elif config.prompt_ref is not None:
        named = f"ref-{config.prompt_ref}"
    else:
        return "tree"
    return re.sub(r"[^A-Za-z0-9._-]+", "-", named).strip("-.")[:64] or "prompt"


def api_key() -> str:
    """`ANTHROPIC_API_KEY` from the environment; each refusal names the variable, never its value."""
    key = os.environ.get("ANTHROPIC_API_KEY") or ""
    if not key:
        raise Refused("ANTHROPIC_API_KEY isn't set in the environment; the run calls the Claude API with it")
    if not API_KEY.fullmatch(key):
        raise Refused("ANTHROPIC_API_KEY must be one API key: printable ASCII with no spaces")
    return key


def month_guard(deps: Deps, spend_file: Path, estimate: float) -> None:
    """Refuses a run whose estimate would take this month's Claude API eval spend past the monthly
    limit less the demo reserve, as `passes._Pass._budget` does for a tier 2 pass."""
    try:
        limit, reserve = load_budget(deps.root)
    except PassRefused as refusal:
        raise Refused(str(refusal)) from None
    allowed = limit - reserve
    spent = sum(float(row.get("claude_api_usd") or 0) for row in month_rows(read_spend(spend_file), deps.now()))
    if spent + estimate > allowed + EPSILON:
        raise Refused(f"this run's ${estimate:.4f} of Claude API spend would take this month's eval spend past "
                      f"${allowed:.2f} (the ${limit:.0f} monthly limit less the ${reserve:.0f} demo reserve): "
                      f"${max(allowed - spent, 0):.4f} remains")


async def run(config: Config, deps: Deps, *, cases: tuple[Case, ...] | None = None,
              prompt: Prompt | None = None,
              request_hashes: frozenset[str] | None = None) -> tuple[RunResult, Path]:
    """Measure the check as the module docstring says; the run and where its results file is."""
    if cases is None:
        cases = tuple(load_cases(deps.cases))
    if prompt is None:
        prompt = load_prompt(deps.root, ref=config.prompt_ref, file=config.prompt_file)
    label = config.label or default_label(config)
    if not LABEL.fullmatch(label):
        raise Refused("--label is up to 64 letters, digits, '.', '_' and '-', starting with a letter or digit")
    planned = len(cases) * config.samples
    unit_estimate = per_call_usd(config.candidate)
    estimate = round(planned * unit_estimate, 6)
    if estimate > config.max_usd + EPSILON:
        raise Refused(f"the estimate ${estimate:.4f} for {planned} calls ({len(cases)} cases, {config.samples} "
                      f"samples each, at ${unit_estimate:.4f} a call) is over --max-usd ${config.max_usd:.4f}")
    spend_file = deps.spend_file or shared_spend_file(deps.root)
    month_guard(deps, spend_file, estimate)
    key = api_key()
    try:
        decisions.refuse_custom_headers()
    except RuntimeError as refusal:
        raise Refused(str(refusal)) from None

    now = deps.now()
    stamp = now.astimezone(UTC).strftime("%Y%m%d-%H%M%S")
    inputs = {case.id: call_input(case, config.input_shape) for case in cases}
    tallies = {case.id: CaseResult(id=case.id, group=case.group, language=case.language,
                                   input_sha256=input_sha256(inputs[case.id]), expected=case.expected,
                                   code_blocked=code_blocked(case), majority_required=case.majority_required,
                                   requested=config.samples) for case in cases}
    wire_client = WithSystem(deps.client(key), prompt.text, request_hashes)
    checker = (AnthropicDecisions if config.candidate == "sonnet" else HistoricalHaikuSoftPromise)(wire_client)
    meter = SpendMeter(config.max_usd)
    bounds = {case.id: call_bound(prompt.text, inputs[case.id], config.candidate) for case in cases}
    jobs = [case for _ in range(config.samples) for case in cases]   # every case's sample before the next
    position = 0

    async def worker() -> None:
        nonlocal position
        while position < len(jobs) and meter.start(bounds[jobs[position].id]):
            case, position = jobs[position], position + 1
            verdict, usage = None, None
            try:
                verdict, usage = await checker.soft_promise(inputs[case.id])
            finally:   # a call cut short is charged its bound
                meter.end(bounds[case.id], usage)
            if wire_client.messages.diverged:
                raise Refused("actual request differs from the recorded experiment hashes")
            tallies[case.id].count(verdict, usage)

    row_id = f"{CALIBRATION_PREFIX}soft-promise-{label}-{stamp}"
    try:
        await asyncio.gather(*(worker() for _ in range(config.concurrency)))
    finally:
        if meter.calls:
            usd = f"{meter.spent:.6f}"
            append_spend(spend_file, {
                "pass_id": row_id + ("-estimated" if meter.estimated else ""),
                "date": now.astimezone(UTC).date().isoformat(), "provider": "anthropic", "runs": meter.calls,
                "desk_usd": usd, "simulator_usd": f"{0:.6f}", "claude_api_usd": usd, "total_usd": usd,
                "estimated_usd": f"{meter.estimated_usd:.6f}",
            })
    try:
        git_sha: str | None = results.git(deps.root, "rev-parse", "--verify", "HEAD^{commit}").strip()
    except results.GitError:
        git_sha = None
    outcome = RunResult(
        label=label, created_at=now, git_sha=git_sha,
        prompt=PromptRecord(source=prompt.source, sha256=prompt.sha256, text=prompt.text),
        model=candidate_model(config.candidate), samples=config.samples, concurrency=config.concurrency,
        max_usd=config.max_usd, per_call_usd=unit_estimate, estimate_usd=estimate, spend_usd=round(meter.spent, 6),
        calls=meter.calls, estimated_calls=meter.estimated, stopped_by_cap=meter.calls < len(jobs),
        over_cap=meter.over, spend_row=row_id + ("-estimated" if meter.estimated else ""),
        cases=list(tallies.values()),
        input_shape=config.input_shape, call_usage=meter.usage,
    )
    deps.out_dir.mkdir(parents=True, exist_ok=True)
    path = deps.out_dir / f"{label}-{stamp}.json"
    number = 1
    while path.exists():
        number += 1
        path = deps.out_dir / f"{label}-{stamp}-{number}.json"
    path.write_text(outcome.model_dump_json(indent=1) + "\n", encoding="utf-8")
    return outcome, path


# The table

@dataclass(frozen=True)
class Row:
    label: str
    cases: int
    all: int
    some: int
    none: int
    incomplete: int            # fewer samples than asked for
    not_run: int
    stale: int                 # a rescore's: answers to another input than the case's now, never scored
    errors: int                # samples with no verdict


def table(case_results: Sequence[CaseResult]) -> list[Row]:
    """A row per group, in the order the groups first appear, with the cases the code check blocks on
    a row of their own after it; then the totals, the same way."""

    def row(label: str, members: list[CaseResult]) -> Row:
        outcomes = Counter(member.outcome for member in members)
        return Row(label, len(members), outcomes["all"], outcomes["some"], outcomes["none"], outcomes["incomplete"],
                   outcomes["not_run"], outcomes["stale"], sum(member.verdicts.get("error", 0) for member in members))

    rows = []
    for group in [*dict.fromkeys(result.group for result in case_results), None]:
        for blocked in (False, True):
            members = [result for result in case_results
                       if (group is None or result.group == group) and result.code_blocked is blocked]
            if members:
                rows.append(row((group or "total") + (", code-blocked" if blocked else ""), members))
    return rows


def render(rows: Sequence[Row], *, samples: int, rescored: bool = False) -> list[str]:
    """The table; a rescore's has a column for its stale cases."""
    width = max(len("group"), *(len(row.label) for row in rows))
    stale = ", or whose input changed since the run or went unrecorded (stale, never scored)" if rescored else ""
    return [
        f"Each group's cases that met their expectation in all {samples} samples, in some and in none, and "
        f"those with fewer samples (incomplete) or none (not run){stale}; the code check blocks the code-blocked "
        "ones before the model reads them:",
        f"{'group':<{width}}  cases  all  some  none  incomplete  not run  {'stale  ' if rescored else ''}errors",
        *(f"{row.label:<{width}}  {row.cases:>5}  {row.all:>3}  {row.some:>4}  {row.none:>4}  {row.incomplete:>10}  "
          f"{row.not_run:>7}  {f'{row.stale:>5}  ' if rescored else ''}{row.errors:>6}" for row in rows),
    ]


STALE = {"changed": "stale, its input has changed since the run, so its answers aren't scored",
         "unrecorded": "stale, the run recorded no input for it, so its answers aren't scored"}


def scored(case_results: Sequence[CaseResult], *, samples: int, rescored: bool = False) -> list[str]:
    """The table, then each case not met in every sample asked for, with its answers."""
    lines = render(table(case_results), samples=samples, rescored=rescored)
    missed = [result for result in case_results if result.outcome != "all"]
    if missed:
        lines += ["", "Cases not met in every sample asked for:"]
        for result in missed:
            counts = ", ".join(f"{verdict} {count}" for verdict, count in result.verdicts.items() if count)
            answers = STALE[result.stale] if result.stale else f"{counts or 'not run'} of {result.requested} samples"
            lines.append(f"  {result.id} ({result.group}, expected {result.expected}"
                         f"{', code-blocked' if result.code_blocked else ''}): {answers}")
    return lines


def report(outcome: RunResult, path: Path) -> list[str]:
    planned = len(outcome.cases) * outcome.samples
    lines = [
        f"soft-promise: {outcome.calls} calls to {outcome.model}, {outcome.samples} samples of {len(outcome.cases)} "
        f"cases, with the prompt in {outcome.prompt.source} (sha256 {outcome.prompt.sha256[:12]})",
        f"spend: ${outcome.spend_usd:.4f}" + (f", {outcome.estimated_calls} calls charged their bound"
                                              if outcome.estimated_calls else "") + f"; spend row {outcome.spend_row}",
    ]
    if outcome.stopped_by_cap:
        lines.append(f"stopped at the cap: no call starts past --max-usd ${outcome.max_usd:.4f}; {outcome.calls} of "
                     f"{planned} calls made")
    if outcome.over_cap:
        lines.append(f"over the cap: spent ${outcome.spend_usd:.4f}, past --max-usd ${outcome.max_usd:.4f}, since a "
                     "call cost more than its bound")
    lines += ["", *scored(outcome.cases, samples=outcome.samples), "", f"results: {path}"]
    return lines


# Rescoring saved answers

class _SavedCase(BaseModel):
    """A case's answers as a results file holds them, and the input they answered (None when the run
    didn't record it); what else it says, its expectation and whether the code check blocked it then
    included, is computed again."""

    model_config = ConfigDict(extra="ignore")
    id: str
    input_sha256: str | None = None
    verdicts: dict[Literal["pass", "flag", "flag_ai", "flag_both", "error"], Annotated[int, Field(ge=0)]]
    errors: dict[str, Annotated[int, Field(ge=0)]] = Field(default_factory=dict)


class _SavedRun(BaseModel):
    model_config = ConfigDict(extra="ignore")
    model: str
    samples: int = Field(ge=1)
    calls: int = Field(ge=0)
    prompt: PromptRecord
    cases: list[_SavedCase]
    input_shape: InputShape = "old"


def rescore(saved: Path, cases_file: Path) -> list[str]:
    """The answers in `saved`, a run's results file, scored against the cases in `cases_file` as it
    is now: each case's expectation and whether the code check blocks it come from the case file and
    this tree, the samples asked for from the run, and a case the run never asked about is not run.
    A case whose saved answers are to another input than the one it sends now, or to one the run
    didn't record, is stale: none of its answers is scored. No model is called and nothing is
    written."""
    try:
        run_ = _SavedRun.model_validate_json(saved.read_bytes())
    except (OSError, ValidationError):
        raise Refused(f"{saved.name} isn't a soft-promise run's results file") from None
    answered = {case.id: case for case in run_.cases}
    if len(answered) < len(run_.cases) or any(sum(case.verdicts.values()) > run_.samples for case in run_.cases):
        raise Refused(f"{saved.name} isn't a soft-promise run's results file: a case is there twice or has more "
                      f"than its {run_.samples} samples")
    cases = load_cases(cases_file)
    case_results = []
    for case in cases:
        result = CaseResult(id=case.id, group=case.group, language=case.language,
                            input_sha256=input_sha256(call_input(case, run_.input_shape)), expected=case.expected,
                            code_blocked=code_blocked(case), majority_required=case.majority_required,
                            requested=run_.samples)
        if (answers := answered.get(case.id)) is not None:
            if answers.input_sha256 != result.input_sha256:
                result.stale = "unrecorded" if answers.input_sha256 is None else "changed"
            else:
                result.verdicts = {verdict: answers.verdicts.get(verdict, 0) for verdict in VERDICTS}
                result.errors = dict(answers.errors)
        case_results.append(result)
    gone = [case_id for case_id in answered if case_id not in {case.id for case in cases}]
    lines = [f"soft-promise rescore: the answers in {saved.name} ({run_.calls} calls to {run_.model}, {run_.samples} "
             f"samples of each case, with the prompt in {run_.prompt.source}, sha256 {run_.prompt.sha256[:12]}) "
             f"against {cases_file.name} as it is now; no model called", "",
             *scored(case_results, samples=run_.samples, rescored=True)]
    if gone:
        lines += ["", f"saved answers for cases the case file no longer holds: {', '.join(gone)}"]
    return lines


# The command line

def main(argv: Sequence[str] | None = None, deps: Deps | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m evals.calibration.soft_promise", allow_abbrev=False,
        description="Send every soft-promise case N times to the kernel's check on the real model (this spends "
                    "money) and count its answers.")
    parser.add_argument("--samples", type=int, help="calls per case")
    parser.add_argument("--max-usd", type=float,
                        help="the most the run may spend, in US dollars; it refuses an estimate over it")
    prompt = parser.add_mutually_exclusive_group()
    prompt.add_argument("--prompt-ref", help="take SOFT_PROMISE_SYSTEM from decisions.py at this git ref")
    prompt.add_argument("--prompt-file", type=Path, help="send this file's text as the system prompt")
    parser.add_argument("--label", help="names the results file and the spend row")
    parser.add_argument("--concurrency", type=int, help="calls at a time (4)")
    parser.add_argument("--rescore", type=Path, metavar="RESULTS",
                        help="score the answers in a run's results file against the case file as it is now, "
                             "with no model call, and print the table; it takes no other option")
    options = parser.parse_args(argv)
    deps = deps or Deps()
    run_options = (options.samples, options.max_usd, options.prompt_ref, options.prompt_file, options.label,
                   options.concurrency)
    if options.rescore is not None:
        if any(option is not None for option in run_options):
            parser.error("--rescore reads saved answers and takes no other option")
        try:
            print("\n".join(rescore(options.rescore, deps.cases)))
        except Refused as refusal:
            print(f"soft-promise: {refusal}", file=sys.stderr)
            return 1
        return 0
    missing = [name for name, value in (("--samples", options.samples), ("--max-usd", options.max_usd))
               if value is None]
    if missing:
        parser.error(f"the following arguments are required: {', '.join(missing)}")
    try:
        config = Config(samples=options.samples, max_usd=options.max_usd, prompt_ref=options.prompt_ref,
                        prompt_file=options.prompt_file, label=options.label,
                        concurrency=4 if options.concurrency is None else options.concurrency)
    except ValidationError as error:
        first = error.errors()[0]
        parser.error(f"--{str(first['loc'][0]).replace('_', '-')}: {first['msg']}")
    try:
        outcome, path = asyncio.run(run(config, deps))
    except Refused as refusal:
        print(f"soft-promise: {refusal}", file=sys.stderr)
        return 1
    print("\n".join(report(outcome, path)))
    return 1 if outcome.stopped_by_cap or outcome.over_cap else 0


if __name__ == "__main__":
    sys.exit(main())
