"""The lane database helper: a warm check preserves data in one catalog query, and it reaches
Postgres over the lane link, as the lane's database URLs do."""
from pathlib import Path
import runpy
import sys
from types import SimpleNamespace
from urllib.parse import urlsplit

from desk_tools.testbox import DATABASE_HOST, DATABASE_PORT, remote_environment

HELPER = Path(__file__).parents[1] / 'testbox/database.py'


class Rows:
    def __init__(self, names):
        self.names = names

    def __iter__(self):
        return iter([(name,) for name in self.names])


def fake_psycopg(monkeypatch, existing, connected, queries):
    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, query, params=None):
            queries.append(query)
            return Rows(existing)

    def connect(url, **kwargs):
        connected.append(url)
        return Connection()

    sql = SimpleNamespace(SQL=lambda text: SimpleNamespace(format=lambda *names: text.format(*names)), Identifier=str)
    monkeypatch.setitem(sys.modules, 'psycopg', SimpleNamespace(connect=connect, sql=sql))
    monkeypatch.setitem(sys.modules, 'psycopg.sql', sql)


def run_helper(monkeypatch, tmp_path):
    env = remote_environment('example', '/srv/testbox/lanes/example/repo')
    monkeypatch.setenv('ADMIN_DATABASE_URL', env['ADMIN_DATABASE_URL'])
    monkeypatch.setattr(sys, 'argv', [str(HELPER), str(tmp_path), 'template_schema', 'lane_example', 'schema'])
    runpy.run_path(str(HELPER), run_name='__main__')


def test_warm_database_check_preserves_lane_data_with_one_catalog_query(tmp_path, monkeypatch):
    (tmp_path / 'schema-hash').write_text('schema')
    queries, connected = [], []
    fake_psycopg(monkeypatch, ['template_schema', 'lane_example'], connected, queries)
    run_helper(monkeypatch, tmp_path)
    assert len(queries) == 1 and queries[0].startswith('SELECT'), 'A warm run must not recreate its database'
    assert (tmp_path / 'schema-hash').read_text() == 'schema'


def test_the_helper_reaches_postgres_where_the_lane_environment_does(tmp_path, monkeypatch):
    """Its admin connection and `make db-roles` use the lane link too, not the loopback forwarder."""
    queries, connected, commands = [], [], []
    fake_psycopg(monkeypatch, [], connected, queries)
    monkeypatch.setattr('subprocess.run', lambda command, **kwargs: commands.append(command))
    run_helper(monkeypatch, tmp_path)
    assert [(urlsplit(url).hostname, urlsplit(url).port) for url in connected] == [(DATABASE_HOST, DATABASE_PORT)]
    roles = next(command for command in commands if command[:2] == ['make', 'db-roles'])
    assert f'DB_HOST={DATABASE_HOST}' in roles and f'DB_PORT={DATABASE_PORT}' in roles
    assert 'CREATE DATABASE lane_example WITH TEMPLATE template_schema OWNER desk_admin' in queries
    assert (tmp_path / 'schema-hash').read_text() == 'schema'

