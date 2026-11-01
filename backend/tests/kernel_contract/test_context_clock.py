"""The public context clock contract, with both kernels' clocks frozen in-process."""

import dataclasses
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfoNotFoundError

import httpx
import pytest

from desk.api.kernel_client import KernelHttp
from desk.kernel_api import DeskBusinessRequest
from desk.kernel_service.adapters import base
from desk.kernel_service.app import KernelSettings, create_app
from tests.kernel.conftest import migrated_db, mockpay  # shared database and offline payments fixtures
from tests.kernel.fakes import FakeDecisions, FrozenClock
from tests.kernel_contract import fake_kernel
from tests.kernel_contract.conftest import REAL_RO_SCHEMA
from tests.kernel_contract.fake_kernel import FakeKernelState, fake_kernel_app
from tests.kernel_contract.ro_tables import FAKE_RO_SCHEMA
from tests.kernel_contract.test_contract import context, desk_slug, new_copy, new_visitor

NOW = datetime(2026, 11, 1, 0, 4, 5, 123456, tzinfo=UTC)


@pytest.fixture
def frozen_now(request):
    return datetime.fromisoformat(request.param) if hasattr(request, "param") else NOW


@pytest.fixture(params=["fake", pytest.param("real", marks=pytest.mark.real_kernel)])
async def frozen_kernel(request, frozen_now, fake_ro, mockpay, monkeypatch):
    """Exercise the real HTTP handlers with an injected clock, without a process clock-control hook."""
    if request.param == "fake":
        state = FakeKernelState(ro=fake_ro, now=frozen_now)

        def advance():
            state.now += timedelta(minutes=1)

        async with KernelHttp("http://fake-kernel", transport=httpx.ASGITransport(fake_kernel_app(state))) as http:
            yield http, FAKE_RO_SCHEMA, advance
    else:
        monkeypatch.delenv("DESK_SIGNING_SEED", raising=False)
        monkeypatch.setenv("DESK_PROVE", "/nonexistent/desk-prove")
        clock = FrozenClock(frozen_now)
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
        name="Turner Plumbing", owner_display_name="Marta Turner", timezone=timezone), path={"id": desk_id})
    expected = {"as_of_utc": "2026-11-01T00:04:05.123456Z", "local_now": local_now,
                "local_date": local_date, "weekday": weekday, "timezone": timezone}
    assert (await context(view, session_id)).clock.model_dump() == expected
    assert (await context(owner, copy.owner_session.session_id, desk_id)).clock.model_dump() == expected
    advance()
    refreshed = (await context(view, session_id)).clock
    assert refreshed.as_of_utc == "2026-11-01T00:05:05.123456Z"
    assert refreshed.local_now == ("2026-10-31T17:05-07:00" if timezone == "America/Los_Angeles"
                                   else "2026-11-01T05:50+05:45")


@pytest.mark.kernel_plan("01b")
async def test_context_clock_zone_failure_is_a_closed_http_error(frozen_kernel, ro_read, monkeypatch):
    http, schema, _ = frozen_kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    view = http.session(visitor.session_token)

    def unavailable_zone(name):
        raise ZoneInfoNotFoundError("unavailable-zone-detail")

    # Zone data can become unavailable after a valid business and session were created.
    monkeypatch.setattr(base, "ZoneInfo", unavailable_zone)
    monkeypatch.setattr(fake_kernel, "ZoneInfo", unavailable_zone)
    response = await http._client.get(f"/context/{visitor.state.session_id}", headers=view._headers)
    assert response.status_code == 500
    assert response.json() == {"code": "internal"}
    assert "clock" not in response.text
    assert "ZoneInfoNotFoundError" not in response.text
    assert "unavailable-zone-detail" not in response.text


@pytest.mark.kernel_plan("01b")
@pytest.mark.parametrize(("frozen_now", "timezone", "before", "after"), [
    pytest.param("2026-03-08T09:59:59.123456Z", "America/Los_Angeles",
                 ("2026-03-08T01:59-08:00", "2026-03-08", "sun"),
                 ("2026-03-08T03:00-07:00", "2026-03-08", "sun"), id="spring-forward"),
    pytest.param("2026-11-01T08:59:59.123456Z", "America/Los_Angeles",
                 ("2026-11-01T01:59-07:00", "2026-11-01", "sun"),
                 ("2026-11-01T01:00-08:00", "2026-11-01", "sun"), id="fall-back"),
    pytest.param("2026-01-02T07:59:59.123456Z", "America/Los_Angeles",
                 ("2026-01-01T23:59-08:00", "2026-01-01", "thu"),
                 ("2026-01-02T00:00-08:00", "2026-01-02", "fri"), id="local-midnight"),
    pytest.param("2026-10-03T15:29:59.123456Z", "Australia/Lord_Howe",
                 ("2026-10-04T01:59+10:30", "2026-10-04", "sun"),
                 ("2026-10-04T02:30+11:00", "2026-10-04", "sun"), id="half-hour-dst"),
], indirect=["frozen_now"])
async def test_context_clock_boundary_values(frozen_kernel, frozen_now, ro_read, timezone, before, after):
    http, schema, advance = frozen_kernel
    copy = await new_copy(http)
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    view, session_id = http.session(visitor.session_token), visitor.state.session_id
    await http.owner(copy.owner_token).call("PUT /desks/{id}/business", DeskBusinessRequest(
        name="Turner Plumbing", owner_display_name="Marta Turner", timezone=timezone),
        path={"id": copy.desk_ids[0]})

    local_now, local_date, weekday = before
    assert (await context(view, session_id)).clock.model_dump() == {
        "as_of_utc": frozen_now.strftime("%Y-%m-%dT%H:%M:%S.%fZ"), "local_now": local_now,
        "local_date": local_date, "weekday": weekday, "timezone": timezone}
    advance()
    local_now, local_date, weekday = after
    assert (await context(view, session_id)).clock.model_dump() == {
        "as_of_utc": (frozen_now + timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "local_now": local_now, "local_date": local_date, "weekday": weekday, "timezone": timezone}
