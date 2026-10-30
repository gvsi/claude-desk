"""Knowledge: the API's view of an item that holds document text shows no title or text.

`labels.store_knowledge` stores a knowledge item holding a document's canary for the owner alone,
and ledgers that it did, in the same transaction as the item: `desk_data` `{part: "knowledge",
item_id, owner_only_forced: true}`. Such an item's title and text hold private document text, and
no kernel_ro view shows document bodies or canaries, so `kernel_ro.knowledge_items` now shows
`title` and `text` as NULL for it. Every other column, and every other item, reads as before.

The view finds whether an item was forced in the latest knowledge entry the ledger holds for it.
It shows the title and text only when that entry says `owner_only_forced: false`, so an item with
no such entry (one not stored through `store_knowledge`) shows neither: the view fails closed. It
reads only columns desk_ro_owner may already SELECT (the ledger's are kernel_ro.ledger_entries's),
in rows its `copy_read` policies admit, so desk_ro_owner's grants and row security stay exactly as
they were. A flag column on the table would need a grant beyond the columns the views show.

CREATE OR REPLACE VIEW would need the admin to own the view, so the view is dropped and created
again as 0002_copy_isolation, 0005_kernel_ro_owner and 01b_3b_money_cap leave a view: a
security_barrier view filtered on the transaction's `desk.copy_id`, owned by desk_ro_owner and
readable by desk_api alone. The title and text are scalar subqueries in the select list, so the
view still reads one table and a write through it is refused for want of privilege, as before.
Dropping without CASCADE fails if anything depends on it.

Any admin role can run this, superuser or not (a managed Postgres's admin isn't): the grant runs
first, while the admin owns the view; the admin owns kernel_ro, so it may drop the view; then
`_change_owner` lends the admin SET on desk_ro_owner, and desk_ro_owner CREATE on the schema, for
the ownership change alone, and takes both back.

Revision ID: 01b_5b_knowledge_view
Revises: 01b_3b_money_cap
"""

from alembic import op

revision = "01b_5b_knowledge_view"
down_revision = "01b_3b_money_cap"
branch_labels = None
depends_on = None

CURRENT_COPY = "nullif(current_setting('desk.copy_id', true), '')"

# Whether the latest knowledge entry on the item's Desk ledger says it wasn't forced owner-only.
SHOWN = """(SELECT e.event #> '{summary,owner_only_forced}' FROM kernel.ledger_entries e
            WHERE e.desk_id = k.desk_id AND e.copy_id = k.copy_id
              AND e.event @> jsonb_build_object('kind', 'desk_data', 'summary',
                                                jsonb_build_object('part', 'knowledge', 'item_id', k.item_id))
            ORDER BY e.seq DESC LIMIT 1) = 'false'::jsonb"""

# The view's select list before and after this revision, frozen here (the columns are the same).
BEFORE = "item_id, copy_id, desk_id, source, title, text, readers"
AFTER = (f"k.item_id, k.copy_id, k.desk_id, k.source, CASE WHEN {SHOWN} THEN k.title END AS title,"
         f" CASE WHEN {SHOWN} THEN k.text END AS text, k.readers")


def _script(sql: str) -> None:
    """Run a multi-statement SQL script as-is (no parameters), inside the migration's transaction."""
    op.get_bind().connection.driver_connection.execute(sql)


def _change_owner(role: str, schema: str, statements: str) -> None:
    """Run `statements`, which make `role` the owner of objects in `schema`, as any admin role.

    A superuser may change an owner as it is. Any other admin (one with CREATEROLE, which Postgres 16
    gives ADMIN OPTION on the roles it creates, but not SET) is lent SET on `role`, and `role` CREATE
    on `schema`, for these statements only. Both are taken back after, so the admin and `role` end
    as a superuser's run leaves them.
    """
    _script(f"""
        GRANT {role} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
        GRANT CREATE ON SCHEMA {schema} TO {role};
        {statements}
        REVOKE CREATE ON SCHEMA {schema} FROM {role};
        REVOKE {role} FROM CURRENT_USER;
    """)


def _recreate_view(select_list: str) -> None:
    _script(f"""
        DROP VIEW kernel_ro.knowledge_items;
        CREATE VIEW kernel_ro.knowledge_items WITH (security_barrier = true) AS
            SELECT {select_list} FROM kernel.knowledge_items k WHERE k.copy_id = {CURRENT_COPY};
        GRANT SELECT ON kernel_ro.knowledge_items TO desk_api;
    """)
    _change_owner("desk_ro_owner", "kernel_ro", "ALTER VIEW kernel_ro.knowledge_items OWNER TO desk_ro_owner;")


def upgrade() -> None:
    _recreate_view(AFTER)


def downgrade() -> None:
    _recreate_view(BEFORE)
