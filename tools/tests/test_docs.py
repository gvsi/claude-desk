"""The docs check (`python -m desk_tools.check_docs`, `make docs-check`) and the shipped docs it guards:
the README, the threat model, the architecture decisions, and the product proposal and capability prediction
that the About this prototype pages show."""

import os
import re
import subprocess
from pathlib import Path
from xml.etree import ElementTree

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
# The two documents the About this prototype pages show, as Task 1 of the About readers plan
# (docs/plans/2026-10-29-07-about-readers.md) defines them, each with its figure markers in order.
ABOUT_DOCS = {
    "docs/product-proposal.md": ("architecture",),
    "docs/capability-prediction.md": ("tau3", "readiness"),
}
SHIPPED_DOCS = (
    README,
    THREAT_MODEL,
    "docs/architecture-decisions.md",
    "docs/path-to-mvp.md",
    "docs/deploy.md",
    "docs/ci.md",
    "docs/evals.md",
    *ABOUT_DOCS,
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
    """A tree the docs check passes: every required disclosure where it belongs, links that resolve, and a deny
    list with no terms yet (without one, the check says so)."""
    write(root, "README.md", "# Claude Desk\n\n" + disclosures_for("README.md")
          + "\nSee [the threat model](docs/threat-model.md).\n")
    write(root, "docs/threat-model.md", "# Threat model\n\n" + disclosures_for("docs/threat-model.md"))
    write(root, "AGENTS.md", "# Agents\n")
    write(root, ".local/docs-deny.txt", "# private terms, one per line\n")
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


CANVAS = "https://claude.ai/artifact/M46eP5Mtsoi15ruVMZ1uUx?sk=bbGjca_v34tZ2PPYoF0OVA"


def test_the_published_design_canvas_passes(tmp_path):
    root = passing_tree(tmp_path)
    write(root, "docs/deploy.md", f"# Deploying\n\nThe boards are on the [design canvas]({CANVAS}).\n")

    code, out = run(root)

    assert code == 0, out


@pytest.mark.parametrize("url", [
    "https://claude.ai/artifact/M46eP5Mtsoi15ruVMZ1uUx",
    "https://claude.ai/artifact/M46eP5Mtsoi15ruVMZ1uUx?sk=another",
    "https://claude.ai/artifact/abc123?sk=bbGjca_v34tZ2PPYoF0OVA",
])
def test_other_artifact_links_stay_private(tmp_path, url):
    root = passing_tree(tmp_path)
    write(root, "docs/deploy.md", f"# Deploying\n\nSee [the canvas]({CANVAS}) and [this one]({url}).\n")

    code, out = run(root)

    assert code == 1
    assert "docs/deploy.md:3: private reference (claude.ai/artifact)" in out


def test_private_references_in_prose_and_unshipped_docs_pass(tmp_path):
    root = passing_tree(tmp_path)
    write(root, "docs/deploy.md", "# Deploying\n\nThe AWS CLI reads its profile from ~/.aws, as usual.\n")
    write(root, "docs/plans/plan.md", "The runner writes `.plan-runs/<plan>/progress.md` and `/Users/someone/x`.\n")

    code, out = run(root)

    assert code == 0, out


def test_deny_list_is_optional_and_applied(tmp_path):
    root = passing_tree(tmp_path)
    (root / ".local/docs-deny.txt").unlink()
    write(root, "docs/ci.md", "# CI\n\nBuilt for the Northwind Pilot.\n")
    write(root, "docs/plans/plan.md", "Built for the Northwind Pilot.\n")
    assert run(root)[0] == 0   # no deny list: nothing to apply

    write(root, ".local/docs-deny.txt", "# private terms, one per line\n\nnorthwind pilot\n")
    code, out = run(root)

    assert code == 1
    assert "docs/ci.md:3: private reference (a term from .local/docs-deny.txt, line 3)" in out
    assert "northwind" not in out.casefold()   # the term itself is never printed
    assert "plans/plan.md" not in out          # only shipped docs are scanned


def test_flags_private_references_in_the_committed_images(tmp_path):
    # An SVG's title, description and labels are public text wherever the repository is read.
    root = passing_tree(tmp_path)
    write(root, ".local/docs-deny.txt", "northwind pilot\n")
    write(root, "docs/images/figure.svg", '<svg xmlns="http://www.w3.org/2000/svg">\n'
          "  <title>A figure</title>\n  <desc>Drawn from /Users/someone/figure.fig</desc>\n</svg>\n")
    write(root, "docs/images/chart.svg", '<svg xmlns="http://www.w3.org/2000/svg">\n'
          '  <text x="0" y="10">Built for the Northwind Pilot</text>\n</svg>\n')

    code, out = run(root)

    assert code == 1
    assert out.splitlines() == [
        "docs-check: docs/images/chart.svg:2: private reference (a term from .local/docs-deny.txt, line 1)",
        "docs-check: docs/images/figure.svg:3: private reference (/Users/)",
        "docs-check: 2 problems",
    ]

    write(root, "docs/images/figure.svg", '<svg xmlns="http://www.w3.org/2000/svg"><title>A figure</title></svg>\n')
    write(root, "docs/images/chart.svg", '<svg xmlns="http://www.w3.org/2000/svg"><text>Built for a pilot</text></svg>\n')
    assert run(root) == (0, "docs-check: ok")


def git(*args: str) -> None:
    subprocess.run(["git", *args], check=True, capture_output=True)


def test_deny_list_falls_back_to_the_main_checkout(tmp_path, monkeypatch, capfd):
    # A worktree has no .local/ of its own, so the check reads the main checkout's list.
    for name in [name for name in os.environ if name.startswith("GIT_")]:
        monkeypatch.delenv(name)   # a hook's GIT_DIR or GIT_INDEX_FILE must not point git at this repository
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", "/dev/null")   # nor this machine's config (signing, hooks)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))   # and tmp_path is never inside a repository
    main = passing_tree(tmp_path / "main")
    write(main, ".gitignore", ".local/\n")
    write(main, ".local/docs-deny.txt", "northwind pilot\n")
    write(main, "docs/ci.md", "# CI\n\nBuilt for the Northwind Pilot.\n")
    git("init", "-q", str(main))
    git("-C", str(main), "add", ".")
    git("-C", str(main), "-c", "user.name=Docs Check", "-c", "user.email=docs-check@example.com",
        "commit", "-q", "-m", "Add the docs")
    worktree = tmp_path / "worktree"
    git("-C", str(main), "worktree", "add", "-q", str(worktree))
    assert not (worktree / ".local").exists()

    code, out = run(worktree)

    assert code == 1
    assert "docs/ci.md:3: private reference (a term from .local/docs-deny.txt, line 1)" in out
    assert "no deny list" not in out

    # Outside a repository there is no main checkout to fall back to: no deny list, and the check says so.
    outside = passing_tree(tmp_path / "outside")
    (outside / ".local/docs-deny.txt").unlink()
    write(outside, "docs/ci.md", "# CI\n\nBuilt for the Northwind Pilot.\n")

    code, out = run(outside)

    assert (code, out.splitlines()) == (0, [
        "docs-check: no deny list (.local/docs-deny.txt), private terms not checked",
        "docs-check: ok",
    ])
    assert capfd.readouterr().err == ""   # git's own error stays out of the output


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


def test_about_documents_are_shipped_docs():
    # A shipped doc that isn't in the tree is skipped, so both must also be there to be checked at all.
    assert [path for path in ABOUT_DOCS if path not in check_docs.SHIPPED_DOCS] == []
    assert [path for path in ABOUT_DOCS if not (REPO / path).is_file()] == []


def test_about_documents_pass_the_docs_check():
    found = check_docs.check_private(REPO) + check_docs.check_links(REPO)

    assert [str(problem) for problem in found if problem.path in [*ABOUT_DOCS, "docs/images/v1-architecture.svg"]] == []
    # The architecture figure GitHub readers see, linked from the proposal, is a committed SVG.
    proposal = (REPO / "docs/product-proposal.md").read_text()
    assert "images/v1-architecture.svg" in [target for _, target in check_docs.link_targets(proposal)]
    assert ElementTree.parse(REPO / "docs/images/v1-architecture.svg").getroot().tag == "{http://www.w3.org/2000/svg}svg"


FIGURE_MARKER = re.compile(r"<!-- figure: (architecture|tau3|readiness) -->")
FIGURE_IMAGE = re.compile(r"!\[[^\[\]\n]+\]\(images/v1-architecture\.svg\)")
# A web or e-mail address at the start of a word (after anything but a letter or digit), which GitHub links
# though no one wrote a link.
BARE_ADDRESS = re.compile(
    r"(?<![^\W_])(?:(?i:https?://|www\.)|[A-Za-z0-9_.+-]+@[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+)")


def reader_subset_problems(text: str, other: str) -> list[str]:
    """What in `text` the About pages' Markdown reader would refuse, by line: a fenced code block or a code span
    across lines, HTML other than a figure marker on a line of its own, an image other than the architecture
    figure's line right after its marker, a heading below `##` or a second `#` heading, a blockquote, a thematic
    break, a setext heading, a nested list, a link that is neither `https://` nor `other`, the other document's
    file name, or a bare web or e-mail address outside a link. The reader's own tests run the full parse; this
    catches the common breaks without the web toolchain."""
    problems: list[str] = []
    # The reader has no code blocks, and the blanking below would hide what one holds, so each is refused first.
    # The checker's own fence lines are the ones it skips, opener then closer, so every other one opens a block.
    inside = {number for number, _, _ in check_docs._lines(text)}
    delimiters = [number for number in range(1, text.count("\n") + 2) if number not in inside]
    problems += [f"line {number}: a fenced code block" for number in delimiters[::2]]
    # A code span that crosses a line break would hide the next line's start the same way; the documents
    # never wrap one, so each is refused, and the code spans left are each inside one line.
    unfenced = check_docs._split_fences(text)[0]
    line_of = check_docs._line_of(unfenced)
    problems += [f"line {line_of(span.start())}: a code span across lines"
                 for span in check_docs._CODE_SPAN.finditer(unfenced) if "\n" in span.group(0)]
    lines = check_docs._prose(text).split("\n")   # code spans and fenced code blanked: what they hold is text
    figure_images: set[int] = set()
    titled = False
    for number, line in enumerate(lines, start=1):
        marker = FIGURE_MARKER.fullmatch(line.rstrip())
        if marker:
            if marker.group(1) != "architecture":
                continue
            if number < len(lines) and FIGURE_IMAGE.fullmatch(lines[number].rstrip()):
                figure_images.add(number + 1)
            else:
                problems.append(f"line {number}: the architecture marker without its image line right after it")
            continue
        if number in figure_images:
            continue
        if re.search(r"<[A-Za-z!/?]", line):
            problems.append(f"line {number}: raw HTML")
        if "![" in line:
            problems.append(f"line {number}: an image other than the architecture figure")
        if re.match(r" {0,3}#{3,}(?:[ \t]|$)", line):
            problems.append(f"line {number}: a heading below ##")
        if re.match(r" {0,3}#(?:[ \t]|$)", line):   # the first is the title, which feeds the page's hero
            if titled:
                problems.append(f"line {number}: a second # heading after the title")
            titled = True
        if re.match(r" {0,3}>", line):
            problems.append(f"line {number}: a blockquote")
        # Under a line of text, a line of = or - turns that text into a heading; elsewhere --- is a break.
        if number > 1 and lines[number - 2].strip() and re.fullmatch(r" {0,3}(?:=+|-+)[ \t]*", line):
            problems.append(f"line {number}: a setext heading underline")
        elif re.fullmatch(r" {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*", line):
            problems.append(f"line {number}: a thematic break")
        if re.match(r"[ \t]+(?:[-*+]|\d+[.)])[ \t]", line):
            problems.append(f"line {number}: a nested list")
    for number, target in check_docs.link_targets(text):
        if number not in figure_images and not (target.startswith("https://") or target == other):
            problems.append(f"line {number}: a link to {target}, neither https:// nor {other}")
    # GitHub links a bare address anywhere but in a link, so each link, its words and its target, is blanked first.
    prose = check_docs._prose(text)
    unlinked = check_docs._INLINE_LINK.sub(lambda link: re.sub(r"[^\n]", " ", link.group(0)), prose)
    line_of = check_docs._line_of(unlinked)
    problems += [f"line {line_of(address.start())}: a bare address, which GitHub links; write it as [text](https://…)"
                 for address in BARE_ADDRESS.finditer(unlinked)]
    return problems


# A document inside the reader's subset, for the cases below to break one way each.
IN_SUBSET = "\n".join([
    "# A document",
    "",
    "Giovanni Alcantara · October 29, 2026",
    "",
    "## A section",
    "",
    "Read [the other one](capability-prediction.md) and [a source](https://example.com/report). Code such as",
    "`<b>`, `![x](y.png)` or `[x](notes.md)` is text. Addresses as a link's words or in code aren't linked:",
    "[www.example.com](https://www.example.com), [desk@example.com](https://example.com/contact),",
    "`desk@example.com`; nor are an @ alone, 5@6 or awww.example.",
    "",
    "<!-- figure: architecture -->",
    "![The architecture](images/v1-architecture.svg)",
    "",
    "- One",
    "- Two",
    "",
    "| Axis | Readiness |",
    "| --- | --- |",
    "| Apply policies | Near |",
    "",
    "<!-- figure: tau3 -->",
    "",
])


@pytest.mark.parametrize(("added", "problem"), [
    ("Some <b>bold</b> text.", "raw HTML"),
    ("<script>alert(1)</script>", "raw HTML"),
    ("<!-- a note -->", "raw HTML"),
    ("<!--\nfigure: tau3\n-->", "raw HTML"),
    ("<!-- figure: pie -->", "raw HTML"),
    ("Text <!-- figure: tau3 --> inline.", "raw HTML"),
    ("See <https://example.com>.", "raw HTML"),
    ("![A chart](images/chart.png)", "an image other than the architecture figure"),
    ("![The architecture](images/v1-architecture.svg)", "an image other than the architecture figure"),
    ("<!-- figure: architecture -->\n\nText.", "the architecture marker without its image line"),
    ("<!-- figure: architecture -->\n![The architecture](images/v1-architecture.svg) and more.",
     "the architecture marker without its image line"),
    ("### A subsection", "a heading below ##"),
    ("#### Deeper", "a heading below ##"),
    ("# Another title", "a second # heading after the title"),
    ("  #", "a second # heading after the title"),
    ("> A quote.", "a blockquote"),
    ("   >Quoted with no space.", "a blockquote"),
    ("\n---", "a thematic break"),
    ("\n* * *", "a thematic break"),
    ("\n___", "a thematic break"),
    ("A heading\n=", "a setext heading underline"),
    ("A heading\n  ===", "a setext heading underline"),
    ("A heading\n--", "a setext heading underline"),
    ("A heading\n---", "a setext heading underline"),
    ("- One\n  - Nested", "a nested list"),
    ("1. One\n   1. Nested", "a nested list"),
    ("See [the threat model](threat-model.md).", "a link to threat-model.md"),
    ("See [the proposal](product-proposal.md).", "a link to product-proposal.md"),
    ("See [the readiness](capability-prediction.md#readiness).", "a link to capability-prediction.md#readiness"),
    ("See [a page](http://example.com).", "a link to http://example.com"),
    ("Write [to us](mailto:desk@example.com).", "a link to mailto:desk@example.com"),
    ("See [the model].\n\n[the model]: threat-model.md", "a link to threat-model.md"),
    # The reader has no code blocks, so nothing can hide in one.
    ("```html\n<script>alert(1)</script>\n```", "a fenced code block"),
    ("~~~\n### A subsection\n~~~", "a fenced code block"),
    ("- In a list:\n\n  ```\n  ![A chart](images/chart.png)\n  ```", "a fenced code block"),
    ("Code such as `a\n<script>alert(1)</script>` is not text.", "a code span across lines"),
    ("Code such as `a\n### A subsection` is not text.", "a code span across lines"),
    # GitHub links a bare web or e-mail address that starts a word; the page would show it as plain text.
    ("See https://example.com/report.", "a bare address"),
    ("See HTTP://EXAMPLE.COM here.", "a bare address"),
    ("See www.example.com for more.", "a bare address"),
    ("Write to desk@example.com.", "a bare address"),
    ("Text and\n(desk+orders@mail.example.co.uk) here.", "a bare address"),
    ("[owner: www.example.com]", "a bare address"),
])
def test_the_reader_subset_check_catches_each_break(added, problem):
    assert reader_subset_problems(IN_SUBSET, "capability-prediction.md") == []

    found = reader_subset_problems(IN_SUBSET + added + "\n", "capability-prediction.md")

    assert [line for line in found if problem in line], found


def test_a_link_target_may_nest_parentheses():
    # GitHub, like the reader, keeps balanced parentheses in a link target, so the address in it is a link's, not
    # a bare one. The check reads up to three levels.
    text = IN_SUBSET + "See [the wiki](https://en.wikipedia.org/wiki/A_(b_(c))) here.\n"

    assert reader_subset_problems(text, "capability-prediction.md") == []
    assert [target for _, target in check_docs.link_targets(text)][-1] == "https://en.wikipedia.org/wiki/A_(b_(c))"
    deepest = IN_SUBSET + "See [a](https://x.org/A_(b_(c_(d)))) here.\n"
    assert reader_subset_problems(deepest, "capability-prediction.md") == []
    assert [target for _, target in check_docs.link_targets(deepest)][-1] == "https://x.org/A_(b_(c_(d)))"

    # Unbalanced, or four levels deep, it isn't read as a link, so its address is flagged: the check fails safe.
    for line in ["See [a](https://x.org/A_(b here.", "See [a](https://x.org/A_(b_(c_(d_(e))))) here."]:
        found = reader_subset_problems(IN_SUBSET + line + "\n", "capability-prediction.md")
        assert [problem for problem in found if "a bare address" in problem], line


def test_about_documents_stay_in_the_reader_subset():
    for path, figures in ABOUT_DOCS.items():
        text = (REPO / path).read_text()
        other = next(Path(name).name for name in ABOUT_DOCS if name != path)
        title, byline = [line for line in text.splitlines() if line.strip()][:2]

        assert reader_subset_problems(text, other) == [], path
        assert tuple(FIGURE_MARKER.findall(text)) == figures, path
        # The title and the byline feed the page's hero and meta column rather than the article.
        assert title.startswith("# ") and re.fullmatch(r"Giovanni Alcantara · \w+ \d{1,2}, \d{4}", byline), path
    assert "[capability prediction](capability-prediction.md)" in (REPO / "docs/product-proposal.md").read_text()


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
    "What we left out on purpose",
    "Security model",
    "Evidence",
    "Run it locally",
    "How it was built",
    "Documents",
]
FOOTER = "Concept prototype by [Giovanni Alcantara](https://www.linkedin.com/in/giovannialcantara/), not an Anthropic product"


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


def test_path_to_mvp_sections():
    text = (REPO / "docs/path-to-mvp.md").read_text()

    assert re.findall(r"^## (.+)$", text, re.MULTILINE) == [
        "Architecture",
        "Infrastructure",
        "Model integration",
        "Scaling and what breaks first",
        "Latency and cost per conversation",
        "What changes for real users",
        "Trade-offs made and deferred",
    ]


@pytest.mark.parametrize("row, accepted", [
    (None, True),  # The real draft, including every latency, cost and scaling row.
    ("42 ms | [Run](../evals/reports/run.md)", True),
    ("42 ms | [PR](https://github.com/gvsi/claude-desk/pull/33)", True),
    ("estimate: 30 | estimate: 20 + 10 = 30; [pool](../backend/pool.py)", True),
    ("[measured: local reveal latency, final held-out pass] | [measured: source, final held-out pass]", True),
    ("42 ms |", False),
    ("42 ms", False),
    ("42 ms | [Notes](../docs/notes.md)", False),
    ("42 ms | [Pool](../backend/pool.py)", False),
    ("42 ms | [Pricing](https://example.com/pricing)", False),
    ("42 ms | [Folder](../evals/reports/)", False),
    ("42 ms | [Missing](../evals/reports/missing.md)", False),
    ("estimate: 30 | estimate: from the configured pool", False),
    ("estimate: 30 | estimate: x = y; [pool](../backend/pool.py)", False),
    ("42 ms | [measured: source, final held-out pass]", False),
    ("[measured: local reveal latency, final held-out pass] | [measured: source]", False),
    ("[measured: local reveal latency, final held-out pass] | [Run](../evals/reports/run.md)", False),
])
def test_every_number_has_a_source(tmp_path, row, accepted):
    if row is None:
        assert check_docs.check_mvp_number_sources(REPO) == []
        return

    root = passing_tree(tmp_path)
    write(root, "evals/reports/run.md", "# Measured run\n")
    write(root, "backend/pool.py", "# Configured pool\n")
    write(root, "docs/notes.md", "# Notes\n")
    text = "## Scaling and what breaks first\n\n| Metric | Value | Source |\n|---|---|---|\n"
    write(root, "docs/path-to-mvp.md", text + f"| Test metric | {row} |\n")

    code, out = run(root)
    assert (code == 0) == accepted, out
    if not accepted:
        assert "docs/path-to-mvp.md:5:" in out
    elif "[measured:" in row:
        final_code, final_out = run(root, "--final")
        assert final_code == 1
        assert "docs/path-to-mvp.md:5: placeholder [measured:" in final_out

    # Removing the source column cannot make the table evade the check.
    write(root, "docs/path-to-mvp.md",
          "## Scaling and what breaks first\n\n| Metric | Value |\n|---|---|\n| Test | 42 ms |\n")
    code, out = run(root)
    assert code == 1
    assert "source column" in out


@pytest.mark.parametrize("leading, trailing", [("", ""), ("|", ""), ("", "|"), ("|", "|")])
@pytest.mark.parametrize("delimiter", ["-", "--", ":-:"])
def test_mvp_short_delimiters_require_sources(tmp_path, leading, trailing, delimiter):
    rows = ["Metric | Value | Source", " | ".join([delimiter] * 3), "Test | 42 ms | Unsourced"]
    write(tmp_path, "docs/path-to-mvp.md",
          "## Scaling and what breaks first\n\n"
          + "\n".join(f"{leading}{row}{trailing}" for row in rows) + "\n")

    problems = check_docs.check_mvp_number_sources(tmp_path)

    assert len(problems) == 1
    assert problems[0].line == 5
    assert "metric row needs" in problems[0].message


@pytest.mark.parametrize("following", [
    "# Next", "### Next", "> quote", "- item", "* item", "+ item", "1. item", "1) item",
    "### Next | notes", "> quote | notes", "- item | notes", "* item | notes", "+ item | notes", "1. item | notes",
    "Plain paragraph", "`code | pipe`", r"Escaped \| pipe",
])
def test_mvp_table_ends_at_a_new_block(tmp_path, following):
    write(tmp_path, "docs/path-to-mvp.md",
          "## Scaling and what breaks first\n\n"
          "Metric | Value | Source\n--- | --- | ---\n"
          "Test | 42 ms | [PR](https://github.com/gvsi/claude-desk/pull/33)\n"
          + following + "\n")

    assert check_docs.check_mvp_number_sources(tmp_path) == []


def test_mvp_table_without_boundary_pipes_requires_sources(tmp_path):
    write(tmp_path, "docs/path-to-mvp.md",
          "## Scaling and what breaks first\n\n"
          "Metric | Value | Source\n"
          "--- | --- | ---\n"
          "Test metric | 42 ms | Unsourced\n")

    problems = check_docs.check_mvp_number_sources(tmp_path)

    assert len(problems) == 1
    assert problems[0].line == 5
    assert "metric row needs" in problems[0].message


@pytest.mark.parametrize("leading, trailing", [("", ""), ("|", ""), ("", "|"), ("|", "|")])
@pytest.mark.parametrize("metric", ["Test metric", "`A | B`", "``A | `B` ``", r"A \| B"])
@pytest.mark.parametrize("source, accepted", [
    ("[PR](https://github.com/gvsi/claude-desk/pull/33)", True),
    ("Unsourced", False),
])
def test_mvp_table_boundaries_and_literal_pipes(tmp_path, leading, trailing, metric, source, accepted):
    rows = ["Metric | Value | Source", ":--- | ---: | :---:", f"{metric} | 42 ms | {source}"]
    write(tmp_path, "docs/path-to-mvp.md",
          "## Scaling and what breaks first\n\n"
          + "\n".join(f"{leading}{row}{trailing}" for row in rows) + "\n")

    problems = check_docs.check_mvp_number_sources(tmp_path)

    assert (problems == []) == accepted
    if not accepted:
        assert len(problems) == 1
        assert problems[0].line == 5
        assert "metric row needs" in problems[0].message


@pytest.mark.parametrize("table, message", [
    ("Metric | Value\n--- | ---\nTest | 42 ms\n", "source column"),
    ("Metric | Value | Source\n--- | --- | ---\nMissing cells\n", None),
    ("Metric | Value | Source\n--- | --- | ---\nMissing | cells\n", "cell for every column"),
    ("Metric | Value | Source\n--- | ---\nTest | 42 ms | Unsourced\n", None),
    ("Metric | Value | Source\nProse | without | a delimiter\n", None),
    ("```markdown\nMetric | Value | Source\n--- | --- | ---\nTest | 42 ms | Unsourced\n```\n", None),
])
def test_mvp_table_requires_a_header_and_matching_delimiter(tmp_path, table, message):
    write(tmp_path, "docs/path-to-mvp.md", "## Scaling and what breaks first\n\n" + table)

    problems = check_docs.check_mvp_number_sources(tmp_path)

    if message is None:
        assert problems == []
    else:
        assert len(problems) == 1
        assert message in problems[0].message


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


def test_readme_documents_link_the_proposal_and_the_prediction():
    documents = sections((REPO / "README.md").read_text())["Documents"]

    assert [path for path in ABOUT_DOCS if f"]({path})" not in documents] == []
    assert "[owner:" not in documents


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
    # The matrix's other rows, each in its own row; People is simple.
    for start in ("Quotes and booking", "Spanish", "Passcode", "Accessibility", "Desk management"):
        row(start)
    owner_app = row("The owner app")
    assert "People" in owner_app and "simple" in owner_app
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


def test_no_shipped_doc_says_the_model_check_asks_only_about_promises():
    # The kernel's model check (backend/desk/kernel_service/decisions.py) asks two questions: whether the prose
    # promises what the cards don't back, and whether it denies being an AI. The second backs the threat model's
    # AI disclosure row, so a sentence saying the check asks only about promises must name it too.
    only_promises = re.compile(r"\bonly (?:for|about) promises\b")
    wrong = []
    for path in SHIPPED_DOCS:
        if not (REPO / path).is_file():   # path-to-mvp and the evals guide land with later plans
            continue
        text = " ".join((REPO / path).read_text().casefold().split())
        for sentence in re.split(r"(?<=[.!?])\s+", text):
            if only_promises.search(sentence) and "denies being an ai" not in sentence:
                wrong.append(f"{path}: {sentence}")
    assert wrong == []


# Safety rule 2 in the owner's approved wording of 2026-10-30. It leads each place that states the rule; the threat
# model's control row and the reply check's decision follow it with the same sentence on how the check runs, and the
# decision then keeps its sentences on links and on how a reply is delivered.
REPLY_RULE = (
    "Everything a visitor sees is checked by the kernel first. Prices, dates, discounts and bookings come only from "
    "cards built from the business's facts: Claude's own words can't state a price, date or discount, can't make a "
    "promise the cards don't back, and can confirm a booking only next to a booking card."
)
REPLY_CHECK_HOW = (
    "The code check scans Claude's prose in English and Spanish for digits, money, dates, discount and promise words, "
    "and booking claims without a booking card; a model check on Sonnet 5.5 flags promises the cards don't back and "
    "prose that denies being an AI, and its errors count as violations."
)
REPLY_CHECK_LINKS = "Claude may write links and email addresses, guided by its prompt."   # owner's decision, 2026-10-30
REPLY_CHECK_DELIVERY = (
    "A blocked reply is regenerated once with feedback, then replaced with a handoff to the owner. Every "
    "visitor-visible message passes the kernel's reply check before it is shown: the visitor sees that Claude is "
    "writing, then the checked reply whole, and nothing unchecked is streamed."
)


def safety_rule_two(path: str) -> str:
    """Where `path` states safety rule 2: the invariant, the README's part, the control row or the decision."""
    text = (REPO / path).read_text()
    if path == "AGENTS.md":
        invariants = text.split("## Safety invariants", 1)[1].split("\n## ", 1)[0]
        return next(line.removeprefix("2. ") for line in invariants.splitlines() if line.startswith("2. "))
    if path == README:
        status = sections(text)["What's real, mocked and unfinished"]
        return next(cells[0] for cells in status_table(status) if cells[0].startswith("The reply check"))
    if path == THREAT_MODEL:
        controls = status_table(sections(text)["Controls"])
        where = "`backend/desk/kernel_service/reply_check.py`"
        return next(cells[0] for cells in controls if cells[1].startswith(where))
    records = re.split(r"^## ", text, flags=re.MULTILINE)
    record = next(record for record in records if "Typed cards" in record.splitlines()[0])
    return next(line.removeprefix("**Decision.** ") for line in record.splitlines() if line.startswith("**Decision.** "))


SAFETY_RULE_TWO = {
    "AGENTS.md": REPLY_RULE,
    README: f"The reply check: {REPLY_RULE[0].lower()}{REPLY_RULE[1:]}",   # lowercase after the colon, like its table
    THREAT_MODEL: f"{REPLY_RULE} {REPLY_CHECK_HOW}",
    "docs/architecture-decisions.md": f"{REPLY_RULE} {REPLY_CHECK_HOW} {REPLY_CHECK_LINKS} {REPLY_CHECK_DELIVERY}",
}


@pytest.mark.parametrize("path", SAFETY_RULE_TWO)
def test_safety_rule_two_reads_in_the_owners_wording(path):
    assert safety_rule_two(path) == SAFETY_RULE_TWO[path]


# The design system's README and the reply card's README follow their list of what reaches a visitor only in cards
# with the rule's clause on Claude's own words. Claude's prose may restate a policy since the owner's decision of
# 2026-10-30, so neither list names policies.
DS_READMES = ("web/src/ds/README.md", "web/src/ds/components/ReplyCard/README.md")
CLAUDES_OWN_WORDS = REPLY_RULE.split(": ", 1)[1]


@pytest.mark.parametrize("path", DS_READMES)
def test_design_system_readmes_state_the_rule_and_leave_policies_out_of_cards(path):
    lines = [" ".join(line.split()) for line in (REPO / path).read_text().splitlines()]
    stating = [line for line in lines if CLAUDES_OWN_WORDS in line]
    assert stating, f"{path} must carry safety rule 2's clause on Claude's own words"
    before = stating[0].split(CLAUDES_OWN_WORDS, 1)[0].strip()
    only_in_cards = re.split(r"(?<=[.!?])\s+", before)[-1].casefold()   # the sentence just before the clause
    assert "prices" in only_in_cards, f"{path}: the clause must follow the list of what reaches a visitor only in cards"
    assert "polic" not in only_in_cards, f"{path} lists policies among what reaches a visitor only in cards"
