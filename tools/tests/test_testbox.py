from pathlib import Path

from desk_tools.testbox import lane_name, selected_files, remote_environment, remote_command


def test_lane_names_are_safe_and_do_not_collide():
    assert lane_name("/work/remote-test-box") == "remote-test-box"
    assert lane_name("/work/A B") != lane_name("/work/A-B")
    assert "/" not in lane_name("/work/a; echo bad")


def test_sync_never_selects_secrets_or_local_builds():
    paths = [".env", ".env.example", "backend/.env.test", ".aws/config", "key.pem",
             "web/node_modules/x", "kernel/target/x", "backend/.venv/x", ".local/note",
             "backend/desk/api.py", "notes.txt", ".git/config"]
    assert selected_files(paths) == [".env.example", "backend/desk/api.py", "notes.txt"]


def test_environment_is_lane_scoped_and_ci_is_explicit():
    env = remote_environment("alpha", "/srv/testbox/lanes/alpha/repo")
    assert "CI" not in env
    for role in ("ADMIN", "KERNEL", "API", "MOCKPAY"):
        assert env[f"{role}_DATABASE_URL"].endswith(":5432/lane_alpha")
    assert remote_environment("beta", "/repo", ci="1")["CI"] == "1"
    assert env["DESK_PROVE"].endswith("/kernel/target/release/desk-prove")


def test_lane_database_urls_reach_postgres_directly_over_the_lane_link():
    """Not through the loopback forwarder, whose extra hop cost every connection about 40 ms."""
    from urllib.parse import urlsplit
    from desk_tools.testbox import DATABASE_HOST, DATABASE_PORT

    env = remote_environment("alpha", "/srv/testbox/lanes/alpha/repo")
    for role in ("ADMIN", "KERNEL", "API", "MOCKPAY"):
        url = urlsplit(env[f"{role}_DATABASE_URL"])
        assert (url.hostname, url.port) == ("10.200.0.1", 5432) == (DATABASE_HOST, DATABASE_PORT)
    # The address is the test bridge's, where Postgres listens and the launcher lets each lane connect.
    tools = Path(__file__).parents[1] / "testbox"
    bootstrap = (tools / "bootstrap.sh").read_text()
    assert f"ip addr replace {DATABASE_HOST}/16 dev testbox0" in bootstrap
    assert f"listen_addresses = '127.0.0.1,{DATABASE_HOST}'" in bootstrap
    assert "host all all 10.200.0.0/16 scram-sha-256" in bootstrap
    firewall = f'"-d", "{DATABASE_HOST}", "-p", "tcp", "--dport", "{DATABASE_PORT}", "-j", "ACCEPT"'
    assert firewall in (tools / "lane-exec.py").read_text()


def test_a_lanes_database_rule_comes_before_its_lane_network_reject():
    """A lane's firewall rules are appended in order, and the first match wins: the ACCEPT for the bridge's Postgres
    must come before the REJECT for the lane network it sits in, or new lanes lose their database after the next
    provision."""
    from desk_tools.testbox import DATABASE_HOST, DATABASE_PORT
    launcher = (Path(__file__).parents[1] / "testbox" / "lane-exec.py").read_text()
    accept = f'"iptables", "-A", "OUTPUT", "-d", "{DATABASE_HOST}", "-p", "tcp", "--dport", "{DATABASE_PORT}", "-j", "ACCEPT"'
    reject = '"iptables", "-A", "OUTPUT", "-d", "10.200.0.0/16", "-j", "REJECT"'
    assert accept in launcher and reject in launcher
    assert launcher.index(accept) < launcher.index(reject)
    assert '"iptables", "-I"' not in launcher            # an inserted rule would jump the order the file shows


def test_command_preserves_argument_boundaries():
    assert remote_command(["printf", "%s", "hello; touch /bad"]) == "printf %s 'hello; touch /bad'"


def test_timings_are_opt_in_and_use_stderr(monkeypatch, capsys):
    from desk_tools.testbox import Timings
    monkeypatch.delenv('TESTBOX_TIMING', raising=False)
    Timings('fixture').mark('quiet')
    assert capsys.readouterr() == ('', '')
    monkeypatch.setenv('TESTBOX_TIMING', '1')
    Timings('fixture').mark('visible')
    output = capsys.readouterr()
    assert output.out == ''
    assert 'testbox timing: fixture.visible=' in output.err


def test_make_remote_preserves_dollars_quotes_and_argument_boundaries():
    import shlex
    import subprocess
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    command = "printf '%s\\n' \"$HOME\" 'literal $VALUE'"
    result = subprocess.check_output(['make', '-n', 'remote', 'CMD=' + command], cwd=root, text=True)
    assert shlex.split(result) == ['tools/testbox/run', 'sh', '-c', command]
