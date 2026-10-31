"""The API's tables after Plan 02a: `api_tables` is applied to the hosted database as it stands on `main`, so it is
never edited again; every change Plan 02b makes to the API's tables is a migration of its own, `api_owner`, revising
`main`'s head (`0012_inbox_decision_id`, which revises `api_tables`), and `api_replay` revises `api_owner`.

The upgrade is tried from `main`'s head with rows already in `app.messages`: they come through it unchanged, and a
take-over, a whisper, a hand-back and a reply the kernel's check stops then store their rows on the upgraded database.
"""

import hashlib
from collections.abc import AsyncIterator, Callable
from pathlib import Path

import psycopg
import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import NullPool, create_engine, func, select
from sqlalchemy.exc import OperationalError

from desk.api.main import create_app
from desk.db.session import database_url, libpq_url
from tests.api.fakes import ScriptedModel, response
from tests.api.test_loop_fencing import Kernel
from tests.api.test_public_chat import HOURS, Stream, cookie, events_path, reply, types
from tests.api.test_stopped_drafts import DRAFT, REWRITE
from tests.api.test_take_over import message, mode_change, new_chat

BACKEND = Path(__file__).resolve().parents[2]
MAIN_HEAD = "0012_inbox_decision_id"
# A step waits this long for a lock another transaction holds, then fails, so a stray transaction fails the test
# instead of hanging the run.
LOCK_TIMEOUT = "10s"
IDLE_STRAY = "30s"     # the guard test's stray transaction is ended after this long idle, whatever happens
# `api_tables.py` as `main` has it, applied to the hosted database: a change to it would never reach that database.
DEPLOYED_TABLES_DIGEST = "b4c00cd852b9ae1f5b48a7e2639d2d1892c1128adaf1afe181a80b3ca083088a"
# Rows written at `main`'s head, in its columns: one of each kind a transcript held before Plan 02b.
MAIN_ROWS = [
    ("m-visitor", "visitor_text", "visitor", "public", "Do you open on Saturdays?", None, None, None),
    ("m-assistant", "model_assistant", "claude", "model", None, '[{"text": "x", "type": "text"}]', 0, None),
    ("m-delivered", "delivered", "claude", "public", None, None, None, 1),
    ("m-whisper", "whisper", "owner", "owner", "Mention the Saturday hours.", None, None, None),
    ("m-triage", "triage", "api", "owner", None, None, None, None),
]


def alembic_config() -> Config:
    """The repository's migrations, with no config file, so Alembic leaves the test run's logging alone."""
    config = Config()
    config.set_main_option("script_location", str(BACKEND / "alembic"))
    return config


def migrate(step: Callable[[Config, str], None], revision: str, *, lock_timeout: str = LOCK_TIMEOUT) -> None:
    """One Alembic step (`command.downgrade` or `command.upgrade`) to `revision`, as desk_admin on a connection of its
    own, committed at the end (env.py migrates on `config.attributes["connection"]`), whose transaction waits at most
    `lock_timeout` for any lock: a lock another transaction holds fails the step, never hangs it."""
    config = alembic_config()
    engine = create_engine(database_url("ADMIN"), poolclass=NullPool)
    try:
        with engine.begin() as connection:
            connection.execute(select(func.set_config("lock_timeout", lock_timeout, True)))
            config.attributes["connection"] = connection
            step(config, revision)
    finally:
        engine.dispose()


def test_api_tables_is_left_as_main_applied_it():
    path = BACKEND / "alembic" / "versions" / "api_tables.py"
    assert hashlib.sha256(path.read_bytes()).hexdigest() == DEPLOYED_TABLES_DIGEST, (
        "api_tables is applied to the hosted database: change the API's tables in a new migration instead")


def test_api_owner_revises_main_head_and_api_replay_revises_it():
    scripts = ScriptDirectory.from_config(alembic_config())
    assert scripts.get_revision("api_owner").down_revision == MAIN_HEAD
    assert scripts.get_revision("api_replay").down_revision == "api_owner"
    assert scripts.get_heads() == ["api_replay"]


def test_a_lock_another_transaction_holds_fails_a_step_instead_of_hanging(db):
    # A transaction left open on app.messages (a stray connection) fails the step once its lock timeout runs out, and
    # the step's own transaction rolls back whole, so the database stays at head. Were the timeout gone, the stray
    # would be ended after IDLE_STRAY and the step would pass, failing this test rather than hanging the run.
    try:
        with psycopg.connect(libpq_url(database_url("ADMIN"))) as stray:
            stray.execute(f"SET idle_in_transaction_session_timeout = '{IDLE_STRAY}'")
            stray.execute("LOCK TABLE app.messages IN ACCESS SHARE MODE")
            with pytest.raises(OperationalError, match="lock timeout"):
                migrate(command.downgrade, MAIN_HEAD, lock_timeout="200ms")
            stray.rollback()
    finally:
        migrate(command.upgrade, "head")                       # nothing to do at head
    assert db.execute("SELECT version_num FROM alembic_version").fetchall() == [("api_replay",)]


def kept(admin: psycopg.Connection) -> list[tuple]:
    return admin.execute("SELECT message_id, kind, author, visibility, text, model_content::text, generation,"
                         " event_seq, replay_id FROM app.messages WHERE copy_id = 'main-copy' ORDER BY n").fetchall()


@pytest.fixture
def upgraded(db: psycopg.Connection) -> list[tuple]:
    """The database taken back to `main`'s head, `MAIN_ROWS` written there, then upgraded to head again; what the
    upgrade kept of them."""
    migrate(command.downgrade, MAIN_HEAD)
    try:
        for message_id, kind, author, visibility, words, content, generation, event_seq in MAIN_ROWS:
            db.execute("INSERT INTO app.messages (message_id, copy_id, desk_id, session_id, kind, author, visibility,"
                       " text, model_content, generation, event_seq) VALUES (%s, 'main-copy', 'main-desk',"
                       " 'main-session', %s, %s, %s, %s, %s::jsonb, %s, %s)",
                       (message_id, kind, author, visibility, words, content, generation, event_seq))
    finally:
        migrate(command.upgrade, "head")
    return kept(db)


@pytest.fixture
def model() -> ScriptedModel:
    return ScriptedModel()


@pytest.fixture
def kernel(fake) -> Kernel:
    return Kernel(fake)


@pytest.fixture
async def app(upgraded, db, kernel, api_settings, clock, model) -> AsyncIterator[FastAPI]:
    """The API on FakeKernel and the scripted model, started only once the database is upgraded."""
    app = create_app(api_settings, kernel_transport=kernel, model=model, clock=clock,
                     jobs_connector=InMemoryConnector())
    async with app.router.lifespan_context(app):
        yield app


async def test_upgrade_from_main_keeps_its_rows_and_stores_the_owner_tools_rows(upgraded, app, browser, fake,
                                                                                 kernel_http, model, db):
    # The rows written at main's head came through the upgrade unchanged, none of them recorded history.
    assert upgraded == [(*row, None) for row in MAIN_ROWS]

    # The owner takes over, whispers and hands back; the turn the hand-back wakes drafts a reply the check stops,
    # then a rewrite that goes out.
    chat = await new_chat(app, browser, kernel_http, fake)
    assert (await mode_change(chat, "takeover", 0)).status_code == 200
    assert (await message(chat, "Keep it short when you're back.", "whisper")).status_code == 200
    fake.violation("promise_word")
    model.add(response(reply(DRAFT, HOURS)), response(reply(REWRITE)))
    async with Stream(app, events_path(chat.slug), headers=[cookie(chat.token)]) as stream:
        assert (await mode_change(chat, "handback", 1)).status_code == 200
        await stream.until(lambda events: "turn_end" in types(events))
    await app.state.runtime.runner.drain()

    stored = [kind for (kind,) in db.execute("SELECT kind FROM app.messages WHERE session_id = %s ORDER BY n",
                                             (chat.session_id,))]
    assert {"owner_joined", "whisper", "owner_left", "stopped_draft", "delivered"} <= set(stored)
    owner_items = (await chat.owner.get(chat.path())).json()["items"]
    assert [item["kind"] for item in owner_items] == [
        "owner_joined", "whisper", "owner_left", "stopped_draft", "delivered"]
    assert kept(db) == upgraded
