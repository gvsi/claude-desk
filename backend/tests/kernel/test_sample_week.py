"""The sample week: a hosted copy opens on a hand-written week of finished conversations (`seed.seed_sample_week`).

The kernel writes it only with `SAMPLE_WEEK=1` in its environment and a copy request that asks for history
(`replay_night`, which the hosted API sends). It is history and nothing else: every row terminal, no person, every
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
from desk.db.models import (ActorSession, AgentKey, Approval, Booking, CalendarSlot, DemoInboxEntry, Desk, Execution,
                             Fact, Handoff, Lead, MandateReservation, Person, Quote, VerificationChallenge)
from desk.db.models import Decision as DecisionRow
from desk.db.session import API_CONNECT_OPTIONS, database_url
from desk.kernel_service import auth, decide, reply_check, sample_week, seed

from .helpers import rows_of, verify_session
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
    assert len({day.date for day in week.days if day.bookings}) >= 3
    assert week.bookings >= 3 and week.booked_cents > 0
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
        assert local_today - timedelta(days=6) <= shown.astimezone(TZ).date() < local_today
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
                                                      "desk_data"}
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
        prose = [block for block in verdict.blocks if block.kind == "prose"]
        assert len(prose) == 1 and reply_check.scan_prose(
            prose[0].text, booking_card=any(block.template == "booking_confirmed" for block in verdict.blocks),
            callback_card=any(block.template == "callback_confirmed" for block in verdict.blocks)) == []
        templates |= {block.template for block in verdict.blocks if block.kind == "card"}
    assert templates == {"quote", "booking_confirmed", "callback_confirmed"}
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
    assert {row.status for row in await rows_of(app, created.copy_id, select(Quote))} == {"expired"}
    assert {row.status for row in await rows_of(app, created.copy_id, select(Handoff))} == {"done"}
    [approval] = await rows_of(app, created.copy_id, select(Approval))
    assert (approval.answer, approval.nonce, approval.binding_sha256) == ("deny_once", None, None)
    assert approval.consumed_at is not None
    facts = await rows_of(app, created.copy_id, select(Fact).where(Fact.session_id.in_(ids)))
    assert {(row.kind, row.status) for row in facts} == {("quote", "expired"), ("booking", "committed"),
                                                         ("handoff", "expired")}
    # nothing that runs, waits or pays: no execution, challenge or Demo inbox entry of the week
    assert await rows_of(app, created.copy_id, select(Execution)) == []
    assert await rows_of(app, created.copy_id, select(VerificationChallenge)) == []
    inbox = await rows_of(app, created.copy_id, select(DemoInboxEntry))
    assert [row.kind for row in inbox if row.kind != "head_checkpoint"] == ["alert"]   # the seeded hold's alone


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


# ---- No person -----------------------------------------------------------------------------------------------------

SEEDED_PEOPLE = ("Dana", "Whitfield", "Bob", "Okafor", "dana@", "bob@")


def test_the_written_week_names_no_one():
    """The sample's own words name no seeded person, and neither the owner nor the business, whose names come from
    the seed's own values (so renaming the seed renames them); its replies pass the reply check's prose scan."""
    business, _ = seed.rivera_seed(datetime(2026, 10, 30, tzinfo=UTC))
    banned = (*SEEDED_PEOPLE, *business.owner_display_name.split(), *business.name.split(), "Maria", "Rivera",
              "Mike", "Turner")
    for sample in seed.RIVERA_SAMPLE_WEEK:
        texts = [sample.said, sample.prose, *(str(call.args) for call in sample.calls)]
        for text in texts:
            assert not [name for name in banned if name.lower() in text.lower() and name not in ("Plumbing",)], text
        assert reply_check.scan_prose(sample.prose, booking_card="booking_confirmed" in sample.cards,
                                      callback_card="callback_confirmed" in sample.cards) == [], sample.prose


async def test_the_week_carries_no_person(week_on, app, client):
    created = await create_copy(client, replay_night=True)
    sessions = await sample_sessions(app, created)
    ids = {row.session_id for row in sessions}
    for row in sessions:
        assert (row.person_id, row.verified, row.assurance, row.agent_key_id, row.mandate_id) == (
            None, False, "none", None, None)
    for row in await rows_of(app, created.copy_id, select(Fact).where(Fact.session_id.in_(ids))):
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
    template = {"quote": "quote", "booking": "booking_confirmed", "handoff": "callback_confirmed"}
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


async def test_a_new_conversation_trips_the_breaker_as_on_an_empty_copy(either, app, client, reviewer):
    """The breaker counts a session's own strikes, so the week's closed sessions spend none of a new one's: the same
    three flagged requests pause it on a copy with the week as on one without."""
    created = await create_copy(client, replay_night=True)
    assert created.replay_id == (RECORDING if either else None)
    assert await strikes_until_paused(app, client, created, reviewer) == ["ai", "ai", "paused", "paused"]


async def test_the_week_uses_up_no_limit(week_on, app, client):
    """Nothing the kernel counts over a window or per Desk is spent by the week: no execution (the web search cap),
    verification challenge (code limits), demo agent key, mandate reservation or owner alert of its own."""
    created = await create_copy(client, replay_night=True)
    for model in (Execution, VerificationChallenge):
        assert await rows_of(app, created.copy_id, select(model)) == []
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
    assert len(booked) == (3 if either else 0)
    for row in await rows_of(app, created.copy_id, select(Booking)):
        assert row.starts_at < now


async def test_the_week_leaves_no_open_handoff_and_no_urgent_call(week_on, app, client):
    created = await create_copy(client, replay_night=True)
    ids = {row.session_id for row in await sample_sessions(app, created)}
    handoffs = await rows_of(app, created.copy_id, select(Handoff))
    assert [(row.kind, row.status) for row in handoffs] == [("callback", "done")]
    assert {row.session_id for row in handoffs} <= ids
    tools = {row.tool for row in await rows_of(app, created.copy_id, select(DecisionRow).where(
        DecisionRow.session_id.in_(ids)))}
    assert tools == {"native.quote", "native.book", "native.payment_link", "native.request_callback",
                     "native.capture_lead"}
    assert "emergency" not in repr(seed.RIVERA_SAMPLE_WEEK)


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
