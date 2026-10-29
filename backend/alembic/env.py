"""Alembic environment: migrations run online as desk_admin, which owns every schema.

A caller that runs migrations itself (`desk.ops.admin`) passes its own connection in
`config.attributes["connection"]` and owns that connection's transaction and its process's logging;
otherwise this connects with ADMIN_DATABASE_URL and logs as alembic.ini says.
"""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import Connection, create_engine, pool

from desk.db.models import Base
from desk.db.session import database_url

config = context.config
if config.config_file_name is not None and "connection" not in config.attributes:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connection = config.attributes.get("connection")
    if connection is not None:
        run_migrations(connection)
        return
    engine = create_engine(database_url("ADMIN"), poolclass=pool.NullPool)
    with engine.connect() as connection:
        run_migrations(connection)


if context.is_offline_mode():
    raise SystemExit("Offline migrations aren't supported: 0001_core runs SQL scripts on a live connection.")
run_migrations_online()
