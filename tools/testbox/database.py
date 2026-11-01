"""Create a lane DB from a migrated template, with only development role passwords."""
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit

import psycopg
from psycopg import sql

base, template, database, schema = sys.argv[1:]
stamp = Path(base) / "schema-hash"
# Reach Postgres where the lane's database URLs do (desk_tools.testbox.DATABASE_HOST), not by loopback.
lane = urlsplit(os.environ["ADMIN_DATABASE_URL"])
admin = f"postgresql://desk_admin:change-me-admin@{lane.hostname}:{lane.port}/postgres"
with psycopg.connect(admin, autocommit=True) as conn:
    existing = {row[0] for row in conn.execute("SELECT datname FROM pg_database WHERE datname = ANY(%s)", [[template, database]])}
    if template not in existing:
        conn.execute(sql.SQL("CREATE DATABASE {} OWNER desk_admin").format(sql.Identifier(template)))
        try:
            env = dict(os.environ, ADMIN_DATABASE_URL=os.environ["ADMIN_DATABASE_URL"].rsplit("/", 1)[0] + "/" + template)
            subprocess.run([str(Path.cwd() / "backend/.venv/bin/alembic"), "upgrade", "head"], cwd="backend", env=env, check=True)
            subprocess.run(["make", "db-roles", f"DB_HOST={lane.hostname}", f"DB_PORT={lane.port}", "DB_NAME=" + template], env=env, check=True)
        except BaseException:
            conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(template)))
            raise
    if not stamp.exists() or stamp.read_text() != schema or database not in existing:
        conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(database)))
        conn.execute(sql.SQL("CREATE DATABASE {} WITH TEMPLATE {} OWNER desk_admin").format(sql.Identifier(database), sql.Identifier(template)))
        stamp.write_text(schema)
        print(f"testbox: database {database} cloned from migrated template", file=sys.stderr, flush=True)
