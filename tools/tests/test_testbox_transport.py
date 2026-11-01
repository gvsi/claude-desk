"""Exercise source selection against a real Git worktree, without an AWS connection."""
from pathlib import Path
import subprocess

from desk_tools.testbox_client import source_files


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
