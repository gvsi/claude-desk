"""The sample week: a hosted copy opens on a hand-written week of finished conversations (`seed.seed_sample_week`).

The kernel writes it only with `SAMPLE_WEEK=1` in its environment and a copy request that asks for history
(`replay_night`, which the hosted API sends). It is history: terminal rows, one archived sample-only person, every
ledger entry marked `replayed` inside its signature, and nothing a session, the owner or another copy can act on.
"""

import time as wall
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from desk.api.deps import OwnerCtx
from desk.api.kernel_client import KernelHttp
from desk.api import owner_reads
from desk.api.ro import KernelRO
from desk.api.routes.owner import store_replayed_night
from desk.contracts import CopyCreated, Decision, LedgerPage, Review
from desk.db.models import (ActorSession, AgentKey, Approval, Booking, CalendarSlot, DemoInboxEntry, Desk, Document,
                             DocumentLink, Execution, Fact, Handoff, Lead, MandateReservation, PaymentLink, Person,
                             Quote, VerificationChallenge)
from desk.db.models import Decision as DecisionRow
from desk.db.session import API_CONNECT_OPTIONS, database_url
from desk.kernel_service import activation, auth, decide, payments, reply_check, sample_week, seed, verification

from .helpers import kernel_ctx, rows_of, verify_session
from .test_decide import verify_signature

TZ = ZoneInfo("America/Los_Angeles")
RECORDING = seed.SAMPLE_WEEK_ID
BLOCK = Review(within_charter_bp=1_000, manipulation_bp=9_500, recommendation="block")


@pytest.fixture
def week_on(monkeypatch):
    """The kernel started with `SAMPLE_WEEK=1`, as the hosted kernel's container is (ask before `app`)."""
    monkeypatch.setenv("SAMPLE_WEEK", "1")


@pytest.fixture
def tokens(monkeypatch) -> list[str]:
    """Every token the kernel makes from here on, so a test can speak for a sample session no one was given."""
    made: list[str] = []
    new_token = auth.new_token

    def keep() -> str:
        made.append(new_token())
        return made[-1]

    monkeypatch.setattr(auth, "new_token", keep)
    return made


async def create_copy(client, **body) -> CopyCreated:
    response = await client.post("/copies", json=body)
    assert response.status_code == 200, response.text
    return CopyCreated.model_validate(response.json())


async def sample_sessions(app, created: CopyCreated) -> list[ActorSession]:
    seeded = created.seeded_chat.session_id
    return [row for row in await rows_of(app, created.copy_id, select(ActorSession).where(
        ActorSession.kind == "visitor").order_by(ActorSession.created_at)) if row.session_id != seeded]


def marked(entry) -> dict | None:
    return entry.event.summary.get("replayed")


async def ledger_page(client, created: CopyCreated) -> LedgerPage:
    response = await client.get(f"/ledger/{created.desk_ids[0]}", params={"verify": "true"},
                                headers={auth.OWNER_HEADER: created.owner_token})
    assert response.status_code == 200, response.text
    return LedgerPage.model_validate(response.json())


# ---- Off unless turned on and asked ------------------------------------------------------------------------------

@pytest.mark.parametrize("body", [{}, {"replay_night": True}])
async def test_the_week_is_off_without_the_setting(app, client, body):
    created = await create_copy(client, **body)
    assert (created.replayed_messages, created.replay_id) == ([], None)
    assert await sample_sessions(app, created) == []
    assert not [entry for entry in (await ledger_page(client, created)).entries if "replayed" in entry.event.summary]


async def test_the_week_is_off_when_the_copy_doesnt_ask(week_on, app, client):
    """The evals' targets ask for no history, so even a kernel with the setting on gives them an empty copy."""
    created = await create_copy(client)
    assert (created.replayed_messages, created.replay_id) == ([], None)
    assert await sample_sessions(app, created) == []
    assert not [entry for entry in (await ledger_page(client, created)).entries if "replayed" in entry.event.summary]


# ---- What Today shows ----------------------------------------------------------------------------------------------

NOWS = [
    datetime(2026, 10, 30, 10, 4, tzinfo=TZ),       # a Friday morning, the kernel tests' own clock
    datetime(2026, 11, 2, 9, 0, tzinfo=TZ),         # Monday: yesterday the clocks went back
    datetime(2026, 11, 1, 23, 45, tzinfo=TZ),       # the clock-change day itself, late
    datetime(2026, 10, 31, 12, 0, tzinfo=TZ),       # a Saturday at noon
    datetime(2026, 11, 8, 0, 30, tzinfo=TZ),        # just after midnight on a Sunday
]


async def today_of(app, created: CopyCreated, now: datetime):
    """Store the copy's events as the API does (`store_replayed_night`, in its own transaction, as desk_api over the
    real `kernel_ro` views), then read Today and Conversations as the owner's screens do."""
    engine = create_async_engine(database_url("API"), connect_args={"options": API_CONNECT_OPTIONS})
    try:
        async with engine.connect() as conn:
            stored = await store_replayed_night(conn, created, ro_schema="kernel_ro")
            await conn.commit()
        async with KernelHttp("http://kernel", transport=httpx.ASGITransport(app)) as kernel, engine.connect() as conn:
            ctx = OwnerCtx(copy_id=created.copy_id, desk_ids=tuple(created.desk_ids),
                           owner_session_id=created.owner_session.session_id, owner_generation=0,
                           kernel=kernel.owner(created.owner_token), ro=KernelRO(conn, created.copy_id))
            desk_id = created.desk_ids[0]
            return (stored, await owner_reads.today(ctx, desk_id, now), await owner_reads.conversations(ctx, desk_id),
                    await owner_reads.needs_you(ctx, desk_id), await owner_reads.attempts(ctx, desk_id))
    finally:
        await engine.dispose()


async def reports_of(app, created: CopyCreated, now: datetime):
    engine = create_async_engine(database_url("API"), connect_args={"options": API_CONNECT_OPTIONS})
    try:
        async with KernelHttp("http://kernel", transport=httpx.ASGITransport(app)) as kernel, engine.connect() as conn:
            ctx = OwnerCtx(copy_id=created.copy_id, desk_ids=tuple(created.desk_ids),
                           owner_session_id=created.owner_session.session_id, owner_generation=0,
                           kernel=kernel.owner(created.owner_token), ro=KernelRO(conn, created.copy_id))
            return await owner_reads.reports(ctx, created.desk_ids[0], now, 7)
    finally:
        await engine.dispose()


@pytest.mark.parametrize("hour,minute", [(0, 30), (3, 30), (9, 0), (17, 59), (23, 30)])
async def test_since_last_night_has_two_answers_and_one_refusal(week_on, app, client, frozen_clock, hour, minute):
    now = datetime(2026, 11, 1, hour, minute, tzinfo=TZ)
    frozen_clock.travel(now)
    created = await create_copy(client, replay_night=True)
    assert created.replay_id == RECORDING
    _, today, _, needs_you, _ = await today_of(app, created, now)
    assert today.briefing.answers + today.briefing.bookings == 2
    assert today.briefing.bookings == 0
    assert today.briefing.turned_down == 1
    assert today.needs_you_count == len(needs_you) == 1
    since = datetime(2026, 10, 31, 18, tzinfo=TZ)
    visitors = [event for event in created.replayed_messages if event.kind == "visitor_message"
                and since <= datetime.fromisoformat(event.shown_at) < now]
    assert {event.text for event in visitors} == {sample.said for sample in seed.RIVERA_SAMPLE_WEEK[:3]}
    assert len(visitors) == 3
    expected_date = (now.date() - timedelta(days=1)) if hour < 3 else now.date()
    assert {datetime.fromisoformat(event.shown_at).astimezone(TZ).date() for event in visitors} == {expected_date}
    if hour >= 3:
        for event, minutes in zip(sorted(visitors, key=lambda event: event.shown_at), (180, 135, 90), strict=True):
            assert datetime.fromisoformat(event.shown_at) == now.astimezone(UTC) - timedelta(minutes=minutes)


async def test_elena_cannot_be_verified_or_read_by_a_fresh_visitor(week_on, app, client, frozen_clock):
    from .test_context import context_of, fact_ids

    created = await create_copy(client, replay_night=True)
    [person] = await rows_of(app, created.copy_id, select(Person).where(Person.ref == seed.SAMPLE_CUSTOMER["ref"]))
    [document] = await rows_of(app, created.copy_id, select(Document).where(Document.ref == seed.SAMPLE_INVOICE["ref"]))
    assert person.removed_at < frozen_clock.now()
    [challenge] = await rows_of(app, created.copy_id, select(VerificationChallenge))
    assert challenge.person_id == document.record_owner_person_id == person.person_id
    assert challenge.status == "consumed" and challenge.expires_at < frozen_clock.now()
    assert challenge.failed_at == [] and challenge.code_hash == ""
    assert not verification.code_matches(challenge, "000000")
    [session] = await rows_of(app, created.copy_id, select(ActorSession).where(
        ActorSession.session_id == challenge.session_id))
    assert (session.person_id, session.verified, session.assurance) == (person.person_id, True, "demo_code")
    assert session.closed_at < frozen_clock.now()
    [release] = await rows_of(app, created.copy_id, select(DecisionRow).where(
        DecisionRow.session_id == session.session_id, DecisionRow.tool == "native.release_document"))
    assert (release.state, release.card_ids, release.policy_ids) == ("executed", ["rv-docs"], ["A.auto.rv-docs"])
    [link] = await rows_of(app, created.copy_id, select(DocumentLink))
    assert link.voided_at < frozen_clock.now() and link.expires_at < frozen_clock.now()
    assert (await client.get(f"/document_links/{link.token}")).status_code == 404
    [desk] = await rows_of(app, created.copy_id, select(Desk))
    opened = (await client.post("/sessions", json={"desk_slug": desk.slug, "kind": "visitor"})).json()
    session_id, headers = opened["state"]["session_id"], {auth.SESSION_HEADER: opened["session_token"]}
    context = await context_of(client, session_id, headers)
    assert f"document:{document.document_id}" not in fact_ids(context.facts)
    response = await client.post("/verify/start", headers=headers,
                                 json={"session_id": session_id, "contact": seed.SAMPLE_CUSTOMER["contact"]})
    assert response.status_code == 200 and response.json()["inbox"] == []
    response = await client.post("/verify/check", headers=headers, json={"session_id": session_id, "code": "000000"})
    assert response.status_code == 422
    assert await rows_of(app, created.copy_id, select(VerificationChallenge).where(
        VerificationChallenge.session_id == session_id)) == []
    response = await client.post("/decide", headers=headers, json={"session_id": session_id, "generation": 0,
        "call": {"call_id": "invoice", "tool": "native.release_document",
                 "args": {"document_id": document.document_id}}})
    assert response.status_code == 200 and response.json()["state"] == "refused"
    [live] = await rows_of(app, created.copy_id, select(ActorSession).where(ActorSession.session_id == session_id))
    assert (live.person_id, live.verified, live.assurance) == (None, False, "none")
    assert await rows_of(app, created.copy_id, select(DemoInboxEntry).where(
        DemoInboxEntry.person_id == person.person_id)) == []


async def test_unverified_document_refusal_matches_the_live_path(week_on, app, client, frozen_clock):
    from .test_decide import Visitor, decided

    created = await create_copy(client, replay_night=True)
    [sample] = await rows_of(app, created.copy_id, select(DecisionRow).where(
        DecisionRow.tool == "native.release_document", DecisionRow.state == "refused"))
    [desk] = await rows_of(app, created.copy_id, select(Desk))
    opened = (await client.post("/sessions", json={"desk_slug": desk.slug, "kind": "visitor"})).json()
    visitor = Visitor(opened["state"]["session_id"], opened["session_token"])
    live = await decided(client, visitor, "native.release_document", seed.RIVERA_SAMPLE_WEEK[2].calls[0].args)
    assert live.reason_plain == sample.reason_plain
    assert live.policy_ids == sample.policy_ids == []
    assert live.card_ids == sample.card_ids == []
    assert live.action is sample.action_id is None
    entries = {entry.seq: entry for entry in (await ledger_page(client, created)).entries}
    sample_summary = {key: value for key, value in entries[sample.ledger_seq].event.summary.items() if key != "replayed"}
    assert sample_summary == entries[live.ledger_seq].event.summary
    assert sample_summary["reason"] == "not_given" and "check" not in sample_summary
    _, _, _, _, attempts = await today_of(app, created, frozen_clock.now())
    [attempt] = [attempt for attempt in attempts if attempt.ref_id == sample.decision_id]
    assert attempt.cause == "tool_not_available"


async def test_sample_payment_is_terminal_and_never_calls_the_provider(week_on, app, client, frozen_clock,
                                                                      monkeypatch):
    created = await create_copy(client, replay_night=True)
    [link] = await rows_of(app, created.copy_id, select(PaymentLink))
    assert (link.state, link.amount_cents, link.mandate_id) == ("paid", 2_000, None)
    assert link.created_at < link.completion_started_at < link.updated_at
    assert link.created_at < link.updated_at < link.expires_at < frozen_clock.now()
    [decision] = await rows_of(app, created.copy_id, select(DecisionRow).where(
        DecisionRow.action_id == link.action_id))
    assert (decision.state, decision.card_ids, decision.policy_ids) == ("executed", ["rv-link"], ["A.auto.rv-link"])
    assert decision.review == sample_week.SAMPLE_REVIEW
    [quote] = await rows_of(app, created.copy_id, select(Quote).where(Quote.quote_id == link.quote_id))
    assert quote.status == "paid" and quote.amount_cents == link.amount_cents
    [paid] = [entry for entry in (await ledger_page(client, created)).entries
              if entry.event.kind == "payment" and entry.event.summary.get("state") == "paid"]
    summary = {key: value for key, value in paid.event.summary.items() if key != "replayed"}
    assert set(summary) == {"link_id", "state", "charge_id", "policy_version", "auto_money_cap_cents"}
    assert summary["link_id"] == link.link_id and summary["auto_money_cap_cents"] == seed.RIVERA_MONEY_CAP_CENTS
    [charge] = await rows_of(app, created.copy_id, select(Fact).where(
        Fact.fact_id == f"charge:{summary['charge_id']}"))
    assert charge.created_at == link.updated_at
    assert (paid.event.session_id, paid.event.ref_id) == (link.session_id, link.link_id)
    card = next(block for event in created.replayed_messages if event.verdict for block in event.verdict.blocks
                if block.template == "payment_link")
    assert card.href is not None and card.href.endswith(link.token)

    def no_provider(*args, **kwargs):
        pytest.fail("terminal sample link contacted the provider")

    real_provider = payments.provider
    monkeypatch.setattr(payments, "provider", no_provider)
    response = await client.get(f"/payment_links/{link.token}")
    assert response.status_code == 200 and response.json()["state"] == "paid"
    for operation in ("complete", "cancel"):
        response = await client.post(f"/payment_links/{link.token}/{operation}", json={})
        assert response.status_code == 409
    async with kernel_ctx(app) as ctx:
        ctx.bind(created.copy_id)
        assert await payments.reconcile_link(ctx, link.link_id) is False
        await payments.settle_link(ctx, link.link_id)
        assert await payments.quote_unpayable(ctx, quote) == "quote_paid"
        assert await payments.open_link_fact(ctx, quote) is None
        version = await activation.active_version(ctx, link.desk_id)
        assert await payments.cancel_disallowed_links(ctx, link.desk_id, version) == []
        assert await payments._desk_links(ctx, link.desk_id) == []
        assert await payments.cancelled_links(ctx, link.desk_id, version.version) == []
    assert await payments.reconcile_links_at_startup(app.state.kernel) == []
    from .test_payment_links import checkouts
    assert checkouts(created) == []
    [desk] = await rows_of(app, created.copy_id, select(Desk))
    [dana] = await rows_of(app, created.copy_id, select(Person).where(Person.ref == "dana"))
    opened = (await client.post("/sessions", json={"desk_slug": desk.slug, "kind": "visitor"})).json()
    await verify_session(app, created.copy_id, opened["state"]["session_id"], dana.person_id)
    # The sample charge was never made at the payments server, so a verified customer's refund of it is refused
    # there like any unknown charge, and nothing is refunded.
    monkeypatch.setattr(payments, "provider", real_provider)
    response = await client.post("/decide", headers={auth.SESSION_HEADER: opened["session_token"]}, json={
        "session_id": opened["state"]["session_id"], "generation": 0,
        "call": {"call_id": "sample-refund", "tool": "payments.create_refund",
                 "args": {"charge_id": summary["charge_id"]}}})
    assert response.status_code == 200 and response.json()["state"] == "refused"
    await today_of(app, created, frozen_clock.now())
    assert (await reports_of(app, created, frozen_clock.now())).paid_cents == 2_000


async def test_the_owners_conversations_list_shows_each_sample_outcome(week_on, app, client, frozen_clock):
    """Through the owner's own Conversations read (`owner_reads.conversations`, `visitor_outcomes`): each sample
    conversation previews its visitor's words, is marked replayed and shows the outcome it was written to show."""
    created = await create_copy(client, replay_night=True)
    _, _, conversations, _, _ = await today_of(app, created, frozen_clock.now())
    shown = {summary.latest_visitor_text: summary for summary in conversations}
    expected = ("quoted", None, "turned_down", "visit_booked", "document_sent", "deposit_paid", "called_back",
                "owner_declined", "lead_captured", "turned_down")
    for sample, outcome in zip(seed.RIVERA_SAMPLE_WEEK, expected, strict=True):
        summary = shown[sample.said]
        assert (summary.latest_outcome, summary.replayed) == (outcome, True), sample.said


async def test_each_sample_session_ends_with_its_conversations_outcome(week_on, app, client):
    created = await create_copy(client, replay_night=True)
    page = await ledger_page(client, created)
    entries = {entry.seq: entry.model_dump(mode="json") for entry in page.entries}
    decisions = await rows_of(app, created.copy_id, select(DecisionRow))
    links = {row.link_id: row for row in await rows_of(app, created.copy_id, select(PaymentLink))}
    handoffs = {row.handoff_id: row for row in await rows_of(app, created.copy_id, select(Handoff))}
    expected = ("quote", None, "refused", "booking", "document released", "deposit paid",
                "callback handled", "owner declined", "lead", "refused")
    tools = {"native.quote": "quote", "native.book": "booking", "native.release_document": "document released",
             "native.capture_lead": "lead"}
    for sample, outcome in zip(seed.RIVERA_SAMPLE_WEEK, expected, strict=True):
        [visitor] = [event for event in created.replayed_messages
                     if event.kind == "visitor_message" and event.text == sample.said]
        candidates = []
        for decision in decisions:
            if decision.session_id != visitor.session_id:
                continue
            entry = entries[decision.ledger_seq]
            assert entry["event"]["ref_id"] == decision.decision_id
            assert entry["event"]["kind"] == {"executed": "execute", "denied": "approval", "refused": "decide"}[
                decision.state]
            value = ("refused" if decision.state == "refused" else "owner declined"
                     if decision.state == "denied" else tools.get(decision.tool)
                     if decision.state == "executed" else None)
            candidates.append((owner_reads.entry_time(entry), entry["seq"], value))
        for entry in entries.values():
            event, summary = entry["event"], entry["event"]["summary"]
            link = links.get(summary.get("link_id"))
            if (event["kind"] == "payment" and link is not None and link.session_id == visitor.session_id
                    and link.state == summary.get("state") == "paid" and not summary.get("refused")):
                candidates.append((owner_reads.entry_time(entry), entry["seq"], "deposit paid"))
            if event["kind"] == "desk_data" and summary.get("part") == "handoffs":
                for ref in summary.get("refs", []):
                    handoff = handoffs.get(ref)
                    if handoff is not None and handoff.session_id == visitor.session_id:
                        assert event["session_id"] is None and event["ref_id"] is None
                        assert {key: value for key, value in summary.items() if key != "replayed"} == {
                            "part": "handoffs", "refs": [handoff.handoff_id]}
                        candidates.append((owner_reads.entry_time(entry), entry["seq"],
                                           "callback handled" if handoff.status == "done" else None))
        assert (max(candidates)[2] if candidates else None) == outcome, sample.said


async def test_only_the_deposits_final_reply_is_authored_by_the_desk(week_on, app, client):
    created = await create_copy(client, replay_night=True)
    [deposit] = [event for event in created.replayed_messages
                 if event.kind == "visitor_message" and event.text == seed.RIVERA_SAMPLE_WEEK[5].said]
    replies = [event for event in created.replayed_messages if event.kind == "reply"]
    last = max((event for event in replies if event.session_id == deposit.session_id), key=lambda event: event.shown_at)
    assert last.author == "desk"
    assert [block.template for block in last.verdict.blocks] == ["payment_confirmed"]
    assert all(event.author == "claude" for event in replies if event is not last)
    assert all(event.author == "claude" for event in created.replayed_messages if event.kind != "reply")


@pytest.mark.parametrize("now", NOWS)
async def test_booking_bars_use_the_two_conversations_dates(week_on, app, client, frozen_clock, now):
    frozen_clock.travel(now)
    created = await create_copy(client, replay_night=True)
    _, today, _, _, _ = await today_of(app, created, now)
    expected = {now.astimezone(TZ).date() - timedelta(days=back): 1 for back in (6, 5)}
    assert {day.date: day.bookings for day in today.this_week.days if day.bookings} == expected
    assert today.this_week.bookings == 2
    assert next(day.bookings for day in today.this_week.days if day.date == now.astimezone(TZ).date()) == 0
    sessions = {row.session_id: row for row in await sample_sessions(app, created)}
    entries = {entry.seq: entry.model_dump(mode="json") for entry in (await ledger_page(client, created)).entries}
    bookings = await rows_of(app, created.copy_id, select(DecisionRow).where(DecisionRow.tool == "native.book"))
    for booking in bookings:
        assert owner_reads.entry_time(entries[booking.ledger_seq]).astimezone(TZ).date() == (
            sessions[booking.session_id].created_at.astimezone(TZ).date())


@pytest.mark.parametrize("now", NOWS, ids=lambda now: now.strftime("%a-%m-%d-%H%M"))
async def test_a_hosted_copy_opens_on_a_sample_week(week_on, app, client, frozen_clock, now):
    frozen_clock.travel(now)
    created = await create_copy(client, replay_night=True)
    assert created.replay_id == RECORDING
    sessions = await sample_sessions(app, created)
    assert len(sessions) == len(seed.RIVERA_SAMPLE_WEEK)
    assert [event.shown_at for event in created.replayed_messages] == sorted(
        event.shown_at for event in created.replayed_messages)

    stored, today, conversations, needs_you, attempts = await today_of(app, created, now)
    assert stored == len(created.replayed_messages)
    week = today.this_week
    assert len({day.date for day in week.days if day.bookings}) == 2
    assert week.bookings == 2 and week.booked_cents > 0
    assert week.handled > 1 and week.stopped >= 2
    assert today.recorded_history.this_week is True and today.recorded_history.needs_you is False
    # "Needs you" holds the seeded hold alone, live; nothing sample asks the owner for anything
    assert [item.decision.decision_id for item in needs_you] == [created.seeded_chat.decision.decision_id]
    assert today.needs_you_count == 1
    sample_ids = {row.session_id for row in sessions}
    assert sample_ids <= {summary.session_id for summary in conversations}
    assert {attempt.ref_id for attempt in attempts if attempt.kind == "refused"} >= {
        row.decision_id for row in await rows_of(app, created.copy_id, select(DecisionRow).where(
            DecisionRow.outcome == "refuse", DecisionRow.session_id.in_(sample_ids)))}

    # every sample moment is on one of the six local days before today, by day, and an hour or more before now
    local_today = now.astimezone(TZ).date()
    for event in created.replayed_messages:
        shown = datetime.fromisoformat(event.shown_at)
        assert local_today - timedelta(days=6) <= shown.astimezone(TZ).date() <= local_today
        assert shown <= now - timedelta(hours=1)


async def live_lead(app, client, created: CopyCreated) -> str:
    """A live visitor leaves details through `native.capture_lead`, decided and run as any call; its session's ID."""
    [desk_row] = await rows_of(app, created.copy_id, select(Desk))
    opened = (await client.post("/sessions", json={"desk_slug": desk_row.slug, "kind": "visitor"})).json()
    session_id, headers = opened["state"]["session_id"], {auth.SESSION_HEADER: opened["session_token"]}
    decided = await client.post("/decide", headers=headers, json={
        "session_id": session_id, "generation": 0,
        "call": {"call_id": "lead", "tool": "native.capture_lead", "args": {"name": "Sam", "note": "A new tap."}}})
    assert decided.status_code == 200 and decided.json()["state"] == "allowed", decided.text
    ran = await client.post("/execute", headers=headers, json={
        "decision_id": decided.json()["decision_id"], "session_id": session_id, "generation": 0})
    assert ran.status_code == 200 and ran.json()["state"] == "succeeded", ran.text
    return session_id


async def test_the_owner_sees_each_sample_conversation_transcript_and_lead_marked(week_on, app, client):
    """Conversations, an opened transcript and People's leads say which are sample history (`replayed`), so the
    owner's screens label them and offer no take-over on them; the live seeded hold and a live lead say they aren't."""
    created = await create_copy(client, replay_night=True)
    samples = {row.session_id for row in await sample_sessions(app, created)}
    live = await live_lead(app, client, created)
    seeded = created.seeded_chat.session_id
    engine = create_async_engine(database_url("API"), connect_args={"options": API_CONNECT_OPTIONS})
    try:
        async with engine.connect() as conn:
            await store_replayed_night(conn, created, ro_schema="kernel_ro")
            await conn.commit()
        async with KernelHttp("http://kernel", transport=httpx.ASGITransport(app)) as kernel, engine.connect() as conn:
            ctx = OwnerCtx(copy_id=created.copy_id, desk_ids=tuple(created.desk_ids),
                           owner_session_id=created.owner_session.session_id, owner_generation=0,
                           kernel=kernel.owner(created.owner_token), ro=KernelRO(conn, created.copy_id))
            desk_id = created.desk_ids[0]
            listed = {summary.session_id: summary.model_dump(mode="json")["replayed"]
                      for summary in await owner_reads.conversations(ctx, desk_id)}
            opened = {session_id: await owner_reads.transcript_replayed(ctx, desk_id, session_id)
                      for session_id in (*samples, seeded, live)}
            leads = {lead.display_name: lead.model_dump(mode="json")["replayed"]
                     for lead in await owner_reads.leads(ctx, desk_id)}
    finally:
        await engine.dispose()
    assert {session_id: listed[session_id] for session_id in samples} == dict.fromkeys(samples, True)
    assert (listed[seeded], listed[live]) == (False, False)
    assert opened == {**dict.fromkeys(samples, True), seeded: False, live: False}
    assert leads == {"Priya": True, "Sam": False}


async def test_the_api_stores_the_sample_week_as_recorded_history(week_on, app, client):
    created = await create_copy(client, replay_night=True)
    engine = create_async_engine(database_url("API"), connect_args={"options": API_CONNECT_OPTIONS})
    try:
        async with engine.connect() as conn:
            assert await store_replayed_night(conn, created, ro_schema="kernel_ro") == len(created.replayed_messages)
            await conn.commit()
            rows = (await conn.exec_driver_sql(
                "SELECT kind, replay_id, created_at FROM app.messages WHERE copy_id = %s ORDER BY n",
                (created.copy_id,))).all()
    finally:
        await engine.dispose()
    assert {row.replay_id for row in rows} == {RECORDING}
    assert {row.kind for row in rows} == {"visitor_text", "delivered", "status"}
    assert sorted(row.created_at for row in rows) == sorted(
        datetime.fromisoformat(event.shown_at) for event in created.replayed_messages)


# ---- The ledger ------------------------------------------------------------------------------------------------------

async def test_the_ledger_verifies_and_every_sample_entry_is_marked(week_on, app, client):
    created = await create_copy(client, replay_night=True)
    page = await ledger_page(client, created)
    assert page.chain_ok and page.first_bad_seq is None
    sessions = {row.session_id for row in await sample_sessions(app, created)}
    decisions = await rows_of(app, created.copy_id, select(DecisionRow).where(DecisionRow.session_id.in_(sessions)))
    handoffs = {row.handoff_id for row in await rows_of(app, created.copy_id, select(Handoff))}
    by_seq = {entry.seq: entry for entry in page.entries}
    sample = [entry for entry in page.entries
              if entry.event.session_id in sessions or entry.event.ref_id in {row.decision_id for row in decisions}
              or set(entry.event.summary.get("refs", [])) & handoffs]
    marks = [entry for entry in page.entries if "replayed" in entry.event.summary]
    assert sample and sample == marks                  # every sample entry is marked, and only those are
    assert {entry.event.kind for entry in sample} == {"session", "decide", "execute", "approval", "reply",
                                                      "desk_data", "verify", "document_link", "payment"}
    for entry in sample:
        assert entry.event.origin == "kernel"
        assert marked(entry)["recording"] == RECORDING
        # the signed append time stays the real one; the sample moment is the mark's
        assert datetime.fromisoformat(marked(entry)["at"]) < datetime.fromisoformat(entry.created_at)
    times = [datetime.fromisoformat(marked(entry)["at"]) for entry in sample]
    assert times == sorted(times)                      # appended in sample-time order
    for row in decisions:
        assert marked(by_seq[row.ledger_seq])["recording"] == RECORDING
    # the sample comes after the seed and its held request, inside the copy's own transaction
    held_seq = created.seeded_chat.decision.ledger_seq
    assert min(entry.seq for entry in sample) > held_seq
    public_key = (await client.get("/health")).json()["public_key_hex"]
    for event in created.replayed_messages:
        if event.decision is not None:
            verify_signature(public_key, event.decision)
            assert marked(by_seq[event.decision.ledger_seq])["recording"] == RECORDING
        if event.verdict is not None:
            assert marked(by_seq[event.verdict.ledger_seq])["recording"] == RECORDING


async def test_signed_verdicts_and_cards_are_the_kernels(week_on, app, client):
    created = await create_copy(client, replay_night=True)
    public_key = (await client.get("/health")).json()["public_key_hex"]
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    import hashlib
    import json

    import desk_kernel

    templates = set()
    for event in created.replayed_messages:
        if event.verdict is None:
            continue
        verdict = event.verdict
        assert verdict.ok and verdict.generation == 0 and verdict.language == "en"
        blocks = desk_kernel.canonical_json(json.dumps([block.model_dump(mode="json") for block in verdict.blocks]))
        body = {"session_id": event.session_id, "generation": 0, "message_id": verdict.message_id,
                "blocks_sha256": hashlib.sha256(blocks.encode()).hexdigest(), "visitor_plain": verdict.visitor_plain,
                "ledger_seq": verdict.ledger_seq}
        digest = hashlib.sha256(desk_kernel.canonical_json(json.dumps(body)).encode()).digest()
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key)).verify(
            bytes.fromhex(verdict.signature), b"desk-verdict-v1\0" + digest)
        templates |= {block.template for block in verdict.blocks if block.kind == "card"}
        prose = [block for block in verdict.blocks if block.kind == "prose"]
        if any(block.template == "payment_confirmed" for block in verdict.blocks):
            assert prose == []
            continue
        assert len(prose) == 1 and reply_check.scan_prose(
            prose[0].text, booking_card=any(block.template == "booking_confirmed" for block in verdict.blocks),
            callback_card=any(block.template == "callback_confirmed" for block in verdict.blocks)) == []
    assert templates == {"quote", "booking_confirmed", "callback_confirmed", "document_link", "payment_link",
                         "payment_confirmed"}
    # each card's numbers are the copy's own: a quote's total is its quote row's, a booking's date its booking's
    quotes = {f"quote:{row.quote_id}": row for row in await rows_of(app, created.copy_id, select(Quote))}
    bookings = {f"booking:{row.booking_id}": row for row in await rows_of(app, created.copy_id, select(Booking))}
    for event in created.replayed_messages:
        for block in (event.verdict.blocks if event.verdict else []):
            if block.template == "quote":
                assert block.title == f"${quotes[block.fact_id].amount_cents / 100:,.2f}"
            if block.template == "booking_confirmed":
                starts = bookings[block.fact_id].starts_at.astimezone(TZ)
                assert block.title == f"{starts:%A, %B} {starts.day}"


# ---- Never live ---------------------------------------------------------------------------------------------------

async def test_every_sample_row_is_finished(week_on, app, client):
    created = await create_copy(client, replay_night=True)
    sessions = await sample_sessions(app, created)
    ids = {row.session_id for row in sessions}
    for row in sessions:
        assert row.closed_at is not None and row.generation == 0 and row.mode == "ai" and row.strikes == 0
        assert row.closed_at < created_at(created)
    decisions = await rows_of(app, created.copy_id, select(DecisionRow).where(DecisionRow.session_id.in_(ids)))
    assert {row.state for row in decisions} == {"executed", "refused", "denied"}
    assert {row.status for row in await rows_of(app, created.copy_id, select(Quote))} == {"expired", "paid"}
    assert {row.status for row in await rows_of(app, created.copy_id, select(Handoff))} == {"done"}
    [approval] = await rows_of(app, created.copy_id, select(Approval))
    assert (approval.answer, approval.nonce, approval.binding_sha256) == ("deny_once", None, None)
    assert approval.consumed_at is not None
    facts = await rows_of(app, created.copy_id, select(Fact).where(Fact.session_id.in_(ids)))
    assert {(row.kind, row.status) for row in facts} == {("quote", "expired"), ("booking", "committed"),
                                                         ("handoff", "expired"), ("document", "expired"),
                                                         ("payment_link", "expired"), ("charge", "committed")}
    # Nothing that runs, waits or pays: one consumed challenge, no execution or Demo inbox entry of the week.
    assert await rows_of(app, created.copy_id, select(Execution)) == []
    assert {row.status for row in await rows_of(app, created.copy_id, select(VerificationChallenge))} == {"consumed"}
    inbox = await rows_of(app, created.copy_id, select(DemoInboxEntry))
    assert [row.kind for row in inbox if row.kind != "head_checkpoint"] == ["alert"]   # the seeded hold's alone


async def test_the_denied_hold_isnt_the_live_holds_ask(week_on, app, client):
    """The sample's discount the owner turned down is for another job and amount than the live seeded hold waiting in
    Needs you, so the history never reads as the Desk asking again for something already turned down; the price
    list rule still holds it (a discount on the list price, `H.twin.rv-quote`)."""
    from desk.db.models import Action as ActionRow

    created = await create_copy(client, replay_night=True)
    ids = {row.session_id for row in await sample_sessions(app, created)}
    [denied] = await rows_of(app, created.copy_id, select(DecisionRow).where(
        DecisionRow.session_id.in_(ids), DecisionRow.state == "denied"))
    assert (denied.outcome, denied.policy_ids, denied.card_ids) == ("hold", ["H.twin.rv-quote"], ["rv-quote"])
    [action] = await rows_of(app, created.copy_id, select(ActionRow).where(ActionRow.action_id == denied.action_id))
    assert (action.args_json["items"], action.discount_bp) == ([{"item_id": "heater", "qty": 1}], 1000)
    assert (action.list_cents, action.amount_cents) == (15_000, 13_500)
    live = created.seeded_chat.decision.action
    assert (live.list_cents, live.discount_bp) != (action.list_cents, action.discount_bp)
    assert "10% off" in denied.reason_plain


def created_at(created: CopyCreated) -> datetime:
    return max(datetime.fromisoformat(event.shown_at) for event in created.replayed_messages) + timedelta(hours=1)


async def test_nothing_in_the_week_can_be_acted_on(week_on, tokens, app, client):
    created = await create_copy(client, replay_night=True)
    by_hash = {auth.hash_token(token): token for token in tokens}
    sessions = await sample_sessions(app, created)
    decisions = await rows_of(app, created.copy_id, select(DecisionRow).where(
        DecisionRow.session_id.in_({row.session_id for row in sessions})))
    for row in sessions:
        headers = {auth.SESSION_HEADER: by_hash[row.secret_hash]}
        response = await client.post("/decide", headers=headers, json={
            "session_id": row.session_id, "generation": 0,
            "call": {"call_id": "again", "tool": "native.quote", "args": {"items": [{"item_id": "drain", "qty": 1}]}}})
        assert (response.status_code, response.json()["code"]) == (409, "closed"), response.text
    for row in decisions:
        session = next(session for session in sessions if session.session_id == row.session_id)
        response = await client.post("/execute", headers={auth.SESSION_HEADER: by_hash[session.secret_hash]},
                                     json={"decision_id": row.decision_id, "session_id": row.session_id,
                                           "generation": 0})
        assert response.status_code == 409, response.text
    [denied] = [row for row in decisions if row.state == "denied"]
    for answer in ("allow_once", "deny_once"):
        response = await client.post(f"/approvals/{denied.decision_id}/answer",
                                     headers={auth.OWNER_HEADER: created.owner_token}, json={"answer": answer})
        assert response.status_code == 409, response.text

    # a live visitor can't pay a sample quote or book a sample booking's slot
    [desk] = await rows_of(app, created.copy_id, select(Desk))
    response = await client.post("/sessions", json={"desk_slug": desk.slug, "kind": "visitor"})
    live = response.json()
    headers = {auth.SESSION_HEADER: live["session_token"]}
    quotes = await rows_of(app, created.copy_id, select(Quote))
    bookings = await rows_of(app, created.copy_id, select(Booking))
    calls = [("native.payment_link", {"quote_id": row.quote_id}) for row in quotes]
    calls += [("native.book", {"slot_id": row.slot_id}) for row in bookings]
    for n, (tool, args) in enumerate(calls):
        response = await client.post("/decide", headers=headers, json={
            "session_id": live["state"]["session_id"], "generation": 0,
            "call": {"call_id": f"live-{n}", "tool": tool, "args": args}})
        assert response.status_code == 200, response.text
        decision = Decision.model_validate(response.json())
        assert (decision.outcome, decision.state) == ("refuse", "refused"), (tool, decision.reason_plain)
    # no sample slot is on the calendar the owner edits, so none holds up a calendar write
    slots = {row.slot_id for row in await rows_of(app, created.copy_id, select(CalendarSlot))}
    assert not slots & {row.slot_id for row in bookings}


# ---- No seeded person; one archived sample-only customer -------------------------------------------------------------

SEEDED_PEOPLE = ("Dana", "Whitfield", "Bob", "Okafor", "dana@", "bob@")


def test_the_written_week_names_no_one():
    """The sample's own words name no seeded person, and neither the owner nor the business, whose names come from
    the seed's own values (so renaming the seed renames them); its replies pass the reply check's prose scan."""
    business, _ = seed.rivera_seed(datetime(2026, 10, 30, tzinfo=UTC))
    banned = (*SEEDED_PEOPLE, *business.owner_display_name.split(), *business.name.split(), "Mike", "Turner",
              "Mike", "Turner")
    for sample in seed.RIVERA_SAMPLE_WEEK:
        texts = [sample.said, sample.prose, *(str(call.args) for call in sample.calls)]
        for text in texts:
            assert not [name for name in banned if name.lower() in text.lower() and name not in ("Plumbing",)], text
        assert reply_check.scan_prose(sample.prose, booking_card="booking_confirmed" in sample.cards,
                                      callback_card="callback_confirmed" in sample.cards) == [], sample.prose


async def test_the_week_carries_only_the_archived_sample_person(week_on, app, client):
    created = await create_copy(client, replay_night=True)
    sessions = await sample_sessions(app, created)
    ids = {row.session_id for row in sessions}
    [person] = await rows_of(app, created.copy_id, select(Person).where(Person.ref == seed.SAMPLE_CUSTOMER["ref"]))
    assert person.removed_at is not None
    assert sum(row.verified for row in sessions) == 1
    for row in sessions:
        expected = (person.person_id, True, "demo_code") if row.verified else (None, False, "none")
        assert (row.person_id, row.verified, row.assurance) == expected
        assert (row.agent_key_id, row.mandate_id) == (None, None)
    for row in await rows_of(app, created.copy_id, select(Fact).where(Fact.session_id.in_(ids))):
        if row.kind == "document":
            assert (row.readers, row.record_owner) == (["owner", f"person:{person.person_id}"], person.person_id)
        else:
            assert (row.readers, row.record_owner) == (["owner", f"session:{row.session_id}"], None)
    assert {row.person_id for row in await rows_of(app, created.copy_id, select(Booking))} == {None}
    texts = []
    for model in (DecisionRow, Lead, Handoff, Quote, Fact):
        for row in await rows_of(app, created.copy_id, select(model)):
            if getattr(row, "session_id", None) in ids:
                texts.append(repr({key: value for key, value in vars(row).items() if not key.startswith("_")}))
    texts += [event.model_dump_json() for event in created.replayed_messages]
    for text in texts:
        assert not [name for name in SEEDED_PEOPLE if name in text], text


async def test_a_visitor_verified_as_dana_reads_none_of_it(week_on, app, client):
    created = await create_copy(client, replay_night=True)
    [desk_row] = await rows_of(app, created.copy_id, select(Desk))
    [dana] = await rows_of(app, created.copy_id, select(Person).where(Person.ref == "dana"))
    opened = (await client.post("/sessions", json={"desk_slug": desk_row.slug, "kind": "visitor"})).json()
    session_id = opened["state"]["session_id"]
    await verify_session(app, created.copy_id, session_id, dana.person_id)
    facts = await rows_of(app, created.copy_id, select(Fact).where(
        Fact.session_id.in_({row.session_id for row in await sample_sessions(app, created)})))
    template = {"quote": "quote", "booking": "booking_confirmed", "handoff": "callback_confirmed",
                "document": "document_link", "payment_link": "payment_link", "charge": "charges"}
    for fact in facts:
        response = await client.post("/check_reply", headers={auth.SESSION_HEADER: opened["session_token"]}, json={
            "draft": {"session_id": session_id, "generation": 0, "prose": "Here it is.",
                      "clauses": [{"template": template[fact.kind], "fact_id": fact.fact_id}]}})
        assert response.status_code == 200, response.text
        verdict = response.json()
        assert not verdict["ok"]
        assert {violation["kind"] for violation in verdict["violations"]} & {"unentitled_fact", "stale_fact"}, verdict
        assert not [block for block in verdict["blocks"] if block.get("fact_id") == fact.fact_id]


# ---- Windows and limits: a new conversation behaves as on a copy without the week -------------------------------

async def strikes_until_paused(app, client, created: CopyCreated, reviewer) -> list[str]:
    """A new visitor asks for three weekday bookings the reviewer flags; the session's mode after each."""
    [desk_row] = await rows_of(app, created.copy_id, select(Desk))
    slots = [row for row in await rows_of(app, created.copy_id, select(CalendarSlot).order_by(CalendarSlot.starts_at))
             if row.starts_at.astimezone(TZ).weekday() < 5 and row.starts_at.astimezone(TZ).hour >= 8]
    opened = (await client.post("/sessions", json={"desk_slug": desk_row.slug, "kind": "visitor"})).json()
    headers = {auth.SESSION_HEADER: opened["session_token"]}
    reviewer.answer = BLOCK
    modes = []
    for n in range(decide.BREAKER_STRIKES + 1):
        response = await client.post("/decide", headers=headers, json={
            "session_id": opened["state"]["session_id"], "generation": 0,
            "call": {"call_id": f"try-{n}", "tool": "native.book", "args": {"slot_id": slots[n].slot_id}}})
        assert response.status_code == 200, response.text
        modes.append((await client.get("/whoami", headers=headers)).json()["session"]["mode"])
    return modes


@pytest.fixture(params=[False, True], ids=["empty", "week"])
def either(request, monkeypatch) -> bool:
    """A kernel with the week off, then on (ask before `app`)."""
    if request.param:
        monkeypatch.setenv("SAMPLE_WEEK", "1")
    else:
        monkeypatch.delenv("SAMPLE_WEEK", raising=False)
    return request.param


async def test_live_verification_limits_are_identical_with_or_without_the_week(either, app, client, frozen_clock):
    created = await create_copy(client, replay_night=True)
    assert created.replay_id == (RECORDING if either else None)
    [desk] = await rows_of(app, created.copy_id, select(Desk))
    [dana] = await rows_of(app, created.copy_id, select(Person).where(Person.ref == "dana"))
    opened = (await client.post("/sessions", json={"desk_slug": desk.slug, "kind": "visitor"})).json()
    session_id, headers = opened["state"]["session_id"], {auth.SESSION_HEADER: opened["session_token"]}
    async with kernel_ctx(app) as ctx:
        ctx.bind(created.copy_id)
        assert await verification._challenges_in_hour(ctx, dana.person_id, frozen_clock.now()) == 0
        assert await verification._failures_in_hour(ctx, dana.person_id, frozen_clock.now()) == 0
        assert await verification._live(ctx, session_id=session_id) == []
    response = await client.post("/verify/start", headers=headers,
                                 json={"session_id": session_id, "contact": "new.customer@example.com"})
    assert response.status_code == 200 and response.json()["inbox"] == []
    assert await rows_of(app, created.copy_id, select(VerificationChallenge).where(
        VerificationChallenge.session_id == session_id)) == []
    notices = []
    for _ in range(verification.MAX_CHALLENGES_PER_HOUR + 1):
        response = await client.post("/verify/start", headers=headers,
                                     json={"session_id": session_id, "contact": dana.contact})
        assert response.status_code == 200
        notices.append(len(response.json()["inbox"]))
    assert notices == [1, 1, 1, 1, 1, 0]
    async with kernel_ctx(app) as ctx:
        ctx.bind(created.copy_id)
        assert await verification._challenges_in_hour(ctx, dana.person_id, frozen_clock.now()) == 5
        assert await verification._failures_in_hour(ctx, dana.person_id, frozen_clock.now()) == 0
        assert await verification._live(ctx, session_id=session_id) == []
    inbox = await rows_of(app, created.copy_id, select(DemoInboxEntry).where(
        DemoInboxEntry.person_id == dana.person_id))
    assert len([row for row in inbox if row.kind == "verification_code"]) == 5
    assert len([row for row in inbox if row.kind == "alert"]) == 1


async def test_live_payment_limits_and_quote_reads_are_unchanged(either, app, client, reviewer, frozen_clock):
    from .test_decide import Visitor, decided
    from .test_execute import executed
    from .test_payment_links import checkouts, quoted

    created = await create_copy(client, replay_night=True)
    assert created.replay_id == (RECORDING if either else None)
    assert checkouts(created) == []
    [desk] = await rows_of(app, created.copy_id, select(Desk))
    opened = (await client.post("/sessions", json={"desk_slug": desk.slug, "kind": "visitor"})).json()
    visitor = Visitor(opened["state"]["session_id"], opened["session_token"])
    reviewer.answer = sample_week.SAMPLE_REVIEW
    quote_id = await quoted(client, visitor, ("deposit", 1))
    [quote] = await rows_of(app, created.copy_id, select(Quote).where(Quote.quote_id == quote_id))
    async with kernel_ctx(app) as ctx:
        ctx.bind(created.copy_id)
        version = await activation.active_version(ctx, desk.desk_id)
        assert activation.version_cap(version) == seed.RIVERA_MONEY_CAP_CENTS
        assert await payments.quote_unpayable(ctx, quote) is None
        assert await payments.open_link_fact(ctx, quote) is None
    decision = await decided(client, visitor, "native.payment_link", {"quote_id": quote_id})
    assert (decision.outcome, decision.card_ids, decision.action.amount_cents) == ("allow", ["rv-link"], 2_000)
    assert (await executed(client, visitor, decision)).state == "succeeded"
    [link] = await rows_of(app, created.copy_id, select(PaymentLink).where(PaymentLink.quote_id == quote_id))
    async with kernel_ctx(app) as ctx:
        ctx.bind(created.copy_id)
        assert (await payments.open_link_fact(ctx, quote)).fact_id == f"payment_link:{link.link_id}"
    response = await client.get(f"/payment_links/{link.token}")
    assert response.status_code == 200 and response.json()["state"] == "issued"
    response = await client.post(f"/payment_links/{link.token}/complete", json={})
    assert response.status_code == 200 and response.json()["state"] == "paid"
    assert len(checkouts(created)) == 1
    large_quote = await quoted(client, visitor, ("leak", 3), call_id="large-quote")
    held = await decided(client, visitor, "native.payment_link", {"quote_id": large_quote}, call_id="large-link")
    assert held.outcome == "hold" and "allow_person" not in held.answers
    await today_of(app, created, frozen_clock.now())
    assert (await reports_of(app, created, frozen_clock.now())).paid_cents == 2_000 * (2 if either else 1)


async def test_live_urgent_alerts_are_unchanged(either, app, client):
    from .test_decide import Visitor, decided
    from .test_execute import executed

    created = await create_copy(client, replay_night=True)
    assert created.replay_id == (RECORDING if either else None)
    [desk] = await rows_of(app, created.copy_id, select(Desk))
    opened = (await client.post("/sessions", json={"desk_slug": desk.slug, "kind": "visitor"})).json()
    visitor = Visitor(opened["state"]["session_id"], opened["session_token"])
    sample_call = seed.RIVERA_SAMPLE_WEEK[6].calls[0]
    for n in range(2):
        decision = await decided(client, visitor, sample_call.tool, sample_call.args, call_id=f"urgent-{n}")
        assert decision.outcome == "allow" and decision.card_ids == ["rv-urgent"]
        assert (await executed(client, visitor, decision)).state == "succeeded"
    alerts = await rows_of(app, created.copy_id, select(DemoInboxEntry).where(
        DemoInboxEntry.preview == "Urgent callback requested"))
    assert len(alerts) == 2
    live = await rows_of(app, created.copy_id, select(Handoff).where(Handoff.session_id == visitor.session_id))
    assert sorted(row.status for row in live) == ["done", "open"]
    assert all(row.callback_window is None for row in live)
    if either:
        [sample] = await rows_of(app, created.copy_id, select(Handoff).where(
            Handoff.session_id != visitor.session_id))
        assert sample.status == "done" and all(row.reason == sample.reason for row in live)


async def test_a_new_conversation_trips_the_breaker_as_on_an_empty_copy(either, app, client, reviewer):
    """The breaker counts a session's own strikes, so the week's closed sessions spend none of a new one's: the same
    three flagged requests pause it on a copy with the week as on one without."""
    created = await create_copy(client, replay_night=True)
    assert created.replay_id == (RECORDING if either else None)
    assert await strikes_until_paused(app, client, created, reviewer) == ["ai", "ai", "paused", "paused"]


async def test_the_week_uses_up_no_limit(week_on, app, client):
    """No execution (the web search cap), live/recent challenge (code limits), demo agent key, mandate reservation
    or owner alert of the week's own."""
    created = await create_copy(client, replay_night=True)
    for model in (Execution,):
        assert await rows_of(app, created.copy_id, select(model)) == []
    [challenge] = await rows_of(app, created.copy_id, select(VerificationChallenge))
    assert challenge.status == "consumed" and challenge.failed_at == []
    for model in (AgentKey, MandateReservation):
        assert await rows_of(app, created.copy_id, select(model)) == []
    inbox = [row.kind for row in await rows_of(app, created.copy_id, select(DemoInboxEntry))]
    assert [kind for kind in inbox if kind != "head_checkpoint"] == ["alert"]          # the seeded hold's alone


async def test_the_week_takes_no_open_time(either, app, client, frozen_clock):
    """Sample bookings are on past slots that are no calendar row, so a copy with the week has exactly the open
    future times one without it has: every slot the seed gives the next 14 days, none booked."""
    created = await create_copy(client, replay_night=True)
    now = frozen_clock.now()
    slots = await rows_of(app, created.copy_id, select(CalendarSlot))
    booked = {row.slot_id for row in await rows_of(app, created.copy_id, select(Booking).where(
        Booking.status == "confirmed"))}
    open_future = sorted(row.slot_id for row in slots if row.starts_at > now and row.slot_id not in booked)
    assert open_future == sorted(slot.slot_id for slot in seed.calendar_slots(now))
    assert len(booked) == (2 if either else 0)
    for row in await rows_of(app, created.copy_id, select(Booking)):
        assert row.starts_at < now


async def test_the_urgent_callback_is_done_without_an_inbox_entry(week_on, app, client):
    created = await create_copy(client, replay_night=True)
    ids = {row.session_id for row in await sample_sessions(app, created)}
    handoffs = await rows_of(app, created.copy_id, select(Handoff))
    assert [(row.kind, row.status) for row in handoffs] == [("callback", "done")]
    assert {row.session_id for row in handoffs} <= ids
    tools = {row.tool for row in await rows_of(app, created.copy_id, select(DecisionRow).where(
        DecisionRow.session_id.in_(ids)))}
    assert tools == {"native.quote", "native.book", "native.payment_link", "native.release_document",
                     "desk.emergency-callback", "native.capture_lead"}
    [handoff] = handoffs
    assert (handoff.callback_window, handoff.window_start, handoff.window_end) == (None, None, None)
    assert handoff.reason == "Sam · (510) 555-0178 · Water pouring from under the kitchen sink; cannot find the shut-off"
    [callback] = await rows_of(app, created.copy_id, select(DecisionRow).where(
        DecisionRow.tool == "desk.emergency-callback"))
    assert (callback.state, callback.card_ids, callback.policy_ids) == ("executed", ["rv-urgent"], ["A.auto.rv-urgent"])
    [session] = await rows_of(app, created.copy_id, select(ActorSession).where(
        ActorSession.session_id == handoff.session_id))
    [handled] = [entry for entry in (await ledger_page(client, created)).entries
                 if entry.event.summary.get("refs") == [handoff.handoff_id]]
    assert datetime.fromisoformat(marked(handled)["at"]) == session.created_at + timedelta(minutes=15)
    inbox = await rows_of(app, created.copy_id, select(DemoInboxEntry))
    assert [row.decision_id for row in inbox if row.kind == "alert"] == [created.seeded_chat.decision.decision_id]


async def test_copy_creation_with_the_week_stays_under_three_seconds(week_on, app, client):
    await create_copy(client, replay_night=True)            # warm: the first copy loads the policy engine
    started = wall.perf_counter()
    created = await create_copy(client, replay_night=True)
    elapsed = wall.perf_counter() - started
    assert created.replay_id == RECORDING
    assert elapsed < 3.0, elapsed


async def test_a_week_that_cant_be_written_whole_leaves_a_live_copy(week_on, app, client, monkeypatch, caplog):
    async def fail(*args, **kwargs):
        raise sample_week.SampleWeekRefused("test")

    monkeypatch.setattr(sample_week, "write", fail)
    created = await create_copy(client, replay_night=True)
    assert (created.replayed_messages, created.replay_id) == ([], None)
    assert await sample_sessions(app, created) == []
    assert created.seeded_chat is not None
    assert "sample_week_failed" in caplog.text
