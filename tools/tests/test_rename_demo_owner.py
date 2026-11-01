"""The demo owner's rename (`tools/rename_demo_owner.py`): display names change, identifiers stay, every
edit applies once, and `--check` fails while an old display name is left."""

import importlib.util
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "rename_demo_owner.py"
_spec = importlib.util.spec_from_file_location("rename_demo_owner", SCRIPT)
rename = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rename)


def test_display_names_follow_the_rules():
    text = ("Maria Rivera owns Rivera Plumbing (riveraplumbing.example, maria@riverapl.example, "
            "/d/rivera-plumbing-abc). María's van, Maria’s list, _Maria_ and Rivera's rules.\n")

    assert rename.rename_text(text, "docs/notes.md") == (
        "Mike Turner owns Turner Plumbing (turnerplumbing.example, mike@riverapl.example, "
        "/d/turner-plumbing-abc). Mike's van, Mike’s list, _Mike_ and Turner's rules.\n")


def test_the_owners_initials_follow_the_name():
    assert rename.rename_text("['MRMaria Rivera joined the chat', initials: 'MR']", "web/src/x.test.tsx") == (
        "['MTMike Turner joined the chat', initials: 'MT']")


def test_python_identifiers_stay_and_its_strings_and_comments_change():
    code = ('from .test_adapters import Rivera, rivera\n\n\n'
            'class Rivera:\n    slug: str\n\n\n'
            'def f(copy: Rivera | None) -> tuple[Rivera, str]:\n'
            '    return Rivera(slug="rivera-plumbing"), f"Maria Rivera {RIVERA_CARDS}"  # Rivera\'s copy\n')

    assert rename.rename_text(code, "backend/tests/kernel/test_x.py") == (
        'from .test_adapters import Rivera, rivera\n\n\n'
        'class Rivera:\n    slug: str\n\n\n'
        'def f(copy: Rivera | None) -> tuple[Rivera, str]:\n'
        '    return Rivera(slug="turner-plumbing"), f"Mike Turner {RIVERA_CARDS}"  # Turner\'s copy\n')


@pytest.mark.parametrize("kept", [
    "export const Rivera: Story = {",
    "canvas: 'N-Public-Rivera-Run1'",
    "the N-Rules-Rivera board",
    "`Layout/PublicShell` (`Rivera`, `RiveraEs`)",
    "rivera.business.ownerName",
    "RIVERA_CARDS, rivera_seed and RiveraFrame",
    "<MariaTakesOver /> and expectMariaInTheChat",
    "id: atk-disclose-roleplay-maria",
    "Billing@Rivera-Pay.Shop",
    "Rivera, hyphen, Pay dot shop",
    "Your Rivera payment goes through the card.",
    "Rivera.PuntoPago.shop",
    "Pedir hablar con María Guadalupe Fernández de la Torre",
    "I'm Maria Smith's assistant.",
])
def test_identifiers_ids_and_the_lookalike_domain_stay(kept):
    assert rename.rename_text(kept, "web/src/x.stories.tsx") == kept


def test_an_edit_applies_once_and_again_changes_nothing():
    edits = [("a.md", "Mike said she would", "Mike said he would")]

    once, problems = rename.apply_edits("a.md", "Mike said she would call.", edits)
    again, more = rename.apply_edits("a.md", once, edits)

    assert (once, problems) == ("Mike said he would call.", [])
    assert (again, more) == (once, [])


def test_an_edit_that_finds_nothing_or_too_much_is_a_problem():
    edits = [("a.md", "she would", "he would")]

    assert rename.apply_edits("a.md", "Nothing here.", edits)[1] == ["a.md: edit not found: 'she would'"]
    assert rename.apply_edits("a.md", "she would, she would", edits)[1] == [
        "a.md: edit found 2 times, expected 1: 'she would'"]


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


def test_check_lists_what_is_left_and_a_run_clears_it(tmp_path, capsys):
    git(tmp_path, "init", "-q")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "notes.md").write_text("# Notes\n\nAsk Maria Rivera.\n")
    (tmp_path / "evals" / "results").mkdir(parents=True)
    (tmp_path / "evals" / "results" / "run.json").write_text('{"said": "Maria Rivera"}\n')
    (tmp_path / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n\xff\xfe Maria")
    git(tmp_path, "add", ".")

    assert rename.main(["--check"], root=tmp_path) == 1
    assert "docs/notes.md:3" in capsys.readouterr().out

    assert rename.main([], root=tmp_path) == 0
    assert (tmp_path / "docs" / "notes.md").read_text() == "# Notes\n\nAsk Mike Turner.\n"
    assert (tmp_path / "evals" / "results" / "run.json").read_text() == '{"said": "Maria Rivera"}\n'
    capsys.readouterr()

    assert rename.main(["--check"], root=tmp_path) == 0
    assert rename.main([], root=tmp_path) == 0
    assert "0 files changed" in capsys.readouterr().out

