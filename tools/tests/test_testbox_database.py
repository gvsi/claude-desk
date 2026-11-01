"""The warm database check must preserve data and use one catalog snapshot."""
from pathlib import Path
import runpy
import sys
from types import SimpleNamespace


def test_warm_database_check_preserves_lane_data_with_one_catalog_query(tmp_path, monkeypatch):
    (tmp_path / 'schema-hash').write_text('schema')
    queries = []

    class Rows:
        def fetchone(self):
            return ('template_schema',)

        def __iter__(self):
            return iter([('template_schema',), ('lane_example',)])

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, query, params=None):
            assert isinstance(query, str) and query.startswith('SELECT'), 'A warm run must not recreate its database'
            queries.append(query)
            return Rows()

    monkeypatch.setitem(sys.modules, 'psycopg', SimpleNamespace(connect=lambda *a, **kw: Connection(), sql=None))
    helper = Path(__file__).parents[1] / 'testbox/database.py'
    monkeypatch.setattr(sys, 'argv', [str(helper), str(tmp_path), 'template_schema', 'lane_example', 'schema'])
    runpy.run_path(str(helper), run_name='__main__')
    assert len(queries) == 1
    assert (tmp_path / 'schema-hash').read_text() == 'schema'
