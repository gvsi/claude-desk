"""The business definition is readable through the copy-scoped view, never the tool profile."""

from pathlib import Path

import psycopg
from alembic import command
from alembic.config import Config

from desk.db.session import database_url, libpq_url
from desk.db.tables import KERNEL_RO_COLUMNS


def test_business_view_preserves_copy_security():
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(config, "head")
    with psycopg.connect(libpq_url(database_url("ADMIN"))) as conn:
        columns = conn.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = 'kernel_ro'"
                               " AND table_name = 'tools' ORDER BY ordinal_position").fetchall()
        assert columns[-1] == ("business",)
        assert tuple(row[0] for row in columns) == KERNEL_RO_COLUMNS["tools"]
        owner, options = conn.execute("SELECT pg_get_userbyid(relowner), reloptions FROM pg_class"
                                      " WHERE oid = 'kernel_ro.tools'::regclass").fetchone()
        assert owner == "desk_ro_owner"
        assert "security_barrier=true" in options
        definition = conn.execute("SELECT pg_get_viewdef('kernel_ro.tools'::regclass)").fetchone()[0]
        assert "desk.copy_id" in definition
        assert "profile -> 'business'" in definition
        assert not conn.execute("SELECT has_column_privilege('desk_api', 'kernel.tools', 'profile', 'SELECT')").fetchone()[0]


def test_api_tool_row_accepts_business_definition():
    from desk.api.schemas import ToolRow

    row = ToolRow(tool="desk.enquiry", source="business", effects=["change"], reversible=True,
                  status="needs_review", description_confirmed="Take details.", definition_sha256="a" * 64,
                  pending_definition_text=None, pending_sha256=None, cards=[],
                  business={"title": "Enquiry", "description": "Take details.",
                            "config": {"block": "intake", "questions": ["What do you need?"]}})
    assert row.business.title == "Enquiry"
    assert row.business.config.block == "intake"


async def test_business_suggested_card_uses_the_business_title():
    from desk.api.rules import _suggested_card

    card = await _suggested_card(None, "desk.enquiry", ["change"], [], 0, label="Customer enquiry")
    assert card.applies_to == "desk.enquiry"
    assert "Customer enquiry" in card.reason
