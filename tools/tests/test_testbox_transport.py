"""Exercise source selection against a real Git worktree, without an AWS connection."""
from pathlib import Path
import subprocess

from desk_tools.testbox_client import source_files


def test_delta_sync_detects_same_size_same_mtime_edits_modes_and_symlink_changes(tmp_path):
    import os
    from desk_tools.testbox_client import source_state, changed_files

    (tmp_path / 'source.py').write_text('before')
    (tmp_path / 'alias.py').symlink_to('source.py')
    paths = ['source.py', 'alias.py']
    before = source_state(tmp_path, paths)
    assert changed_files(before, before) == []
    stamp = (tmp_path / 'source.py').stat()
    (tmp_path / 'source.py').write_text('after!')
    os.utime(tmp_path / 'source.py', ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
    assert changed_files(source_state(tmp_path, paths), before) == ['source.py']
    (tmp_path / 'source.py').write_text('before')
    (tmp_path / 'source.py').chmod(0o755)
    (tmp_path / 'alias.py').unlink()
    (tmp_path / 'alias.py').symlink_to('other.py')
    assert changed_files(source_state(tmp_path, paths), before) == ['alias.py', 'source.py']
    assert changed_files(before, {}) == ['alias.py', 'source.py']


def test_sync_includes_dirty_and_untracked_sources_but_never_env_or_symlink_escapes(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    (repo / "tracked.py").write_text("original")
    (repo / ".gitignore").write_text("ignored.py\n")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    (repo / "tracked.py").write_text("dirty")
    (repo / "new.py").write_text("new")
    (repo / ".env").write_text("must not leave")
    (repo / "ignored.py").write_text("ignored")
    (repo / "gone.py").write_text("gone")
    subprocess.run(["git", "-C", str(repo), "add", "gone.py"], check=True)
    (repo / "gone.py").unlink()
    (tmp_path / "private").write_text("private")
    (repo / "escape.py").symlink_to(tmp_path / "private")
    (repo / "alias.py").symlink_to("tracked.py")
    assert source_files(repo) == [".gitignore", "alias.py", "new.py", "tracked.py"]


def test_branch_switch_cleans_nested_directories_without_removing_build_state(tmp_path):
    import json
    import sys
    from desk_tools.testbox_client import cleanup_script

    base = tmp_path / "lane"
    repo = base / "repo"
    (repo / "old/nested").mkdir(parents=True)
    (repo / "old/nested/source.py").write_text("old branch")
    (repo / "backend/.venv").mkdir(parents=True)
    (repo / "backend/.venv/keep").write_text("lane build state")
    (base / "transfer").mkdir()
    (base / "manifest.json").write_text(json.dumps(["old/nested/source.py"]))
    (base / "transfer/manifest.json").write_text(json.dumps(["old"]))
    subprocess.run([sys.executable, "-c", cleanup_script(str(base))], check=True)
    assert not (repo / "old").exists()
    assert (repo / "backend/.venv/keep").read_text() == "lane build state"


def test_cached_instance_is_reused_only_while_its_authenticated_master_is_alive(tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace
    from desk_tools.testbox_client import warm_instance

    calls = []
    def check(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(subprocess, 'run', check)
    cache = tmp_path / 'connection-us-east-1.json'
    assert warm_instance(tmp_path, 'us-east-1') is None
    assert calls == []
    cache.write_text(json.dumps({'instance': 'i-0123456789abcdef0'}))
    assert warm_instance(tmp_path, 'us-east-1') == 'i-0123456789abcdef0'
    assert '-O' in calls[0] and 'check' in calls[0]
    monkeypatch.setattr(subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=255))
    assert warm_instance(tmp_path, 'us-east-1') is None
    cache.write_text(json.dumps({'instance': 'untrusted host -o option'}))
    assert warm_instance(tmp_path, 'us-east-1') is None
