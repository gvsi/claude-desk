"""FakeKernel's read-only tables: the kernel_ro views, rebuilt as tables the fake writes.

The API reads kernel data only through the `kernel_ro` views (master plan, "Data model and database
roles"), which select `KERNEL_RO_COLUMNS` from the kernel's tables and admit only the copy the
transaction set in `desk.copy_id`. `create_fake_ro(conn)` builds schema `fake_kernel_ro` with one table
per view: the master's columns in its order, each with the type the migrated `kernel_ro` view has, and
the same copy rule as row-level security for `desk_api`, which may only SELECT. A read that sets no
copy finds nothing here too, so a test can't pass on a read the real views would refuse. FakeKernel
writes the rows as `desk_admin` through `FakeRO.write` before it answers.
"""

from datetime import datetime

import psycopg
from psycopg import sql
from psycopg.rows import tuple_row
from psycopg.types.json import Jsonb

from desk.db.tables import KERNEL_RO_COLUMNS, KERNEL_RO_VIEWS

FAKE_RO_SCHEMA = "fake_kernel_ro"
CURRENT_COPY = "nullif(current_setting('desk.copy_id', true), '')"

# Each view's key, as its kernel table's primary key (0001_core): ids repeat across Desks where the
# key includes desk_id.
RO_KEYS: dict[str, tuple[str, ...]] = {
    "businesses": ("business_id",), "desks": ("desk_id",), "sessions": ("session_id",), "people": ("person_id",),
    "mandates": ("mandate_id",), "documents": ("document_id",), "leads": ("lead_id",), "tools": ("desk_id", "tool"),
    "price_items": ("desk_id", "item_id"), "calendar_slots": ("desk_id", "slot_id"),
    "notification_prefs": ("desk_id",), "decisions": ("decision_id",), "approvals": ("approval_id",),
    "actions": ("action_id",), "policy_versions": ("desk_id", "version"), "facts": ("desk_id", "fact_id"),
    "knowledge_items": ("desk_id", "item_id"), "quotes": ("quote_id",), "bookings": ("booking_id",),
    "payment_links": ("link_id",), "handoffs": ("handoff_id",), "ledger_entries": ("desk_id", "seq"),
}
assert set(RO_KEYS) == set(KERNEL_RO_VIEWS)


def view_types(conn: psycopg.Connection, schema: str, view: str) -> dict[str, str]:
    """Column name -> Postgres type of `schema.view`, in column order."""
    with conn.cursor(row_factory=tuple_row) as cursor:
        rows = cursor.execute(
            "SELECT a.attname, format_type(a.atttypid, a.atttypmod) FROM pg_attribute a"
            " WHERE a.attrelid = %s::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
            (f"{schema}.{view}",),
        ).fetchall()
    return dict(rows)


class FakeRO:
    """Writes FakeKernel's rows into fake_kernel_ro, one transaction per answer."""

    def __init__(self, conn: psycopg.Connection, types: dict[str, dict[str, str]]):
        self._conn, self._types = conn, types
        self._upserts = {view: self._upsert_sql(view) for view in KERNEL_RO_VIEWS}

    @staticmethod
    def _upsert_sql(view: str) -> sql.Composed:
        columns, keys = KERNEL_RO_COLUMNS[view], RO_KEYS[view]
        upsert = "INSERT INTO {table} ({columns}) VALUES ({values}) ON CONFLICT ({keys}) DO UPDATE SET {sets}"
        return sql.SQL(upsert).format(
            table=sql.Identifier(FAKE_RO_SCHEMA, view),
            columns=sql.SQL(", ").join(map(sql.Identifier, columns)),
            values=sql.SQL(", ").join(sql.Placeholder() * len(columns)),
            keys=sql.SQL(", ").join(map(sql.Identifier, keys)),
            sets=sql.SQL(", ").join(sql.SQL("{0} = EXCLUDED.{0}").format(sql.Identifier(column))
                                    for column in columns if column not in keys),
        )

    def _value(self, view: str, column: str, value: object) -> object:
        if value is not None and self._types[view][column] == "jsonb":
            return Jsonb(value)
        return value

    def write(self, rows: dict[str, list[dict]]) -> None:
        """Insert or replace each row (a dict of exactly its view's columns), by view."""
        with self._conn.transaction(), self._conn.cursor() as cursor:
            for view, batch in rows.items():
                columns = KERNEL_RO_COLUMNS[view]
                for row in batch:
                    if set(row) != set(columns):
                        raise ValueError(f"a {view} row has exactly the view's columns")
                values = [tuple(self._value(view, column, row[column]) for column in columns) for row in batch]
                cursor.executemany(self._upserts[view], values)

    def delete(self, keys: dict[str, list[tuple]]) -> None:
        """Remove each row by its view's key (`RO_KEYS`), by view: a part a `PUT` replaced, say."""
        with self._conn.transaction(), self._conn.cursor() as cursor:
            for view, batch in keys.items():
                where = sql.SQL(" AND ").join(sql.SQL("{} = %s").format(sql.Identifier(key)) for key in RO_KEYS[view])
                statement = sql.SQL("DELETE FROM {} WHERE {}").format(sql.Identifier(FAKE_RO_SCHEMA, view), where)
                cursor.executemany(statement, batch)


def create_fake_ro(conn: psycopg.Connection) -> FakeRO:
    """Rebuild schema fake_kernel_ro (as desk_admin, on a migrated database) and return its writer."""
    types = {}
    for view in KERNEL_RO_VIEWS:
        real = view_types(conn, "kernel_ro", view)
        missing = [column for column in KERNEL_RO_COLUMNS[view] if column not in real]
        if missing:
            raise RuntimeError(f"kernel_ro.{view} lacks {missing}: migrate the database first")
        types[view] = {column: real[column] for column in KERNEL_RO_COLUMNS[view]}
    schema = sql.Identifier(FAKE_RO_SCHEMA)
    with conn.transaction():
        conn.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(schema))
        conn.execute(sql.SQL("CREATE SCHEMA {}").format(schema))
        for view in KERNEL_RO_VIEWS:
            table = sql.Identifier(FAKE_RO_SCHEMA, view)
            conn.execute(sql.SQL("CREATE TABLE {table} ({columns}, PRIMARY KEY ({keys}))").format(
                table=table,
                columns=sql.SQL(", ").join(sql.SQL("{} {}").format(sql.Identifier(column), sql.SQL(kind))
                                           for column, kind in types[view].items()),
                keys=sql.SQL(", ").join(map(sql.Identifier, RO_KEYS[view])),
            ))
            conn.execute(sql.SQL("ALTER TABLE {} ENABLE ROW LEVEL SECURITY").format(table))
            conn.execute(sql.SQL("CREATE POLICY copy_read ON {} FOR SELECT TO desk_api USING (copy_id = {})").format(
                table, sql.SQL(CURRENT_COPY)))
        conn.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO desk_api").format(schema))
        conn.execute(sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA {} TO desk_api").format(schema))
    return FakeRO(conn, types)


def mark_replayed(conn: psycopg.Connection, desk_id: str, seq: int, at: datetime, *,
                  recording: str = "night-marked-by-hand") -> None:
    """Mark the Desk's ledger entry `seq` in fake_kernel_ro as the kernel's replay marks one (Plan 01d: its
    `summary.replayed`, shown at `at`): recorded history a test makes by hand, where the recorded night has none of
    its kind. Fails unless it marked exactly that one entry."""
    update = sql.SQL("UPDATE {} SET event = jsonb_set(event, '{{summary,replayed}}', %s)"
                     " WHERE desk_id = %s AND seq = %s").format(sql.Identifier(FAKE_RO_SCHEMA, "ledger_entries"))
    marked = conn.execute(update, (Jsonb({"at": at.isoformat(), "recording": recording}), desk_id, seq))
    assert marked.rowcount == 1, f"no ledger entry {seq} of {desk_id} to mark replayed"
