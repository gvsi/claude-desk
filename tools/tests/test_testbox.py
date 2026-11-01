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


def test_command_preserves_argument_boundaries():
    assert remote_command(["printf", "%s", "hello; touch /bad"]) == "printf %s 'hello; touch /bad'"
