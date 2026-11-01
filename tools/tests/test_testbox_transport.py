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


def test_git_bundle_sends_only_new_objects_and_handles_a_rewind(tmp_path):
    from desk_tools.testbox_client import create_bundle

    repo, remote = tmp_path / 'source', tmp_path / 'remote'
    for path in [repo, remote]:
        subprocess.run(['git', 'init', '-q', '-b', 'main', str(path)], check=True)
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
    (repo / 'source.txt').write_text('first')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'first')
    first = git('rev-parse', 'HEAD')
    git('update-ref', 'refs/remotes/origin/main', first)
    initial = tmp_path / 'initial.bundle'
    assert create_bundle(repo, initial, '')
    subprocess.run(['git', '-C', str(remote), 'bundle', 'unbundle', str(initial)], check=True, stdout=subprocess.DEVNULL)
    (repo / 'source.txt').write_text('second')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'second')
    second = git('rev-parse', 'HEAD')
    incremental = tmp_path / 'incremental.bundle'
    assert create_bundle(repo, incremental, first + ':' + first)
    # An incremental pack really requires the previous commit; a fresh repo cannot import it.
    empty = tmp_path / 'empty'
    subprocess.run(['git', 'init', '-q', str(empty)], check=True)
    assert subprocess.run(['git', '-C', str(empty), 'bundle', 'verify', str(incremental)], capture_output=True).returncode != 0
    subprocess.run(['git', '-C', str(remote), 'bundle', 'unbundle', str(incremental)], check=True, stdout=subprocess.DEVNULL)
    assert subprocess.check_output(['git', '-C', str(remote), 'show', second + ':source.txt'], text=True) == 'second'
    git('update-ref', 'refs/heads/main', first)
    rewind = tmp_path / 'rewind.bundle'
    assert not create_bundle(repo, rewind, second + ':' + first)
    assert not rewind.exists()


def test_lane_state_reads_actual_git_refs_when_a_remote_command_changes_head(tmp_path):
    import json
    import sys
    from desk_tools.testbox_client import lane_state_script

    repo = tmp_path / 'repo'
    subprocess.run(['git', 'init', '-q', str(repo)], check=True)
    (repo / 'source.txt').write_text('source')
    subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
    subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'source'], check=True)
    head = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    subprocess.run(['git', '-C', str(repo), 'update-ref', 'refs/remotes/origin/main', head], check=True)
    (tmp_path / 'git-signature').write_text('stale marker')
    (tmp_path / 'manifest.json').write_text('[]')
    state = json.loads(subprocess.check_output([sys.executable, '-c', lane_state_script(str(tmp_path))], text=True))
    assert state['git'] == head + ':' + head


def test_worker_restores_index_on_every_call_even_when_refs_are_unchanged(tmp_path, monkeypatch):
    import importlib.util
    import json
    import sys
    import pytest

    spec = importlib.util.spec_from_file_location('testbox_worker', Path(__file__).parents[1] / 'testbox/worker.py')
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    repo = tmp_path / 'repo'
    subprocess.run(['git', 'init', '-q', str(repo)], check=True)
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
    (repo / 'source.txt').write_text('committed')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'source')
    head = git('rev-parse', 'HEAD')
    git('update-ref', 'refs/remotes/origin/main', head)
    (repo / 'source.txt').write_text('staged')
    git('add', '.')
    (repo / 'source.txt').write_text('unstaged')
    transfer = tmp_path / 'transfer'
    transfer.mkdir()
    (transfer / 'manifest.json').write_text('["source.txt"]')
    (transfer / 'request.json').write_text(json.dumps({'signature': head + ':' + head, 'head': head, 'main': head, 'bundle': False, 'lane': 'fixture', 'ci': None}))
    monkeypatch.setattr(sys, 'argv', ['worker.py', str(tmp_path)])
    class Prepared(Exception):
        pass
    def finished(*args):
        raise Prepared()
    monkeypatch.setattr(worker, 'remote_environment', finished)
    with pytest.raises(Prepared):
        worker.main()
    assert git('diff', '--cached', '--name-only') == ''
    assert (repo / 'source.txt').read_text() == 'unstaged'


def test_interrupted_transfer_paths_survive_request_overwrite_and_are_pruned(tmp_path):
    import json
    import sys
    from desk_tools.testbox_client import cleanup_script

    repo, transfer = tmp_path / 'repo', tmp_path / 'transfer'
    repo.mkdir()
    transfer.mkdir()
    (tmp_path / 'manifest.json').write_text('[]')
    (transfer / 'manifest.json').write_text('["partial_branch_test.py"]')
    subprocess.run([sys.executable, '-c', cleanup_script(str(tmp_path))], check=True)
    # First sync was interrupted after copying a file but before worker promotion.
    (repo / 'partial_branch_test.py').write_text('partial transfer')
    assert json.loads((tmp_path / 'pending-manifest.json').read_text()) == ['partial_branch_test.py']
    (transfer / 'manifest.json').write_text('[]')
    subprocess.run([sys.executable, '-c', cleanup_script(str(tmp_path))], check=True)
    assert not (repo / 'partial_branch_test.py').exists()
    assert json.loads((tmp_path / 'pending-manifest.json').read_text()) == []


def test_client_rejects_old_python_before_importing_annotations():
    import sys
    runner = Path(__file__).parents[1] / 'testbox/run'
    script = f"import sys, runpy; sys.version_info = (3, 9, 6); runpy.run_path({str(runner)!r}, run_name='__main__')"
    result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True)
    assert result.returncode == 1
    assert 'Python 3.10 or newer is required' in result.stderr
    assert 'Traceback' not in result.stderr


def test_runner_transfer_is_independent_of_the_selected_repository(tmp_path):
    import importlib.util
    from desk_tools.testbox_client import stage_runner

    stage_runner(tmp_path)
    tools = tmp_path / 'tools'
    assert (tools / 'testbox/database.py').is_file()
    assert (tools / 'desk_tools/testbox_client.py').is_file()
    # The worker must import its helpers with no tools in the synchronized repository.
    result = subprocess.run(['python3', '-c',
        "import runpy; runpy.run_path(" + repr(str(tools / 'testbox/worker.py')) + ", run_name='fixture')"],
        cwd=tmp_path, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_launcher_accepts_current_and_previous_protocol_only():
    import os
    from desk_tools.testbox_client import PROTOCOL_VERSION

    launcher = Path(__file__).parents[1] / 'testbox/lane-exec.py'
    for version in (PROTOCOL_VERSION, PROTOCOL_VERSION - 1, 0, PROTOCOL_VERSION + 1):
        result = subprocess.run(['python3', str(launcher), 'INVALID', 'a' * 32, 'true'],
            env={**os.environ, 'TESTBOX_PROTOCOL': str(version)}, capture_output=True, text=True)
        if version in (PROTOCOL_VERSION, PROTOCOL_VERSION - 1):
            assert 'Invalid lane name' in result.stderr
        else:
            assert "update your branch's tools/testbox or re-provision" in result.stderr


def test_next_sync_removes_remote_created_sources_but_keeps_ignored_builds(tmp_path):
    import json
    import sys
    from desk_tools.testbox_client import cleanup_script

    repo = tmp_path / 'repo'
    subprocess.run(['git', 'init', '-q', str(repo)], check=True)
    (repo / '.gitignore').write_text('build/\n')
    (repo / 'stray.py').write_text('remote generated source')
    (repo / 'local.py').write_text('caller untracked source')
    (repo / 'build').mkdir()
    (repo / 'build/cache').write_text('warm')
    (repo / '.env').write_text('development defaults')
    (tmp_path / 'transfer').mkdir()
    (tmp_path / 'transfer/manifest.json').write_text(json.dumps(['.gitignore', 'local.py']))
    subprocess.run([sys.executable, '-c', cleanup_script(str(tmp_path))], check=True)
    assert not (repo / 'stray.py').exists()
    assert (repo / 'local.py').exists()
    assert (repo / 'build/cache').read_text() == 'warm'
    assert (repo / '.env').exists()
