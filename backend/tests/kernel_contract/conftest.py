"""Fixtures for the kernel contract suite: the same tests against FakeKernel and the real kernel.

`kernel` yields `(KernelHttp, ro_schema, state)`:

- `fake`: FakeKernel in this process (httpx's `ASGITransport`), its rows mirrored into schema
  `fake_kernel_ro`, and its `FakeKernelState`;
- `real` (marker `real_kernel`): the kernel process at `DESK_KERNEL_URL`, which the API reads through
  `kernel_ro`, and None. It skips unless `DESK_KERNEL_PLANS` lists the plan the test names with
  `@pytest.mark.kernel_plan(...)`; every test that uses `kernel` names one.

Tests read their arguments (prices, slots, Desks) from `ro_schema` as `desk_api`, with the copy set the
way the API sets it, so the fake's mirror is checked by the same reads. `arrange` puts a session in a
state the HTTP API can't reach on demand (closed, paused, an execution in doubt): through the fake's knobs,
or for the real kernel as `desk_admin` on its tables, which only tests may do, or through the owner's own
kernel calls.
"""

import os
from collections.abc import AsyncIterator, Callable, Iterator
from datetime import UTC, datetime, timedelta

import httpx
import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine
from sqlalchemy.pool import NullPool

from desk.api.kernel_client import CredentialView, KernelHttp
from desk.db.session import API_CONNECT_OPTIONS, database_url, libpq_url
from desk.contracts import Claim, CopyCreated, Decision, RuleCard
from desk.kernel_api import ExecuteRequest, ModeRequest, PolicyConfirmRequest, PolicyDraftRequest
from tests.kernel_contract.fake_kernel import IDLE_LIMIT, FakeKernelState, fake_kernel_app
from tests.kernel_contract.ro_tables import FAKE_RO_SCHEMA, FakeRO, create_fake_ro

REAL_RO_SCHEMA = "kernel_ro"
IDLE_CLOSE = IDLE_LIMIT + timedelta(seconds=1)   # a visitor session idle this long is closed


def _connect(prefix: str) -> psycopg.Connection:
    return psycopg.connect(libpq_url(database_url(prefix)), autocommit=True)


@pytest.fixture(scope="session")
def admin() -> Iterator[psycopg.Connection]:
    """desk_admin: builds fake_kernel_ro, writes the fake's rows and arranges the real kernel's tables."""
    with _connect("ADMIN") as conn:
        yield conn


@pytest.fixture(scope="session")
def fake_ro(admin: psycopg.Connection) -> FakeRO:
    return create_fake_ro(admin)


@pytest.fixture(scope="session")
def api_conn() -> Iterator[psycopg.Connection]:
    with _connect("API") as conn:
        conn.row_factory = dict_row
        yield conn


@pytest.fixture
async def api_ro_conn() -> AsyncIterator[AsyncConnection]:
    """One connection as desk_api with the API process's engine settings, for reads through `desk.api.ro.KernelRO`
    made as the API makes them."""
    engine = create_async_engine(database_url("API"), connect_args={"options": API_CONNECT_OPTIONS}, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            yield conn
    finally:
        await engine.dispose()


@pytest.fixture
def ro_read(api_conn: psycopg.Connection) -> Callable[..., list[dict]]:
    """`read(ro_schema, copy_id, query, params)`: rows as desk_api, with `{ro}` in the query naming the schema."""

    def read(ro_schema: str, copy_id: str, query: str, params: tuple = ()) -> list[dict]:
        if ro_schema not in (FAKE_RO_SCHEMA, REAL_RO_SCHEMA):
            raise ValueError(f"not a kernel_ro schema: {ro_schema!r}")
        with api_conn.transaction():
            api_conn.execute("SELECT set_config('desk.copy_id', %s, true)", (copy_id,))
            return api_conn.execute(query.format(ro=ro_schema), params).fetchall()

    return read


def _named_plan(request: pytest.FixtureRequest) -> str:
    marker = request.node.get_closest_marker("kernel_plan")
    if marker is None or len(marker.args) != 1:
        pytest.fail("a contract test names the kernel plan that serves its routes: @pytest.mark.kernel_plan(\"01a\")")
    return marker.args[0]


@pytest.fixture(params=["fake", pytest.param("real", marks=pytest.mark.real_kernel)])
async def kernel(request: pytest.FixtureRequest, fake_ro: FakeRO) -> AsyncIterator[tuple]:
    plan = _named_plan(request)
    if request.param == "fake":
        state = FakeKernelState(ro=fake_ro)
        http = KernelHttp("http://fake-kernel", transport=httpx.ASGITransport(app=fake_kernel_app(state)))
        ro_schema = FAKE_RO_SCHEMA
    else:
        url = os.environ.get("DESK_KERNEL_URL")
        if not url:
            pytest.skip("DESK_KERNEL_URL is not set")
        landed = {name.strip() for name in os.environ.get("DESK_KERNEL_PLANS", "").split(",") if name.strip()}
        if plan not in landed:
            pytest.skip(f"kernel plan {plan} is not in DESK_KERNEL_PLANS")
        state, http, ro_schema = None, KernelHttp(url), REAL_RO_SCHEMA
    try:
        yield http, ro_schema, state
    finally:
        await http.aclose()


class Arrange:
    """Session states the contract needs that a test can't reach through the kernel's HTTP API alone."""

    def __init__(self, state: FakeKernelState | None, admin: psycopg.Connection):
        self._state, self._admin = state, admin

    async def take_over(self, owner: CredentialView, session_id: str, generation: int) -> None:
        """Mode `owner` (generation + 1), as the owner's take-over sets it."""
        if self._state is not None:
            self._state.set_mode(session_id, "owner")
        else:
            await owner.call("POST /sessions/{id}/mode", ModeRequest(mode="owner", generation=generation),
                             path={"id": session_id})

    def pause(self, session_id: str) -> None:
        """Mode `paused`, as the breaker's third strike sets it (generation unchanged)."""
        if self._state is not None:
            self._state.set_mode(session_id, "paused")
        else:
            self._admin.execute("UPDATE kernel.sessions SET mode = 'paused', strikes = 3 WHERE session_id = %s",
                                (session_id,))

    def stored_policy(self, copy: CopyCreated, key: str, text: str, *,
                      readers: tuple[str, ...] = ("public",), expired: bool = False) -> None:
        """Historical policy rows that current write guards would refuse, with optional read filtering."""
        desk_id, fact_id = copy.desk_ids[0], f"charter:policy:{key}"
        claims = [Claim(key=f"policy:{key}", kind="text", value=text)]
        expires_at = datetime(2000, 1, 1, tzinfo=UTC) if expired else None
        if self._state is not None:
            desk = self._state.desks[desk_id]
            fact = desk.facts[fact_id]
            self._state._put_fact(desk, fact.model_copy(update={
                "claims": claims, "label": fact.label.model_copy(update={"readers": list(readers)}),
                "expires_at": expires_at}))
            self._state.flush()
        else:
            self._admin.execute("UPDATE kernel.facts SET claims = %s, readers = %s, expires_at = %s"
                                " WHERE copy_id = %s AND desk_id = %s AND fact_id = %s",
                                (Jsonb([claim.model_dump(mode="json") for claim in claims]), Jsonb(list(readers)),
                                 expires_at, copy.copy_id, desk_id, fact_id))

    def expire_mandate(self, mandate_id: str) -> None:
        """Simulate reaching the stored mandate's expiry without expiring the decision or agent turn."""
        if self._state is not None:
            record = self._state.mandates[mandate_id]
            record.mandate = record.mandate.model_copy(update={
                "expires_at": (self._state.now - timedelta(seconds=1)).isoformat()})
        else:
            self._admin.execute("UPDATE kernel.mandates SET expires_at = %s WHERE mandate_id = %s",
                                (datetime.now(UTC) - timedelta(seconds=1), mandate_id))

    async def never(self, owner: CredentialView, ro_read: Callable[..., list[dict]], ro_schema: str, copy: CopyCreated,
                    tool: str) -> None:
        """The owner's rules change: a `never` card for `tool` is confirmed on the copy's first Desk. The real kernel
        gets it the way the owner does, drafted on the active version's cards, proved and confirmed; it skips when
        the kernel can't prove drafts (bounded mode activates no owner draft)."""
        desk_id = copy.desk_ids[0]
        if self._state is not None:
            self._state.never(desk_id, tool)
            return
        (active,) = ro_read(ro_schema, copy.copy_id, "SELECT version, cards FROM {ro}.policy_versions"
                                                     " WHERE desk_id = %s AND status = 'active'", (desk_id,))
        cards = [RuleCard.model_validate(card) for card in active["cards"]]
        cards = [card for card in cards if not card.is_default] + [RuleCard(
            card_id=f"never-{tool}", applies_to=tool, mode="never", who="anyone", reason="You said never for this.")]
        draft = await owner.call("POST /policy/draft", PolicyDraftRequest(desk_id=desk_id, cards=cards,
                                                                          expected_parent=active["version"]))
        if draft.status != "proved":
            pytest.skip(f"the kernel didn't prove the draft ({draft.status})")
        await owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=desk_id, version=draft.version))

    async def ask(self, owner: CredentialView, ro_read: Callable[..., list[dict]], ro_schema: str, copy: CopyCreated,
                  tool: str) -> None:
        """The owner's rules change: `tool` asks the owner (an `ask` card for anyone, in place of the cards that
        covered it) on the copy's first Desk, so its calls hold through an ask card. The fake stands for it with a
        scripted hold (`state.script`); the real kernel gets the card drafted, proved and confirmed as `never` does,
        and skips when the kernel can't prove drafts."""
        desk_id = copy.desk_ids[0]
        if self._state is not None:
            self._state.script(tool, "hold")
            return
        (active,) = ro_read(ro_schema, copy.copy_id, "SELECT version, cards FROM {ro}.policy_versions"
                                                     " WHERE desk_id = %s AND status = 'active'", (desk_id,))
        cards = [RuleCard.model_validate(card) for card in active["cards"]]
        cards = [card for card in cards if not card.is_default and card.applies_to != tool] + [RuleCard(
            card_id=f"ask-{tool}", applies_to=tool, mode="ask", who="anyone", reason="Ask me first.")]
        draft = await owner.call("POST /policy/draft", PolicyDraftRequest(desk_id=desk_id, cards=cards,
                                                                          expected_parent=active["version"]))
        if draft.status != "proved":
            pytest.skip(f"the kernel didn't prove the draft ({draft.status})")
        await owner.call("POST /policy/confirm", PolicyConfirmRequest(desk_id=desk_id, version=draft.version))

    async def execution_in_doubt(self, view: CredentialView, decision: Decision) -> None:
        """The allow's execution has begun and its outcome isn't known: on the fake it ran and ended `unknown` (left
        to reconcile); on the real kernel its `intent` row is in place, as while it runs (reconciliation leaves an
        intent alone for its first 30 s). The row's `started_at` is the host's clock, the one the kernel judges an
        orphan by, never Postgres' `now()`, which can lag the host (a container's clock after the host slept)."""
        if self._state is not None:
            self._state.script(decision.action.tool, exec_state="unknown")
            await view.call("POST /execute", ExecuteRequest(decision_id=decision.decision_id,
                                                            session_id=decision.session_id, generation=0))
        else:
            self._admin.execute("INSERT INTO kernel.executions (action_id, copy_id, decision_id, state, started_at)"
                                " VALUES (%s, %s, %s, 'intent', %s)",
                                (decision.action.action_id, decision.action.copy_id, decision.decision_id,
                                 datetime.now(UTC)))

    def canary(self, copy_id: str) -> str:
        """One of the copy's document canaries, which no view shows: from the fake's documents, or for the real kernel
        read as `desk_admin` from its table."""
        if self._state is not None:
            return next(document.canary for desk in self._state.desks.values() if desk.copy_id == copy_id
                        for document in desk.documents.values())
        (found,) = self._admin.execute("SELECT canary FROM kernel.documents WHERE copy_id = %s ORDER BY document_id"
                                       " LIMIT 1", (copy_id,)).fetchall()
        return found[0]

    def recorded_policy_ids(self, decision_id: str) -> list[str]:
        """The deciding policies the kernel recorded with a decision: the fake's own record, or for the real kernel read
        as `desk_admin` from its table."""
        if self._state is not None:
            return list(self._state.decisions[decision_id].decision.policy_ids)
        (found,) = self._admin.execute("SELECT policy_ids FROM kernel.decisions WHERE decision_id = %s",
                                       (decision_id,)).fetchall()
        return found[0]

    def recorded_knowledge_created_at(self, desk_id: str) -> dict[str, datetime | None]:
        """First-added timestamps from the fake's stored state or the real kernel's table, never an API write."""
        if self._state is not None:
            return dict(self._state.desks[desk_id].knowledge_created_at)
        return dict(self._admin.execute(
            "SELECT item_id, created_at FROM kernel.knowledge_items WHERE desk_id = %s", (desk_id,)).fetchall())

    def close_idle_sessions(self, session_id: str) -> None:
        """Closes the session: the fake's clock moves past the 24-hour idle limit (closing every idle visitor
        session of the fake), the real kernel's row gets `closed_at`."""
        if self._state is not None:
            self._state.now += IDLE_CLOSE
        else:
            self._admin.execute("UPDATE kernel.sessions SET closed_at = now() WHERE session_id = %s", (session_id,))


@pytest.fixture
def arrange(kernel: tuple, admin: psycopg.Connection) -> Arrange:
    return Arrange(kernel[2], admin)
