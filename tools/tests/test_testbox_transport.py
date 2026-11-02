"""Exercise source selection against a real Git worktree, without an AWS connection."""
from pathlib import Path
import subprocess

import pytest

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
    """Clients before version 2 sent no version at all, so they are refused like any unknown version."""
    import os
    from desk_tools.testbox_client import PROTOCOL_VERSION

    launcher = Path(__file__).parents[1] / 'testbox/lane-exec.py'
    for version in (PROTOCOL_VERSION, PROTOCOL_VERSION - 1, 0, PROTOCOL_VERSION + 1, None):
        env = {key: value for key, value in os.environ.items() if key != 'TESTBOX_PROTOCOL'}
        if version is not None:
            env['TESTBOX_PROTOCOL'] = str(version)
        result = subprocess.run(['python3', str(launcher), 'INVALID', 'a' * 32, 'true'], env=env, capture_output=True, text=True)
        if version in (PROTOCOL_VERSION, PROTOCOL_VERSION - 1):
            assert 'Invalid lane name' in result.stderr
        else:
            assert "update your branch's tools/testbox or re-provision" in result.stderr


@pytest.mark.parametrize('staged', [False, True])
def test_next_sync_removes_remote_created_sources_but_keeps_ignored_builds(tmp_path, staged):
    """A source file a remote command created is removed on the next sync, also when the command staged it
    (git add): the index reset that follows would otherwise leave it behind as an untracked file."""
    import json
    import sys
    from desk_tools.testbox_client import cleanup_script

    repo = tmp_path / 'repo'
    subprocess.run(['git', 'init', '-q', str(repo)], check=True)
    (repo / '.gitignore').write_text('build/\n')
    (repo / 'stray.py').write_text('remote generated source')
    if staged:
        subprocess.run(['git', '-C', str(repo), 'add', 'stray.py'], check=True)
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


@pytest.mark.parametrize('code, message', [
    (75, 'the test machine is bootstrapping, retry shortly'),
    (78, "the test machine's setup failed: re-run tools/testbox/provision.sh"),
])
def test_not_ready_status_reaches_the_caller_with_its_own_exit_code(capsys, code, message):
    import io
    from types import SimpleNamespace
    from desk_tools.testbox_client import read_remote_state

    holder = SimpleNamespace(stdout=io.BytesIO(b''), wait=lambda: code)
    assert read_remote_state(holder) is None
    output = capsys.readouterr()
    assert output.out == ''
    assert message in output.err


def test_authenticated_host_key_replaces_all_old_entries_for_the_instance(tmp_path):
    from desk_tools.testbox_client import replace_host_key
    known = tmp_path / 'known_hosts'
    known.write_text('i-test ssh-ed25519 old\ni-other ssh-ed25519 keep\ni-test ssh-ed25519 old\n')
    replace_host_key(known, 'i-test', ['ssh-ed25519', 'new'])
    replace_host_key(known, 'i-test', ['ssh-ed25519', 'new'])
    assert known.read_text().splitlines() == ['i-other ssh-ed25519 keep', 'i-test ssh-ed25519 new']


def run_prepare(tmp_path, *, lock=True, flock_status=0, ready=True, failed=False):
    """Run the client's remote shell prefix against a stand-in /opt/testbox; flock is replaced by a recorder."""
    import os
    import shlex
    from desk_tools.testbox_client import prepare_script

    opt, tools = tmp_path / 'opt', tmp_path / 'bin'
    opt.mkdir()
    tools.mkdir()
    if ready:
        (opt / 'ready').write_text('ready\n')
    if lock:
        (opt / 'bootstrap.lock').touch()
    if failed:
        (opt / 'bootstrap-failed').touch()
    (tools / 'flock').write_text(f'#!/bin/sh\necho "$@" >> {tmp_path / "flock-args"}\nexit {flock_status}\n')
    (tools / 'flock').chmod(0o755)
    script = prepare_script(str(tmp_path / 'lane')).replace('/opt/testbox', str(opt)) + shlex.quote('print("continued")')
    return subprocess.run(['bash', '-c', script], env={**os.environ, 'PATH': f'{tools}:{os.environ["PATH"]}'},
                          capture_output=True, text=True)


def test_a_ready_machine_admits_the_run_under_the_shared_bootstrap_lock(tmp_path):
    result = run_prepare(tmp_path)
    assert (result.returncode, result.stdout) == (0, 'continued\n')
    # Shared, and bounded: a caller waiting behind a bootstrap gives up with 75 instead of hanging.
    assert (tmp_path / 'flock-args').read_text().split() == ['-s', '-w', '30', '8']


@pytest.mark.parametrize('failure', ['missing-lock', 'lock-not-taken'])
def test_a_run_never_starts_without_the_shared_bootstrap_lock(tmp_path, failure):
    # A missing lock file must stop the run on its own, even where flock itself would succeed.
    result = run_prepare(tmp_path, lock=failure != 'missing-lock', flock_status=0 if failure == 'missing-lock' else 1)
    assert result.returncode == 75
    assert 'continued' not in result.stdout


@pytest.mark.parametrize('failed, code', [(False, 75), (True, 78)])
def test_a_machine_that_is_not_ready_says_whether_its_setup_is_running_or_failed(tmp_path, failed, code):
    result = run_prepare(tmp_path, ready=False, failed=failed)
    assert result.returncode == code
    assert 'continued' not in result.stdout


@pytest.mark.parametrize('standby', [False, True])
def test_only_a_standby_call_reaches_the_standby_and_it_never_moves_other_lanes(tmp_path, monkeypatch, standby):
    """Lanes share this laptop's remembered connection; a call proving a standby machine must not repoint them."""
    import json
    from types import SimpleNamespace
    from desk_tools import testbox_client as client

    (tmp_path / 'connection-us-east-1.json').write_text(json.dumps({'instance': 'i-0aaaaaaaaaaaaaaaa'}))
    monkeypatch.setattr(subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=0))   # the warm master is alive
    asked = []
    def api(service, operation, **params):
        asked.append(next(f['Values'] for f in params['filters'] if f['Name'] == 'tag:Purpose'))
        return {'Reservations': [{'Instances': [{'InstanceId': 'i-0bbbbbbbbbbbbbbbb'}]}]}
    instance = client.choose_instance(tmp_path, 'us-east-1', api, standby)
    client.open_connection(tmp_path, 'us-east-1', instance, api, remember=not standby)   # its master is alive too
    remembered = json.loads((tmp_path / 'connection-us-east-1.json').read_text())['instance']
    if standby:
        assert (instance, asked, remembered) == ('i-0bbbbbbbbbbbbbbbb', [['agent-test-box-standby']], 'i-0aaaaaaaaaaaaaaaa')
    else:
        assert (instance, asked, remembered) == ('i-0aaaaaaaaaaaaaaaa', [], 'i-0aaaaaaaaaaaaaaaa')


def test_discovery_needs_exactly_one_running_machine(tmp_path):
    from desk_tools import testbox_client as client
    api = lambda *a, **kw: {'Reservations': []}
    with pytest.raises(RuntimeError, match='Expected one running standby test box in us-east-1, found 0'):
        client.choose_instance(tmp_path, 'us-east-1', api, True)


def test_a_lanes_first_call_on_a_machine_says_it_is_setting_up_so_it_is_not_read_as_unreachable():
    from desk_tools.testbox_client import new_lane_notice
    assert 'setting up this lane' in new_lane_notice({'git': '', 'sources': {}})
    assert '5 minutes' in new_lane_notice({'git': '', 'sources': {}})
    assert new_lane_notice({'git': 'a' * 40 + ':' + 'b' * 40, 'sources': {'README.md': 'x'}}) is None



@pytest.mark.parametrize('remember', [False, True])
def test_a_new_connection_is_authorized_over_ssm_and_recorded_only_when_asked(tmp_path, monkeypatch, remember):
    """Provisioning reuses this with an AWS helper that raises RuntimeError while SSM has no invocation yet."""
    import json
    from types import SimpleNamespace
    from desk_tools import testbox_client as client

    (tmp_path / 'connection-us-east-1.json').write_text(json.dumps({'instance': 'i-0aaaaaaaaaaaaaaaa'}))
    (tmp_path / 'id_ed25519.pub').write_text('ssh-ed25519 CLIENT desk-testbox-client')
    (tmp_path / 'id_ed25519').write_text('private')
    ssh = []
    def run(command, **kwargs):
        ssh.append(command)
        return SimpleNamespace(returncode=255 if '-O' in command else 0)   # no live master yet
    monkeypatch.setattr(subprocess, 'run', run)
    monkeypatch.setattr(client.time, 'sleep', lambda _: None)
    answers = [RuntimeError('InvocationDoesNotExist'), {'Status': 'Success', 'StandardOutputContent': 'ssh-ed25519 HOSTKEY'}]
    def api(service, operation, **params):
        if operation == 'send-command':
            return {'Command': {'CommandId': 'test'}}
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer
    client.open_connection(tmp_path, 'us-east-1', 'i-0bbbbbbbbbbbbbbbb', api, remember=remember)
    assert any('-MNf' in command for command in ssh)
    assert 'i-0bbbbbbbbbbbbbbbb ssh-ed25519 HOSTKEY' in (tmp_path / 'known_hosts').read_text()
    recorded = json.loads((tmp_path / 'connection-us-east-1.json').read_text())['instance']
    assert recorded == ('i-0bbbbbbbbbbbbbbbb' if remember else 'i-0aaaaaaaaaaaaaaaa')


def test_the_shared_connection_outlasts_a_long_upload_queue(tmp_path, monkeypatch):
    """Every lane's uploads share one connection, and Session Manager carries uploads slowly (15–45 KB/s measured).
    One 2 MB upload delayed a round trip on that connection by 74 s, past the old 45 s keepalive limit, so the master
    closed itself and dropped every lane's call. The master now allows ten minutes without a keepalive reply. A
    closed Session Manager stream still ends it at once, because the proxy process exits."""
    import json
    from types import SimpleNamespace
    from desk_tools import testbox_client as client

    (tmp_path / 'connection-us-east-1.json').write_text(json.dumps({'instance': 'i-0aaaaaaaaaaaaaaaa'}))
    monkeypatch.setattr(subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=0))   # the master is alive
    options = client.open_connection(tmp_path, 'us-east-1', 'i-0aaaaaaaaaaaaaaaa', None, remember=False)
    settings = dict(value.split('=', 1) for flag, value in zip(options, options[1:]) if flag == '-o')
    assert int(settings['ServerAliveInterval']) * int(settings['ServerAliveCountMax']) >= 600


def test_a_change_to_the_masters_settings_opens_its_own_master(tmp_path, monkeypatch):
    """A caller reuses any live master on its control socket, and a master keeps the settings it was opened with. A
    lane on an older branch could otherwise keep a master with the old 45 s limit open while it stays busy, since
    ControlPersist counts only idle time. The socket's name therefore follows the master's settings."""
    from desk_tools import testbox_client as client

    current = client.control_path(tmp_path, 'us-east-1', 'i-0aaaaaaaaaaaaaaaa')
    monkeypatch.setattr(client, 'MASTER_OPTIONS', ('ServerAliveInterval=15', 'ServerAliveCountMax=3'))
    assert client.control_path(tmp_path, 'us-east-1', 'i-0aaaaaaaaaaaaaaaa') != current


def _effective_ssh(args):
    """ssh's own reading of these options, without connecting: `ssh -G` prints the configuration it would use."""
    import shutil
    if shutil.which('ssh') is None:
        pytest.skip('needs the OpenSSH client')
    done =subprocess.run(['ssh', '-F', '/dev/null', '-G', *args, 'ubuntu@i-0aaaaaaaaaaaaaaaa'], capture_output=True, text=True, check=True)
    return dict(line.split(' ', 1) for line in done.stdout.splitlines() if ' ' in line)


def test_a_large_upload_goes_over_its_own_compressed_connection_and_a_small_one_shares(tmp_path):
    """Every lane's calls share one connection, and Session Manager carries it slowly, so a new lane's first upload
    (an 11 MB Git bundle and 30 MB of source files) held every other lane's calls and keepalives behind it for
    minutes. A large upload opens its own connection over a new Session Manager session instead, compressed, since
    the macOS rsync has no reliable -z. A small one stays on the shared connection, which is already open."""
    import shlex
    from desk_tools import testbox_client as client

    shared = ['-o', 'ControlMaster=auto', '-o', f'ControlPath={tmp_path / "shared.sock"}', '-o', 'ProxyCommand=aws ssm start-session --target %h']
    small = shlex.split(client.transport(shared, client.BULK_BYTES))
    assert small == ['ssh', *shared]
    assert _effective_ssh(small[1:])['controlpath'] == str(tmp_path / 'shared.sock')
    large = _effective_ssh(shlex.split(client.transport(shared, client.BULK_BYTES + 1))[1:])
    assert large['controlmaster'] == 'false'
    assert large.get('controlpath', 'none') == 'none'   # ssh -G leaves an unset control path out
    assert large['compression'] == 'yes'
    assert large['proxycommand'].startswith('aws ssm start-session')


def test_an_uploads_size_counts_files_and_links_and_skips_missing_paths(tmp_path):
    from desk_tools import testbox_client as client

    (tmp_path / 'a.txt').write_bytes(b'x' * 1000)
    (tmp_path / 'link').symlink_to('a.txt')
    assert client.upload_size(tmp_path, ['a.txt', 'link', 'gone.txt']) == 1000 + len('a.txt')


def test_a_new_lanes_bundle_goes_alone_while_a_small_source_delta_shares(tmp_path):
    """The request folder (with any Git bundle) and the changed source files are judged separately, each by its own
    size, and only what goes over a connection of its own is reported."""
    from desk_tools import testbox_client as client

    transfer, root = tmp_path / 'transfer', tmp_path / 'repo'
    (transfer / 'tools').mkdir(parents=True)
    (transfer / 'source.bundle').write_bytes(b'b' * 2_000_000)
    (transfer / 'tools' / 'worker.py').write_bytes(b'w' * 1000)
    root.mkdir()
    (root / 'small.py').write_bytes(b's' * 1000)
    shared = ['-o', 'ControlMaster=auto']
    request, sources, alone = client.upload_plan(shared, transfer, root, ['small.py'])
    assert request == client.transport(shared, client.BULK_BYTES + 1)
    assert sources == client.transport(shared, 0)
    assert alone == 2_001_000

    (transfer / 'source.bundle').unlink()
    (root / 'big.py').write_bytes(b'x' * 2_000_000)
    request, sources, alone = client.upload_plan(shared, transfer, root, ['small.py', 'big.py'])
    assert (request, sources, alone) == (client.transport(shared, 0), client.transport(shared, client.BULK_BYTES + 1), 2_001_000)


def test_a_call_that_lost_its_lane_during_an_upload_stops_with_a_message(tmp_path):
    """A large upload no longer rides on the lane holder's connection, so the holder can end while it runs (the
    shared connection closed by hand, or its keepalives gave up). The call then stops with a testbox message instead
    of carrying on into a lane it no longer holds."""
    import sys
    from desk_tools import testbox_client as client

    holder = subprocess.Popen([sys.executable, '-c', 'pass'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    holder.wait()
    with pytest.raises(RuntimeError, match="lost the lane's connection"):
        client.check_lease(holder)
    alive = subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdin.read()'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        client.check_lease(alive)
    finally:
        alive.stdin.close()
        alive.wait()


def test_closing_the_shared_connections_works_with_none_open(tmp_path):
    """The documented way to close a silent connection is one script, so an unattended lane can run it, and it
    copes with a cache that holds no connection at all."""
    import os
    script = Path(__file__).resolve().parents[1] / 'testbox' / 'close-connections'
    (tmp_path / '.cache' / 'desk-testbox').mkdir(parents=True)
    done = subprocess.run(['bash', str(script)], env={**os.environ, 'HOME': str(tmp_path)}, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == 'testbox: closed 0 shared connection(s)'
