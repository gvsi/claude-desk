"""Tier 1's plan gating and summary.

Every case names the plans it needs with `@pytest.mark.requires(...)`; an unmarked case or an
unknown plan id is a collection error. A case runs or skips by target and by `landed.toml`
(`harness.skip_reason`), and those are the only skips tier 1 allows. A plan whose code is on the
branch but whose id `landed.toml` leaves out (`harness.unlisted_landed`) is named at collection
and listed under `unlisted` in the summary: on the gate (`CI` set, as on every run on `main`, on
a pull request to it and on a manual workflow run on any branch, or `--strict-landed`) it fails
the run and counts as failed, since its cases would otherwise all skip as pending with the gate
off; off the gate (a task of a kernel plan on its `plan/<id>` branch, whose last task adds the
id) it is a warning, and the cases skip as pending on the kernel and API targets. Each run
writes `evals/out/tier1-summary.json`; on the stub, passing cases count as contract-checked,
never as passes.

Tier 1 makes no model calls: before any case imports a client, the process drops every inherited
`ANTHROPIC_*` setting and holds only a dummy key, and it takes nothing from the repository's
`.env` but the database URLs. For the whole run `ANTHROPIC_BASE_URL` points at a fake model
server that scripts nothing, so a client made outside a target fails the run instead of calling out.

The fixtures a case uses: `k`, what it calls (the contract stub on `--target stub`, else a fresh
`KernelTarget` on the travelling clock, started on emptied kernel and API tables); `fake`, the model server `k` calls (on the stub, one no
call ever reaches); `records`, what `k` left in the database (on the stub, none); `api`, the API
over `k` (Plan 02a's `make_api_target`), for the cases that require 02a or 02.
"""

import functools
import ipaddress
import json
import os
import socket
import warnings
from collections import Counter
from collections.abc import AsyncIterator, Callable, Iterator, Mapping
from pathlib import Path
from typing import Any

import psycopg
import pytest

from desk.db.session import database_url, libpq_url
from desk.db.tables import APP_TABLES, KERNEL_TABLES
from evals.fakes import FakeAnthropic
from evals.records import NoRecords, Records
from evals.tier1.harness import (
    PLANS,
    SUMMARY_FILE,
    TIER1_DIR,
    KernelHarness,
    load_landed,
    skip_reason,
    unlisted_landed,
    unlisted_sentence,
    unlisted_warning,
)
from evals.tier1.stub import ContractStub
from evals.tier1.targets import (
    DUMMY_KEY,
    ApiTarget,
    KernelTarget,
    TargetError,
    load_api_target,
    refuse_real_models,
)

REPO_ROOT = TIER1_DIR.parents[1]
SKIP_RULE = "tier 1 skips a case only when a plan it requires hasn't landed, or it needs the API or kernel code"


def tier1_environment(env_file: Path) -> None:
    """Hold only the dummy model key, and load only `*_DATABASE_URL` from `env_file`; the
    environment's own values win, and nothing read is ever printed."""
    for name in [name for name in os.environ if name.startswith("ANTHROPIC_")]:
        del os.environ[name]
    os.environ["ANTHROPIC_API_KEY"] = DUMMY_KEY
    if not env_file.is_file():
        return
    for line in env_file.read_text().splitlines():
        name, sep, value = line.strip().partition("=")
        name = name.strip()
        if sep and not name.startswith("#") and name.endswith("_DATABASE_URL"):
            os.environ.setdefault(name, value.strip().strip("'\""))


tier1_environment(REPO_ROOT / ".env")
refuse_real_models()

LOOPBACK = frozenset({ipaddress.ip_address("127.0.0.1"), ipaddress.ip_address("::1")})


class OffLoopbackConnection(ConnectionRefusedError):
    """Tier 1 connected somewhere other than this machine's loopback address."""


def _loopback_only(connect: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(connect)
    def guarded(sock: socket.socket, address: Any) -> Any:
        if sock.family != socket.AF_UNIX:
            host = address[0] if isinstance(address, tuple) and address else address
            try:
                local = ipaddress.ip_address(host) in LOOPBACK
            except ValueError:
                local = False   # a host name, even "localhost", is refused: only the two literals pass
            if not local:
                raise OffLoopbackConnection(f"tier 1 refuses connections off loopback ({host!r})")
        return connect(sock, address)

    return guarded


@pytest.fixture(autouse=True, scope="session")
def loopback_only() -> Iterator[None]:
    """Every socket connection goes to 127.0.0.1 or ::1, or fails."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(socket.socket, "connect", _loopback_only(socket.socket.connect))
        patch.setattr(socket.socket, "connect_ex", _loopback_only(socket.socket.connect_ex))
        yield


@pytest.fixture(autouse=True, scope="session")
def unscripted_model_server(loopback_only: None) -> Iterator[FakeAnthropic]:
    """`ANTHROPIC_BASE_URL` for the whole run: a fake model server with no script, so any client
    made outside a target gets a 500, and the run fails at the end if one called it."""
    fake = FakeAnthropic().start()
    try:
        with pytest.MonkeyPatch.context() as patch:
            patch.setenv("ANTHROPIC_BASE_URL", fake.url)
            yield fake
    finally:
        fake.stop()
    fake.check()


def empty_database() -> None:
    """Empty every kernel and API table, as desk_admin (the kernel's role may not truncate the
    ledger), so a case finds only what it makes. A kernel's startup looks at every copy in the
    database (`rebuild_at_startup`), so copies left by earlier cases made each start slower than
    the last."""
    tables = [*(f"kernel.{table}" for table in KERNEL_TABLES), *(f"app.{table}" for table in APP_TABLES)]
    with psycopg.connect(libpq_url(database_url("ADMIN")), autocommit=True) as admin:
        admin.execute("TRUNCATE " + ", ".join(tables))


@pytest.fixture
async def k(request: pytest.FixtureRequest) -> AsyncIterator[KernelHarness]:
    """What the case calls: the contract stub, or a fresh real kernel in-process on an empty database."""
    if request.config.getoption("--target") == "stub":
        yield ContractStub()
        return
    empty_database()
    target = await KernelTarget(models="fake", allow_bounded=request.config.getoption("--allow-bounded")).start()
    try:
        yield target
    finally:
        await target.stop()


@pytest.fixture
def fake(k: KernelHarness) -> FakeAnthropic:
    """The model server `k` calls. The stub makes no model calls, so its scripts are never used."""
    return k.fake if isinstance(k, KernelTarget) else FakeAnthropic()


@pytest.fixture
def records(k: KernelHarness) -> Records | NoRecords:
    """What `k` left in the database, read as the API's role; the stub leaves nothing to read."""
    return k.records if isinstance(k, KernelTarget) else NoRecords()


@pytest.fixture
async def api(k: KernelHarness) -> AsyncIterator[ApiTarget]:
    """The API over `k`: Plan 02a's `make_api_target(k, models="fake")`, started for the case and
    stopped after it, so its model calls go to `fake` too. Only cases requiring 02a or 02 use it,
    and those run only on `--target api`; without `api_impl.py` it fails the case, never skips it."""
    if not isinstance(k, KernelTarget):
        raise TargetError("the API runs over the real kernel: API cases run on --target api")
    target = load_api_target()(k, models="fake")
    await target.start()
    try:
        yield target
    finally:
        await target.stop()


def strict_landed(config: pytest.Config, environ: Mapping[str, str] = os.environ) -> bool:
    """Whether a plan's code on the branch without its id fails the run instead of warning: on the
    gate, which is any run with `CI` set or a run given `--strict-landed`. GitHub Actions sets `CI`
    and runs CI on `main`, on pull requests to it (so a plan's PR can't merge in that state) and on
    a manual workflow run, which is strict on whatever branch it runs."""
    return bool(config.getoption("--strict-landed")) or environ.get("CI", "") != ""


class Tier1:
    """The plugin: gates cases by plan and target, and counts what happened to each."""

    def __init__(self, config: pytest.Config):
        self.config = config
        self.target: str = config.getoption("--target")
        self.strict = strict_landed(config)
        self.landed: tuple[str, ...] | None = None   # None until landed.toml has loaded
        self.unlisted: list[str] = []        # plans with code on the branch but no id in landed.toml
        self.gate_failures = 0               # unlisted plans that failed the gate run at collection
        self.skips: dict[str, str] = {}      # nodeid → the tier 1 skip reason it was given
        self.outcomes: dict[str, str] = {}   # nodeid → "passed", "failed" or its skip reason
        self.collect_errors = 0

    def in_tier1(self, nodeid: str) -> bool:
        return (self.config.rootpath / nodeid.split("::")[0]).resolve().is_relative_to(TIER1_DIR)

    def pytest_collection_modifyitems(self, items: list[pytest.Item]) -> None:
        try:
            self.landed = load_landed()
        except ValueError as error:
            raise pytest.UsageError(str(error)) from None
        if unlisted := unlisted_landed(self.landed):
            # The plan's cases all skip as pending with its gate off: on the gate nobody would be
            # told, so the run fails, and its summary still names the plans and counts them as
            # failed; on the plan's own branch that is the state of every task before the last, so
            # the run says so and goes on.
            self.unlisted = unlisted
            if self.strict:
                self.gate_failures = len(unlisted)
                raise pytest.UsageError(unlisted_sentence(unlisted))
            warnings.warn(unlisted_warning(unlisted))
        kept = []
        for item in items:
            if not self.in_tier1(item.nodeid):
                kept.append(item)
                continue
            if error := _plan_error(item):
                self.config.hook.pytest_collectreport(report=pytest.CollectReport(item.nodeid, "failed", error, []))
                continue
            plans = {plan for mark in item.iter_markers("requires") for plan in mark.args}
            white_box = item.get_closest_marker("white_box") is not None
            if reason := skip_reason(self.target, plans, white_box, self.landed):
                item.add_marker(pytest.mark.skip(reason=reason))
                self.skips[item.nodeid] = reason
            kept.append(item)
        items[:] = kept

    @pytest.hookimpl(wrapper=True)
    def pytest_runtest_makereport(self, item: pytest.Item, call: pytest.CallInfo) -> pytest.TestReport:
        """A skip or expected failure tier 1 didn't give is a failure: a miss is fixed, not skipped."""
        report = yield
        if report.skipped and self.in_tier1(item.nodeid) and item.nodeid not in self.skips:
            reason = getattr(report, "wasxfail", "") or _skip_reason(report)
            report.outcome = "failed"
            report.longrepr = f"{SKIP_RULE}; this case skipped itself: {reason or 'xfail'}"
            if hasattr(report, "wasxfail"):
                del report.wasxfail
        return report

    @pytest.hookimpl(tryfirst=True)   # before the session and the terminal count the report
    def pytest_collectreport(self, report: pytest.CollectReport) -> None:
        """A tier 1 module or package that skips itself (`pytest.skip(allow_module_level=True)`,
        `pytest.importorskip`) drops its cases unseen, so it is a collection error."""
        if not self.in_tier1(report.nodeid):
            return
        if report.skipped:
            report.outcome = "failed"
            report.longrepr = f"{SKIP_RULE}; {report.nodeid} skipped itself: {_skip_reason(report)}"
        if report.failed:
            self.collect_errors += 1

    def pytest_runtest_logreport(self, report: pytest.TestReport) -> None:
        if not self.in_tier1(report.nodeid):
            return
        if report.failed:
            self.outcomes[report.nodeid] = "failed"
        elif self.outcomes.get(report.nodeid) == "failed":
            pass
        elif report.skipped:
            self.outcomes[report.nodeid] = self.skips.get(report.nodeid, "failed")
        elif report.when == "call":
            self.outcomes[report.nodeid] = "passed"

    def summary(self) -> dict:
        counts = Counter(self.outcomes.values())
        pending = {reason.removeprefix("pending "): n for reason, n in counts.items() if reason.startswith("pending ")}
        stub = self.target == "stub"
        return {
            "target": self.target,
            "landed": list(self.landed or ()),
            "unlisted": list(self.unlisted),
            "passed": 0 if stub else counts["passed"],
            "contract_checked": counts["passed"] if stub else 0,
            "failed": counts["failed"] + self.collect_errors + self.gate_failures,
            "pending": {plan: pending[plan] for plan in PLANS if plan in pending},
            "needs_api": counts["needs api"],
            "needs_kernel_code": counts["needs kernel code"],
        }

    def pytest_sessionfinish(self, session: pytest.Session) -> None:
        if session.config.option.collectonly or self.landed is None:
            return
        SUMMARY_FILE.parent.mkdir(exist_ok=True)
        SUMMARY_FILE.write_text(json.dumps(self.summary(), indent=2) + "\n")

    def pytest_terminal_summary(self, terminalreporter: pytest.TerminalReporter) -> None:
        if self.landed is None:
            return
        summary = self.summary()
        if self.target == "stub":
            line = f"tier 1 on stub: {summary['contract_checked']} contract-checked (not passes)"
        else:
            line = f"tier 1 on {self.target}: {summary['passed']} passed"
        line += f", {summary['failed']} failed"
        if summary["pending"]:
            line += "; pending " + ", ".join(f"{plan} {n}" for plan, n in summary["pending"].items())
        for key, label in (("needs_api", "needs api"), ("needs_kernel_code", "needs kernel code")):
            if summary[key]:
                line += f"; {label} {summary[key]}"
        line += "; landed: " + ", ".join(summary["landed"])
        if summary["unlisted"]:
            line += "; unlisted: " + ", ".join(summary["unlisted"])
        terminalreporter.write_line(line)


def _skip_reason(report: pytest.TestReport | pytest.CollectReport) -> str:
    return report.longrepr[2] if isinstance(report.longrepr, tuple) else ""


def _plan_error(item: pytest.Item) -> str | None:
    marks = list(item.iter_markers("requires"))
    if not any(mark.args for mark in marks):
        return f"{item.nodeid}: every tier 1 case names the plans it needs with @pytest.mark.requires(...)"
    if unknown := [plan for mark in marks for plan in mark.args if plan not in PLANS]:
        return f"{item.nodeid}: requires names unknown plans {unknown}; the plans are {list(PLANS)}"
    return None


def pytest_configure(config: pytest.Config) -> None:
    config.pluginmanager.register(Tier1(config), "tier1")
