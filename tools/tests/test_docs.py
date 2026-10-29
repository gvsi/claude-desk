"""The docs check (`python -m desk_tools.check_docs`, `make docs-check`) and the shipped docs it guards:
the README, the threat model and the architecture decisions."""

import re
from pathlib import Path

import pytest

from desk_tools import check_docs

REPO = Path(__file__).resolve().parents[2]

# The contract, written out as Task 9 of the deploy and docs plan (docs/plans/2026-10-28-06b-deploy-and-docs.md)
# defines it rather than read from the checker, so a weakened table in the checker fails these tests.
README, THREAT_MODEL = "README.md", "docs/threat-model.md"
REQUIRED_DISCLOSURES = {
    "shows codes to whoever entered the contact": (README, THREAT_MODEL),
    "does not establish possession of the contact": (README, THREAT_MODEL),
    "whether a contact is on record": (README, THREAT_MODEL),
    "cancel a contact's live challenge": (README, THREAT_MODEL),
    "use up its hourly limit": (README, THREAT_MODEL),
    "verification codes are simulated": (README, THREAT_MODEL),
    "payments are mocked": (README, THREAT_MODEL),
    "a buggy API process": (THREAT_MODEL,),
    "out of the attacker's reach": (THREAT_MODEL,),
}
SHIPPED_DOCS = (
    README,
    THREAT_MODEL,
    "docs/architecture-decisions.md",
    "docs/path-to-mvp.md",
    "docs/deploy.md",
    "docs/ci.md",
    "docs/evals.md",
)


def write(root: Path, path: str, text: str) -> Path:
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)
    return target


def disclosures_for(path: str) -> str:
    """One sentence per phrase the plan requires in `path`."""
    return "".join(f"It {phrase}.\n" for phrase, files in REQUIRED_DISCLOSURES.items() if path in files)


def passing_tree(root: Path) -> Path:
    """A tree the docs check passes: every required disclosure where it belongs, links that resolve."""
    write(root, "README.md", "# Claude Desk\n\n" + disclosures_for("README.md")
          + "\nSee [the threat model](docs/threat-model.md).\n")
    write(root, "docs/threat-model.md", "# Threat model\n\n" + disclosures_for("docs/threat-model.md"))
    write(root, "AGENTS.md", "# Agents\n")
    return root


def run(root: Path, *args: str) -> tuple[int, str]:
    lines: list[str] = []
    code = check_docs.main(["--root", str(root), *args], out=lines.append)
    return code, "\n".join(lines)


def test_relative_links_resolve(tmp_path):
    root = passing_tree(tmp_path)
    write(root, "docs/guide.md", "# Guide\n\n## Steps\n")
    write(root, "docs/plans/plan.md", "Read [the guide](../guide.md#steps) and [the spec](../specs/missing.md).\n")
    write(root, "AGENTS.md", "See [the guide](docs/guide.md), [steps](docs/guide.md#steps) and [here](#top).\n")

    code, out = run(root)

    assert code == 1
    assert "docs/plans/plan.md:1: broken link ../specs/missing.md" in out
    assert "guide.md" not in out.replace("docs/plans/plan.md", "")

    write(root, "docs/specs/missing.md", "# Now it exists\n")
    code, out = run(root)
    assert code == 0, out


def test_links_across_line_breaks_are_checked(tmp_path):
    root = passing_tree(tmp_path)
    write(root, "AGENTS.md", "# Agents\n\nSee [the\nguide](\n  docs/guide.md\n) and [the plan](docs/plan.md\n  \"The plan\").\n")

    code, out = run(root)

    assert code == 1
    assert "AGENTS.md:5: broken link docs/guide.md" in out
    assert "AGENTS.md:6: broken link docs/plan.md" in out

    write(root, "docs/guide.md", "# Guide\n")
    write(root, "docs/plan.md", "# Plan\n")
    assert run(root) == (0, "docs-check: ok")


def test_link_targets_may_hold_balanced_parentheses(tmp_path):
    root = passing_tree(tmp_path)
    write(root, "AGENTS.md", "See [the guide](docs/guide(v2).md) and [the notes](docs/notes(old).md \"Old notes\").\n")
    write(root, "docs/notes(old).md", "# Old notes\n")

    code, out = run(root)

    assert code == 1
    assert out.splitlines()[0] == "docs-check: AGENTS.md:1: broken link docs/guide(v2).md"
    assert "notes" not in out

    write(root, "docs/guide(v2).md", "# Guide\n")
    assert run(root) == (0, "docs-check: ok")


def test_reference_style_links_are_checked(tmp_path):
    root = passing_tree(tmp_path)
    write(root, "AGENTS.md", "See [the guide][guide] and [the plan].\n\n[guide]: docs/guide.md\n[the plan]:\n  docs/plan.md\n")

    code, out = run(root)

    assert code == 1
    assert "AGENTS.md:3: broken link docs/guide.md" in out
    assert "AGENTS.md:5: broken link docs/plan.md" in out

    write(root, "docs/guide.md", "# Guide\n")
    write(root, "docs/plan.md", "# Plan\n")
    assert run(root) == (0, "docs-check: ok")


def test_angle_bracket_links_are_checked(tmp_path):
    root = passing_tree(tmp_path)
    write(root, "AGENTS.md", "See [the guide](<docs/the guide.md>) and [two](docs/guide%20two.md).\n")

    code, out = run(root)

    assert code == 1
    assert "AGENTS.md:1: broken link docs/the guide.md" in out
    assert "AGENTS.md:1: broken link docs/guide%20two.md" in out

    write(root, "docs/the guide.md", "# Guide\n")
    write(root, "docs/guide two.md", "# Guide two\n")
    assert run(root) == (0, "docs-check: ok")


def test_links_in_code_examples_are_not_checked(tmp_path):
    root = passing_tree(tmp_path)
    write(root, "docs/plans/plan.md", "\n".join([
        "Write a link as `[text](nope.md)` or ``[text][ref]``, even across lines: `[text](",
        "nope.md)`.",
        "",
        "```md",
        "[text](nope.md)",
        "[ref]: nope.md",
        "```",
        "",
        "1. In a list item:",
        "",
        "    ~~~md",
        "    [text](nope.md)",
        "    ~~~",
        "",
    ]))

    assert run(root) == (0, "docs-check: ok")

    write(root, "docs/plans/plan.md", "Outside code, [text](nope.md) is a link.\n")
    assert "docs/plans/plan.md:1: broken link nope.md" in run(root)[1]


def test_relative_links_that_leave_the_repository_are_broken(tmp_path):
    root = passing_tree(tmp_path / "repo")
    write(tmp_path, "outside/notes.md", "# Only on this machine\n")
    write(root, "AGENTS.md", "See [the notes](../outside/notes.md).\n")

    code, out = run(root)

    assert code == 1
    assert "AGENTS.md:1: broken link ../outside/notes.md (it leaves the repository)" in out


@pytest.mark.parametrize("line", [
    "Notes are in [my notes](/Users/someone/notes.md).",
    "Run `cat ~/scratch/key.txt` first.",
    "Run `/Users/someone/bin/desk` first.",
    "The run ledger lives in .plan-runs/06b/progress.md.",
    "The design is at https://claude.ai/artifact/abc123.",
    "The design is at https://claude.ai/code/artifact/abc123.",
    "See https://claude.ai/share/abc123 for the chat.",
    "Notes are in [my notes](~/notes.md).",
    "See /Users/someone/notes.md for the steps.",
    "Copied from /home/someone/notes.md.",
    "    /Users/someone/bin/desk deploy",
])
def test_flags_private_references(tmp_path, line):
    root = passing_tree(tmp_path)
    write(root, "docs/deploy.md", f"# Deploying\n\n{line}\n")

    code, out = run(root)

    assert code == 1
    assert "docs/deploy.md:3: private reference" in out


def test_flags_private_paths_in_fenced_code(tmp_path):
    root = passing_tree(tmp_path)
    write(root, "docs/deploy.md", "# Deploying\n\n```sh\n/Users/someone/bin/desk deploy\ncat ~/scratch/key.txt\n```\n")

    code, out = run(root)

    assert code == 1
    assert "docs/deploy.md:4: private reference (/Users/)" in out
    assert "docs/deploy.md:5: private reference (~/ in a link or code)" in out


def test_flags_private_paths_in_code_nested_in_a_list(tmp_path):
    root = passing_tree(tmp_path)
    write(root, "docs/deploy.md", "# Deploying\n\n1. Run:\n\n    ```sh\n    cat ~/scratch/key.txt\n    ```\n"
          "2. Then:\n\n    ~~~sh\n    cat ~/scratch/other.txt\n    ~~~\n")

    code, out = run(root)

    assert code == 1
    assert "docs/deploy.md:6: private reference (~/ in a link or code)" in out
    assert "docs/deploy.md:11: private reference (~/ in a link or code)" in out


def test_private_references_in_prose_and_unshipped_docs_pass(tmp_path):
    root = passing_tree(tmp_path)
    write(root, "docs/deploy.md", "# Deploying\n\nThe AWS CLI reads its profile from ~/.aws, as usual.\n")
    write(root, "docs/plans/plan.md", "The runner writes `.plan-runs/<plan>/progress.md` and `/Users/someone/x`.\n")

    code, out = run(root)

    assert code == 0, out


def test_deny_list_is_optional_and_applied(tmp_path):
    root = passing_tree(tmp_path)
    write(root, "docs/ci.md", "# CI\n\nBuilt for the Northwind Pilot.\n")
    write(root, "docs/plans/plan.md", "Built for the Northwind Pilot.\n")
    assert run(root)[0] == 0   # no deny list: nothing to apply

    write(root, ".local/docs-deny.txt", "# private terms, one per line\n\nnorthwind pilot\n")
    code, out = run(root)

    assert code == 1
    assert "docs/ci.md:3: private reference (a term from .local/docs-deny.txt, line 3)" in out
    assert "northwind" not in out.casefold()   # the term itself is never printed
    assert "plans/plan.md" not in out          # only shipped docs are scanned


def test_final_mode_checks_placeholders_in_shipped_docs_only(tmp_path):
    root = passing_tree(tmp_path)
    write(root, "docs/plans/plan.md", "Numbers read `[measured: …]` until the report, links [owner: …].\n")
    write(root, "docs/specs/spec.md", "Placeholders look like [measured: p95].\n")
    assert run(root) == (0, "docs-check: ok")
    assert run(root, "--final") == (0, "docs-check: ok")

    readme = root / "README.md"
    readme.write_text(readme.read_text() + "\nHeld-out completion: [measured: first held-out pass].\n")
    write(root, "docs/evals.md", "# Evals\n\n## Latest results\n\n[measured: first held-out pass]\n")
    write(root, "docs/threat-model.md", (root / "docs/threat-model.md").read_text() + "[owner: a link]\n")
    assert run(root)[0] == 0

    code, out = run(root, "--final")

    assert code == 1
    assert "README.md:" in out and "placeholder [measured:" in out
    assert "docs/evals.md:5: placeholder [measured:" in out
    assert "docs/threat-model.md:" in out and "placeholder [owner:" in out
    assert "plans/plan.md" not in out and "specs/spec.md" not in out


def test_the_checker_holds_the_plans_disclosures_and_shipped_docs():
    assert check_docs.DISCLOSURES == REQUIRED_DISCLOSURES
    assert sorted(check_docs.SHIPPED_DOCS) == sorted(SHIPPED_DOCS)


@pytest.mark.parametrize("phrase", list(REQUIRED_DISCLOSURES))
def test_each_required_disclosure_is_enforced(tmp_path, phrase):
    for path in REQUIRED_DISCLOSURES[phrase]:
        root = passing_tree(tmp_path / path.replace("/", "_"))
        assert run(root)[0] == 0
        doc = root / path
        doc.write_text(doc.read_text().replace(f"It {phrase}.\n", ""))

        code, out = run(root)

        assert code == 1
        assert f'{path}: missing the disclosure "{phrase}"' in out


@pytest.mark.parametrize("path", SHIPPED_DOCS)
def test_every_shipped_doc_is_scanned(tmp_path, path):
    root = passing_tree(tmp_path)
    doc = root / path
    before = doc.read_text() if doc.is_file() else "# A shipped doc\n"
    write(root, path, before + "\nNotes are in .plan-runs/06b/progress.md.\n\nCost: [measured: cost per conversation].\n")
    lines = len(before.splitlines())

    assert f"{path}:{lines + 2}: private reference (.plan-runs/)" in run(root)[1]
    assert f"{path}:{lines + 4}: placeholder [measured:" in run(root, "--final")[1]


def test_disclosures_match_across_case_line_breaks_and_apostrophes(tmp_path):
    root = passing_tree(tmp_path)
    doc = root / "docs/threat-model.md"
    text = doc.read_text().replace("It a buggy API process.", "Hardened against\na buggy API\nprocess.")
    doc.write_text(text.replace("out of the attacker's reach", "Out of the attacker’s reach"))

    code, out = run(root)

    assert code == 0, out


def test_a_missing_disclosure_file_fails(tmp_path):
    root = passing_tree(tmp_path)
    (root / "docs/threat-model.md").unlink()
    write(root, "README.md", (root / "README.md").read_text().replace("See [the threat model](docs/threat-model.md).", ""))

    code, out = run(root)

    assert code == 1
    assert "docs/threat-model.md: missing (it must carry the required disclosures)" in out


README_SECTIONS = [
    "Try it",
    "Things to try",
    "What's real, mocked and unfinished",
    "Security model",
    "Evidence",
    "Run it locally",
    "How it was built",
    "Documents",
]
FOOTER = "Concept prototype by Giovanni Alcantara, not an Anthropic product"


def sections(text: str) -> dict[str, str]:
    """Each `## ` section's body, by heading, in order."""
    found: dict[str, str] = {}
    heading = None
    for line in text.splitlines():
        if line.startswith("## "):
            heading = line[3:].strip()
            found[heading] = ""
        elif heading is not None:
            found[heading] += line + "\n"
    return found


def test_readme_sections():
    text = (REPO / "README.md").read_text()
    lines = [line for line in text.splitlines() if line.strip()]

    assert lines[0] == "# Claude Desk"
    assert list(sections(text)) == README_SECTIONS
    assert lines[-1].strip("_* ") == FOOTER


def test_readme_evidence_links_the_evals_guide():
    evidence = sections((REPO / "README.md").read_text())["Evidence"]

    if (REPO / "docs/evals.md").is_file():
        assert "](docs/evals.md)" in evidence, "the README's Evidence must link docs/evals.md"
        assert check_docs.check_links(REPO) == []
    else:
        # The evals guide lands with the evals report. Until then Evidence names it in a placeholder,
        # which `--final` refuses, so the docs can't ship without the link.
        held = [line for line in evidence.splitlines() if "[measured:" in line and "docs/evals.md" in line]
        assert held, "with no docs/evals.md yet, Evidence must hold a [measured: …] placeholder naming it"


def status_table(section: str) -> list[list[str]]:
    """The cells of each row of the section's table, the header row first and the divider left out."""
    table = []
    for line in section.splitlines():
        if line.startswith("|"):
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if not all(set(cell) <= set("-:") for cell in cells):
                table.append(cells)
    return table


def test_readme_states_what_is_real_mocked_unfinished():
    status = sections((REPO / "README.md").read_text())["What's real, mocked and unfinished"]
    rows = {cells[0]: cells[1] for cells in status_table(status)[1:]}

    def row(start: str) -> str:
        found = [status for part, status in rows.items() if part.startswith(start)]
        assert found, f"the table has no row for {start!r}"
        return found[0]

    assert row("Payment").startswith("Payments are mocked")
    assert "Verification codes are simulated" in row("Verifying")
    # Every mock and simple part in the master plan's requirement matrix is named in its own row.
    share_kit = row("Share kit")
    assert "Link and QR real" in share_kit
    assert all(word in share_kit for word in ("Google profile", "embed", "signature", "voicemail", "mock"))
    returning = row("Returning visitors")
    assert "cookie" in returning and "vision mock" in returning
    assert row("Suggested upgrades").startswith("Simple")
    assert all(status for status in rows.values()), "every part has a status"
    unfinished = status.split("### Unfinished", 1)
    assert (len(unfinished) == 2 and unfinished[1].strip()) or "Nothing was cut" in status, \
        "an Unfinished entry with something under it, or the line 'Nothing was cut'"


def test_readme_says_what_is_on_main_for_each_part():
    status = sections((REPO / "README.md").read_text())["What's real, mocked and unfinished"]
    header, *rows = status_table(status)

    assert header == ["Part", "Status", "At this commit"]
    for part, *rest in rows:
        assert len(rest) == 2 and all(rest), f"{part!r} needs a status and its state at this commit"
        at_commit = rest[1].casefold()
        on_main = "on `main`" in at_commit
        assert on_main or re.search(r"lands with .*\(plan \d", at_commit), \
            f"{part!r}: say what is on `main` or name the plan it lands with, not {rest[1]!r}"
        if on_main:   # a link to the code, so the link check proves it is there
            code = [target for target in re.findall(r"\]\(([^)]+)\)", rest[1]) if not target.startswith("docs/")]
            assert code, f"{part!r} says it is on `main`, so it links the code that is"
    assert check_docs.check_links(REPO) == []


ADR_PARTS = ["Status", "Context", "Decision", "Alternatives", "Consequences"]
ADR_TOPICS = [   # each record the plan asks for, by a word or two its title must carry
    "kernel", "Cedar", "reviewer", "cards", "loop", "Express Mode", "mocked",
]


def test_architecture_decisions_have_required_parts():
    text = (REPO / "docs/architecture-decisions.md").read_text()
    records = re.split(r"^## ", text, flags=re.MULTILINE)[1:]

    assert len(records) >= len(ADR_TOPICS)
    for record in records:
        title = record.splitlines()[0]
        parts = re.findall(r"^\*\*(\w+)\.\*\*", record, flags=re.MULTILINE)
        assert parts == ADR_PARTS, f"{title!r} has {parts}, not {ADR_PARTS} in that order"
    titles = " ".join(record.splitlines()[0] for record in records).casefold()
    assert [topic for topic in ADR_TOPICS if topic.casefold() not in titles] == []
    assert "](specs/2026-10-28-claude-desk-design.md#decisions-log)" in text
    assert "](research/stack-options.md)" in text
