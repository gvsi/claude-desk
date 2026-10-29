"""Alembic environment: migrations run online as desk_admin, which owns every schema."""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

from desk.db.models import Base
from desk.db.session import database_url

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_online() -> None:
    engine = create_engine(database_url("ADMIN"), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    raise SystemExit("Offline migrations aren't supported: 0001_core runs SQL scripts on a live connection.")
run_migrations_online()
