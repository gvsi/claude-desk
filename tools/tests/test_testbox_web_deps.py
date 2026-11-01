"""The test machine's worker installs web/'s packages (npm ci) for a lane that has none, or whose web/package.json or
web/package-lock.json changed since that lane's last install, and not otherwise; a worktree without web/ skips it."""
import importlib.util
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace

import pytest

WORKER = Path(__file__).parents[1] / 'testbox/worker.py'


def load_worker():
    spec = importlib.util.spec_from_file_location('testbox_worker', WORKER)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    return worker


@pytest.fixture
def lane(tmp_path, monkeypatch):
    worker = load_worker()
    repo = tmp_path / 'repo'
    web = repo / 'web'
    web.mkdir(parents=True)
    (web / 'package.json').write_text('{"name": "web"}')
    (web / 'package-lock.json').write_text('{"lockfileVersion": 3}')
    installs = []
    failures = []

    def fake_run(cmd, **kwargs):
        installs.append(SimpleNamespace(cmd=cmd, cwd=kwargs.get('cwd'), env=kwargs.get('env')))
        if failures:
            raise subprocess.CalledProcessError(failures.pop(), cmd)
        # npm ci writes node_modules/.package-lock.json as its last step.
        (web / 'node_modules').mkdir(exist_ok=True)
        (web / 'node_modules/.package-lock.json').write_text('{}')

    monkeypatch.setattr(worker, 'run', fake_run)
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    node = bin_dir / 'node'
    node.write_text('node v24')
    node.chmod(0o755)
    env = {'npm_config_cache': '/srv/testbox/cache/npm', 'PATH': str(bin_dir)}
    return SimpleNamespace(worker=worker, base=tmp_path, repo=repo, web=web, node=node, installs=installs, failures=failures,
                           prepare=lambda: worker.install_web_dependencies(tmp_path, repo, env))


def test_first_call_installs_with_npm_ci_in_web_using_the_shared_cache(lane):
    assert lane.prepare() is None
    assert [call.cmd[:2] for call in lane.installs] == [['npm', 'ci']]
    assert lane.installs[0].cwd == lane.web
    assert lane.installs[0].env['npm_config_cache'] == '/srv/testbox/cache/npm'


def test_unchanged_package_files_skip_the_install(lane):
    lane.prepare()
    lane.prepare()
    assert len(lane.installs) == 1


@pytest.mark.parametrize('name', ['package-lock.json', 'package.json'])
def test_a_changed_package_file_installs_again(lane, name):
    lane.prepare()
    (lane.web / name).write_text('{"changed": true}')
    lane.prepare()
    assert len(lane.installs) == 2
    lane.prepare()
    assert len(lane.installs) == 2


def test_missing_or_unfinished_node_modules_installs_again(lane):
    lane.prepare()
    (lane.web / 'node_modules/.package-lock.json').unlink()
    lane.prepare()
    assert len(lane.installs) == 2


def test_node_modules_changed_since_the_recorded_install_installs_again(lane):
    """A lane command's `npm install`, or a cancelled `npm ci`, rewrites npm's marker after the worker's install."""
    lane.prepare()
    (lane.web / 'node_modules/.package-lock.json').write_text('{"drifted": 1}')
    lane.prepare()
    assert len(lane.installs) == 2
    lane.prepare()
    assert len(lane.installs) == 2


def test_a_changed_install_command_or_node_installs_again(lane, monkeypatch):
    lane.prepare()
    monkeypatch.setattr(lane.worker, 'NPM_CI', lane.worker.NPM_CI + ['--omit=optional'])
    lane.prepare()
    assert lane.installs[-1].cmd[-1] == '--omit=optional'
    assert len(lane.installs) == 2
    lane.node.write_text('node v26, a different build')
    lane.prepare()
    assert len(lane.installs) == 3
    lane.prepare()
    assert len(lane.installs) == 3


def test_a_worktree_without_a_web_lockfile_skips_the_install(lane):
    (lane.web / 'package-lock.json').unlink()
    assert lane.prepare() is None
    assert lane.installs == []


def test_a_failed_install_fails_the_call_clearly_and_retries_next_time(lane, capsys):
    lane.prepare()
    # The lockfile changes and npm ci fails part way.
    (lane.web / 'package-lock.json').write_text('{"changed": true}')
    lane.failures.append(1)
    assert lane.prepare() == 1
    assert 'npm ci in web/ failed' in capsys.readouterr().err
    # Even with the old lockfile back, what the failed install left is not taken for the recorded install.
    (lane.web / 'package-lock.json').write_text('{"lockfileVersion": 3}')
    assert lane.prepare() is None
    assert len(lane.installs) == 3


class DatabaseStep(Exception):
    pass


@pytest.fixture
def worker_call(tmp_path, monkeypatch):
    """worker.main() on a committed lane repo with web/, recording each command it runs and stopping at the database lock."""
    worker = load_worker()
    repo = tmp_path / 'repo'
    subprocess.run(['git', 'init', '-q', str(repo)], check=True)
    (repo / 'web').mkdir()
    (repo / 'web/package.json').write_text('{}')
    (repo / 'web/package-lock.json').write_text('{}')
    (repo / '.env.example').write_text('ADMIN_DATABASE_URL=\n')
    git = lambda *args: subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'source')
    head = git('rev-parse', 'HEAD')
    git('update-ref', 'refs/remotes/origin/main', head)
    transfer = tmp_path / 'transfer'
    transfer.mkdir()
    (transfer / 'manifest.json').write_text('[]')
    (transfer / 'request.json').write_text(json.dumps({'signature': head + ':' + head, 'head': head, 'main': head, 'bundle': False,
                                                       'lane': 'fixture', 'ci': None, 'command': ['true']}))
    ran, locks, failing = [], [], []

    def fake_run(cmd, **kwargs):
        ran.append(cmd)
        if cmd[:2] in failing:
            raise subprocess.CalledProcessError(1, cmd)

    def database_lock(*args, **kwargs):
        locks.append(args)
        raise DatabaseStep()

    monkeypatch.setattr(worker, 'run', fake_run)
    monkeypatch.setattr(worker, 'open', database_lock, raising=False)
    monkeypatch.setattr('sys.argv', ['worker.py', str(tmp_path)])
    monkeypatch.chdir(tmp_path)
    return SimpleNamespace(main=worker.main, ran=ran, locks=locks, failing=failing)


def test_worker_installs_web_dependencies_before_the_lane_database_and_command(worker_call):
    with pytest.raises(DatabaseStep):
        worker_call.main()
    assert ['npm', 'ci'] in [cmd[:2] for cmd in worker_call.ran]


def test_a_failed_install_stops_the_call_before_the_database_and_command(worker_call):
    worker_call.failing.append(['npm', 'ci'])
    assert worker_call.main() == 1
    assert worker_call.locks == []
    assert ['true'] not in worker_call.ran
