"""The public context clock contract, with both kernels' clocks frozen in-process."""

import dataclasses
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from desk.api.kernel_client import KernelHttp
from desk.kernel_api import DeskBusinessRequest
from desk.kernel_service.app import KernelSettings, create_app
from tests.kernel.conftest import migrated_db, mockpay  # shared database and offline payments fixtures
from tests.kernel.fakes import FakeDecisions, FrozenClock
from tests.kernel_contract.conftest import REAL_RO_SCHEMA
from tests.kernel_contract.fake_kernel import FakeKernelState, fake_kernel_app
from tests.kernel_contract.ro_tables import FAKE_RO_SCHEMA
from tests.kernel_contract.test_contract import context, desk_slug, new_copy, new_visitor

NOW = datetime(2026, 11, 1, 0, 4, 5, 123456, tzinfo=UTC)


@pytest.fixture(params=["fake", pytest.param("real", marks=pytest.mark.real_kernel)])
async def frozen_kernel(request, fake_ro, mockpay, monkeypatch):
    """Exercise the real HTTP handlers with an injected clock, without a process clock-control hook."""
    if request.param == "fake":
        state = FakeKernelState(ro=fake_ro, now=NOW)

        def advance():
            state.now += timedelta(minutes=1)

        async with KernelHttp("http://fake-kernel", transport=httpx.ASGITransport(fake_kernel_app(state))) as http:
            yield http, FAKE_RO_SCHEMA, advance
    else:
        monkeypatch.delenv("DESK_SIGNING_SEED", raising=False)
        monkeypatch.setenv("DESK_PROVE", "/nonexistent/desk-prove")
        clock = FrozenClock(NOW)
        settings = dataclasses.replace(KernelSettings.from_env(), mockpay_url=mockpay.url, mockpay_key=mockpay.key,
                                       mockpay_spawn=False)
        app = create_app(settings, clock=clock, decisions=FakeDecisions(None))
        async with app.router.lifespan_context(app):
            async with KernelHttp("http://kernel", transport=httpx.ASGITransport(app)) as http:
                yield http, REAL_RO_SCHEMA, lambda: clock.advance(60)


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize(("timezone", "local_now", "local_date", "weekday"), [
    ("America/Los_Angeles", "2026-10-31T17:04-07:00", "2026-10-31", "sat"),
    ("Asia/Kathmandu", "2026-11-01T05:49+05:45", "2026-11-01", "sun"),
])
async def test_context_clock_matches_the_kernel_and_business(frozen_kernel, ro_read,
                                                            timezone, local_now, local_date, weekday):
    http, schema, advance = frozen_kernel
    copy = await new_copy(http)
    owner, desk_id = http.owner(copy.owner_token), copy.desk_ids[0]
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    # Change the business after session creation: context reads the current time zone, not a session snapshot.
    await owner.call("PUT /desks/{id}/business", DeskBusinessRequest(
        name="Rivera Plumbing", owner_display_name="Marta Rivera", timezone=timezone), path={"id": desk_id})
    expected = {"as_of_utc": "2026-11-01T00:04:05.123456Z", "local_now": local_now,
                "local_date": local_date, "weekday": weekday, "timezone": timezone}
    assert (await context(view, session_id)).clock.model_dump() == expected
    assert (await context(owner, copy.owner_session.session_id, desk_id)).clock.model_dump() == expected
    advance()
    refreshed = (await context(view, session_id)).clock
    assert refreshed.as_of_utc == "2026-11-01T00:05:05.123456Z"
    assert refreshed.local_now == ("2026-10-31T17:05-07:00" if timezone == "America/Los_Angeles"
                                   else "2026-11-01T05:50+05:45")
