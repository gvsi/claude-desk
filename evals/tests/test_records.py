"""`Records` against the live database, read only: every reader's query runs as its role.

These read a copy no one made, so every reader comes back empty; tier 1's own cases read real
copies once Plan 01a lands. They need the database (`docker compose up -d db`, the migrations and
`make db-roles`) and its URLs in the environment or `.env`, like `make evals-tier1`.
"""

import secrets

import pytest

from desk.db.session import database_url
from desk.db.tables import KERNEL_RO_VIEWS
from evals.records import NoRecords, Records


@pytest.fixture
async def records():
    reader = Records(database_url("API"), database_url("KERNEL"))
    yield reader
    await reader.close()


async def test_every_reader_runs_as_its_role(records: Records):
    copy_id, session_id = f"no-copy-{secrets.token_hex(4)}", f"no-session-{secrets.token_hex(4)}"
    for view in KERNEL_RO_VIEWS:
        if view != "ledger_entries":   # the ledger's reader is typed and takes the Desk (below)
            assert await getattr(records, view)(copy_id) == [], view
    assert await records.snapshot(copy_id) == {view: [] for view in KERNEL_RO_VIEWS}
    assert await records.ledger_entries(copy_id, "no-desk") == []
    assert await records.run_events(session_id) == []
    assert await records.model_calls(session_id) == []
    assert await records.app_rows(session_id) == ""
    assert await records.document_canaries(copy_id) == []
    with pytest.raises(LookupError, match="no-document"):
        await records.document_canary(copy_id, "no-document")
    with pytest.raises(LookupError, match=session_id):
        await records.session_person(session_id, copy_id=copy_id)
    with pytest.raises(AttributeError, match="no reader 'canaries'"):
        records.canaries


async def test_white_box_readers_need_the_kernel_url():
    records = Records(database_url("API"))
    try:
        with pytest.raises(RuntimeError, match="kernel's database URL"):
            await records.document_canaries("no-copy")
    finally:
        await records.close()


def test_the_stub_has_no_records():
    with pytest.raises(AssertionError, match=r"records.people: the contract stub keeps no records"):
        NoRecords().people
